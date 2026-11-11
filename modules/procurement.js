// Procurement (RFQ -> comparison -> purchase order -> bill) and subcontractor payment certificates.
const { esc, money } = require('../lib/render');

const { amountInWords } = require('../lib/words');

module.exports = ctx => {
  const { db, send, bad, audit, readBody, getSettings, today, round, C, nextNumber, TABLES, parseItems } = ctx;
  db.exec(`
  CREATE TABLE IF NOT EXISTS rfqs(id INTEGER PRIMARY KEY, number TEXT, date TEXT, project_id INTEGER, description TEXT, items TEXT DEFAULT '[]', quotes TEXT DEFAULT '[]', status TEXT DEFAULT 'open', awarded_party_id INTEGER);
  CREATE TABLE IF NOT EXISTS purchase_orders(id INTEGER PRIMARY KEY, number TEXT, date TEXT, party_id INTEGER, project_id INTEGER, rfq_id INTEGER, delivery_date TEXT, status TEXT DEFAULT 'draft', items TEXT DEFAULT '[]', vat_pct REAL DEFAULT 5, terms TEXT, notes TEXT, bill_id INTEGER);
  CREATE TABLE IF NOT EXISTS subcontracts(id INTEGER PRIMARY KEY, project_id INTEGER, party_id INTEGER, description TEXT, contract_value REAL DEFAULT 0, retention_pct REAL DEFAULT 0, advance REAL DEFAULT 0, status TEXT DEFAULT 'active');
  CREATE TABLE IF NOT EXISTS sub_certs(id INTEGER PRIMARY KEY, number TEXT, subcontract_id INTEGER, date TEXT, cumulative REAL DEFAULT 0, retention_pct REAL DEFAULT 0, advance_recovery REAL DEFAULT 0, deductions REAL DEFAULT 0, vat_pct REAL DEFAULT 5, status TEXT DEFAULT 'draft', notes TEXT, bill_id INTEGER);`);
  const addCol = (t, c, d) => { if (!db.prepare(`PRAGMA table_info(${t})`).all().some(x => x.name === c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`); };
  // subcontract terms printed on the payment certificate; VAT basis: 'gross' (on the work value) or 'net' (after retention and contra charges)
  [['agreement_no', 'TEXT'], ['agreement_date', 'TEXT'], ['start_date', 'TEXT'], ['completion_date', 'TEXT'], ['eot_date', 'TEXT'], ['variations', 'REAL DEFAULT 0'], ['vat_basis', "TEXT DEFAULT 'gross'"], ['contra_uplift', 'REAL DEFAULT 0']].forEach(([c, d]) => addCol('subcontracts', c, d));
  [['deliver_to', 'TEXT'], ['site_contact', 'TEXT'], ['payment_terms', 'TEXT'], ['valid_from', 'TEXT'], ['valid_to', 'TEXT'], ['pr_ref', 'TEXT'], ['quote_ref', 'TEXT']].forEach(([c, d]) => addCol('purchase_orders', c, d));
  [['period_to', 'TEXT'], ['materials', 'REAL DEFAULT 0'], ['release', 'REAL DEFAULT 0'], ['app_ref', 'TEXT'], ['cost_codes', 'TEXT'], ['vat_basis', 'TEXT']].forEach(([c, d]) => addCol('sub_certs', c, d));   // vat_basis: fixed when the certificate is created
  Object.assign(TABLES, {
    rfqs: { cols: ['number', 'date', 'project_id', 'description', 'items', 'quotes', 'status', 'awarded_party_id'], json: ['items', 'quotes'], prefix: 'RFQ' },
    purchase_orders: { cols: ['number', 'date', 'party_id', 'project_id', 'rfq_id', 'delivery_date', 'status', 'items', 'vat_pct', 'terms', 'notes', 'deliver_to', 'site_contact', 'payment_terms', 'valid_from', 'valid_to', 'pr_ref', 'quote_ref'], num: ['vat_pct'], json: ['items'], prefix: 'PO' },
    subcontracts: { cols: ['project_id', 'party_id', 'description', 'contract_value', 'retention_pct', 'advance', 'status', 'agreement_no', 'agreement_date', 'start_date', 'completion_date', 'eot_date', 'variations', 'vat_basis', 'contra_uplift'], num: ['contract_value', 'retention_pct', 'advance', 'variations', 'contra_uplift'] },
  });
  const name = (t, id) => (id ? db.prepare(`SELECT name FROM ${t} WHERE id=?`).get(id)?.name : null);
  const json = (s, d = []) => { try { return JSON.parse(s || ''); } catch { return d; } };
  const notFound = () => { const e = new Error('not found'); e.status = 404; throw e; };

  // line discount %: the totals use the net unit price (rate less discount)
  const netItems = items => items.map(i => ({ ...i, rate: round((+i.rate || 0) * (1 - (+i.disc || 0) / 100) * 10000) / 10000 }));
  ctx.poNet = netItems;
  const poView = r => { const items = parseItems(r), t = C.docTotals(netItems(items), r.vat_pct), gross = round(items.reduce((x, i) => x + (+i.qty || 0) * (+i.rate || 0), 0));
    return { ...r, items, ...t, gross, discount: round(gross - t.subtotal), supplier_name: name('parties', r.party_id), supplier_trn: db.prepare('SELECT trn FROM parties WHERE id=?').get(r.party_id)?.trn, project_name: name('projects', r.project_id) }; };
  ctx.poView = poView;
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
  // Cumulative, as on a main contractor's PC: (A) work done + materials − advance recovered to date; (B) retention + contra charges
  // − retention released + previous payments; net this certificate = A − B. VAT 'gross': on the work value of the period less contra
  // charges (retention still taxed now); 'net': on the net amount (retention taxed when released).
  function certView(c) {
    const sub = db.prepare('SELECT * FROM subcontracts WHERE id=?').get(c.subcontract_id) || {}, basis = (c.vat_basis || 'gross') === 'net' ? 'net' : 'gross';
    const all = db.prepare('SELECT * FROM sub_certs WHERE subcontract_id=? ORDER BY id').all(c.subcontract_id), upto = all.filter(x => x.id <= c.id);
    let prevCum = 0, prevMat = 0; const runs = [];
    for (const x of upto) {
      const g = round((+x.cumulative || 0) - prevCum), mt = round((+x.materials || 0) - prevMat), ret = round((g + mt) * (+x.retention_pct || 0) / 100);
      const rel = round(+x.release || 0), con = round(+x.deductions || 0), adv = round(+x.advance_recovery || 0);
      const net = round(g + mt - adv - ret - con + rel), pct = +x.vat_pct || 0;
      const vat = round(((x.vat_basis || 'gross') === 'net' ? net : g + mt - con) * pct / 100);   // older certificates: gross
      runs.push({ id: x.id, g, mt, ret, rel, con, adv, net, vat }); prevCum = +x.cumulative || 0; prevMat = +x.materials || 0;
    }
    const me = runs[runs.length - 1] || { g: 0, mt: 0, ret: 0, rel: 0, con: 0, adv: 0, net: 0, vat: 0 }, before = runs.slice(0, -1), sum = (a, k) => round(a.reduce((t, r) => t + r[k], 0));
    const retention_cum = sum(runs, 'ret'), contra_cum = sum(runs, 'con'), release_cum = sum(runs, 'rel'), adv_rec_cum = sum(runs, 'adv');
    const prev_payments = sum(before, 'net'), prev_vat = sum(before, 'vat'), materials = round(+c.materials || 0), cumulative = round(+c.cumulative || 0);
    const A = round(cumulative + materials - adv_rec_cum), B = round(retention_cum + contra_cum - release_cum + prev_payments);
    const prev = before.length ? (+all.find(x => x.id === before[before.length - 1].id).cumulative || 0) : 0;
    const vatPctSub = +c.vat_pct || 0, contractVat = round(((+sub.contract_value || 0) + (+sub.variations || 0)) * vatPctSub / 100);
    return { ...c, previous: prev, gross_this: me.g, materials_this: me.mt, retention: me.ret, release: me.rel, contra_this: me.con, taxable: round(me.g + me.mt - me.con), vat: me.vat, payable_now: round(me.net + me.vat),
      net_this: me.net, A, B, retention_cum, contra_cum, release_cum, adv_rec_cum, advance: +sub.advance || 0, adv_balance: round((+sub.advance || 0) - adv_rec_cum), prev_payments, prev_vat, vat_cum: round(prev_vat + me.vat), basis,
      contract_value: +sub.contract_value || 0, variations: +sub.variations || 0, contract_vat: contractVat, adjusted: round((+sub.contract_value || 0) + (+sub.variations || 0) + contractVat), sub,
      party_id: sub.party_id, project_id: sub.project_id, supplier_name: name('parties', sub.party_id), project_name: name('projects', sub.project_id), description: sub.description };
  }

  // ---- printable ----
  const PO_NOTES = 'Purchase order number to be shown on all delivery notes and invoices.\nInvoices must show the TRN of the supplier and of the purchaser.\nMaterials are subject to inspection and approval on delivery.\nDeliveries as per call-off by the site team.';
const PO_CONDITIONS = `1. Order. This purchase order, its attachments and these conditions form the whole agreement. Any quotation terms of the supplier apply only where written into this order.

2. Prices. Prices are fixed for the agreement period and include packing, transport and delivery to the place stated, unless the order says otherwise. No price increase is accepted without the purchaser's written approval.

3. Quantities. Quantities may be increased or reduced by the purchaser at the same unit prices.

4. Delivery. Goods are delivered on the dates or call-offs given by the purchaser, with a delivery note showing the order number. The purchaser may cancel undelivered quantities if delivery is late.

5. Quality and inspection. Goods must match the order, the approved samples and submittals, and the project specifications, and are subject to inspection and approval by the purchaser, the consultant and the client. Rejected goods are replaced or removed at the supplier's cost.

6. Documents. Test certificates, certificates of origin, warranties, manuals and safety data sheets required by the project are supplied with the goods at no extra cost.

7. Warranty. The supplier warrants the goods against defects in materials and workmanship for twelve months from use, or longer where the main contract requires, and replaces defective goods promptly.

8. Invoicing and payment. Invoices quote the order number and both TRNs and are paid as per the terms of payment stated in this order after the goods are received and approved. Amounts owed by the supplier to the purchaser may be set off against payments.

9. Ownership and risk. Ownership passes on delivery or payment, whichever is earlier; risk passes on acceptance at the delivery point.

10. Health, safety and environment. The supplier follows the site HSE rules and applicable UAE regulations when delivering to site.

11. Confidentiality. Information received from the purchaser in connection with this order is kept confidential.

12. Assignment. The supplier may not assign or sub-contract this order without the purchaser's written consent.

13. Termination. The purchaser may terminate the order in writing if the supplier fails to perform, becomes insolvent, or if the related works are cancelled; delivered and accepted goods are paid for.

14. Law. This order is governed by the laws of the Emirate of Dubai and the federal laws of the UAE.`;
  ctx.renderers.purchase_orders = id => {
    const r = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(id); if (!r) notFound();
    const po = poView(r), S = getSettings(), cur = S.currency || 'AED', sup = db.prepare('SELECT * FROM parties WHERE id=?').get(r.party_id) || {}, p = db.prepare('SELECT * FROM projects WHERE id=?').get(r.project_id) || {};
    const row = (k, v) => v ? `<tr><td>${k}</td><td>${v}</td></tr>` : '';
    const vt = i => (i.vat === 'zero' ? '0' : i.vat === 'exempt' ? 'Ex.' : String(+r.vat_pct || 0));
    const lines = po.items.map((i, n) => { const net = (+i.rate || 0) * (1 - (+i.disc || 0) / 100);
      return `<tr><td>${n + 1}</td><td class="mono">${esc(i.code || '')}</td><td>${esc(i.description || '').replace(/\n/g, '<br>')}</td><td>${esc(i.unit || '')}</td><td class="n">${money(i.qty)}</td><td class="n">${money(i.rate)}</td><td class="n">${+i.disc ? (+i.disc).toFixed(2) : '0.00'}</td><td class="n">${money(net)}</td><td class="n">${money((+i.qty || 0) * net)}</td><td class="n">${vt(i)}</td></tr>`; }).join('');
    const notes = String(S.po_notes || PO_NOTES).split('\n').map(x => x.trim()).filter(Boolean);
    const cond = String(S.po_conditions === undefined ? PO_CONDITIONS : S.po_conditions).trim();   // Settings: empty = no conditions page
    const period = r.valid_from || r.valid_to ? `${esc(r.valid_from || '…')} to ${esc(r.valid_to || '…')}` : '';
    return { title: `Purchase Order ${po.number}`, filename: po.number, ref: po.number, date: r.date, legal: true, label: 'Signed and sealed for the purchaser', receiver: 'Signed and sealed for the supplier',
      body: `<style>.pol{width:100%;table-layout:fixed;font-size:8pt}.pol th{font-size:6.3pt;letter-spacing:0;white-space:normal;padding:1.2mm .8mm}.pol td{padding:1.4mm .8mm;word-wrap:break-word}
        .pot{display:flex;justify-content:space-between;gap:8mm;margin-top:3mm;page-break-inside:avoid}.pot .tot{flex:none}.pot .terms{flex:1;font-size:8.5pt}.pot .terms table td{border:0;padding:.6mm 0}.pot .terms td:first-child{color:#8A8578;width:38%}
        .pon{font-size:8pt;margin:3mm 0 0;padding-inline-start:4mm}.pon li{margin:.6mm 0}.cond{column-count:2;column-gap:8mm;font-size:7.5pt;line-height:1.45;text-align:justify}.cond h3{column-span:all;text-align:center;font-size:10pt;margin:0 0 3mm}</style>
      <h2 class="t">PURCHASE ORDER</h2>
      <div class="info"><div><h4>Supplier</h4><div class="nm">${esc(sup.name || '')}</div>${sup.address ? `<div class="muted">${esc(sup.address)}</div>` : ''}
          <table style="margin-top:1mm"><tbody>${row('Phone', esc(sup.phone || ''))}${row('Email', esc(sup.email || ''))}${row('TRN', esc(sup.trn || ''))}</tbody></table></div>
        <div><h4>Order details</h4><table><tbody>${row('PO no.', `<b class="mono">${esc(po.number)}</b>`)}${row('Date', esc(r.date))}${row('Purchaser', esc(S.legal_name || S.company_name || ''))}${row('Purchaser TRN', esc(S.trn || ''))}
          ${row('Project', esc(`${p.code ? p.code + ' — ' : ''}${p.name || ''}`))}${row('PR ref.', esc(r.pr_ref || ''))}${row('Your quotation', esc(r.quote_ref || ''))}</tbody></table></div></div>
      <table class="pol"><colgroup>${[4, 10, 31, 6, 8, 9, 6, 9, 11, 6].map(w => `<col style="width:${w}%">`).join('')}</colgroup>
        <thead><tr><th>SR</th><th>Item code</th><th>Description</th><th>Unit</th><th class="n">Qty</th><th class="n">Unit price</th><th class="n">Disc.<br>%</th><th class="n">Net unit<br>price</th><th class="n">Net amount<br>${esc(cur)}</th><th class="n">VAT<br>%</th></tr></thead><tbody>${lines}</tbody></table>
      <div class="pot"><div class="terms"><table><tbody>${row('Terms of payment', esc(r.payment_terms || ''))}${row('Delivery date', esc(r.delivery_date || ''))}${row('Deliver to', esc([r.deliver_to, r.site_contact].filter(Boolean).join(' — ')))}${row('Agreement period', period)}</tbody></table></div>
        <div class="tot">${po.discount ? `<div><span>Total order discount</span><span>${money(po.discount)}</span></div>` : ''}<div><span>Total excluding VAT</span><span>${money(po.subtotal)}</span></div><div><span>Total VAT amount</span><span>${money(po.vat)}</span></div><div class="t"><span>TOTAL ${esc(cur)}</span><span>${money(po.total)}</span></div></div></div>
      <p style="font-size:8.5pt;margin:2mm 0 0"><b>${esc(amountInWords(po.total, cur))}</b></p>
      ${r.terms ? `<p style="font-size:8.5pt;margin:3mm 0 0"><b>Special conditions:</b><br>${esc(r.terms).replace(/\n/g, '<br>')}</p>` : ''}${r.notes ? `<p style="font-size:8.5pt;margin:2mm 0 0"><b>Notes:</b><br>${esc(r.notes).replace(/\n/g, '<br>')}</p>` : ''}
      <ul class="pon">${notes.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`,
      after: `${cond ? `<div class="cond"><h3>GENERAL CONDITIONS OF PURCHASE</h3>${esc(cond).replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>').replace(/^/, '<p>')}</p></div>` : ''}` };
  };

  ctx.renderers.sub_certs = id => {
    const r = db.prepare('SELECT * FROM sub_certs WHERE id=?').get(id); if (!r) notFound();
    const c = certView(r), S = getSettings(), sub = c.sub, cur = S.currency || 'AED', p = db.prepare('SELECT * FROM projects WHERE id=?').get(sub.project_id) || {};
    const seq = db.prepare('SELECT COUNT(*) n FROM sub_certs WHERE subcontract_id=? AND id<=?').get(r.subcontract_id, r.id).n;
    const m = v => money(v), neg = v => (v ? '(' + money(v) + ')' : '-'), dash = v => (v ? money(v) : '-');
    const L = (k, v, cls = '') => `<tr class="${cls}"><td>${k}</td><td class="n">${v}</td></tr>`, D = (k, v) => `<tr><td>${k}</td><td>${v || '<span class="muted">—</span>'}</td></tr>`;
    const signers = String(S.sub_cert_signatories || 'Quantity Surveyor, Site Engineer, Project Manager, General Manager').split(',').map(x => x.trim()).filter(Boolean);
    const codes = String(r.cost_codes || '').split(/\n|·|;/).map(x => x.trim()).filter(Boolean);
    const vatTxt = c.basis === 'net' ? 'on the net amount (this certificate)' : 'on the value of work done (this certificate)';
    const words = amountInWords(c.payable_now, cur);
    return { title: `Payment Certificate ${c.number}`, filename: c.number, ref: c.number, date: r.date, stamp: false, signature: false, legal: true,
      body: `<style>.pcb{width:100%;border-collapse:collapse;font-size:8.5pt;margin-bottom:2.5mm}.pcb>tbody>tr>td{border:.6pt solid #1F3A5F;vertical-align:top;padding:1.2mm 2.2mm;width:50%}
        .pcb table{font-size:8.5pt}.pcb table td{border:0;padding:.45mm 0}.pcb table td:first-child{color:#55606e}.pcb tr.b td{font-weight:700;color:#1F3A5F!important;border-top:.6pt solid #1F3A5F}.pcb tr.hl td{font-weight:800;font-size:9.5pt;color:#1F3A5F!important;background:#F2F1EE}
        .pch{text-align:center;margin:-2mm 0 2mm}.pch h2{margin:0;font-size:13pt;letter-spacing:.4px}.pch div{font-size:8.5pt;color:#8A8578}
        .vs{width:100%;border-collapse:collapse;font-size:8pt;margin-top:1.5mm}.vs td,.vs th{border:.6pt solid #1F3A5F!important;padding:1mm 1.5mm;text-align:center;color:#1F3A5F;text-transform:none;letter-spacing:0;font-size:8pt}
        .sg{display:grid;grid-template-columns:repeat(${Math.min(4, signers.length) || 1},1fr);border:.6pt solid #1F3A5F;margin-top:3mm;page-break-inside:avoid}.sg div{border-inline-end:.6pt solid #1F3A5F;height:19mm;font-size:7.5pt;font-weight:700;text-align:center;padding-top:1.5mm}.sg div:last-child{border-inline-end:0}
        .wd{font-size:8.5pt;font-weight:700;background:#F2F1EE;border:.6pt solid #1F3A5F;padding:1.5mm 2.2mm}</style>
      <div class="pch"><h2>PAYMENT CERTIFICATE FOR SUBCONTRACTOR</h2><div>Date of issue: <b>${esc(r.date)}</b></div></div>
      <table class="pcb"><tbody><tr><td><table><tbody>${D('Certificate no.', `<b>${seq}</b> <span class="mono muted">${esc(c.number)}</span>`)}${D('Project / main contract', esc(p.main_contract || `${p.code ? p.code + ' — ' : ''}${p.name || ''}`))}${D('Sub-contractor', `<b>${esc(c.supplier_name || '')}</b>`)}${D('Sub-contract works', esc(sub.description || ''))}</tbody></table></td>
        <td><table><tbody>${D('For works up to', `<b>${esc(r.period_to || '')}</b>`)}${D('Contract no.', esc(p.code || p.client_contract_ref || ''))}${D('Sub-contract agreement no.', esc([sub.agreement_no, sub.agreement_date && 'dated ' + sub.agreement_date].filter(Boolean).join(', ')))}</tbody></table></td></tr>
      <tr><td><table><tbody>${L('Net contract value', m(c.contract_value))}${L('Total of variations', dash(c.variations))}${L(`Value added tax (VAT) ${+r.vat_pct || 0}%`, m(c.contract_vat))}${L('Adjusted contract value', m(c.adjusted), 'b')}</tbody></table></td>
        <td><table><tbody>${D('Commencement date', esc(sub.start_date || ''))}${D('Completion date', esc(sub.completion_date || ''))}${D('Extension of time', esc(sub.eot_date ? 'yes' : ''))}${D('Extended completion date', esc(sub.eot_date || ''))}</tbody></table></td></tr>
      <tr><td><table><tbody>${L('Value of work done', m(c.cumulative))}${L('Materials on site', dash(c.materials))}${L('Advance payment', dash(c.advance))}${L('Adv. payment — recovery', c.adv_rec_cum ? neg(c.adv_rec_cum) : '-')}${L('Adv. payment — balance to recover', dash(c.adv_balance))}${L('Certified amount (A)', m(c.A), 'b')}</tbody></table></td>
        <td>${codes.length ? `<table><tbody><tr><td colspan="2"><b>Cost codes</b></td></tr>${codes.map(x => { const k = x.match(/^(\S+)\s+(.*)$/); return k ? L(esc(k[1]), esc(k[2])) : `<tr><td colspan="2">${esc(x)}</td></tr>`; }).join('')}<tr class="b"><td>Total</td><td class="n">${m(c.cumulative)}</td></tr></tbody></table>` : ''}</td></tr>
      <tr><td><table><tbody><tr><td colspan="2"><b>Deductions</b></td></tr>${L(`Retention (${+r.retention_pct || 0}%)`, m(c.retention_cum))}${L('Contra charges', dash(c.contra_cum))}${L('Release of retention', c.release_cum ? neg(c.release_cum) : '-')}${L('Previous payments (without VAT)', m(c.prev_payments))}${L('Total deductions (B)', m(c.B), 'b')}
          ${L('NET AMOUNT (A − B)', m(c.net_this), 'b')}${L(`Add VAT (${+r.vat_pct || 0}%) ${vatTxt}`, m(c.vat))}${L(`NET AMOUNT CERTIFIED INCLUDING VAT (${esc(cur)})`, m(c.payable_now), 'hl')}</tbody></table>
          <table class="vs"><tbody><tr><td rowspan="2" style="text-align:start"><b>Summary of ${+r.vat_pct || 0}% VAT</b></td><td>Previous</td><td>This certificate</td><td>Cumulative</td></tr><tr><td class="mono">${m(c.prev_vat)}</td><td class="mono">${m(c.vat)}</td><td class="mono">${m(c.vat_cum)}</td></tr></tbody></table></td>
        <td><b>Notes:</b><ol style="margin:1mm 0;padding-inline-start:5mm">${r.app_ref ? `<li>This PC is for ${esc(r.app_ref)}${r.period_to ? `, period ending ${esc(r.period_to)}` : ''}.</li>` : ''}${c.contra_this ? `<li>Contra charges this certificate: ${m(c.contra_this)}${sub.contra_uplift ? ` (cost plus ${+sub.contra_uplift}% uplift)` : ''}.</li>` : ''}${r.notes ? `<li>${esc(r.notes).replace(/\n/g, '<br>')}</li>` : ''}</ol></td></tr></tbody></table>
      <div class="wd">(${esc(words)})</div>
      <div class="sg">${signers.map(x => `<div>${esc(x)}</div>`).join('')}</div>` };
  };

  return {
    async handle(req, res, url, [a, b, c], me) {
      const m = req.method;
      if (a === 'po-defaults' && m === 'GET') return send(res, 200, { notes: PO_NOTES, conditions: PO_CONDITIONS }), true;   // Settings shows the standard texts until they are changed
      if (a === 'rfqs' && m === 'GET') { const rows = db.prepare('SELECT * FROM rfqs ORDER BY id DESC').all().map(rfqView); return send(res, 200, b ? rows.find(r => r.id === +b) || null : rows), true; }
      if (a === 'purchase_orders' && m === 'GET') { const rows = db.prepare('SELECT * FROM purchase_orders ORDER BY id DESC').all().map(poView); return send(res, 200, b ? rows.find(r => r.id === +b) || null : rows), true; }
      if (a === 'subcontracts' && m === 'GET') { const rows = db.prepare('SELECT * FROM subcontracts ORDER BY id DESC').all().map(subView); return send(res, 200, b ? rows.find(r => r.id === +b) || null : rows), true; }
      if (a === 'sub_certs' && m === 'GET') { const rows = db.prepare('SELECT * FROM sub_certs ORDER BY id DESC').all().map(certView); return send(res, 200, b ? rows.find(r => r.id === +b) || null : rows), true; }

      if (a === 'rfqs' && c === 'award' && m === 'POST') {
        const rfq = db.prepare('SELECT * FROM rfqs WHERE id=?').get(+b); if (!rfq) notFound();
        if (!require('../lib/acl').can(me.role, 'POST', 'purchase_orders')) return send(res, 403, { error: 'your role cannot issue purchase orders' }), true;   // awarding creates a priced PO
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
        const ex = k => (body[k] !== undefined ? body[k] : cur ? cur[k] : null);
        Object.assign(f, { period_to: ex('period_to') || null, materials: +ex('materials') || 0, release: +ex('release') || 0, app_ref: ex('app_ref') || '', cost_codes: ex('cost_codes') || '' });
        if (f.materials < 0 || f.release < 0 || f.deductions < 0 || f.advance_recovery < 0) bad('Amounts cannot be negative');
        // within the subcontract: work up to its value + variations, advance recovered up to the advance, retention released up to what is held
        const others = db.prepare('SELECT * FROM sub_certs WHERE subcontract_id=? AND id!=? ORDER BY id').all(subId, id || 0), limit = round((+sub.contract_value || 0) + (+sub.variations || 0));
        if (limit > 0 && f.cumulative > limit + 0.01) bad(`Cumulative work ${money(f.cumulative)} is more than the subcontract value with variations (${money(limit)}) — record the variation on the subcontract first`);
        const advSoFar = round(others.reduce((s, x) => s + (+x.advance_recovery || 0), 0));
        if (f.advance_recovery > 0 && advSoFar + f.advance_recovery > (+sub.advance || 0) + 0.01) bad(`Advance recovery is more than the advance left to recover (${money(Math.max(0, (+sub.advance || 0) - advSoFar))})`);
        let pc = 0, pm = 0, held = 0; for (const x of others.filter(x => !id || x.id < id)) { held += ((+x.cumulative || 0) - pc + (+x.materials || 0) - pm) * (+x.retention_pct || 0) / 100 - (+x.release || 0); pc = +x.cumulative || 0; pm = +x.materials || 0; }
        held = round(held + (f.cumulative - pc + f.materials - pm) * f.retention_pct / 100);
        if (f.release > held + 0.01) bad(`Retention release is more than the retention held (${money(held)})`);
        if (id) { db.prepare('UPDATE sub_certs SET date=?,cumulative=?,retention_pct=?,advance_recovery=?,deductions=?,vat_pct=?,notes=?,period_to=?,materials=?,release=?,app_ref=?,cost_codes=?,vat_basis=? WHERE id=?').run(body.date || cur.date, f.cumulative, f.retention_pct, f.advance_recovery, f.deductions, f.vat_pct, body.notes ?? cur.notes, f.period_to, f.materials, f.release, f.app_ref, f.cost_codes, sub.vat_basis === 'net' ? 'net' : 'gross', id); return send(res, 200, { ok: 1 }), true; }
        const r = db.prepare('INSERT INTO sub_certs(number,subcontract_id,date,cumulative,retention_pct,advance_recovery,deductions,vat_pct,notes,period_to,materials,release,app_ref,cost_codes,vat_basis) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(nextNumber('sub_certs', 'SC'), subId, body.date || today(), f.cumulative, f.retention_pct, f.advance_recovery, f.deductions, f.vat_pct, body.notes || '', f.period_to, f.materials, f.release, f.app_ref, f.cost_codes, sub.vat_basis === 'net' ? 'net' : 'gross');
        audit(req, 'create', 'sub_certs', Number(r.lastInsertRowid), `subcontract ${subId}`);
        return send(res, 200, { id: Number(r.lastInsertRowid) }), true;
      }
      if (a === 'sub_certs' && c === 'approve' && m === 'POST') {
        const raw = db.prepare('SELECT * FROM sub_certs WHERE id=?').get(+b); if (!raw) notFound();
        if (raw.status === 'approved') bad('Already approved');
        if (db.prepare("SELECT 1 FROM sub_certs WHERE subcontract_id=? AND id<? AND status='draft'").get(raw.subcontract_id, raw.id)) bad('Approve the earlier certificate first');
        const v = certView(raw);
        if (v.gross_this <= 0 && v.materials_this <= 0 && v.release <= 0 && v.contra_this <= 0) bad('Nothing certified in this period');
        // the cost of the period (work + materials − contra charges) with the VAT as certified; a retention release is no new cost (VAT on it when the basis is 'net')
        const bill = db.prepare('INSERT INTO bills(date,party_id,project_id,category,description,amount,vat_amount,reference) VALUES(?,?,?,?,?,?,?,?)')
          .run(raw.date, v.party_id, v.project_id, 'subcontract', `Payment certificate ${raw.number} — ${v.description || ''}${v.release > 0 ? ` (retention released ${money(v.release)})` : ''}`, v.taxable, v.vat, raw.number);
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
