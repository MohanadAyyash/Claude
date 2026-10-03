// Procurement (RFQ -> comparison -> purchase order -> bill) and subcontractor payment certificates.
const { esc, money } = require('../lib/render');

module.exports = ctx => {
  const { db, send, bad, audit, readBody, getSettings, today, round, C, nextNumber, TABLES, parseItems } = ctx;
  db.exec(`
  CREATE TABLE IF NOT EXISTS rfqs(id INTEGER PRIMARY KEY, number TEXT, date TEXT, project_id INTEGER, description TEXT, items TEXT DEFAULT '[]', quotes TEXT DEFAULT '[]', status TEXT DEFAULT 'open', awarded_party_id INTEGER);
  CREATE TABLE IF NOT EXISTS purchase_orders(id INTEGER PRIMARY KEY, number TEXT, date TEXT, party_id INTEGER, project_id INTEGER, rfq_id INTEGER, delivery_date TEXT, status TEXT DEFAULT 'draft', items TEXT DEFAULT '[]', vat_pct REAL DEFAULT 5, terms TEXT, notes TEXT, bill_id INTEGER);
  CREATE TABLE IF NOT EXISTS subcontracts(id INTEGER PRIMARY KEY, project_id INTEGER, party_id INTEGER, description TEXT, contract_value REAL DEFAULT 0, retention_pct REAL DEFAULT 0, advance REAL DEFAULT 0, status TEXT DEFAULT 'active');
  CREATE TABLE IF NOT EXISTS sub_certs(id INTEGER PRIMARY KEY, number TEXT, subcontract_id INTEGER, date TEXT, cumulative REAL DEFAULT 0, retention_pct REAL DEFAULT 0, advance_recovery REAL DEFAULT 0, deductions REAL DEFAULT 0, vat_pct REAL DEFAULT 5, status TEXT DEFAULT 'draft', notes TEXT, bill_id INTEGER);`);
  Object.assign(TABLES, {
    rfqs: { cols: ['number', 'date', 'project_id', 'description', 'items', 'quotes', 'status', 'awarded_party_id'], json: ['items', 'quotes'], prefix: 'RFQ' },
    purchase_orders: { cols: ['number', 'date', 'party_id', 'project_id', 'rfq_id', 'delivery_date', 'status', 'items', 'vat_pct', 'terms', 'notes'], num: ['vat_pct'], json: ['items'], prefix: 'PO' },
    subcontracts: { cols: ['project_id', 'party_id', 'description', 'contract_value', 'retention_pct', 'advance', 'status'], num: ['contract_value', 'retention_pct', 'advance'] },
  });
  const name = (t, id) => (id ? db.prepare(`SELECT name FROM ${t} WHERE id=?`).get(id)?.name : null);
  const json = (s, d = []) => { try { return JSON.parse(s || ''); } catch { return d; } };
  const notFound = () => { const e = new Error('not found'); e.status = 404; throw e; };

  const poView = r => { const items = parseItems(r), t = C.docTotals(items, r.vat_pct); return { ...r, items, ...t, supplier_name: name('parties', r.party_id), supplier_trn: db.prepare('SELECT trn FROM parties WHERE id=?').get(r.party_id)?.trn, project_name: name('projects', r.project_id) }; };
  const rfqView = r => {
    const items = json(r.items), quotes = json(r.quotes).map(q => ({ ...q, supplier_name: name('parties', q.party_id), total: round(items.reduce((s, it, i) => s + (+it.qty || 0) * (+(q.rates || [])[i] || 0), 0)), complete: items.every((_, i) => +(q.rates || [])[i] > 0) }));
    const priced = quotes.filter(q => q.complete); const low = priced.length ? Math.min(...priced.map(q => q.total)) : null;
    return { ...r, items, quotes: quotes.map(q => ({ ...q, lowest: q.complete && q.total === low })), project_name: name('projects', r.project_id) };
  };
  const subView = s => {
    const certs = db.prepare('SELECT * FROM sub_certs WHERE subcontract_id=? ORDER BY id').all(s.id).map(c => certView(c));
    const approved = certs.filter(c => c.status === 'approved');
    return { ...s, party_name: name('parties', s.party_id), project_name: name('projects', s.project_id), certified: round(Math.max(0, ...approved.map(c => c.cumulative))),
      retention_held: round(approved.reduce((x, c) => x + c.retention, 0)), advance_recovered: round(approved.reduce((x, c) => x + c.advance_recovery, 0)), certs: certs.length };
  };
  function certView(c) {
    const sub = db.prepare('SELECT * FROM subcontracts WHERE id=?').get(c.subcontract_id) || {};
    const prev = db.prepare('SELECT cumulative FROM sub_certs WHERE subcontract_id=? AND id<? ORDER BY id DESC LIMIT 1').get(c.subcontract_id, c.id)?.cumulative || 0;
    const gross = round(c.cumulative - prev), retention = round(gross * c.retention_pct / 100), taxable = round(gross - c.deductions), vat = round(taxable * c.vat_pct / 100);
    return { ...c, previous: prev, gross_this: gross, retention, taxable, vat, payable_now: round(taxable - retention - c.advance_recovery + vat),
      contract_value: sub.contract_value, party_id: sub.party_id, project_id: sub.project_id, supplier_name: name('parties', sub.party_id), project_name: name('projects', sub.project_id), description: sub.description };
  }

  // ---- printable ----
  ctx.renderers.purchase_orders = id => {
    const r = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(id); if (!r) notFound();
    const po = poView(r), S = getSettings(), td = '';
    const rows = po.items.map((i, n) => `<tr><td>${n + 1}</td><td>${esc(i.description)}</td><td>${esc(i.unit)}</td><td class="n">${money(i.qty)}</td><td class="n">${money(i.rate)}</td><td>${i.vat === 'zero' ? '0%' : i.vat === 'exempt' ? 'Exempt' : po.vat_pct + '%'}</td><td class="n">${money(i.qty * i.rate)}</td></tr>`).join('');
    return { title: `Purchase Order ${po.number}`, filename: po.number, label: 'Authorised signatory / المفوّض بالتوقيع', receiver: 'Supplier acknowledgement / تأكيد المورد', body: `<h2 class="t">Purchase Order / أمر شراء — ${esc(po.number)}</h2>
      <div class="box"><b>Supplier / المورد:</b> ${esc(po.supplier_name || '')} ${po.supplier_trn ? `(TRN ${esc(po.supplier_trn)})` : ''}<br><b>Project / المشروع:</b> ${esc(po.project_name || '—')}<br><b>Date:</b> ${esc(po.date)} &nbsp; <b>Delivery:</b> ${esc(po.delivery_date || '—')}</div>
      <table><thead><tr><th>#</th><th>Description</th><th>Unit</th><th class="n">Qty</th><th class="n">Unit price</th><th>VAT</th><th class="n">Amount (${esc(S.currency || 'AED')})</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="tot"><div><span>Total excl. VAT</span><span>${money(po.subtotal)}</span></div><div><span>VAT ${po.vat_pct}%</span><span>${money(po.vat)}</span></div><div class="t"><span>Total</span><span>${money(po.total)}</span></div></div>
      ${po.terms ? `<p><b>Terms:</b><br>${esc(po.terms).replace(/\n/g, '<br>')}</p>` : ''}${po.notes ? `<p><b>Notes:</b><br>${esc(po.notes).replace(/\n/g, '<br>')}</p>` : ''}` };
  };
  ctx.renderers.sub_certs = id => {
    const r = db.prepare('SELECT * FROM sub_certs WHERE id=?').get(id); if (!r) notFound();
    const c = certView(r), S = getSettings(), row = (a, v, b) => `<tr${b ? ' style="font-weight:700"' : ''}><td>${a}</td><td class="n">${money(v)}</td></tr>`;
    return { title: `Payment Certificate ${c.number}`, filename: c.number, label: 'Approved by / اعتمد', receiver: 'Subcontractor / مقاول الباطن', body: `<h2 class="t">Subcontractor Payment Certificate / شهادة دفع مقاول باطن — ${esc(c.number)}</h2>
      <div class="box"><b>Subcontractor:</b> ${esc(c.supplier_name || '')}<br><b>Project:</b> ${esc(c.project_name || '')}<br><b>Scope:</b> ${esc(c.description || '')}<br><b>Date:</b> ${esc(c.date)} · <b>Contract value:</b> ${money(c.contract_value)}</div>
      <table><tbody>${row('Work completed to date (cumulative)', c.cumulative)}${row('Less: previously certified', -c.previous)}${row('Certified this period', c.gross_this, 1)}${row('Less: other deductions / back-charges', -c.deductions)}${row(`Less: retention ${c.retention_pct}%`, -c.retention)}${row('Less: advance recovery', -c.advance_recovery)}${row(`Add: VAT ${c.vat_pct}%`, c.vat)}${row(`Net payable now (${esc(S.currency || 'AED')})`, c.payable_now, 1)}</tbody></table>
      ${c.notes ? `<p>${esc(c.notes)}</p>` : ''}` };
  };

  return {
    async handle(req, res, url, [a, b, c], me) {
      const m = req.method;
      if (a === 'rfqs' && m === 'GET') { const rows = db.prepare('SELECT * FROM rfqs ORDER BY id DESC').all().map(rfqView); return send(res, 200, b ? rows.find(r => r.id === +b) || null : rows), true; }
      if (a === 'purchase_orders' && m === 'GET') { const rows = db.prepare('SELECT * FROM purchase_orders ORDER BY id DESC').all().map(poView); return send(res, 200, b ? rows.find(r => r.id === +b) || null : rows), true; }
      if (a === 'subcontracts' && m === 'GET') { const rows = db.prepare('SELECT * FROM subcontracts ORDER BY id DESC').all().map(subView); return send(res, 200, b ? rows.find(r => r.id === +b) || null : rows), true; }
      if (a === 'sub_certs' && m === 'GET') { const rows = db.prepare('SELECT * FROM sub_certs ORDER BY id DESC').all().map(certView); return send(res, 200, b ? rows.find(r => r.id === +b) || null : rows), true; }

      if (a === 'rfqs' && c === 'award' && m === 'POST') {
        const rfq = db.prepare('SELECT * FROM rfqs WHERE id=?').get(+b); if (!rfq) notFound();
        if (rfq.status === 'awarded') bad('This RFQ was already awarded');
        const { party_id } = await readBody(req), v = rfqView(rfq), q = v.quotes.find(x => x.party_id === +party_id);
        if (!q) bad('Select a supplier that submitted a quotation'); if (!q.complete) bad('That quotation has missing prices');
        const items = v.items.map((it, i) => ({ description: it.description, unit: it.unit, qty: it.qty, rate: +q.rates[i], vat: 'std' }));
        const r = db.prepare('INSERT INTO purchase_orders(number,date,party_id,project_id,rfq_id,items,vat_pct,terms) VALUES(?,?,?,?,?,?,?,?)')
          .run(nextNumber('purchase_orders', 'PO'), today(), +party_id, rfq.project_id, rfq.id, JSON.stringify(items), +getSettings().vat_pct || 5, `Per quotation of ${q.supplier_name}${q.delivery_days ? `, delivery within ${q.delivery_days} days` : ''}.`);
        db.prepare("UPDATE rfqs SET status='awarded', awarded_party_id=? WHERE id=?").run(+party_id, rfq.id);
        audit(req, 'award', 'rfqs', rfq.id, `${rfq.number} → ${q.supplier_name}`);
        return send(res, 200, { id: Number(r.lastInsertRowid) }), true;
      }
      if (a === 'purchase_orders' && c === 'receive' && m === 'POST') {
        const po = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(+b); if (!po) notFound();
        if (po.bill_id) bad('A bill was already created for this purchase order'); if (po.status === 'cancelled') bad('This purchase order is cancelled');
        const body = await readBody(req), v = poView(po);
        const bill = db.prepare('INSERT INTO bills(date,party_id,project_id,category,description,amount,vat_amount,reference) VALUES(?,?,?,?,?,?,?,?)')
          .run(body.date || today(), po.party_id, po.project_id, body.category || 'materials', `Goods received — ${po.number}`, v.subtotal, v.vat, body.reference || po.number);
        db.prepare("UPDATE purchase_orders SET status='received', bill_id=? WHERE id=?").run(Number(bill.lastInsertRowid), po.id);
        audit(req, 'receive', 'purchase_orders', po.id, `${po.number} → bill ${bill.lastInsertRowid}`);
        return send(res, 200, { bill_id: Number(bill.lastInsertRowid) }), true;
      }
      if (a === 'purchase_orders' && c === 'email' && m === 'POST') {
        const po = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(+b); if (!po) notFound();
        const { to, message } = await readBody(req); if (!ctx.validEmail(to)) bad('Enter a valid email address');
        const st = getSettings(); let attachments = [];
        try { attachments = [{ filename: `${po.number}.pdf`, mime: 'application/pdf', content: await ctx.pdf(ctx.renderPage('purchase_orders', po.id, me).html) }]; } catch { /* no browser: send text only */ }
        const v = poView(po), html = `<div style="font-family:Arial,sans-serif;font-size:13px">${message ? `<p>${esc(message).replace(/\n/g, '<br>')}</p>` : ''}<p>Please find purchase order <b>${esc(po.number)}</b> from ${esc(st.company_name)}. Total: ${esc(st.currency || 'AED')} ${money(v.total)}.${attachments.length ? '' : ' (PDF unavailable — please contact us for the full document.)'}</p></div>`;
        const sig = ctx.signature(me), full = html + sig.html;
        await ctx.sendMail(ctx.mailCfg(), { to, subject: `Purchase Order ${po.number} — ${st.company_name || ''}`, html: full, text: ctx.toText(full), attachments, inline: sig.inline });
        audit(req, 'email', 'purchase_orders', po.id, `${po.number} to ${to}`);
        return send(res, 200, { ok: 1 }), true;
      }

      // ---- subcontractor certificates (validated writes) ----
      if (a === 'sub_certs' && ['POST', 'PUT'].includes(m) && c !== 'approve') {
        const body = await readBody(req), id = m === 'PUT' ? +b : null, cur = id ? db.prepare('SELECT * FROM sub_certs WHERE id=?').get(id) : null;
        if (id && !cur) notFound(); if (cur?.status === 'approved') bad('Approved certificates cannot be edited');
        const subId = cur ? cur.subcontract_id : +body.subcontract_id, sub = db.prepare('SELECT * FROM subcontracts WHERE id=?').get(subId); if (!sub) bad('Select a subcontract');
        const prev = db.prepare('SELECT cumulative FROM sub_certs WHERE subcontract_id=? AND id<? ORDER BY id DESC LIMIT 1').get(subId, id || 9e15)?.cumulative || 0;
        const f = { cumulative: +body.cumulative, retention_pct: body.retention_pct === undefined || body.retention_pct === '' ? sub.retention_pct : +body.retention_pct, advance_recovery: +body.advance_recovery || 0, deductions: +body.deductions || 0, vat_pct: body.vat_pct === undefined || body.vat_pct === '' ? (+getSettings().vat_pct || 5) : +body.vat_pct };
        if (!(f.cumulative >= prev)) bad(`Cumulative work must be at least the previous certificate (${money(prev)})`);
        if (f.retention_pct < 0 || f.retention_pct > 100) bad('Retention % must be between 0 and 100');
        if (id) { db.prepare('UPDATE sub_certs SET date=?,cumulative=?,retention_pct=?,advance_recovery=?,deductions=?,vat_pct=?,notes=? WHERE id=?').run(body.date || cur.date, f.cumulative, f.retention_pct, f.advance_recovery, f.deductions, f.vat_pct, body.notes ?? cur.notes, id); return send(res, 200, { ok: 1 }), true; }
        const r = db.prepare('INSERT INTO sub_certs(number,subcontract_id,date,cumulative,retention_pct,advance_recovery,deductions,vat_pct,notes) VALUES(?,?,?,?,?,?,?,?,?)')
          .run(nextNumber('sub_certs', 'SC'), subId, body.date || today(), f.cumulative, f.retention_pct, f.advance_recovery, f.deductions, f.vat_pct, body.notes || '');
        audit(req, 'create', 'sub_certs', Number(r.lastInsertRowid), `subcontract ${subId}`);
        return send(res, 200, { id: Number(r.lastInsertRowid) }), true;
      }
      if (a === 'sub_certs' && c === 'approve' && m === 'POST') {
        const raw = db.prepare('SELECT * FROM sub_certs WHERE id=?').get(+b); if (!raw) notFound();
        if (raw.status === 'approved') bad('Already approved');
        if (db.prepare("SELECT 1 FROM sub_certs WHERE subcontract_id=? AND id<? AND status='draft'").get(raw.subcontract_id, raw.id)) bad('Approve the earlier certificate first');
        const v = certView(raw);
        if (v.gross_this <= 0) bad('Nothing certified in this period');
        const bill = db.prepare('INSERT INTO bills(date,party_id,project_id,category,description,amount,vat_amount,reference) VALUES(?,?,?,?,?,?,?,?)')
          .run(raw.date, v.party_id, v.project_id, 'subcontract', `Payment certificate ${raw.number} — ${v.description || ''}`, v.taxable, v.vat, raw.number);
        if (v.advance_recovery > 0) db.prepare("INSERT INTO payments(kind,date,amount,method,reference,bill_id,notes) VALUES('out',?,?,'offset',?,?,?)").run(raw.date, v.advance_recovery, 'advance recovery', Number(bill.lastInsertRowid), `Advance recovered — ${raw.number}`);
        db.prepare("UPDATE sub_certs SET status='approved', bill_id=? WHERE id=?").run(Number(bill.lastInsertRowid), raw.id);
        audit(req, 'approve', 'sub_certs', raw.id, `${raw.number} → bill ${bill.lastInsertRowid}`);
        return send(res, 200, { bill_id: Number(bill.lastInsertRowid) }), true;
      }
      if (a === 'sub_certs' && m === 'DELETE') {
        const r = db.prepare('SELECT * FROM sub_certs WHERE id=?').get(+b); if (!r) notFound(); if (r.status === 'approved') bad('Approved certificates cannot be deleted');
        db.prepare('DELETE FROM sub_certs WHERE id=?').run(r.id); return send(res, 200, { ok: 1 }), true;
      }
      if ((a === 'purchase_orders') && m === 'DELETE') { const r = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(+b); if (r?.bill_id) bad('A bill exists for this purchase order — cancel it instead'); return false; }
      return false;
    },
  };
};
