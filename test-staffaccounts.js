// Employee accounts and expense claims: claim with receipt, approval rule (manager and administrator any amount, accountant up to
// the limit, nobody their own), booking on the project with VAT, reimbursement, taking an approval back, the employee statement
// (salaries due and paid, advances and instalments, expense claims), reconciliation with the ledger, roles, closed period, Zoho.
//   node --no-warnings test-staffaccounts.js          Fake names and amounts only.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-staff-'));
const { server } = require('./server.js');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api/`; let cookie = '';
  const call = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j, t }; };
  const ok = (r, m = '') => { assert.equal(r.s, 200, m + ' ' + JSON.stringify(r.j)); return r.j; };
  const no = (r, re, m = '') => { assert.ok(r.s >= 400, m + ' expected a refusal, got ' + r.s + ' ' + JSON.stringify(r.j)); if (re) assert.match(JSON.stringify(r.j), re, m); return r.j; };
  const sessions = {};
  const as = async (u, fn) => { const keep = cookie; cookie = sessions[u] || ''; try { return await fn(); } finally { sessions[u] = cookie; cookie = keep; } };
  const login = async u => { cookie = ''; ok(await call('POST', 'login', { username: u, password: 'pass1234' }), 'login ' + u); sessions[u] = cookie; };
  const credit = async code => { const f = ok(await call('GET', 'financials?from=2000-01-01&to=2099-12-31')); const r = f.trial_balance.find(x => x.code === code); return r ? Math.round((r.credit - r.debit) * 100) / 100 : 0; };
  const WPS = { person_code: '12345678901234', routing_code: '302620122', iban: 'AE070331234567890123456' };
  try {
    ok(await call('POST', 'setup', { username: 'admin', password: 'secret12', company: 'Test Contracting' })); sessions.admin = cookie;
    ok(await call('PUT', 'settings', { trn: '100123456700003', mohre_id: '1234567890123', employer_routing: '302620122', employer_iban: 'AE070331234567890123456' }));
    const prj = ok(await call('POST', 'projects', { name: 'Test Project', status: 'active' })).id;
    const E1 = ok(await call('POST', 'employees', { name: 'Worker One', join_date: '2026-01-01', basic: 3000, project_id: prj, ...WPS })).id;
    const E2 = ok(await call('POST', 'employees', { name: 'Site Engineer Two', join_date: '2026-01-01', basic: 5000, project_id: prj, ...WPS })).id;
    const E3 = ok(await call('POST', 'employees', { name: 'Manager Three', join_date: '2026-01-01', basic: 9000, ...WPS })).id;
    for (const [u, role, e] of [['worker1', 'employee', E1], ['eng2', 'site_engineer', E2], ['mgr3', 'manager', E3], ['acc', 'accountant', null], ['hr1', 'hr', null], ['view1', 'viewer', null]])
      ok(await call('POST', 'users', { username: u, password: 'pass1234', role, ...(e ? { employee_id: e } : {}) }), 'user ' + u);
    for (const u of ['worker1', 'eng2', 'mgr3', 'acc', 'hr1', 'view1']) { await login(u); }
    cookie = sessions.admin;
    // a staff account may be linked to its employee record (optional); one account per employee
    no(await call('POST', 'users', { username: 'dup', password: 'pass1234', role: 'qs', employee_id: E1 }), /already has an account/);
    const users = ok(await call('GET', 'users')), uid = n => users.find(u => u.username === n).id;
    assert.equal(users.find(u => u.username === 'mgr3').employee_id, E3);
    no(await call('PUT', `users/${uid('worker1')}`, { employee_id: '' }), /must stay linked/);
    no(await call('PUT', `users/${uid('acc')}`, { employee_id: E2 }), /already has an account/);
    ok(await call('PUT', `users/${uid('eng2')}`, { employee_id: '' })); ok(await call('PUT', `users/${uid('eng2')}`, { employee_id: E2 }));
    // (the session reads the user record on every request: the link applies at once)

    // ---- an employee asks for an expense back (portal), with the receipt
    const c1 = await as('worker1', async () => {
      no(await call('POST', 'me/claims', { date: '2099-01-01', description: 'Fuel', amount: 100 }), /future/);
      no(await call('POST', 'me/claims', { date: '2026-09-10', description: 'Fuel', amount: 100, vat_amount: 6 }), /VAT is more than 5%/);
      no(await call('POST', 'me/claims', { date: '2026-09-10', description: '', amount: 100 }), /what was paid/);
      const id = ok(await call('POST', 'me/claims', { date: '2026-09-10', description: 'Site fuel', amount: 200, vat_amount: 10, category: 'transport', project_id: prj, reference: 'RCPT-1' })).id;
      ok(await call('POST', `me/claims/${id}/receipt`, { name: 'receipt.png', data: PNG }));
      no(await call('POST', `me/claims/${id}/receipt`, { name: 'x.txt', data: 'data:text/plain;base64,aGk=' }), /photo or a PDF/);
      const mine = ok(await call('GET', 'me/claims')); assert.equal(mine.length, 1); assert.equal(mine[0].status, 'pending'); assert.equal(mine[0].receipts.length, 1); assert.equal(mine[0].total, 210);
      // an employee sees only own records
      assert.equal((await call('GET', 'expense_claims')).s, 403); assert.equal((await call('GET', 'staff_statements')).s, 403); assert.equal((await call('GET', `staff_statements/${E2}`)).s, 403);
      return id;
    });
    // approvers were notified (administrator and manager; the accountant only once a limit covers the amount)
    const notes = await as('mgr3', async () => ok(await call('GET', 'notifications')));
    assert.ok(notes.items.some(n => /Expense claim to approve/.test(n.title)), 'manager notified');

    // ---- approval rule
    await as('acc', async () => no(await call('POST', `expense_claims/${c1}/decide`, { status: 'approved' }), /limit is not set/));
    ok(await call('PUT', 'settings', { staff_approval_accountant_limit: '150' }));
    await as('acc', async () => {
      const list = ok(await call('GET', 'expense_claims?status=pending')); const r = list.rows.find(x => x.id === c1);
      assert.equal(r.can_decide, false); assert.match(r.block, /limit \(150\.00\)/); assert.equal(list.accountant_limit, 150);
      no(await call('POST', `expense_claims/${c1}/decide`, { status: 'approved' }), /accountant's approval limit/);
    });
    ok(await call('PUT', 'settings', { staff_approval_accountant_limit: '500' }));
    await as('eng2', async () => assert.equal((await call('POST', `expense_claims/${c1}/decide`, { status: 'approved' })).s, 403, 'a site engineer cannot approve'));
    await as('acc', async () => {
      no(await call('POST', `expense_claims/${c1}/decide`, { status: 'rejected' }), /reason/);
      const v = ok(await call('POST', `expense_claims/${c1}/decide`, { status: 'approved', note: 'ok' })); assert.equal(v.status, 'approved'); assert.ok(v.bill_id && v.payment_id);
      no(await call('POST', `expense_claims/${c1}/decide`, { status: 'approved' }), /already decided/);
    });
    // booked on the project with its VAT; no company money moved yet; owed to the employee in 2260
    const bill = ok(await call('GET', 'bills')).find(b => b.reference === 'RCPT-1');
    assert.equal(bill.project_id, prj); assert.equal(bill.amount, 200); assert.equal(bill.vat_amount, 10); assert.equal(bill.balance, 0); assert.match(bill.description, /claim of Worker One/);
    assert.equal(await credit('2260'), 210); assert.equal(await credit('1200'), -10); assert.equal(await credit('1000'), 0, 'no bank movement on approval');
    await as('worker1', async () => { const n = ok(await call('GET', 'notifications')); assert.ok(n.items.some(x => /approved/.test(x.title)), 'the employee is told'); });

    // nobody approves their own claim; a rejection needs a reason and reaches the employee
    const c3 = await as('mgr3', async () => ok(await call('POST', 'me/claims', { date: '2026-09-12', description: 'Client lunch', amount: 300, vat_amount: 15, category: 'overhead' })).id);
    await as('mgr3', async () => no(await call('POST', `expense_claims/${c3}/decide`, { status: 'approved' }), /their own/));
    const c4 = ok(await call('POST', 'expense_claims', { employee_id: E2, date: '2026-09-15', description: 'Tools', amount: 1000, category: 'equipment', project_id: prj }));   // entered by the administrator for an employee
    await as('acc', async () => no(await call('POST', `expense_claims/${c4.id}/decide`, { status: 'approved' }), /accountant's approval limit/));
    await as('mgr3', async () => ok(await call('POST', `expense_claims/${c4.id}/decide`, { status: 'rejected', note: 'no receipt' })));
    ok(await call('POST', `expense_claims/${c3}/decide`, { status: 'approved' }));   // the administrator approves the manager's claim
    // the accountant does not approve a claim he entered himself; the administrator may approve one he entered for an employee
    const c6 = await as('acc', async () => ok(await call('POST', 'expense_claims', { employee_id: E1, date: '2026-09-16', description: 'Nails', amount: 40, category: 'materials', project_id: prj })).id);
    await as('acc', async () => no(await call('POST', `expense_claims/${c6}/decide`, { status: 'approved' }), /entered/));
    const c7 = ok(await call('POST', 'expense_claims', { employee_id: E1, date: '2026-09-16', description: 'Tape', amount: 12, category: 'materials', project_id: prj })).id;
    ok(await call('POST', `expense_claims/${c7}/decide`, { status: 'rejected', note: 'duplicate' }));
    await as('acc', async () => ok(await call('DELETE', `expense_claims/${c6}`)));
    assert.equal(await credit('2260'), 210 + 315);

    // ---- the payments of a claim are kept from Expense claims only
    const pay1 = ok(await call('GET', `expense_claims/${c1}`)).payment_id;
    no(await call('PUT', `payments/${pay1}`, { amount: 1 }), /expense claim/);
    no(await call('DELETE', `payments/${pay1}`), /expense claim/);
    no(await call('DELETE', `bills/${bill.id}`), /take the approval back/);
    no(await call('POST', 'payments', { kind: 'out', date: '2026-09-20', amount: 5, method: 'employee', bill_id: bill.id }), /expense claims/);

    // ---- reimbursement
    await as('mgr3', async () => assert.equal((await call('POST', 'expense_claims/reimburse', { employee_id: E1, amount: 10 })).s, 403, 'the manager approves, the accounts pay'));
    await as('acc', async () => {
      no(await call('POST', 'expense_claims/reimburse', { employee_id: E1, date: '2026-09-20', amount: 210.01, method: 'bank' }), /not yet reimbursed: 210/);
      ok(await call('POST', 'expense_claims/reimburse', { employee_id: E1, date: '2026-09-20', amount: 210, method: 'bank', reference: 'TT-9' }));
    });
    assert.equal(await credit('2260'), 315); assert.equal(await credit('1000'), 210, 'the bank pays the employee (credit)');
    no(await call('POST', `expense_claims/${c1}/undo`), /already reimbursed/);
    await as('acc', async () => no(await call('POST', `expense_claims/${c3}/undo`), /Only the administrator/));
    ok(await call('POST', `expense_claims/${c3}/undo`));   // the manager's claim, not yet reimbursed: back to pending, bill gone
    assert.equal(ok(await call('GET', `expense_claims/${c3}`)).status, 'pending'); assert.equal(await credit('2260'), 0);
    ok(await call('POST', `expense_claims/${c3}/decide`, { status: 'approved' }));
    // a reimbursement dated today is company cash out (dashboard), an approval is not
    const outNow = async () => { const m = ok(await call('GET', 'dashboard')).months; return m[m.length - 1].out; };
    let before = await outNow();
    const rid = await as('acc', async () => ok(await call('POST', 'expense_claims/reimburse', { employee_id: E3, amount: 15, method: 'cash' })).id);
    assert.equal(Math.round((await outNow() - before) * 100) / 100, 15, 'reimbursement counted as cash out');
    await as('acc', async () => ok(await call('DELETE', `expense_claims/reimburse/${rid}`)));

    // ---- salaries and advances in the statement
    ok(await call('POST', 'hr/loans', { employee_id: E1, amount: 600, installments: 2, start_month: '2026-08' }));
    for (const mo of ['2026-07', '2026-08']) { ok(await call('POST', 'payroll/generate', { month: mo })); ok(await call('POST', 'payroll/finalize', { month: mo }), 'finalize ' + mo); }
    ok(await call('POST', 'payroll/pay', { month: '2026-08', date: '2026-09-03' }));
    const net = mo => call('GET', 'payroll?month=' + mo).then(r => ok(r).find(x => x.employee_id === E1).net);
    const n7 = await net('2026-07'), n8 = await net('2026-08');
    assert.equal(n7, 3000); assert.equal(n8, 2700, 'August net after the 300 advance instalment');
    let s = ok(await call('GET', `staff_statements/${E1}?to=2026-12-31`));
    assert.equal(s.sections.salary.closing, 3000, 'July due, August paid'); assert.equal(s.sections.salary.lines.length, 3);
    assert.equal(s.sections.advance.closing, -300, 'half the advance still owed by the employee');
    assert.equal(s.sections.claims.closing, 0); assert.equal(s.sections.claims.lines.length, 2);
    assert.equal(s.total, 2700); assert.ok(s.eos_provision >= 0);
    s = ok(await call('GET', `staff_statements/${E1}?from=2026-09-01&to=2026-12-31`));
    assert.equal(s.sections.salary.opening, 5700); assert.equal(s.sections.salary.lines.length, 1);
    const list = ok(await call('GET', 'staff_statements')); const r1 = list.rows.find(r => r.id === E1);
    assert.equal(r1.balances.total, 2700); assert.ok(list.totals.salary >= 3000);
    const doc = await call('GET', `doc/employee_statement/${E1}?to=2026-12-31`); assert.equal(doc.s, 200); assert.match(doc.t, /Employee statement of account/); assert.match(doc.t, /Worker One/); assert.match(doc.t, /2,700\.00/);
    await as('worker1', async () => { const me = ok(await call('GET', 'me/statement?to=2026-12-31')); assert.equal(me.total, 2700); assert.equal(me.employee.id, E1); });
    await as('eng2', async () => { ok(await call('GET', 'me/statement')); ok(await call('GET', 'me/claims')); });   // any role linked to an employee
    // a site role (here not assigned to any project) still sees its own claims: own records are not filtered by the assigned projects
    await as('eng2', async () => {
      const id = ok(await call('POST', 'me/claims', { date: '2026-09-18', description: 'Marker spray', amount: 25, project_id: prj })).id;
      const mine = ok(await call('GET', 'me/claims')); assert.ok(mine.some(c => c.id === id), 'own claim visible to the site engineer');
      ok(await call('DELETE', `me/claims/${id}`));
    });
    await as('acc', async () => { const r = await call('POST', 'me/claims', { description: 'x', amount: 1 }); assert.equal(r.s, 403); assert.match(r.t, /not linked/); });

    // ---- ledger = statements
    let chk = ok(await call('GET', 'ops/checks')).results.find(r => r.id === 'employee_accounts'); assert.equal(chk.status, 'ok', chk.detail);
    ok(await call('POST', 'journal_entries', { date: '2026-09-30', memo: 'manual salary accrual', lines: [{ account: '6200', debit: 50 }, { account: '2200', credit: 50 }] }));
    chk = ok(await call('GET', 'ops/checks')).results.find(r => r.id === 'employee_accounts'); assert.equal(chk.status, 'warn'); assert.match(chk.detail, /2200/); assert.doesNotMatch(chk.detail, /\d+\.\d\d/, 'no amounts');

    // ---- roles
    await as('hr1', async () => { ok(await call('GET', 'staff_statements')); assert.equal((await call('GET', 'expense_claims')).s, 403); });
    await as('view1', async () => { assert.equal((await call('GET', 'staff_statements')).s, 403); assert.equal((await call('GET', 'expense_claims')).s, 403); assert.equal((await call('GET', `doc/employee_statement/${E1}`)).s, 403); });
    await as('mgr3', async () => { ok(await call('GET', 'expense_claims')); assert.equal((await call('GET', 'staff_statements')).s, 403); });

    // ---- Zoho: an expense with no supplier paid by an employee is not sent as a company bank payment
    const zx = await call('GET', 'zoho/export?kind=expenses'); assert.equal(zx.s, 200); assert.doesNotMatch(zx.t, /Site fuel/);
    const zp = await call('GET', 'zoho/export?kind=vendor_payments'); assert.doesNotMatch(zp.t, /TT-9/);

    // ---- closed period
    const c5 = await as('worker1', async () => ok(await call('POST', 'me/claims', { date: '2026-09-25', description: 'Water', amount: 20 })).id);
    ok(await call('PUT', 'period', { lock_date: '2026-09-30' }));
    no(await call('POST', `expense_claims/${c5}/decide`, { status: 'approved' }), /closed/);
    await as('acc', async () => no(await call('POST', 'expense_claims/reimburse', { employee_id: E3, date: '2026-09-28', amount: 1 }), /closed/));
    ok(await call('PUT', 'period', { lock_date: '' }));
    // withdraw a pending claim (own) — not someone else's
    await as('eng2', async () => assert.equal((await call('DELETE', `me/claims/${c5}`)).s, 404));
    await as('worker1', async () => ok(await call('DELETE', `me/claims/${c5}`)));
    await as('worker1', async () => no(await call('DELETE', `me/claims/${c1}`), /pending/));

    console.log('EMPLOYEE ACCOUNTS TESTS PASSED');
  } catch (e) { console.error(e); process.exitCode = 1; } finally { server.close(); process.exit(process.exitCode || 0); }
});
