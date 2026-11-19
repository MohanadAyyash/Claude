// Zoho preflight: a dry run against the connected organisation that writes nothing and reports what would happen: node --no-warnings test-zohopreflight.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-zohopre-'));
process.env.ZOHO_NO_SCHEDULER = '1'; process.env.SALES_NO_SCHEDULER = '1';
const mockZoho = require('./tools/zoho-mock.js');
const zoho = mockZoho();
process.env.ZOHO_CLIENT_ID = zoho.CLIENT_ID; process.env.ZOHO_CLIENT_SECRET = zoho.CLIENT_SECRET;      // as the office PC's .env would
const { server, ctx } = require('./server.js');
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
    console.log(out.map(x => '  ✔ ' + x).join('\n'));
    console.log('ZOHO PREFLIGHT TESTS PASSED');
  } finally { server.close(); zoho.srv.close(); }
});
