// Health endpoint, error log and integrity checks: node --no-warnings test-health.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert'), { execFileSync } = require('child_process');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-health-'));
process.env.ZOHO_NO_SCHEDULER = '1'; process.env.SALES_NO_SCHEDULER = '1';
const { server, ctx } = require('./server.js');

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api/`; let cookie = '';
  const call = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; return { s: r.status, j: await r.json().catch(() => null) }; };
  const check = (rep, id) => rep.results.find(r => r.id === id);
  try {
    // health: public, no data
    const h = await call('GET', 'health');
    assert.equal(h.s, 200); assert.equal(h.j.ok, true); assert.equal(h.j.db, 'ok');
    assert.deepEqual(Object.keys(h.j).sort(), ['db', 'ok', 'time', 'uptime_s']);
    console.log('✔ /api/health is public and returns only status');

    await call('POST', 'setup', { username: 'admin', password: 'secret12', company: 'Trigon' });
    await call('PUT', 'settings', { trn: '100123456700003' });
    const cl = (await call('POST', 'parties', { type: 'client', name: 'Client', trn: '100234567800003', address: 'Dubai' })).j.id;
    const p = (await call('POST', 'projects', { name: 'P', client_id: cl })).j.id;
    const i1 = (await call('POST', 'invoices', { project_id: p, items: [{ description: 'Works', qty: 1, rate: 1000 }] })).j.id;
    assert.ok(i1, 'invoice created');
    assert.equal((await call('POST', 'payments', { kind: 'in', date: '2026-01-10', amount: 500, invoice_id: i1 })).s, 200);

    // clean data: everything passes
    let rep = (await call('GET', 'ops/checks')).j;
    assert.equal(rep.status, 'ok', JSON.stringify(rep.results.filter(r => r.status !== 'ok')));
    assert.equal(check(rep, 'trial_balance').status, 'ok');
    console.log('✔ integrity checks pass on clean data');

    // admin only
    assert.equal((await call('POST', 'users', { username: 'acc1', password: 'pass1234', role: 'accountant' })).s, 200);
    const admin = cookie; cookie = ''; await call('POST', 'login', { username: 'acc1', password: 'pass1234' });
    assert.equal((await call('GET', 'ops/checks')).s, 403); assert.equal((await call('GET', 'ops/errors')).s, 403);
    cookie = admin;
    console.log('✔ ops endpoints are administrator only');

    // break things directly in the database and see each check catch it
    const db = ctx.db, yr = new Date().getFullYear();
    db.prepare("INSERT INTO journal_entries(date,memo,lines) VALUES('2026-01-01','bad',?)").run(JSON.stringify([{ account: '1000', debit: 100, credit: 0 }, { account: '3000', debit: 0, credit: 90 }]));
    db.prepare("INSERT INTO invoices(number,date,project_id,items) VALUES(?, '2026-01-01', ?, '[]')").run(`INV-${yr}-005`, p);
    db.prepare("INSERT INTO invoices(number,date,project_id,items) VALUES(?, '2026-01-01', ?, 'not json')").run(`INV-${yr}-005`, p);
    db.prepare("INSERT INTO payments(kind,date,amount,invoice_id) VALUES('in','2026-01-01',10,99999)").run();
    rep = (await call('GET', 'ops/checks')).j;
    assert.equal(rep.status, 'fail');
    assert.equal(check(rep, 'manual_journals').status, 'fail'); assert.deepEqual(check(rep, 'manual_journals').items, ['JV-1']);
    assert.equal(check(rep, 'trial_balance').status, 'fail');
    assert.equal(check(rep, 'invoice_numbers').status, 'fail'); assert.deepEqual(check(rep, 'invoice_numbers').items, [`INV-${yr}-005`]);
    assert.equal(check(rep, 'invoice_items').status, 'fail');
    assert.equal(check(rep, 'payment_links').status, 'fail');
    assert.equal(check(rep, 'db_integrity').status, 'ok');
    console.log('✔ checks catch unbalanced journal, trial balance, duplicate number, corrupt items, orphan payment');

    // gaps alone are a warning
    db.prepare("DELETE FROM invoices WHERE number=?").run(`INV-${yr}-005`);
    db.prepare("INSERT INTO invoices(number,date,project_id,items) VALUES(?, '2026-01-01', ?, '[]')").run(`INV-${yr}-004`, p);
    const g = check((await call('GET', 'ops/checks')).j, 'invoice_numbers');
    assert.equal(g.status, 'warn'); assert.deepEqual(g.items, [`INV-${yr}-002`, `INV-${yr}-003`]);
    console.log('✔ numbering gaps are reported as a warning');

    // error log: unexpected errors are recorded without query strings
    ctx.logError(new Error('boom'), { method: 'GET', url: '/api/x/5?token=secret' });
    const errs = (await call('GET', 'ops/errors')).j;
    assert.equal(errs[0].message, 'boom'); assert.equal(errs[0].path, '/api/x/5');
    const e24 = check((await call('GET', 'ops/checks')).j, 'errors_24h');
    assert.equal(e24.status, 'warn'); assert.match(e24.items[0], /boom/);
    console.log('✔ errors are logged (path without query string) and reported');

    // command-line daily check: report file + exit code 1 on failure
    let code = 0;
    try { execFileSync(process.execPath, ['--no-warnings', 'scripts/daily-check.js'], { env: process.env, stdio: 'pipe' }); } catch (e) { code = e.status; }
    assert.equal(code, 1);
    const files = fs.readdirSync(path.join(process.env.DATA_DIR, 'ops'));
    assert.equal(files.length, 1); assert.match(files[0], /^check-\d{4}-\d{2}-\d{2}\.json$/);
    console.log('✔ scripts/daily-check.js writes the report and exits 1 on failure');
    console.log('HEALTH TESTS PASSED');
  } catch (e) { console.error('FAIL', e); process.exitCode = 1; }
  finally { server.close(); setTimeout(() => process.exit(process.exitCode || 0), 100); }
});
