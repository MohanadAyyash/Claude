// Zoho accounting sync: automatic account provisioning (allowlist, partners, VAT, conflicts), the READY gate, continuous sending
// with retry, exactly-once, closed periods, Zoho-side edits, reconciliation and Trial Balance against Trial Balance — all against
// the Zoho mock (nothing real is touched): node --no-warnings test-zohoacct.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-zohoacct-'));
process.env.ZOHO_NO_SCHEDULER = '1'; process.env.SALES_NO_SCHEDULER = '1';
const mockZoho = require('./tools/zoho-mock.js');
const zoho = mockZoho();
process.env.ZOHO_CLIENT_ID = zoho.CLIENT_ID; process.env.ZOHO_CLIENT_SECRET = zoho.CLIENT_SECRET;
const { server, ctx } = require('./server.js');
ctx.zohoReconPace = 0;                                                                   // no pacing against the mock
// this suite runs the whole flow including asset disposals, as after the planned gain / loss accounting change (6150 adopted by code);
// 6150 deferred (today's decision), VAT pending and READY_NON_VAT are tested in test-zohogate.js
delete ctx.zohoX.DEFERRED['6150'];

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api/`; let cookie = '';
  const call = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j, t }; };
  const ok = (r, l) => { assert.equal(r.s, 200, `${l || ''} → ${r.s} ${JSON.stringify(r.j).slice(0, 400)}`); return r.j; };
  const writesSince = n => zoho.calls.slice(n).filter(c => !/^GET /.test(c));
  const T = zoho.T, coa = () => T.chartofaccounts.concat(T.bankaccounts), acct = id => coa().find(a => a.account_id === id);
  const map = key => ctx.db.prepare("SELECT * FROM zoho_map WHERE kind='account' AND local_key=?").get(key);
  const row = (kind, id) => ctx.db.prepare('SELECT * FROM zoho_sync WHERE kind=? AND local_id=?').get(kind, id);
  const A = ctx.zohoAcct, out = [], TODAY = ctx.today();
  // every transaction is dated on or before 2026-11-19: the continuous sync sends what is dated up to today
  await new Promise(r => zoho.srv.listen(0, r)); process.env.ZOHO_ACCOUNTS_URL = zoho.accountsUrl;
  try {
    // ---- Trigon: a company with an invoice and its receipt, partners, petty cash, custody, claims, a bill, an asset
    ok(await call('POST', 'setup', { username: 'admin', password: 'secret12', company: 'Trigon' }));
    ok(await call('PUT', 'settings', { trn: '100123456700003' }));
    const WPS = { person_code: '12345678901234', routing_code: '302620122', iban: 'AE070331234567890123456' };
    const cl = ok(await call('POST', 'parties', { type: 'client', name: 'Client Test', trn: '100000000000003' })).id, sup = ok(await call('POST', 'parties', { type: 'supplier', name: 'Block Factory', trn: '100000000000011' })).id;
    const P = ok(await call('POST', 'projects', { name: 'Villa 12', client_id: cl, retention_pct: 10, status: 'active' })).id;
    const inv = ok(await call('POST', 'invoices', { project_id: P, date: '2026-11-05', retention_pct: 10, items: [{ description: 'Excavation', qty: 100, rate: 50 }] })).id;
    ok(await call('POST', 'payments', { kind: 'in', date: '2026-11-20', amount: 2000, method: 'bank', invoice_id: inv }));
    const PA = ok(await call('POST', 'partners', { name: 'Partner Alpha' })).id, PB = ok(await call('POST', 'partners', { name: 'Partner Beta' })).id;
    for (const [p, pct] of [[PA, 60], [PB, 40]]) ok(await call('POST', `partners/${p}/shares`, { pct, from_date: '2026-01-01' }));
    ok(await call('POST', 'partner_txns', { partner_id: PA, date: '2026-11-02', type: 'capital_in', amount: 100000, method: 'bank' }));
    ok(await call('POST', 'partner_txns', { partner_id: PB, date: '2026-11-02', type: 'loan_in', amount: 20000, method: 'bank' }));
    ok(await call('POST', 'partner_txns', { partner_id: PB, date: '2026-11-03', type: 'deposit', amount: 3000, method: 'cash' }));
    const sb = ok(await call('POST', 'bills', { party_id: sup, date: '2026-11-04', amount: 1000, vat_amount: 50, category: 'materials', project_id: P, reference: 'BF-1' })).id;
    ok(await call('POST', 'payments', { kind: 'out', date: '2026-11-06', amount: 1050, method: 'bank', bill_id: sb }));
    ok(await call('POST', 'petty_topups', { date: '2026-11-03', amount: 2000, note: 'office float' }));
    ok(await call('POST', 'petty_topups/expense', { date: '2026-11-07', description: 'Office water', amount: 100, vat_amount: 5 }));
    const E = ok(await call('POST', 'employees', { name: 'Site Foreman', join_date: '2025-01-01', basic: 2500, project_id: P, ...WPS })).id;
    ok(await call('POST', 'petty_custody/handover', { employee_id: E, date: '2026-11-08', amount: 1000, method: 'cash' }));
    const cc = ok(await call('POST', 'expense_claims', { employee_id: E, date: '2026-11-09', description: 'Nails', amount: 300, vat_amount: 15, project_id: P, paid_from: 'custody' })).id;
    ok(await call('POST', `expense_claims/${cc}/decide`, { status: 'approved' }));
    const c1 = ok(await call('POST', 'expense_claims', { employee_id: E, date: '2026-11-10', description: 'Taxi', amount: 150, vat_amount: 7.5, project_id: P })).id;
    ok(await call('POST', `expense_claims/${c1}/decide`, { status: 'approved' }));
    ok(await call('POST', 'expense_claims/reimburse', { employee_id: E, date: '2026-11-14', amount: 157.5, method: 'bank' }));
    ok(await call('POST', 'fixed_assets', { name: 'Compressor', purchase_date: '2026-10-01', cost: 6000, salvage: 0, life_years: 1, opening: 1, status: 'disposed', disposal_date: '2026-10-20', disposal_proceeds: 7000 }));   // sold at a gain
    ok(await call('POST', 'fixed_assets', { name: 'Generator', purchase_date: '2026-10-01', cost: 6000, salvage: 0, life_years: 1, opening: 1, status: 'disposed', disposal_date: '2026-10-20', disposal_proceeds: 1000 }));  // sold at a loss
    ok(await call('POST', 'fixed_assets', { name: 'Pickup', purchase_date: '2026-10-01', cost: 12000, salvage: 0, life_years: 1, opening: 1 }));   // depreciated at the end of October

    // ---- Zoho (mock): a UAE organisation with VAT set up, its system Retained Earnings, and some traps
    // the foundation as an organisation would have it: Zoho's system accounts, and the rest carrying Trigon's codes (adopted by exact code + type)
    for (const a of T.chartofaccounts) if (a.account_id === '3201') a.is_system_account = true;   // Accounts Receivable
    const coded = { 3102: '2200', 3104: '2250', 3106: '2300', 3101: '5200', 3105: '5260', 3202: '1150' };
    for (const a of T.chartofaccounts) if (coded[a.account_id]) a.account_code = coded[a.account_id];
    T.bankaccounts.find(a => a.account_id === '2001').account_code = '1000';
    T.chartofaccounts.push(
      { account_id: '3301', account_name: 'Accounts Payable', account_type: 'accounts_payable', is_active: true, is_system_account: true },
      { account_id: '3401', account_name: 'Input VAT', account_type: 'input_tax', is_active: true, is_system_account: true }, { account_id: '3402', account_name: 'Output VAT', account_type: 'output_tax', is_active: true, is_system_account: true },
      { account_id: '3501', account_name: 'Retained Earnings', account_type: 'equity', is_active: true, is_system_account: true },
      { account_id: '3601', account_name: 'Employee Cash Custody Account', account_type: 'expense', is_active: true },          // a SIMILAR name: never adopted
      { account_id: '3701', account_name: 'Misc Income', account_code: '6150', account_type: 'income', is_active: true },        // Trigon's code with the WRONG type
      { account_id: '3801', account_name: 'Office Salaries', account_code: '6200', account_type: 'expense', is_active: true });
    T.bankaccounts.push({ account_id: '2003', account_name: 'Cash on Hand', account_code: '1020', account_type: 'cash', is_active: true });               // 2002 "Petty Cash": the SAME name as 1010
    ok(await call('POST', 'zoho/connect', { code: '1000.code.one' }));
    ok(await call('PUT', 'zoho/config', { enabled: '1', start: '2026-10-01', start_v2: '2026-10-01', post: '1' }));
    // the accounts outside the automatic list are mapped once, as on the office PC
    ok(await call('PUT', 'zoho/mapping', { kind: 'account', local_key: 'acct:4000', zoho_id: '3004' }));   // revenue (two income accounts in this Zoho): for the reconciliation
    // one Zoho expense account per Trigon category code ("asset" is 1600, created by the provisioning) — 1300 (3103) deliberately has no code yet
    const catCodes = [...new Set(Object.keys(ctx.zohoX.CAT).map(c => ctx.expenseCode(c)))].filter(c => c !== '1600' && !Object.values(coded).includes(c) && c !== '6200');
    for (const code of catCodes) T.chartofaccounts.push({ account_id: 'C-' + code, account_name: 'Cost ' + code, account_code: code, account_type: 'expense', is_active: true });
    // history: the 5 November invoice (and its retention journal) was sent by the earlier version, before this workflow existed
    ctx.db.prepare("UPDATE zoho_config SET value='0' WHERE key='gate_required'").run();
    const hist = ok(await call('POST', 'zoho/sync', { from: '2026-11-05', to: '2026-11-05' })); assert.equal(hist.failed, 0, hist.message);
    ctx.db.prepare("UPDATE zoho_config SET value='1' WHERE key='gate_required'").run();
    ctx.db.prepare("UPDATE zoho_sync SET sent_eff=NULL, doc_date=NULL, verified_at=NULL").run();   // rows written by the earlier version have none of these
    const histRows = ctx.db.prepare("SELECT kind, local_id, zoho_id, hash, synced_at, sent_eff FROM zoho_sync WHERE kind IN ('invoice','jv_retention') ORDER BY kind").all();
    assert.equal(histRows.length, 2); assert.ok(histRows.every(x => x.zoho_id && !x.sent_eff), 'sent by the earlier version');
    const mapBefore = ctx.db.prepare("SELECT kind, local_key, zoho_id, label FROM zoho_map ORDER BY kind, local_key").all();

    // ---- 1. no transaction leaves Trigon before the gate is READY
    let r = await call('POST', 'zoho/sync', {}); assert.equal(r.s, 400); assert.match(r.j.error, /^GATE:/);
    ok(await call('PUT', 'zoho-sync/settings', { continuous: '1' }));
    const objs = () => T.journals.length + T.invoices.length + T.bills.length + T.expenses.length + T.customerpayments.length + T.vendorpayments.length, o0 = objs();
    assert.equal((await A.tick({ force: true })).skipped, 'gate'); assert.equal(objs(), o0, 'nothing sent');
    r = await call('POST', 'zoho-sync/provision', { confirm: true, token: 'x' }); assert.equal(r.s, 400); assert.match(r.j.error, /preflight first/);
    out.push('no sync, no continuous run and no provisioning before the read-only preflight');

    // ---- 2. preflight + preview: read only
    let n0 = zoho.calls.length;
    const pf = ok(await call('POST', 'zoho-sync/preflight'));
    assert.equal(pf.verdict, 'READY WITH MISSING MAPPINGS'); assert.equal(pf.gate.ready, false);
    let pv = ok(await call('GET', 'zoho-sync/preview'));
    assert.deepEqual(writesSince(n0), [], 'preflight and preview: GET only');
    const byKey = k => pv.rows.find(x => x.key === k);
    // same name as an existing, active, compatible, uncoded Zoho cash account: proposed for explicit confirmation — never adopted by name alone
    const pc = byKey('acct:1010'); assert.equal(pc.classification, 'ADOPT_EXISTING_AFTER_CONFIRMATION'); assert.equal(pc.reason, 'NAME_IN_USE');
    assert.deepEqual(pc.name_match, { checks: { unique_name: true, active: true, compatible_type: true, no_other_code: true, not_used_by_another_trigon_account: true },
      account_id: '2002', account_name: 'Petty Cash', account_code: '', account_type: 'cash', parent_account: '(none)', is_system_account: false, active: true, involved_in_transaction: false, owned_by: [] });
    assert.ok(!pv.adopts.some(a => a.key === 'acct:1010') && !pv.mutations.some(m => m.body.account_code === '1010'), 'neither adopted nor created without confirmation');
    assert.deepEqual(pv.confirmable, [{ key: 'acct:1010', zoho_id: '2002' }]);
    // an exact name that is NOT safe (incompatible type) stays a conflict
    T.chartofaccounts.push({ account_id: '3995', account_name: 'Depreciation', account_type: 'income', is_active: true });
    const pu = (await A.plan()).rows.find(x => x.key === 'acct:6100'); assert.equal(pu.classification, 'ACCOUNT_CONFLICT'); assert.equal(pu.name_match.checks.compatible_type, false); T.chartofaccounts.pop();
    // VAT diagnostic and the three decisions
    const vd = pv.vat_diagnostic; assert.match(vd.uae_vat_enabled, /^yes/); assert.equal(vd.standard_5_active.tax_id, '1001'); assert.equal(vd.organization.tax_reg_no, '•••0003'); assert.equal(vd.organization.is_tax_registered, true);
    assert.deepEqual(vd.input_vat_control.map(a => [a.id, a.type, a.system]), [['3401', 'input_tax', true]]); assert.deepEqual(vd.output_vat_control.map(a => a.id), ['3402']);
    assert.deepEqual(pv.decisions.map(d => [d.code, d.classification]), [['3100', 'SYSTEM_ACCOUNT_ADOPT'], ['1690', 'CREATE_APPROVED'], ['6150', 'ACCOUNT_CONFLICT']]);
    assert.match(pv.decisions[0].treatment, /id 3501/); assert.match(pv.decisions[1].treatment, /net book value/);
    assert.equal(byKey('acct:1030').action, 'create', 'a similar name is not adopted');
    assert.equal(byKey('acct:6150').action, 'conflict'); assert.equal(byKey('acct:6150').reason, 'WRONG_TYPE'); assert.equal(byKey('acct:6150').zoho.type, 'income');   // type mismatch: BLOCKED
    const SEVEN = ['ADOPT_EXISTING', 'ADOPT_EXISTING_AFTER_CONFIRMATION', 'CREATE_APPROVED', 'SYSTEM_ACCOUNT_ADOPT', 'VAT_CONFIGURATION_REQUIRED', 'ACCOUNT_CONFLICT', 'AMBIGUOUS', 'BLOCKED'];
    assert.ok([...pv.rows, ...pv.vat].every(r => SEVEN.includes(r.classification)), 'every required account has one of the seven classifications');
    for (const [k, id] of [['acct:3100', '3501'], ['acct:1100', '3201'], ['acct:2000', '3301']]) { assert.equal(byKey(k).classification, 'SYSTEM_ACCOUNT_ADOPT', k); assert.equal(byKey(k).zoho.id, id); }
    assert.ok(!pv.mutations.some(m => ['3100', '1100', '2000'].includes(m.body.account_code)), 'system accounts never created');
    for (const [k, id] of [['acct:2200', '3102'], ['acct:1000', '2001'], ['acct:1020', '2003'], ['acct:6200', '3801'], ['cat:materials', 'C-5100']]) { assert.equal(byKey(k).classification, 'ADOPT_EXISTING', k); assert.equal(byKey(k).zoho.id, id, k); }
    assert.equal(byKey('acct:1300').classification, 'BLOCKED'); assert.equal(byKey('acct:1300').reason, 'NO_ACCOUNT_WITH_CODE'); assert.ok(byKey('acct:1300').candidates.some(c => c.id === '3103'), 'candidate shown, not adopted');
    assert.equal(byKey('cat:asset').classification, 'ADOPT_EXISTING'); assert.equal(byKey('cat:asset').follows, 'acct:1600');
    assert.deepEqual(byKey('acct:1690').payload, { account_name: 'Accumulated Depreciation', account_code: '1690', account_type: 'fixed_asset', parent_account_id: '(the new "Fixed Assets")' });
    assert.ok(byKey('acct:1690').review && byKey('acct:6150').review && byKey('acct:3100').review);
    assert.ok(pv.rows.filter(r => r.classification === 'CREATE_APPROVED').every(r => r.payload && pv.mutations.some(m => m.key === r.key)), 'every CREATE_APPROVED shows its exact payload');
    for (const k of ['acct:1050', 'acct:1600', 'acct:1690', 'acct:2050', 'acct:2260', 'acct:2400', 'acct:3900', 'acct:6100', 'acct:3000', 'acct:2500', 'acct:3110', `acct:3000:p${PA}`, `acct:3110:p${PB}`]) assert.equal(byKey(k).action, 'create', k);
    assert.equal(pv.state, 'Conflict');
    // VAT: Zoho's tax accounts adopted, never created
    assert.deepEqual(pv.vat.map(v => [v.code, v.action, v.zoho && v.zoho.id]), [['1200', 'adopt', '3401'], ['2100', 'adopt', '3402']]);
    assert.ok(pv.mutations.every(m => m.method === 'POST' && m.path === '/chartofaccounts' && !/tax/.test(m.body.account_type) && !/vat/i.test(m.body.account_name)), 'no VAT account is ever created');
    assert.deepEqual(pv.mutations.map(m => m.body.account_code).slice(0, 4), ['1030', '1050', '1600', '2050']);
    assert.ok(pv.mutations.findIndex(m => m.body.account_code === '1690') > pv.mutations.findIndex(m => m.body.account_code === '1600'), '1690 after its parent 1600');
    const childMut = pv.mutations.find(m => m.body.account_code === `3000-P${PA}`); assert.equal(childMut.body.account_name, 'Partner Alpha - Capital'); assert.match(childMut.body.parent_account_id, /the new "Partner Capital"/);
    // 3100 is only ever Zoho's system Retained Earnings: a replacement coded 3100 is a conflict, a missing system account blocks, nothing is created
    const re = acct('3501');
    T.chartofaccounts.push({ account_id: '3999', account_name: 'Retained Earnings 2', account_code: '3100', account_type: 'equity', is_active: true });
    let pe = await A.plan(), r3 = pe.rows.find(x => x.key === 'acct:3100'); assert.equal(r3.classification, 'ACCOUNT_CONFLICT'); assert.equal(r3.reason, 'REPLACEMENT_EXISTS');
    T.chartofaccounts.pop(); re.is_system_account = false;
    pe = await A.plan(); r3 = pe.rows.find(x => x.key === 'acct:3100'); assert.equal(r3.classification, 'BLOCKED'); assert.equal(r3.reason, 'SYSTEM_ACCOUNT_NOT_FOUND'); assert.ok(!pe.mutations.some(m => m.body.account_code === '3100'));
    re.is_system_account = true;
    T.chartofaccounts.push({ account_id: '3996', account_name: 'Owner Equity', account_type: 'equity', is_active: true });
    ctx.db.prepare("INSERT INTO zoho_map(kind,local_key,zoho_id) VALUES('account','acct:3100','3996')").run();   // mapped to an equity account that is not the system one
    pe = await A.plan(); assert.equal(pe.rows.find(x => x.key === 'acct:3100').reason, 'NOT_SYSTEM_ACCOUNT');
    ctx.db.prepare("DELETE FROM zoho_map WHERE local_key='acct:3100'").run(); T.chartofaccounts.pop();
    // one account of the right type but without the code: shown as a candidate, never adopted by type alone
    acct('3202').is_active = false; pe = await A.plan(); const r13 = pe.rows.find(x => x.key === 'acct:1300');
    assert.equal(r13.classification, 'BLOCKED'); assert.deepEqual(r13.candidates.map(c => c.id), ['3103']); assert.ok(!pe.adopts.some(a => a.key === 'acct:1300')); acct('3202').is_active = true;
    // AMBIGUOUS: two accounts with the same code; two system receivables — nothing is guessed
    T.chartofaccounts.push({ account_id: '3998', account_name: 'Deductions 2', account_code: '2250', account_type: 'other_current_liability', is_active: true }, { account_id: '3997', account_name: 'Receivables 2', account_type: 'accounts_receivable', is_active: true, is_system_account: true });
    pe = await A.plan(); assert.equal(pe.rows.find(x => x.key === 'acct:2250').classification, 'AMBIGUOUS'); assert.equal(pe.rows.find(x => x.key === 'acct:1100').classification, 'AMBIGUOUS');
    assert.equal(pe.targets.ambiguous_matches, 2); assert.ok(!pe.adopts.some(a => ['acct:2250', 'acct:1100'].includes(a.key)));
    const ga = await A.preflightAndGate('test', 'ambiguous'); assert.equal(ga.gate.ready, false); assert.ok(ga.gate.ambiguous_matches >= 2); assert.ok(ga.gate.reasons.some(x => /2250 .*AMBIGUOUS/.test(x)));
    T.chartofaccounts.splice(-2, 2);
    out.push('3100: only the system Retained Earnings (a replacement → ACCOUNT_CONFLICT, none → BLOCKED, never created); duplicates → AMBIGUOUS, never guessed');
    out.push(`preview (GET only): ${pv.mutations.length} accounts to create, adoptions by code / rule / tax account, NAME_IN_USE and WRONG_TYPE stopped, no VAT account created`);

    // ---- 3. provisioning: confirmed token only; POST /chartofaccounts only; read back; ids persisted; conflicts untouched
    r = await call('POST', 'zoho-sync/provision', { confirm: true, token: 'stale' }); assert.equal(r.s, 400); assert.match(r.j.error, /differ from the preview/);
    const gl0 = JSON.stringify(ctx.financials('2026-01-01', TODAY));
    n0 = zoho.calls.length;
    let prov = ok(await call('POST', 'zoho-sync/provision', { confirm: true, token: pv.token }));
    assert.deepEqual([...new Set(writesSince(n0))], ['POST /chartofaccounts'], 'provisioning created accounts and did nothing else');
    assert.equal(prov.result.created.length, pv.mutations.length); assert.deepEqual(prov.result.failed, []);
    const custody = map('acct:1030'); assert.ok(custody && custody.created_by_trigon === 1 && custody.zoho_code === '1030' && custody.zoho_type === 'cash' && custody.mapped_at && custody.verified_at);
    const pAlpha = map(`acct:3000:p${PA}`), parentCap = map('acct:3000');
    assert.equal(acct(pAlpha.zoho_id).parent_account_id, parentCap.zoho_id, 'partner sub-account under "Partner Capital"'); assert.equal(pAlpha.partner_id, PA);
    assert.equal(acct('3701').account_type, 'income'); assert.equal(acct('3701').account_code, '6150'); assert.equal(acct('2002').account_name, 'Petty Cash', 'conflicting accounts are not renamed, re-typed or re-coded');
    assert.equal(map('acct:1200').zoho_id, '3401'); assert.equal(map('acct:3100').zoho_id, '3501'); assert.equal(map('acct:3100').created_by_trigon, 0);
    assert.equal(acct(map('acct:1690').zoho_id).parent_account_id, map('acct:1600').zoho_id, '1690 under 1600 (net book value)'); assert.equal(map('cat:asset').zoho_id, map('acct:1600').zoho_id);
    assert.equal(coa().filter(a => /retained earnings/i.test(a.account_name)).length, 1, 'no second Retained Earnings');
    assert.equal(prov.gate.ready, false, 'conflicts left: not READY'); assert.equal(map('acct:1010'), undefined, 'not adopted without the confirmation'); assert.equal(JSON.stringify(ctx.financials('2026-01-01', TODAY)), gl0, "provisioning does not touch Trigon's ledger");
    const histMap = ctx.db.prepare("SELECT kind, local_key, zoho_id, label FROM zoho_map WHERE local_key IN (" + mapBefore.map(() => '?').join(',') + ") ORDER BY kind, local_key").all(...mapBefore.map(m => m.local_key));
    assert.deepEqual(histMap, mapBefore, 'existing mappings untouched');
    out.push(`provisioning: ${prov.result.created.length} accounts created (read back, ids persisted, partners under their parents), conflicts left as they are, Trigon's ledger unchanged`);

    // ---- 4. resolve the conflicts the way the preview recommends — in Zoho, by code — then the second preflight is READY
    acct('3701').account_code = '4900'; acct('3103').account_code = '1300';   // as the preview recommends
    T.chartofaccounts.push({ account_id: '3994', account_name: 'Gain / Loss on Disposal', account_code: '6150', account_type: 'other_expense', is_active: true });   // (6150 is never created by Trigon)
    pv = ok(await call('GET', 'zoho-sync/preview')); assert.equal(byKey('acct:1300').classification, 'ADOPT_EXISTING'); assert.equal(byKey('acct:6150').classification, 'ADOPT_EXISTING');
    r = await call('POST', 'zoho-sync/provision', { confirm: true, token: pv.token, confirm_adopt: ['acct:1030'] }); assert.equal(r.s, 400); assert.match(r.j.error, /not an account the preview proposed/);
    prov = ok(await call('POST', 'zoho-sync/provision', { confirm: true, token: pv.token, confirm_adopt: ['acct:1010'] }));   // the administrator confirms Petty Cash
    assert.equal(map('acct:1010').zoho_id, '2002'); assert.equal(map('acct:1010').created_by_trigon, 0); assert.equal(acct('2002').account_code, undefined, 'nothing changed in Zoho');
    assert.equal(prov.gate.ready, true, JSON.stringify(prov.gate.reasons)); assert.equal(ctx.zohoX.cfg().gate, 'READY');
    assert.deepEqual([prov.gate.missing_mappings, prov.gate.wrong_types, prov.gate.ambiguous_matches, prov.gate.blocking_conflicts], [0, 0, 0, 0]);
    assert.deepEqual(prov.plan.targets, { missing_mappings: 0, wrong_types: 0, ambiguous_matches: 0, blocking_conflicts: 0 });
    out.push('Petty Cash: an exact-name match is adopted only on explicit confirmation (nothing changed in Zoho); after the fixes the second preflight is READY (0 / 0 / 0 / 0)');

    // ---- 5. idempotent: 1, 2 … 20 runs give the same Zoho structure; a lost answer during creation is adopted by code, not duplicated
    const shape = () => coa().map(a => `${a.account_code || ''}|${a.account_name}|${a.account_type}|${a.parent_account_id || ''}`).sort().join('\n'), s0 = shape(), c0 = coa().length;
    for (let i = 0; i < 20; i++) { const p2 = await A.plan(); assert.equal(p2.mutations.length, 0); await A.apply(p2, { trigger: 'test' }); }
    assert.equal(shape(), s0); assert.equal(coa().length, c0);
    assert.equal(new Set(coa().map(a => a.account_name.toLowerCase())).size, coa().length, 'no duplicate names (no "Employee Cash Custody 1")');
    ctx.db.prepare("DELETE FROM zoho_map WHERE local_key='acct:2400'").run();                // as if Trigon stopped right after Zoho created it
    const p3 = await A.plan(); assert.equal(p3.rows.find(x => x.key === 'acct:2400').state, 'BY_CODE'); await A.apply(p3, { trigger: 'test' });
    assert.equal(coa().length, c0); assert.ok(map('acct:2400'));
    out.push('20 more runs: identical structure; a create whose answer was lost is adopted by code, never duplicated');

    // ---- 6. partners: renamed → no new accounts; 10 partners → 30 distinct sub-accounts, created by the continuous sync
    ok(await call('PUT', `partners/${PA}`, { name: 'Partner Alpha Renamed' }));
    let p4 = await A.plan(); assert.equal(p4.mutations.length, 0, 'a rename creates nothing'); assert.match(p4.rows.find(x => x.key === `acct:3000:p${PA}`).note, /differs from Trigon's/);
    const more = []; for (let i = 3; i <= 10; i++) more.push(ok(await call('POST', 'partners', { name: `Partner ${i}` })).id);
    ok(await call('POST', 'partners', { name: 'Partner 3' })); // the same name twice: still its own accounts (identity is the id)
    let tk = await A.tick({ force: true }); assert.equal(tk.ran, true, JSON.stringify(tk)); assert.equal(tk.prov.created.length, 27); assert.deepEqual(tk.prov.failed, []);
    const ps = ctx.db.prepare('SELECT id FROM partners').all().map(x => x.id);
    for (const [code] of A.PARENTS) { const ids = ps.map(p => map(`acct:${code}:p${p}`).zoho_id); assert.equal(new Set(ids).size, ps.length, code + ': one account per partner'); assert.ok(ids.every(id => acct(id).parent_account_id === map('acct:' + code).zoho_id)); }
    tk = await A.tick({ force: true }); assert.ok(!tk.prov, 'nothing more to create');
    out.push(`partners: a rename creates nothing; ${ps.length} partners (two with the same name) → ${ps.length * 3} distinct sub-accounts under their parents`);

    // ---- 7. the continuous sync sent everything, read back and verified; the same transaction is never sent twice
    assert.equal(tk.result.failed, 0, JSON.stringify(tk.result.errors));
    const sent = ctx.db.prepare("SELECT * FROM zoho_sync WHERE status='ok' AND kind <> 'contact'").all();
    const isHist = x => histRows.some(h => h.kind === x.kind && h.local_id === x.local_id);
    assert.ok(sent.length >= 10 && sent.filter(x => !isHist(x)).every(x => x.zoho_id && x.verified_at && x.sent_eff && x.doc_date), 'every new record: Zoho id, read-back verified, effect and date kept');
    const w0 = zoho.calls.filter(c => !/^GET /.test(c)).length;
    for (let i = 0; i < 3; i++) await A.tick({ force: true });
    assert.equal(zoho.calls.filter(c => !/^GET /.test(c)).length, w0, 'nothing sent twice'); assert.equal(T.invoices.length, 1);
    const g0 = zoho.calls.length; assert.equal((await A.tick()).skipped, 'nothing new'); assert.equal(zoho.calls.length, g0, 'an idle minute costs no API call');
    out.push(`continuous: ${sent.length} records sent, each read back and verified; repeated runs send nothing; an idle minute makes no call`);

    // ---- 8. reconciliation: all MATCH, Trial Balance equal; at a cutoff before any transaction everything is zero and matches
    let rc = await A.reconcile({ cutoff: TODAY });
    const badTb = rc.tb.filter(x => x.status !== "MATCH"), badItems = rc.items.filter(x => x.status !== 'MATCH');
    assert.deepEqual(badTb.map(x => `${x.codes.join('+')}: Trigon ${x.trigon} Zoho ${x.zoho} (${x.status})`), [], 'Trial Balance: every account matches');
    assert.deepEqual(badItems, [], 'every record matches'); assert.equal(rc.status, 'MATCH'); assert.ok(rc.statements.every(x => x.status === 'MATCH'), JSON.stringify(rc.statements));
    assert.ok(rc.tb.length >= 15); assert.equal(rc.summary.totals.trigon_debit, rc.summary.totals.zoho_debit);
    // 6150 carries the loss (debit) and the gain (credit); 1690 is credited and shown under 1600: net book value equal in both books
    const p6150 = zoho.postings().filter(x => x.account_id === map('acct:6150').zoho_id);
    assert.ok(p6150.some(x => x.debit_amount > 0) && p6150.some(x => x.credit_amount > 0), '6150: a loss (debit) and a gain (credit)');
    const nbv = rc.statements.find(x => /net book value/.test(x.name)), gl = rc.statements.find(x => /^Gain \/ loss/.test(x.name));
    assert.equal(nbv.status, 'MATCH'); assert.equal(gl.status, 'MATCH'); assert.equal(nbv.trigon, ctx.financials('2026-01-01', TODAY).trial_balance.filter(a => ['1600', '1690'].includes(a.code)).reduce((t, a) => Math.round((t + a.debit - a.credit) * 100) / 100, 0));
    const t1690 = rc.tb.find(x => x.codes.includes('1690')); assert.ok(t1690.zoho < 0 && t1690.status === 'MATCH', '1690: credit balance (contra-asset)');
    out.push(`6150: a gain (credit) and a loss (debit) on one account, net ${gl.zoho} in both books; 1690 credit ${t1690.zoho} under 1600: net book value ${nbv.zoho} in both`);
    const z0 = await A.reconcile({ cutoff: '2026-09-30' }); assert.equal(z0.status, 'MATCH'); assert.ok(z0.tb.every(x => x.trigon === 0 && x.zoho === 0 && x.status === 'MATCH'));
    out.push(`reconciliation: ${rc.items.length} records MATCH, ${rc.tb.length} Trial Balance rows MATCH, statements (BS, P&L, VAT, AR, AP, bank/cash, partners, employees) MATCH; all zero before the first transaction`);

    // ---- 9. Zoho outage: Trigon keeps working; the run backs off; it succeeds once Zoho is back
    zoho.state.down = true;
    ok(await call('POST', 'partner_txns', { partner_id: PB, date: '2026-11-16', type: 'withdrawal', amount: 1000, method: 'bank' }), 'Trigon records the transaction while Zoho is down');
    tk = await A.tick({ force: true }); assert.equal(tk.run_failed, true); assert.ok(ctx.zohoX.cfg().q_next_at > new Date().toISOString());
    assert.equal((await A.tick()).skipped, 'backoff');
    zoho.state.down = false; tk = await A.tick({ force: true }); assert.equal(tk.result.failed, 0, JSON.stringify(tk.result.errors)); assert.equal(ctx.zohoX.cfg().q_next_at, '');
    assert.ok(T.journals.some(j => j.notes && /withdraw/i.test(j.notes) || /Partner/.test(j.notes || '')));
    // a record that fails on its own: retrying with back-off, skipped while waiting, sent when due
    ok(await call('POST', 'partner_txns', { partner_id: PA, date: '2026-11-17', type: 'deposit', amount: 500, method: 'cash' }));
    zoho.state.failPost = 1; zoho.state.failPath = '/journals';
    tk = await A.tick({ force: true }); const rt = ctx.db.prepare("SELECT * FROM zoho_sync WHERE status='retrying'").get();
    assert.ok(rt && rt.attempts === 1 && rt.next_at > new Date().toISOString(), 'retrying, next attempt in a minute');
    const jn = T.journals.length; tk = await A.tick({ force: true }); assert.equal(T.journals.length, jn, 'not retried before it is due'); assert.ok(tk.result.waiting >= 1);
    ctx.db.prepare('UPDATE zoho_sync SET next_at=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), rt.id);   // a minute later
    tk = await A.tick({ force: true }); assert.equal(row(rt.kind, rt.local_id).status, 'ok'); assert.equal(T.journals.length, jn + 1);
    // the answer to a create is lost (timeout): the next attempt finds it in Zoho — no second journal
    ok(await call('POST', 'partner_txns', { partner_id: PA, date: '2026-11-18', type: 'deposit', amount: 700, method: 'cash' }));
    zoho.state.lostPost = 1;
    tk = await A.tick({ force: true }); const lost = ctx.db.prepare("SELECT * FROM zoho_sync WHERE pending_create=1").get(); assert.ok(lost && lost.status === 'retrying');
    ctx.db.prepare("UPDATE zoho_sync SET status='error' WHERE id=?").run(lost.id); ok(await call('POST', 'zoho/retry'));   // the older "retry failed" button
    assert.equal(row(lost.kind, lost.local_id).pending_create, 1, 'the lost create is not forgotten by the older retry button');
    const jl = T.journals.length; ctx.db.prepare('UPDATE zoho_sync SET next_at=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), lost.id);
    tk = await A.tick({ force: true }); assert.equal(T.journals.length, jl, 'adopted, not sent again'); const lr = row(lost.kind, lost.local_id);
    assert.equal(lr.status, 'ok'); assert.equal(lr.pending_create, 0); assert.equal(T.journals.find(j => j.journal_id === lr.zoho_id).status, 'published');
    // two candidates in Zoho for a lost create: nothing is guessed — blocked as a possible duplicate, nothing sent
    ok(await call('POST', 'partner_txns', { partner_id: PB, date: '2026-11-18', type: 'deposit', amount: 60, method: 'cash' }));
    zoho.state.lostPost = 1; await A.tick({ force: true });
    const two = ctx.db.prepare("SELECT * FROM zoho_sync WHERE pending_create=1").get(), made = T.journals[T.journals.length - 1];
    T.journals.push({ ...made, journal_id: '9990777' });                                     // someone also keyed it in Zoho
    ctx.db.prepare('UPDATE zoho_sync SET next_at=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), two.id);
    const jd = T.journals.length; await A.tick({ force: true });
    assert.equal(T.journals.length, jd, 'nothing sent'); assert.equal(row(two.kind, two.local_id).status, 'blocked'); assert.match(row(two.kind, two.local_id).error, /^POSSIBLE_DUPLICATE/);
    T.journals.splice(T.journals.findIndex(j => j.journal_id === '9990777'), 1); ok(await call('POST', 'zoho-sync/retry')); await A.tick({ force: true });
    assert.equal(row(two.kind, two.local_id).status, 'ok'); assert.equal(row(two.kind, two.local_id).zoho_id, made.journal_id);
    out.push('outage: Trigon carries on, the run backs off and succeeds later; a failed record retries when due; a lost answer is adopted, not duplicated; two candidates → POSSIBLE_DUPLICATE');
    // read-back: Zoho stores something else than it was sent → blocked for review (VERIFY_MISMATCH), not sent again
    ok(await call('POST', 'partner_txns', { partner_id: PB, date: '2026-11-18', type: 'deposit', amount: 40, method: 'cash' }));
    zoho.state.tamperJournal = 1; const jv = T.journals.length; await A.tick({ force: true });
    const vm = ctx.db.prepare("SELECT * FROM zoho_sync WHERE error LIKE 'VERIFY_MISMATCH%'").get(); assert.ok(vm && vm.status === 'blocked' && vm.zoho_id, 'blocked, its Zoho id kept');
    await A.tick({ force: true }); assert.equal(T.journals.length, jv + 1, 'never sent a second time');
    const tj = T.journals.find(j => j.journal_id === vm.zoho_id); for (const l of tj.line_items) l.amount = Math.round((l.amount - 1) * 100) / 100;   // corrected in Zoho
    ok(await call('POST', 'zoho-sync/retry')); await A.tick({ force: true }); assert.equal(row(vm.kind, vm.local_id).status, 'ok'); assert.equal(T.journals.length, jv + 1);
    out.push('read-back mismatch after a send: blocked (VERIFY_MISMATCH), never sent twice, cleared once Zoho holds what Trigon sent');

    // ---- 10. someone edits a Trigon journal in Zoho: reconciliation fails it; Trigon does not overwrite it
    const target = ctx.db.prepare("SELECT * FROM zoho_sync WHERE kind='jv_partner' AND status='ok' ORDER BY id LIMIT 1").get(), zj = T.journals.find(j => j.journal_id === target.zoho_id);
    for (const l of zj.line_items) l.amount = Math.round((l.amount + 10) * 100) / 100;
    rc = await A.reconcile({ cutoff: TODAY });
    assert.equal(rc.items.find(x => x.kind === 'jv_partner' && x.local_id === target.local_id).status, 'AMOUNT_MISMATCH'); assert.equal(rc.status, 'DIFFERENCES');
    assert.ok(rc.tb.some(x => x.status === 'DIFFERENCE'), 'and the Trial Balance shows it');
    ctx.db.prepare("UPDATE zoho_sync SET hash='changed-here' WHERE id=?").run(target.id);        // Trigon would now update it
    const w1 = zoho.calls.filter(c => /^PUT /.test(c)).length; tk = await A.tick({ force: true });
    assert.equal(zoho.calls.filter(c => /^PUT /.test(c)).length, w1, 'not overwritten'); assert.equal(row(target.kind, target.local_id).status, 'blocked'); assert.match(row(target.kind, target.local_id).error, /^ZOHO_MODIFIED/);
    for (const l of zj.line_items) l.amount = Math.round((l.amount - 10) * 100) / 100;           // the accountant puts it back
    ctx.db.prepare("UPDATE zoho_sync SET hash=NULL WHERE id=?").run(target.id); ok(await call('POST', 'zoho-sync/retry')); await A.tick({ force: true });
    assert.equal(row(target.kind, target.local_id).status, 'ok');
    out.push('a Trigon journal edited in Zoho: AMOUNT_MISMATCH and a Trial Balance difference; Trigon blocks it (ZOHO_MODIFIED) instead of overwriting');

    // ---- 11. a 0.01 difference and a Zoho-only journal are found and shown separately
    rc = await A.reconcile({ cutoff: TODAY }); assert.equal(rc.status, 'MATCH', JSON.stringify(rc.tb.filter(x => x.status !== 'MATCH')));
    T.journals.push({ journal_id: '9990001', journal_date: '2026-11-15', reference_number: 'ACCT-ADJ', status: 'published', line_items: [{ account_id: '3801', debit_or_credit: 'debit', amount: 0.01 }, { account_id: '2003', debit_or_credit: 'credit', amount: 0.01 }] });
    rc = await A.reconcile({ cutoff: TODAY });
    const d1 = rc.tb.filter(x => x.status !== 'MATCH'); assert.deepEqual(d1.map(x => [x.zoho_id, x.difference, x.zoho_only]).sort(), [['2003', -0.01, -0.01], ['3801', 0.01, 0.01]]);
    assert.ok(rc.zoho_only.some(x => x.id === '9990001' && x.type === 'journal'), 'the Zoho-only journal is listed on its own');
    assert.ok(!rc.items.some(x => x.zoho_id === '9990001'), 'and is not mixed with Trigon records'); assert.equal(rc.status, 'DIFFERENCES');
    T.journals.pop();
    out.push('Trial Balance: a 0.01 difference detected; a Zoho-only journal identified separately');

    // ---- 12. closed period: nothing dated on or before the closing date is changed in Zoho
    ok(await call('PUT', 'period', { lock_date: '2026-11-15' }));
    ok(await call('PUT', 'zoho/mapping', { kind: 'account', local_key: 'acct:1010', zoho_id: '2003' }));   // would rewrite the petty cash top-up and the office water expense
    const w2 = zoho.calls.filter(c => /^(PUT|DELETE|POST) \/(bills|journals|invoices|expenses)/.test(c)).length; await A.tick({ force: true });
    assert.equal(zoho.calls.filter(c => /^(PUT|DELETE|POST) \/(bills|journals|invoices|expenses)/.test(c)).length, w2, 'closed period not rewritten');
    const closed = ctx.db.prepare("SELECT kind, status, error FROM zoho_sync WHERE status='blocked'").all();
    assert.ok(closed.length >= 2 && closed.every(x => /^CLOSED_PERIOD/.test(x.error)), JSON.stringify(closed)); assert.ok(closed.some(x => x.kind === 'jv_petty') && closed.some(x => x.kind === 'bill'));
    ok(await call('PUT', 'zoho/mapping', { kind: 'account', local_key: 'acct:1010', zoho_id: '2002' }));
    out.push('closed period: changes dated inside it are BLOCKED (CLOSED_PERIOD), nothing rewritten in Zoho');

    // ---- 13. type mismatch on a mapped account during sync: ACCOUNT_CONFLICT, nothing sent with it; unrelated records continue
    ok(await call('PUT', 'period', { lock_date: '' }));
    acct(map('acct:1030').zoho_id).account_type = 'expense';                                  // someone re-typed it in Zoho
    ok(await call('POST', 'petty_custody/handover', { employee_id: E, date: '2026-11-19', amount: 300, method: 'cash' }));
    ok(await call('POST', 'partner_txns', { partner_id: PB, date: '2026-11-19', type: 'deposit', amount: 50, method: 'cash' }));
    const jb = T.journals.length; tk = await A.tick({ force: true });
    const hand = ctx.db.prepare("SELECT * FROM zoho_sync WHERE kind='jv_petty' ORDER BY id DESC LIMIT 1").get(); assert.equal(hand.status, 'blocked'); assert.match(hand.error, /^ACCOUNT_CONFLICT/);
    assert.equal(T.journals.length, jb + 1, 'the unrelated partner deposit was sent');
    pv = await A.plan(); assert.equal(pv.rows.find(x => x.key === 'acct:1030').reason, 'WRONG_TYPE'); assert.equal(pv.state, 'Conflict');
    const g2 = await A.preflightAndGate('test', 'test'); assert.equal(g2.gate.ready, false, 'the gate drops'); assert.equal((await A.tick({ force: true })).skipped, 'gate');
    acct(map('acct:1030').zoho_id).account_type = 'cash';
    out.push('a mapped account re-typed in Zoho: ACCOUNT_CONFLICT on its records only, the gate drops, nothing is changed in Zoho');

    // ---- 14. VAT not configured in Zoho: VAT_CONFIGURATION_REQUIRED, no generic account created
    ctx.db.prepare("DELETE FROM zoho_map WHERE local_key IN ('acct:1200','acct:2100')").run();
    acct('3401').is_active = false;
    pv = await A.plan(); assert.equal(pv.state, 'VAT_CONFIGURATION_REQUIRED'); assert.equal(pv.vat.find(v => v.code === '1200').action, 'vat_required');
    assert.ok(!pv.mutations.some(m => /vat|tax/i.test(m.body.account_name + m.body.account_type))); assert.equal(pv.mutations.length, 0);
    const t0 = T.taxes.splice(0, 1); pv = await A.plan(); assert.ok(pv.vat.some(v => v.code === 'tax' && v.classification === 'VAT_CONFIGURATION_REQUIRED')); T.taxes.unshift(...t0);
    acct('3401').is_active = true; await A.apply(await A.plan(), { trigger: 'test' }); assert.equal(map('acct:1200').zoho_id, '3401');
    out.push('VAT not set up in Zoho: VAT_CONFIGURATION_REQUIRED; no VAT or generic account is created');

    const back = await A.preflightAndGate('test', 'after the fixes in Zoho'); assert.equal(back.gate.ready, true, JSON.stringify(back.gate.reasons));
    // ---- 15. a Zoho failure during provisioning leaves Trigon's ledger alone
    const gl1 = JSON.stringify(ctx.financials('2026-01-01', TODAY));
    ok(await call('POST', 'partners', { name: 'Partner Late' })); zoho.state.down = true;
    await assert.rejects(A.plan()); tk = await A.tick({ force: true }); assert.equal(tk.run_failed, true); assert.equal(JSON.stringify(ctx.financials('2026-01-01', TODAY)), gl1);
    zoho.state.down = false; tk = await A.tick({ force: true }); assert.equal(tk.prov.created.length, 3);
    out.push("Zoho down during provisioning: nothing changes in Trigon's ledger; done on the next run");
    // a created account that Zoho stores with another type: READ_BACK_MISMATCH, remembered (not created again), then a conflict
    ok(await call('POST', 'partners', { name: 'Partner Odd' })); zoho.state.tamperAccount = 'other_liability';
    tk = await A.tick({ force: true }); assert.equal(tk.prov.failed.length, 1); assert.match(tk.prov.failed[0].error, /^READ_BACK_MISMATCH: account_type is "other_liability", expected "equity"/);
    const odd = ctx.db.prepare("SELECT id FROM partners WHERE name='Partner Odd'").get().id, oddMap = map(`acct:3000:p${odd}`); assert.ok(oddMap && oddMap.verified_at === null);
    const cOdd = coa().length; tk = await A.tick({ force: true }); assert.equal(coa().length, cOdd, 'not created again');
    assert.equal((await A.plan()).rows.find(x => x.key === `acct:3000:p${odd}`).reason, 'WRONG_TYPE');
    acct(oddMap.zoho_id).account_type = 'equity';                                            // corrected in Zoho
    out.push('a created account read back with another type: READ_BACK_MISMATCH, remembered (never created twice), shown as a conflict');

    // ---- 16. the read-only operations stay read-only
    n0 = zoho.calls.length;
    ok(await call('POST', 'zoho-sync/preflight')); ok(await call('GET', 'zoho-sync/preview')); await A.reconcile({ cutoff: TODAY }); ok(await call('POST', 'zoho/dry-run', {}));
    assert.deepEqual(writesSince(n0), [], 'preflight, preview, reconciliation and dry run: GET only');
    const ro = ctx.zohoX.client(ctx.zohoX.cfg(), true);
    for (const [m2, f] of [['POST', () => ro.post('/invoices', {})], ['PUT', () => ro.put('/invoices/1', {})], ['DELETE', () => ro.del('/journals/1')]]) await assert.rejects(f(), /read-only/, m2);
    // provisioning cannot be steered elsewhere: the path in a plan is ignored (accounts only), and its client refuses any other POST
    const n1 = zoho.calls.length;
    await ctx.zohoAcct.apply({ token: 't', adopts: [], rows: [{ key: 'x' }], vat: [], mutations: [{ key: 'x', method: 'POST', path: '/journals', body: { journal_date: '2026-11-01', line_items: [] } }] }, {});
    assert.ok(writesSince(n1).every(c => c === 'POST /chartofaccounts'), JSON.stringify(writesSince(n1)));
    const co = ctx.zohoAcct._createOnly(ctx.zohoX.client(ctx.zohoX.cfg()));
    for (const pth of ['/journals', '/invoices', '/chartofaccounts/1/inactive', '/bankaccounts']) await assert.rejects(co.post(pth, {}), /may only create accounts/, pth);
    assert.equal(co.put, undefined); assert.equal(co.del, undefined);
    out.push('preflight, preview, reconciliation, dry run: no modifying call; the provisioning client can only create accounts');

    // ---- history: never resent, never updated, matched in the reconciliation
    assert.deepEqual(ctx.db.prepare("SELECT kind, local_id, zoho_id, hash, synced_at, sent_eff FROM zoho_sync WHERE kind IN ('invoice','jv_retention') ORDER BY kind").all(), histRows, 'historical rows untouched');
    assert.equal(T.invoices.length, 1, 'the invoice exists once in Zoho'); assert.equal(T.journals.filter(j => /^RET-/.test(j.reference_number)).length, 1, 'its retention journal once');
    assert.ok(!zoho.calls.some(c => /^PUT \/invoices\//.test(c)), 'the historical invoice was never updated');
    rc = await A.reconcile({ cutoff: TODAY }); for (const h of histRows) assert.equal(rc.items.find(x => x.kind === h.kind && x.local_id === h.local_id).status, 'MATCH');
    out.push('history sent by the earlier version: never resent or rewritten, and matched by the reconciliation');

    // ---- the status screen
    const st = ok(await call('GET', 'zoho-sync'));
    assert.equal(st.gate, 'READY'); assert.equal(st.connection.connected, true); assert.ok(st.last_successful_sync && st.last_reconciliation && st.last_provisioning);
    const acc = await call('PUT', 'zoho-sync/settings', { continuous: '0' }); assert.equal(acc.s, 200);
    out.push('status: connection, gate, accounts, queue, last sync, last reconciliation, trial balance');

    console.log(out.map(x => '  ✔ ' + x).join('\n'));
    console.log('ZOHO ACCOUNTING SYNC TESTS PASSED');
  } finally { server.close(); zoho.srv.close(); }
});
