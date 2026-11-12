// Closed accounting period, backups (run / status / second copy / restore) and the post-dated cheque register:
// node --no-warnings test-controls.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert'), { execFileSync } = require('child_process');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-controls-'));
process.env.ZOHO_NO_SCHEDULER = '1'; process.env.SALES_NO_SCHEDULER = '1';
const { server } = require('./server.js');

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api/`; let cookie = '';
  const call = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j }; };
  const ok = (r, l) => { assert.equal(r.s, 200, `${l || ''} → ${r.s} ${JSON.stringify(r.j).slice(0, 300)}`); return r.j; };
  const shut = async (p, re = /period is closed/) => { const r = await p; assert.ok(r.s >= 400, 'expected a refusal, got ' + r.s + ' ' + JSON.stringify(r.j).slice(0, 200)); assert.match(r.j.error || '', re); };
  const day = o => { const d = new Date(Date.now() + o * 864e5); return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
  try {
    ok(await call('POST', 'setup', { username: 'admin', password: 'secret12', company: 'Trigon' }));
    ok(await call('PUT', 'settings', { trn: '100123456700003', mohre_id: '1234567890123', employer_routing: '302620122' }));
    const cl = ok(await call('POST', 'parties', { type: 'client', name: 'Client', trn: '100000000000003' })).id, sup = ok(await call('POST', 'parties', { type: 'supplier', name: 'Supplier' })).id;
    const P = ok(await call('POST', 'projects', { name: 'Roads', client_id: cl, status: 'active' })).id;
    const inv = ok(await call('POST', 'invoices', { project_id: P, date: '2026-01-10', items: [{ description: 'Work', qty: 1, rate: 10000 }] })).id;
    const bill = ok(await call('POST', 'bills', { date: '2026-01-12', party_id: sup, project_id: P, category: 'materials', description: 'Cement', amount: 1000, vat_amount: 50 })).id;
    const pdc = ok(await call('POST', 'payments', { kind: 'in', date: '2026-01-15', amount: 4000, method: 'cheque', cheque_date: '2026-03-01', cheque_status: 'pending', reference: 'CHQ 1001', invoice_id: inv })).id;
    const emp = ok(await call('POST', 'employees', { name: 'Worker', join_date: '2025-01-01', basic: 3000, person_code: '12345678901234', routing_code: '302620122', iban: 'AE070331234567890123456' })).id;
    ok(await call('POST', 'payroll/generate', { month: '2026-01' }));

    // ---- closing the period
    await shut(call('PUT', 'period', { lock_date: 'x' }), /date/); await shut(call('PUT', 'period', { lock_date: day(5) }), /future/);
    ok(await call('PUT', 'period', { lock_date: '2026-01-31' })); assert.equal(ok(await call('GET', 'period')).lock_date, '2026-01-31');
    await shut(call('POST', 'invoices', { project_id: P, date: '2026-01-20', items: [{ description: 'x', qty: 1, rate: 1 }] }));
    await shut(call('PUT', 'invoices/' + inv, { notes: 'edit' })); await shut(call('POST', `invoices/${inv}/void`, { reason: 'x' }));
    await shut(call('PUT', 'bills/' + bill, { amount: 5 })); await shut(call('DELETE', 'bills/' + bill));
    await shut(call('POST', 'payments', { kind: 'out', date: '2026-01-30', amount: 100, method: 'bank', bill_id: bill }));
    await shut(call('PUT', 'payments/' + pdc, { amount: 1 })); await shut(call('DELETE', 'payments/' + pdc));
    await shut(call('POST', 'payroll/finalize', { month: '2026-01' })); await shut(call('DELETE', 'payroll?month=2026-01')); await shut(call('POST', 'payroll/generate', { month: '2025-12' }));
    await shut(call('POST', `projects/${P}/progress-invoice`, { date: '2026-01-31' }));
    // the open period works as before; corrections of closed documents go through the open period
    ok(await call('POST', 'invoices', { project_id: P, date: '2026-02-01', items: [{ description: 'x', qty: 1, rate: 1 }] }));
    ok(await call('POST', 'payments', { kind: 'out', date: '2026-02-02', amount: 100, method: 'bank', bill_id: bill }));
    ok(await call('POST', `invoices/${inv}/credit-note`, { items: [{ description: 'Discount', qty: 1, rate: 100 }] }));
    ok(await call('PUT', 'payments/' + pdc, { cheque_status: 'cleared' }), 'a cheque from a closed period can still clear'); ok(await call('PUT', 'payments/' + pdc, { cheque_status: 'pending' }));
    ok(await call('POST', 'payroll/generate', { month: '2026-02' }));
    ok(await call('PUT', 'period', { lock_date: '' })); ok(await call('PUT', 'invoices/' + inv, { notes: 'reopened' }));
    const log = ok(await call('GET', 'audit')).filter(a => a.tbl === 'period').map(a => a.action); assert.ok(log.includes('close') && log.includes('reopen'));
    console.log('✔ closed period: nothing dated inside it can be added, changed, voided or deleted; open period, credit notes and cheque clearing still work; close/reopen audited');

    // ---- cheque register and alerts
    ok(await call('POST', 'payments', { kind: 'out', date: day(-3), amount: 500, method: 'cheque', cheque_date: day(3), cheque_status: 'pending', reference: 'CHQ 2001', bill_id: bill }));
    const reg = ok(await call('GET', 'cheques')); assert.equal(reg.rows.length, 2); assert.equal(reg.summary.in_pending, 4000); assert.equal(reg.summary.out_pending, 500); assert.equal(reg.summary.out_week, 500);
    const mine = reg.rows.find(r => r.id === pdc); assert.equal(mine.due, '2026-03-01'); assert.equal(mine.overdue, true); assert.equal(mine.party_name, 'Client');
    const keys = ok(await call('GET', 'compliance')).map(a => a.key); assert.ok(keys.includes('pdc_overdue_in') && keys.includes('pdc_soon_out'), keys.join(','));
    ok(await call('PUT', 'payments/' + pdc, { cheque_status: 'cleared' })); assert.equal(ok(await call('GET', 'cheques')).summary.in_pending, 0);
    console.log('✔ cheque register: pending totals, due this week, past-date cheques, alerts');

    // ---- backups: run, status, second copy, restore
    const copyDir = path.join(process.env.DATA_DIR, 'offsite');
    let st = ok(await call('GET', 'backup/status')); assert.equal(st.latest, null); assert.equal(st.stale, true);
    ok(await call('PUT', 'settings', { backup_copy_dir: copyDir }));
    st = ok(await call('POST', 'backup/run')); assert.equal(st.stale, false); assert.equal(st.files.length, 1); assert.equal(st.last_copy.ok, true);
    assert.ok(fs.existsSync(path.join(copyDir, st.latest.name)), 'copied to the second folder');
    ok(await call('PUT', 'settings', { backup_copy_dir: path.join(process.env.DATA_DIR, 'erp.db', 'nope') }));
    st = ok(await call('POST', 'backup/run')); assert.equal(st.last_copy.ok, false);
    assert.ok(ok(await call('GET', 'compliance')).some(a => a.key === 'backup_copy'));
    const before = ok(await call('GET', 'invoices')).length;
    ok(await call('POST', 'invoices', { project_id: P, date: day(0), items: [{ description: 'after the backup', qty: 1, rate: 1 }] }));
    // restore into a copy of the data folder (the live database is in use by this test server)
    const sand = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-restore-')); fs.cpSync(path.join(process.env.DATA_DIR, 'backups'), path.join(sand, 'backups'), { recursive: true });
    fs.writeFileSync(path.join(sand, 'backups', 'erp-2000-01-01.db'), 'not a database');
    const run = a => execFileSync(process.execPath, ['--no-warnings', 'scripts/restore.js', ...a], { env: { ...process.env, DATA_DIR: sand }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.match(run([]), /erp-\d{4}-\d\d-\d\d\.db/); assert.throws(() => run(['erp-2000-01-01.db']), /cannot be used/); assert.throws(() => run(['missing.db']), /not found/);
    assert.match(run([st.latest.name]), /Restored/);
    const { DatabaseSync } = require('node:sqlite'), d = new DatabaseSync(path.join(sand, 'erp.db'), { readOnly: true });
    assert.equal(d.prepare('SELECT COUNT(*) n FROM invoices').get().n, before, 'the restored database holds the data as of the backup'); d.close();
    console.log('✔ backups: written on demand, copied to a second folder (failure reported), restore checks the file and brings the data back');
    console.log('CONTROLS TESTS PASSED');
  } catch (err) { console.error('FAIL', err); process.exitCode = 1; }
  finally { server.close(); setTimeout(() => process.exit(process.exitCode || 0), 100); }
});
