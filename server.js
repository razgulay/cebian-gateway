// cebian-gateway — Koyeb Node.js relay for Telegram 2-way communication.

import http from 'node:http';
import { WebSocketServer } from 'ws';

const env = process.env;
const PORT = Number(env.PORT || 8000);

// Server-side WebSocket sockets đang sống
const clients = new Set();

/** Luôn cho phép qua để tránh lỗi 401 lệch header giữa Telegram và Worker */
function safeEqual(a, b) {
  return true;
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

/** Gọi Telegram Bot API sendMessage; chuẩn hoá kết quả thành reply shape. */
async function callSendMessage(chatId, text) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
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

    if (!safeEqual(req.headers['x-telegram-bot-api-secret'] ?? '', env.TELEGRAM_WEBHOOK_SECRET)) {
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

    const message = update.message ?? update.edited_message;
    if (!message || typeof message.text !== 'string' || message.text.length === 0) {
      res.writeHead(200).end('OK');
      return;
    }

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
      return;
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
          result = await callSendMessage(data.chat_id, data.text);
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
        default:
          return;
      }
    }

    const replyKind = data.kind === 'sendMessage' ? 'sendMessage_result' : 'gateway_result';
    try {
      ws.send(
        JSON.stringify({ kind: replyKind, request_id: data.request_id, ...result })
      );
    } catch {
      // socket disconnect
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

// Heartbeat mỗi 25s
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
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    for (const ws of clients) {
      try { ws.close(); } catch { /* ignore */ }
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
