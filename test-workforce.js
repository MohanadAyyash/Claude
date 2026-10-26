// HR phase 1: approval chains, phone attendance with site area, overtime per the law, labour-law checks, sick-pay tiers,
// onboarding / offboarding and the final settlement: node --no-warnings test-workforce.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-hr1-'));
const { server } = require('./server.js');

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api/`;
  const jar = {}; let who = 'admin';
  const call = async (m, u, b) => {
    const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie: jar[who] || '' }, body: b ? JSON.stringify(b) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) jar[who] = sc.split(';')[0];
    const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch { j = text; }
    return { s: r.status, j };
  };
  const as = async (user, fn) => { const prev = who; who = user; try { return await fn(); } finally { who = prev; } };
  const login = (u, p = 'pass1234') => as(u, () => call('POST', 'login', { username: u, password: p }));
  const ok = (r, msg) => { assert.ok(r.s === 200, `${msg || ''} → ${r.s} ${JSON.stringify(r.j)}`); return r.j; };
  try {
    ok(await call('POST', 'setup', { username: 'admin', password: 'secret12', company: 'Trigon' }));
    ok(await call('PUT', 'settings', { hr_rest_day: 'fri', hr_work_hours: '8', hr_break_min: '60' }));
    for (const [u, role] of [['pm1', 'manager'], ['hr1', 'hr']]) ok(await call('POST', 'users', { username: u, password: 'pass1234', role }));
    const users = ok(await call('GET', 'users')), pm1 = users.find(u => u.username === 'pm1').id;
    const proj = ok(await call('POST', 'projects', { name: 'Dubai South roads', status: 'active', site_lat: 25.0, site_lng: 55.0, site_radius: 300 })).id;
    const e1 = ok(await call('POST', 'employees', { name: 'Imran Qureshi', join_date: '2025-01-01', basic: 3000, housing: 1000, other_allowance: 500, project_id: proj, manager_user_id: pm1 })).id;
    ok(await call('POST', 'users', { username: 'imran', password: 'pass1234', role: 'employee', employee_id: e1 }));
    for (const u of ['pm1', 'hr1', 'imran']) await login(u);

    // ---- leave: line manager → HR
    const lv = ok(await as('imran', () => call('POST', 'me/leave', { type: 'annual', start_date: '2026-11-10', end_date: '2026-11-12' })), 'leave').id;
    assert.equal((await as('hr1', () => call('PUT', `hr/leave/${lv}/decide`, { status: 'approved' }))).s, 403, 'HR has to wait for the line manager');
    assert.equal(ok(await as('hr1', () => call('GET', 'approvals'))).length, 0);
    const q1 = ok(await as('pm1', () => call('GET', 'approvals'))); assert.equal(q1.length, 1); assert.equal(q1[0].level, 1); assert.equal(q1[0].levels, 2); assert.ok(q1[0].balance);
    assert.ok(ok(await as('pm1', () => call('GET', 'notifications'))).items.some(n => /Leave request to approve/.test(n.title)));
    ok(await as('pm1', () => call('PUT', 'approvals/' + q1[0].step_id, { status: 'approved', note: 'ok from site' })));
    assert.equal(ok(await call('GET', 'hr/leave')).find(l => l.id === lv).status, 'pending');
    const q2 = ok(await as('hr1', () => call('GET', 'approvals'))); assert.equal(q2.length, 1); assert.equal(q2[0].history[0].by, 'pm1');
    assert.equal((await as('pm1', () => call('PUT', 'approvals/' + q2[0].step_id, { status: 'approved' }))).s, 403, 'level 2 belongs to HR');
    ok(await as('hr1', () => call('PUT', `hr/leave/${lv}/decide`, { status: 'approved', note: 'enjoy' })));
    assert.equal(ok(await call('GET', 'hr/leave')).find(l => l.id === lv).status, 'approved');
    assert.ok(ok(await as('imran', () => call('GET', 'notifications'))).items.some(n => /approved/.test(n.title) && /enjoy/.test(n.body)));

    // ---- requests: big advances need the admin as well
    const adv = ok(await as('imran', () => call('POST', 'me/request', { type: 'advance', amount: 6000, details: 'family' }))).id;
    const small = ok(await as('imran', () => call('POST', 'me/request', { type: 'advance', amount: 1000 }))).id;
    const hq = ok(await as('hr1', () => call('GET', 'approvals'))); assert.equal(hq.length, 2);
    for (const it of hq) ok(await as('hr1', () => call('PUT', 'approvals/' + it.step_id, { status: 'approved' })));
    const reqs = () => call('GET', 'hr/requests').then(r => r.j);
    assert.equal((await reqs()).find(r => r.id === small).status, 'approved');
    assert.equal((await reqs()).find(r => r.id === adv).status, 'pending');
    const aq = ok(await call('GET', 'approvals')); assert.equal(aq.length, 1); assert.equal(aq[0].levels, 2);
    ok(await call('PUT', 'approvals/' + aq[0].step_id, { status: 'rejected', note: 'max 5000' }));
    assert.equal((await reqs()).find(r => r.id === adv).status, 'rejected');
    assert.equal((await call('PUT', 'approvals/' + aq[0].step_id, { status: 'approved' })).s, 400);

    // ---- configurable chains; records from before approvals still decide
    assert.equal((await call('PUT', 'hr/flows', { leave: [['role:boss']] })).s, 400);
    ok(await call('PUT', 'hr/flows', { leave: [['role:hr']] }));
    assert.deepEqual(ok(await call('GET', 'hr/flows')).leave, [['role:hr', 0, 0]]);
    const { DatabaseSync } = require('node:sqlite'); const raw = new DatabaseSync(path.join(process.env.DATA_DIR, 'erp.db'));
    const legacy = Number(raw.prepare("INSERT INTO leave_requests(employee_id,type,start_date,end_date,days,status,created) VALUES(?,'unpaid','2026-12-01','2026-12-01',1,'pending','2026-10-01')").run(e1).lastInsertRowid);
    ok(await as('hr1', () => call('PUT', `hr/leave/${legacy}/decide`, { status: 'approved' })));

    // ---- phone attendance with the site area
    const st0 = ok(await as('imran', () => call('GET', 'me/clock'))); assert.equal(st0.clocked_in, false); assert.equal(st0.site.located, true);
    const c1 = ok(await as('imran', () => call('POST', 'me/clock', { lat: 25.001, lng: 55.0, accuracy: 15 }))); assert.equal(c1.kind, 'in'); assert.equal(c1.inside, true); assert.ok(c1.distance_m > 100 && c1.distance_m < 120);
    assert.equal(ok(await as('imran', () => call('POST', 'me/clock', { lat: 25.001, lng: 55.0 }))).duplicate, true);
    assert.equal(ok(await as('imran', () => call('GET', 'me/clock'))).clocked_in, true);
    const c2 = ok(await as('imran', () => call('POST', 'me/clock', { kind: 'out', lat: 25.02, lng: 55.0 }))); assert.equal(c2.inside, false);
    assert.ok(ok(await as('pm1', () => call('GET', 'notifications'))).items.some(n => /outside the site/.test(n.title)));
    ok(await call('PUT', 'settings', { hr_geofence: 'block' }));
    assert.match((await as('imran', () => call('POST', 'me/clock', { kind: 'in', lat: 25.05, lng: 55.0 }))).j.error, /outside the site area/);
    assert.match((await as('imran', () => call('POST', 'me/clock', { kind: 'in' }))).j.error, /Location is required/);
    ok(await call('PUT', 'settings', { hr_geofence: 'flag' }));
    assert.equal((await as('imran', () => call('POST', 'attendance/clock', { employee_ids: [e1] }))).s, 403, 'employees cannot clock others');

    // ---- overtime per the law (HR corrections with a time; supervisors use the current time only)
    const hrClock = (at, kind) => as('hr1', () => call('POST', 'attendance/clock', { employee_ids: [e1], kind, at, lat: 25.0, lng: 55.0 }));
    assert.match((await as('pm1', () => call('POST', 'attendance/clock', { employee_ids: [e1], at: '2026-07-01 06:00' }))).j.error, /Only HR/);
    ok(await hrClock('2026-07-01 06:00', 'in')); ok(await hrClock('2026-07-01 19:00', 'out'));             // 13 h, 1 h break → 4 h overtime
    ok(await hrClock('2026-07-02 14:00', 'in')); ok(await hrClock('2026-07-03 01:00', 'out'));             // 11 h, 3 h after 10 pm → 2 h night overtime
    ok(await hrClock('2026-07-03 08:00', 'in')); ok(await hrClock('2026-07-03 12:00', 'out'));             // Friday (rest day) → all 150 %
    const att = d => call('GET', 'attendance?date=' + d).then(r => r.j.rows.find(x => x.employee_id === e1));
    let a = await att('2026-07-01');
    assert.equal(a.worked_hours, 13); assert.equal(a.ot_normal_hours, 4); assert.equal(a.ot_special_hours, 0); assert.equal(a.check_in, '06:00'); assert.equal(a.check_out, '19:00'); assert.equal(a.source, 'clock');
    assert.ok(a.flags.includes('midday_break') && a.flags.includes('ot_over_2h'));
    a = await att('2026-07-02'); assert.equal(a.worked_hours, 11); assert.equal(a.ot_normal_hours, 0); assert.equal(a.ot_special_hours, 2); assert.equal(a.check_out, '01:00');
    a = await att('2026-07-03'); assert.equal(a.ot_special_hours, 4); assert.equal(a.ot_normal_hours, 0);
    ok(await call('PUT', 'attendance', { employee_id: e1, date: '2026-07-06', status: 'absent', ot_normal_hours: 0, ot_special_hours: 0 }));   // HR's manual status wins
    ok(await hrClock('2026-07-06 07:00', 'in'));
    a = await att('2026-07-06'); assert.equal(a.status, 'absent'); assert.equal(a.check_in, '07:00'); assert.equal(a.source, 'manual');
    ok(await call('PUT', 'settings', { hr_ramadan_from: '2026-07-20', hr_ramadan_to: '2026-07-20' }));
    ok(await hrClock('2026-07-20 08:00', 'in')); ok(await hrClock('2026-07-20 16:00', 'out'));             // Ramadan: 6 h day → 1 h overtime (8 − 1 break − 6)
    assert.equal((await att('2026-07-20')).ot_normal_hours, 1);
    assert.equal(ok(await call('GET', 'attendance/events?date=2026-07-01')).length, 2);

    // ---- labour-law checks
    for (const d of ['04', '05', '07', '08', '09', '10', '11', '12', '13']) ok(await call('PUT', 'attendance', { employee_id: e1, date: `2026-07-${d}`, status: 'present', ot_normal_hours: 0, ot_special_hours: 0 }));
    ok(await call('PUT', 'employees/' + e1, { probation_end: '2025-09-01' }));
    const iss = ok(await as('hr1', () => call('GET', 'hr/compliance?month=2026-07'))), rules = iss.map(i => i.rule);
    for (const r of ['ot_daily', 'midday_break', 'rest_day', 'probation_6m']) assert.ok(rules.includes(r), r + ' in ' + rules);
    assert.ok(iss.find(i => i.rule === 'ot_daily').law.includes('Art. 19'));
    assert.equal((await as('pm1', () => call('GET', 'hr/compliance?month=2026-07'))).s, 403);

    // ---- sick pay tiers in payroll: 20 sick days → days 16–20 at half pay = 2.5 days off the salary
    ok(await call('PUT', 'employees/' + e1, { probation_end: '2025-06-30' }));
    const sick = ok(await call('POST', 'hr/leave', { employee_id: e1, type: 'sick', start_date: '2026-08-01', end_date: '2026-08-20' })).id;
    ok(await as('hr1', () => call('PUT', `hr/leave/${sick}/decide`, { status: 'approved' })));
    ok(await call('POST', 'payroll/generate', { month: '2026-08' }));
    const pay = ok(await call('GET', 'payroll?month=2026-08')).find(r => r.employee_id === e1);
    assert.equal(pay.days_worked, 27.5); assert.equal(pay.leave_days, 2.5);

    // ---- onboarding / offboarding and the final settlement
    const ob = ok(await as('hr1', () => call('POST', `hr/onboarding/${e1}`))); assert.equal(ob.length, 12);
    ok(await as('hr1', () => call('PUT', `hr/checklist/${ob[0].id}`, { done: 1 })));
    assert.equal(ok(await as('hr1', () => call('GET', `hr/checklist/${e1}`))).onboarding[0].done_by, 'hr1');
    assert.equal((await as('hr1', () => call('POST', `hr/offboarding/${e1}`, { last_day: '2026-12-15', reason: 'quit' }))).s, 400);
    const stl = ok(await as('hr1', () => call('POST', `hr/offboarding/${e1}`, { last_day: '2026-12-15', reason: 'resignation', notice_date: '2026-12-05', other_deductions: 200 })));
    assert.equal(stl.salary, 2250);                                         // 4,500 / 30 × 15
    assert.equal(stl.notice_days, 10); assert.equal(stl.notice, -3000);      // 20 days short × 150
    assert.equal(stl.deductions, -200); assert.ok(stl.gratuity > 0); assert.ok(stl.leave_encashment > 0);
    assert.ok(stl.warnings.some(w => /at least 30/.test(w)));
    assert.equal(stl.total, Math.round((stl.salary + stl.leave_encashment + stl.gratuity + stl.notice + stl.deductions) * 100) / 100);
    assert.match((await as('hr1', () => call('POST', `hr/offboarding/${e1}/complete`))).j.error, /still open/);
    ok(await as('hr1', () => call('POST', `hr/offboarding/${e1}/complete`, { force: 1 })));
    assert.equal(ok(await call('GET', 'employees/' + e1)).status, 'left');
    assert.equal((await as('imran', () => call('GET', 'me'))).s, 401, 'session ended');
    assert.equal((await login('imran')).s, 403, 'account disabled');
    raw.close();
    console.log('✔ approval chains (line manager → HR → admin by amount), phone attendance + site area, overtime/night/rest day/Ramadan, labour-law checks, sick-pay tiers, onboarding, offboarding settlement');
    console.log('WORKFORCE TESTS PASSED');
  } catch (e) { console.error('FAIL', e); process.exitCode = 1; }
  finally { server.close(); setTimeout(() => process.exit(process.exitCode || 0), 100); }
});
