// ⛏️ Đào Vàng — máy chủ cho bot game Telegram (Cloudflare Worker + D1).
// Máy chủ giữ toàn bộ số liệu (vàng, cấp, năng lượng); trình duyệt chỉ gửi số lần bấm và yêu cầu mua.
// Mọi yêu cầu từ game kèm header x-init-data (do Telegram ký) để biết chắc là người chơi nào.
//
// Đường dẫn:
//   GET  /state            trạng thái + cấu hình (tạo người chơi mới nếu chưa có)
//   POST /sync {taps}      gửi số lần bấm
//   POST /buy {item}       nâng cấp bằng vàng: tap | miner | tank
//   POST /daily            quà mỗi ngày
//   POST /invoice {item}   tạo link hóa đơn Telegram Stars
//   GET  /top  /friends    bảng xếp hạng, bạn bè đã mời
//   POST /webhook          Telegram gửi cập nhật (tin nhắn, thanh toán)
//   GET  /setup?key=…      (chủ game) tạo bảng D1, gắn webhook, lệnh, nút menu
//   GET  /refund?key=…&charge=…   (chủ game) hoàn Stars

const CFG = {
  regen: 1,             // năng lượng hồi mỗi giây
  baseEnergy: 500, tankStep: 250,
  maxTps: 20,           // tối đa 20 lần bấm/giây (chặn auto-click)
  offlineCap: 3 * 3600, // thợ mỏ đào tối đa 3 giờ khi vắng mặt
  tap: { base: 50, mul: 1.6 },
  miner: { base: 100, mul: 1.55, rate: 2 },
  tank: { base: 200, mul: 1.7 },
  goldMinerRate: 50,
  refBonus: 2500,
};
const SHOP = {
  energy: { stars: 15, title: '⚡ Nạp đầy năng lượng', desc: 'Năng lượng đầy lại ngay để bấm tiếp' },
  boost: { stars: 30, title: '🔥 Nhân đôi vàng 2 giờ', desc: 'x2 vàng khi bấm và thợ mỏ trong 2 giờ (cộng dồn)' },
  chest: { stars: 49, title: '💰 Rương vàng', desc: 'Nhận ngay số vàng bằng 2 giờ thợ mỏ (ít nhất 20.000)' },
  goldminer: { stars: 99, title: '👷 Thợ mỏ vàng', desc: '+50 vàng/giây vĩnh viễn, mua nhiều lần được' },
};

const cost = (k, lvl) => Math.floor(CFG[k].base * CFG[k].mul ** lvl);
const tapPower = u => 1 + u.tap_lvl;
const rate = u => u.miner_lvl * CFG.miner.rate + u.gold_miners * CFG.goldMinerRate;
const maxEnergy = u => CFG.baseEnergy + u.tank_lvl * CFG.tankStep;
const mult = (u, t) => (u.boost_until > t ? 2 : 1);
const vnDay = ms => new Date(ms + 7 * 3600e3).toISOString().slice(0, 10);

// Cộng vàng thợ mỏ và hồi năng lượng từ lần trước tới giờ
function advance(u, now) {
  const dt = Math.max(0, now - u.last) / 1000, capped = Math.min(dt, CFG.offlineCap);
  const boosted = Math.min(capped, Math.max(0, (u.boost_until - u.last) / 1000));
  const earn = rate(u) * (capped + boosted);
  u.gold += earn; u.total += earn;
  u.energy = Math.min(maxEnergy(u), u.energy + dt * CFG.regen);
  u.last = now;
  return { dt, earn };
}

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
const hookSecret = async env => hex(await crypto.subtle.digest('SHA-256', enc.encode('dv-hook:' + env.TG_BOT_TOKEN))).slice(0, 48);
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

// initData do Telegram ký: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
async function auth(req, env) {
  const p = new URLSearchParams(req.headers.get('x-init-data') || '');
  const hash = p.get('hash'); if (!hash) return null;
  p.delete('hash');
  const check = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  if (!safeEq(hex(await hmac(await hmac('WebAppData', env.TG_BOT_TOKEN), check)), hash)) return null;
  if (Date.now() / 1000 - Number(p.get('auth_date') || 0) > 86400) return null;
  let user; try { user = JSON.parse(p.get('user') || 'null'); } catch (e) { return null; }
  if (!user || !user.id) return null;
  return { user, startParam: p.get('start_param') || '' };
}
const cleanName = u => (`${u.first_name || ''} ${u.last_name || ''}`.replace(/[<>\u0000-\u001f]/g, '').trim() || 'Thợ mỏ').slice(0, 24);
const refOf = s => { const m = /^r(\d{1,15})$/.exec(String(s || '')); return m ? Number(m[1]) : 0; };

// ---------- D1 ----------
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT, gold REAL DEFAULT 0, total REAL DEFAULT 0,
    tap_lvl INTEGER DEFAULT 0, miner_lvl INTEGER DEFAULT 0, tank_lvl INTEGER DEFAULT 0, gold_miners INTEGER DEFAULT 0,
    energy REAL DEFAULT 500, last INTEGER, tap_at INTEGER, boost_until INTEGER DEFAULT 0,
    daily_day TEXT DEFAULT '', streak INTEGER DEFAULT 0, ref INTEGER DEFAULT 0, created INTEGER)`,
  `CREATE INDEX IF NOT EXISTS users_total ON users(total DESC)`,
  `CREATE INDEX IF NOT EXISTS users_ref ON users(ref)`,
  `CREATE TABLE IF NOT EXISTS pending_refs (user_id INTEGER PRIMARY KEY, ref INTEGER)`,
  `CREATE TABLE IF NOT EXISTS payments (charge_id TEXT PRIMARY KEY, user_id INTEGER, item TEXT, stars INTEGER, at INTEGER, refunded INTEGER DEFAULT 0)`,
];
const COLS = ['name', 'gold', 'total', 'tap_lvl', 'miner_lvl', 'tank_lvl', 'gold_miners', 'energy', 'last', 'tap_at', 'boost_until', 'daily_day', 'streak'];
const getUser = (env, id) => env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
const saveStmt = (env, u) => env.DB.prepare(`UPDATE users SET ${COLS.map(c => c + ' = ?').join(', ')} WHERE id = ?`).bind(...COLS.map(c => u[c]), u.id);
const save = (env, u) => saveStmt(env, u).run();

async function loadOrCreate(env, a, now) {
  let u = await getUser(env, a.user.id);
  if (u) return { u, isNew: false };
  // Người mới: ai mời? (link t.me/bot?start=r123 qua bot, hoặc t.me/bot/app?startapp=r123 mở thẳng game)
  const pend = await env.DB.prepare('SELECT ref FROM pending_refs WHERE user_id = ?').bind(a.user.id).first();
  let ref = refOf(a.startParam) || (pend && pend.ref) || 0;
  if (ref === a.user.id || (ref && !(await getUser(env, ref)))) ref = 0;
  const gold = ref ? CFG.refBonus : 0;
  const stmts = [env.DB.prepare('INSERT OR IGNORE INTO users (id, name, gold, total, energy, last, tap_at, ref, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(a.user.id, cleanName(a.user), gold, gold, CFG.baseEnergy, now, now, ref, now)];
  if (ref) stmts.push(env.DB.prepare('UPDATE users SET gold = gold + ?, total = total + ? WHERE id = ?').bind(CFG.refBonus, CFG.refBonus, ref));
  if (pend) stmts.push(env.DB.prepare('DELETE FROM pending_refs WHERE user_id = ?').bind(a.user.id));
  await env.DB.batch(stmts);
  return { u: await getUser(env, a.user.id), isNew: true, refBonus: gold };
}

const view = (u, now) => ({
  id: u.id, name: u.name, gold: Math.floor(u.gold), total: Math.floor(u.total),
  tap_lvl: u.tap_lvl, miner_lvl: u.miner_lvl, tank_lvl: u.tank_lvl, gold_miners: u.gold_miners,
  energy: u.energy, boost_until: u.boost_until, daily_ready: u.daily_day !== vnDay(now), streak: u.streak, now,
});

// ---------- Thanh toán Stars ----------
async function applyItem(env, uid, item, now) {
  const u = await getUser(env, uid); if (!u) return;
  advance(u, now);
  if (item === 'energy') u.energy = maxEnergy(u);
  else if (item === 'boost') u.boost_until = Math.max(u.boost_until, now) + 2 * 3600e3;
  else if (item === 'chest') { const g = Math.max(20000, rate(u) * 7200); u.gold += g; u.total += g; }
  else if (item === 'goldminer') u.gold_miners++;
  await save(env, u);
}

async function onUpdate(env, up) {
  const now = Date.now();
  if (up.pre_checkout_query) {   // Telegram hỏi lại trước khi trừ Stars
    const q = up.pre_checkout_query, [item, uid] = String(q.invoice_payload).split(':');
    const ok = !!SHOP[item] && q.currency === 'XTR' && q.total_amount === SHOP[item].stars && Number(uid) === q.from.id;
    await tg(env, 'answerPreCheckoutQuery', ok ? { pre_checkout_query_id: q.id, ok: true }
      : { pre_checkout_query_id: q.id, ok: false, error_message: 'Hóa đơn không còn hợp lệ, hãy mở lại game và mua lại.' });
    return;
  }
  const msg = up.message; if (!msg) return;
  const sp = msg.successful_payment;
  if (sp) {
    const [item, uid] = String(sp.invoice_payload).split(':');
    // charge_id là khóa chính → Telegram có gửi lại bao nhiêu lần cũng chỉ cộng 1 lần
    const r = await env.DB.prepare('INSERT OR IGNORE INTO payments (charge_id, user_id, item, stars, at) VALUES (?, ?, ?, ?, ?)')
      .bind(sp.telegram_payment_charge_id, Number(uid), item, sp.total_amount, now).run();
    if (r.meta.changes) await applyItem(env, Number(uid), item, now);
    // Tin cảm ơn gửi lỗi cũng không sao: thanh toán đã ghi xong
    await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: `✅ Đã nhận ${sp.total_amount}⭐ – ${SHOP[item] ? SHOP[item].title : item}. Chúc bạn đào nhiều vàng!` }).catch(() => {});
    return;
  }
  const [cmd, arg] = String(msg.text || '').split(/\s+/);
  const c = cmd.split('@')[0].toLowerCase();
  if (c === '/start' || c === '/play') {
    const ref = refOf(arg);
    if (ref && ref !== msg.from.id && !(await getUser(env, msg.from.id)))
      await env.DB.prepare('INSERT OR REPLACE INTO pending_refs (user_id, ref) VALUES (?, ?)').bind(msg.from.id, ref).run();
    await tg(env, 'sendMessage', {
      chat_id: msg.chat.id,
      text: `⛏️ Chào ${msg.from.first_name || 'bạn'}! Chào mừng tới Đào Vàng.\n\nBấm vào tảng đá để đào vàng, thuê thợ mỏ đào giúp cả khi bạn offline, leo bảng xếp hạng và mời bạn bè nhận thưởng.${ref ? `\n\n🎁 Bạn được mời: vào game nhận ngay ${CFG.refBonus.toLocaleString('vi-VN')} vàng!` : ''}`,
      reply_markup: { inline_keyboard: [[{ text: '⛏️ Vào mỏ', web_app: { url: env.GAME_URL } }]] },
    });
  } else if (c === '/paysupport') {   // Telegram bắt buộc bot bán bằng Stars có lệnh này
    await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: `💬 Hỗ trợ thanh toán: nhắn ${env.SUPPORT || 'chủ game'} kèm ảnh chụp giao dịch Stars. Mua nhầm hoặc không nhận được vật phẩm sẽ được hoàn Stars.` });
  } else if (c === '/terms') {
    await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: '📜 Vàng và vật phẩm trong Đào Vàng là hàng ảo chỉ dùng trong game, không quy đổi thành tiền hay tiền mã hóa. Thanh toán bằng Telegram Stars. Lỗi thanh toán: /paysupport.' });
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
  if (!env.TG_BOT_TOKEN) return json(env, { error: 'no_token' }, 503);

  if (req.method === 'POST' && path === '/webhook') {
    if (!safeEq(req.headers.get('x-telegram-bot-api-secret-token') || '', await hookSecret(env))) return json(env, { error: 'auth' }, 401);
    const up = await req.json().catch(() => null);
    if (up) {
      try { await onUpdate(env, up); }
      catch (e) { if (up.pre_checkout_query || (up.message && up.message.successful_payment)) throw e; }   // lỗi thanh toán: để Telegram gửi lại
    }
    return json(env, { ok: true });
  }

  if (path === '/setup' || path === '/refund') {
    const key = req.headers.get('x-admin-key') || url.searchParams.get('key') || '';
    if (!env.ADMIN_KEY || env.ADMIN_KEY.length < 8 || !safeEq(key, env.ADMIN_KEY)) { await new Promise(r => setTimeout(r, 800)); return json(env, { error: 'auth' }, 401); }
    if (path === '/setup') {
      await env.DB.batch(SCHEMA.map(s => env.DB.prepare(s)));
      await tg(env, 'setWebhook', { url: `${url.origin}/webhook`, secret_token: await hookSecret(env), allowed_updates: ['message', 'pre_checkout_query'] });
      await tg(env, 'setMyCommands', { commands: [
        { command: 'start', description: 'Vào mỏ đào vàng' },
        { command: 'paysupport', description: 'Hỗ trợ thanh toán Stars' },
        { command: 'terms', description: 'Điều khoản' },
      ] });
      await tg(env, 'setChatMenuButton', { menu_button: { type: 'web_app', text: '⛏️ Chơi', web_app: { url: env.GAME_URL } } });
      const me = await tg(env, 'getMe');
      return json(env, { ok: true, bot: '@' + me.username, webhook: `${url.origin}/webhook`, game: env.GAME_URL });
    }
    const charge = url.searchParams.get('charge') || '';
    const p = await env.DB.prepare('SELECT * FROM payments WHERE charge_id = ?').bind(charge).first();
    if (!p) return json(env, { error: 'missing' }, 404);
    if (p.refunded) return json(env, { ok: true, already: true });
    await tg(env, 'refundStarPayment', { user_id: p.user_id, telegram_payment_charge_id: charge });
    await env.DB.prepare('UPDATE payments SET refunded = 1 WHERE charge_id = ?').bind(charge).run();
    return json(env, { ok: true, refunded: charge, stars: p.stars });
  }

  // ----- Các yêu cầu từ game: bắt buộc có initData hợp lệ -----
  const a = await auth(req, env);
  if (!a) return json(env, { error: 'auth' }, 401);
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};

  if (req.method === 'GET' && path === '/state') {
    const r = await loadOrCreate(env, a, now), u = r.u;
    const off = advance(u, now);
    u.name = cleanName(a.user);
    await save(env, u);
    return json(env, {
      cfg: CFG, shop: SHOP, bot: env.BOT_USERNAME || '', me: view(u, now),
      offline: !r.isNew && off.dt > 60 && off.earn >= 1 ? { earn: Math.floor(off.earn), sec: Math.round(Math.min(off.dt, CFG.offlineCap)) } : null,
      welcome: r.isNew ? { refBonus: r.refBonus || 0 } : null,
    });
  }

  const u = await getUser(env, a.user.id);
  if (!u) return json(env, { error: 'no_user' }, 409);
  advance(u, now);

  if (req.method === 'POST' && path === '/sync') {
    const taps = Math.max(0, Math.min(10000, Math.floor(Number(body.taps) || 0)));
    const allow = Math.floor(Math.max(0, now - u.tap_at) / 1000 * CFG.maxTps) + CFG.maxTps;
    const ok = Math.min(taps, Math.floor(u.energy), allow);
    const g = ok * tapPower(u) * mult(u, now);
    u.gold += g; u.total += g; u.energy -= ok; u.tap_at = now;
    await save(env, u);
    return json(env, { me: view(u, now), accepted: ok });
  }

  if (req.method === 'POST' && path === '/buy') {
    const k = body.item, col = { tap: 'tap_lvl', miner: 'miner_lvl', tank: 'tank_lvl' }[k];
    if (!col) return json(env, { error: 'bad_request' }, 400);
    const price = cost(k, u[col]);
    if (u.gold < price) return json(env, { error: 'not_enough', me: view(u, now) }, 409);
    u.gold -= price; u[col]++;
    if (k === 'tank') u.energy += CFG.tankStep;
    await save(env, u);
    return json(env, { me: view(u, now) });
  }

  if (req.method === 'POST' && path === '/daily') {
    const today = vnDay(now);
    if (u.daily_day === today) return json(env, { error: 'claimed', me: view(u, now) }, 409);
    u.streak = u.daily_day === vnDay(now - 86400e3) ? u.streak + 1 : 1;
    u.daily_day = today;
    const g = 200 * Math.min(u.streak, 7) + rate(u) * 600;
    u.gold += g; u.total += g;
    await save(env, u);
    return json(env, { me: view(u, now), reward: Math.floor(g) });
  }

  if (req.method === 'POST' && path === '/invoice') {
    const it = SHOP[body.item];
    if (!it) return json(env, { error: 'bad_request' }, 400);
    const link = await tg(env, 'createInvoiceLink', {
      title: it.title.replace(/^\S+\s/, ''), description: it.desc,
      payload: `${body.item}:${u.id}:${now}`, currency: 'XTR', prices: [{ label: it.title, amount: it.stars }],
    });
    return json(env, { link });
  }

  if (req.method === 'GET' && path === '/top') {
    const list = await env.DB.prepare('SELECT id, name, total FROM users ORDER BY total DESC LIMIT 50').all();
    const rank = await env.DB.prepare('SELECT COUNT(*) + 1 AS r FROM users WHERE total > ?').bind(u.total).first();
    return json(env, { list: list.results.map(r => ({ name: r.name, total: Math.floor(r.total), me: r.id === u.id })), rank: rank.r, total: Math.floor(u.total) });
  }

  if (req.method === 'GET' && path === '/friends') {
    const list = await env.DB.prepare('SELECT name, total FROM users WHERE ref = ? ORDER BY total DESC LIMIT 50').bind(u.id).all();
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE ref = ?').bind(u.id).first();
    return json(env, { count: n.n, bonus: CFG.refBonus, list: list.results.map(r => ({ name: r.name, total: Math.floor(r.total) })) });
  }

  return json(env, { error: 'not_found' }, 404);
}
