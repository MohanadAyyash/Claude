// Zoho: the transactions it did not receive yet (petty cash, custody, claims, partners, assets, salaries paid by date, expenses paid
// through their real account). Rule: Zoho's accounting effect equals Trigon's, account by account: node --no-warnings test-zohov2.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-zohov2-'));
process.env.ZOHO_NO_SCHEDULER = '1'; process.env.SALES_NO_SCHEDULER = '1';
const mockZoho = require('./tools/zoho-mock.js');
const zoho = mockZoho();
process.env.ZOHO_CLIENT_ID = zoho.CLIENT_ID; process.env.ZOHO_CLIENT_SECRET = zoho.CLIENT_SECRET;      // as the office PC's .env would
const { server, ctx } = require('./server.js');
// this suite tests the send engine itself: the READY gate of the account-provisioning workflow is tested in test-zohoacct.js
ctx.db.prepare("UPDATE zoho_config SET value='0' WHERE key='gate_required'").run();

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api/`; let cookie = '';
  const call = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j, t }; };
  const ok = (r, l) => { assert.equal(r.s, 200, `${l || ''} → ${r.s} ${JSON.stringify(r.j).slice(0, 300)}`); return r.j; };
  await new Promise(r => zoho.srv.listen(0, r)); process.env.ZOHO_ACCOUNTS_URL = zoho.accountsUrl;
  const RANGE = { from: '2026-10-01', to: '2026-12-31' }, writes = () => zoho.calls.filter(c => /^(POST|PUT)/.test(c)).length, out = [];
  try {
    ok(await call('POST', 'setup', { username: 'admin', password: 'secret12', company: 'Trigon' }));
    ok(await call('PUT', 'settings', { trn: '100123456700003', mohre_id: '1234567890123', employer_routing: '302620122' }));
    const WPS = { person_code: '12345678901234', routing_code: '302620122', iban: 'AE070331234567890123456' };
    const cl = ok(await call('POST', 'parties', { type: 'client', name: 'Emaar Test', trn: '100000000000003' })).id;
    const A = ok(await call('POST', 'projects', { name: 'Villa 12', client_id: cl, retention_pct: 10, status: 'active' })).id, B = ok(await call('POST', 'projects', { name: 'Roads', client_id: cl, status: 'active' })).id;
    const inv = ok(await call('POST', 'invoices', { project_id: A, date: '2026-11-05', retention_pct: 10, items: [{ description: 'Excavation', qty: 100, rate: 50 }] })).id;
    // payroll Nov 2026: one worker 20 days on A, 10 on B; one head-office employee; an advance paid in cash
    const w = ok(await call('POST', 'employees', { name: 'Worker', join_date: '2025-01-01', basic: 3000, project_id: A, ...WPS })).id;
    ok(await call('POST', 'employees', { name: 'Accountant', join_date: '2025-01-01', basic: 6000, ...WPS }));
    for (let d = 1; d <= 30; d++) ok(await call('PUT', 'attendance', { employee_id: w, date: `2026-11-${String(d).padStart(2, '0')}`, status: 'present', project_id: d <= 20 ? A : B }));
    ok(await call('POST', 'hr/loans', { employee_id: w, amount: 600, installments: 2, start_month: '2026-11', method: 'cash' }));
    ok(await call('POST', 'payroll/generate', { month: '2026-11' })); ok(await call('POST', 'payroll/finalize', { month: '2026-11' }));
    ok(await call('POST', 'payroll/pay', { month: '2026-11', date: '2026-12-02' }));


    // ---- the new transaction types, all from 2026-11-01
    const sup = ok(await call('POST', 'parties', { type: 'supplier', name: 'Block Factory', trn: '100000000000011' })).id;
    const PA = ok(await call('POST', 'partners', { name: 'Partner Alpha' })).id, PB = ok(await call('POST', 'partners', { name: 'Partner Beta' })).id;
    for (const [p, pct] of [[PA, 60], [PB, 40]]) ok(await call('POST', `partners/${p}/shares`, { pct, from_date: '2026-01-01' }));
    ok(await call('POST', 'partner_txns', { partner_id: PA, date: '2026-11-02', type: 'capital_in', amount: 100000, method: 'bank' }));
    ok(await call('POST', 'partner_txns', { partner_id: PB, date: '2026-11-02', type: 'loan_in', amount: 20000, method: 'bank' }));
    ok(await call('POST', 'partner_txns', { partner_id: PB, date: '2026-11-03', type: 'deposit', amount: 3000, method: 'cash' }));
    ok(await call('POST', 'partner_txns', { partner_id: PB, date: '2026-11-25', type: 'withdrawal', amount: 1000, method: 'bank' }));
    // a supplier bill a partner paid, and an expense without a supplier a partner paid
    const sb = ok(await call('POST', 'bills', { party_id: sup, date: '2026-11-04', amount: 1000, vat_amount: 50, category: 'materials', project_id: A, reference: 'BF-1' })).id;
    ok(await call('POST', `partners/${PB}/expense`, { bill_id: sb, date: '2026-11-06', amount: 1050 }));
    ok(await call('POST', `partners/${PA}/expense`, { date: '2026-11-05', description: 'Site fuel', amount: 200, vat_amount: 10, category: 'equipment', project_id: A }));
    // office petty cash: top-up from the bank, an expense paid from it
    ok(await call('POST', 'petty_topups', { date: '2026-11-03', amount: 2000, note: 'office float' }));
    ok(await call('POST', 'petty_topups/expense', { date: '2026-11-07', description: 'Office water', amount: 100, vat_amount: 5 }));
    // petty cash held by an employee: hand-over, an expense from it, the rest returned
    const E = ok(await call('POST', 'employees', { name: 'Site Foreman', join_date: '2025-01-01', basic: 2500, project_id: A, ...WPS })).id;
    ok(await call('POST', 'petty_custody/handover', { employee_id: E, date: '2026-11-08', amount: 1000, method: 'cash' }));
    const cc = ok(await call('POST', 'expense_claims', { employee_id: E, date: '2026-11-09', description: 'Nails', amount: 300, vat_amount: 15, project_id: A, paid_from: 'custody' })).id;
    ok(await call('POST', `expense_claims/${cc}/decide`, { status: 'approved' }));
    ok(await call('POST', 'petty_custody/return', { employee_id: E, date: '2026-11-12', amount: 200, method: 'bank' }));
    // an employee's own money: an expense without a supplier, a supplier bill, then the reimbursement
    const c1 = ok(await call('POST', 'expense_claims', { employee_id: E, date: '2026-11-10', description: 'Taxi', amount: 150, vat_amount: 7.5, project_id: A })).id;
    const c2 = ok(await call('POST', 'expense_claims', { employee_id: E, date: '2026-11-10', description: 'Cement bags', amount: 400, vat_amount: 20, project_id: A, party_id: sup, reference: 'BF-2' })).id;
    for (const c of [c1, c2]) ok(await call('POST', `expense_claims/${c}/decide`, { status: 'approved' }));
    ok(await call('POST', 'expense_claims/reimburse', { employee_id: E, date: '2026-11-14', amount: 577.5, method: 'bank' }));
    // an expense without a supplier entered unpaid, paid later by bank (a sundry-supplier bill in Zoho)
    const ub = ok(await call('POST', 'bills', { date: '2026-11-15', description: 'Generator repair', amount: 400, vat_amount: 20, category: 'equipment', project_id: A })).id;
    ok(await call('POST', 'payments', { kind: 'out', date: '2026-11-18', amount: 420, method: 'bank', bill_id: ub }));
    // an asset owned before the system (opening), depreciated monthly
    ok(await call('POST', 'fixed_assets', { name: 'Pickup', purchase_date: '2026-11-01', cost: 12000, salvage: 0, life_years: 1, opening: 1 }));

    // ---- Zoho: one account per Trigon code (per partner for 3000 / 2500 / 3110), so every Zoho line maps back to one Trigon code
    ok(await call('POST', 'zoho/connect', { code: '1000.code.one' }));
    ok(await call('PUT', 'zoho/config', { enabled: '1', start: '2026-11-01', start_v2: '2026-11-01', post: '0' }));
    const Zof = {}, add = (code, type, bank) => { const id = 'Z' + code.replace(/\D/g, '') + (code.includes(':p') ? 'P' : ''); (bank ? zoho.T.bankaccounts : zoho.T.chartofaccounts).push({ account_id: id, account_name: 'Trigon ' + code, account_type: type, is_active: true }); Zof[id] = code.split(':')[0]; return id; };
    const MAP = { 1000: ['bank', 1], 1010: ['cash', 1], 1020: ['cash', 1], 1030: ['cash', 1], 1300: ['other_current_asset'], 1150: ['other_current_asset'], 1600: ['fixed_asset'], 1690: ['fixed_asset'], 2200: ['other_current_liability'], 2250: ['other_current_liability'], 2260: ['other_current_liability'],
      2300: ['other_liability'], 3100: ['equity'], 3900: ['equity'], 5200: ['expense'], 6200: ['expense'], 5260: ['expense'], 6100: ['expense'], 6150: ['expense'] };
    for (const [code, [type, bank]] of Object.entries(MAP)) ok(await call('PUT', 'zoho/mapping', { kind: 'account', local_key: 'acct:' + code, zoho_id: add(code, type, bank) }));
    for (const p of [PA, PB]) for (const [code, type] of [['3000', 'equity'], ['2500', 'other_liability'], ['3110', 'equity']]) {
      const id = 'Z' + code + 'P' + p; zoho.T.chartofaccounts.push({ account_id: id, account_name: `Trigon ${code} partner ${p}`, account_type: type }); Zof[id] = code;
      ok(await call('PUT', 'zoho/mapping', { kind: 'account', local_key: `acct:${code}:p${p}`, zoho_id: id }));
    }
    for (const [cat, code] of [['materials', '5100'], ['equipment', '5400'], ['other', '5700'], ['overhead', '6000']]) { const id = add(code, 'expense'); ok(await call('PUT', 'zoho/mapping', { kind: 'account', local_key: 'cat:' + cat, zoho_id: id })); }

    // ---- preflight first: read-only, and every account the new types use is mapped
    const callsBefore = zoho.calls.length, pre = ok(await call('POST', 'zoho/dry-run', RANGE));
    assert.deepEqual(zoho.calls.slice(callsBefore).filter(c => !/^GET /.test(c)), [], 'the preflight wrote nothing');
    assert.deepEqual(pre.preflight.missing_accounts, [], 'every account mapped'); assert.equal(pre.failed, 0, JSON.stringify(pre.errors));
    for (const k of ['jv_petty', 'jv_reimb', 'jv_partner', 'jv_dep', 'jv_asset', 'jv_paypaid_d']) assert.ok(pre.preflight.plan[k] && pre.preflight.plan[k].create >= 1, `${k} planned`);
    assert.ok(pre.preflight.accounts.some(a => a.code === '3110:p' + PA && a.how === 'mapped'), 'each partner on his own account');
    out.push(`preflight: ${Object.keys(pre.preflight.plan).length} types planned, nothing written, no account missing`);

    // ---- send
    const r = ok(await call('POST', 'zoho/sync', RANGE)); assert.equal(r.failed, 0, r.message);
    // the documents chosen: an expense paid through the partner's account, through 1010, through 1030 and through 2260; a vendor
    // payment through the partner's account and through 2260; the unpaid expense as a sundry-supplier bill + vendor payment by bank
    const exp = d => zoho.T.expenses.find(x => (x.description || '').startsWith(d));
    assert.equal(exp('Site fuel').paid_through_account_id, 'Z3110P' + PA); assert.equal(exp('Office water').paid_through_account_id, 'Z1010');
    assert.equal(exp('Nails').paid_through_account_id, 'Z1030'); assert.equal(exp('Taxi').paid_through_account_id, 'Z2260');
    const vp = n => zoho.T.vendorpayments.find(x => (x.bills || []).some(l => zoho.T.bills.find(b => b.bill_id === l.bill_id && b.bill_number === n)));
    assert.equal(vp('BF-1').paid_through_account_id, 'Z3110P' + PB, 'supplier bill paid by a partner'); assert.equal(vp('BF-2').paid_through_account_id, 'Z2260', 'supplier bill paid by an employee');
    const sundry = zoho.T.contacts.find(c => c.contact_name === 'Sundry suppliers (Trigon ERP)'); assert.ok(sundry);
    const gb = zoho.T.bills.find(b => b.vendor_id === sundry.contact_id); assert.ok(gb && gb.date === '2026-11-15'); assert.equal(vp(gb.bill_number).paid_through_account_id, 'Z1000');
    assert.equal(zoho.T.journals.filter(j => /^PAY-2026-11-2026-12-02$/.test(j.reference_number)).length, 1, 'salaries paid: one journal per payment date');
    out.push(`sent: ${r.sent} — expenses and vendor payments through the account that paid, partner / custody / claims / asset journals`);

    // ---- the rule: Zoho's accounting effect = Trigon's, account by account
    const zoho2t = id => Zof[id] || (id === '2001' ? '1000' : id === '2002' ? '1020' : id === '3201' ? '1100' : id === '3202' ? '1150' : '?' + id);
    const Zb = {}, post = (code, dr, cr) => { Zb[code] = Math.round(((Zb[code] || 0) + dr - cr) * 100) / 100; };
    const vat = l => { const t = zoho.T.taxes.find(x => x.tax_id === l.tax_id); return t ? Math.round(l.quantity * l.rate * t.tax_percentage) / 100 : 0; };
    for (const i of zoho.T.invoices.filter(i => i.status !== 'void')) for (const l of i.line_items) { const v = vat(l); post('1100', l.quantity * l.rate + v, 0); post('4000', 0, l.quantity * l.rate); post('2100', 0, v); }
    for (const b of zoho.T.bills) for (const l of b.line_items) { const v = vat(l); post(zoho2t(l.account_id), l.quantity * l.rate, 0); post('1200', v, 0); post('2000', 0, l.quantity * l.rate + v); }
    for (const x of zoho.T.expenses) { const v = vat({ quantity: 1, rate: x.amount, tax_id: x.tax_id }); post(zoho2t(x.account_id), x.amount, 0); post('1200', v, 0); post(zoho2t(x.paid_through_account_id), 0, x.amount + v); }
    for (const p of zoho.T.vendorpayments) { post('2000', p.amount, 0); post(zoho2t(p.paid_through_account_id), 0, p.amount); }
    for (const p of zoho.T.customerpayments) { post(zoho2t(p.account_id), p.amount, 0); post('1100', 0, p.amount); }
    for (const j of zoho.T.journals) for (const l of j.line_items) post(zoho2t(l.account_id), l.debit_or_credit === 'debit' ? l.amount : 0, l.debit_or_credit === 'credit' ? l.amount : 0);
    const f = ctx.financials('2000-01-01', '2099-12-31'), Tb = Object.fromEntries(f.trial_balance.map(a => [a.code, Math.round((a.debit - a.credit) * 100) / 100]));
    const codes = [...new Set([...Object.keys(Tb), ...Object.keys(Zb)])].sort(), diff = codes.filter(c => Math.abs((Tb[c] || 0) - (Zb[c] || 0)) > 0.005);
    assert.deepEqual(diff.map(c => `${c}: Trigon ${Tb[c] || 0} / Zoho ${Zb[c] || 0}`), [], 'every account: Zoho = Trigon');
    const touched = ['1010', '1030', '2260', '3000', '2500', '3110', '1600', '1690', '6100', '3100', '2200'];
    assert.deepEqual(touched.filter(c => !(c in Zb)), [], 'the new types reached Zoho (some net to zero: claims reimbursed, salaries paid)');
    assert.ok(Math.abs(Zb['2000'] || 0) < 0.005, 'nothing left in accounts payable: every bill paid');
    out.push(`Zoho = Trigon on all ${codes.length} accounts (trial balance ${f.tb_debit})`);
    // and per partner: each partner's Zoho accounts = his statement
    for (const p of [PA, PB]) {
      const st = ok(await call('GET', `partners/${p}/statement?to=2026-12-31`)), z = code => -zoho.T.journals.concat([]).flatMap(j => j.line_items).filter(l => l.account_id === `Z${code}P${p}`).reduce((s, l) => s + (l.debit_or_credit === 'debit' ? l.amount : -l.amount), 0)
        + zoho.T.expenses.filter(x => x.paid_through_account_id === `Z${code}P${p}`).reduce((s, x) => s + x.amount * 1.05, 0) + zoho.T.vendorpayments.filter(x => x.paid_through_account_id === `Z${code}P${p}`).reduce((s, x) => s + x.amount, 0);
      for (const [code, k] of [['3000', 'capital'], ['2500', 'loan'], ['3110', 'current']]) assert.ok(Math.abs(z(code) - st.sections[k].closing) < 0.01, `partner ${p} ${code}: Zoho ${z(code)} / statement ${st.sections[k].closing}`);
    }
    out.push('each partner: his Zoho accounts = his statement');

    // ---- nothing twice: a second send writes nothing
    const wr = zoho.calls.filter(c => !/^GET /.test(c)).length; ok(await call('POST', 'zoho/sync', RANGE));
    assert.equal(zoho.calls.filter(c => !/^GET /.test(c)).length, wr, 'a second send writes nothing');
    out.push('second send: nothing written');

    console.log(out.map(x => '  ✔ ' + x).join('\n'));
    console.log('ZOHO NEW TYPES TESTS PASSED');
  } finally { server.close(); zoho.srv.close(); }
});
