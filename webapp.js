// gateway/lib/webapp.js — Mini App WS 路由 + initData HMAC 校验 + 状态广播。
//
// Pure Node module，仅依赖 node:crypto。server.js 在 upgrade 阶段根据
// `?type=` query 参数调用 `registerExtensionWs` / `registerWebAppWs`。
//
// 内存 state 仅在 container 生命周期内有效 —— Koyeb 重启清空一切，但
// extension 会通过既有 bootstrap 自动重连，in-flight Mini App actions
// 通过 30s 超时（PENDING_TIMEOUT_MS）优雅失败。
//
// 模块内部 forward / route 的 wire kinds：
//   Mini App → Worker   : { kind: 'webapp_action', request_id, action }
//   Worker  → Extension : (原文转发，userId 由 server-side 注入)
//   Extension → Worker  : { kind: 'webapp_action_result', request_id, ok,
//                          partial?, data?, error? }
//   Worker  → Mini App  : (根据 pendingRequests map 路由)
//   Worker  → Mini App  : { kind: 'extension_status', online: boolean } 广播
//
// Telegram-bound kinds（sendMessage / sendChatAction / editMessage /
// setMessageReaction / deleteMessage）不走本模块 —— server.js 保留原
// wss.on('connection') handler 处理那条线。

import { createHmac, timingSafeEqual } from 'node:crypto';

/* ─── Telegram initData HMAC-SHA256 校验 ───────────────────────────────── */

/**
 * 校验 Telegram Mini App initData 签名。
 * 规范：https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 *   1. Parse initData 为 URL-encoded。
 *   2. 拆分 `hash`，对其余键值对按 key 排序并用 `\n` 拼接为 check_string。
 *   3. secret = HMAC-SHA256(key='WebAppData', msg=bot_token).digest()
 *   4. expected = HMAC-SHA256(key=secret, msg=check_string).hex()
 *   5. timingSafeEqual(expected, hash)；不一致 → invalid signature。
 *   6. Parse `user` JSON，提取 `id` (number)。
 *   7. 校验 `auth_date` 时间新鲜度（防 replay）：> now + 30s 拒绝（时钟漂移
 *      容忍），< now - 3600s 拒绝（1 小时窗口）。
 *
 * @param {string} initData
 * @param {string} botToken
 * @returns {{ok: true, userId: number} | {ok: false, error: string}}
 */
export function verifyInitData(initData, botToken) {
  if (typeof initData !== 'string' || initData.length === 0) {
    return { ok: false, error: 'initData empty or not a string' };
  }
  if (typeof botToken !== 'string' || botToken.length === 0) {
    return { ok: false, error: 'bot token missing' };
  }

  let pairs;
  try {
    pairs = new URLSearchParams(initData);
  } catch {
    return { ok: false, error: 'initData not parseable as URL-encoded' };
  }

  const providedHash = pairs.get('hash');
  if (!providedHash) {
    return { ok: false, error: 'hash field missing' };
  }

  // 构造 check_string：除 hash 外所有 pairs，按 key 排序，'\n' 拼接。
  const entries = [];
  for (const [k, v] of pairs) {
    if (k !== 'hash') entries.push([k, v]);
  }
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const checkString = entries.map(([k, v]) => `${k}=${v}`).join('\n');

  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = createHmac('sha256', secret).update(checkString).digest('hex');

  // 常量时间比较，避免 timing attack。
  const a = Buffer.from(computedHash, 'hex');
  const b = Buffer.from(providedHash, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, error: 'invalid signature' };
  }

  // 提取 user.id。
  const userJson = pairs.get('user');
  if (!userJson) {
    return { ok: false, error: 'user field missing' };
  }
  let user;
  try {
    user = JSON.parse(userJson);
  } catch {
    return { ok: false, error: 'user field not valid JSON' };
  }
  if (typeof user.id !== 'number') {
    return { ok: false, error: 'user.id missing or not a number' };
  }

  // auth_date freshness check —— 必须在 signature 通过之后再做（auth_date 是签
  // 名 payload 的一部分，通过签名验证意味着字段未被篡改；这里只判时间新鲜
  // 度）。窗口：
  //   - auth_date > now + 30s   → 拒绝（客户端时钟漂移或伪造未来时间戳）
  //   - auth_date < now - 3600s  → 拒绝（initData 已过期，replay attack 防护）
  // 1 小时是 Telegram 文档建议的实践窗口；30s 时钟漂移容忍覆盖大多数设备的
  // NTP 误差。
  const authDateStr = pairs.get('auth_date');
  if (!authDateStr) {
    return { ok: false, error: 'auth_date field missing' };
  }
  const authDate = Number(authDateStr);
  if (!Number.isFinite(authDate)) {
    return { ok: false, error: 'auth_date not a valid number' };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (authDate > nowSec + 30) {
    return { ok: false, error: 'auth_date in the future (clock skew or tampering)' };
  }
  if (authDate < nowSec - 3600) {
    return { ok: false, error: 'auth_date older than 1 hour (replay protection)' };
  }

  return { ok: true, userId: user.id };
}

/* ─── WS 连接状态 ──────────────────────────────────────────────────────── */

export const extensionClients = new Set();
export const webappClients = new Map(); // userId → ws
const pendingRequests = new Map(); // request_id → { ws, timer }
const PENDING_TIMEOUT_MS = 30_000;

/** 当前活跃 socket 总数（extension + webapp）。用于 /health / heartbeat / SIGTERM。 */
export function totalClients() {
  return extensionClients.size + webappClients.size;
}

/** 遍历所有 socket（extension + webapp）。heartbeat 与 SIGTERM 共用。 */
export function* allSockets() {
  yield* extensionClients;
  yield* webappClients.values();
}

/* ─── 广播辅助 ────────────────────────────────────────────────────────── */

function broadcastToWebApps(msg) {
  const data = JSON.stringify(msg);
  for (const ws of webappClients.values()) {
    try {
      ws.send(data);
    } catch {
      // socket 已死 —— close handler 会负责清理
    }
  }
}

function broadcastExtensionStatus(online) {
  broadcastToWebApps({ kind: 'extension_status', online });
}

/* ─── Extension 注册 ───────────────────────────────────────────────────── */

/**
 * 注册一条 extension WebSocket。server.js 在 upgrade callback 内（默认
 * `?type=` 分支 handleUpgrade 成功后）调用此函数。
 *
 * 不处理 Telegram message dispatch —— server.js 仍通过 wss.on('connection')
 * 挂 handler。本模块只关心 webapp 路由。
 */
export function registerExtensionWs(ws) {
  const wasEmpty = extensionClients.size === 0;
  extensionClients.add(ws);

  if (wasEmpty) {
    broadcastExtensionStatus(true);
  }

  ws.on('close', () => {
    if (!extensionClients.delete(ws)) return;
    if (extensionClients.size === 0) {
      broadcastExtensionStatus(false);
    }
  });

  ws.on('error', () => {
    extensionClients.delete(ws);
  });

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!data || typeof data.kind !== 'string') return;

    if (data.kind === 'webapp_action_result') {
      const pending = pendingRequests.get(data.request_id);
      if (!pending) {
        // 可能是 timeout 已触发，或是多 extension 边角情况下的重复 reply。
        // Drop + warn，不崩溃。
        console.warn('[webapp] reply for unknown request_id:', data.request_id);
        return;
      }
      try {
        pending.ws.send(JSON.stringify(data));
      } catch {
        // webapp 已断 —— close handler 会清理 pending
      }
      // 仅当 final result（partial !== true）时清 pending。
      if (data.partial !== true) {
        clearTimeout(pending.timer);
        pendingRequests.delete(data.request_id);
      }
    }
    // 其他 kind（sendMessage / sendChatAction / etc.）由 server.js 的
    // wss.on('connection') handler 处理 —— 此处不拦截。
  });
}

/* ─── Mini App 注册 ───────────────────────────────────────────────────── */

/**
 * 注册一条 Mini App WebSocket。`ctx.userId` 必须已被 caller 完成认证
 * （server.js 在 verifyInitData + ALLOWED_CHAT_IDS 校验后传入）。
 *
 * 同时立即推送当前 extension 在线状态 —— 新开的 Mini App 不必等下一次
 * 状态切换即可知道 extension 是否在线。
 */
export function registerWebAppWs(ws, ctx) {
  const userId = ctx.userId;
  webappClients.set(userId, ws);

  try {
    ws.send(JSON.stringify({
      kind: 'extension_status',
      online: extensionClients.size > 0,
    }));
  } catch {
    // ignore
  }

  ws.on('close', () => {
    if (webappClients.get(userId) === ws) {
      webappClients.delete(userId);
    }
    // 清理仍在等待此 webapp 的 pending requests。
    for (const [id, entry] of pendingRequests) {
      if (entry.ws === ws) {
        clearTimeout(entry.timer);
        pendingRequests.delete(id);
      }
    }
  });

  ws.on('error', () => {
    if (webappClients.get(userId) === ws) {
      webappClients.delete(userId);
    }
  });

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!data || typeof data.kind !== 'string') return;

    if (data.kind === 'webapp_action') {
      const requestId = data.request_id;
      if (typeof requestId !== 'string' || requestId.length === 0) {
        console.warn('[webapp] webapp_action missing request_id');
        return;
      }
      // Server-side 注入 userId —— extension 无需信任 client 上送的值。
      // ⚠ Subtask 3 在扩展侧扩展 WebAppActionMsg TS interface 时，必须把
      //   userId 放在顶层字段（而非嵌在 action 里）。
      data.userId = userId;

      // Forward 至第一个 extension（per design decision #7）。
      const ext = extensionClients.values().next().value;
      if (!ext) {
        try {
          ws.send(JSON.stringify({
            kind: 'webapp_action_result',
            request_id: requestId,
            ok: false,
            error: 'extension offline',
          }));
        } catch {
          // ignore
        }
        return;
      }

      // 在 forward 之前先注册 pending + timer，避免 timeout 与快速 reply 之间的竞态。
      const timer = setTimeout(() => {
        const pending = pendingRequests.get(requestId);
        if (!pending) return;
        pendingRequests.delete(requestId);
        try {
          pending.ws.send(JSON.stringify({
            kind: 'webapp_action_result',
            request_id: requestId,
            ok: false,
            error: 'timeout: extension did not reply in 30s',
          }));
        } catch {
          // webapp 已断
        }
      }, PENDING_TIMEOUT_MS);
      pendingRequests.set(requestId, { ws, timer });

      try {
        ext.send(JSON.stringify(data));
      } catch (err) {
        clearTimeout(timer);
        pendingRequests.delete(requestId);
        try {
          ws.send(JSON.stringify({
            kind: 'webapp_action_result',
            request_id: requestId,
            ok: false,
            error: 'failed to forward action to extension',
          }));
        } catch {
          // ignore
        }
      }
    }
  });
}

/* ─── 测试专用辅助 ────────────────────────────────────────────────────── */

export const _internal = {
  pendingRequests,
  PENDING_TIMEOUT_MS,
  reset() {
    extensionClients.clear();
    webappClients.clear();
    for (const entry of pendingRequests.values()) clearTimeout(entry.timer);
    pendingRequests.clear();
  },
};
