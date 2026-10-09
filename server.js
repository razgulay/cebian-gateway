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
//                          disable_notification?, disable_link_preview?,
//                          reply_markup?, bot? ('automation') }
//                        { kind: 'sendChatAction', request_id, chat_id, action, bot? }
//                        { kind: 'editMessage', request_id, chat_id, message_id, text, parse_mode?, bot? }
//                        { kind: 'setMessageReaction', request_id, chat_id, message_id, emoji?, bot? }
//                        { kind: 'deleteMessage', request_id, chat_id, message_id, bot? }
//                          （bot? vắng = bot chat chính; 'automation' → chọn token
//                           TELEGRAM_AUTOMATION_BOT_TOKEN — 5 kind trên đều nhận）
//                        { kind: 'sendPhoto', request_id, chat_id,
//                          image_url? | image_base64?, caption?, parse_mode?,
//                          reply_to_message_id?, message_id? (watchdog cancel) }
//                        { kind: 'sendMediaGroup', request_id, chat_id,
//                          media: InputMediaPhoto[], reply_to_message_id? }
//                        { kind: 'agent_state', chat_id, state, tool?, ts }
//                          （one-way telemetry，无 request_id、不回 ack——/status 读）
//   Worker → extension : { kind: 'sendMessage_result', request_id, ok, message_id?, error? }
//                        { kind: 'gateway_result', request_id, ok, error? }（后两种 action 用）
//
// Env vars (Koyeb Variables hoặc .env):
//   TELEGRAM_BOT_TOKEN      — bot token (chỉ Worker đọc, không log)
//   TELEGRAM_AUTOMATION_BOT_TOKEN — bot token của automation bot (tuỳ chọn;
//                             webhook /webhook/telegram_automation + outbound
//                             action `bot:'automation'` dùng nó; chưa set →
//                             automation webhook 503 + action báo lỗi)
//   TELEGRAM_WEBHOOK_SECRET — giá trị header X-Telegram-Bot-Api-Secret-Token
//                             (dùng chung cho cả 2 bot webhook)
//   WS_AUTH_TOKEN           — shared secret extension trình diện ở ?token=
//   ALLOWED_CHAT_IDS        — CSV chat id (dùng chung cho cả 2 bot); rỗng/chưa
//                             set = từ chối tất cả (fail-closed)
//   PORT                    — mặc định 8000 (Koyeb web port mặc định)

import http from 'node:http';
import { WebSocketServer } from 'ws';

const env = process.env;
const PORT = Number(env.PORT || 8000);

// Server-side WebSocket sockets đang sống (set để delete O(1) trên close).
const clients = new Set();

// ─── Observability state（fail-loud：让"沉默"可读）───
// Timestamps 均为 epoch ms；null = 从未发生。/health v2 与 /status 消费这些值
// ——没有时间戳就无法观测（handoff 原则 3）。
const startedAt = Date.now();
let lastInboundAt = null;         // webhook 收到 Telegram 消息/回调
let lastAutomationInboundAt = null; // webhook 收到 automation bot 消息
let lastBroadcastAt = null;       // gateway 向 extension 广播 frame
let lastExtensionActionAt = null; // extension 发起 action（**不含** ping——
                                  // 算上 ping 的话 15s 心跳会让它永远新鲜，失去诊断意义）
/** String(chat_id) → { state, tool, at }。extension 经 `agent_state` one-way
 *  frame 主动申报（不 reply）；waiting_user = ask_user 正在等用户作答。 */
const agentStates = new Map();

// ─── Stall detector（re-arm + fire-gate）───
// Timer 语义 = 「距最后一条用户可见 action 已 45s」。extension 在 agent 运行期
// 间每 ~4s 刷新 typing（sendChatAction），每条 STALL_CLEARING_KINDS frame 都会
// re-arm——只有活动真正停止 45s 才触发，覆盖 run 中途 Chrome 被杀 / LLM 断连
// 这类最常见的静默失败。
// Fire-gate：到点后只有 extension 申报的 agent_state 处于 thinking / tool 才发
// 警报——无 state（旧 extension 从不发 agent_state）或 idle / waiting_user 一律
// 抑制：旧行为不回退、turn 已结束或正在等用户作答时沉默是正常的。任何部署组合
// （gateway 新 + extension 旧 / 反之）都不会误报。
// timer .unref()（不吊住进程）；socket close 不清理——之后警报依然是正确信号。
const STALL_MS = 45_000;
const stallTimers = new Map(); // String(chat_id) → { timer, replyTo }

function armStallWatch(chatId, replyToMessageId = null) {
  const key = String(chatId);
  // re-arm 时保留最初那条用户消息作 reply 锚点（只有 webhook 侧带 message_id）
  const prev = stallTimers.get(key);
  if (prev) clearTimeout(prev.timer);
  const replyTo = replyToMessageId ?? prev?.replyTo ?? null;
  const timer = setTimeout(() => {
    stallTimers.delete(key);
    const st = agentStates.get(key);
    if (!st || st.state === 'idle' || st.state === 'waiting_user') return;
    void callSendMessage(
      chatId,
      `⏳ Agent chưa có phản hồi sau ${STALL_MS / 1000}s — có thể đang kẹt. Gõ /status để kiểm tra.`,
      { ...(replyTo != null ? { reply_to_message_id: replyTo } : {}) },
    );
  }, STALL_MS);
  timer.unref();
  stallTimers.set(key, { timer, replyTo });
}

function clearStallWatch(chatId) {
  const key = String(chatId);
  const entry = stallTimers.get(key);
  if (entry) {
    clearTimeout(entry.timer);
    stallTimers.delete(key);
  }
}

/** 这些 action 表示 extension 正在产出用户可见的响应 → re-arm 该 chat 的监视
 *  （45s 从最后一个 action 重新起算，不是第一次 action 就永久解除）。 */
const STALL_REARM_KINDS = new Set([
  'sendMessage',
  'editMessage',
  'sendChatAction',
  'sendPhoto',
  'sendMediaGroup',
]);

/** Constant-time string compare — so byte cùng độ dài, không lộ timing. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

/** Match 1 ảnh Markdown: `![alt](url)`. URL không được chứa `)` hay khoảng
 *  trắng (Telegram Bot API cũng không nhận các ký tự đó trong URL). Nhóm 1
 *  = alt, nhóm 2 = url. Tách Markdown image thành phần text-only + 1 mảng
 *  ảnh để case 'sendMessage' route sang sendPhoto / sendMediaGroup thay vì
 *  nhét cả `![…](…)` thành chuỗi raw dài ngoằng mà Telegram parser sẽ
 *  biến thành văn bản hỏng. */
const MARKDOWN_IMAGE_RE = /!\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)/g;
const TELEGRAM_ALBUM_MAX = 10;

/** Trích tất cả ảnh Markdown khỏi `text`, trả về { cleanText, images }.
 *  - cleanText:  text đã loại bỏ các thẻ ảnh, có thể kèm dọn khoảng trắng
 *                thừa (leading/trailing blank lines, nhiều dòng trống liên
 *                tiếp) — tránh để caption trống khi user chỉ gửi ảnh.
 *  - images:     mảng { url, alt } theo thứ tự xuất hiện trong text gốc.
 *  Alt chỉ dùng để debug; Telegram chỉ nhận URL, không có alt text. */
function extractMarkdownImages(text) {
  const images = [];
  // Bảo toàn alt có chứa `]` ở giữa bằng nhóm [^\]\n]* (không cho phép ] xuống dòng).
  for (const m of text.matchAll(MARKDOWN_IMAGE_RE)) {
    images.push({ url: m[2], alt: m[1] || '' });
  }
  const cleanText = text
    .replace(MARKDOWN_IMAGE_RE, '')
    .replace(/[ \t]+\n/g, '\n')        // bỏ trailing space trước newline
    .replace(/\n{3,}/g, '\n\n')        // gộp 3+ newline liên tiếp
    .replace(/^\s+|\s+$/g, '');         // trim
  return { cleanText, images };
}

/** CSV → Set<string> chat id. env rỗng → tập rỗng = từ chối tất cả (fail-closed).
 *  Chỉ parse MỘT LẦN ở module level — env tĩnh theo lifetime container (Koyeb
 *  đổi env = restart), không cần invalidation; nhờ đó isChatAllowed trên hot
 *  path (mỗi webhook message / callback / outbound action) là O(1) thuần túy. */
function parseAllowedChatIds(raw) {
  const set = new Set();
  for (const piece of String(raw ?? '').split(',')) {
    const id = piece.trim();
    if (id) set.add(id);
  }
  return set;
}

const ALLOWED_CHATS_SET = parseAllowedChatIds(env.ALLOWED_CHAT_IDS);


// ─── Runtime config (zero-terminal) ───
// env chỉ là **giá trị khởi tạo fallback**; extension sau khi nối WS đẩy frame
// `configure_bots` (token 2 bot + webhook secret + whitelist) đè lên runtime.
// Server restart mất runtime → tự phục hồi vài giây nhờ extension reconnect
// + re-push (Telegram có retry webhook).
const runtime = {
  mainBotToken: env.TELEGRAM_BOT_TOKEN || null,
  automationBotToken: env.TELEGRAM_AUTOMATION_BOT_TOKEN || null,
  webhookSecret: env.TELEGRAM_WEBHOOK_SECRET || null,
  allowedChats: ALLOWED_CHATS_SET,
  whitelistSource: 'env',
};

function isChatAllowed(chatId) {
  return runtime.allowedChats.has(String(chatId));
}

/** Gọi Telegram Bot API sendMessage; chuẩn hoá kết quả thành reply shape.
 *  extra — các field tuỳ chọn forward thẳng từ wire action:
 *    parse_mode            → body.parse_mode
 *    reply_to_message_id   → body.reply_to_message_id (Block 1 reply vào tin user)
 *    disable_notification  → body.disable_notification (Block 2+ im lặng)
 *    disable_link_preview  → body.link_preview_options.is_disabled (chống card preview lợn cột)
 *  token — bot token đích (mặc định = bot chat chính; automation action truyền
 *    token của automation bot — helper nhận token thay vì tự đọc env để mọi
 *    đường gửi đi đều tường minh bot nào). */
async function callSendMessage(chatId, text, extra = {}, token = runtime.mainBotToken) {
  try {
    const body = { chat_id: chatId, text };
    if (extra.parse_mode) body.parse_mode = extra.parse_mode;
    if (extra.reply_to_message_id) body.reply_to_message_id = extra.reply_to_message_id;
    if (extra.disable_notification) body.disable_notification = true;
    if (extra.disable_link_preview) body.link_preview_options = { is_disabled: true };
    if (extra.reply_markup) body.reply_markup = extra.reply_markup;
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
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

/** sendChatAction — typing indicator (Telegram tự hết hạn ~5s → client tái gửi 4s/lần).
 *  token — bot đích (mặc định = bot chat chính; automation action truyền token
 *  riêng — cùng pattern với callSendMessage). */
async function callSendChatAction(chatId, action, token = runtime.mainBotToken) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
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
async function callEditMessage(chatId, messageId, text, parseMode, replyMarkup, token = runtime.mainBotToken) {
  try {
    const body = { chat_id: chatId, message_id: messageId, text };
    if (parseMode) body.parse_mode = parseMode;
    if (replyMarkup) body.reply_markup = replyMarkup;
    const res = await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
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
async function callSetMessageReaction(chatId, messageId, emoji, token = runtime.mainBotToken) {
  try {
    const reaction = emoji ? [{ type: 'emoji', emoji }] : [];
    const res = await fetch(`https://api.telegram.org/bot${token}/setMessageReaction`, {
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
async function callDeleteMessage(chatId, messageId, token = runtime.mainBotToken) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
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
    const res = await fetch(`https://api.telegram.org/bot${runtime.mainBotToken}/answerCallbackQuery`, {
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

/** Danh sách lệnh hiện cho autocomplete khi user gõ `/` trong chat.
 *  Đăng ký một lần lúc boot (xem `registerBotCommands`) — Bot API lưu phía
 *  Telegram, không cần gọi lại mỗi request. Command KHÔNG kèm `/` (Bot API
 *  convention). Description ≤ 256 ký tự; ở đây ngắn vì chỉ là gợi ý autocomplete
 *  (Telegram cắt phần dài trên mobile).
 *
 *  ⚠️ `setMyCommands` **THAY THẾ toàn bộ** danh sách, không phải append — kể cả
 *  danh sách user từng set qua BotFather. Nên mọi lệnh bot hỗ trợ phải có mặt ở
 *  đây, thiếu một cái là nó biến mất khỏi menu `/`. Thêm lệnh mới thì sửa mảng
 *  này, đừng set tay qua BotFather (lần boot sau sẽ ghi đè).
 *
 *  Chỉ khai báo command mà gateway biết chắc: `/tabs` + `/model` do extension
 *  xử lý (gateway chỉ forward), `/status` + `/ping` gateway tự trả lời. Đừng
 *  thêm lệnh ở đây nếu chưa có phía xử lý — user gõ vào sẽ không ai đáp. */
const BOT_COMMANDS = [
  { command: 'model', description: 'Đổi model cho hội thoại này' },
  { command: 'tabs', description: 'Chụp màn hình một tab đang mở' },
  { command: 'status', description: 'Trạng thái gateway và agent' },
  { command: 'ping', description: 'Kiểm tra gateway còn sống' },
];

/** setMyCommands — đăng ký autocomplete cho `/`. Best-effort: fail thì chỉ log,
 *  KHÔNG chặn boot (autocomplete thiếu vẫn gõ tay được lệnh). Retry 1 lần sau
 *  10s vì cold start trên Koyeb có thể chưa ra được internet. */
let botCommandsRegistered = Boolean(runtime.mainBotToken);

async function registerBotCommands() {
  const call = async () => {
    const res = await fetch(`https://api.telegram.org/bot${runtime.mainBotToken}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands: BOT_COMMANDS }),
    });
    const json = await res.json().catch(() => ({}));
    return json.ok ? { ok: true } : { ok: false, error: json.description ?? `status ${res.status}` };
  };
  try {
    const first = await call();
    if (first.ok) {
      console.log('[gateway] bot commands registered:', BOT_COMMANDS.map((c) => c.command).join(', '));
      return;
    }
    console.warn('[gateway] setMyCommands failed, retrying in 10s:', first.error);
  } catch (err) {
    console.warn('[gateway] setMyCommands unreachable, retrying in 10s:', String(err));
  }
  setTimeout(() => {
    call()
      .then((r) => {
        if (r.ok) console.log('[gateway] bot commands registered on retry');
        else console.warn('[gateway] setMyCommands retry failed:', r.error);
      })
      .catch((err) => console.warn('[gateway] setMyCommands retry unreachable:', String(err)));
  }, 10_000).unref();
}

/** sendPhoto (web URL) — JSON POST, Telegram server-side tự fetch ảnh
 *  (≤10MB, jpg/png/gif; URL không tải được → Telegram trả 400, caller fallback).
 *  caption / parse_mode forward thẳng (caption markdown của AI reply);
 *  replyToMessageId map sang reply_parameters (Bot API 7+). */
async function callSendPhotoUrl(chatId, photoUrl, caption, parseMode, replyToMessageId) {
  try {
    const body = { chat_id: chatId, photo: photoUrl };
    if (caption) body.caption = caption;
    if (parseMode) body.parse_mode = parseMode;
    if (typeof replyToMessageId === 'number') {
      body.reply_parameters = { message_id: replyToMessageId, allow_sending_without_reply: true };
    }
    const res = await fetch(`https://api.telegram.org/bot${runtime.mainBotToken}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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

/** sendMediaGroup — JSON POST Bot API sendMediaGroup (native photo album).
 *  reply_to_message_id map sang reply_parameters (Bot API 7+; allow_sending_
 *  without_reply để tin gốc bị xoá vẫn gửi được). parse_mode KHÔNG phải param
 *  cấp top của sendMediaGroup — Bot API yêu cầu parse_mode nằm trên từng
 *  InputMedia có caption, nên opts.parseMode được dịch xuống media tương ứng
 *  (hiện chỉ media[0] mang caption). ok = Telegram trả mảng message. */
async function callSendMediaGroup(chatId, media, opts = {}) {
  try {
    const body = {
      chat_id: chatId,
      media: media.map((item) =>
        item.caption && opts.parseMode ? { ...item, parse_mode: opts.parseMode } : item,
      ),
    };
    if (typeof opts.replyToMessageId === 'number') {
      body.reply_parameters = { message_id: opts.replyToMessageId, allow_sending_without_reply: true };
    }
    const res = await fetch(`https://api.telegram.org/bot${runtime.mainBotToken}/sendMediaGroup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (json.ok && Array.isArray(json.result) && json.result.length > 0) {
      return { ok: true };
    }
    if (json.ok) {
      return { ok: false, error: 'telegram response missing messages' };
    }
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
    const res = await fetch(`https://api.telegram.org/bot${runtime.mainBotToken}/sendPhoto`, {
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
    // Observability v2：每个状态都带时间戳——旧 payload 无时间，健康容器与死了
    // 3 小时的容器看起来一样。sinceLastPongMs 是核心诊断指标（extension 心跳
    // 15s，>60s = socket half-open，但 clients.size 仍在数它）。
    const now = Date.now();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: clients.size > 0 ? 'ok' : 'degraded',
      clients: clients.size,
      ts: now,
      uptimeSec: Math.round((now - startedAt) / 1000),
      clientsDetail: [...clients].map((ws) => ({
        connectedAt: ws.connectedAt,
        lastPongAt: ws.lastPongAt,
        ageMs: now - ws.connectedAt,
        sinceLastPongMs: now - ws.lastPongAt,
      })),
      hasToken: Boolean(runtime.mainBotToken),
      hasSecret: Boolean(runtime.webhookSecret),
      hasWsToken: Boolean(env.WS_AUTH_TOKEN),
      hasWhitelist: runtime.allowedChats.size > 0,
      whitelistSource: runtime.whitelistSource,
      hasAutomationToken: Boolean(runtime.automationBotToken),
      lastInboundAt,
      lastAutomationInboundAt,
      lastBroadcastAt,
      lastExtensionActionAt,
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
      !runtime.webhookSecret ||
      !safeEqual(req.headers['x-telegram-bot-api-secret-token'] ?? '', runtime.webhookSecret)
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
    //
    // callback_data 按前缀分流：`au:` = ask_user 的问答键盘（extension 侧
    // ask-user.ts 生成）；`sm:` = /model 的选型键盘（extension 侧
    // model-command.ts 生成）——两者都是「extension 自己管理的交互键盘」，
    // 不弹「Đang chụp tab」toast、不 arm 5s watchdog（问答要等用户读题作答，
    // 选模型要等 extension 排队等 agent idle，5s 都会把键盘改没）；过期清理
    // 由 extension 负责，gateway 对它们无状态。其余（`cap_*` 等）走原 /tabs
    // 截图流程，行为原状。
    if (update.callback_query) {
      lastInboundAt = Date.now();
      const cq = update.callback_query;
      const cbData = typeof cq.data === 'string' ? cq.data : '';
      // extension 自管的交互键盘：`au:`（ask_user）/ `sm:`（/model）。
      const isExtensionKeyboard =
        cbData.startsWith('au:') || cbData.startsWith('sm:');
      const chatId = cq.message?.chat?.id;
      const messageId = cq.message?.message_id;
      console.log('[gateway] callback_query received', {
        cb_id: cq.id,
        data: cq.data,
        chat_id: chatId,
        message_id: messageId,
        whitelisted: chatId ? isChatAllowed(chatId) : false,
        extensions: clients.size,
      });
      if (
        !chatId || typeof messageId !== 'number' ||
        !isChatAllowed(chatId)
      ) {
        console.warn('[gateway] callback_query REJECTED (whitelist or missing fields)');
        res.writeHead(200).end('OK');
        return;
      }
      console.log('[gateway] callback_query accepted — answering + broadcasting to', clients.size, 'clients');
      void callAnswerCallbackQuery(cq.id, isExtensionKeyboard ? undefined : '⏳ Đang chụp tab…');
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
        data: cbData,
        chat_id: chatId,
        message_id: messageId,
        from: cq.from ? { id: cq.from.id, username: cq.from.username } : null,
      });
      for (const ws of clients) {
        try { ws.send(payload); } catch { clients.delete(ws); }
      }
      lastBroadcastAt = Date.now();
      // 仅 /tabs 截图回调 arm 5s watchdog；ask_user / /model 的键盘存活期以分钟计
      // （10 分钟过期由 extension 侧清理），gateway 对 au: / sm: 无状态。
      if (!isExtensionKeyboard) armCallbackWatchdog(chatId, messageId);
      res.writeHead(200).end('OK');
      return;
    }

    // Tin thường + edit đều forward (khớp wire contract)。
    // 先快照再打点——/status 自身也会更新 lastInboundAt，若直接读当前值，
    // 「Tin cuối từ Telegram」将永远是 0s，诊断意义归零。
    const prevInboundAt = lastInboundAt;
    lastInboundAt = Date.now();
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

    // ─── /status · /ping — gateway TỰ trả lời，不转发 agent ───
    // 必须排在 clients.size === 0 guard **之前**：extension offline 的时刻——
    // 正是用户最需要它的时刻——命令不能被吞。顺序：whitelist → /status →
    // guard → broadcast。@botname 后缀与 /tabs 的 regex 保持一致（群聊）。
    const cmd = message.text.trim().toLowerCase();
    if (/^\/(status|ping)(@\S+)?$/.test(cmd)) {
      const now = Date.now();
      const ago = (t) => (t ? `${Math.round((now - t) / 1000)}s trước` : 'chưa có');
      const agent = agentStates.get(String(message.chat.id));
      const lines = [
        `🩺 Gateway: ${clients.size > 0 ? 'OK' : 'DEGRADED'}`,
        `Extension online: ${clients.size}`,
        `Uptime: ${Math.round((now - startedAt) / 60000)} phút`,
        `Tin cuối từ Telegram: ${ago(prevInboundAt)}`,
        `Lệnh cuối từ extension: ${ago(lastExtensionActionAt)}`,
        `Agent: ${agent ? `${agent.state}${agent.tool ? ` (${agent.tool})` : ''} — ${ago(agent.at)}` : 'không rõ'}`,
      ];
      void callSendMessage(message.chat.id, lines.join('\n'), {
        reply_to_message_id: message.message_id,
      });
      res.writeHead(200).end('OK');
      return;
    }

    // Fail-loud：没有任何 extension online → 消息会广播进空 Set 然后蒸发。
    // 直接告知用户，而不是 200 OK 静默吞掉。
    if (clients.size === 0) {
      void callSendMessage(
        message.chat.id,
        '⚠️ Không có Chrome extension nào online — tin của bạn chưa được xử lý. Mở Chrome rồi gửi lại.',
        { reply_to_message_id: message.message_id },
      );
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
      // 回复锚点：用户回复了 bot 之前推送的消息（如 dispatch_agent 的报告块）。
      // undefined → JSON.stringify 自动删除该 key。
      reply_to_message_id: message.reply_to_message?.message_id,
    });

    for (const ws of clients) {
      try {
        ws.send(payload);
      } catch {
        clients.delete(ws);
      }
    }
    lastBroadcastAt = Date.now();
    // 新消息待 extension 处理 → 首次 arm（带 reply 锚点）。此后由 extension 的
    // 每条用户可见 action re-arm——fire-gate 语义见 armStallWatch 上方的块注释。
    armStallWatch(message.chat.id, message.message_id);
    res.writeHead(200).end('OK');
    return;
  }

  // ─── Automation bot webhook（独立 bot，token 存 server env）───
  // 与主 bot 路由同构：GET 探活 / 非 POST 405 / secret fail-closed / whitelist
  // fail-closed。v1 只转发文本 message（callback / edited / media 等 update 一律
  // 200 吞掉）；不做 /status 命令、不 arm stall watch（automation turn 自带
  // watchdog，调度 turn 的死活由 extension 侧兜底；stall 提醒走主 bot 会对错误
  // 的 chat 说话）。extension offline 的 fail-loud 提示走 automation token——
  // 对正确的 chat 说话。
  if (url.pathname === '/webhook/telegram_automation') {
    if (req.method === 'GET') {
      res.writeHead(200).end('OK');
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end('Method Not Allowed');
      return;
    }
    if (!runtime.automationBotToken) {
      // token 未配置 → Telegram 重试无意义，503 明确告知配置缺失。
      res.writeHead(503).end('automation bot token not configured');
      return;
    }
    if (
      !runtime.webhookSecret ||
      !safeEqual(req.headers['x-telegram-bot-api-secret-token'] ?? '', runtime.webhookSecret)
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
    lastAutomationInboundAt = Date.now();
    const message = update.message;
    if (!message || typeof message.text !== 'string' || message.text.length === 0) {
      // 非 text update（media / sticker / edited...）——确认消费，不转发。
      res.writeHead(200).end('OK');
      return;
    }
    if (!isChatAllowed(message.chat.id)) {
      res.writeHead(200).end('OK');
      return;
    }

    // Fail-loud：extension offline → 告知而不是静默蒸发（走 automation token，
    // 说到正确的 chat）。
    if (clients.size === 0) {
      void callSendMessage(
        message.chat.id,
        '⚠️ Không có Chrome extension nào online — tin của bạn chưa được xử lý. Mở Chrome rồi gửi lại.',
        { reply_to_message_id: message.message_id },
        runtime.automationBotToken,
      );
      res.writeHead(200).end('OK');
      return;
    }

    const payload = JSON.stringify({
      kind: 'telegram_automation_message',
      update_id: update.update_id,
      message_id: message.message_id,
      chat_id: message.chat.id,
      chat_type: message.chat.type,
      text: message.text,
      date: message.date,
      from: message.from ? { id: message.from.id, username: message.from.username } : null,
      reply_to_message_id: message.reply_to_message?.message_id,
    });

    for (const ws of clients) {
      try {
        ws.send(payload);
      } catch {
        clients.delete(ws);
      }
    }
    lastBroadcastAt = Date.now();
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
  // fail-closed：chưa set WS_AUTH_TOKEN → từ chối mọi upgrade。So sánh constant-time
  // bằng safeEqual — nhất quán với webhook secret ở trên (chống timing side-channel).
  const token = url.searchParams.get('token');
  if (!env.WS_AUTH_TOKEN || !safeEqual(token ?? '', env.WS_AUTH_TOKEN)) {
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
  ws.connectedAt = Date.now();
  ws.lastPongAt = Date.now();
  console.log(`[gateway] client connected (total: ${clients.size})`);

  ws.on('pong', () => {
    ws.isAlive = true;
    ws.lastPongAt = Date.now();
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

    // 到这里的每个 frame 都是 extension 的真实动作（ping 已被上面拦截）→ 标记
    // 存活时间戳。
    lastExtensionActionAt = Date.now();

    // agent_state — one-way telemetry（extension → gateway），与 ping 同层处理：
    // **不回** gateway_result（extension 用 sendState raw-send 发送，没有
    // pendingAcks 等待 resolve）。排在 switch 与 token/whitelist gate 之前——
    // frame 无害：/status 读 agentStates 仍需过 whitelist。
    if (data.kind === 'agent_state') {
      // 无 chat_id 的 frame 存进 map 会产生 "undefined" 垃圾 key——直接丢弃。
      if (data.chat_id == null) return;
      // 显式解除：turn 结束（idle）或正在等用户作答（waiting_user）时，
      // 沉默是正常的——不需要 stall 警报。
      if (data.state === 'idle' || data.state === 'waiting_user') {
        clearStallWatch(data.chat_id);
      }
      agentStates.set(String(data.chat_id), {
        state: typeof data.state === 'string' ? data.state : 'unknown',
        tool: typeof data.tool === 'string' && data.tool.length > 0 ? data.tool : null,
        at: Date.now(),
      });
      return;
    }

    // ─── configure_bots (zero-terminal) ───
    // Extension đẩy runtime config ngay sau connect + mỗi lần Save: token 2 bot,
    // webhook secret, whitelist. Chỉ đè field được gửi; env là fallback khởi tạo.
    // Reply gateway_result để extension dùng sendOutbound (có queue + ack).
    if (data.kind === 'configure_bots') {
      if (typeof data.mainBotToken === 'string' && data.mainBotToken) runtime.mainBotToken = data.mainBotToken;
      if (typeof data.automationBotToken === 'string' && data.automationBotToken) runtime.automationBotToken = data.automationBotToken;
      if (typeof data.webhookSecret === 'string' && data.webhookSecret) runtime.webhookSecret = data.webhookSecret;
      if (Array.isArray(data.allowedChatIds)) {
        runtime.allowedChats = new Set(data.allowedChatIds.map((id) => String(id)));
        runtime.whitelistSource = 'runtime';
      }
      console.log(`[gateway] runtime config updated: main=${Boolean(runtime.mainBotToken)} automation=${Boolean(runtime.automationBotToken)} secret=${Boolean(runtime.webhookSecret)} whitelist=${runtime.allowedChats.size} (source=${runtime.whitelistSource})`);
      // zero-terminal：main token 经 configure_bots 首次到位 → 补注册 bot 命令
      //（boot 时 env 无 token 的部署从未跑过）。null→set 转变只跑一次。
      if (runtime.mainBotToken && !botCommandsRegistered) {
        botCommandsRegistered = true;
        void registerBotCommands();
      }
      try {
        ws.send(JSON.stringify({ kind: 'gateway_result', request_id: data.request_id, ok: true }));
      } catch { /* socket đã chết — close handler sẽ dọn */ }
      return;
    }

    if (!data.chat_id) {
      return;
    }

    // extension 正在产出用户可见的响应 → re-arm 该 chat 的 stall 监视
    // （45s 从最后一个 action 重新起算；reply 锚点保留最初那条用户消息）。
    // automation bot 的 action 不 re-arm——stall 提醒只走主 bot，对 automation
    // chat 说话会用错 bot。
    if (data.bot !== 'automation' && STALL_REARM_KINDS.has(data.kind)) {
      armStallWatch(data.chat_id);
    }

    let result;
    // action 的目标 bot token：`bot:'automation' ` → automation bot（各 turn-UX
    // action 均带该判别——sendMessage / sendChatAction / editMessage /
    // setMessageReaction / deleteMessage）；缺省 = 主 chat bot。
    const actionToken =
      data.bot === 'automation' ? runtime.automationBotToken : runtime.mainBotToken;
    if (!actionToken) {
      result = {
        ok: false,
        error: data.bot === 'automation' ? 'automation bot token not configured' : 'bot token not configured',
      };
    } else if (!isChatAllowed(data.chat_id)) {
      result = { ok: false, error: 'chat_id not in whitelist' };
    } else {
      switch (data.kind) {
        case 'sendMessage':
          if (typeof data.text !== 'string') {
            result = { ok: false, error: 'text required' };
            break;
          }
          if (data.bot === 'automation') {
            // automation bot v1：纯文本 sendMessage（不拆 Markdown 图片——
            // sendPhoto / sendMediaGroup 的 call helper 尚不支持 token 注入，
            // automation turn 的回复以文本为主；需要图片时后续再把 token
            // 参数化到 callSendPhotoUrl / callSendMediaGroup）。
            result = await callSendMessage(data.chat_id, data.text, data, actionToken);
            break;
          }
          // Tách ảnh Markdown: nếu text chứa `![alt](url)` thì thay vì nhét
          // cả thẻ vào callSendMessage (Telegram parser sẽ lột `![]` và in
          // raw URL → link preview bể góc + rác text), tách ra rồi gửi ảnh
          // native qua sendPhoto (1 ảnh) hoặc sendMediaGroup (2–10 ảnh).
          // Wire contract: vẫn trả 'sendMessage_result' để extension match
          // đúng in-flight request, với message_id từ phần tử cuối cùng
          // gửi thành công (text, 1 photo, hoặc media group).
          const { cleanText, images } = extractMarkdownImages(data.text);
          if (images.length === 0) {
            // Không có ảnh — luồng cũ không đổi
            result = await callSendMessage(data.chat_id, data.text, data, actionToken);
            break;
          }
          // Có ảnh: gửi text trước (nếu có nội dung) để dùng reply anchor
          let sentTextMessageId = null;
          if (cleanText.length > 0) {
            const textResult = await callSendMessage(data.chat_id, cleanText, data, actionToken);
            if (textResult.ok && typeof textResult.message_id === 'number') {
              sentTextMessageId = textResult.message_id;
            } else if (!textResult.ok) {
              // text gửi fail nhưng ảnh có thể vẫn gửi được — tiếp tục gửi ảnh
              // để user vẫn nhận được gì đó; vẫn trả lỗi ở result dưới.
              result = textResult;
            }
          }
          // Nếu ảnh > 10 (giới hạn Bot API) → cắt + log (chỉ giữ 10 đầu).
          // 11+ ảnh là edge case cực hiếm từ agent; user vẫn nhận album 10 ảnh.
          const slice = images.slice(0, TELEGRAM_ALBUM_MAX);
          let mediaResult;
          if (slice.length === 1) {
            mediaResult = await callSendPhotoUrl(
              data.chat_id,
              slice[0].url,
              undefined,             // caption đã tách thành cleanText ở trên
              undefined,             // parse_mode: ảnh đơn không kèm MD
              sentTextMessageId ?? data.reply_to_message_id,
            );
          } else {
            // sendMediaGroup: mỗi item là InputMediaPhoto có type + media.
            const media = slice.map((img) => ({ type: 'photo', media: img.url }));
            mediaResult = await callSendMediaGroup(data.chat_id, media, {
              replyToMessageId: sentTextMessageId ?? data.reply_to_message_id,
            });
          }
          // Ưu tiên text error (nếu có) > media error; nếu cả hai ok thì gộp
          // ok=true + lấy message_id text (nếu có) để extension match.
          if (result && !result.ok) {
            // text đã fail; media kết quả coi như nỗ lực cuối
            if (mediaResult && mediaResult.ok) {
              result = { ok: false, error: `${result.error}; media ok but text failed` };
            }
            break;
          }
          if (mediaResult && mediaResult.ok) {
            result = { ok: true, message_id: sentTextMessageId ?? undefined };
          } else {
            result = mediaResult ?? { ok: false, error: 'media send failed' };
          }
          break;
        case 'sendChatAction':
          result = await callSendChatAction(data.chat_id, data.action, actionToken);
          break;
        case 'editMessage':
          if (typeof data.message_id !== 'number' || typeof data.text !== 'string') {
            result = { ok: false, error: 'message_id and text required' };
            break;
          }
          if (data.bot === 'automation') {
            // automation không có keyboard → không có watchdog để cancel.
            result = await callEditMessage(data.chat_id, data.message_id, data.text, data.parse_mode, data.reply_markup, actionToken);
            break;
          }
          cancelCallbackWatchdog(data.chat_id, data.message_id);
          result = await callEditMessage(data.chat_id, data.message_id, data.text, data.parse_mode, data.reply_markup, actionToken);
          break;
        case 'setMessageReaction':
          if (typeof data.message_id !== 'number') {
            result = { ok: false, error: 'message_id required' };
            break;
          }
          result = await callSetMessageReaction(data.chat_id, data.message_id, data.emoji, actionToken);
          break;
        case 'deleteMessage':
          if (typeof data.message_id !== 'number') {
            result = { ok: false, error: 'message_id required' };
            break;
          }
          result = await callDeleteMessage(data.chat_id, data.message_id, actionToken);
          break;
        case 'sendPhoto':
          // Huỷ watchdog nếu capture xuất phát từ keyboard (message_id có mặt).
          // Đặt trước cả hai nhánh — type cho phép image_url + message_id cùng xuất hiện.
          if (typeof data.message_id === 'number') {
            cancelCallbackWatchdog(data.chat_id, data.message_id);
          }
          // Hai nguồn ảnh: image_url (web — JSON POST, Telegram tự fetch) hoặc
          // image_base64 (screenshot — multipart upload). Bắt buộc có một.
          if (typeof data.image_url === 'string' && data.image_url.length > 0) {
            result = await callSendPhotoUrl(data.chat_id, data.image_url, data.caption, data.parse_mode, data.reply_to_message_id);
            break;
          }
          if (typeof data.image_base64 !== 'string' || data.image_base64.length === 0) {
            result = { ok: false, error: 'image_url or image_base64 required' };
            break;
          }
          result = await callSendPhoto(data.chat_id, data.image_base64, data.caption);
          break;
        case 'sendMediaGroup':
          if (!Array.isArray(data.media) || data.media.length === 0) {
            result = { ok: false, error: 'media required' };
            break;
          }
          result = await callSendMediaGroup(data.chat_id, data.media, {
            parseMode: data.parse_mode,
            replyToMessageId: data.reply_to_message_id,
          });
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
  console.log(`[gateway] tokens: main=${Boolean(runtime.mainBotToken)} automation=${Boolean(runtime.automationBotToken)} secret=${Boolean(runtime.webhookSecret)} ws=${Boolean(env.WS_AUTH_TOKEN)} whitelist=${runtime.allowedChats.size} (source=${runtime.whitelistSource})`);
  // Autocomplete cho `/` — best-effort, không chặn boot (xem registerBotCommands).
  if (runtime.mainBotToken) void registerBotCommands();
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
