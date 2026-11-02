// Deleting a draft payroll month: linked rows go too, a finalized month stays locked: node --no-warnings test-paydel.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-paydel-'));
process.env.ZOHO_NO_SCHEDULER = '1'; process.env.SALES_NO_SCHEDULER = '1';
const { server } = require('./server.js');
const { DatabaseSync } = require('node:sqlite');

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api/`; let cookie = '';
  const call = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j }; };
  const ok = (r, l) => { assert.equal(r.s, 200, `${l || ''} → ${r.s} ${JSON.stringify(r.j).slice(0, 300)}`); return r.j; };
  try {
    ok(await call('POST', 'setup', { username: 'admin', password: 'secret12', company: 'Trigon' }));
    ok(await call('PUT', 'settings', { trn: '100123456700003', mohre_id: '1234567890123', employer_routing: '302620122' }));
    const e = ok(await call('POST', 'employees', { name: 'Worker', join_date: '2025-01-01', basic: 3000, person_code: '12345678901234', routing_code: '302620122', iban: 'AE070331234567890123456' })).id;
    ok(await call('POST', 'hr/loans', { employee_id: e, amount: 600, installments: 2, start_month: '2026-10' }));
    const count = t => { const d = new DatabaseSync(path.join(process.env.DATA_DIR, 'erp.db'), { readOnly: true }), n = d.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n; d.close(); return n; };
    ok(await call('POST', 'payroll/generate', { month: '2026-10' })); assert.equal(count('payroll'), 1); assert.equal(count('loan_repayments'), 1);
    assert.equal(ok(await call('DELETE', 'payroll?month=2026-10')).deleted, 1);
    assert.equal(count('payroll'), 0); assert.equal(count('loan_repayments'), 0, 'advance instalment released');
    assert.equal((await call('DELETE', 'payroll?month=bad')).s, 400);
    assert.equal(ok(await call('POST', 'payroll/generate', { month: '2026-10' })).created, 1, 'month can be generated again');
    ok(await call('POST', 'payroll/finalize', { month: '2026-10' }));
    assert.equal((await call('DELETE', 'payroll?month=2026-10')).s, 409, 'finalized month is locked');
    const id = ok(await call('GET', 'payroll?month=2026-10'))[0].id;
    assert.equal((await call('DELETE', 'payroll/' + id)).s, 409); assert.equal(count('payroll'), 1);
    assert.equal((await call('DELETE', 'payroll/999999')).s, 404);
    console.log('✔ draft month deleted with its advance instalment and can be regenerated; finalized month stays locked');
    console.log('PAYROLL DELETE TESTS PASSED');
  } catch (err) { console.error('FAIL', err); process.exitCode = 1; }
  finally { server.close(); setTimeout(() => process.exit(process.exitCode || 0), 100); }
});
