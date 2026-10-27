// Phase 2 payroll: gratuity without unpaid days, end-of-service provision (2300), advances, project cost split, SIF days, rest day, midday ban: node --no-warnings test-payroll2.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-pay2-'));
process.env.ZOHO_NO_SCHEDULER = '1'; process.env.SALES_NO_SCHEDULER = '1';
const { server } = require('./server.js');
const C = require('./lib/compliance');

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api/`; let cookie = '';
  const call = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j }; };
  const ok = (r, l) => { assert.equal(r.s, 200, `${l || ''} → ${r.s} ${JSON.stringify(r.j).slice(0, 200)}`); return r.j; };
  const WPS = { person_code: '12345678901234', routing_code: '302620122', iban: 'AE070331234567890123456' };
  const bal2300 = async () => { const l = ok(await call('GET', 'ledger?account=2300')).lines; return l.length ? l[l.length - 1].balance : 0; };
  const out = [];
  try {
    ok(await call('POST', 'setup', { username: 'admin', password: 'secret12', company: 'Trigon' }));
    ok(await call('PUT', 'settings', { trn: '100123456700003', mohre_id: '1234567890123', employer_routing: '302620122', employer_iban: 'AE070331234567890123456', hr_rest_day: 'fri' }));
    ok(await call('PUT', 'hr/flows', { leave: [['role:admin']], request: [['role:admin']] }));
    const A = ok(await call('POST', 'projects', { name: 'Project A', status: 'active' })).id, B = ok(await call('POST', 'projects', { name: 'Project B', status: 'active' })).id;

    // ---- 1. gratuity (basic 1,500, end of service 2026-10-27)
    const g1 = C.gratuity({ join_date: '2023-04-27', basic: 1500 }, '2026-10-27');
    const g2 = C.gratuity({ join_date: '2023-04-27', basic: 1500 }, '2026-10-27', 60);
    const g3 = C.gratuity({ join_date: '1996-10-27', basic: 1500 }, '2026-10-27');
    assert.equal(g1.amount, 3679.32); assert.equal(g2.amount, 3506.71); assert.equal(g3.amount, 36000);
    out.push(`gratuity 3.5 y = ${g1.amount} | with 60 unpaid days = ${g2.amount} | 30 y = ${g3.amount} (cap 24 × basic)`);

    // ---- 2. provision: basic 1,500, three finalised months = 262.50; leaves before a year → gratuity 0, provision reversed, 2300 = 0
    const P = ok(await call('POST', 'employees', { name: 'Provision Worker', join_date: '2026-07-01', basic: 1500, project_id: A, ...WPS })).id;
    for (const m of ['2026-07', '2026-08', '2026-09']) { ok(await call('POST', 'payroll/generate', { month: m })); ok(await call('POST', 'payroll/finalize', { month: m }), 'finalize ' + m); }
    assert.equal(await bal2300(), -262.5, 'provision credited to 2300');
    ok(await call('POST', 'payroll/finalize', { month: '2026-09' }));                  // finalising again adds nothing
    assert.equal(await bal2300(), -262.5);
    const st = ok(await call('POST', `hr/offboarding/${P}`, { last_day: '2026-09-30', reason: 'resignation', notice_date: '2026-08-31' }));
    assert.equal(st.gratuity, 0);
    ok(await call('POST', `hr/offboarding/${P}/complete`, { force: 1 }));
    assert.equal(await bal2300(), 0, '2300 back to zero');
    const fin = ok(await call('GET', 'financials?from=2026-01-01&to=2026-12-31'));
    out.push(`provision after 3 months = 262.50, left before 1 year: gratuity ${st.gratuity}, 2300 balance ${await bal2300()}`);

    // ---- 3. gratuity through the API counts unpaid leave + absent days
    const G = ok(await call('POST', 'employees', { name: 'Long Service', join_date: '2023-04-27', basic: 1500, project_id: A, ...WPS })).id;
    const lv = ok(await call('POST', 'hr/leave', { employee_id: G, type: 'unpaid', start_date: '2025-01-01', end_date: '2025-02-19' })).id;   // 50 days
    ok(await call('PUT', `hr/leave/${lv}/decide`, { status: 'approved' }));
    for (let d = 1; d <= 10; d++) ok(await call('PUT', 'attendance', { employee_id: G, date: `2026-03-${String(d).padStart(2, '0')}`, status: 'absent' }));
    const gApi = ok(await call('GET', `employees/${G}/gratuity?end=2026-10-27`));
    assert.equal(gApi.unpaid_days, 60); assert.equal(gApi.amount, 3506.71);
    out.push(`API gratuity: 50 unpaid-leave days + 10 absent days = ${gApi.unpaid_days} → ${gApi.amount}`);
    ok(await call('PUT', `employees/${G}`, { status: 'left' }));

    // ---- 4. advances: request with 3 instalments → monthly deduction, balance on payslip and settlement
    const L = ok(await call('POST', 'employees', { name: 'Advance Worker', join_date: '2025-01-01', basic: 2000, project_id: A, ...WPS })).id;
    const rq = ok(await call('POST', 'hr/requests', { employee_id: L, type: 'advance', amount: 1000, installments: 3, details: 'family' })).id;
    ok(await call('PUT', `hr/requests/${rq}/decide`, { status: 'approved' }));
    const loan = ok(await call('GET', 'hr/loans')).find(l => l.employee_id === L);
    assert.ok(loan, 'loan created on approval'); assert.equal(loan.installments, 3); assert.equal(loan.monthly, 333.33);
    const ded = [];
    for (const m of [loan.start_month, ...[1, 2, 3].map(k => { let y = +loan.start_month.slice(0, 4), mo = +loan.start_month.slice(5) + k; while (mo > 12) { mo -= 12; y++; } return `${y}-${String(mo).padStart(2, '0')}`; })]) {
      ok(await call('POST', 'payroll/generate', { month: m }));
      const row = ok(await call('GET', 'payroll?month=' + m)).find(r => r.employee_id === L); ded.push(row.deductions);
      ok(await call('POST', 'payroll/finalize', { month: m }));
      if (ded.length === 1) { const slip = await fetch(base + `doc/payslips/${row.id}`, { headers: { cookie } }).then(r => r.text()); assert.match(slip, /remaining balance/); assert.match(slip, /666\.67/); }
    }
    assert.deepEqual(ded, [333.33, 333.33, 333.34, 0]);
    assert.equal(ok(await call('GET', 'hr/loans')).find(l => l.id === loan.id).balance, 0);
    out.push(`advance 1,000 / 3: deductions ${ded.join(', ')}; balance after = 0; payslip shows remaining 666.67 after the first`);
    // HR advance still open → shows in the final settlement
    ok(await call('POST', 'hr/loans', { employee_id: L, amount: 600, installments: 6, start_month: '2027-06' }));
    const stL = ok(await call('POST', `hr/offboarding/${L}`, { last_day: '2027-03-31', reason: 'resignation', notice_date: '2027-03-01' }));
    assert.equal(stL.advance, -600);
    // >50% warning kept
    const W = ok(await call('POST', 'employees', { name: 'Big Advance', join_date: '2025-01-01', basic: 1000, project_id: A, ...WPS })).id;
    ok(await call('POST', 'hr/loans', { employee_id: W, amount: 800, installments: 1, start_month: '2027-08' }));
    ok(await call('POST', 'payroll/generate', { month: '2027-08' }));
    assert.ok(ok(await call('GET', 'payroll/check?month=2027-08')).some(i => i.warn && /50%/.test(i.msg)), '>50% warning');
    out.push('settlement shows outstanding advance −600; >50% deduction warning still raised');

    // ---- 5. cost split by attendance: 3,000; 20 days on A and 10 on B → A 2,000, B 1,000
    const PA = ok(await call('POST', 'projects', { name: 'Split A', status: 'active' })).id, PB = ok(await call('POST', 'projects', { name: 'Split B', status: 'active' })).id;
    const X = ok(await call('POST', 'employees', { name: 'Split Worker', join_date: '2025-01-01', basic: 3000, project_id: PA, ...WPS })).id;
    for (let d = 1; d <= 30; d++) ok(await call('PUT', 'attendance', { employee_id: X, date: `2027-11-${String(d).padStart(2, '0')}`, status: 'present', project_id: d <= 20 ? PA : PB }));
    ok(await call('POST', 'payroll/generate', { month: '2027-11' })); ok(await call('POST', 'payroll/finalize', { month: '2027-11' }));
    const before = ok(await call('GET', 'project-summary'));
    const costOf = (rows, id) => rows.find(p => p.id === id).cost_by_category.payroll || 0;
    const rowX = ok(await call('GET', 'payroll?month=2027-11')).find(r => r.employee_id === X); assert.equal(rowX.gross, 3000);
    assert.equal(costOf(before, PA), 2000); assert.equal(costOf(before, PB), 1000);
    out.push(`cost split 3,000 (20 days A / 10 days B) → A ${costOf(before, PA)}, B ${costOf(before, PB)}`);
    // a month without project attendance → all to the main project
    const Y = ok(await call('POST', 'employees', { name: 'Office Worker', join_date: '2025-01-01', basic: 3000, project_id: PB, ...WPS })).id;
    ok(await call('POST', 'payroll/generate', { month: '2027-12' })); ok(await call('POST', 'payroll/finalize', { month: '2027-12' }));
    assert.equal(costOf(ok(await call('GET', 'project-summary')), PB), 4000);
    out.push('no attendance → the whole month to the main project (B 1,000 + 3,000 = 4,000)');

    // ---- 6. SIF "days in period"
    const rowsS = [{ person_code: '12345678901234', routing_code: '302620122', iban: 'AE070331234567890123456', fixed: 1000, overtime: 0, bonus: 0, deductions: 0, net: 1000, days_worked: 27, leave_days: 3 }];
    const S0 = { mohre_id: '1234567890123', employer_routing: '302620122' }, day = s => +C.buildSif(s, rowsS, '2026-10').content.split('\r\n')[0].split(',')[6];
    assert.equal(day(S0), 31); assert.equal(day({ ...S0, hr_sif_days: 'calendar_minus_leave' }), 28); assert.equal(day({ ...S0, hr_sif_days: 'legacy' }), 27);
    out.push(`SIF October days: calendar ${day(S0)} | calendar − leave ${day({ ...S0, hr_sif_days: 'calendar_minus_leave' })} | previous method ${day({ ...S0, hr_sif_days: 'legacy' })}`);

    // ---- 7. rest day worked: pay +50% or a substitute day
    const R = ok(await call('POST', 'employees', { name: 'Rest Worker', join_date: '2025-01-01', basic: 2400, project_id: A, ...WPS })).id;
    ok(await call('PUT', 'attendance', { employee_id: R, date: '2028-01-07', status: 'present', ot_special_hours: 8, rest_comp: 'pay' }));   // Friday
    ok(await call('PUT', 'attendance', { employee_id: R, date: '2028-01-14', status: 'present', ot_special_hours: 8, rest_comp: 'day' }));
    ok(await call('PUT', 'attendance', { employee_id: R, date: '2028-01-18', status: 'comp_off' }));
    ok(await call('POST', 'payroll/generate', { month: '2028-01' }));
    const rowR = ok(await call('GET', 'payroll?month=2028-01')).find(r => r.employee_id === R);
    assert.equal(rowR.ot_special_hours, 8); assert.equal(rowR.overtime, 120);         // 2400/30/8 = 10/h × 1.5 × 8
    assert.equal(rowR.days_worked, 30, 'comp_off is a paid day');
    const balR = ok(await call('GET', 'hr/balances')).find(b => b.employee_id === R);
    assert.equal(balR.comp_days, 0, 'one earned, one taken');
    out.push(`rest day: paid day → 8 h × 150% = ${rowR.overtime}; substitute-day day → not paid extra; comp_off taken, balance ${balR.comp_days}`);

    // ---- 8. midday ban hours/dates from settings
    const clockAt = async (at, kind) => ok(await call('POST', 'attendance/clock', { employee_ids: [R], kind, at }));
    await clockAt('2028-05-10 11:00', 'in'); await clockAt('2028-05-10 14:00', 'out');
    const flags = async d => (ok(await call('GET', 'attendance?date=' + d)).rows.find(r => r.employee_id === R) || {}).flags || '';
    assert.ok(!/midday_break/.test(await flags('2028-05-10')), 'May is outside the default 15/6–15/9');
    ok(await call('PUT', 'settings', { hr_midday_from: '05-01', hr_midday_to: '09-30', hr_midday_start: '13:00', hr_midday_end: '15:30' }));
    await clockAt('2028-05-11 11:00', 'in'); await clockAt('2028-05-11 14:00', 'out');
    assert.ok(/midday_break/.test(await flags('2028-05-11')));
    await clockAt('2028-05-12 06:00', 'in'); await clockAt('2028-05-12 12:59', 'out');
    assert.ok(!/midday_break/.test(await flags('2028-05-12')), 'left before 13:00');
    out.push('midday ban: default dates ignore May; after setting 01/05–30/09 13:00–15:30 → flagged; work ending 12:59 → not flagged');

    // ---- ledger still balances
    const tb = ok(await call('GET', 'financials?from=2026-01-01&to=2028-12-31'));
    assert.ok(fin && tb);
    const all = ok(await call('GET', 'ledger')).lines, dr = all.reduce((s, l) => s + l.debit, 0), cr = all.reduce((s, l) => s + l.credit, 0);
    assert.equal(Math.round(dr * 100), Math.round(cr * 100));
    out.push(`ledger debits = credits (${dr.toFixed(2)})`);
    console.log(out.map(x => '✔ ' + x).join('\n'));
    console.log('PAYROLL PHASE 2 TESTS PASSED');
  } catch (e) { console.log(out.map(x => '✔ ' + x).join('\n')); console.error('FAIL', e); process.exitCode = 1; }
  finally { server.close(); setTimeout(() => process.exit(process.exitCode || 0), 100); }
});
