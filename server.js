// cebian-gateway — Koyeb Node.js relay for Telegram 2-way communication.
//
// Thay thế Cloudflare Worker (stateless per-request isolates — in-memory clients
// Map không sống sót qua các request) bằng một container Node.js dài hạn: RAM
// của container là thật, `clients` Set sống xuyên suốt lifetime của service.
//
// Wire contract (khớp `lib/telegram-gateway/types.ts`):
//   Worker → extension : { kind: 'telegram_message', update_id, message_id,
//                          chat_id, chat_type, text, date,
//                          from: { id, username? } | null }
//   extension → Worker : { kind: 'sendMessage', request_id, chat_id, text,
//                          parse_mode?, reply_to_message_id?,
//                          disable_notification?, disable_link_preview? }
//                        { kind: 'sendChatAction', request_id, chat_id, action }
//                        { kind: 'editMessage', request_id, chat_id, message_id, text, parse_mode? }
//                        { kind: 'setMessageReaction', request_id, chat_id, message_id, emoji? }
//                        { kind: 'deleteMessage', request_id, chat_id, message_id }
//   Worker → extension : { kind: 'sendMessage_result', request_id, ok, message_id?, error? }
//                        { kind: 'gateway_result', request_id, ok, error? }（后两种 action 用）
//
// Env vars (Koyeb Variables hoặc .env):
//   TELEGRAM_BOT_TOKEN      — bot token (chỉ Worker đọc, không log)
//   TELEGRAM_WEBHOOK_SECRET — giá trị header X-Telegram-Bot-Api-Secret-Token
//   WS_AUTH_TOKEN           — shared secret extension trình diện ở ?token=
//   ALLOWED_CHAT_IDS        — CSV chat id; rỗng/chưa set = từ chối tất cả (fail-closed)
//   PORT                    — mặc định 8000 (Koyeb web port mặc định)

import http from 'node:http';
import { WebSocketServer } from 'ws';

const env = process.env;
const PORT = Number(env.PORT || 8000);

// Server-side WebSocket sockets đang sống (set để delete O(1) trên close).
const clients = new Set();

/** Constant-time string compare — so byte cùng độ dài, không lộ timing. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

/** CSV → Set<string> chat id. env rỗng → tập rỗng = từ chối tất cả (fail-closed). */
function parseAllowedChatIds(raw) {
  const set = new Set();
  for (const piece of String(raw ?? '').split(',')) {
    const id = piece.trim();
    if (id) set.add(id);
  }
  return set;
}

function isChatAllowed(chatId) {
  return parseAllowedChatIds(env.ALLOWED_CHAT_IDS).has(String(chatId));
}

/** Gọi Telegram Bot API sendMessage; chuẩn hoá kết quả thành reply shape.
 *  extra — các field tuỳ chọn forward thẳng từ wire action:
 *    parse_mode            → body.parse_mode
 *    reply_to_message_id   → body.reply_to_message_id (Block 1 reply vào tin user)
 *    disable_notification  → body.disable_notification (Block 2+ im lặng)
 *    disable_link_preview  → body.link_preview_options.is_disabled (chống card preview lợn cột) */
async function callSendMessage(chatId, text, extra = {}) {
  try {
    const body = { chat_id: chatId, text };
    if (extra.parse_mode) body.parse_mode = extra.parse_mode;
    if (extra.reply_to_message_id) body.reply_to_message_id = extra.reply_to_message_id;
    if (extra.disable_notification) body.disable_notification = true;
    if (extra.disable_link_preview) body.link_preview_options = { is_disabled: true };
    if (extra.reply_markup) body.reply_markup = extra.reply_markup;
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (json.ok && typeof json.result?.message_id === 'number') {
      return { ok: true, message_id: json.result.message_id };
    }
    if (json.ok) {
      return { ok: false, error: 'telegram response missing message_id' };
    }
    return {
      ok: false,
      error: json.description ? `${res.status}: ${json.description}` : `status ${res.status}`,
    };
  } catch (err) {
    return { ok: false, error: `telegram api unreachable: ${String(err)}` };
  }
}

/** sendChatAction — typing indicator (Telegram tự hết hạn ~5s → client tái gửi 4s/lần). */
async function callSendChatAction(chatId, action) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action: action || 'typing' }),
    });
    const json = await res.json().catch(() => ({}));
    if (json.ok) return { ok: true };
    return {
      ok: false,
      error: json.description ? `${res.status}: ${json.description}` : `status ${res.status}`,
    };
  } catch (err) {
    return { ok: false, error: `telegram api unreachable: ${String(err)}` };
  }
}

/** editMessageText — block streaming (plain) + lần cuối (Markdown).
 *  'message is not modified' (nội dung không đổi giữa 2 lần edit liên tiếp)
 *  → nuốt, coi như ok — không phải lỗi với caller. */
async function callEditMessage(chatId, messageId, text, parseMode, replyMarkup) {
  try {
    const body = { chat_id: chatId, message_id: messageId, text };
    if (parseMode) body.parse_mode = parseMode;
    if (replyMarkup) body.reply_markup = replyMarkup;
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (json.ok) return { ok: true };
    if (typeof json.description === 'string' && json.description.includes('message is not modified')) {
      return { ok: true };
    }
    return {
      ok: false,
      error: json.description ? `${res.status}: ${json.description}` : `status ${res.status}`,
    };
  } catch (err) {
    return { ok: false, error: `telegram api unreachable: ${String(err)}` };
  }
}

/** setMessageReaction — dán / đổi / gỡ emoji reaction trên một message
 *  (Step-Progress: 👀 lúc chạy → 👌 hoàn tất / ❌ lỗi). `emoji` rỗng/undefined
 *  → reaction rỗng = gỡ. is_big bật animation to (client-native).
 *  Lỗi Telegram (reaction không được hỗ trợ trên chat loại đó, v.v.) trả
 *  ok:false — caller phía extension tự catch-im lặng. */
async function callSetMessageReaction(chatId, messageId, emoji) {
  try {
    const reaction = emoji ? [{ type: 'emoji', emoji }] : [];
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setMessageReaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        reaction,
        is_big: true,
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (json.ok) return { ok: true };
    return {
      ok: false,
      error: json.description ? `${res.status}: ${json.description}` : `status ${res.status}`,
    };
  } catch (err) {
    return { ok: false, error: `telegram api unreachable: ${String(err)}` };
  }
}

/** deleteMessage — Step-Progress 收尾用：正式回覆落位後刪掉臨時工具狀態行。
 *  'message to delete not found' 吞掉視為 ok（冪等——重複刪除 / 已刪不報錯，
 *  同 'message is not modified' 的處理先例）。 */
async function callDeleteMessage(chatId, messageId) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/deleteMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
    });
    const json = await res.json().catch(() => ({}));
    if (json.ok) return { ok: true };
    if (typeof json.description === 'string' && json.description.includes('message to delete not found')) {
      return { ok: true };
    }
    return {
      ok: false,
      error: json.description ? `${res.status}: ${json.description}` : `status ${res.status}`,
    };
  } catch (err) {
    return { ok: false, error: `telegram api unreachable: ${String(err)}` };
  }
}

/** reply_markup tường minh để XOÁ inline keyboard (editMessageText với
 *  empty inline_keyboard là cách remove per Bot API docs — không dựa vào
 *  hành vi omit-mặc định). */
const CLEAR_KEYBOARD = { inline_keyboard: [] };

/** answerCallbackQuery — CHỈ gateway gọi (Telegram reject answer lần 2 trên
 *  cùng callback_query_id; extension không bao giờ answer — mọi feedback của
 *  extension đi qua editMessage). */
async function callAnswerCallbackQuery(callbackQueryId, text) {
  try {
    const body = { callback_query_id: callbackQueryId };
    if (text) body.text = text;
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (json.ok) return { ok: true };
    return {
      ok: false,
      error: json.description ? `${res.status}: ${json.description}` : `status ${res.status}`,
    };
  } catch (err) {
    return { ok: false, error: `telegram api unreachable: ${String(err)}` };
  }
}

/** sendPhoto — multipart upload (Telegram không nhận base64 data-URL qua
 *  JSON). Node 20+ native FormData/Blob — zero dependency. */
async function callSendPhoto(chatId, imageBase64, caption) {
  try {
    const buf = Buffer.from(imageBase64, 'base64');
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('photo', new Blob([buf], { type: 'image/jpeg' }), 'capture.jpg');
    if (caption) form.append('caption', caption);
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`, {
      method: 'POST',
      body: form,
    });
    const json = await res.json().catch(() => ({}));
    if (json.ok && Array.isArray(json.result?.photo) && json.result.photo.length > 0) {
      return { ok: true };
    }
    if (json.ok) {
      return { ok: false, error: 'telegram response missing photo' };
    }
    return {
      ok: false,
      error: json.description ? `${res.status}: ${json.description}` : `status ${res.status}`,
    };
  } catch (err) {
    return { ok: false, error: `telegram api unreachable: ${String(err)}` };
  }
}

// ─── Watchdog 5s cho callback capture ────────────────────────────────────
// Arm khi broadcast telegram_callback xuống extension; cancel khi extension
// gửi sendPhoto / editMessage cùng chat_id+message_id. Nổ = editMessage
// báo hết giờ + xoá keyboard — user không bao giờ nhìn spinner treo.
const CALLBACK_WATCHDOG_MS = 5_000;
const callbackWatchdogs = new Map(); // `${chat_id}:${message_id}` → timer

function cancelCallbackWatchdog(chatId, messageId) {
  const key = `${chatId}:${messageId}`;
  const timer = callbackWatchdogs.get(key);
  if (timer) {
    clearTimeout(timer);
    callbackWatchdogs.delete(key);
  }
}

function armCallbackWatchdog(chatId, messageId) {
  cancelCallbackWatchdog(chatId, messageId);
  const key = `${chatId}:${messageId}`;
  const timer = setTimeout(() => {
    callbackWatchdogs.delete(key);
    void callEditMessage(chatId, messageId, '⚠️ Hết giờ chụp — Chrome không phản hồi. Thử lại nhé.', undefined, CLEAR_KEYBOARD);
  }, CALLBACK_WATCHDOG_MS);
  callbackWatchdogs.set(key, timer);
}

/** Đọc toàn bộ body của một incoming request dưới dạng string. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** HTTP router: /health + /webhook/telegram. /ws đi qua upgrade handler riêng. */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      clients: clients.size,
      ts: Date.now(),
      hasToken: Boolean(env.TELEGRAM_BOT_TOKEN),
      hasSecret: Boolean(env.TELEGRAM_WEBHOOK_SECRET),
      hasWsToken: Boolean(env.WS_AUTH_TOKEN),
      hasWhitelist: Boolean(env.ALLOWED_CHAT_IDS && String(env.ALLOWED_CHAT_IDS).trim()),
    }));
    return;
  }

  if (url.pathname === '/webhook/telegram') {
    if (req.method === 'GET') {
      res.writeHead(200).end('OK');
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end('Method Not Allowed');
      return;
    }
    // fail-closed：chưa set secret → từ chối tất cả (chặn giả mạo Telegram update)。
    // Header đúng theo Bot API là X-Telegram-Bot-Api-Secret-Token (Node lowercase
    // toàn bộ tên header)——đọc sai tên header = 401 vĩnh viễn với mọi update。
    if (
      !env.TELEGRAM_WEBHOOK_SECRET ||
      !safeEqual(req.headers['x-telegram-bot-api-secret-token'] ?? '', env.TELEGRAM_WEBHOOK_SECRET)
    ) {
      res.writeHead(401).end('Unauthorized');
      return;
    }

    let update;
    try {
      update = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400).end('Bad Request: Invalid JSON');
      return;
    }

    // ─── Inline-keyboard callback (nút bấm từ keyboard của /tabs command) ───
    // Whitelist fail-closed giống tin nhắn. answerCallbackQuery được gateway
    // gọi DUY NHẤT tại đây (Telegram reject answer lần 2 trên cùng
    // callback_query_id — extension không bao giờ answer, mọi feedback của
    // extension đi qua editMessage). Không extension nào online → tự edit
    // message báo lỗi thay vì để user nhìn spinner treo.
    if (update.callback_query) {
      const cq = update.callback_query;
      const chatId = cq.message?.chat?.id;
      const messageId = cq.message?.message_id;
      if (
        !chatId || typeof messageId !== 'number' ||
        !isChatAllowed(chatId)
      ) {
        res.writeHead(200).end('OK');
        return;
      }
      void callAnswerCallbackQuery(cq.id, '⏳ Đang chụp tab…');
      if (clients.size === 0) {
        void callEditMessage(
          chatId,
          messageId,
          '⚠️ Chrome extension đang offline — mở Chrome lên rồi thử lại.',
          undefined,
          CLEAR_KEYBOARD,
        );
        res.writeHead(200).end('OK');
        return;
      }
      const payload = JSON.stringify({
        kind: 'telegram_callback',
        callback_query_id: cq.id,
        data: typeof cq.data === 'string' ? cq.data : '',
        chat_id: chatId,
        message_id: messageId,
        from: cq.from ? { id: cq.from.id, username: cq.from.username } : null,
      });
      for (const ws of clients) {
        try { ws.send(payload); } catch { clients.delete(ws); }
      }
      armCallbackWatchdog(chatId, messageId);
      res.writeHead(200).end('OK');
      return;
    }

    // Tin thường + edit đều forward (khớp wire contract)。
    const message = update.message ?? update.edited_message;
    if (!message || typeof message.text !== 'string' || message.text.length === 0) {
      res.writeHead(200).end('OK');
      return;
    }

    // Whitelist fail-closed：ngoài danh sách → 200 OK im lặng (200 để Telegram
    // ngừng retry, không broadcast gì xuống extension)。
    if (!isChatAllowed(message.chat.id)) {
      res.writeHead(200).end('OK');
      return;
    }

    const payload = JSON.stringify({
      kind: 'telegram_message',
      update_id: update.update_id,
      message_id: message.message_id,
      chat_id: message.chat.id,
      chat_type: message.chat.type,
      text: message.text,
      date: message.date,
      from: message.from ? { id: message.from.id, username: message.from.username } : null,
    });

    for (const ws of clients) {
      try {
        ws.send(payload);
      } catch {
        clients.delete(ws);
      }
    }
    res.writeHead(200).end('OK');
    return;
  }

  res.writeHead(404).end('Not Found');
});

// ─── WebSocket upgrade: chỉ nhận GET /ws?token=<WS_AUTH_TOKEN> ───

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }
  // fail-closed：chưa set WS_AUTH_TOKEN → từ chối mọi upgrade。
  const token = url.searchParams.get('token');
  if (!env.WS_AUTH_TOKEN || token !== env.WS_AUTH_TOKEN) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.isAlive = true;
  console.log(`[gateway] client connected (total: ${clients.size})`);

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', async (raw) => {
    let data;
    try {
      data = JSON.parse(String(raw));
    } catch {
      return; // payload hỏng (kể cả keepalive ' ' của extension) — bỏ qua
    }
    if (!data || typeof data.kind !== 'string') {
      return;
    }

    // ─── Ping/Pong heartbeat (2 chiều) ─────────────────────────────────────
    // Extension gửi {kind:'ping'} mỗi 15s. Trước đây heartbeat là 1-chiều
    // (extension gửi space, gateway im lặng) → TCP half-open không bị phát
    // hiện: extension tưởng connection sống, gateway broadcast callback_query
    // xuống socket đã chết ngầm → extension không bao giờ nhận được → /tabs
    // tap im lặng. Respond pong để extension track lastPongAt + tự reconnect
    // khi >45s không thấy pong.
    if (data.kind === 'ping') {
      try {
        ws.send(JSON.stringify({ kind: 'pong', ts: data.ts }));
      } catch {
        // socket đã chết — close handler sẽ dọn
      }
      return;
    }

    if (!data.chat_id) {
      return;
    }

    let result;
    if (!env.TELEGRAM_BOT_TOKEN) {
      result = { ok: false, error: 'bot token not configured' };
    } else if (!isChatAllowed(data.chat_id)) {
      result = { ok: false, error: 'chat_id not in whitelist' };
    } else {
      switch (data.kind) {
        case 'sendMessage':
          if (typeof data.text !== 'string') {
            result = { ok: false, error: 'text required' };
            break;
          }
          result = await callSendMessage(data.chat_id, data.text, data);
          break;
        case 'sendChatAction':
          result = await callSendChatAction(data.chat_id, data.action);
          break;
        case 'editMessage':
          if (typeof data.message_id !== 'number' || typeof data.text !== 'string') {
            result = { ok: false, error: 'message_id and text required' };
            break;
          }
          cancelCallbackWatchdog(data.chat_id, data.message_id);
          result = await callEditMessage(data.chat_id, data.message_id, data.text, data.parse_mode, data.reply_markup);
          break;
        case 'setMessageReaction':
          if (typeof data.message_id !== 'number') {
            result = { ok: false, error: 'message_id required' };
            break;
          }
          result = await callSetMessageReaction(data.chat_id, data.message_id, data.emoji);
          break;
        case 'deleteMessage':
          if (typeof data.message_id !== 'number') {
            result = { ok: false, error: 'message_id required' };
            break;
          }
          result = await callDeleteMessage(data.chat_id, data.message_id);
          break;
        case 'sendPhoto':
          if (typeof data.image_base64 !== 'string' || data.image_base64.length === 0) {
            result = { ok: false, error: 'image_base64 required' };
            break;
          }
          // Huỷ watchdog nếu capture xuất phát từ keyboard (message_id có mặt).
          if (typeof data.message_id === 'number') {
            cancelCallbackWatchdog(data.chat_id, data.message_id);
          }
          result = await callSendPhoto(data.chat_id, data.image_base64, data.caption);
          break;
        default:
          return; // 未知 kind——静默忽略
      }
    }

    // request_id 必须回显——extension 用它配对 in-flight 请求。
    // sendMessage 保留 'sendMessage_result'（向后兼容旧 extension）；
    // sendChatAction / editMessage / setMessageReaction / deleteMessage 用 'gateway_result'。
    const replyKind = data.kind === 'sendMessage' ? 'sendMessage_result' : 'gateway_result';
    try {
      ws.send(
        JSON.stringify({ kind: replyKind, request_id: data.request_id, ...result })
      );
    } catch {
      // socket 中途断开——close handler 负责清理
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[gateway] client disconnected (total: ${clients.size})`);
  });
  ws.on('error', () => {
    clients.delete(ws);
  });
});

// Heartbeat：protocol-level ping mỗi 25s。Browser tự động Pong —— socket chết
// (NAT drop / client tắt máy gấp) sẽ không Pong → terminate + dọn clients。
setInterval(() => {
  for (const ws of clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      clients.delete(ws);
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      clients.delete(ws);
    }
  }
}, 25_000).unref();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[gateway] listening on 0.0.0.0:${PORT}`);
  console.log(`[gateway] env: hasToken=${Boolean(env.TELEGRAM_BOT_TOKEN)} hasSecret=${Boolean(env.TELEGRAM_WEBHOOK_SECRET)} hasWsToken=${Boolean(env.WS_AUTH_TOKEN)} hasWhitelist=${Boolean(env.ALLOWED_CHAT_IDS && String(env.ALLOWED_CHAT_IDS).trim())}`);
});

// Koyeb gửi SIGTERM khi redeploy / scale — đóng sạch để không treo container.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    for (const ws of clients) {
      try { ws.close(); } catch { /* ignore */ }
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
