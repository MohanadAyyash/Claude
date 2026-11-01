// Working with a main contractor: payment application (proforma, no accounting effect) → payment certificate (PC) received
// from the main contractor → tax invoice that matches the PC to the fils.
// Everything is cumulative, as on a main contractor's PC: value of work done to date, materials on site, advance recovery,
// retention, release of retention, contra charges and previous payments; "net this month" = A − B.
// VAT basis per project: 'gross' (VAT on the work value, the system's default) or 'net' (VAT on the amount after retention and
// contra charges — the retention is taxed when it is released, as many main contractors certify).
const { esc, money } = require('../lib/render');
const { amountInWords } = require('../lib/words');

module.exports = ctx => {
  const { db, send, bad, audit, readBody, getSettings, today, round, enrich, nextNumber, C } = ctx;
  const addCol = (t, c, d) => { if (!db.prepare(`PRAGMA table_info(${t})`).all().some(x => x.name === c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`); };
  // client references on projects and invoices; contract terms for main-contractor work
  [['client_contract_ref', 'TEXT'], ['main_contract', 'TEXT'], ['payment_terms_days', 'INTEGER'], ['vat_basis', "TEXT DEFAULT 'gross'"]].forEach(([c, d]) => addCol('projects', c, d));
  const P = ctx.TABLES.projects; P.cols.push('client_contract_ref', 'main_contract', 'payment_terms_days', 'vat_basis'); P.num = [...(P.num || []), 'payment_terms_days'];
  const prevCheck = P.check;
  P.check = r => { prevCheck && prevCheck(r); if (r.vat_basis !== undefined && !['gross', 'net'].includes(r.vat_basis || 'gross')) bad('VAT basis must be gross or net'); };
  [['client_ref', 'TEXT'], ['retention_amount', 'REAL'], ['vat_basis', 'TEXT'], ['pc_id', 'INTEGER']].forEach(([c, d]) => addCol('invoices', c, d));
  ctx.TABLES.invoices.cols.push('client_ref');
  db.exec(`
  CREATE TABLE IF NOT EXISTS pay_apps(id INTEGER PRIMARY KEY, project_id INTEGER, seq INTEGER, number TEXT, date TEXT, period_to TEXT, lines TEXT DEFAULT '[]',
    materials REAL DEFAULT 0, notes TEXT, status TEXT DEFAULT 'draft', created TEXT, created_by TEXT);
  CREATE TABLE IF NOT EXISTS client_pcs(id INTEGER PRIMARY KEY, project_id INTEGER, app_id INTEGER, number TEXT, issue_date TEXT, period_to TEXT,
    work_cum REAL DEFAULT 0, materials REAL DEFAULT 0, adv_rec_cum REAL DEFAULT 0, retention_cum REAL DEFAULT 0, release_cum REAL DEFAULT 0, contra_cum REAL DEFAULT 0,
    prev_payments REAL DEFAULT 0, vat_certified REAL, prev_work REAL DEFAULT 0, prev_materials REAL DEFAULT 0, prev_adv_rec REAL DEFAULT 0, prev_retention REAL DEFAULT 0,
    prev_release REAL DEFAULT 0, prev_contra REAL DEFAULT 0, prev_vat REAL DEFAULT 0, lines TEXT DEFAULT '[]', cost_codes TEXT, notes TEXT, status TEXT DEFAULT 'recorded',
    invoice_id INTEGER, created TEXT, created_by TEXT);`);
  const notFound = () => { const e = new Error('not found'); e.status = 404; throw e; };
  const num = v => (v === null || v === undefined || v === '' ? 0 : round(+v || 0));
  const J = s => { try { return JSON.parse(s || '[]'); } catch { return []; } };
  const proj = id => db.prepare('SELECT * FROM projects WHERE id=?').get(id) || notFound();
  const vatPct = () => { const st = getSettings(); return st.vat_registered === '0' ? 0 : (+st.vat_pct || 5); };
  const lineAmt = (q, r) => round((+q || 0) * (+r || 0));
  const pcsOf = pid => db.prepare('SELECT * FROM client_pcs WHERE project_id=? ORDER BY issue_date, id').all(pid);

  // ---- received payment certificates -------------------------------------------------------------------------------------
  function pcCalc(pc, p) {
    const pct = vatPct(), basis = p.vat_basis === 'net' ? 'net' : 'gross';
    const A = round(num(pc.work_cum) + num(pc.materials) - num(pc.adv_rec_cum));
    const B = round(num(pc.retention_cum) - num(pc.release_cum) + num(pc.contra_cum) + num(pc.prev_payments));
    const net = round(A - B);
    const d = { work: round(num(pc.work_cum) - num(pc.prev_work)), materials: round(num(pc.materials) - num(pc.prev_materials)), adv: round(num(pc.adv_rec_cum) - num(pc.prev_adv_rec)),
      retention: round(num(pc.retention_cum) - num(pc.prev_retention)), release: round(num(pc.release_cum) - num(pc.prev_release)), contra: round(num(pc.contra_cum) - num(pc.prev_contra)) };
    const vat_calc = round((basis === 'net' ? net : net + d.retention - d.release) * pct / 100);
    const certified = pc.vat_certified !== null && pc.vat_certified !== undefined && pc.vat_certified !== '';
    const vat = certified ? num(pc.vat_certified) : vat_calc;
    return { A, B, net, vat_calc, vat, total: round(net + vat), d, basis, vat_pct: pct, vat_prev: num(pc.prev_vat), vat_cum: round(num(pc.prev_vat) + vat) };
  }
  function pcView(pc, p = proj(pc.project_id)) {
    const c = pcCalc(pc, p), all = pcsOf(pc.project_id), i = all.findIndex(x => x.id === pc.id), before = i > 0 ? all[i - 1] : null, checks = [];
    if (before) {
      const b = pcCalc(before, p), expectPrev = round(num(before.prev_payments) + b.net);
      if (Math.abs(expectPrev - num(pc.prev_payments)) > 0.01) checks.push({ code: 'prev_payments', expected: expectPrev, actual: num(pc.prev_payments) });
      for (const [k, f] of [['prev_work', 'work_cum'], ['prev_retention', 'retention_cum'], ['prev_contra', 'contra_cum'], ['prev_adv_rec', 'adv_rec_cum'], ['prev_release', 'release_cum'], ['prev_materials', 'materials']])
        if (Math.abs(num(pc[k]) - num(before[f])) > 0.01) checks.push({ code: k, expected: num(before[f]), actual: num(pc[k]) });
    }
    if (Math.abs(c.vat - c.vat_calc) > 0.01) checks.push({ code: 'vat', expected: c.vat_calc, actual: c.vat });
    const lines = J(pc.lines);
    if (lines.length) { const t = round(lines.reduce((s, l) => s + lineAmt(l.cert_qty, l.rate), 0)); if (Math.abs(t - num(pc.work_cum)) > 0.01) checks.push({ code: 'lines', expected: t, actual: num(pc.work_cum) }); }
    if (c.d.retention < -0.004) checks.push({ code: 'retention_down', expected: num(pc.prev_retention), actual: num(pc.retention_cum) });
    if (c.d.release > 0.004 && !pc.invoice_id) {                        // releasing more than the system holds: retention from before the system needs an opening balance (journal to 1150)
      const open = round(enrich().invoices.filter(x => x.project_id === pc.project_id && !x.voided).reduce((s, x) => s + (x.retention_open || 0), 0));
      if (c.d.release > open + 0.01) checks.push({ code: 'release_exceeds', expected: open, actual: c.d.release });
    }
    const app = pc.app_id ? db.prepare('SELECT * FROM pay_apps WHERE id=?').get(pc.app_id) : null, av = app ? appView(app, p) : null;
    return { ...pc, lines, ...c, checks, app_number: av ? av.number : null, app_seq: av ? av.seq : null, claimed_net: av ? av.net : null, claimed_total: av ? av.total : null,
      invoice_number: pc.invoice_id ? (db.prepare('SELECT number FROM invoices WHERE id=?').get(pc.invoice_id) || {}).number : null };
  }
  // the PC before a date / application: the starting point of the next one
  const lastPc = (pid, exceptAppId, upTo) => pcsOf(pid).filter(x => (!exceptAppId || x.app_id !== exceptAppId) && (!upTo || x.issue_date <= upTo)).pop() || null;

  // ---- payment applications (proforma) -------------------------------------------------------------------------------------
  function appView(app, p = proj(app.project_id)) {
    const lines = J(app.lines).map(l => ({ ...l, prev_amount: lineAmt(l.prev_qty, l.rate), cum_amount: lineAmt(l.cum_qty, l.rate), this_qty: round((+l.cum_qty || 0) - (+l.prev_qty || 0)), this_amount: round(lineAmt(l.cum_qty, l.rate) - lineAmt(l.prev_qty, l.rate)) }));
    const prev = lastPc(app.project_id, app.id, app.date), pv = prev ? pcCalc(prev, p) : null, pct = vatPct(), basis = p.vat_basis === 'net' ? 'net' : 'gross';
    const work = round(lines.reduce((s, l) => s + l.cum_amount, 0)), materials = num(app.materials);
    const adv = ctx.contractState ? ctx.contractState(app.project_id) : null;
    const advance = adv ? adv.advance.invoiced : 0, recPct = adv ? adv.advance.recovery_pct : 0;
    const adv_rec_cum = round(Math.min(advance, work * recPct / 100));
    const retention_cum = round((work + materials) * (+p.retention_pct || 0) / 100);
    const release_cum = prev ? num(prev.release_cum) : 0, contra_cum = prev ? num(prev.contra_cum) : 0;
    const prev_payments = prev ? round(num(prev.prev_payments) + pv.net) : 0, prev_retention = prev ? num(prev.retention_cum) : 0;
    const A = round(work + materials - adv_rec_cum), B = round(retention_cum - release_cum + contra_cum + prev_payments), net = round(A - B);
    const vat = round((basis === 'net' ? net : net + (retention_cum - prev_retention)) * pct / 100);
    const prev_vat = prev ? pv.vat_cum : 0;
    const variations = round(db.prepare("SELECT COALESCE(SUM(amount),0) a FROM variations WHERE project_id=? AND status='approved'").get(app.project_id).a);
    return { ...app, lines, work, materials, advance, recovery_pct: recPct, adv_rec_cum, retention_pct: +p.retention_pct || 0, retention_cum, release_cum, contra_cum, prev_payments,
      A, B, net, vat, total: round(net + vat), vat_pct: pct, basis, prev_vat, vat_cum: round(prev_vat + vat), previous_pc: prev ? prev.number : null,
      contract_value: +p.contract_value || 0, variations, adjusted: round((+p.contract_value || 0) + variations), project_name: p.name, project_code: p.code,
      pc: (db.prepare('SELECT id, number FROM client_pcs WHERE app_id=?').get(app.id) || null) };
  }
  function newLines(pid) {
    const prev = lastPc(pid), cert = {}; for (const l of J(prev && prev.lines)) cert[l.key] = +l.cert_qty || 0;
    const boq = db.prepare('SELECT * FROM boq_items WHERE project_id=? ORDER BY id').all(pid).map((i, n) => {
      const key = 'b' + i.id, pq = key in cert ? cert[key] : round(i.qty * (i.billed_pct || 0) / 100);
      return { key, boq_id: i.id, item: String(n + 1), section: i.section || '', description: i.description, unit: i.unit || '', qty: i.qty, rate: i.rate, prev_qty: pq, cum_qty: (i.done_pct || 0) > (i.billed_pct || 0) + 0.0001 ? Math.max(pq, round(i.qty * i.done_pct / 100)) : pq };   // only new progress moves the quantity
    });
    const vos = db.prepare("SELECT * FROM variations WHERE project_id=? AND status='approved' ORDER BY id").all(pid).map(v => {
      const key = 'v' + v.id, pq = key in cert ? cert[key] : 0;
      return { key, vo_id: v.id, item: v.number || 'VO', section: 'Variations', description: v.description || '', unit: 'LS', qty: 1, rate: v.amount, prev_qty: pq, cum_qty: pq };
    });
    return [...boq, ...vos];
  }

  // ---- tax invoice from a received PC ----------------------------------------------------------------------------------------
  function invoiceFromPc(pc, body, req) {
    const p = proj(pc.project_id), st = getSettings();
    if (st.vat_registered !== '0' && !C.validTrn(st.trn)) bad('Enter your company TRN (15 digits) in Settings before issuing tax invoices');
    if (pc.invoice_id) bad('A tax invoice was already issued for this PC');
    const v = pcView(pc, p), d = v.d, gross = v.basis === 'gross';
    if (!body.force && v.checks.some(c => ['vat', 'prev_payments', 'retention_down'].includes(c.code))) { const e = new Error('check_pc'); e.status = 409; e.checks = v.checks; throw e; }
    if (d.retention < -0.004) bad('The retention on this PC is lower than on the previous one — record the difference as a release of retention');
    const ref = `PC No. ${pc.number}${pc.issue_date ? ` dated ${pc.issue_date}` : ''}`, upto = pc.period_to ? ` — works up to ${pc.period_to}` : '';
    const items = [];
    if (Math.abs(d.work) > 0.004) items.push({ description: `Value of work done this period per ${ref}${upto} (cumulative ${money(num(pc.work_cum))} less previous ${money(num(pc.prev_work))})`, unit: 'LS', qty: 1, rate: d.work, vat: 'std' });
    if (Math.abs(d.materials) > 0.004) items.push({ description: `Materials on site — movement this period (cumulative ${money(num(pc.materials))})`, unit: 'LS', qty: 1, rate: d.materials, vat: 'std' });
    if (Math.abs(d.contra) > 0.004) items.push({ description: `Less: contra charges deducted per ${ref} (cumulative ${money(num(pc.contra_cum))})`, unit: 'LS', qty: 1, rate: -d.contra, vat: 'std', contra: true });
    if (Math.abs(d.adv) > 0.004) items.push({ description: `Less: advance payment recovery per ${ref} (cumulative ${money(num(pc.adv_rec_cum))})`, unit: 'LS', qty: 1, rate: -d.adv, vat: 'std', recovery: true });
    if (Math.abs(d.release) > 0.004) items.push({ description: `Release of retention per ${ref}`, unit: 'LS', qty: 1, rate: d.release, vat: gross ? 'na' : 'std', release: true });
    const before = round(d.work + d.materials - d.contra - d.adv + d.release - d.retention), adj = round(v.net - before);
    if (Math.abs(adj) > 0.004) items.push({ description: `Adjustment per ${ref} (previous payments certified ${money(num(pc.prev_payments))})`, unit: 'LS', qty: 1, rate: adj, vat: 'std' });
    if (!items.length) bad('Nothing to invoice — the PC certifies no change since the previous one');
    const date = body.date || today(); if (!/^\d{4}-\d\d-\d\d$/.test(date)) bad('Invalid date');
    let due = body.due_date || null;
    if (!due && +p.payment_terms_days > 0) { const x = new Date(Date.parse(date + 'T00:00:00Z')); x.setUTCDate(x.getUTCDate() + +p.payment_terms_days); due = x.toISOString().slice(0, 10); }
    const notes = [`Against Payment Certificate ${pc.number}${pc.issue_date ? ` dated ${pc.issue_date}` : ''}${pc.period_to ? ` for works up to ${pc.period_to}` : ''}.`,
      v.app_number ? `Payment Application No. ${v.app_seq} (${v.app_number}).` : '', p.client_contract_ref ? `Contract / sub-contract: ${p.client_contract_ref}.` : '',
      v.basis === 'net' ? 'VAT on the certified amount after retention and contra charges; VAT on retention is invoiced at its release.' : ''].filter(Boolean).join(' ');
    const r = db.prepare('INSERT INTO invoices(number,date,due_date,project_id,items,vat_pct,retention_pct,notes,client_ref,retention_amount,vat_basis,pc_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(nextNumber('invoices', 'INV'), date, due, p.id, JSON.stringify(items), vatPct(), +p.retention_pct || 0, notes, `PC ${pc.number}`, Math.max(0, d.retention), v.basis, pc.id);
    const id = Number(r.lastInsertRowid);
    // the invoice must equal the PC to the fils
    const inv = enrich().invoices.find(x => x.id === id);
    if (Math.abs(inv.due_now - v.total) > 0.011) { db.prepare('DELETE FROM invoices WHERE id=?').run(id); bad(`The invoice would not match the PC (${money(inv.due_now)} vs ${money(v.total)}) — check the VAT basis on the project`); }
    db.prepare("UPDATE client_pcs SET status='invoiced', invoice_id=? WHERE id=?").run(id, pc.id);
    if (pc.app_id) db.prepare("UPDATE pay_apps SET status='invoiced' WHERE id=?").run(pc.app_id);
    // BOQ: billed % follows what was certified
    const lines = J(pc.lines).length ? J(pc.lines).map(l => ({ key: l.key, q: +l.cert_qty || 0 })) : pc.app_id ? J((db.prepare('SELECT lines FROM pay_apps WHERE id=?').get(pc.app_id) || {}).lines).map(l => ({ key: l.key, q: +l.cum_qty || 0 })) : [];
    for (const l of lines) if (/^b\d+$/.test(l.key)) {
      const b = db.prepare('SELECT * FROM boq_items WHERE id=? AND project_id=?').get(+l.key.slice(1), p.id);
      if (b && b.qty > 0) db.prepare('UPDATE boq_items SET billed_pct=? WHERE id=?').run(Math.min(100, round(l.q / b.qty * 100)), b.id);
    }
    audit(req, 'create', 'pc_invoice', id, `${p.name} PC ${pc.number}`);
    return { id, number: inv.number, total: inv.due_now };
  }

  // ---- printable payment application -------------------------------------------------------------------------------------------
  // Proforma invoice: the BOQ with quantities and amounts for the main contractor to check against their records before the PC —
  // English only, no VAT, no TRN, no bank details (the tax invoice follows the PC)
  ctx.renderers.pay_app = id => {
    const app = db.prepare('SELECT * FROM pay_apps WHERE id=?').get(id) || notFound(), p = proj(app.project_id), a = appView(app, p), S = getSettings(), cur = S.currency || 'AED';
    const client = db.prepare('SELECT * FROM parties WHERE id=?').get(p.client_id) || {};
    const row = (k, v) => v ? `<tr><td>${k}</td><td>${v}</td></tr>` : '';
    const sum = (k, v, b, neg) => `<tr${b ? ' class="b"' : ''}><td>${k}</td><td class="n">${neg && v ? '(' + money(v) + ')' : money(v)}</td></tr>`;
    const lines = a.lines.filter(l => l.cum_qty || l.prev_qty || l.qty);
    let sec = null;
    const body = lines.map(l => { const h = l.section && l.section !== sec ? `<tr class="sec"><td colspan="10">${esc(l.section)}</td></tr>` : ''; sec = l.section;
      return `${h}<tr><td>${esc(l.item || '')}</td><td>${esc(l.description)}</td><td>${esc(l.unit)}</td><td class="n">${money(l.qty)}</td><td class="n">${money(l.rate)}</td><td class="n">${money(l.prev_qty)}</td><td class="n">${money(l.this_qty)}</td><td class="n">${money(l.cum_qty)}</td><td class="n">${money(l.cum_amount)}</td><td class="n">${l.qty ? round(l.cum_qty / l.qty * 100) : 0}%</td></tr>`; }).join('');
    const thisTotal = round(lines.reduce((s, l) => s + l.this_amount, 0));
    return { title: `Proforma Invoice ${a.number}`, filename: a.number, ref: a.number, date: a.date, trn: false, label: 'Submitted by', receiver: 'Received by (main contractor)',
      body: `<style>.boqp{width:100%;table-layout:fixed;font-size:7.5pt}.boqp th{font-size:6pt;letter-spacing:0;white-space:normal;padding:1mm .8mm}.boqp td{padding:1.1mm .8mm;word-wrap:break-word}.boqp .n{white-space:nowrap}
        .boqp tr.sec td{font-weight:700;padding-top:2mm;border-bottom:.5pt solid #8A8578}.boqp tfoot td{font-weight:700;border-top:1pt solid #1F3A5F;border-bottom:0}
        .cv{display:flex;gap:4mm;margin:0 0 3mm;font-size:8pt}.cv div{flex:1;border-bottom:.5pt solid #D6D2C8;padding:1mm 0;display:flex;justify-content:space-between}.cv span{color:#8A8578}
        .psum{width:95mm;margin:3mm 0 0 auto;font-size:8.5pt}.psum td{padding:.9mm 1mm}.psum tr.b td{font-weight:700;border-top:1pt solid #1F3A5F}.psum tr.net td{font-size:10pt;font-weight:800;border-top:1.5pt solid #1F3A5F;border-bottom:1.5pt solid #1F3A5F}</style>
      <h2 class="t">PROFORMA INVOICE</h2>
      <div class="info"><div><h4>To</h4><div class="nm">${esc(client.name || '')}</div>${client.address ? `<div class="muted">${esc(client.address)}</div>` : ''}
          <table style="margin-top:1.5mm"><tbody>${row('Project', esc(`${p.code ? p.code + ' — ' : ''}${p.name}`))}${row('Main contract', esc(p.main_contract || ''))}${row('Contract no.', esc(p.client_contract_ref || ''))}</tbody></table></div>
        <div><h4>Proforma details</h4><table><tbody>${row('Proforma no.', `<b class="mono">${esc(a.number)}</b>`)}${row('Application no.', String(a.seq))}${row('Date', esc(a.date))}${row('For works up to', esc(a.period_to || ''))}${row('Previous certificate', esc(a.previous_pc ? 'PC ' + a.previous_pc : ''))}</tbody></table></div></div>
      <div class="cv"><div><span>Contract value</span><b class="mono">${money(a.contract_value)}</b></div><div><span>Approved variations</span><b class="mono">${money(a.variations)}</b></div><div><span>Adjusted contract value</span><b class="mono">${money(a.adjusted)}</b></div></div>
      <table class="boqp"><colgroup>${[4, 30, 5, 9, 8, 9, 8, 9, 12, 6].map(w => `<col style="width:${w}%">`).join('')}</colgroup>
        <thead><tr><th>Item</th><th>Description</th><th>Unit</th><th class="n">Contract<br>qty</th><th class="n">Rate</th><th class="n">Previous<br>qty</th><th class="n">This<br>period</th><th class="n">Cumulative<br>qty</th><th class="n">Cumulative<br>amount</th><th class="n">%</th></tr></thead>
        <tbody>${body}</tbody><tfoot><tr><td colspan="6">Total</td><td class="n"></td><td></td><td class="n">${money(a.work)}</td><td class="n">${a.adjusted ? round(a.work / a.adjusted * 100) : 0}%</td></tr></tfoot></table>
      <table class="psum"><tbody>
        ${sum('Value of work done to date', a.work)}${a.materials ? sum('Materials on site', a.materials) : ''}${a.adv_rec_cum ? sum(`Less: advance payment recovery (${a.recovery_pct}%)`, a.adv_rec_cum, 0, 1) : ''}${sum('Amount due to date (A)', a.A, 1)}
        ${sum(`Retention ${a.retention_pct}% (cumulative)`, a.retention_cum)}${a.release_cum ? sum('Less: retention released', a.release_cum, 0, 1) : ''}${a.contra_cum ? sum('Contra charges (as last certified)', a.contra_cum) : ''}${sum('Previous payments certified', a.prev_payments)}${sum('Total deductions (B)', a.B, 1)}
        <tr class="net"><td>NET AMOUNT (A − B) ${esc(cur)}</td><td class="n">${money(a.net)}</td></tr></tbody></table>
      <p style="font-size:8.5pt;text-align:end"><b>(${esc(amountInWords(a.net, cur))})</b></p>
      <p class="muted" style="font-size:8pt">Work done this period: ${money(thisTotal)}. Please check the quantities against your records; the tax invoice will be issued for the amount you certify.</p>
      ${a.notes ? `<p style="font-size:8.5pt"><b>Notes:</b><br>${esc(a.notes).replace(/\n/g, '<br>')}</p>` : ''}` };
  };

  const appFields = b => ({ date: b.date, period_to: b.period_to || null, materials: num(b.materials), notes: b.notes || '' });
  const PCF = ['number', 'app_id', 'issue_date', 'period_to', 'work_cum', 'materials', 'adv_rec_cum', 'retention_cum', 'release_cum', 'contra_cum', 'prev_payments', 'vat_certified',
    'prev_work', 'prev_materials', 'prev_adv_rec', 'prev_retention', 'prev_release', 'prev_contra', 'prev_vat', 'cost_codes', 'notes'];
  const NUMF = new Set(['work_cum', 'materials', 'adv_rec_cum', 'retention_cum', 'release_cum', 'contra_cum', 'prev_payments', 'prev_work', 'prev_materials', 'prev_adv_rec', 'prev_retention', 'prev_release', 'prev_contra', 'prev_vat']);
  const pcRow = (b, old = {}) => {
    const r = {}; for (const k of PCF) r[k] = b[k] !== undefined ? b[k] : old[k];
    for (const k of NUMF) r[k] = num(r[k]);
    r.vat_certified = r.vat_certified === '' || r.vat_certified === undefined || r.vat_certified === null ? null : num(r.vat_certified);
    r.app_id = r.app_id ? +r.app_id : null;
    if (!String(r.number || '').trim()) bad('Enter the PC number');
    if (!/^\d{4}-\d\d-\d\d$/.test(r.issue_date || '')) bad('Enter the PC date of issue');
    r.lines = JSON.stringify(Array.isArray(b.lines) ? b.lines.map(l => ({ key: String(l.key), item: l.item || '', description: l.description || '', unit: l.unit || '', qty: +l.qty || 0, rate: +l.rate || 0, cert_qty: num(l.cert_qty) })) : J(old.lines));
    return r;
  };

  return {
    async handle(req, res, url, [a, b, c], me) {
      if (a !== 'claims') return false;
      const m = req.method;
      if (m === 'GET' && !b) {
        const pid = +url.searchParams.get('project_id'), p = proj(pid);
        const apps = db.prepare('SELECT * FROM pay_apps WHERE project_id=? ORDER BY seq').all(pid).map(x => appView(x, p));
        const pcs = pcsOf(pid).map(x => pcView(x, p));
        return send(res, 200, { apps, pcs, project: { id: p.id, vat_basis: p.vat_basis || 'gross', client_contract_ref: p.client_contract_ref || '', main_contract: p.main_contract || '', retention_pct: p.retention_pct || 0, payment_terms_days: p.payment_terms_days || null } }), true;
      }
      if (b === 'apps') {
        if (m === 'POST' && !c) {
          const x = await readBody(req), p = proj(+x.project_id);
          const lines = newLines(p.id); if (!lines.length) bad('Add the BOQ items to the project first');
          const seq = db.prepare('SELECT COUNT(*) n FROM pay_apps WHERE project_id=?').get(p.id).n + 1;
          const f = appFields({ date: today(), ...x }); if (!/^\d{4}-\d\d-\d\d$/.test(f.date)) bad('Invalid date');
          const r = db.prepare('INSERT INTO pay_apps(project_id,seq,number,date,period_to,lines,materials,notes,status,created,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
            .run(p.id, seq, nextNumber('pay_apps', 'PF'), f.date, f.period_to, JSON.stringify(lines), f.materials, f.notes, 'draft', today(), me.username);
          audit(req, 'create', 'pay_apps', Number(r.lastInsertRowid), `${p.name} No. ${seq}`);
          return send(res, 200, appView(db.prepare('SELECT * FROM pay_apps WHERE id=?').get(r.lastInsertRowid), p)), true;
        }
        const row = c ? db.prepare('SELECT * FROM pay_apps WHERE id=?').get(+c) : null; if (c && !row) notFound();
        if (m === 'GET' && row) return send(res, 200, appView(row)), true;
        if (m === 'PUT' && row) {
          const x = await readBody(req);
          if (['certified', 'invoiced'].includes(row.status) && (x.lines || x.materials !== undefined)) bad('This application was certified — record changes on the PC');
          const f = appFields({ ...row, ...x });
          let lines = J(row.lines);
          if (Array.isArray(x.lines)) { const byKey = Object.fromEntries(x.lines.map(l => [String(l.key), l])); lines = lines.map(l => byKey[l.key] ? { ...l, cum_qty: Math.max(0, num(byKey[l.key].cum_qty)) } : l); }
          const status = x.status && ['draft', 'submitted'].includes(x.status) && ['draft', 'submitted'].includes(row.status) ? x.status : row.status;
          db.prepare('UPDATE pay_apps SET date=?, period_to=?, materials=?, notes=?, lines=?, status=? WHERE id=?').run(f.date, f.period_to, f.materials, f.notes, JSON.stringify(lines), status, row.id);
          audit(req, 'update', 'pay_apps', row.id, status);
          return send(res, 200, appView(db.prepare('SELECT * FROM pay_apps WHERE id=?').get(row.id))), true;
        }
        if (m === 'DELETE' && row) {
          if (['certified', 'invoiced'].includes(row.status)) bad('A certified application cannot be deleted');
          db.prepare('DELETE FROM pay_apps WHERE id=?').run(row.id); audit(req, 'delete', 'pay_apps', row.id);
          return send(res, 200, { ok: 1 }), true;
        }
      }
      if (b === 'pcs') {
        if (m === 'GET' && c === 'new') {                                        // a form pre-filled from the previous PC and the application
          const pid = +url.searchParams.get('project_id'), p = proj(pid), appId = +url.searchParams.get('app_id') || null, prev = lastPc(pid), pv = prev ? pcCalc(prev, p) : null;
          const app = appId ? db.prepare('SELECT * FROM pay_apps WHERE id=? AND project_id=?').get(appId, pid) : null, av = app ? appView(app, p) : null;
          const lines = av ? av.lines.map(l => ({ key: l.key, item: l.item, description: l.description, unit: l.unit, qty: l.qty, rate: l.rate, cert_qty: l.cum_qty })) : [];
          return send(res, 200, { project_id: pid, app_id: appId, number: '', issue_date: today(), period_to: av ? av.period_to : '', lines,
            work_cum: av ? av.work : (prev ? num(prev.work_cum) : 0), materials: av ? av.materials : (prev ? num(prev.materials) : 0), adv_rec_cum: av ? av.adv_rec_cum : (prev ? num(prev.adv_rec_cum) : 0),
            retention_cum: av ? av.retention_cum : (prev ? num(prev.retention_cum) : 0), release_cum: prev ? num(prev.release_cum) : 0, contra_cum: prev ? num(prev.contra_cum) : 0,
            prev_payments: prev ? round(num(prev.prev_payments) + pv.net) : 0, vat_certified: null,
            prev_work: prev ? num(prev.work_cum) : 0, prev_materials: prev ? num(prev.materials) : 0, prev_adv_rec: prev ? num(prev.adv_rec_cum) : 0, prev_retention: prev ? num(prev.retention_cum) : 0,
            prev_release: prev ? num(prev.release_cum) : 0, prev_contra: prev ? num(prev.contra_cum) : 0, prev_vat: prev ? pv.vat_cum : 0, first: !prev, cost_codes: '', notes: '' }), true;
        }
        if (m === 'POST' && !c) {
          const x = await readBody(req), p = proj(+x.project_id), r0 = pcRow(x);
          if (r0.app_id && !db.prepare('SELECT 1 FROM pay_apps WHERE id=? AND project_id=?').get(r0.app_id, p.id)) bad('That application belongs to another project');
          if (r0.app_id && db.prepare('SELECT 1 FROM client_pcs WHERE app_id=?').get(r0.app_id)) bad('A PC is already recorded for this application');
          const cols = [...PCF, 'lines'];
          const r = db.prepare(`INSERT INTO client_pcs(project_id,${cols.join(',')},status,created,created_by) VALUES(?,${cols.map(() => '?').join(',')},'recorded',?,?)`).run(p.id, ...cols.map(k => r0[k]), today(), me.username);
          if (r0.app_id) db.prepare("UPDATE pay_apps SET status='certified' WHERE id=?").run(r0.app_id);
          audit(req, 'create', 'client_pcs', Number(r.lastInsertRowid), `${p.name} PC ${r0.number}`);
          return send(res, 200, pcView(db.prepare('SELECT * FROM client_pcs WHERE id=?').get(r.lastInsertRowid), p)), true;
        }
        const row = c ? db.prepare('SELECT * FROM client_pcs WHERE id=?').get(+c) : null; if (c && !row) notFound();
        if (m === 'GET' && row) return send(res, 200, pcView(row)), true;
        if (m === 'PUT' && row) {
          if (row.invoice_id) bad('A tax invoice was issued for this PC — void the invoice or issue a credit note first');
          const x = await readBody(req), r0 = pcRow(x, row);
          if (r0.app_id !== row.app_id && r0.app_id && db.prepare('SELECT 1 FROM client_pcs WHERE app_id=? AND id!=?').get(r0.app_id, row.id)) bad('A PC is already recorded for this application');
          db.prepare(`UPDATE client_pcs SET ${[...PCF, 'lines'].map(k => k + '=?').join(',')} WHERE id=?`).run(...[...PCF, 'lines'].map(k => r0[k]), row.id);
          if (row.app_id && row.app_id !== r0.app_id) db.prepare("UPDATE pay_apps SET status='submitted' WHERE id=? AND status='certified'").run(row.app_id);
          if (r0.app_id) db.prepare("UPDATE pay_apps SET status='certified' WHERE id=? AND status!='invoiced'").run(r0.app_id);
          audit(req, 'update', 'client_pcs', row.id);
          return send(res, 200, pcView(db.prepare('SELECT * FROM client_pcs WHERE id=?').get(row.id))), true;
        }
        if (m === 'DELETE' && row) {
          if (row.invoice_id) bad('A tax invoice was issued for this PC — it cannot be deleted');
          db.prepare('DELETE FROM client_pcs WHERE id=?').run(row.id);
          if (row.app_id) db.prepare("UPDATE pay_apps SET status='submitted' WHERE id=? AND status='certified'").run(row.app_id);
          audit(req, 'delete', 'client_pcs', row.id); return send(res, 200, { ok: 1 }), true;
        }
      }
      if (b === 'pc-invoice' && c && m === 'POST') {
        const row = db.prepare('SELECT * FROM client_pcs WHERE id=?').get(+c) || notFound(), x = await readBody(req).catch(() => ({}));
        try { return send(res, 200, invoiceFromPc(row, x || {}, req)), true; }
        catch (e) { if (e.checks) return send(res, 409, { error: 'check_pc', checks: e.checks }), true; throw e; }
      }
      return false;
    },
  };
};
