// Ageing (as of a date, buckets, retention apart) and statements of account for customers and suppliers: node --no-warnings test-statements.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-stmt-'));
const { server } = require('./server.js');

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api/`; let cookie = '';
  const call = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j, t }; };
  const ok = (r, m = '') => { assert.equal(r.s, 200, m + ' ' + JSON.stringify(r.j)); return r.j; };
  try {
    ok(await call('POST', 'setup', { username: 'admin', password: 'secret12', company: 'Trigon' }));
    ok(await call('PUT', 'settings', { trn: '100123456700003' }));
    const cl = ok(await call('POST', 'parties', { type: 'client', name: 'Al Waha Developments', trn: '100234567800003', address: 'Dubai South', email: 'ap@alwaha.test' })).id;
    const sup = ok(await call('POST', 'parties', { type: 'supplier', name: 'Emirates Safety Supplies' })).id;
    const p = ok(await call('POST', 'projects', { name: 'Internal Roads', client_id: cl, retention_pct: 10 })).id;
    const i1 = ok(await call('POST', 'invoices', { project_id: p, date: '2026-06-01', due_date: '2026-06-30', retention_pct: 10, items: [{ description: 'Works', qty: 1, rate: 100000 }] })).id;
    const i2 = ok(await call('POST', 'invoices', { project_id: p, date: '2026-09-15', due_date: '2026-10-15', retention_pct: 10, items: [{ description: 'Works', qty: 1, rate: 20000 }] })).id;
    ok(await call('POST', 'payments', { kind: 'in', date: '2026-07-10', amount: 50000, method: 'bank', reference: 'TT-77', invoice_id: i1 }));
    ok(await call('POST', 'payments', { kind: 'in', date: '2026-07-11', amount: 999, method: 'cheque', cheque_status: 'bounced', invoice_id: i1 }));   // bounced: ignored
    const b1 = ok(await call('POST', 'bills', { date: '2026-08-01', party_id: sup, description: 'PPE', amount: 10000, vat_amount: 500, reference: 'ESS-1' })).id;
    ok(await call('POST', 'payments', { kind: 'out', date: '2026-08-15', amount: 5000, method: 'bank', bill_id: b1 }));

    // ---- receivables ageing
    let a = ok(await call('GET', 'aging/receivable?as_of=2026-10-20')), r = a.rows[0];
    assert.equal(a.rows.length, 1); assert.equal(r.name, 'Al Waha Developments');
    assert.equal(r.d90p, 45000, '95,000 due − 50,000 paid, 112 days late'); assert.equal(r.d30, 19000, 'invoice 2, 5 days late'); assert.equal(r.current, 0);
    assert.equal(r.retention, 12000); assert.equal(r.total, 64000); assert.equal(a.totals.total, 64000);
    a = ok(await call('GET', 'aging/receivable?as_of=2026-07-01')); assert.equal(a.rows[0].d30, 95000); assert.equal(a.rows[0].docs.length, 1);
    a = ok(await call('GET', 'aging/receivable?as_of=2026-06-15')); assert.equal(a.rows[0].current, 95000);
    assert.equal(ok(await call('GET', 'aging/receivable?as_of=2026-05-31')).rows.length, 0);
    // ---- payables ageing (from the bill date)
    a = ok(await call('GET', 'aging/payable?as_of=2026-10-20')); assert.equal(a.rows[0].name, 'Emirates Safety Supplies'); assert.equal(a.rows[0].d90, 5500);

    // ---- statements
    let s = ok(await call('GET', `statement/${cl}?from=2026-07-01&to=2026-10-20`));
    assert.equal(s.opening, 105000); assert.equal(s.lines.length, 2); assert.equal(s.lines[0].credit, 50000); assert.equal(s.lines[0].balance, 55000);
    assert.equal(s.lines[1].debit, 21000); assert.equal(s.closing, 76000); assert.equal(s.closing, s.aging.total + s.aging.retention);
    s = ok(await call('GET', `statement/${sup}?to=2026-10-20`)); assert.equal(s.supplier, true); assert.equal(s.closing, 5500); assert.equal(s.lines[0].credit, 10500);
    const doc = await call('GET', `doc/statement/${cl}?from=2026-07-01&to=2026-10-20`);
    assert.equal(doc.s, 200); assert.match(doc.t, /Statement of account/); assert.match(doc.t, /Al Waha Developments/); assert.match(doc.t, /76,000\.00/); assert.match(doc.t, /Opening balance/);
    assert.equal((await call('GET', 'statement/99999')).s, 404);
    // ---- e-mail: validated; needs the mail settings
    assert.equal((await call('POST', `statement/${cl}/email`, { to: 'nope' })).s, 400);
    assert.match((await call('POST', `statement/${cl}/email`, { to: 'ap@alwaha.test' })).j.error, /Email is not configured/);

    // ---- roles
    for (const [u, role] of [['viewer1', 'viewer'], ['hr1', 'hr']]) ok(await call('POST', 'users', { username: u, password: 'pass1234', role }));
    cookie = ''; ok(await call('POST', 'login', { username: 'viewer1', password: 'pass1234' }));
    assert.equal((await call('GET', 'aging/receivable')).s, 200); assert.equal((await call('GET', `statement/${cl}`)).s, 200);
    assert.equal((await call('POST', `statement/${cl}/email`, { to: 'ap@alwaha.test' })).s, 403);
    cookie = ''; ok(await call('POST', 'login', { username: 'hr1', password: 'pass1234' }));
    assert.equal((await call('GET', 'aging/receivable')).s, 403); assert.equal((await call('GET', `doc/statement/${cl}`)).s, 403);
    console.log('✔ receivable/payable ageing as of any date (buckets, retention apart, bounced cheques ignored), statements with opening/running/closing, print, e-mail checks, roles');
    console.log('STATEMENT TESTS PASSED');
  } catch (e) { console.error('FAIL', e); process.exitCode = 1; }
  finally { server.close(); setTimeout(() => process.exit(process.exitCode || 0), 100); }
});
