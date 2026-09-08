// api/admin.js - Sizemill admin data endpoint (v1.0)
// Every request carries x-admin-secret and is compared in constant time against
// SIZEMILL_ADMIN_SECRET. Reads use the Supabase service role (SUPABASE_SERVICE_ROLE_KEY),
// which never leaves this function. Actions are written to public.admin_audit.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SIZEMILL_ADMIN_SECRET.

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SECRET = process.env.SIZEMILL_ADMIN_SECRET || '';
const FUNCTIONS = ['market-feed', 'payment-link', 'shopify-sync'];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SIZEMILL_ADMIN_SECRET'].filter(k => !process.env[k]);
  if (missing.length) return res.status(500).json({ error: 'Missing environment variables: ' + missing.join(', ') + '. Set them in Vercel, Project, Settings, Environment Variables, then redeploy.' });
  const given = String(req.headers['x-admin-secret'] || '');
  if (!safeEqual(given, SECRET)) { await sleep(600); return res.status(401).json({ error: 'Wrong admin secret' }); }
  const body = typeof req.body === 'string' ? safeJson(req.body) : (req.body || {});
  const action = String(body.action || 'overview');
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  try {
    switch (action) {
      case 'check': return res.status(200).json({ ok: true });
      case 'overview': return res.status(200).json(await overview());
      case 'export': { const b = await getBook(body.owner); if (!b) return res.status(404).json({ error: 'No book for that member' }); await audit('export', b.owner, { key: b.key }, ip); return res.status(200).json({ ok: true, name: b.name, saved_at: b.saved_at, state: b.state }); }
      case 'snapshot': { const b = await getBook(body.owner); if (!b) return res.status(404).json({ error: 'No book for that member' }); await sb('POST', '/rest/v1/book_history', { book_id: b.id, owner: b.owner, key: b.key, state: b.state, reason: 'admin', bytes: JSON.stringify(b.state).length }); await audit('snapshot', b.owner, { key: b.key }, ip); return res.status(200).json({ ok: true }); }
      case 'magiclink': { const email = String(body.email || '').trim().toLowerCase(); if (!email) return res.status(400).json({ error: 'Email required' }); const r = await sb('POST', '/auth/v1/admin/generate_link', { type: 'magiclink', email, options: { redirect_to: body.redirect || '' } }); await audit('magiclink', email, null, ip); return res.status(200).json({ ok: true, link: r.action_link || (r.properties && r.properties.action_link) || null }); }
      case 'invite': { const email = String(body.email || '').trim().toLowerCase(); if (!email) return res.status(400).json({ error: 'Email required' }); const r = await sb('POST', '/auth/v1/invite', { email, data: { invited_by: 'admin' } }); await audit('invite', email, null, ip); return res.status(200).json({ ok: true, id: r.id || null }); }
      case 'deleteUser': { const id = String(body.id || ''); if (!id) return res.status(400).json({ error: 'User id required' }); if (String(body.confirm || '') !== 'DELETE') return res.status(400).json({ error: 'Type DELETE to confirm' }); await sb('DELETE', `/rest/v1/books?owner=eq.${encodeURIComponent(id)}`); await sb('DELETE', `/auth/v1/admin/users/${encodeURIComponent(id)}`); await audit('deleteUser', body.email || id, { id }, ip); return res.status(200).json({ ok: true }); }
      case 'audit': return res.status(200).json({ ok: true, rows: await sb('GET', '/rest/v1/admin_audit?select=*&order=at.desc&limit=100') });
      default: return res.status(400).json({ error: 'Unknown action ' + action });
    }
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message || e) });
  }
}

/* ---------- Supabase over plain fetch, service role ---------- */
async function sb(method, path, body, extraHeaders) {
  const r = await fetch(SB_URL + path, { method, headers: Object.assign({ apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', Prefer: method === 'POST' && path.startsWith('/rest/') ? 'return=minimal' : 'return=representation' }, extraHeaders || {}), body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path.split('?')[0]} -> ${r.status}: ${text.slice(0, 300)}`);
  return text ? safeJson(text) : null;
}
async function audit(action, target, detail, ip) { try { await sb('POST', '/rest/v1/admin_audit', { action, target: target || null, detail: detail || null, ip: ip || null }); } catch (e) { /* audit must never block the action */ } }
async function getBook(owner) { if (!owner) return null; const rows = await sb('GET', `/rest/v1/books?select=id,owner,key,name,state,saved_at&owner=eq.${encodeURIComponent(owner)}&key=eq.main`); return rows && rows[0] || null; }

/* ---------- overview: everything the dashboard needs in one round trip ---------- */
async function overview() {
  const t0 = Date.now();
  const [usersRaw, books, history, stats, auditRows, fns] = await Promise.all([
    sb('GET', '/auth/v1/admin/users?page=1&per_page=1000'),
    sb('GET', '/rest/v1/books?select=id,owner,key,name,state,saved_at,updated_at'),
    sb('GET', '/rest/v1/book_history?select=id,owner,key,taken_at,reason,bytes&order=taken_at.desc&limit=500'),
    sb('POST', '/rest/v1/rpc/admin_stats', {}),
    sb('GET', '/rest/v1/admin_audit?select=*&order=at.desc&limit=50').catch(() => []),
    probeFunctions(),
  ]);
  const latency = Date.now() - t0;
  const users = (usersRaw && usersRaw.users) || (Array.isArray(usersRaw) ? usersRaw : []);
  const byOwner = {}; (books || []).forEach(b => { byOwner[b.owner] = byOwner[b.owner] || []; byOwner[b.owner].push(b); });
  const histByOwner = {}; (history || []).forEach(h => { histByOwner[h.owner] = histByOwner[h.owner] || []; histByOwner[h.owner].push(h); });
  const members = users.map(u => {
    const bks = byOwner[u.id] || []; const main = bks.find(b => b.key === 'main') || bks[0];
    const s = main ? summarise(main.state) : null;
    const hs = histByOwner[u.id] || [];
    return {
      id: u.id, email: u.email, created_at: u.created_at, last_sign_in_at: u.last_sign_in_at, confirmed: !!(u.email_confirmed_at || u.confirmed_at),
      provider: (u.app_metadata && (u.app_metadata.provider || (u.app_metadata.providers || [])[0])) || 'email',
      book: main ? { name: main.name, saved_at: main.saved_at, bytes: JSON.stringify(main.state).length, keys: bks.length } : null,
      summary: s, snapshots: hs.length, last_snapshot: hs[0] ? hs[0].taken_at : null,
      health: health(u, main, s),
    };
  }).sort((a, b) => (b.book && b.book.saved_at || '').localeCompare(a.book && a.book.saved_at || '') || (b.last_sign_in_at || '').localeCompare(a.last_sign_in_at || ''));
  const platform = members.reduce((acc, m) => { const s = m.summary; if (!s) return acc; acc.books++; if (!s.demo) acc.live++; acc.positionsOpen += s.open; acc.units += s.units; acc.costOpen += s.costOpen; acc.sold += s.sold; acc.revenue += s.revenue; acc.clients += s.clients; acc.requestsOpen += s.requestsOpen; acc.invoicesOpen += s.invoicesOpen; acc.owed += s.owed; acc.cash += s.cash; return acc; }, { books: 0, live: 0, positionsOpen: 0, units: 0, costOpen: 0, sold: 0, revenue: 0, clients: 0, requestsOpen: 0, invoicesOpen: 0, owed: 0, cash: 0 });
  const now = Date.now(), d = n => now - n * 864e5;
  const activity = { active7: members.filter(m => m.last_sign_in_at && new Date(m.last_sign_in_at) > d(7)).length, active30: members.filter(m => m.last_sign_in_at && new Date(m.last_sign_in_at) > d(30)).length, saved7: members.filter(m => m.book && new Date(m.book.saved_at) > d(7)).length, never: members.filter(m => !m.book).length };
  const saves = dayBuckets((history || []).map(h => h.taken_at), 30);
  const signups = dayBuckets(users.map(u => u.created_at), 30);
  const insights = buildInsights(members, stats);
  return {
    ok: true, generated_at: new Date().toISOString(), latency_ms: latency,
    members, platform, activity, saves, signups, insights,
    history: (history || []).slice(0, 60).map(h => ({ id: h.id, owner: h.owner, taken_at: h.taken_at, reason: h.reason, bytes: h.bytes, email: (users.find(u => u.id === h.owner) || {}).email || h.owner })),
    stats: stats || {}, audit: auditRows || [], functions: fns,
    deployment: { env: process.env.VERCEL_ENV || 'local', region: process.env.VERCEL_REGION || null, commit: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || null, message: process.env.VERCEL_GIT_COMMIT_MESSAGE || null, branch: process.env.VERCEL_GIT_COMMIT_REF || null, url: process.env.VERCEL_URL || null, project: process.env.VERCEL_PROJECT_PRODUCTION_URL || null, node: process.version },
    supabase: { url: SB_URL, region: 'eu-west-2' },
  };
}

/* ---------- book summary from the saved state (same shape the app persists) ---------- */
function summarise(state) {
  if (!state || typeof state !== 'object') return null;
  const top = state.top || {}; const ws = state.ws || Object.keys(state.tenants || {})[0]; const t = (state.tenants || {})[ws] || {};
  const positions = t.positions || [], ledger = t.ledger || [], clients = t.clients || [], requests = t.requests || [], invoices = t.invoices || [];
  const open = positions.filter(p => p.status !== 'sold'), sold = positions.filter(p => p.status === 'sold');
  const num = v => Number(v) || 0;
  const paid = i => (i.payments || []).reduce((a, x) => a + num(x.amt), 0);
  const openInv = invoices.filter(i => num(i.amount) - paid(i) > 0.005);
  return {
    workspace: top.workspace || t.name || ws || '', demo: !!top.demo, entity: (top.tax || {}).entity || null, version: state.v || null, savedAt: state.savedAt || null,
    open: open.length, units: open.reduce((a, p) => a + (num(p.qty) || 1), 0), costOpen: open.reduce((a, p) => a + (num(p.cost) + num(p.shipIn)) * (num(p.qty) || 1), 0),
    sold: sold.length, revenue: sold.reduce((a, p) => a + num(p.sold && p.sold.price) * (num(p.qty) || 1), 0), costSold: sold.reduce((a, p) => a + (num(p.cost) + num(p.shipIn)) * (num(p.qty) || 1), 0),
    lastSale: sold.map(p => p.sold && p.sold.date).filter(Boolean).sort().pop() || null,
    clients: clients.length, clientsWithContact: clients.filter(c => c.phone || c.ig).length, requestsOpen: requests.filter(r => num(r.stage) < 4).length,
    invoices: invoices.length, invoicesOpen: openInv.length, owed: openInv.reduce((a, i) => a + num(i.amount) - paid(i), 0),
    cash: ledger.reduce((a, e) => a + num(e.cash), 0), ledgerEntries: ledger.length, taxReserve: num(t.taxReserve), hoursThisMonth: Object.values(t.hours || {}).slice(-1)[0] || 0,
    integrations: Object.entries(top.integ || {}).filter(([, v]) => v && v.ok).map(([k]) => k), whatsapp: !!(top.contact && top.contact.whatsapp),
  };
}
function health(u, book, s) {
  const days = iso => iso ? (Date.now() - new Date(iso).getTime()) / 864e5 : Infinity;
  if (!book) return { score: 'red', why: 'No book saved yet' };
  const since = days(book.saved_at);
  if (s && s.demo) return { score: 'amber', why: 'Still on demo data' };
  if (since > 30) return { score: 'red', why: `No save for ${Math.round(since)} days` };
  if (since > 7) return { score: 'amber', why: `Last save ${Math.round(since)} days ago` };
  if (s && s.open === 0 && s.sold === 0) return { score: 'amber', why: 'Live, but an empty book' };
  return { score: 'green', why: `Saved ${since < 1 ? 'today' : Math.round(since) + 'd ago'}, ${s ? s.open + ' open, ' + s.sold + ' sold' : ''}` };
}
function buildInsights(members, stats) {
  const out = []; const now = Date.now();
  members.forEach(m => {
    if (m.book && !m.summary.demo && m.snapshots === 0) out.push({ lvl: 'warn', t: `${m.email} has a live book and no snapshot yet`, d: 'The trigger takes the first one on the next change; take one now from the row if you want a floor under them today.' });
    if (m.book && m.book.bytes > 2_000_000) out.push({ lvl: 'warn', t: `${m.email}'s book is ${(m.book.bytes / 1e6).toFixed(1)} MB`, d: 'Images in the book are the usual cause; the app trims them above 4.5 MB. Worth a word before it gets there.' });
    if (!m.book && (now - new Date(m.created_at).getTime()) > 2 * 864e5) out.push({ lvl: 'info', t: `${m.email} signed up ${Math.round((now - new Date(m.created_at).getTime()) / 864e5)} days ago and never saved a book`, d: 'Either they went offline-only or they bounced at the gate. A magic link from the row gets them back in one tap.' });
    if (m.summary && !m.summary.demo && m.summary.owed > 0 && m.summary.invoicesOpen >= 3) out.push({ lvl: 'info', t: `${m.email} is carrying £${Math.round(m.summary.owed).toLocaleString()} across ${m.summary.invoicesOpen} open invoices`, d: 'Card links are the feature that turns this into cash; this member is the first user for them.' });
  });
  if (stats && stats.db_bytes > 400_000_000) out.push({ lvl: 'loss', t: `Database is ${(stats.db_bytes / 1e6).toFixed(0)} MB of the 500 MB free tier`, d: 'Snapshots are capped at 120 per book; the next lever is the plan.' });
  if (!out.length) out.push({ lvl: 'gain', t: 'Nothing needs you', d: 'Every member with a book has saved this week and has snapshots behind them.' });
  return out;
}
async function probeFunctions() {
  return Promise.all(FUNCTIONS.map(async fn => {
    const t = Date.now();
    try { const r = await fetch(`${SB_URL}/functions/v1/${fn}`, { headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY } }); return { fn, code: r.status, ms: Date.now() - t, state: r.status === 404 ? 'not deployed' : r.ok ? 'live' : 'error' }; }
    catch (e) { return { fn, code: 0, ms: Date.now() - t, state: 'unreachable' }; }
  }));
}
function dayBuckets(isoList, days) {
  const out = []; const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) { const d = new Date(today.getTime() - i * 864e5); out.push({ day: d.toISOString().slice(0, 10), n: 0 }); }
  const idx = {}; out.forEach((b, i) => idx[b.day] = i);
  isoList.forEach(iso => { if (!iso) return; const k = String(iso).slice(0, 10); if (idx[k] != null) out[idx[k]].n++; });
  return out;
}
function safeEqual(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); if (!y.length) return false; let diff = x.length ^ y.length; const n = Math.max(x.length, y.length); for (let i = 0; i < n; i++) diff |= (x[i] || 0) ^ (y[i] || 0); return diff === 0; }
function safeJson(s) { try { return JSON.parse(s); } catch (e) { return null; } }
const sleep = ms => new Promise(r => setTimeout(r, ms));
