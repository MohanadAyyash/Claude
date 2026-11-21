// The controlled, non-VAT account-provisioning run (scripts/zoho-provision.js) on an isolated copy, against the Zoho mock:
// its request guard, the refusal of anything outside the authorisation, the stop at the first failure, the full run with read-back,
// the preflight again (READY_NON_VAT), the reconciliation, and what production sees afterwards.   node --no-warnings test-zohoprovision.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-zohoprov-'));
process.env.ZOHO_NO_SCHEDULER = '1'; process.env.SALES_NO_SCHEDULER = '1';
const mockZoho = require('./tools/zoho-mock.js');
const zoho = mockZoho();
process.env.ZOHO_CLIENT_ID = zoho.CLIENT_ID; process.env.ZOHO_CLIENT_SECRET = zoho.CLIENT_SECRET;
const { server, ctx } = require('./server.js');
ctx.zohoReconPace = 0;
const { spawn } = require('child_process');   // not spawnSync: the Zoho mock answers from this same process
const spawnAsync = (args, opts) => new Promise(res => { const c = spawn(process.execPath, args, opts); let stdout = '', stderr = ''; c.stdout.on('data', d => stdout += d); c.stderr.on('data', d => stderr += d); c.on('close', status => res({ status, stdout, stderr })); });

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api/`; let cookie = '';
  const call = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j }; };
  const ok = (r, l) => { assert.equal(r.s, 200, `${l || ''} → ${r.s} ${JSON.stringify(r.j).slice(0, 400)}`); return r.j; };
  const T = zoho.T, out = [];
  await new Promise(r => zoho.srv.listen(0, r)); process.env.ZOHO_ACCOUNTS_URL = zoho.accountsUrl;
  try {
    // ---- the request guard of the script (unit)
    const G = require('./scripts/zoho-provision.js'), BOOKS = 'https://www.zohoapis.com/books/v3';
    assert.equal(G.decide(BOOKS + '/chartofaccounts?organization_id=1', { method: 'GET' }), 'read');
    G.guard.budget = 5; G.guard.creates = 0;
    for (const ph of ['read', 'verify']) { G.guard.phase = ph; assert.equal(G.decide(BOOKS + '/chartofaccounts?organization_id=1', { method: 'POST', body: '{}' }), 'BLOCKED', 'no creation outside the provisioning step: ' + ph); }
    G.guard.phase = 'provision'; G.guard.budget = 2; G.guard.creates = 0;
    assert.equal(G.decide(BOOKS + '/chartofaccounts?organization_id=1', { method: 'POST', body: JSON.stringify({ account_name: 'X', account_code: '1', account_type: 'cash' }) }), 'create account');
    assert.deepEqual(G.requests[G.requests.length - 1].account, { code: '1', name: 'X', type: 'cash', parent_id: '' });
    for (const [u, m] of [['/invoices', 'POST'], ['/journals', 'POST'], ['/customerpayments', 'POST'], ['/chartofaccounts/5', 'PUT'], ['/chartofaccounts/5', 'DELETE'], ['/chartofaccounts/5/inactive', 'POST'], ['/settings/taxes', 'POST']])
      assert.equal(G.decide(BOOKS + u, { method: m }), 'BLOCKED', `${m} ${u}`);
    assert.equal(G.decide(BOOKS + '/chartofaccounts', { method: 'POST', body: '{}' }), 'create account');
    assert.equal(G.decide(BOOKS + '/chartofaccounts', { method: 'POST', body: '{}' }), 'BLOCKED', 'never more creations than the authorised plan');
    G.guard.phase = 'verify'; assert.equal(G.decide(BOOKS + '/chartofaccounts', { method: 'POST', body: '{}' }), 'BLOCKED');
    assert.equal(G.decide('https://accounts.zoho.com/oauth/v2/token', { method: 'POST', body: 'grant_type=refresh_token&refresh_token=x' }), 'access token');
    assert.equal(G.decide('https://accounts.zoho.com/oauth/v2/token', { method: 'POST', body: 'grant_type=authorization_code&code=x' }), 'BLOCKED');
    assert.equal(G.decide('https://graph.microsoft.com/v1.0/me', { method: 'GET' }), 'BLOCKED');
    assert.deepEqual(G.AUTH.create.map(a => a[0]), ['1020', '1030', '1050', '1600', '1690', '2050', '2260', '2400', '3900', '6100', '3000', '2500', '3110']);
    for (const c of ['1010', '3100', '1200', '2100', '6150']) assert.ok(!G.AUTH.create.some(a => a[0] === c) && G.AUTH.never.includes(c), c);
    out.push('guard: GET, the access token, and POST /chartofaccounts only while provisioning and only as many as authorised; everything else refused');

    // ---- Trigon and Zoho as in the real organisation: VAT pending, Petty Cash owned by the legacy 1020 mapping, one partner
    ok(await call('POST', 'setup', { username: 'admin', password: 'secret12', company: 'Trigon' }));
    ok(await call('PUT', 'settings', { trn: '100123456700003' }));
    const cl = ok(await call('POST', 'parties', { type: 'client', name: 'Client Test', trn: '100000000000003' })).id;
    const P = ok(await call('POST', 'projects', { name: 'Site A', client_id: cl, status: 'active' })).id;
    const inv = ok(await call('POST', 'invoices', { project_id: P, date: '2026-11-05', items: [{ description: 'Works', qty: 10, rate: 100 }] })).id;
    ok(await call('POST', 'payments', { kind: 'in', date: '2026-11-10', amount: 1050, method: 'bank', invoice_id: inv }));
    const PA = ok(await call('POST', 'partners', { name: 'Partner Alpha' })).id;
    ok(await call('POST', `partners/${PA}/shares`, { pct: 100, from_date: '2026-01-01' }));
    ok(await call('POST', 'partner_txns', { partner_id: PA, date: '2026-11-02', type: 'capital_in', amount: 50000, method: 'bank' }));
    T.taxes.length = 0;
    for (const a of T.chartofaccounts) if (a.account_id === '3201') a.is_system_account = true;   // Accounts Receivable (system)
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
    ok(await call('PUT', 'zoho/mapping', { kind: 'account', local_key: 'acct:1020', zoho_id: '2002', label: 'Petty Cash (cash)' }));
    ok(await call('PUT', 'zoho/mapping', { kind: 'account', local_key: 'acct:4000', zoho_id: '3004' }));
    const map1020 = JSON.stringify(ctx.db.prepare("SELECT * FROM zoho_map WHERE local_key='acct:1020'").get());

    const env = { ...process.env, ZOHO_ACCOUNTS_URL: zoho.accountsUrl, DATA_DIR: '' };
    const copyOf = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-zohoprov-copy-')), data = path.join(d, 'data'); fs.mkdirSync(data); ctx.db.exec(`VACUUM INTO '${path.join(data, 'erp.db').replace(/'/g, "''")}'`); return { d, data }; };
    const ARGS = data => ['--no-warnings', 'scripts/zoho-provision.js', '--data', data, '--org', zoho.ORG, '--petty-cash-id', '2002', '--retained-earnings-id', '3501', '--yes'];
    const zohoBefore = JSON.stringify(T), writes = n => zoho.calls.slice(n).filter(c => !/^GET /.test(c));
    const secrets = r => { for (const s of [zoho.CLIENT_ID, zoho.CLIENT_SECRET, 'rt-', 'at-']) assert.ok(!(r.stdout + r.stderr).includes(s), 'no secret printed: ' + s); };

    // ---- 1. anything outside the authorisation: refused before the first change
    { const { d, data } = copyOf(), n = zoho.calls.length;
      let r = await spawnAsync([...ARGS(data).slice(0, 7), '9999', ...ARGS(data).slice(8), '--out', path.join(d, 'r1')], { env });
      assert.equal(r.status, 2, r.stdout + r.stderr); assert.match(r.stdout, /REPAIR_OPERATIONS|repair operations differ|is not an active cash account named Petty Cash|could not read Petty Cash/);
      assert.match(r.stdout, /VERDICT: REFUSED — nothing was changed in Zoho/); assert.deepEqual(writes(n), []);
      r = await spawnAsync(ARGS(data).map(a => a === '3501' ? '3002' : a).concat(['--out', path.join(d, 'r2')]), { env });
      assert.equal(r.status, 2); assert.match(r.stdout, /3100 is not adopted as the system Retained Earnings 3002/); assert.deepEqual(writes(n), []);
      r = await spawnAsync(ARGS(data).map(a => a === zoho.ORG ? '900000002' : a), { env });
      assert.equal(r.status, 2); assert.match(r.stderr, /connected to organisation 900000001, not 900000002/); assert.deepEqual(writes(n), []);
      // the partner sub-accounts are not in the 13 authorised accounts: refused unless --partner-subaccounts
      r = await spawnAsync([...ARGS(data), '--out', path.join(d, 'r3')], { env });
      assert.equal(r.status, 2, r.stdout + r.stderr); assert.match(r.stdout, /the plan also creates 3 partner sub-account\(s\), not in this authorisation: 3000-P1 "Partner Alpha - Capital"; 2500-P1 "Partner Alpha - Loan"; 3110-P1 "Partner Alpha - Current" — run again with --partner-subaccounts/);
      assert.deepEqual(writes(n), []); assert.equal(JSON.stringify(T), zohoBefore, 'Zoho unchanged');
      // continuous sync switched on in the copy: refused
      const { DatabaseSync } = require('node:sqlite'), cdb = new DatabaseSync(path.join(data, 'erp.db'));
      cdb.prepare("INSERT INTO zoho_config(key,value) VALUES('continuous','1') ON CONFLICT(key) DO UPDATE SET value='1'").run(); cdb.close();
      r = await spawnAsync([...ARGS(data), '--partner-subaccounts'], { env }); assert.equal(r.status, 2); assert.match(r.stderr, /Continuous sync is ON in this copy/); assert.deepEqual(writes(n), []);
      // the live folder and a folder without a database are refused
      r = await spawnAsync(ARGS(path.join(d, 'nothing')), { env }); assert.equal(r.status, 3); assert.match(r.stderr, /No erp\.db/);
      secrets(r); }
    out.push('refused with zero modifying calls: wrong Petty Cash id, wrong Retained Earnings id, another organisation, partner sub-accounts not authorised, continuous ON, no database');

    // ---- 2. a creation fails in the middle: the run stops at once, nothing after it is attempted
    { const { d, data } = copyOf(), n = zoho.calls.length; zoho.state.failNth = 3; zoho.state.failPath = '/chartofaccounts';
      const r = await spawnAsync([...ARGS(data), '--partner-subaccounts', '--out', path.join(d, 'stop')], { env }); zoho.state.failNth = 0; zoho.state.failPath = '';
      assert.equal(r.status, 4, r.stdout + r.stderr); assert.match(r.stdout, /STOPPED: stopped at the first failure \(acct:\d+\)/); assert.match(r.stdout, /VERDICT: STOPPED/);
      const w = writes(n); assert.deepEqual(w, ['POST /chartofaccounts', 'POST /chartofaccounts', 'POST (failed) /chartofaccounts'], 'two created, the third failed, nothing after it');
      const rep = JSON.parse(fs.readFileSync(path.join(d, 'stop', 'provision-report.json'), 'utf8'));
      assert.equal(rep.modifying_calls.length, 3); assert.equal(rep.modifying_calls[0].code, '1020'); assert.equal(rep.modifying_calls[2].outcome, 'HTTP 503'); assert.ok(!rep.after, 'no preflight after a stop');
      const { DatabaseSync } = require('node:sqlite'), cdb = new DatabaseSync(path.join(data, 'erp.db'));
      const m = k => cdb.prepare("SELECT zoho_id FROM zoho_map WHERE kind='account' AND local_key=?").get(k);
      assert.equal(m('acct:1010').zoho_id, '2002'); assert.notEqual(m('acct:1020').zoho_id, '2002', 'the repair before the failure is complete'); cdb.close();
      // undo in the mock (test only) so the full run below starts from the real organisation's state
      T.chartofaccounts.splice(T.chartofaccounts.length - 2, 2); assert.equal(JSON.stringify(T), zohoBefore); }
    out.push('a failure on the 3rd creation stops the run: no 4th POST, no preflight, the repair already done stays complete');

    // ---- 3. the authorised run: create, repair, read back, preflight again, reconcile
    const { d, data } = copyOf(), n = zoho.calls.length, petty = JSON.stringify(T.bankaccounts.find(a => a.account_id === '2002'));
    const r = await spawnAsync([...ARGS(data), '--partner-subaccounts', '--out', path.join(d, 'run')], { env }); if (process.env.SHOW) console.log(r.stdout);
    assert.equal(r.status, 0, r.stdout + r.stderr); secrets(r);
    assert.match(r.stdout, /VERDICT: PROVISIONED AND VERIFIED — READY_NON_VAT\. Continuous sync is OFF\. Stop here\./);
    for (const t of ['✔ Gate = READY_NON_VAT', '✔ non-VAT missing mappings = 0', '✔ non-VAT wrong types = 0', '✔ non-VAT ambiguous matches = 0', '✔ non-VAT blocking conflicts = 0', '✔ VAT = VAT_PENDING', '✔ 6150 = ACCOUNTING_CHANGE_PENDING',
      '✔ 1010 / 1020 / 1030 on three distinct Zoho accounts', '✔ no request refused by the guard', '✔ continuous sync still OFF', '✔ historical mapping audit kept; one legacy_mapping_repair audit record added',
      '✔ no transaction, document, journal or payment sent (Trigon send log unchanged; no sync run)', '✔ reconciliation ran:']) assert.ok(r.stdout.includes(t), t);
    const w = writes(n); assert.equal(w.length, 16); assert.ok(w.every(c => c === 'POST /chartofaccounts'), 'only account creations: ' + w.join(', '));
    const rep = JSON.parse(fs.readFileSync(path.join(d, 'run', 'provision-report.json'), 'utf8'));
    assert.equal(rep.modifying_calls.length, 16); assert.deepEqual(rep.modifying_calls.map(m => m.code).slice(0, 1), ['1020'], 'Cash on Hand first (the repair)');
    assert.ok(rep.modifying_calls.every(m => m.method === 'POST' && m.path.endsWith('/chartofaccounts') && /^HTTP 20[01]$/.test(m.outcome)));
    const created = c => T.chartofaccounts.filter(a => a.account_code === c);
    for (const [code, name, type, parent] of G.AUTH.create) { const a = created(code); assert.equal(a.length, 1, code); assert.equal(a[0].account_name, name); assert.equal(a[0].account_type, type);
      if (parent) assert.equal(a[0].parent_account_id, created(parent)[0].account_id, code + ' under ' + parent); }
    for (const c of ['1010', '3100', '1200', '2100', '6150']) assert.equal(created(c).length, 0, c + ' never created');
    assert.equal(JSON.stringify(T.bankaccounts.find(a => a.account_id === '2002')), petty, 'Petty Cash itself unchanged');
    assert.equal(T.chartofaccounts.concat(T.bankaccounts).filter(a => /^petty cash$/i.test(a.account_name)).length, 1);
    assert.equal(T.taxes.length, 0, 'VAT not touched'); for (const k of ['invoices', 'bills', 'journals', 'customerpayments']) assert.ok(!(T[k] || []).length, 'nothing sent: ' + k);
    const ids = Object.fromEntries(rep.zoho_ids.map(x => [x.trigon, x])); assert.equal(ids['acct:1010'].zoho_id, '2002'); assert.equal(ids['acct:3100'].zoho_id, '3501'); assert.equal(ids['acct:1020'].zoho_id, created('1020')[0].account_id);
    assert.equal(rep.after.gate, 'READY_NON_VAT'); assert.deepEqual(rep.after.targets_non_vat, { missing_mappings: 0, wrong_types: 0, ambiguous_matches: 0, blocking_conflicts: 0 }); assert.equal(rep.after.vat, 'VAT_PENDING');
    assert.ok(rep.reconciliation && rep.reconciliation.tb && rep.reconciliation.status !== 'FAILED'); assert.ok(rep.audit.repair_record && /legacy_mapping_repair/.test(rep.audit.repair_record.detail));
    assert.ok(rep.verified.every(v => v.ok && v.active)); assert.equal(rep.requests.blocked, 0);
    const log = fs.readFileSync(path.join(d, 'run', 'request-log.csv'), 'utf8'); assert.ok(!/refresh_token|Zoho-oauthtoken|test-secret/.test(log), 'no token in the log');
    out.push(`authorised run: ${w.length} POST /chartofaccounts (13 accounts + 3 partner sub-accounts), each read back; Petty Cash unchanged; 1010 / 1020 / 1030 distinct; READY_NON_VAT with zeros; VAT_PENDING; 6150 pending; nothing else sent`);

    // ---- 4. run again on the same copy: nothing left to create — refused, zero calls
    { const n2 = zoho.calls.length, r2 = await spawnAsync([...ARGS(data), '--partner-subaccounts', '--out', path.join(d, 'again')], { env });
      assert.equal(r2.status, 2, r2.stdout); assert.match(r2.stdout, /the accounts to create are \[\]/); assert.deepEqual(writes(n2), []); }
    // ---- 5. production (this database, never touched by the run): its own preview later adopts everything by code — nothing created twice
    { assert.equal(JSON.stringify(ctx.db.prepare("SELECT * FROM zoho_map WHERE local_key='acct:1020'").get()), map1020, 'production mapping untouched by the run on the copy');
      const n3 = zoho.calls.length, q = await ctx.zohoAcct.plan(); assert.deepEqual(writes(n3), []);
      assert.deepEqual(q.mutations.map(m => m.body.account_code), [], 'nothing to create in production afterwards');
      const rp = q.rows.find(x => x.key === 'acct:1010').repair; assert.equal(rp.state, 'PROPOSED');
      assert.deepEqual(rp.operations.map(o => [o.op, o.zoho_id]), [['REMOVE_MAPPING_ONLY', '2002'], ['ADOPT_EXISTING', '2002'], ['MAP', created('1020')[0].account_id]], 'production repair maps 1020 to the existing Cash on Hand'); }
    out.push('rerun on the copy refused (nothing to create); production later adopts every account by code and its repair maps 1020 to the existing Cash on Hand — no second creation');

    for (const o of out) console.log('  ✔ ' + o);
    console.log('ZOHO CONTROLLED PROVISIONING TESTS PASSED');
  } catch (e) { console.error(e); process.exitCode = 1; }
  finally { server.close(); zoho.srv.close(); setTimeout(() => process.exit(process.exitCode || 0), 100); }
});
