// 💞 Mơ AI — máy chủ app trò chuyện với nhân vật AI trên Telegram (Cloudflare Worker + D1 + Claude API).
// Mọi yêu cầu từ app kèm header x-init-data (Telegram ký) để biết chắc là người dùng nào.
//
//   GET  /chars                 danh sách nhân vật (công khai, cho bản xem thử)
//   GET  /state                 ví 💗, VIP, lượt miễn phí, danh sách nhân vật, gói bán
//   POST /adult                 xác nhận đủ 18 tuổi
//   GET  /chat/:char            lịch sử trò chuyện + kịch bản đang chơi
//   POST /chat {char, text}     gửi tin nhắn, nhận trả lời từ Claude
//   POST /scene {char, scene}   chọn kịch bản (bắt đầu cuộc trò chuyện mới); scene "" = trò chuyện thường
//   POST /unlock {photo}        mở khóa ảnh bằng 💗
//   POST /invoice {pack}        hóa đơn Telegram Stars
//   POST /order {pack}          đơn chuyển khoản VietQR · GET /order/:code · POST /order/:code?cancel=1
//   POST /sepay                 SePay báo tiền về · POST /webhook  Telegram gửi cập nhật
//   GET  /setup?key=…  /refund?key=…&charge=…   (chủ app)

import Anthropic from '@anthropic-ai/sdk';
import { CHAR_MAP, PHOTO_MAP, publicChars, systemPrompt } from './chars.js';

const FREE_PER_DAY = 10;       // tin nhắn miễn phí mỗi ngày
const MSG_COST = 1;            // 💗 cho mỗi tin sau khi hết lượt miễn phí
const WELCOME_HEARTS = 20;     // quà người mới
const HISTORY = 30;            // số tin gần nhất gửi kèm cho Claude
const MAX_TEXT = 800;          // độ dài tối đa 1 tin người dùng
const DEFAULT_MODEL = 'claude-opus-5-5';

// Gói bán: Stars và giá chuyển khoản (cao hơn giá Stars một chút, ~500đ/⭐)
const PACKS = {
  h100: { stars: 50, vnd: 27000, hearts: 100, title: '💗 100 tim', desc: 'Dùng để nhắn tin khi hết lượt miễn phí và mở khóa ảnh' },
  h550: { stars: 200, vnd: 109000, hearts: 550, title: '💗 550 tim', desc: '500 tim + tặng 50 tim' },
  vip30: { stars: 250, vnd: 135000, hearts: 300, vip: 30, title: '👑 VIP 30 ngày', desc: 'Nhắn tin không giới hạn 30 ngày + tặng 300 tim' },
};
const ORDER_RE = /MO[A-Z0-9]{8}/;
const ORDER_TTL = 24 * 3600e3;
const DAY = 86400e3;

const vnDay = ms => new Date(ms + 7 * 3600e3).toISOString().slice(0, 10);
const payOn = env => !!(env.SEPAY_API_KEY && env.PAY_BIN && env.PAY_ACCT);
const payInfo = env => payOn(env) ? { bin: env.PAY_BIN, acct: env.PAY_ACCT, holder: env.PAY_HOLDER || '', memo: env.PAY_MEMO || '' } : null;

// ---------- Tiện ích ----------
const enc = new TextEncoder();
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(msg));
}
function safeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const hookSecret = async env => hex(await crypto.subtle.digest('SHA-256', enc.encode('mo-hook:' + env.TG_BOT_TOKEN))).slice(0, 48);
const cors = env => ({
  'access-control-allow-origin': env.ALLOWED_ORIGIN || '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type,x-init-data',
});
const json = (env, d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json', ...cors(env) } });

async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  const d = await r.json().catch(() => ({ ok: false, description: 'HTTP ' + r.status }));
  if (!d.ok) throw new Error(`${method}: ${d.description || 'lỗi'}`);
  return d.result;
}

async function auth(req, env) {
  const p = new URLSearchParams(req.headers.get('x-init-data') || '');
  const hash = p.get('hash'); if (!hash) return null;
  p.delete('hash');
  const check = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  if (!safeEq(hex(await hmac(await hmac('WebAppData', env.TG_BOT_TOKEN), check)), hash)) return null;
  if (Date.now() / 1000 - Number(p.get('auth_date') || 0) > 86400) return null;
  let user; try { user = JSON.parse(p.get('user') || 'null'); } catch (e) { return null; }
  return user && user.id ? user : null;
}
const cleanName = u => (`${u.first_name || ''} ${u.last_name || ''}`.replace(/[<>\u0000-\u001f]/g, '').trim() || 'bạn').slice(0, 24);

// ---------- D1 ----------
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT, hearts INTEGER DEFAULT 0, vip_until INTEGER DEFAULT 0,
    free_day TEXT DEFAULT '', free_used INTEGER DEFAULT 0, adult INTEGER DEFAULT 0, busy_until INTEGER DEFAULT 0, created INTEGER)`,
  `CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, char_id TEXT, role TEXT, content TEXT, at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS messages_conv ON messages(user_id, char_id, id)`,
  `CREATE TABLE IF NOT EXISTS convs (user_id INTEGER, char_id TEXT, scene TEXT DEFAULT '', PRIMARY KEY (user_id, char_id))`,
  `CREATE TABLE IF NOT EXISTS unlocks (user_id INTEGER, photo_id TEXT, at INTEGER, PRIMARY KEY (user_id, photo_id))`,
  `CREATE TABLE IF NOT EXISTS orders (code TEXT PRIMARY KEY, user_id INTEGER, pack TEXT, vnd INTEGER, status TEXT, at INTEGER, paid_at INTEGER, tx TEXT)`,
  `CREATE INDEX IF NOT EXISTS orders_user ON orders(user_id, at DESC)`,
  `CREATE TABLE IF NOT EXISTS payments (charge_id TEXT PRIMARY KEY, user_id INTEGER, pack TEXT, stars INTEGER, at INTEGER, refunded INTEGER DEFAULT 0)`,
];
const getUser = (env, id) => env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
async function loadOrCreate(env, tgUser, now) {
  let u = await getUser(env, tgUser.id);
  if (u) return { u, isNew: false };
  await env.DB.prepare('INSERT OR IGNORE INTO users (id, name, hearts, created) VALUES (?, ?, ?, ?)').bind(tgUser.id, cleanName(tgUser), WELCOME_HEARTS, now).run();
  return { u: await getUser(env, tgUser.id), isNew: true };
}
const freeLeft = (u, now) => (u.free_day === vnDay(now) ? Math.max(0, FREE_PER_DAY - u.free_used) : FREE_PER_DAY);
const view = (u, now) => ({ id: u.id, name: u.name, hearts: u.hearts, vip_until: u.vip_until, vip: u.vip_until > now, free_left: freeLeft(u, now), free_per_day: FREE_PER_DAY, adult: !!u.adult, now });

// Cộng quà của gói (dùng chung cho Stars và chuyển khoản)
async function applyPack(env, uid, packId, now) {
  const p = PACKS[packId]; if (!p) return;
  const u = await getUser(env, uid); if (!u) return;
  const vip = p.vip ? Math.max(u.vip_until, now) + p.vip * DAY : u.vip_until;
  await env.DB.prepare('UPDATE users SET hearts = hearts + ?, vip_until = ? WHERE id = ?').bind(p.hearts || 0, vip, uid).run();
}

// ---------- Claude ----------
async function askClaude(env, c, userName, scene, history) {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}) });
  const res = await client.beta.messages.create({
    model: env.CLAUDE_MODEL || DEFAULT_MODEL,
    max_tokens: 4000,
    // Nếu model từ chối vì bộ lọc an toàn, máy chủ Anthropic tự chạy lại bằng model dự phòng phù hợp
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low' },          // trò chuyện thường: low là đủ, tiết kiệm token
    cache_control: { type: 'ephemeral' },     // cache phần đầu cuộc trò chuyện giữa các lượt
    system: systemPrompt(c, userName, scene),
    messages: history,
  });
  if (res.stop_reason === 'refusal') return null;
  return res.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim() || null;
}
// Lịch sử gửi cho Claude: phải bắt đầu bằng tin của người dùng, không có 2 tin liền cùng vai
function toHistory(rows) {
  const out = [];
  // Câu mở đầu của nhân vật đứng trước: thêm một dòng mở màn để giữ nó trong ngữ cảnh
  if (rows.length && rows[0].role !== 'user') out.push({ role: 'user', content: '(Người dùng mở cuộc trò chuyện)' });
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && last.role === r.role) last.content += '\n' + r.content;
    else out.push({ role: r.role, content: r.content });
  }
  return out;
}

// ---------- Telegram ----------
async function onUpdate(env, up) {
  const now = Date.now();
  if (up.pre_checkout_query) {
    const q = up.pre_checkout_query, [pack, uid] = String(q.invoice_payload).split(':');
    const ok = !!PACKS[pack] && q.currency === 'XTR' && q.total_amount === PACKS[pack].stars && Number(uid) === q.from.id;
    await tg(env, 'answerPreCheckoutQuery', ok ? { pre_checkout_query_id: q.id, ok: true }
      : { pre_checkout_query_id: q.id, ok: false, error_message: 'Hóa đơn không còn hợp lệ, hãy mở lại app và mua lại.' });
    return;
  }
  const msg = up.message; if (!msg) return;
  const sp = msg.successful_payment;
  if (sp) {
    const [pack, uid] = String(sp.invoice_payload).split(':');
    const r = await env.DB.prepare('INSERT OR IGNORE INTO payments (charge_id, user_id, pack, stars, at) VALUES (?, ?, ?, ?, ?)')
      .bind(sp.telegram_payment_charge_id, Number(uid), pack, sp.total_amount, now).run();
    if (r.meta.changes) await applyPack(env, Number(uid), pack, now);
    await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: `✅ Đã nhận ${sp.total_amount}⭐ – ${PACKS[pack] ? PACKS[pack].title : pack}. Cảm ơn bạn 💞` }).catch(() => {});
    return;
  }
  const c = String(msg.text || '').split(/\s+/)[0].split('@')[0].toLowerCase();
  if (c === '/start') {
    await tg(env, 'sendMessage', {
      chat_id: msg.chat.id,
      text: `💞 Chào ${msg.from.first_name || 'bạn'}! Đây là Mơ AI: trò chuyện, tâm sự và hẹn hò cùng những người bạn AI có tính cách riêng.\n\nDành cho người từ 18 tuổi. Bấm nút bên dưới để bắt đầu 👇`,
      reply_markup: { inline_keyboard: [[{ text: '💬 Mở Mơ AI', web_app: { url: env.APP_URL } }]] },
    });
  } else if (c === '/paysupport') {
    await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: `💬 Hỗ trợ thanh toán: nhắn ${env.SUPPORT || 'chủ app'} kèm ảnh chụp giao dịch. Mua nhầm hoặc không nhận được tim/VIP sẽ được hoàn tiền.` });
  } else if (c === '/terms') {
    await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: '📜 Mơ AI dành cho người từ 18 tuổi. Nhân vật là AI, không phải người thật; nội dung do AI tạo có thể không chính xác. Tim và VIP là hàng ảo, không quy đổi thành tiền. Lỗi thanh toán: /paysupport.' });
  }
}

// ---------- Định tuyến ----------
export default {
  async fetch(req, env) {
    try { return await handle(req, env); }
    catch (e) { return json(env, { error: 'server', detail: String(e && e.message || e).slice(0, 200) }, 500); }
  },
};

async function handle(req, env) {
  const url = new URL(req.url), path = url.pathname.replace(/\/+$/, '') || '/', now = Date.now();
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors(env) });
  if (path === '/health') return json(env, { ok: true, t: now });
  if (req.method === 'GET' && path === '/chars') return json(env, publicChars());   // cho bản xem thử ngoài Telegram
  if (!env.TG_BOT_TOKEN) return json(env, { error: 'no_token' }, 503);

  if (req.method === 'POST' && path === '/webhook') {
    if (!safeEq(req.headers.get('x-telegram-bot-api-secret-token') || '', await hookSecret(env))) return json(env, { error: 'auth' }, 401);
    const up = await req.json().catch(() => null);
    if (up) {
      try { await onUpdate(env, up); }
      catch (e) { if (up.pre_checkout_query || (up.message && up.message.successful_payment)) throw e; }
    }
    return json(env, { ok: true });
  }

  if (req.method === 'POST' && path === '/sepay') {
    if (!env.SEPAY_API_KEY || !safeEq(req.headers.get('authorization') || '', 'Apikey ' + env.SEPAY_API_KEY)) return json(env, { success: false }, 401);
    const tx = await req.json().catch(() => null);
    if (!tx || tx.transferType !== 'in') return json(env, { success: true });
    const m = String(tx.content || tx.description || '').toUpperCase().replace(/[^A-Z0-9]/g, '').match(ORDER_RE);
    if (!m) return json(env, { success: true });
    const o = await env.DB.prepare('SELECT * FROM orders WHERE code = ?').bind(m[0]).first();
    if (!o || o.status !== 'pending' || now - o.at > ORDER_TTL || Number(tx.transferAmount) < o.vnd) return json(env, { success: true });
    const r = await env.DB.prepare("UPDATE orders SET status = 'paid', paid_at = ?, tx = ? WHERE code = ? AND status = 'pending'").bind(now, String(tx.id || ''), o.code).run();
    if (r.meta.changes) {
      await applyPack(env, o.user_id, o.pack, now);
      await tg(env, 'sendMessage', { chat_id: o.user_id, text: `✅ Đã nhận ${o.vnd.toLocaleString('vi-VN')}đ cho đơn ${o.code} – ${PACKS[o.pack].title}. Cảm ơn bạn 💞` }).catch(() => {});
    }
    return json(env, { success: true });
  }

  if (path === '/setup' || path === '/refund') {
    const key = req.headers.get('x-admin-key') || url.searchParams.get('key') || '';
    if (!env.ADMIN_KEY || env.ADMIN_KEY.length < 8 || !safeEq(key, env.ADMIN_KEY)) { await new Promise(r => setTimeout(r, 800)); return json(env, { error: 'auth' }, 401); }
    if (path === '/setup') {
      await env.DB.batch(SCHEMA.map(s => env.DB.prepare(s)));
      await tg(env, 'setWebhook', { url: `${url.origin}/webhook`, secret_token: await hookSecret(env), allowed_updates: ['message', 'pre_checkout_query'] });
      await tg(env, 'setMyCommands', { commands: [
        { command: 'start', description: 'Mở Mơ AI' },
        { command: 'paysupport', description: 'Hỗ trợ thanh toán' },
        { command: 'terms', description: 'Điều khoản' },
      ] });
      await tg(env, 'setChatMenuButton', { menu_button: { type: 'web_app', text: '💬 Mơ AI', web_app: { url: env.APP_URL } } });
      const me = await tg(env, 'getMe');
      return json(env, { ok: true, bot: '@' + me.username, webhook: `${url.origin}/webhook`, app: env.APP_URL, ai: !!env.ANTHROPIC_API_KEY, pay: payOn(env) });
    }
    const charge = url.searchParams.get('charge') || '';
    const p = await env.DB.prepare('SELECT * FROM payments WHERE charge_id = ?').bind(charge).first();
    if (!p) return json(env, { error: 'missing' }, 404);
    if (p.refunded) return json(env, { ok: true, already: true });
    await tg(env, 'refundStarPayment', { user_id: p.user_id, telegram_payment_charge_id: charge });
    await env.DB.prepare('UPDATE payments SET refunded = 1 WHERE charge_id = ?').bind(charge).run();
    return json(env, { ok: true, refunded: charge, stars: p.stars });
  }

  // ----- Yêu cầu từ app: bắt buộc có initData hợp lệ -----
  const tgUser = await auth(req, env);
  if (!tgUser) return json(env, { error: 'auth' }, 401);
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};

  if (req.method === 'GET' && path === '/state') {
    const { u, isNew } = await loadOrCreate(env, tgUser, now);
    const unl = await env.DB.prepare('SELECT photo_id FROM unlocks WHERE user_id = ?').bind(u.id).all();
    return json(env, {
      me: view(u, now), isNew, welcome: WELCOME_HEARTS, msg_cost: MSG_COST,
      chars: publicChars(), packs: PACKS, pay: payInfo(env), ai: !!env.ANTHROPIC_API_KEY,
      unlocks: unl.results.map(r => r.photo_id),
      order: await env.DB.prepare("SELECT code, pack, vnd FROM orders WHERE user_id = ? AND status = 'pending' AND at > ? ORDER BY at DESC LIMIT 1").bind(u.id, now - ORDER_TTL).first(),
    });
  }

  const u = await getUser(env, tgUser.id);
  if (!u) return json(env, { error: 'no_user' }, 409);

  if (req.method === 'POST' && path === '/adult') {
    await env.DB.prepare('UPDATE users SET adult = 1 WHERE id = ?').bind(u.id).run();
    return json(env, { ok: true });
  }

  let m = path.match(/^\/chat\/([a-z0-9_-]{1,20})$/);
  if (req.method === 'GET' && m) {
    if (!CHAR_MAP[m[1]]) return json(env, { error: 'bad_request' }, 400);
    const conv = await env.DB.prepare('SELECT scene FROM convs WHERE user_id = ? AND char_id = ?').bind(u.id, m[1]).first();
    const rows = await env.DB.prepare('SELECT role, content, at FROM (SELECT * FROM messages WHERE user_id = ? AND char_id = ? ORDER BY id DESC LIMIT 60) ORDER BY id').bind(u.id, m[1]).all();
    return json(env, { scene: conv ? conv.scene : '', messages: rows.results });
  }

  if (req.method === 'POST' && path === '/scene') {
    const c = CHAR_MAP[body.char];
    const sc = c && (body.scene ? c.scenes.find(s => s.id === body.scene) : null);
    if (!c || (body.scene && !sc)) return json(env, { error: 'bad_request' }, 400);
    const opening = sc ? sc.opening : c.greeting;
    await env.DB.batch([
      env.DB.prepare('DELETE FROM messages WHERE user_id = ? AND char_id = ?').bind(u.id, c.id),
      env.DB.prepare('INSERT INTO convs (user_id, char_id, scene) VALUES (?, ?, ?) ON CONFLICT (user_id, char_id) DO UPDATE SET scene = excluded.scene').bind(u.id, c.id, sc ? sc.id : ''),
      env.DB.prepare("INSERT INTO messages (user_id, char_id, role, content, at) VALUES (?, ?, 'assistant', ?, ?)").bind(u.id, c.id, opening, now),
    ]);
    return json(env, { ok: true, scene: sc ? sc.id : '', messages: [{ role: 'assistant', content: opening, at: now }] });
  }

  if (req.method === 'POST' && path === '/chat') {
    const c = CHAR_MAP[body.char];
    const text = String(body.text || '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, MAX_TEXT);
    if (!c || !text) return json(env, { error: 'bad_request' }, 400);
    if (!u.adult) return json(env, { error: 'adult' }, 403);
    if (!env.ANTHROPIC_API_KEY) return json(env, { error: 'ai_off' }, 503);
    if (u.busy_until > now) return json(env, { error: 'busy' }, 429);   // đang chờ trả lời tin trước
    const vip = u.vip_until > now, free = freeLeft(u, now) > 0;
    if (!vip && !free && u.hearts < MSG_COST) return json(env, { error: 'no_hearts', me: view(u, now) }, 402);
    await env.DB.prepare('UPDATE users SET busy_until = ? WHERE id = ?').bind(now + 60e3, u.id).run();
    try {
      const conv = await env.DB.prepare('SELECT scene FROM convs WHERE user_id = ? AND char_id = ?').bind(u.id, c.id).first();
      const scene = conv && conv.scene ? c.scenes.find(s => s.id === conv.scene) : null;
      const rows = (await env.DB.prepare('SELECT role, content FROM messages WHERE user_id = ? AND char_id = ? ORDER BY id DESC LIMIT ?').bind(u.id, c.id, HISTORY).all()).results.reverse();
      if (!rows.length) rows.push({ role: 'assistant', content: scene ? scene.opening : c.greeting });
      rows.push({ role: 'user', content: text });
      let reply;
      try { reply = await askClaude(env, c, cleanName(tgUser), scene, toHistory(rows)); }
      catch (e) {
        if (e instanceof Anthropic.RateLimitError || e instanceof Anthropic.InternalServerError || e instanceof Anthropic.APIConnectionError) return json(env, { error: 'ai_busy' }, 503);
        if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return json(env, { error: 'ai_off' }, 503);
        if (e instanceof Anthropic.APIError) return json(env, { error: 'ai_error', detail: `${e.status}` }, 502);
        throw e;
      }
      // Bị từ chối (cả model dự phòng): trả lời nhẹ nhàng trong vai, không trừ lượt
      if (!reply) return json(env, { reply: `*${c.name} mỉm cười, lắc đầu* Mình nói chuyện khác nha 😊`, me: view(u, now), charged: false });
      // Chỉ trừ lượt/tim khi đã có câu trả lời
      if (!vip && free) { u.free_used = u.free_day === vnDay(now) ? u.free_used + 1 : 1; u.free_day = vnDay(now); }
      else if (!vip) u.hearts -= MSG_COST;
      await env.DB.batch([
        env.DB.prepare("INSERT INTO messages (user_id, char_id, role, content, at) VALUES (?, ?, 'user', ?, ?)").bind(u.id, c.id, text, now),
        env.DB.prepare("INSERT INTO messages (user_id, char_id, role, content, at) VALUES (?, ?, 'assistant', ?, ?)").bind(u.id, c.id, reply, Date.now()),
        env.DB.prepare('UPDATE users SET free_day = ?, free_used = ?, hearts = ? WHERE id = ?').bind(u.free_day, u.free_used, u.hearts, u.id),
      ]);
      return json(env, { reply, me: view(u, now), charged: true });
    } finally {
      await env.DB.prepare('UPDATE users SET busy_until = 0 WHERE id = ?').bind(u.id).run();
    }
  }

  if (req.method === 'POST' && path === '/unlock') {
    const ph = PHOTO_MAP[body.photo];
    if (!ph) return json(env, { error: 'bad_request' }, 400);
    if (await env.DB.prepare('SELECT 1 FROM unlocks WHERE user_id = ? AND photo_id = ?').bind(u.id, ph.id).first()) return json(env, { ok: true, me: view(u, now) });
    if (u.hearts < ph.price) return json(env, { error: 'no_hearts', me: view(u, now) }, 402);
    const r = await env.DB.prepare('UPDATE users SET hearts = hearts - ? WHERE id = ? AND hearts >= ?').bind(ph.price, u.id, ph.price).run();
    if (!r.meta.changes) return json(env, { error: 'no_hearts', me: view(u, now) }, 402);
    await env.DB.prepare('INSERT OR IGNORE INTO unlocks (user_id, photo_id, at) VALUES (?, ?, ?)').bind(u.id, ph.id, now).run();
    u.hearts -= ph.price;
    return json(env, { ok: true, me: view(u, now) });
  }

  if (req.method === 'POST' && path === '/invoice') {
    const p = PACKS[body.pack];
    if (!p) return json(env, { error: 'bad_request' }, 400);
    const link = await tg(env, 'createInvoiceLink', {
      title: p.title.replace(/^\S+\s/, ''), description: p.desc,
      payload: `${body.pack}:${u.id}:${now}`, currency: 'XTR', prices: [{ label: p.title, amount: p.stars }],
    });
    return json(env, { link });
  }

  if (req.method === 'POST' && path === '/order') {
    const p = PACKS[body.pack];
    if (!p) return json(env, { error: 'bad_request' }, 400);
    if (!payOn(env)) return json(env, { error: 'pay_off' }, 503);
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const code = 'MO' + Array.from(crypto.getRandomValues(new Uint8Array(8)), b => A[b % 32]).join('');
    await env.DB.batch([
      env.DB.prepare("UPDATE orders SET status = 'cancelled' WHERE user_id = ? AND status = 'pending'").bind(u.id),
      env.DB.prepare("INSERT INTO orders (code, user_id, pack, vnd, status, at) VALUES (?, ?, ?, ?, 'pending', ?)").bind(code, u.id, body.pack, p.vnd, now),
    ]);
    return json(env, { code, pack: body.pack, vnd: p.vnd, pay: payInfo(env) });
  }
  m = path.match(/^\/order\/(MO[A-Z0-9]{8})$/);
  if (m && req.method === 'GET') {
    const o = await env.DB.prepare('SELECT status, at FROM orders WHERE code = ? AND user_id = ?').bind(m[1], u.id).first();
    if (!o) return json(env, { status: 'missing' });
    const status = o.status === 'pending' && now - o.at > ORDER_TTL ? 'expired' : o.status;
    return json(env, { status, me: status === 'paid' ? view(await getUser(env, u.id), now) : undefined });
  }
  if (m && req.method === 'POST' && url.searchParams.get('cancel') === '1') {
    await env.DB.prepare("UPDATE orders SET status = 'cancelled' WHERE code = ? AND user_id = ? AND status = 'pending'").bind(m[1], u.id).run();
    return json(env, { ok: true });
  }

  return json(env, { error: 'not_found' }, 404);
}
