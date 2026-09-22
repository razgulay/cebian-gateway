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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { WebSocketServer } from 'ws';
import * as webapp from './lib/webapp.js';

const env = process.env;
const PORT = Number(env.PORT || 8000);

/** 当前文件所在目录 —— 用于 `GET /app` static serve（Subtask 2 引入）。 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Extension 与 Mini App 的 WS 连接状态由 webapp 模块统一管理。server.js
// 通过 `webapp.extensionClients` / `webapp.webappClients` / `webapp.allSockets()`
// 提供给 heartbeat、/health、SIGTERM —— 不再保留独立的 Set（原 `clients`
// 已在本次重构中移除）。

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
async function callEditMessage(chatId, messageId, text, parseMode) {
  try {
    const body = { chat_id: chatId, message_id: messageId, text };
    if (parseMode) body.parse_mode = parseMode;
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
      // 保留 `clients` 字段以保持向后兼容（总活跃 socket 数）；
      // 新增 `extensions` / `webapps` 用于分别观察两条线。
      clients: webapp.totalClients(),
      extensions: webapp.extensionClients.size,
      webapps: webapp.webappClients.size,
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

    for (const ws of webapp.extensionClients) {
      try {
        ws.send(payload);
      } catch {
        // socket 已死 —— close handler 由 webapp 模块负责清理
      }
    }
    res.writeHead(200).end('OK');
    return;
  }

  // ─── GET /app — Telegram Mini App static HTML ──────────────────────────
  // CSP 关键指令：
  //   - frame-ancestors 限 Telegram 域名嵌入（防 clickjacking / iframe abuse）
  //   - script-src 'unsafe-inline' 允许 inline <script>（HTML 用 vanilla 内嵌）
  //   - connect-src wss:/ws: 同时支持 https 生产与 http localhost 开发
  // Cache-Control: no-cache —— HTML 经常改，每次强制刷新
  if (url.pathname === '/app') {
    const filePath = path.join(__dirname, 'public/index.html');
    const stream = fs.createReadStream(filePath);
    // 流式读取时可能因为文件缺失 / 权限错误 / 部署 race 而 emit 'error'。
    // 必须显式挂 handler，否则 Node 在下一 tick 打 Unhandled 'error' warning，
    // 同时客户端会看到半截响应（headers 已写 200，但 body 中途断流）。
    stream.on('error', (err) => {
      console.error('[gateway] failed to read public/index.html:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      res.end('Internal Server Error');
    });
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Content-Security-Policy':
        "default-src 'self' https://telegram.org; " +
        "script-src 'self' https://telegram.org 'unsafe-inline'; " +
        "style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data:; " +
        "connect-src 'self' wss: ws:; " +
        "frame-ancestors https://web.telegram.org https://t.me;",
    });
    stream.pipe(res);
    return;
  }

  res.writeHead(404).end('Not Found');
});

// ─── WebSocket upgrade：3 条分支 ─────────────────────────────────────────
//   ?type=webapp&initData=…   → Mini App，校验 HMAC + 白名单 → registerWebAppWs
//   ?type=(default) &token=…  → Extension，使用 WS_AUTH_TOKEN         → registerExtensionWs
//   （其它情况）               → 401 fail-closed

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }

  const type = url.searchParams.get('type');

  if (type === 'webapp') {
    // Mini App 路径 —— fail-closed：未设置 bot token → 拒绝（无 token
    // 无法完成 initData 校验）。
    if (!env.TELEGRAM_BOT_TOKEN) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const initData = url.searchParams.get('initData') ?? '';
    const verifyResult = webapp.verifyInitData(initData, env.TELEGRAM_BOT_TOKEN);
    if (!verifyResult.ok) {
      console.warn('[webapp] upgrade rejected:', verifyResult.error);
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    // 语义说明：Telegram DM (1:1) 中 `chat.id === user.id`；Mini App 通过
    // Menu Button 打开运行在 DM 上下文，因此复用现有 `ALLOWED_CHAT_IDS`
    // env 即可 —— 无需新增独立白名单。
    const allowedIds = parseAllowedChatIds(env.ALLOWED_CHAT_IDS);
    if (!allowedIds.has(String(verifyResult.userId))) {
      console.warn(
        `[webapp] upgrade rejected: userId ${verifyResult.userId} not in ALLOWED_CHAT_IDS`,
      );
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      webapp.registerWebAppWs(ws, { userId: verifyResult.userId });
    });
    return;
  }

  // 默认：Extension。沿用原 WS_AUTH_TOKEN 校验（语义不变）。
  const token = url.searchParams.get('token');
  if (!env.WS_AUTH_TOKEN || token !== env.WS_AUTH_TOKEN) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    webapp.registerExtensionWs(ws);
  });
});

wss.on('connection', (ws) => {
  // Extension 已在 upgrade callback 内通过 webapp.registerExtensionWs 注册；
  // webapp 模块持有 Set 生命周期 + close/error/message cleanup（仅限
  // webapp routing）。本 handler 只负责 Telegram-bound dispatch。
  ws.isAlive = true;
  console.log(`[gateway] client connected (total: ${webapp.totalClients()})`);

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
    if (!data || typeof data.kind !== 'string' || !data.chat_id) {
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
          result = await callEditMessage(data.chat_id, data.message_id, data.text, data.parse_mode);
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

  // close / error handlers KHÔNG xoá ws khỏi Set nữa — webapp module đã lo
  // phần đó (qua on('close') của registerExtensionWs). Logging vẫn chạy để
  // operator thấy disconnect.
  ws.on('close', () => {
    console.log(`[gateway] client disconnected (total: ${webapp.totalClients()})`);
  });
  ws.on('error', () => {
    // ws 已 close → webapp 模块负责 Set 清理；此处无需操作。
  });
});

// Heartbeat：protocol-level ping 每 25s。Browser 自动回 Pong —— socket 死亡
// (NAT drop / 客户端突然关机) 不回 Pong → terminate + 由 webapp 模块的
// on('close') handler 完成清理。
setInterval(() => {
  for (const ws of webapp.allSockets()) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      // ignore — close handler sẽ dọn
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
    for (const ws of webapp.allSockets()) {
      try { ws.close(); } catch { /* ignore */ }
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
