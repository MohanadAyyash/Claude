// Payroll / HR review fixes: February = 30 days, advances caught up on existing drafts, no double deduction, input limits,
// gratuity for exactly one year, whole days in the SIF, own leave days, blank notice date: node --no-warnings test-payfix.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-payfix-'));
process.env.ZOHO_NO_SCHEDULER = '1'; process.env.SALES_NO_SCHEDULER = '1';
const { server } = require('./server.js');
const C = require('./lib/compliance.js');

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api/`; let cookie = '';
  const call = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j }; };
  const ok = (r, l) => { assert.equal(r.s, 200, `${l || ''} → ${r.s} ${JSON.stringify(r.j).slice(0, 300)}`); return r.j; };
  const row = async (m, e) => ok(await call('GET', 'payroll?month=' + m)).find(r => r.employee_id === e);
  try {
    ok(await call('POST', 'setup', { username: 'admin', password: 'secret12', company: 'Trigon' }));
    ok(await call('PUT', 'settings', { trn: '100123456700003', mohre_id: '1234567890123', employer_routing: '302620122' }));
    const mk = async (name, x = {}) => ok(await call('POST', 'employees', { name, join_date: '2024-01-01', basic: 3000, transport: 300, person_code: '12345678901234', routing_code: '302620122', iban: 'AE070331234567890123456', ...x })).id;
    const e = await mk('Worker');

    // ---- a full February pays the full wage
    ok(await call('POST', 'payroll/generate', { month: '2026-02' }));
    let r = await row('2026-02', e); assert.equal(r.days_worked, 30); assert.equal(r.fixed, 3300);
    const joiner = await mk('Joiner', { join_date: '2026-03-17' });
    ok(await call('POST', 'payroll/generate', { month: '2026-03' }));
    assert.equal((await row('2026-03', joiner)).days_worked, 15, 'a part month is still pro-rated');
    console.log('✔ full February = 30 days (3,300), part month pro-rated');

    // ---- an advance approved after the draft exists is deducted in that draft; a lowered deduction keeps it owed
    ok(await call('POST', 'hr/loans', { employee_id: e, amount: 1000, installments: 1, start_month: '2026-03' }));
    r = await row('2026-03', e); assert.equal(r.deductions, 1000); assert.equal(r.net, 2300);
    ok(await call('PUT', 'payroll/' + r.id, { deductions: 400 }));
    ok(await call('POST', 'payroll/finalize', { month: '2026-02' })); ok(await call('POST', 'payroll/finalize', { month: '2026-03' }));
    let loan = ok(await call('GET', 'hr/loans'))[0]; assert.equal(loan.repaid, 400); assert.equal(loan.balance, 600);
    ok(await call('POST', 'payroll/generate', { month: '2026-04' }));
    r = await row('2026-04', e); assert.equal(r.deductions, 600, 'the rest is caught up next month');
    console.log('✔ advance: applied to an existing draft, repaid only by what is withheld, remainder caught up');

    // ---- unpaid leave + absent on the same dates is deducted once; refresh picks up late attendance
    const lv = ok(await call('POST', 'hr/leave', { employee_id: e, type: 'unpaid', start_date: '2026-04-10', end_date: '2026-04-11' })).id;
    ok(await call('PUT', `hr/leave/${lv}/decide`, { status: 'approved' }));
    for (const d of ['2026-04-10', '2026-04-11']) ok(await call('PUT', 'attendance', { employee_id: e, date: d, status: 'absent' }));
    ok(await call('PUT', 'attendance', { employee_id: e, date: '2026-04-12', status: 'present', ot_normal_hours: 2 }));
    assert.equal(ok(await call('POST', 'payroll/refresh', { month: '2026-04' })).updated, 2);
    r = await row('2026-04', e); assert.equal(r.leave_days, 2); assert.equal(r.days_worked, 28); assert.equal(r.ot_normal_hours, 2); assert.equal(r.deductions, 600, 'refresh keeps the advance');
    console.log('✔ same date counted once (2 days, not 4); refresh re-reads attendance into the draft');

    // ---- limits
    assert.equal((await call('PUT', 'attendance', { employee_id: e, date: '2026-04-13', status: 'present', ot_normal_hours: -50 })).s, 400);
    assert.equal((await call('PUT', 'attendance', { employee_id: e, date: '2026-04-13', status: 'present', ot_special_hours: 25 })).s, 400);
    assert.equal((await call('PUT', 'payroll/' + r.id, { deductions: -5000 })).s, 400);
    assert.equal((await call('PUT', 'payroll/' + r.id, { days_worked: -10 })).s, 400);
    assert.equal((await call('PUT', 'payroll/' + r.id, { days_worked: 31 })).s, 400);
    assert.equal((await call('POST', 'payroll/finalize', { month: '2031-01' })).s, 400, 'nothing to finalize');
    assert.equal((await call('POST', 'payroll/finalize', { month: 'x' })).s, 400);
    console.log('✔ negative / out-of-range attendance and payroll values rejected');

    // ---- gratuity: exactly one year; SIF: whole days
    assert.equal(C.gratuity({ join_date: '2025-01-01', basic: 3000 }, '2025-12-31').amount, 2100);
    assert.equal(C.gratuity({ join_date: '2025-01-01', basic: 3000 }, '2025-12-30').amount, 0);
    const sif = C.buildSif({ mohre_id: '1234567890123', employer_routing: '302620122', hr_sif_days: 'calendar_minus_leave' }, [{ person_code: '12345678901234', routing_code: '302620122', iban: 'AE070331234567890123456', fixed: 3000, overtime: 0, bonus: 0, deductions: 0, net: 3000, days_worked: 29.5, leave_days: 0.5 }], '2026-03');
    const edr = sif.content.split(/\r?\n/)[0].split(','); assert.ok(/^\d+$/.test(edr[6]) && /^\d+$/.test(edr[9]), 'days fields are whole numbers: ' + edr.join(','));
    console.log('✔ gratuity paid for exactly one year of service; SIF day fields are whole numbers');

    // ---- transport is part of the salary certificate total
    const letter = ok(await call('POST', 'hr/letters', { type: 'salary_certificate', employee_id: e }));
    const html = await (await fetch(base.replace('/api/', '') + `/api/doc/letter/${letter.id}`, { headers: { cookie } })).text();
    assert.match(html, /3,300\.00/); assert.match(html, /transport allowance/);
    // a letter issued "for" an advance request does not approve the advance
    const adv = ok(await call('POST', 'hr/requests', { employee_id: e, type: 'advance', amount: 9000, details: 'x' })).id;
    ok(await call('POST', 'hr/letters', { type: 'noc', employee_id: e, request_id: adv }));
    assert.equal(ok(await call('GET', 'hr/requests')).find(x => x.id === adv).status, 'pending');
    console.log('✔ certificate total includes transport; issuing a letter cannot approve an advance request');

    // ---- final settlement: blank notice date → no notice pay, with a warning; salary not repeated when the month is on payroll
    const leaver = await mk('Leaver');
    let st = ok(await call('POST', `hr/offboarding/${leaver}`, { last_day: '2026-06-20', reason: 'resignation' }));
    assert.equal(st.notice, 0); assert.ok(st.warnings.some(w => /notice date not entered/.test(w))); assert.equal(st.salary, 2200);
    ok(await call('POST', 'payroll/generate', { month: '2026-06' }));
    assert.equal(await row('2026-06', leaver), undefined, 'June is paid in the settlement, not on the sheet');
    const leaver2 = await mk('Leaver2');
    ok(await call('POST', 'payroll/generate', { month: '2026-07' }));
    st = ok(await call('POST', `hr/offboarding/${leaver2}`, { last_day: '2026-07-20', reason: 'resignation', notice_date: '2026-06-20' }));
    assert.equal(st.salary, 0); assert.ok(st.warnings.some(w => /payroll sheet/.test(w)));
    console.log('✔ settlement: no silent 30-day notice charge; last month paid once (sheet or settlement)');

    // ---- portal: own leave counts every day; approval history is private
    ok(await call('POST', 'users', { username: 'worker', password: 'secret12', role: 'employee', employee_id: e }));
    const other = await mk('Other'); const olv = ok(await call('POST', 'hr/leave', { employee_id: other, type: 'annual', start_date: '2026-08-01', end_date: '2026-08-05' })).id;
    const admin = cookie; cookie = ''; ok(await call('POST', 'login', { username: 'worker', password: 'secret12' }));
    const mine = ok(await call('POST', 'me/leave', { type: 'annual', start_date: '2026-09-01', end_date: '2026-09-30', days: 0.01 })).id;
    assert.equal((await call('GET', `approvals/history?kind=leave&id=${olv}`)).s, 403);
    assert.equal((await call('GET', `approvals/history?kind=leave&id=${mine}`)).s, 200);
    cookie = admin;
    assert.equal(ok(await call('GET', 'hr/leave')).find(x => x.id === mine).days, 30);
    console.log('✔ portal leave counts the whole span; approval history only for HR, approvers and the employee');
    console.log('PAYROLL FIX TESTS PASSED');
  } catch (err) { console.error('FAIL', err); process.exitCode = 1; }
  server.close(); setTimeout(() => process.exit(), 200);
});
