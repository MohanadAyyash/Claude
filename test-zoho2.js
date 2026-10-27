// Phase 5 Zoho: keys from .env, dry run, account / project mapping, payroll + end-of-service + advance journals: node --no-warnings test-zoho2.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-zoho2-'));
process.env.ZOHO_NO_SCHEDULER = '1'; process.env.SALES_NO_SCHEDULER = '1';
const mockZoho = require('./tools/zoho-mock.js');
const zoho = mockZoho();
process.env.ZOHO_CLIENT_ID = zoho.CLIENT_ID; process.env.ZOHO_CLIENT_SECRET = zoho.CLIENT_SECRET;      // as the office PC's .env would
const { server } = require('./server.js');

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

    // ---- 1. keys from .env: shown as set, never returned, cannot be changed from the screen
    const st = ok(await call('GET', 'zoho'));
    assert.match(st.config.env, /client_id/); assert.match(st.config.env, /client_secret/); assert.equal(st.config.secret_set, '1');
    assert.ok(!JSON.stringify(st).includes(zoho.CLIENT_SECRET), 'secret never sent to the browser');
    ok(await call('PUT', 'zoho/config', { client_secret: 'typed-on-screen', client_id: 'other' }));
    assert.equal(ok(await call('GET', 'zoho')).config.client_id, zoho.CLIENT_ID, '.env wins');
    out.push('keys from .env: used, hidden from the browser, not changeable from the screen');

    // ---- 2. dry run before connecting: offline, nothing written anywhere
    const d0 = ok(await call('POST', 'zoho/dry-run', { from: '2026-11-01', to: '2026-12-31' }));
    assert.equal(d0.offline, true); assert.equal(writes(), 0); assert.equal(ok(await call('GET', 'zoho/log')).length, 0);
    assert.ok(d0.ops.some(o => o.path === '/invoices'), 'invoice would be sent'); assert.ok(d0.errors.some(e => /map our account/.test(e)), 'journals need account mapping');
    out.push(`dry run (not connected): ${d0.ops.length} operations listed, 0 sent, journals report the missing account mapping`);

    // ---- 3. connect with a grant code (client from .env)
    ok(await call('POST', 'zoho/connect', { code: '1000.code.one' }));
    ok(await call('PUT', 'zoho/config', { enabled: '1', start: '2026-11-01', post: '0' }));

    // ---- 4. mapping: accounts, project → reporting-tag option / Zoho project
    const mp = ok(await call('GET', 'zoho/mapping'));
    assert.ok(mp.zoho.accounts.length > 5); assert.equal(mp.zoho.tags[0].options.length, 2); assert.equal(mp.zoho.projects[0].id, '8001');
    for (const [k, z] of [['acct:5200', '3101'], ['acct:6200', '3101'], ['acct:2200', '3102'], ['acct:2250', '3104'], ['acct:1300', '3103'], ['acct:5260', '3105'], ['acct:2300', '3106']]) ok(await call('PUT', 'zoho/mapping', { kind: 'account', local_key: k, zoho_id: z }));
    ok(await call('PUT', 'zoho/mapping', { kind: 'project', local_key: A, zoho_id: 'tag:7001:7101' }));
    ok(await call('PUT', 'zoho/mapping', { kind: 'project', local_key: B, zoho_id: 'project:8001' }));

    // ---- 5. dry run when connected: real reads, still no writes
    const before = writes(), d1 = ok(await call('POST', 'zoho/dry-run', RANGE));
    assert.equal(d1.offline, false); assert.equal(writes(), before); assert.equal(d1.failed, 0, JSON.stringify(d1.errors));
    const jp = d1.payloads.find(p => p.path === '/journals' && p.body.reference_number === 'PAY-2026-11');
    assert.ok(jp, 'payroll journal planned');
    out.push(`dry run (connected): ${d1.ops.length} operations, 0 written in Zoho`);

    // ---- 6. real send: invoice tagged with its project, journals balanced and split by project
    const r = ok(await call('POST', 'zoho/sync', RANGE));
    assert.equal(r.failed, 0, r.message);
    const zi = zoho.T.invoices[0]; assert.deepEqual(zi.line_items[0].tags, [{ tag_id: '7001', tag_option_id: '7101' }]);
    const J = ref => zoho.T.journals.filter(j => j.reference_number === ref);
    const pay = J('PAY-2026-11'); assert.equal(pay.length, 2, 'accrual + paid');
    const accr = pay.find(j => j.line_items.some(l => l.account_id === '3101')), lines = accr.line_items;
    const sal = lines.filter(l => l.account_id === '3101');
    assert.deepEqual(sal.map(l => [l.amount, l.tags || l.project_id || null]), [[2000, [{ tag_id: '7001', tag_option_id: '7101' }]], [1000, '8001'], [6000, null]]);
    assert.equal(lines.find(l => l.account_id === '3103').amount, 300, 'advance instalment credited to employee advances');
    const paid = pay.find(j => j !== accr); assert.equal(paid.journal_date, '2026-12-02'); assert.equal(paid.line_items.find(l => l.debit_or_credit === 'credit').account_id, '2001');
    const eos = J('EOS-2026-11')[0]; assert.ok(eos); assert.equal(eos.line_items.find(l => l.account_id === '3106').amount, round2(3000 / 30 * 21 / 12 + 6000 / 30 * 21 / 12));
    const adv = zoho.T.journals.find(j => /^ADV-/.test(j.reference_number)); assert.equal(adv.line_items.find(l => l.debit_or_credit === 'credit').account_id, '2002', 'cash advance from petty cash');
    out.push(`sent: invoice tagged “Villa 12”; payroll journal 2,000 (tag Villa 12) + 1,000 (Zoho project) + 6,000 head office; salaries paid; EOS provision; advance from cash`);
    // idempotent
    const n = zoho.T.journals.length; ok(await call('POST', 'zoho/sync', RANGE)); assert.equal(zoho.T.journals.length, n, 'nothing sent twice');
    const log = ok(await call('GET', 'zoho/log')); assert.ok(log.some(l => l.kind === 'jv_payroll' && l.status === 'ok'));
    out.push('second run sends nothing again; journals in the send log');
    // the secret never in the log tables or audit
    const all = JSON.stringify([log, ok(await call('GET', 'zoho')).runs]); assert.ok(!all.includes(zoho.CLIENT_SECRET));
    console.log(out.map(x => '✔ ' + x).join('\n'));
    console.log('ZOHO PHASE 5 TESTS PASSED');
  } catch (e) { console.log(out.map(x => '✔ ' + x).join('\n')); console.error('FAIL', e); process.exitCode = 1; }
  finally { server.close(); zoho.srv.close(); setTimeout(() => process.exit(process.exitCode || 0), 100); }
});
function round2(n) { return Math.round(n * 100) / 100; }
