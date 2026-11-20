// Zoho gate while VAT registration is pending: READY_NON_VAT / VAT_PENDING, transactions with VAT held, 6150 deferred (asset
// disposals held), and the read-only diagnostic of who already owns an existing Zoho account — all against the Zoho mock.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-zohogate-'));
process.env.ZOHO_NO_SCHEDULER = '1'; process.env.SALES_NO_SCHEDULER = '1';
const mockZoho = require('./tools/zoho-mock.js');
const zoho = mockZoho();
process.env.ZOHO_CLIENT_ID = zoho.CLIENT_ID; process.env.ZOHO_CLIENT_SECRET = zoho.CLIENT_SECRET;
const { server, ctx } = require('./server.js');
ctx.zohoReconPace = 0;

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api/`; let cookie = '';
  const call = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j, t }; };
  const ok = (r, l) => { assert.equal(r.s, 200, `${l || ''} → ${r.s} ${JSON.stringify(r.j).slice(0, 400)}`); return r.j; };
  const T = zoho.T, acct = id => T.chartofaccounts.concat(T.bankaccounts).find(a => a.account_id === id), A = ctx.zohoAcct, out = [];
  const row = (kind, id) => ctx.db.prepare('SELECT * FROM zoho_sync WHERE kind=? AND local_id=?').get(kind, id);
  await new Promise(r => zoho.srv.listen(0, r)); process.env.ZOHO_ACCOUNTS_URL = zoho.accountsUrl;
  try {
    // ---- Trigon: an invoice with VAT and one without, a bill with VAT and one without, partners, petty cash, an asset sold
    ok(await call('POST', 'setup', { username: 'admin', password: 'secret12', company: 'Trigon' }));
    ok(await call('PUT', 'settings', { trn: '100123456700003' }));
    const cl = ok(await call('POST', 'parties', { type: 'client', name: 'Client Test', trn: '100000000000003' })).id, sup = ok(await call('POST', 'parties', { type: 'supplier', name: 'Supplier Test', trn: '100000000000011' })).id;
    const P = ok(await call('POST', 'projects', { name: 'Site A', client_id: cl, status: 'active' })).id;
    const vInv = ok(await call('POST', 'invoices', { project_id: P, date: '2026-11-05', items: [{ description: 'Works', qty: 10, rate: 100 }] })).id;
    const zInv = ok(await call('POST', 'invoices', { project_id: P, date: '2026-11-06', items: [{ description: 'Exported service', qty: 1, rate: 500, vat: 'zero' }] })).id;
    ok(await call('POST', 'payments', { kind: 'in', date: '2026-11-10', amount: 1050, method: 'bank', invoice_id: vInv }));
    const vBill = ok(await call('POST', 'bills', { party_id: sup, date: '2026-11-04', amount: 1000, vat_amount: 50, category: 'materials', project_id: P, reference: 'S-1' })).id;
    const nBill = ok(await call('POST', 'bills', { party_id: sup, date: '2026-11-04', amount: 300, vat_amount: 0, category: 'materials', project_id: P, reference: 'S-2' })).id;
    const PA = ok(await call('POST', 'partners', { name: 'Partner Alpha' })).id;
    ok(await call('POST', `partners/${PA}/shares`, { pct: 100, from_date: '2026-01-01' }));
    ok(await call('POST', 'partner_txns', { partner_id: PA, date: '2026-11-02', type: 'capital_in', amount: 50000, method: 'bank' }));
    ok(await call('POST', 'fixed_assets', { name: 'Old mixer', purchase_date: '2026-10-01', cost: 6000, salvage: 0, life_years: 1, opening: 1, status: 'disposed', disposal_date: '2026-10-20', disposal_proceeds: 7000 }));
    const zinv = ctx.enrich().invoices.find(i => i.id === zInv); assert.ok(Math.abs(zinv.vat) < 0.005, 'the zero-rated invoice carries no VAT');

    // ---- Zoho: VAT not set up (registration pending) — no taxes, no VAT accounts; Petty Cash is a system cash account
    T.taxes.length = 0;
    for (const a of T.chartofaccounts) if (a.account_id === '3201') a.is_system_account = true;
    const coded = { 3102: '2200', 3104: '2250', 3106: '2300', 3101: '5200', 3105: '5260', 3202: '1150', 3103: '1300' };
    for (const a of T.chartofaccounts) if (coded[a.account_id]) a.account_code = coded[a.account_id];
    T.bankaccounts.find(a => a.account_id === '2001').account_code = '1000';
    T.bankaccounts.find(a => a.account_id === '2002').is_system_account = true;            // "Petty Cash", system, cash, no code
    T.chartofaccounts.push({ account_id: '3301', account_name: 'Accounts Payable', account_type: 'accounts_payable', is_active: true, is_system_account: true },
      { account_id: '3501', account_name: 'Retained Earnings', account_type: 'equity', is_active: true, is_system_account: true },
      { account_id: '3801', account_name: 'Office Salaries', account_code: '6200', account_type: 'expense', is_active: true });
    for (const code of [...new Set(Object.keys(ctx.zohoX.CAT).map(c => ctx.expenseCode(c)))].filter(c => !['1600', '5200', '6200'].includes(c))) T.chartofaccounts.push({ account_id: 'C-' + code, account_name: 'Cost ' + code, account_code: code, account_type: 'expense', is_active: true });
    ok(await call('POST', 'zoho/connect', { code: '1000.code.one' }));
    ok(await call('PUT', 'zoho/config', { enabled: '1', start: '2026-10-01', start_v2: '2026-10-01', post: '1' }));
    // as in production: cash on hand (1020) was mapped to Zoho's "Petty Cash" on the mapping screen, before provisioning existed
    ok(await call('PUT', 'zoho/mapping', { kind: 'account', local_key: 'acct:1020', zoho_id: '2002', label: 'Petty Cash (cash)' }));
    ok(await call('PUT', 'zoho/mapping', { kind: 'account', local_key: 'acct:4000', zoho_id: '3004' }));
    const map1020 = JSON.stringify(ctx.db.prepare("SELECT * FROM zoho_map WHERE local_key='acct:1020'").get());

    // ---- 1. who owns Zoho's Petty Cash: read only, the mapping is not touched
    let n0 = zoho.calls.length; ok(await call('POST', 'zoho-sync/preflight'));
    let pv = ok(await call('GET', 'zoho-sync/preview')); assert.deepEqual(zoho.calls.slice(n0).filter(c => !/^GET /.test(c)), []);
    const pc = pv.rows.find(r => r.key === 'acct:1010');
    assert.equal(pc.classification, 'ACCOUNT_CONFLICT'); assert.equal(pc.name_match.checks.not_used_by_another_trigon_account, false);
    assert.equal(pc.name_match.is_system_account, true); assert.equal(pc.name_match.account_type, 'cash'); assert.equal(pc.name_match.involved_in_transaction, false);
    const own = pc.name_match.owned_by; assert.equal(own.length, 1);
    assert.equal(own[0].trigon_code, '1020'); assert.equal(own[0].trigon_key, 'acct:1020'); assert.equal(own[0].mapping_source, 'mapping screen (before provisioning) — legacy mapping');
    assert.equal(own[0].zoho_id, '2002'); assert.equal(own[0].zoho_name, 'Petty Cash'); assert.equal(own[0].zoho_type, 'cash'); assert.match(own[0].legacy_audit[0], /admin: account acct:1020 → 2002/); assert.ok(own[0].mapped_at);
    assert.equal(JSON.stringify(ctx.db.prepare("SELECT * FROM zoho_map WHERE local_key='acct:1020'").get()), map1020, 'the owning mapping is not modified');
    out.push('Petty Cash already owned by 1020 (legacy mapping-screen mapping, with its audit trail): shown read only, conflict, mapping untouched');

    // ---- 2. VAT pending and 6150 deferred, in the preview
    assert.equal(pv.vat_state, 'VAT_PENDING'); assert.match(pv.vat_diagnostic.uae_vat_enabled, /^no/); assert.equal(pv.vat_diagnostic.standard_5_active, null);
    assert.deepEqual(pv.vat.map(v => v.classification), ['VAT_CONFIGURATION_REQUIRED', 'VAT_CONFIGURATION_REQUIRED', 'VAT_CONFIGURATION_REQUIRED']);
    const r6150 = pv.rows.find(r => r.key === 'acct:6150'); assert.equal(r6150.reason, 'DEFERRED_ACCOUNTING_CHANGE'); assert.ok(!pv.mutations.some(m => m.body.account_code === '6150'));
    assert.deepEqual(pv.deferred.map(d => d.code), ['6150']); assert.match(pv.decisions[2].treatment, /Gain on Asset Disposal → Other Income; Loss on Asset Disposal → Other Expense/);
    assert.ok(pv.targets.blocking_conflicts >= 4, 'full targets: VAT and the 1010 conflict');
    out.push('preview: VAT_PENDING (3 × VAT_CONFIGURATION_REQUIRED, diagnostic "no"), 6150 deferred — never created, not counted');

    // ---- 3. a non-VAT conflict keeps the gate closed; resolved by code (an "Office Float" coded 1010) → READY_NON_VAT
    let g = await A.preflightAndGate('test', 'test'); assert.equal(g.gate.state, 'NOT_READY');
    T.bankaccounts.push({ account_id: '2004', account_name: 'Office Float', account_code: '1010', account_type: 'cash', is_active: true });
    pv = ok(await call('GET', 'zoho-sync/preview')); assert.equal(pv.rows.find(r => r.key === 'acct:1010').classification, 'ADOPT_EXISTING');
    const prov = ok(await call('POST', 'zoho-sync/provision', { confirm: true, token: pv.token }));
    assert.equal(prov.gate.state, 'READY_NON_VAT', JSON.stringify(prov.gate.reasons)); assert.equal(prov.gate.vat, 'VAT_PENDING'); assert.equal(ctx.zohoX.cfg().gate, 'READY_NON_VAT');
    assert.deepEqual(prov.gate.targets_non_vat, { missing_mappings: 0, wrong_types: 0, ambiguous_matches: 0, blocking_conflicts: 0 });
    assert.ok(prov.gate.targets.blocking_conflicts > 0, 'the full gate stays closed'); assert.equal(prov.gate.ready, false); assert.match(prov.gate.reasons[0], /^VAT_PENDING/);
    assert.equal(JSON.stringify(ctx.db.prepare("SELECT * FROM zoho_map WHERE local_key='acct:1020'").get()), map1020);
    out.push('gate: NOT_READY with a non-VAT conflict; after the fix READY_NON_VAT (non-VAT targets 0 / 0 / 0 / 0), VAT_PENDING, full gate still closed');

    // ---- 4. a send now: non-VAT records go; everything with VAT is held (no Zoho call for it); the disposal is held
    const r1 = ok(await call('POST', 'zoho/sync', {}));
    assert.equal(row('invoice', vInv).status, 'held'); assert.match(row('invoice', vInv).error, /^VAT_PENDING/); assert.equal(row('invoice', vInv).zoho_id, null);
    assert.equal(row('bill', vBill).status, 'held'); assert.match(row('bill', vBill).error, /^VAT_PENDING/);
    const pay = ctx.db.prepare("SELECT * FROM zoho_sync WHERE kind='payment'").get(); assert.equal(pay.status, 'held');
    assert.equal(row('invoice', zInv).status, 'ok', 'the zero-rated invoice is sent'); assert.equal(row('bill', nBill).status, 'ok', 'the bill without VAT is sent');
    assert.equal(T.invoices.length, 1); assert.ok(T.invoices.every(i => i.invoice_number !== ctx.enrich().invoices.find(x => x.id === vInv).number));
    assert.ok(T.bills.every(b => b.bill_number !== 'S-1'), 'the VAT bill never reached Zoho');
    const disp = ctx.db.prepare("SELECT * FROM zoho_sync WHERE kind='jv_asset' AND error LIKE 'ACCOUNTING_CHANGE_PENDING%'").get(); assert.ok(disp && disp.status === 'held', 'the disposal (6150) is held');
    assert.ok(ctx.db.prepare("SELECT COUNT(*) n FROM zoho_sync WHERE kind='jv_partner' AND status='ok'").get().n >= 1, 'partner journals sent');
    assert.ok(!T.journals.some(j => j.line_items.some(l => ['3401', '3402'].includes(l.account_id))));
    const st = ok(await call('GET', 'zoho-sync')); assert.equal(st.gate, 'READY_NON_VAT'); assert.equal(st.vat, 'VAT_PENDING'); assert.equal(st.continuous, false, 'continuous sync stays off'); assert.ok(st.queue.held >= 4);
    // held records are re-checked each run without any Zoho write
    const w = zoho.calls.filter(c => !/^GET /.test(c)).length; ok(await call('POST', 'zoho/sync', {})); assert.equal(zoho.calls.filter(c => !/^GET /.test(c)).length, w);
    out.push(`send with READY_NON_VAT: ${r1.sent} non-VAT record(s) sent; VAT invoice, VAT bill and its payment held (VAT_PENDING); the disposal held (ACCOUNTING_CHANGE_PENDING); continuous off`);

    // ---- 5. reconciliation shows the held records as BLOCKED with their reason
    const rc = await A.reconcile({ cutoff: ctx.today() });
    assert.equal(rc.items.find(x => x.kind === 'invoice' && x.local_id === vInv).status, 'BLOCKED'); assert.match(rc.items.find(x => x.kind === 'invoice' && x.local_id === vInv).note, /VAT_PENDING/);
    out.push('reconciliation: held records reported as BLOCKED (VAT_PENDING / ACCOUNTING_CHANGE_PENDING)');

    // ---- a non-VAT blocker still closes the non-VAT gate (a document already in Zoho under the same number: possible duplicate)
    const z2 = ok(await call('POST', 'invoices', { project_id: P, date: '2026-11-12', items: [{ description: 'Export 2', qty: 1, rate: 200, vat: 'zero' }] })).id;
    const num2 = ctx.enrich().invoices.find(i => i.id === z2).number;
    T.invoices.push({ invoice_id: '9990555', invoice_number: num2, customer_id: 'x', date: '2026-11-12', status: 'sent', line_items: [], total: 200, balance: 200 });
    g = await A.preflightAndGate('test', 'duplicate'); assert.equal(g.gate.state, 'NOT_READY'); assert.ok(g.gate.targets_non_vat.blocking_conflicts > 0); assert.ok(g.gate.reasons.some(x => /possible duplicate/.test(x)));
    T.invoices.pop(); g = await A.preflightAndGate('test', 'resolved'); assert.equal(g.gate.state, 'READY_NON_VAT', JSON.stringify(g.gate.reasons));
    out.push('a non-VAT blocker (possible duplicate) closes the non-VAT gate; once resolved it is READY_NON_VAT again');

    // ---- 6. once VAT is configured in Zoho (by its people) and adopted: READY; the VAT records go; 6150 stays held
    T.taxes.push({ tax_id: '1001', tax_name: 'Standard Rate', tax_percentage: 5, tax_type: 'tax' }, { tax_id: '1002', tax_name: 'Zero Rate', tax_percentage: 0, tax_type: 'tax' });
    T.chartofaccounts.push({ account_id: '3401', account_name: 'Input VAT', account_type: 'input_tax', is_active: true, is_system_account: true }, { account_id: '3402', account_name: 'Output VAT', account_type: 'output_tax', is_active: true, is_system_account: true });
    ok(await call('POST', 'zoho-sync/preflight')); pv = ok(await call('GET', 'zoho-sync/preview')); assert.equal(pv.vat_state, 'VAT_TO_ADOPT');
    const prov2 = ok(await call('POST', 'zoho-sync/provision', { confirm: true, token: pv.token })); assert.equal(prov2.gate.state, 'READY', JSON.stringify(prov2.gate.reasons)); assert.equal(prov2.gate.vat, 'VAT_READY');
    ok(await call('POST', 'zoho/sync', {}));
    assert.equal(row('invoice', vInv).status, 'ok'); assert.equal(row('bill', vBill).status, 'ok'); assert.equal(ctx.db.prepare("SELECT status FROM zoho_sync WHERE kind='payment'").get().status, 'ok');
    assert.equal(ctx.db.prepare('SELECT status FROM zoho_sync WHERE id=?').get(disp.id).status, 'held', '6150 still deferred');
    out.push('VAT configured in Zoho and adopted: gate READY, the held VAT records are sent; the disposal stays held until the 6150 accounting change');

    console.log(out.map(x => '  ✔ ' + x).join('\n'));
    console.log('ZOHO GATE (VAT PENDING) TESTS PASSED');
  } finally { server.close(); zoho.srv.close(); }
});
