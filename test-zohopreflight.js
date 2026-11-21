// Zoho preflight: a dry run against the connected organisation that writes nothing and reports what would happen: node --no-warnings test-zohopreflight.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-zohopre-'));
process.env.ZOHO_NO_SCHEDULER = '1'; process.env.SALES_NO_SCHEDULER = '1';
const mockZoho = require('./tools/zoho-mock.js');
const zoho = mockZoho();
process.env.ZOHO_CLIENT_ID = zoho.CLIENT_ID; process.env.ZOHO_CLIENT_SECRET = zoho.CLIENT_SECRET;      // as the office PC's .env would
const { server, ctx } = require('./server.js');
// this suite tests the send engine itself: the READY gate of the account-provisioning workflow is tested in test-zohoacct.js
ctx.db.prepare("UPDATE zoho_config SET value='0' WHERE key='gate_required'").run();
const Z = require('./lib/zoho.js');

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

    // ---- 3. connect with a grant code (client from .env)
    ok(await call('POST', 'zoho/connect', { code: '1000.code.one' }));
    ok(await call('PUT', 'zoho/config', { enabled: '1', start: '2026-11-01', post: '0' }));

    // ---- 4. mapping: accounts, project → reporting-tag option / Zoho project
    const mp = ok(await call('GET', 'zoho/mapping'));
    assert.ok(mp.zoho.accounts.length > 5); assert.equal(mp.zoho.tags[0].options.length, 2); assert.equal(mp.zoho.projects[0].id, '8001');
    for (const [k, z] of [['acct:5200', '3101'], ['acct:6200', '3101'], ['acct:2200', '3102'], ['acct:2250', '3104'], ['acct:1300', '3103'], ['acct:5260', '3105'], ['acct:1150', '3202']]) ok(await call('PUT', 'zoho/mapping', { kind: 'account', local_key: k, zoho_id: z }));
    ok(await call('PUT', 'zoho/mapping', { kind: 'project', local_key: A, zoho_id: 'tag:7001:7101' }));
    ok(await call('PUT', 'zoho/mapping', { kind: 'project', local_key: B, zoho_id: 'project:8001' }));

    // ---- first real send: what is sent becomes "already synced" (the end-of-service journal fails: 2300 is not mapped)
    const rcpt = ok(await call('POST', 'payments', { kind: 'in', date: '2026-11-10', amount: 1000, method: 'bank', invoice_id: inv, reference: 'RCPT-1' })).id;
    const rc2 = ok(await call('POST', 'payments', { kind: 'in', date: '2026-11-12', amount: 500, method: 'bank', invoice_id: inv, reference: 'RCPT-2' })).id;
    ok(await call('POST', 'zoho/sync', RANGE));
    assert.equal(ctx.db.prepare("SELECT status FROM zoho_sync WHERE kind='payment' AND local_id=?").get(rcpt).status, 'ok', 'the receipt was sent');
    ok(await call('DELETE', `payments/${rcpt}`));
    ok(await call('PUT', `payments/${rc2}`, { amount: 400 }));   // changed here after it was sent: removed there and sent again   // deleted here after it was sent: the dry run reports it would be removed there
    const inv1 = ctx.db.prepare("SELECT number FROM invoices WHERE id=?").get(inv).number;
    // after it: a new invoice (to create), the first invoice edited here after it was paid in Zoho (a conflict), and an invoice
    // whose number already exists in Zoho without being in our send log (a possible duplicate: it would be linked, not created)
    const inv2 = ok(await call('POST', 'invoices', { project_id: A, date: '2026-11-20', retention_pct: 10, items: [{ description: 'Kerbs', qty: 10, rate: 40 }] })).id;
    const inv3 = ok(await call('POST', 'invoices', { project_id: B, date: '2026-11-21', items: [{ description: 'Asphalt', qty: 5, rate: 300 }] })).id;
    const n3 = ctx.db.prepare('SELECT number FROM invoices WHERE id=?').get(inv3).number;
    zoho.T.invoices.push({ invoice_id: '4609999999999', invoice_number: n3, status: 'sent', total: 1575, balance: 1575 });
    zoho.T.invoices.find(i => i.invoice_number === inv1).status = 'paid';
    ok(await call('PUT', `invoices/${inv}`, { notes: 'edited after payment' }));

    // a partner (his accounts are not in Zoho yet), 2400 mapped to an income account (wrong type), 1050 mapped to an account Zoho does not have
    const PA = ok(await call('POST', 'partners', { name: 'Partner Alpha' })).id;
    ok(await call('PUT', 'zoho/mapping', { kind: 'account', local_key: 'acct:2400', zoho_id: '3004' }));
    ok(await call('PUT', 'zoho/mapping', { kind: 'account', local_key: 'acct:1050', zoho_id: '9999999' }));
    zoho.T.bankaccounts.push({ account_id: '2003', account_name: 'Site Cash Box', account_type: 'cash', is_active: true });   // a second cash account: 1020 is no longer obvious
    // ---- the preflight: only GET requests reach the Books API, nothing changes in our send log either
    const logBefore = JSON.stringify(ctx.db.prepare('SELECT * FROM zoho_sync ORDER BY id').all()), mapBefore = JSON.stringify(ctx.db.prepare('SELECT * FROM zoho_map').all());
    const callsBefore = zoho.calls.length, rowsBefore = JSON.stringify(zoho.T);
    const d = ok(await call('POST', 'zoho/dry-run', RANGE)), pf = d.preflight;
    const during = zoho.calls.slice(callsBefore);
    assert.ok(during.length > 3, 'it read from Zoho'); assert.deepEqual(during.filter(c => !/^GET /.test(c)), [], 'no POST / PUT / DELETE reached the Books API');
    assert.equal(JSON.stringify(zoho.T), rowsBefore, 'nothing changed in Zoho');
    assert.equal(JSON.stringify(ctx.db.prepare('SELECT * FROM zoho_sync ORDER BY id').all()), logBefore, 'nothing changed in our send log');
    assert.equal(JSON.stringify(ctx.db.prepare('SELECT * FROM zoho_map').all()), mapBefore);
    out.push(`preflight: ${during.length} GET requests, no write in Zoho or in the send log`);

    // organisation, data centre, mappings, what is already synced
    assert.equal(pf.read_only, true); assert.equal(pf.offline, false);
    assert.equal(pf.organization.id, zoho.ORG); assert.equal(pf.organization.name, 'Trigon Civil Road Contracting'); assert.equal(pf.organization.currency, 'AED');
    assert.equal(pf.data_centre, 'ae'); assert.ok(pf.api_host);
    assert.ok(pf.mappings.some(m => m.kind === 'account' && m.local_key === 'acct:5200' && m.zoho_id === '3101'));
    assert.ok(pf.mappings.some(m => m.kind === 'project' && m.zoho_id === 'project:8001'));
    assert.ok(pf.synced.some(r => r.kind === 'invoice' && r.status === 'ok' && r.n >= 1), 'invoices already synced are counted');
    // per record: unchanged / create / conflict / link, with the reason
    const item = (kind, ref) => pf.items.find(i => i.kind === kind && i.ref === ref);
    const n2 = ctx.db.prepare('SELECT number FROM invoices WHERE id=?').get(inv2).number;
    assert.equal(item('invoice', n2).action, 'create');
    assert.equal(item('invoice', n3).action, 'link'); assert.match(item('invoice', n3).why, /already exists in Zoho but is not in the send log/);
    assert.equal(item('invoice', inv1).action, 'conflict'); assert.match(item('invoice', inv1).why, /after it was paid in Zoho/);
    assert.ok(pf.conflicts.some(i => i.ref === n3) && pf.conflicts.some(i => i.ref === inv1), 'conflicts and possible duplicates listed together');
    assert.equal(item('contact', 'Emaar Test').action, 'unchanged', 'the client is already in Zoho');
    assert.ok(pf.items.some(i => i.kind === 'jv_advance' && i.action === 'unchanged'), 'the advance journal was sent before: left alone');
    assert.equal(pf.items.find(i => i.kind === 'payment' && i.local_id === rcpt).action, 'remove', 'a receipt deleted here would be removed from Zoho');
    const ch = pf.items.filter(i => i.kind === 'payment' && i.local_id === rc2).map(i => i.action); assert.deepEqual(ch, ['remove', 'create'], 'a changed receipt: removed and sent again');
    assert.ok(pf.plan.invoice.create >= 1 && pf.plan.invoice.link === 1 && pf.plan.invoice.conflict === 1);
    out.push(`plan: ${JSON.stringify(pf.plan.invoice)} invoices; conflicts ${pf.conflicts.length}`);
    // every Trigon account the sync uses, and how it resolves in Zoho
    const acc = code => pf.accounts.find(a => a.code === code);
    assert.equal(acc('5200').how, 'mapped'); assert.equal(acc('5200').zoho_name, 'Salaries and Employee Wages');
    assert.match(acc('2300').how, /^missing/); assert.ok(pf.missing_accounts.some(a => a.code === '2300'), 'the unmapped account is reported');
    assert.ok(d.errors.some(e => /map our account 2300/.test(e)));
    assert.equal(acc('1000').zoho_name, 'Emirates NBD', 'bank accounts are named too'); assert.match(acc('1100').how, /automatic/); assert.equal(acc('1100').zoho_name, 'Accounts Receivable');
    assert.match(acc('2100').how, /Standard Rate/); assert.ok(acc('4000'));
    out.push(`accounts: ${pf.accounts.length} Trigon accounts resolved, missing: ${pf.missing_accounts.map(a => a.code).join(', ')}`);

    // ---- readiness: connection, what is already synced, the accounts the proposed sync needs (by type, never by name), the verdict
    assert.equal(pf.connection.connected, true); assert.equal(pf.connection.organization_id, zoho.ORG); assert.equal(pf.connection.data_centre, 'ae'); assert.equal(pf.connection.uae, true);
    assert.equal(pf.connection.data_centre_ok, null, 'the mock is not a Zoho data centre: not judged');
    assert.ok(pf.already_synced.invoices.ok >= 1 && pf.already_synced.payments.ok >= 1 && pf.already_synced.payroll, 'grouped: invoices, payments, payroll');
    assert.equal(pf.summary.would_create, pf.items.filter(i => i.action === 'create').length); assert.equal(pf.summary.would_delete, 2); assert.equal(pf.summary.possible_duplicates, 1); assert.equal(pf.summary.conflicts, 1);
    const req = code => pf.required_accounts.find(a => a.code === code);
    for (const c of ['1000', '1010', '1020', '1030', '1050', '1200', '1300', '2000', '2050', '2100', '2200', '2260', '2300', '2400', '3100', '3900', '5200', '6200', '1600', '1690']) assert.ok(req(c), 'required: ' + c);
    assert.equal(req('5200').status, 'mapped'); assert.deepEqual([req('5200').zoho.id, req('5200').zoho.type], ['3101', 'expense']);
    assert.equal(req('2400').status, 'type_mismatch'); assert.match(req('2400').note, /Zoho type is income; expected other_current_liability/);
    assert.equal(req('1050').status, 'not_found');
    assert.equal(req('2300').status, 'missing'); assert.ok(req('2300').candidates.some(c => c.id === '3106'), 'accounts of the right type are offered, not chosen');
    assert.equal(req('1000').status, 'automatic', 'the only bank account'); assert.equal(req('1020').status, 'ambiguous'); assert.match(req('1020').note, /2 Zoho accounts of type cash — map the right one/); assert.equal(req('1100').status, 'automatic');
    assert.equal(req('1010').status, 'missing', 'no name matching: "Petty Cash" in Zoho is not taken for 1010');
    assert.equal(req('2100').status, 'mapped'); assert.equal(req('2100').zoho.type, 'tax');
    const pa = pf.partner_accounts.find(p => p.id === PA); assert.deepEqual(pa.accounts.map(a => [a.code, a.proposed, a.parent, a.status]),
      [['3000', 'Partner Alpha Capital', 'Partner Capital', 'missing'], ['2500', 'Partner Alpha Loan', 'Partner Loans', 'missing'], ['3110', 'Partner Alpha Current', 'Partner Current Accounts', 'missing']]);
    assert.equal(pf.verdict, 'BLOCKED');
    for (const re of [/2400 Advances from customers: mapped to "Sales" — Zoho type is income/, /1050 .*does not exist/, /1 conflict/, /1 possible duplicate/]) assert.ok(pf.blockers.some(b => re.test(b)), 'blocker: ' + re);
    assert.ok(pf.to_configure.some(t => /^Partner Partner Alpha Current: create a Zoho account of type equity under the parent account "Partner Current Accounts"/.test(t)));
    assert.ok(pf.to_configure.some(t => /^2300 End-of-service provision: create \(or choose\) a Zoho account of type long_term_liability/.test(t)));
    out.push(`readiness: verdict ${pf.verdict}, ${pf.blockers.length} blocker(s), ${pf.to_configure.length} item(s) to configure`);

    // the read-only client refuses any write before it is sent
    const c = ctx.db.prepare("SELECT key, value FROM zoho_config").all().reduce((o, r) => (o[r.key] = r.value, o), {});
    const ro = Z.createClient({ accounts: zoho.accountsUrl, client_id: zoho.CLIENT_ID, client_secret: zoho.CLIENT_SECRET, refresh_token: c.refresh_token, api_domain: c.api_domain, org: zoho.ORG, readOnly: true });
    const k = zoho.calls.length;
    for (const [m, f] of [['POST', () => ro.post('/invoices', {})], ['PUT', () => ro.put('/invoices/1', {})], ['DELETE', () => ro.del('/journals/1')]]) await assert.rejects(f, /read-only \(dry run\)/, m);
    assert.ok(await ro.get('/settings/taxes'), 'reads still work');
    assert.deepEqual(zoho.calls.slice(k), ['GET /settings/taxes'], 'the refused writes never reached Zoho');
    out.push('read-only client: POST / PUT / DELETE refused before sending');

    // a real send afterwards still works and is not affected by the dry run
    const r = ok(await call('POST', 'zoho/sync', RANGE)); assert.ok(r.sent >= 1);
    assert.equal(zoho.T.invoices.filter(i => i.invoice_number === n3).length, 1, 'the existing Zoho invoice was linked, not created twice');
    // ---- the UAE data centre: the API domain must belong to it (checked without the mock override, nothing is sent)
    { const saved = process.env.ZOHO_ACCOUNTS_URL, dom = ctx.db.prepare("SELECT value FROM zoho_config WHERE key='api_domain'").get().value, setDom = v => ctx.db.prepare("UPDATE zoho_config SET value=? WHERE key='api_domain'").run(v);
      delete process.env.ZOHO_ACCOUNTS_URL;
      try {
        setDom('https://www.zohoapis.ae'); let k = ctx.zohoConnection();
        assert.deepEqual([k.data_centre_ok, k.accounts_url, k.api_base_url], [true, 'https://accounts.zoho.ae', 'https://www.zohoapis.ae/books/v3']);
        setDom('https://www.zohoapis.com'); k = ctx.zohoConnection();
        assert.equal(k.data_centre_ok, false); assert.match(k.note, /does not belong to the ae data centre \(expected https:\/\/www\.zohoapis\.ae\)/);
        // the office's organisation is on the .com data centre (ZOHO_DC=com): accounts.zoho.com + www.zohoapis.com belong together
        const dc0 = process.env.ZOHO_DC; process.env.ZOHO_DC = 'com';
        try { k = ctx.zohoConnection(); assert.deepEqual([k.data_centre_ok, k.accounts_url, k.api_base_url, k.uae, k.credentials.dc, k.credentials.dc_source], [true, 'https://accounts.zoho.com', 'https://www.zohoapis.com/books/v3', false, 'com', '.env']); }
        finally { if (dc0 === undefined) delete process.env.ZOHO_DC; else process.env.ZOHO_DC = dc0; }
      } finally { process.env.ZOHO_ACCOUNTS_URL = saved; setDom(dom); }
      out.push('data centre: ae ↔ zohoapis.ae, com ↔ zohoapis.com accepted; a mismatch refused');
    }

    // ---- the Windows script: its own guard decides every request before it is sent
    const { decide } = require('./scripts/zoho-preflight.js');
    const BOOKS = 'https://www.zohoapis.ae/books/v3/invoices?organization_id=1';
    assert.equal(decide(BOOKS, { method: 'GET' }), 'read');
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(decide(BOOKS, { method: m }), 'BLOCKED', m);
    assert.equal(decide('https://accounts.zoho.ae/oauth/v2/token', { method: 'POST', body: 'grant_type=refresh_token&refresh_token=x' }), 'access token');
    assert.equal(decide('https://accounts.zoho.ae/oauth/v2/token', { method: 'POST', body: 'grant_type=authorization_code&code=x' }), 'BLOCKED', 'no new connection');
    assert.equal(decide('https://accounts.zoho.ae/oauth/v2/token/revoke?token=x', { method: 'POST' }), 'BLOCKED', 'no revoke');
    assert.equal(decide('https://graph.microsoft.com/v1.0/me', { method: 'GET' }), 'BLOCKED', 'nothing but Zoho');
    // the script itself, on a copy of this database, against the mock: confirms, runs, writes the report and the request log
    const { spawn } = require('child_process');   // not spawnSync: the Zoho mock answers from this same process
    const spawnAsync = (args, opts) => new Promise(res => { const c = spawn(process.execPath, args, opts); let stdout = '', stderr = ''; c.stdout.on('data', d => stdout += d); c.stderr.on('data', d => stderr += d); c.on('close', status => res({ status, stdout, stderr })); });
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-zohopre-copy-')), dataCopy = path.join(copy, 'data'); fs.mkdirSync(dataCopy);
    ctx.db.exec(`VACUUM INTO '${path.join(dataCopy, 'erp.db').replace(/'/g, "''")}'`);
    const env = { ...process.env, ZOHO_ACCOUNTS_URL: zoho.accountsUrl, DATA_DIR: '' }, callsB = zoho.calls.length;
    const run = await spawnAsync(['--no-warnings', 'scripts/zoho-preflight.js', '--data', dataCopy, '--yes', '--from', '2026-11-01', '--to', '2026-12-31', '--out', path.join(copy, 'report')], { env });
    assert.equal(run.status, 2, 'BLOCKED → exit code 2\n' + run.stdout + run.stderr);
    assert.match(run.stdout, new RegExp(`Organisation ID: +${zoho.ORG}`)); assert.match(run.stdout, /Data centre: +ae \(UAE\)/); assert.match(run.stdout, /Organisation name: Trigon Civil Road Contracting/);
    assert.match(run.stdout, /0 modifying call\(s\) sent, 0 refused by the guard; Trigon copy unchanged: yes/); assert.match(run.stdout, /VERDICT: BLOCKED/);
    assert.deepEqual(zoho.calls.slice(callsB).filter(c => !/^GET /.test(c)), [], 'the real run made zero modifying calls on the Books API');
    const rep = JSON.parse(fs.readFileSync(path.join(copy, 'report', 'preflight-report.json'), 'utf8'));
    assert.equal(rep.proof.modifying_calls_sent, 0); assert.deepEqual(rep.proof.books_methods, ['GET']); assert.ok(rep.proof.access_token_requests <= 1); assert.equal(rep.proof.local_copy_unchanged, true);
    const log = fs.readFileSync(path.join(copy, 'report', 'request-log.csv'), 'utf8').trim().split('\n').slice(1).map(l => l.split(','));
    assert.ok(log.length >= 5 && log.every(([, m, , p, d]) => (m === 'GET' && d === 'read') || (m === 'POST' && p === '/oauth/v2/token' && d === 'access token')), 'request log: reads and the access token only');
    assert.ok(!/refresh_token|access_token|Zoho-oauthtoken/.test(fs.readFileSync(path.join(copy, 'report', 'request-log.csv'), 'utf8')), 'no token in the log');
    const html = fs.readFileSync(path.join(copy, 'report', 'preflight-report.html'), 'utf8');
    for (const t of ['Verdict: BLOCKED', 'Proof: zero modifying calls', 'Partner Alpha Capital', 'Partner Current Accounts', 'type mismatch', 'Already synced', 'Account provisioning preview (read only — nothing was created)', 'POST /chartofaccounts']) assert.ok(html.includes(t), 'report: ' + t);
    assert.match(run.stdout, /Account provisioning preview \(nothing created\): \w+ — ADOPT_EXISTING \d+ · ADOPT_EXISTING_AFTER_CONFIRMATION \d+ · SYSTEM_ACCOUNT_ADOPT \d+ · CREATE_APPROVED \d+ · VAT_CONFIGURATION_REQUIRED \d+ · ACCOUNT_CONFLICT \d+ · AMBIGUOUS \d+ · BLOCKED \d+/);
    assert.match(run.stdout, /Targets before synchronisation: missing mappings \d+ · wrong types \d+ · ambiguous matches \d+ · blocking conflicts \d+ \(each must be 0\)/);
    assert.ok(html.includes('Proposed creation payload (not sent)') && html.includes('Targets before synchronisation'));
    // every CREATE_APPROVED account in the console: code, name, type, parent; the VAT diagnostic; the three decisions
    const muts = rep.account_provisioning_preview.mutations; assert.match(run.stdout, new RegExp(`CREATE_APPROVED — exact account-creation payloads \\(${muts.length}, NOT sent\\)`));
    for (const m of muts) assert.ok(run.stdout.includes(m.body.account_code.padEnd(10) + ' ' + m.body.account_name), 'console: ' + m.body.account_code);
    assert.match(run.stdout, /1690 +Accumulated Depreciation +type fixed_asset +parent Fixed Assets \(created first, in the same run\)/);
    assert.match(run.stdout, /VAT diagnostic \(read only\): UAE VAT enabled: /); assert.match(run.stdout, /active Standard 5%: Standard Rate \(id 1001\)/); assert.match(run.stdout, /input VAT control: /);
    for (const c of ['3100 Retained Earnings → the exact Zoho system account', '1690 Accumulated Depreciation → contra-asset under 1600', '6150 Gain / Loss on Asset Disposal → deferred (separate gain / loss treatment)']) assert.ok(run.stdout.includes(c), c);
    for (const t of ['CREATE_APPROVED — exact account-creation payloads', 'Accounting decisions', 'VAT diagnostic (read only']) assert.ok(html.includes(t), 'html: ' + t);
    assert.match(run.stdout, /Non-VAT targets \(READY_NON_VAT\): missing mappings \d+ · wrong types \d+ · ambiguous matches \d+ · blocking conflicts \d+ \(each must be 0\) · VAT: VAT_\w+/);
    assert.match(run.stdout, /Deferred by accounting decision \(not counted; its transactions are held\): 6150/); assert.ok(!muts.some(m => m.body.account_code === '6150'), '6150 never in the creation list');
    assert.ok(rep.account_provisioning_preview && Array.isArray(rep.account_provisioning_preview.mutations) && rep.account_provisioning_preview.mutations.length > 0, 'the preview lists what would be created');
    assert.ok(!zoho.calls.slice(callsB).some(c => /^POST \/chartofaccounts/.test(c)), 'and nothing was created');
    // refuses a folder without a database (and so never creates one)
    const bad = await spawnAsync(['--no-warnings', 'scripts/zoho-preflight.js', '--data', path.join(copy, 'nothing'), '--yes'], { env });
    assert.equal(bad.status, 3); assert.match(bad.stderr, /No erp\.db/); assert.ok(!fs.existsSync(path.join(copy, 'nothing')));
    out.push(`Windows script: ${log.length} request(s) logged — Books: GET only; verdict BLOCKED; report and request log written`);
    // credentials are reported as set / missing with their source — never their values
    assert.match(run.stdout, /ZOHO_CLIENT_ID: +set \(Windows environment — overrides \.env\)/); assert.match(run.stdout, /Zoho refresh credential: +set \(database\)/);
    assert.match(run.stdout, /ZOHO_DC: +ae \(/); assert.match(run.stdout, /organization_id: +set/); assert.match(run.stdout, /Network: Node v\d+/);
    for (const s of [zoho.CLIENT_ID, zoho.CLIENT_SECRET, 'rt-', 'at-']) assert.ok(!run.stdout.includes(s) && !run.stderr.includes(s) && !JSON.stringify(rep.sign_in).includes(s), 'no secret printed: ' + s);
    assert.equal(rep.sign_in.result.kind, 'ok'); assert.ok(log.every(l => /^HTTP \d{3}$/.test(l[5])), 'request log: outcome of every request');
    // a revoked refresh token: the run stops after the access-token request with a diagnosis — nothing is read from Books, nothing written
    { const callsR = zoho.calls.length, bad = '1000.revokedrefresh00000000.00000000';
      const r2 = await spawnAsync(['--no-warnings', 'scripts/zoho-preflight.js', '--data', dataCopy, '--yes', '--out', path.join(copy, 'report-revoked')], { env: { ...env, ZOHO_REFRESH_TOKEN: bad } });
      assert.equal(r2.status, 2, r2.stdout + r2.stderr); assert.match(r2.stdout, /Access-token request FAILED/); assert.match(r2.stdout, /kind: +oauth_rejected/); assert.match(r2.stdout, /OAuth error: +invalid_code/);
      assert.match(r2.stdout, /HTTP status: +200/); assert.match(r2.stdout, /refresh token is invalid, revoked/); assert.match(r2.stdout, /1 Zoho Books read\(s\), 1 access-token request\(s\), 0 modifying call\(s\) sent/); assert.match(r2.stdout, /Connectivity probe: HTTP 401/); assert.match(r2.stdout, /FAILED — OAuth rejection/);
      assert.match(r2.stdout, /Trigon copy unchanged: yes/); assert.match(r2.stdout, /VERDICT: BLOCKED — OAuth rejection; nothing else was read/); assert.match(r2.stdout, /Zoho refresh credential: +set \(Windows environment/);
      const d = fs.readFileSync(path.join(copy, 'report-revoked', 'signin-diagnostics.json'), 'utf8');
      for (const s of [bad, zoho.CLIENT_ID, zoho.CLIENT_SECRET]) assert.ok(!(r2.stdout + r2.stderr + d).includes(s), 'no secret printed or saved: ' + s);
      assert.equal(JSON.parse(d).result.oauth_error, 'invalid_code'); assert.deepEqual(zoho.calls.slice(callsR), [], 'no Books request at all'); }
    // a sign-in server that cannot be reached: network failure with Node's cause code
    { const tmp = require('http').createServer(); await new Promise(r => tmp.listen(0, '127.0.0.1', r)); const p = tmp.address().port; await new Promise(r => tmp.close(r));
      const r3 = await spawnAsync(['--no-warnings', 'scripts/zoho-preflight.js', '--data', dataCopy, '--yes', '--out', path.join(copy, 'report-down')], { env: { ...env, ZOHO_ACCOUNTS_URL: `http://127.0.0.1:${p}` } });
      assert.equal(r3.status, 2, r3.stdout + r3.stderr); assert.match(r3.stdout, /Access-token request FAILED/); assert.match(r3.stdout, /kind: +network/); assert.match(r3.stdout, /cause code: +ECONNREFUSED/);
      assert.match(r3.stdout, /HTTP status: +— \(no answer\)/); assert.match(fs.readFileSync(path.join(copy, 'report-down', 'request-log.csv'), 'utf8'), /access token,failed ECONNREFUSED/); }
    // a .env saved with a BOM (PowerShell 5.1 Set-Content -Encoding UTF8): stopped before anything is sent
    { const app = path.join(copy, 'app'); fs.mkdirSync(app);
      for (const f of ['server.js', 'package.json', 'lib', 'modules', 'scripts', 'public']) fs.cpSync(f, path.join(app, f), { recursive: true });
      fs.symlinkSync(path.resolve('node_modules'), path.join(app, 'node_modules'), 'junction');
      fs.writeFileSync(path.join(app, '.env'), Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('ZOHO_CLIENT_ID=1000.X\r\nZOHO_DC=ae\r\n')]));
      const callsE = zoho.calls.length, r4 = await spawnAsync(['--no-warnings', path.join(app, 'scripts', 'zoho-preflight.js'), '--data', dataCopy, '--yes'], { env, cwd: app });
      assert.equal(r4.status, 3, r4.stdout + r4.stderr); assert.match(r4.stdout, /\.env of this program folder: utf-8 with BOM, CRLF line endings; settings read: ZOHO_CLIENT_ID \(unreadable: BOM\)/); assert.match(r4.stdout, /✖ \.env starts with a byte-order mark.*ZOHO_CLIENT_ID/);
      assert.match(r4.stderr, /not read correctly .* nothing was sent/); assert.ok(!/access-token request/i.test(r4.stdout.split('Network:')[1] || ''), 'stopped before the token request'); assert.deepEqual(zoho.calls.slice(callsE), []); }
    out.push('Windows script: credentials shown as set / missing; revoked refresh token and unreachable sign-in server diagnosed; a BOM .env stops the run before anything is sent');
    // the probe, timings and the sanitized request target on a normal run
    assert.match(run.stdout, /Time limits: connect \(DNS \+ TCP \+ TLS\) 30000 ms, first response 30000 ms, whole request 60000 ms \(default\)/);
    assert.match(run.stdout, /Connectivity probe: HTTP 401 from 127\.0\.0\.1:\d+ in \d+ ms \(1 attempt\)/);
    assert.match(run.stdout, /request: +GET 127\.0\.0\.1\/books\/v3\/organizations · organization_id not sent · Authorization none/);
    assert.match(run.stdout, /request: +GET 127\.0\.0\.1\/books\/v3\/organizations · organization_id not sent · Authorization token \(hidden\)/);
    assert.match(run.stdout, /timing: +HTTP 401 · connection new · DNS \+ TCP \+ TLS \d+ ms · first response \d+ ms · total \d+ ms/);
    assert.match(run.stdout, /Access token: received \(not shown\)/); assert.deepEqual(rep.sign_in.limits.connect_ms, 30000); assert.equal(rep.sign_in.probe.http_status, 401);
    assert.ok(log.some(l => l[6] === 'set' && l[7] === 'token (hidden)'), 'request log: organization_id set / token hidden'); assert.ok(log.every(l => l[11] !== ''), 'request log: total time of every request');
    // connect timeouts on the Books host, simulated under the script's own guard (the guard still decides and logs every attempt)
    { const hook = path.join(copy, 'connect-timeout-hook.js');
      fs.writeFileSync(hook, `const f = globalThis.fetch; let n = 0; const fail = +process.env.HOOK_FAIL_BOOKS;
globalThis.fetch = async (url, o) => { if (new URL(String(url)).pathname.startsWith('/books/') && (!process.env.HOOK_ONLY_AUTH || (o && o.headers && o.headers.Authorization)) && ++n <= fail) throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('Connect Timeout Error (attempted address: www.zohoapis.com:443, timeout: 30000ms)'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) }); return f(url, o); };`);
      const books = r => fs.readFileSync(path.join(r, 'request-log.csv'), 'utf8').trim().split('\n').slice(1).map(l => l.split(','));
      // first Books GET times out on connect, the retry succeeds, the run completes — read only
      const callsA = zoho.calls.length, rA = await spawnAsync(['--no-warnings', '--require', hook, 'scripts/zoho-preflight.js', '--data', dataCopy, '--yes', '--from', '2026-11-01', '--to', '2026-12-31', '--out', path.join(copy, 'report-retry')], { env: { ...env, HOOK_FAIL_BOOKS: '1', ZOHO_PREFLIGHT_TIMEOUT_MS: '45000' } });
      assert.equal(rA.status, 2, rA.stdout + rA.stderr); assert.match(rA.stdout, /Connectivity probe: HTTP 401 .* \(2 attempts\)/); assert.match(rA.stdout, /connect \(DNS \+ TCP \+ TLS\) 45000 ms.*\(ZOHO_PREFLIGHT_TIMEOUT_MS\)/);
      assert.match(rA.stdout, /Organisation name: Trigon Civil Road Contracting/); assert.match(rA.stdout, /0 modifying call\(s\) sent, 0 refused by the guard; Trigon copy unchanged: yes/);
      const la = books(path.join(copy, 'report-retry')); assert.equal(la[0][5], 'failed UND_ERR_CONNECT_TIMEOUT'); assert.equal(la[1][5], 'HTTP 401'); assert.ok(la.every(([, m, , p, d]) => (m === 'GET' && d === 'read') || (m === 'POST' && p === '/oauth/v2/token' && d === 'access token')));
      assert.deepEqual(zoho.calls.slice(callsA).filter(c => !/^GET /.test(c)), [], 'Books: GET only');
      const repA = JSON.parse(fs.readFileSync(path.join(copy, 'report-retry', 'preflight-report.json'), 'utf8')); assert.equal(repA.proof.modifying_calls_sent, 0); assert.deepEqual(repA.proof.books_methods, ['GET']);
      // both attempts time out: classified, stopped before the token and the organisation, two attempts only
      const callsB2 = zoho.calls.length, rB = await spawnAsync(['--no-warnings', '--require', hook, 'scripts/zoho-preflight.js', '--data', dataCopy, '--yes', '--out', path.join(copy, 'report-timeout')], { env: { ...env, HOOK_FAIL_BOOKS: '99' } });
      assert.equal(rB.status, 2, rB.stdout + rB.stderr); assert.match(rB.stdout, /Connectivity probe to Zoho Books FAILED — TCP \/ TLS connect timeout/); assert.match(rB.stdout, /timeout type: +connect/); assert.match(rB.stdout, /attempts: +2/);
      assert.match(rB.stdout, /cause code: +UND_ERR_CONNECT_TIMEOUT/); assert.match(rB.stdout, /2 Zoho Books read\(s\), 0 access-token request\(s\), 0 modifying call\(s\) sent, 0 refused by the guard; Trigon copy unchanged: yes/);
      assert.match(rB.stdout, /VERDICT: BLOCKED — TCP \/ TLS connect timeout/); assert.deepEqual(zoho.calls.slice(callsB2), []);
      const lb = books(path.join(copy, 'report-timeout')); assert.deepEqual(lb.map(l => [l[1], l[4], l[5]]), [['GET', 'read', 'failed UND_ERR_CONNECT_TIMEOUT'], ['GET', 'read', 'failed UND_ERR_CONNECT_TIMEOUT']]);
      // the probe works, then GET /organizations times out on both attempts: the step and the class are named
      const rC = await spawnAsync(['--no-warnings', '--require', hook, 'scripts/zoho-preflight.js', '--data', dataCopy, '--yes', '--out', path.join(copy, 'report-org-timeout')], { env: { ...env, HOOK_FAIL_BOOKS: '99', HOOK_ONLY_AUTH: '1' } });
      assert.equal(rC.status, 2, rC.stdout + rC.stderr); assert.match(rC.stdout, /Connectivity probe: HTTP 401 .* \(1 attempt\)/); assert.match(rC.stdout, /GET \/organizations FAILED — TCP \/ TLS connect timeout/);
      assert.match(rC.stdout, /3 Zoho Books read\(s\), 1 access-token request\(s\), 0 modifying call\(s\) sent/); assert.match(rC.stdout, /attempts: +2/);
      out.push('Windows script: Books connect timeout → retried once and the run completes; both attempts time out → "TCP / TLS connect timeout", stopped, 0 modifying calls'); }

    console.log(out.map(x => '  ✔ ' + x).join('\n'));
    console.log('ZOHO PREFLIGHT TESTS PASSED');
  } finally { server.close(); zoho.srv.close(); }
});
