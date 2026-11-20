// Ledger alignment Trigon ↔ Zoho (accounting review of 2026-11-20), from the "ledger rules" date:
//  - payroll: site (5200) / head office (6200) by the attendance allocation — one engine for the ledger, project costs and Zoho;
//  - post-dated cheques: into 1050 / 2050 on their date, into the bank only on the cheque date once cleared;
//  - customer advances: on 2400 until recovered, in Zoho as in Trigon.
// For each: before / after, and Trigon trial balance = expected accounting effect = Zoho payload effect, at several dates.
// node --no-warnings test-ledgeralign.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-align-'));
process.env.ZOHO_NO_SCHEDULER = '1'; process.env.SALES_NO_SCHEDULER = '1';
const zoho = require('./tools/zoho-mock.js')();
process.env.ZOHO_CLIENT_ID = zoho.CLIENT_ID; process.env.ZOHO_CLIENT_SECRET = zoho.CLIENT_SECRET;
const { server, ctx } = require('./server.js');
// this suite tests the send engine itself: the READY gate of the account-provisioning workflow is tested in test-zohoacct.js
ctx.db.prepare("UPDATE zoho_config SET value='0' WHERE key='gate_required'").run();
const r2 = x => Math.round(x * 100) / 100;

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api/`; let cookie = '';
  const call = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { s: r.status, j, t }; };
  const ok = (r, l) => { assert.equal(r.s, 200, `${l || ''} → ${r.s} ${r.t.slice(0, 300)}`); return r.j; };
  const no = (r, re) => { assert.ok(r.s >= 400, `expected a refusal, got ${r.s}`); assert.match(r.t, re); };
  await new Promise(r => zoho.srv.listen(0, r)); process.env.ZOHO_ACCOUNTS_URL = zoho.accountsUrl;
  const out = [];
  try {
    ok(await call('POST', 'setup', { username: 'admin', password: 'secret12', company: 'Trigon' }));
    ok(await call('PUT', 'settings', { trn: '100123456700003', mohre_id: '1234567890123', employer_routing: '302620122' }));
    const WPS = { person_code: '12345678901234', routing_code: '302620122', iban: 'AE070331234567890123456' };
    const cl = ok(await call('POST', 'parties', { type: 'client', name: 'Client Test', trn: '100000000000003' })).id;
    const sup = ok(await call('POST', 'parties', { type: 'supplier', name: 'Supplier Test', trn: '100000000000011' })).id;
    const P = ok(await call('POST', 'projects', { name: 'Roads', client_id: cl, contract_value: 1000000, retention_pct: 0, advance_pct: 10, advance_recovery_pct: 10, status: 'active' })).id;
    const boq = ok(await call('POST', 'boq_items', { project_id: P, description: 'Asphalt', unit: 'm2', qty: 100, rate: 5000 })).id;
    // customer advance 10% (100,000 + VAT), then progress 40% of the asphalt = 200,000 of work, 20,000 recovered
    const adv = ok(await call('POST', `projects/${P}/advance-invoice`, { date: '2026-11-03' })).id;
    ok(await call('PUT', 'boq_items/' + boq, { done_pct: 40 }));
    const prog = ok(await call('POST', `projects/${P}/progress-invoice`, { date: '2026-11-08' })).id;
    const AI = ok(await call('GET', 'invoices/' + adv)), PI = ok(await call('GET', 'invoices/' + prog));
    assert.equal(AI.subtotal, 100000); assert.equal(PI.recovery, 20000); assert.equal(PI.revenue, 200000);
    // payroll November: a site worker (all days on the project) and a head-office employee who worked 10 days on the project
    const W = ok(await call('POST', 'employees', { name: 'Site Worker', join_date: '2025-01-01', basic: 3000, project_id: P, ...WPS })).id;
    const H = ok(await call('POST', 'employees', { name: 'Office Engineer', join_date: '2025-01-01', basic: 9000, ...WPS })).id;
    for (let d = 1; d <= 30; d++) ok(await call('PUT', 'attendance', { employee_id: W, date: `2026-11-${String(d).padStart(2, '0')}`, status: 'present', project_id: P }));
    for (let d = 1; d <= 10; d++) ok(await call('PUT', 'attendance', { employee_id: H, date: `2026-11-${String(d).padStart(2, '0')}`, status: 'present', project_id: P }));
    ok(await call('POST', 'payroll/generate', { month: '2026-11' })); ok(await call('POST', 'payroll/finalize', { month: '2026-11' })); ok(await call('POST', 'payroll/pay', { month: '2026-11', date: '2026-12-02' }));
    const gross = id => ctx.db.prepare("SELECT gross FROM payroll WHERE month='2026-11' AND employee_id=?").get(id).gross, gW = gross(W), gH = gross(H);
    // post-dated cheques: the advance received 4 Nov due 25 Nov (still pending); the progress invoice part received 12 Nov due 18 Nov
    // (cleared); a supplier bill paid by a cheque issued 10 Nov due 15 Nov (cleared)
    const c1 = ok(await call('POST', 'payments', { kind: 'in', date: '2026-11-04', amount: 105000, method: 'cheque', cheque_date: '2026-11-25', cheque_status: 'pending', invoice_id: adv, reference: 'CHQ-A' })).id;
    const c2 = ok(await call('POST', 'payments', { kind: 'in', date: '2026-11-12', amount: 50000, method: 'cheque', cheque_date: '2026-11-18', cheque_status: 'cleared', invoice_id: prog, reference: 'CHQ-B' })).id;
    const sb = ok(await call('POST', 'bills', { party_id: sup, date: '2026-11-06', amount: 1000, vat_amount: 50, category: 'materials', project_id: P, reference: 'S-1' })).id;
    const c3 = ok(await call('POST', 'payments', { kind: 'out', date: '2026-11-10', amount: 1050, method: 'cheque', cheque_date: '2026-11-15', cheque_status: 'cleared', bill_id: sb, reference: 'CHQ-C' })).id;

    const tb = to => { const f = ctx.financials('2000-01-01', to); return Object.fromEntries(f.trial_balance.map(a => [a.code, r2(a.debit - a.credit)])); };
    const DATES = ['2026-11-11', '2026-11-16', '2026-11-22', '2026-12-31'];

    // ---- BEFORE (no ledger rules date): head office all on 6200; a cleared cheque straight into the bank on its receipt date
    const before = Object.fromEntries(DATES.map(d => [d, tb(d)]));
    assert.equal(before['2026-12-31']['6200'], gH); assert.equal(before['2026-12-31']['5200'], gW);
    assert.equal(before['2026-11-11']['1000'] || 0, -1050, 'before: the supplier cheque left the bank on 10 Nov although due 15 Nov');
    assert.equal(before['2026-11-16']['1050'], 105000, 'before: only the pending cheque in 1050');
    out.push('before: head office on 6200 only; a cleared cheque in the bank on its receipt date');

    // ---- the ledger rules date (admin, after the closing date) and Zoho's new types from the same date
    ok(await call('PUT', 'period/rules', { ledger_rules_from: '2026-11-01' }));
    const after = Object.fromEntries(DATES.map(d => [d, tb(d)]));

    // ---- expected accounting effect, worked out by hand
    const hq = r2(gH * 10 / 30), E = {
      '2026-11-11': { 1050: 105000, 1100: 189000, 2050: -1050, 1000: 0 },                // the advance cheque in 1050, the supplier cheque in 2050; the progress invoice (189,000 with VAT) still open
      '2026-11-16': { 1050: 155000, 2050: 0, 1000: -1050 },                              // supplier cheque cleared 15 Nov; CHQ-B received 12 Nov
      '2026-11-22': { 1050: 105000, 1000: 48950 },                                       // CHQ-B cleared 18 Nov
      '2026-12-31': { 1050: 105000, 1000: r2(48950 - (gW + gH - ctx.db.prepare("SELECT SUM(deductions) d FROM payroll WHERE month='2026-11'").get().d)), 2050: 0,
        5200: r2(gW + hq), 6200: r2(gH - hq), 2400: -80000, 4000: -200000 },             // advance 100,000 less 20,000 recovered
    };
    for (const [d, exp] of Object.entries(E)) for (const [code, v] of Object.entries(exp)) assert.equal(after[d][code] || 0, v, `Trigon ${code} at ${d}`);
    assert.equal(r2(after['2026-12-31']['5200'] + after['2026-12-31']['6200']), r2(gW + gH), 'project allocations + head office = payroll expense');
    out.push(`after: 5200 = ${E['2026-12-31'][5200]}, 6200 = ${E['2026-12-31'][6200]} (10 of 30 days on site); cheques in 1050 / 2050 until their date; 2400 = -80,000`);

    // ---- Zoho: connect, map one Zoho account per Trigon code, send
    ok(await call('POST', 'zoho/connect', { code: '1000.code.one' }));
    ok(await call('PUT', 'zoho/config', { enabled: '1', start: '2026-11-01', start_v2: '2026-11-01', post: '0' }));
    const Zof = { 2001: '1000', 2002: '1020', 3201: '1100' };
    zoho.T.chartofaccounts.push({ account_id: 'ZAP', account_name: 'Accounts Payable', account_type: 'accounts_payable' }); Zof.ZAP = '2000';
    for (const [code, type, bank] of [['1050', 'other_current_asset'], ['2050', 'other_current_liability'], ['2400', 'other_current_liability'], ['5200', 'expense'], ['6200', 'expense'], ['2200', 'other_current_liability'], ['2250', 'other_current_liability'], ['1300', 'other_current_asset'], ['5260', 'expense'], ['2300', 'other_liability'], ['1150', 'other_current_asset']]) {
      const id = 'Z' + code; zoho.T.chartofaccounts.push({ account_id: id, account_name: 'Trigon ' + code, account_type: type }); Zof[id] = code;
      ok(await call('PUT', 'zoho/mapping', { kind: 'account', local_key: 'acct:' + code, zoho_id: id }));
    }
    zoho.T.chartofaccounts.push({ account_id: 'Z5100', account_name: 'Trigon 5100', account_type: 'expense' }); Zof.Z5100 = '5100'; ok(await call('PUT', 'zoho/mapping', { kind: 'account', local_key: 'cat:materials', zoho_id: 'Z5100' }));
    const pre = ok(await call('POST', 'zoho/dry-run', { from: '2026-11-01', to: '2026-12-31' }));
    assert.deepEqual(pre.preflight.missing_accounts, []); assert.equal(pre.failed, 0, JSON.stringify(pre.errors));
    const r = ok(await call('POST', 'zoho/sync', { from: '2026-11-01', to: '2026-12-31' })); assert.equal(r.failed, 0, r.message);

    // the documents: advance lines on 2400; the cheques as 1050 / 2050 journals against the customer / supplier, the payment on the cheque date
    const zi = n => zoho.T.invoices.find(i => i.invoice_number === n);
    assert.ok(zi(AI.number).line_items.every(l => l.account_id === 'Z2400'), 'advance invoice on 2400');
    assert.equal(zi(PI.number).line_items.filter(l => l.account_id === 'Z2400').length, 1, 'only the recovery line of the progress invoice on 2400');
    const J = ref => zoho.T.journals.find(j => j.reference_number === ref);
    assert.ok(J(`PDC-${c1}`) && !J(`PDC-CLR-${c1}`), 'pending cheque: in 1050, not cleared'); assert.ok(J(`PDC-${c2}`) && J(`PDC-CLR-${c2}`).journal_date === '2026-11-18');
    assert.equal(J(`PDC-${c1}`).line_items.find(l => l.debit_or_credit === 'credit').customer_id, zoho.T.contacts.find(c => c.contact_name === 'Client Test').contact_id, 'against the customer');
    assert.equal(J(`PDC-${c3}`).line_items.find(l => l.debit_or_credit === 'debit').customer_id, zoho.T.contacts.find(c => c.contact_name === 'Supplier Test').contact_id, 'against the supplier');
    assert.equal(zoho.T.customerpayments.length, 1, 'only the cleared receipt reached Zoho as a payment'); assert.equal(zoho.T.customerpayments[0].date, '2026-11-18');
    assert.equal(zoho.T.vendorpayments[0].date, '2026-11-15');

    // ---- Zoho payload effect at each date = expected = Trigon, on every account
    const zt = id => Zof[id] || '?' + id, vat = l => { const t = zoho.T.taxes.find(x => x.tax_id === l.tax_id); return t ? r2(l.quantity * l.rate * t.tax_percentage / 100) : 0; };
    const zEffect = to => {
      const Z = {}, post = (c, dr, cr) => { Z[c] = r2((Z[c] || 0) + dr - cr); };
      for (const i of zoho.T.invoices) if (i.date <= to && i.status !== 'void') for (const l of i.line_items) { post('1100', l.quantity * l.rate + vat(l), 0); post(l.account_id ? zt(l.account_id) : '4000', 0, l.quantity * l.rate); post('2100', 0, vat(l)); }
      for (const b of zoho.T.bills) if (b.date <= to) for (const l of b.line_items) { post(zt(l.account_id), l.quantity * l.rate, 0); post('1200', vat(l), 0); post('2000', 0, l.quantity * l.rate + vat(l)); }
      for (const p of zoho.T.customerpayments) if (p.date <= to) { post(zt(p.account_id), p.amount, 0); post('1100', 0, p.amount); }
      for (const p of zoho.T.vendorpayments) if (p.date <= to) { post('2000', p.amount, 0); post(zt(p.paid_through_account_id), 0, p.amount); }
      for (const j of zoho.T.journals) if (j.journal_date <= to) for (const l of j.line_items) post(zt(l.account_id), l.debit_or_credit === 'debit' ? l.amount : 0, l.debit_or_credit === 'credit' ? l.amount : 0);
      return Z;
    };
    for (const d of DATES) {
      const T = after[d], Z = zEffect(d), codes = [...new Set([...Object.keys(T), ...Object.keys(Z)])];
      assert.deepEqual(codes.filter(c => Math.abs((T[c] || 0) - (Z[c] || 0)) > 0.005).map(c => `${c}: Trigon ${T[c] || 0} / Zoho ${Z[c] || 0}`), [], `every account at ${d}: Zoho = Trigon`);
      for (const [code, v] of Object.entries(E[d] || {})) assert.equal(Z[code] || 0, v, `Zoho ${code} at ${d} = expected`);
    }
    out.push(`Trigon = expected = Zoho on every account at ${DATES.join(', ')}`);

    // ---- the invariant: allocations + head office = payroll expense (daily check), and it notices a broken allocation
    const chk = async () => ok(await call('GET', 'ops/checks')).results.find(x => x.id === 'payroll_allocation');
    assert.equal((await chk()).status, 'ok');
    const al = ctx.db.prepare('SELECT id, amount FROM payroll_alloc ORDER BY id LIMIT 1').get();
    ctx.db.prepare('UPDATE payroll_alloc SET amount=amount+1 WHERE id=?').run(al.id);
    const bad = await chk(); assert.equal(bad.status, 'fail'); assert.match(bad.detail, /allocation differs from the salary/); assert.doesNotMatch(bad.detail, /\d{3,}\.\d/, 'no amounts in the check text');
    ctx.db.prepare('UPDATE payroll_alloc SET amount=? WHERE id=?').run(al.amount, al.id); assert.equal((await chk()).status, 'ok');
    out.push('daily check: allocations + head office = payroll expense, and a broken allocation fails');

    // ---- a closed period never changes: the rules date must come after the closing date, and cannot move while inside it
    ok(await call('PUT', 'period', { lock_date: '2026-11-10' }));
    no(await call('PUT', 'period/rules', { ledger_rules_from: '2026-11-05' }), /closed up to 2026-11-10/);
    no(await call('PUT', 'period/rules', { ledger_rules_from: '2026-11-20' }), /cannot be changed while their date is in a closed period/);
    ok(await call('PUT', 'period', { lock_date: '' }));
    ok(await call('PUT', 'period/rules', { ledger_rules_from: '2026-11-01' }));
    out.push('the rules date: only after the closing date; not moved while inside a closed period');

    console.log(out.map(x => '  ✔ ' + x).join('\n'));
    console.log('LEDGER ALIGNMENT TESTS PASSED');
  } finally { server.close(); zoho.srv.close(); }
});
