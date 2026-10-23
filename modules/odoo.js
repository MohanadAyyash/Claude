// Odoo bridge: pushes the day's transactions (contacts, tax invoices / credit notes, supplier bills, receipts / payments) to Odoo Accounting,
// keeps a per-record sync log so nothing is sent twice, produces a daily transactions report, and offers Odoo-ready CSV import files
// for accounts without API access. The API key lives in its own table and is never sent back to the browser.
const { createClient } = require('../lib/odoo');

module.exports = ctx => {
  const { db, send, bad, audit, readBody, today, round, enrich } = ctx;
  db.exec(`CREATE TABLE IF NOT EXISTS odoo_config(key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS odoo_sync(id INTEGER PRIMARY KEY, kind TEXT, local_id INTEGER, odoo_id INTEGER, status TEXT, error TEXT, hash TEXT, synced_at TEXT, UNIQUE(kind, local_id));
  CREATE TABLE IF NOT EXISTS odoo_runs(id INTEGER PRIMARY KEY, started TEXT, finished TEXT, trigger TEXT, user TEXT, sent INTEGER DEFAULT 0, updated INTEGER DEFAULT 0, failed INTEGER DEFAULT 0, skipped INTEGER DEFAULT 0, message TEXT);`);
  const KEYS = ['url', 'db', 'login', 'key', 'api', 'enabled', 'auto', 'hour', 'start', 'post', 'misc_partner'];
  const cfg = () => { const o = { api: 'auto', hour: '23', post: '0' }; for (const r of db.prepare('SELECT key,value FROM odoo_config').all()) o[r.key] = r.value; return o; };
  const setCfg = (k, v) => db.prepare('INSERT INTO odoo_config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, v == null ? '' : String(v));
  const publicCfg = c => { const o = { ...c }; o.key_set = c.key ? '1' : ''; delete o.key; return o; };
  const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
  const canFin = me => ['admin', 'accountant'].includes(me.role);

  const hashOf = o => { const s = JSON.stringify(o); let h = 0; for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0; return String(h >>> 0); };
  const rec = (kind, id) => db.prepare('SELECT * FROM odoo_sync WHERE kind=? AND local_id=?').get(kind, id);
  const mark = (kind, id, odooId, status, error, hash) => db.prepare(`INSERT INTO odoo_sync(kind,local_id,odoo_id,status,error,hash,synced_at) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(kind,local_id) DO UPDATE SET odoo_id=COALESCE(excluded.odoo_id,odoo_id), status=excluded.status, error=excluded.error, hash=COALESCE(excluded.hash,hash), synced_at=excluded.synced_at`).run(kind, id, odooId ?? null, status, error ?? null, hash ?? null, now());

  // ---------- what goes to Odoo (pure mapping, also used by the CSV export and the daily report) ----------
  function data(from, to) {
    const e = enrich(), inRange = d => d && (!from || d >= from) && (!to || d <= to);
    const invoices = e.invoices.filter(i => inRange(i.date));
    const bills = e.bills.filter(b => inRange(b.date));
    const payments = e.payments.filter(p => inRange(p.date) && !(p.method === 'cheque' && p.cheque_status === 'bounced'));
    return { e, invoices, bills, payments };
  }
  const invoiceDoc = i => ({
    move_type: i.kind === 'credit_note' ? 'out_refund' : 'out_invoice', ref: i.number, date: i.date, due: i.due_date || null, client_id: i.client_id,
    narration: [i.project_name && `Project: ${i.project_name}`, i.retention > 0 && `Retention ${i.retention_pct}% = ${i.retention.toFixed(2)} AED (held by client)`, i.notes].filter(Boolean).join('\n'),
    lines: (i.items || []).map(x => ({ name: String(x.description || '-'), quantity: +x.qty || 0, price_unit: +x.rate || 0, taxed: x.vat !== 'zero' && x.vat !== 'exempt' && (+i.vat_pct || 0) > 0 })),
    voided: !!i.voided, total: Math.abs(i.total),
  });
  const billDoc = b => ({ move_type: 'in_invoice', ref: b.reference || `TRG-B${b.id}`, date: b.date, party_id: b.party_id,
    narration: [b.project_name && `Project: ${b.project_name}`, b.category && `Category: ${b.category}`].filter(Boolean).join('\n'),
    lines: [{ name: b.description || b.category || 'Expense', quantity: 1, price_unit: round(b.amount), taxed: b.vat_amount > 0.004 }], vat: b.vat_amount, total: b.total });
  const payDoc = (p, e) => {
    const inv = p.invoice_id ? e.invoices.find(i => i.id === p.invoice_id) : null, bill = p.bill_id ? e.bills.find(b => b.id === p.bill_id) : null;
    return { payment_type: p.kind === 'in' ? 'inbound' : 'outbound', partner_type: p.kind === 'in' ? 'customer' : 'supplier', amount: round(p.amount), date: p.date,
      memo: [p.reference, inv && inv.number, bill && (bill.reference || bill.description), p.is_retention ? 'retention release' : '', p.method === 'cheque' && p.cheque_date ? `cheque ${p.cheque_date}` : ''].filter(Boolean).join(' · ') || `TRG-PAY${p.id}`,
      party_id: inv ? inv.client_id : bill ? bill.party_id : null, cash: ['cash', 'petty'].includes(p.method) };
  };

  // ---------- push ----------
  async function lookups(cl) {
    const taxes = await cl.searchRead('account.tax', [['amount', '=', 5], ['amount_type', '=', 'percent'], ['active', '=', true]], ['id', 'name', 'type_tax_use'], 50);
    const journals = await cl.searchRead('account.journal', [['type', 'in', ['sale', 'purchase', 'bank', 'cash']]], ['id', 'name', 'type', 'code'], 50);
    const pick = (arr, f) => arr.find(f) || null;
    return { sale_tax: pick(taxes, t => t.type_tax_use === 'sale'), purchase_tax: pick(taxes, t => t.type_tax_use === 'purchase'),
      sale_journal: pick(journals, j => j.type === 'sale'), purchase_journal: pick(journals, j => j.type === 'purchase'), bank_journal: pick(journals, j => j.type === 'bank'), cash_journal: pick(journals, j => j.type === 'cash') };
  }
  async function test() {
    const c = cfg(); if (!c.url || !c.db || !c.login || !c.key) throw new Error('Fill in the Odoo URL, database, login and API key first');
    const cl = createClient(c), inf = await cl.info(); await cl.auth();
    const lk = await lookups(cl), missing = [];
    if (!lk.sale_tax) missing.push('5% sales tax'); if (!lk.purchase_tax) missing.push('5% purchase tax'); if (!lk.sale_journal) missing.push('sales journal');
    if (!lk.purchase_journal) missing.push('purchase journal'); if (!lk.bank_journal) missing.push('bank journal');
    return { ok: true, ...inf, lookups: Object.fromEntries(Object.entries(lk).map(([k, v]) => [k, v && v.name])), missing };
  }

  async function partnerId(cl, partyId, ctxRun) {
    if (!partyId) {                                                                   // expenses without a supplier → one shared "Miscellaneous suppliers" contact
      const c = cfg(); if (c.misc_partner) return +c.misc_partner;
      const found = await cl.searchRead('res.partner', [['ref', '=', 'TRG-MISC']], ['id'], 1);
      const id = found[0] ? found[0].id : await cl.create('res.partner', { name: 'Miscellaneous suppliers (Trigon ERP)', ref: 'TRG-MISC', is_company: true });
      setCfg('misc_partner', id); return id;
    }
    const p = ctxRun.e.parties[partyId]; if (!p) throw new Error('contact not found');
    const vals = { name: p.name, ref: `TRG-P${p.id}`, is_company: true, vat: p.trn || false, phone: p.phone || false, email: p.email || false, street: p.address || false, comment: p.notes || false };
    const h = hashOf(vals), r = rec('partner', p.id);
    if (r && r.status === 'ok' && r.odoo_id) { if (r.hash !== h) { await cl.write('res.partner', [r.odoo_id], vals); mark('partner', p.id, r.odoo_id, 'ok', null, h); ctxRun.updated++; } return r.odoo_id; }
    const found = await cl.searchRead('res.partner', [['ref', '=', vals.ref]], ['id'], 1);
    const id = found[0] ? found[0].id : await cl.create('res.partner', vals);
    if (found[0]) await cl.write('res.partner', [id], vals);
    mark('partner', p.id, id, 'ok', null, h); ctxRun.sent++; return id;
  }
  const lineCmds = (lines, tax) => lines.map(l => [0, 0, { name: l.name, quantity: l.quantity, price_unit: l.price_unit, tax_ids: [[6, 0, l.taxed && tax ? [tax.id] : []]] }]);

  async function pushMove(cl, kind, localId, doc, partner, journal, tax, run) {
    const vals = { move_type: doc.move_type, partner_id: partner, invoice_date: doc.date, ref: doc.ref, narration: doc.narration || false, journal_id: journal ? journal.id : undefined,
      invoice_line_ids: lineCmds(doc.lines, tax) };
    if (doc.move_type === 'out_invoice' || doc.move_type === 'out_refund') { vals.payment_reference = doc.ref; if (doc.due) vals.invoice_date_due = doc.due; }
    if (!vals.journal_id) delete vals.journal_id;
    const h = hashOf(vals), r = rec(kind, localId);
    if (doc.voided) {                                                                 // cancelled here → cancel there (if it was sent)
      if (!r || !r.odoo_id) { mark(kind, localId, null, 'skipped', 'void — not sent', h); run.skipped++; return; }
      if (r.status === 'cancelled') return;
      try { await cl.action('account.move', [r.odoo_id], 'button_draft'); } catch { /* already draft */ }
      await cl.action('account.move', [r.odoo_id], 'button_cancel'); mark(kind, localId, r.odoo_id, 'cancelled', null, h); run.updated++; return;
    }
    if (r && r.odoo_id && ['ok', 'changed'].includes(r.status)) {
      if (r.hash === h) return;
      const cur = (await cl.searchRead('account.move', [['id', '=', r.odoo_id]], ['state'], 1))[0];
      if (cur && cur.state === 'draft') { await cl.write('account.move', [r.odoo_id], { ...vals, invoice_line_ids: [[5, 0, 0], ...vals.invoice_line_ids] }); mark(kind, localId, r.odoo_id, 'ok', null, h); run.updated++; return; }
      if (cur) { if (r.status !== 'changed') { mark(kind, localId, r.odoo_id, 'changed', 'edited here after it was posted in Odoo — correct it in Odoo (reset to draft) or issue a credit note', null); run.failed++; } return; }
      // deleted in Odoo → fall through and send it again
    }
    const existing = await cl.searchRead('account.move', [['ref', '=', doc.ref], ['move_type', '=', doc.move_type], ['partner_id', '=', partner]], ['id'], 1);
    const id = existing[0] ? existing[0].id : await cl.create('account.move', vals);
    if (!existing[0] && cfg().post === '1') await cl.action('account.move', [id], 'action_post');
    mark(kind, localId, id, 'ok', null, h); run.sent++;
  }
  async function pushPayment(cl, p, lk, run, major) {
    const d = payDoc(p, run.e), r = rec('payment', p.id);
    if (r && ['ok', 'skipped'].includes(r.status)) return;
    if (!d.party_id) { mark('payment', p.id, null, 'skipped', 'not linked to an invoice or bill — record it in Odoo directly', null); run.skipped++; return; }
    const partner = await partnerId(cl, d.party_id, run), journal = d.cash ? (lk.cash_journal || lk.bank_journal) : lk.bank_journal;
    const vals = { payment_type: d.payment_type, partner_type: d.partner_type, partner_id: partner, amount: d.amount, date: d.date, [major >= 18 ? 'memo' : 'ref']: d.memo };
    if (journal) vals.journal_id = journal.id;
    const id = await cl.create('account.payment', vals);
    if (cfg().post === '1') await cl.action('account.payment', [id], 'action_post');
    mark('payment', p.id, id, 'ok', null, hashOf(vals)); run.sent++;
  }

  let running = null;
  async function sync({ trigger = 'manual', user = '', from, to } = {}) {
    if (running) throw new Error('A sync is already running');
    const c = cfg(); if (c.enabled !== '1') throw new Error('The Odoo link is switched off');
    const run = { sent: 0, updated: 0, failed: 0, skipped: 0, errors: [] }, started = now();
    running = (async () => {
      const cl = createClient(c), inf = await cl.info(); await cl.auth(); const lk = await lookups(cl);
      const { e, invoices, bills, payments } = data(from || c.start || null, to || today()); run.e = e;
      const each = async (kind, id, label, fn) => { try { await fn(); } catch (err) { run.failed++; run.errors.push(`${label}: ${err.message}`); mark(kind, id, null, 'error', err.message.slice(0, 500), null); } };
      for (const i of invoices) await each('invoice', i.id, i.number, async () => {
        if (!i.client_id) throw new Error('invoice project has no client'); const doc = invoiceDoc(i);
        await pushMove(cl, 'invoice', i.id, doc, await partnerId(cl, i.client_id, run), lk.sale_journal, lk.sale_tax, run);
      });
      for (const b of bills) await each('bill', b.id, b.reference || b.description || `#${b.id}`, async () => {
        const doc = billDoc(b); await pushMove(cl, 'bill', b.id, doc, await partnerId(cl, b.party_id, run), lk.purchase_journal, lk.purchase_tax, run);
      });
      for (const p of payments) await each('payment', p.id, `${p.kind === 'in' ? 'receipt' : 'payment'} ${p.reference || '#' + p.id}`, () => pushPayment(cl, p, lk, run, inf.major));
    })();
    let message = '';
    try { await running; } catch (err) { message = err.message; run.failed++; } finally { running = null; }
    if (!message && run.errors.length) message = run.errors.slice(0, 5).join(' | ');
    db.prepare('INSERT INTO odoo_runs(started,finished,trigger,user,sent,updated,failed,skipped,message) VALUES(?,?,?,?,?,?,?,?,?)').run(started, now(), trigger, user, run.sent, run.updated, run.failed, run.skipped, message);
    setCfg('last_run', today());
    return { sent: run.sent, updated: run.updated, failed: run.failed, skipped: run.skipped, message };
  }

  // nightly run on the server edition (the browser-only edition cannot call Odoo: CORS + no background process)
  if (typeof window === 'undefined' && !process.env.ODOO_NO_SCHEDULER) {
    const tick = () => {
      const c = cfg(), h = new Date().getHours();
      if (c.enabled === '1' && c.auto === '1' && h === +c.hour && c.last_run !== today() && !running) sync({ trigger: 'nightly' }).catch(() => {});
    };
    setInterval(tick, 10 * 60 * 1000).unref();
  }

  // ---------- daily report ----------
  function report(date) {
    const { invoices, bills, payments } = data(date, date), st = (k, id) => rec(k, id) || { status: 'pending' };
    const rows = [
      ...invoices.map(i => ({ type: i.kind === 'credit_note' ? 'credit_note' : 'invoice', ref: i.number, party: i.client_name, project: i.project_name, net: i.subtotal, vat: i.vat, total: i.total, void: !!i.voided, sync: st('invoice', i.id) })),
      ...bills.map(b => ({ type: 'bill', ref: b.reference || `#${b.id}`, party: b.party_name, project: b.project_name, net: round(b.amount), vat: round(b.vat_amount), total: b.total, sync: st('bill', b.id) })),
      ...payments.map(p => ({ type: p.kind === 'in' ? 'receipt' : 'payment', ref: p.reference || p.ref_label || `#${p.id}`, party: p.party_name, project: p.project_name, net: round(p.amount), vat: 0, total: round(p.kind === 'in' ? p.amount : -p.amount), method: p.method, sync: st('payment', p.id) })),
    ].map(r => ({ ...r, sync_status: r.sync.status, sync_error: r.sync.error || '', odoo_id: r.sync.odoo_id || null, sync: undefined }));
    const sum = t => round(rows.filter(r => r.type === t && !r.void).reduce((s, r) => s + r.total, 0));
    return { date, rows, totals: { invoiced: round(sum('invoice') + sum('credit_note')), output_vat: round(rows.filter(r => ['invoice', 'credit_note'].includes(r.type) && !r.void).reduce((s, r) => s + r.vat, 0)),
      bills: sum('bill'), input_vat: round(rows.filter(r => r.type === 'bill').reduce((s, r) => s + r.vat, 0)), received: sum('receipt'), paid: round(-sum('payment')),
      pending: rows.filter(r => r.sync_status === 'pending').length, errors: rows.filter(r => ['error', 'changed'].includes(r.sync_status)).length } };
  }

  // ---------- CSV files in Odoo's import format (works without API access: Odoo → Import records) ----------
  const cell = v => { let s = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = rows => '﻿' + rows.map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
  function exportCsv(kind, from, to) {
    const { e, invoices, bills, payments } = data(from, to);
    if (kind === 'partners') {
      const out = [['id', 'name', 'is_company', 'vat', 'phone', 'email', 'street', 'ref']];
      for (const p of Object.values(e.parties)) out.push([`trigon_partner_${p.id}`, p.name, 'True', p.trn, p.phone, p.email, p.address, `TRG-P${p.id}`]);
      return csv(out);
    }
    if (kind === 'invoices' || kind === 'bills') {
      const out = [['id', 'move_type', 'partner_id', 'invoice_date', 'invoice_date_due', 'ref', 'narration', 'invoice_line_ids/name', 'invoice_line_ids/quantity', 'invoice_line_ids/price_unit', 'invoice_line_ids/tax_ids']];
      const docs = kind === 'invoices' ? invoices.filter(i => !i.voided).map(i => [`trigon_invoice_${i.id}`, invoiceDoc(i), e.parties[i.client_id]]) : bills.map(b => [`trigon_bill_${b.id}`, billDoc(b), e.parties[b.party_id]]);
      for (const [xid, d, party] of docs) d.lines.forEach((l, n) => out.push([n ? '' : xid, n ? '' : d.move_type, n ? '' : (party ? party.name : 'Miscellaneous suppliers (Trigon ERP)'), n ? '' : d.date, n ? '' : (d.due || ''), n ? '' : d.ref, n ? '' : d.narration, l.name, l.quantity, l.price_unit, l.taxed ? (kind === 'invoices' ? 'VAT 5%' : 'VAT 5%') : '']));
      return csv(out);
    }
    if (kind === 'payments') {
      const out = [['id', 'payment_type', 'partner_type', 'partner_id', 'amount', 'date', 'memo', 'journal_id']];
      for (const p of payments) { const d = payDoc(p, e), party = e.parties[d.party_id]; out.push([`trigon_payment_${p.id}`, d.payment_type, d.partner_type, party ? party.name : '', d.amount, d.date, d.memo, d.cash ? 'Cash' : 'Bank']); }
      return csv(out);
    }
    return null;
  }

  return {
    async handle(req, res, url, [a, b], me) {
      if (a !== 'odoo') return false;
      if (!canFin(me)) return send(res, 403, { error: 'forbidden' }), true;
      const m = req.method, q = url.searchParams;
      if (m === 'GET' && !b) {
        const counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM odoo_sync GROUP BY status').all().map(r => [r.status, r.n]));
        return send(res, 200, { config: publicCfg(cfg()), counts, running: !!running, runs: db.prepare('SELECT * FROM odoo_runs ORDER BY id DESC LIMIT 20').all(), server: typeof window === 'undefined' }), true;
      }
      if (m === 'PUT' && b === 'config') {
        if (me.role !== 'admin') return send(res, 403, { error: 'only an administrator can change the Odoo connection' }), true;
        const body = await readBody(req);
        if (body.url && !/^https:\/\/[^/\s]+/.test(body.url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(body.url)) return send(res, 400, { error: 'The Odoo address must start with https://' }), true;
        if (body.start && !/^\d{4}-\d{2}-\d{2}$/.test(body.start)) return send(res, 400, { error: 'Start date must be YYYY-MM-DD' }), true;
        if (body.hour != null && !(+body.hour >= 0 && +body.hour <= 23)) return send(res, 400, { error: 'Hour must be 0–23' }), true;
        if (body.api && !['auto', 'jsonrpc', 'json2'].includes(body.api)) return send(res, 400, { error: 'Unknown API type' }), true;
        for (const k of KEYS) if (k !== 'key' && k !== 'misc_partner' && body[k] !== undefined) setCfg(k, k === 'url' ? String(body[k]).trim().replace(/\/+$/, '') : String(body[k]).trim());
        if (body.key) setCfg('key', String(body.key).trim());                            // the key only changes when a new one is typed
        if (body.url !== undefined || body.db !== undefined) setCfg('misc_partner', '');
        audit(req, 'update', 'odoo_config', 0, 'connection settings');
        return send(res, 200, publicCfg(cfg())), true;
      }
      if (m === 'POST' && b === 'test') { try { return send(res, 200, await test()), true; } catch (e) { return send(res, 400, { error: e.message }), true; } }
      if (m === 'POST' && b === 'sync') {
        const body = await readBody(req);
        try { const r = await sync({ trigger: 'manual', user: me.username, from: body.from, to: body.to }); audit(req, 'sync', 'odoo', 0, JSON.stringify(r).slice(0, 300)); return send(res, 200, r), true; }
        catch (e) { return send(res, 400, { error: e.message }), true; }
      }
      if (m === 'POST' && b === 'retry') { db.prepare("DELETE FROM odoo_sync WHERE status IN ('error','skipped')").run(); return send(res, 200, { ok: true }), true; }
      if (m === 'GET' && b === 'log') return send(res, 200, db.prepare('SELECT * FROM odoo_sync ORDER BY synced_at DESC, id DESC LIMIT 300').all()), true;
      if (m === 'GET' && b === 'report') { const d = q.get('date') || today(); if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return send(res, 400, { error: 'date must be YYYY-MM-DD' }), true; return send(res, 200, report(d)), true; }
      if (m === 'GET' && b === 'export') {
        const kind = q.get('kind'), body = exportCsv(kind, q.get('from') || null, q.get('to') || null);
        if (body == null) return send(res, 400, { error: 'kind must be partners, invoices, bills or payments' }), true;
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="odoo-${kind}-${q.get('from') || 'all'}-${q.get('to') || today()}.csv"` });
        return res.end(body), true;
      }
      return send(res, 404, { error: 'not found' }), true;
    },
    sync, report,
  };
};
