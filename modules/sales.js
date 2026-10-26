// Sales pipeline and online quote acceptance.
// - Tenders / opportunities: stage (lead → invited → preparing → submitted → negotiation → won / lost), value, probability, owner,
//   submission and closing dates, linked quotation and project; the owner is reminded 3 days before a submission date.
// - Quote acceptance link: a public page (no login) where the client sees the quotation and accepts it with name + signature,
//   or rejects it with a comment; staff are notified and the tender moves on.
const crypto = require('node:crypto');
const { page, esc } = require('../lib/render');
const STAGES = ['lead', 'invited', 'preparing', 'submitted', 'negotiation', 'won', 'lost'];
const PUBLIC_CSP = "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

module.exports = ctx => {
  const { db, send, bad, audit, readBody, getSettings, today, round, enrich, docHtml } = ctx;
  db.exec(`CREATE TABLE IF NOT EXISTS tenders(id INTEGER PRIMARY KEY, title TEXT NOT NULL, client_id INTEGER, client_name TEXT, source TEXT, stage TEXT DEFAULT 'lead', value REAL DEFAULT 0, probability REAL DEFAULT 20,
    submission_date TEXT, closing_date TEXT, owner_user_id INTEGER, quote_id INTEGER, project_id INTEGER, lost_reason TEXT, notes TEXT, created TEXT, last_reminded TEXT);`);
  const addCol = (t, c, d) => { if (!db.prepare(`PRAGMA table_info(${t})`).all().some(x => x.name === c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`); };
  [['share_token', 'TEXT'], ['shared_by', 'INTEGER'], ['accepted_at', 'TEXT'], ['accepted_by', 'TEXT'], ['accepted_ip', 'TEXT'], ['signature', 'TEXT'], ['client_comment', 'TEXT'], ['rejected_at', 'TEXT']].forEach(([c, d]) => addCol('quotes', c, d));
  const notify = (to, msg) => ctx.notify ? ctx.notify(to, msg).catch(() => {}) : null;
  const now = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().replace('T', ' ').slice(0, 16); };
  const COLS = ['title', 'client_id', 'client_name', 'source', 'stage', 'value', 'probability', 'submission_date', 'closing_date', 'owner_user_id', 'quote_id', 'project_id', 'lost_reason', 'notes'];
  function clean(x) {
    const o = {}; for (const k of COLS) if (k in x) o[k] = x[k] === '' ? null : x[k];
    for (const k of ['value', 'probability']) if (k in o) o[k] = +o[k] || 0;
    for (const k of ['client_id', 'owner_user_id', 'quote_id', 'project_id']) if (k in o) o[k] = +o[k] || null;
    if ('title' in o && !String(o.title || '').trim()) bad('Enter the tender / opportunity name');
    if (o.stage && !STAGES.includes(o.stage)) bad('Invalid stage');
    if ('probability' in o && !(o.probability >= 0 && o.probability <= 100)) bad('Probability must be 0–100');
    for (const k of ['submission_date', 'closing_date']) if (o[k] && !/^\d{4}-\d\d-\d\d$/.test(o[k])) bad('Invalid date');
    if (o.stage === 'lost' && !o.lost_reason && !x.lost_reason) bad('Give the reason it was lost');
    if (o.stage === 'won') o.probability = 100; if (o.stage === 'lost') o.probability = 0;
    return o;
  }
  function list() {
    const e = enrich();
    return db.prepare('SELECT * FROM tenders ORDER BY id DESC').all().map(t => {
      const q = t.quote_id ? e.quotes.find(x => x.id === t.quote_id) : null;
      return { ...t, client: t.client_id ? (e.parties[t.client_id] || {}).name : t.client_name, owner: t.owner_user_id ? (db.prepare('SELECT username FROM users WHERE id=?').get(t.owner_user_id) || {}).username : null,
        quote: q ? { id: q.id, number: q.number, status: q.status, total: q.subtotal, accepted_at: q.accepted_at } : null, weighted: round((t.value || 0) * (t.probability || 0) / 100),
        due_soon: !!(t.submission_date && ['lead', 'invited', 'preparing'].includes(t.stage) && t.submission_date >= today() && t.submission_date <= new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10)) };
    });
  }
  function summary(rows) {
    const open = rows.filter(t => !['won', 'lost'].includes(t.stage)), y = today().slice(0, 4), closed = rows.filter(t => ['won', 'lost'].includes(t.stage) && (t.closing_date || t.created || '').slice(0, 4) === y);
    const won = closed.filter(t => t.stage === 'won');
    return { open: open.length, pipeline: round(open.reduce((s, t) => s + t.value, 0)), weighted: round(open.reduce((s, t) => s + t.weighted, 0)), won_value: round(won.reduce((s, t) => s + t.value, 0)), win_rate: closed.length ? round(won.length / closed.length * 100) : null };
  }

  // submission reminders (server edition)
  if (typeof window === 'undefined' && !process.env.SALES_NO_SCHEDULER) setInterval(() => {
    for (const t of list()) if (t.due_soon && t.last_reminded !== today()) {
      db.prepare('UPDATE tenders SET last_reminded=? WHERE id=?').run(today(), t.id);
      notify(t.owner_user_id ? [t.owner_user_id] : { roles: ['admin'] }, { title: 'موعد تقديم مناقصة قريب / Tender submission soon', body: `${t.title} — ${t.submission_date}`, url: '#tenders' });
    }
  }, 30 * 60 * 1000).unref();

  // ---------- public quote acceptance ----------
  const hits = new Map();
  const limited = ip => { const t = (hits.get(ip) || []).filter(x => Date.now() - x < 3600e3); t.push(Date.now()); hits.set(ip, t); return t.length > 30; };
  const byToken = tok => /^[a-f0-9]{48}$/.test(tok || '') ? enrich().quotes.find(q => q.share_token === tok) : null;
  const expired = q => { const d = new Date(Date.parse(q.date + 'T00:00:00Z') + (q.validity_days || 30) * 864e5).toISOString().slice(0, 10); return d < today() ? d : null; };
  ctx.publicHandler = async (req, res, url) => {
    const m = /^\/(q|pub\/q)\/([a-f0-9]{48})(?:\/(accept|reject))?$/.exec(url.pathname); if (!m) return false;
    const q = byToken(m[2]), S = getSettings();
    const html = (body, code = 200) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': PUBLIC_CSP, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }); res.end(body); };
    if (!q) return html(page({ S, brand: ctx.brand, title: 'Link not valid', body: '<h2>This link is not valid any more. / هذا الرابط لم يعد صالحاً.</h2>', stamp: false, signature: false }), 404), true;
    if (m[1] === 'q' && req.method === 'GET') {
      const done = q.accepted_at ? `<div class="qa-done">✔ Accepted by ${esc(q.accepted_by)} on ${esc(q.accepted_at)} — thank you. / تم القبول، شكراً لكم.</div>` : q.rejected_at ? `<div class="qa-done">Declined on ${esc(q.rejected_at)}. / تم الرفض.</div>` : '';
      const exp = expired(q), form = done || (exp ? `<div class="qa-done">This quotation expired on ${exp}. Please contact us for an updated offer. / انتهت صلاحية العرض.</div>` : `<div id="qa" data-token="${m[2]}"><h2>Accept this quotation / قبول عرض السعر</h2>
        <label>Your full name / الاسم الكامل<input id="qa-name" maxlength="80" autocomplete="name"></label><label>Signature / التوقيع</label><canvas id="qa-sig" width="500" height="160"></canvas>
        <div><button type="button" id="qa-clear">Clear / مسح</button> <button type="button" id="qa-accept">✔ Accept &amp; sign / قبول وتوقيع</button></div>
        <details><summary>Decline or ask for changes / رفض أو طلب تعديل</summary><textarea id="qa-comment" maxlength="1000" placeholder="Comment / ملاحظة"></textarea><button type="button" id="qa-reject">Send / إرسال</button></details><p id="qa-msg"></p></div>`);
      const body = docHtml({ kind: 'quotes', doc: { ...q, client_trn: (enrich().parties[q.client_id] || {}).trn }, settings: S, bare: true, mode: 'print' }) + form + '<link rel="stylesheet" href="/qa.css"><script src="/qa.js"></script>';
      return html(page({ S, brand: ctx.brand, title: `Quotation ${q.number}`, body, ref: q.number, date: q.date, stamp: false, signature: false })), true;
    }
    if (m[1] === 'pub/q' && req.method === 'POST') {
      const ip = (process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      if (limited(ip)) return send(res, 429, { error: 'too many attempts' }), true;
      if (q.accepted_at || q.rejected_at) return send(res, 409, { error: 'This quotation was already answered' }), true;
      if (expired(q)) return send(res, 410, { error: 'This quotation has expired' }), true;
      const x = await readBody(req, 300000);
      const staff = [...new Set([q.shared_by, ...db.prepare("SELECT id FROM users WHERE role IN ('admin','manager') AND COALESCE(disabled,0)=0").all().map(u => u.id)].filter(Boolean))];
      const tender = db.prepare('SELECT * FROM tenders WHERE quote_id=?').get(q.id);
      if (m[3] === 'accept') {
        const name = String(x.name || '').trim();
        if (name.length < 3) bad('Please type your full name');
        if (!/^data:image\/png;base64,[A-Za-z0-9+/=]{200,270000}$/.test(x.signature || '')) bad('Please sign in the box');
        db.prepare("UPDATE quotes SET status='accepted', accepted_at=?, accepted_by=?, accepted_ip=?, signature=? WHERE id=?").run(now(), name.slice(0, 80), ip, x.signature, q.id);
        if (tender && !['won', 'lost'].includes(tender.stage)) db.prepare("UPDATE tenders SET stage='won', probability=100, closing_date=? WHERE id=?").run(today(), tender.id);
        notify(staff, { title: `قبل العميل عرض السعر ${q.number} / Quotation accepted`, body: `${q.client_name || ''} — ${name} — ${round(q.subtotal).toFixed(2)} AED`, url: '#quotes' });
        db.prepare('INSERT INTO audit_log(ts,user,action,tbl,rec,detail) VALUES(?,?,?,?,?,?)').run(new Date().toISOString(), 'client', 'accept', 'quotes', q.id, `${name} from ${ip}`);
        return send(res, 200, { ok: 1 }), true;
      }
      if (m[3] === 'reject') {
        const c = String(x.comment || '').trim().slice(0, 1000);
        db.prepare("UPDATE quotes SET status='rejected', rejected_at=?, client_comment=? WHERE id=?").run(now(), c, q.id);
        if (tender && !['won', 'lost'].includes(tender.stage)) db.prepare("UPDATE tenders SET stage='negotiation' WHERE id=?").run(tender.id);
        notify(staff, { title: `ردّ العميل على عرض السعر ${q.number} / Quotation declined`, body: c || '—', url: '#quotes' });
        db.prepare('INSERT INTO audit_log(ts,user,action,tbl,rec,detail) VALUES(?,?,?,?,?,?)').run(new Date().toISOString(), 'client', 'reject', 'quotes', q.id, c.slice(0, 200));
        return send(res, 200, { ok: 1 }), true;
      }
    }
    return send(res, 404, { error: 'not found' }), true;
  };

  return {
    async handle(req, res, url, [a, b, c], me) {
      const m = req.method;
      if (a === 'quotes' && b && c === 'share' && m === 'POST') {
        const q = db.prepare('SELECT * FROM quotes WHERE id=?').get(+b); if (!q) return send(res, 404, { error: 'not found' }), true;
        if (q.accepted_at || q.rejected_at) bad('This quotation was already answered by the client');
        const x = await readBody(req);
        let tok = q.share_token; if (!tok || x.renew) { tok = crypto.randomBytes(24).toString('hex'); db.prepare('UPDATE quotes SET share_token=?, shared_by=? WHERE id=?').run(tok, me.id, q.id); }
        if (q.status === 'draft') db.prepare("UPDATE quotes SET status='sent' WHERE id=?").run(q.id);
        audit(req, 'share', 'quotes', q.id, 'acceptance link'); return send(res, 200, { token: tok, path: `/q/${tok}` }), true;
      }
      if (a === 'quotes' && b && c === 'share' && m === 'DELETE') { db.prepare('UPDATE quotes SET share_token=NULL WHERE id=?').run(+b); return send(res, 200, { ok: 1 }), true; }
      if (a !== 'tenders') return false;
      if (m === 'GET' && !b) { const rows = list(); return send(res, 200, { rows, summary: summary(rows), stages: STAGES }), true; }
      if (m === 'POST' && !b) {
        const o = clean(await readBody(req)); if (!o.title) bad('Enter the tender / opportunity name');
        o.stage = o.stage || 'lead'; o.created = today(); if (!('owner_user_id' in o)) o.owner_user_id = me.id;
        const ks = Object.keys(o), r = db.prepare(`INSERT INTO tenders(${ks.join(',')}) VALUES(${ks.map(() => '?').join(',')})`).run(...Object.values(o));
        audit(req, 'create', 'tenders', Number(r.lastInsertRowid), o.title); return send(res, 200, { id: Number(r.lastInsertRowid) }), true;
      }
      const t = b && db.prepare('SELECT * FROM tenders WHERE id=?').get(+b); if (b && !t) return send(res, 404, { error: 'not found' }), true;
      if (m === 'PUT' && !c) {
        const o = clean(await readBody(req)); if (!Object.keys(o).length) bad('Nothing to change');
        if (o.stage && ['won', 'lost'].includes(o.stage) && !t.closing_date && !o.closing_date) o.closing_date = today();
        db.prepare(`UPDATE tenders SET ${Object.keys(o).map(k => k + '=?').join(',')} WHERE id=?`).run(...Object.values(o), t.id);
        audit(req, 'update', 'tenders', t.id, Object.keys(o).join(',')); return send(res, 200, { ok: 1 }), true;
      }
      if (m === 'POST' && c === 'quote') {
        if (t.quote_id) bad('This tender already has a quotation');
        if (!t.client_id) bad('Choose the client (from Clients & suppliers) first');
        const st = getSettings(), number = ctx.brandRef('quotes', 'number', (enrich().parties[t.client_id] || {}).name);
        const r = db.prepare("INSERT INTO quotes(number,date,client_id,project_name,validity_days,status,items,vat_pct,terms) VALUES(?,?,?,?,30,'draft','[]',?,?)").run(number, today(), t.client_id, t.title, +st.vat_pct || 5, st.terms || '');
        db.prepare("UPDATE tenders SET quote_id=?, stage=CASE WHEN stage IN ('lead','invited') THEN 'preparing' ELSE stage END WHERE id=?").run(Number(r.lastInsertRowid), t.id);
        audit(req, 'create', 'quotes', Number(r.lastInsertRowid), `from tender ${t.title}`); return send(res, 200, { quote_id: Number(r.lastInsertRowid) }), true;
      }
      if (m === 'DELETE' && !c) { db.prepare('DELETE FROM tenders WHERE id=?').run(t.id); audit(req, 'delete', 'tenders', t.id, t.title); return send(res, 200, { ok: 1 }), true; }
      return false;
    },
  };
};
