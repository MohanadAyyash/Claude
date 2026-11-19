// Employee accounts and expense claims: claim with receipt, approval rule (manager and administrator any amount, accountant up to
// the limit, nobody their own), booking on the project with VAT, reimbursement, taking an approval back, the employee statement
// (salaries due and paid, advances and instalments, expense claims), reconciliation with the ledger, roles, closed period, Zoho.
//   node --no-warnings test-staffaccounts.js          Fake names and amounts only.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-staff-'));
const { server, ctx } = require('./server.js');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api/`; let cookie = '';
  let call = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j, t }; };
  // accounting invariants after every change that went through: debits = credits, and the employee sub-ledgers equal the general
  // ledger (no FAIL in the partner or employee reconciliations). INV is off only where a test breaks the books on purpose.
  let INV = true, invRuns = 0;
  const invariants = what => {
    const f = ctx.financials('2000-01-01', '2099-12-31');
    assert.ok(Math.abs(f.tb_debit - f.tb_credit) < 0.006, `after ${what}: debits ${f.tb_debit} ≠ credits ${f.tb_credit}`);
    const bad = [...ctx.partnerChecks(), ...ctx.staffChecks()].filter(c => c.status === 'fail'); assert.equal(bad.length, 0, `after ${what}: ${bad.map(c => c.detail).join('; ')}`);
    invRuns++;
  };
  const call0 = call;
  call = async (m, u, b) => { const r = await call0(m, u, b); if (INV && m !== 'GET' && r.s === 200) invariants(`${m} ${u}`); return r; };
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
    const E5 = ok(await call('POST', 'employees', { name: 'Accountant Five', join_date: '2026-01-01', basic: 7000, ...WPS })).id;
    for (const [u, role, e] of [['worker1', 'employee', E1], ['eng2', 'site_engineer', E2], ['mgr3', 'manager', E3], ['acc', 'accountant', E5], ['hr1', 'hr', null], ['view1', 'viewer', null], ['mgr9', 'manager', null]])
      ok(await call('POST', 'users', { username: u, password: 'pass1234', role, ...(e ? { employee_id: e } : {}) }), 'user ' + u);
    for (const u of ['worker1', 'eng2', 'mgr3', 'acc', 'hr1', 'view1', 'mgr9']) { await login(u); }
    cookie = sessions.admin;
    // a staff account may be linked to its employee record (optional); one account per employee
    no(await call('POST', 'users', { username: 'dup', password: 'pass1234', role: 'qs', employee_id: E1 }), /already has an account/);
    const users = ok(await call('GET', 'users')), uid = n => users.find(u => u.username === n).id;
    assert.equal(users.find(u => u.username === 'mgr3').employee_id, E3);
    no(await call('PUT', `users/${uid('worker1')}`, { employee_id: '' }), /must stay linked/);
    no(await call('PUT', `users/${uid('hr1')}`, { employee_id: E2 }), /already has an account/);
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
      no(await call('POST', 'me/claims', { date: '2026-09-18', description: 'Marker spray', amount: 25, project_id: prj }), /not assigned/);   // F7
      const id = ok(await call('POST', 'me/claims', { date: '2026-09-18', description: 'Marker spray', amount: 25 })).id;
      const mine = ok(await call('GET', 'me/claims')); assert.ok(mine.some(c => c.id === id), 'own claim visible to the site engineer');
      ok(await call('DELETE', `me/claims/${id}`));
    });
    await as('hr1', async () => { const r = await call('POST', 'me/claims', { description: 'x', amount: 1 }); assert.equal(r.s, 403); assert.match(r.t, /not linked/); });

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

    // ================= review fixes =================
    // D1: a manager whose account is not linked to an employee record cannot approve (else he could enter and approve his own claim)
    const c8 = await as('worker1', async () => ok(await call('POST', 'me/claims', { date: '2026-10-01', description: 'Bolts', amount: 60, project_id: prj })).id);
    await as('mgr9', async () => { no(await call('POST', `expense_claims/${c8}/decide`, { status: 'approved' }), /Link your account/); assert.equal(ok(await call('GET', 'expense_claims')).rows.find(r => r.id === c8).can_decide, false); });
    // D2: the accountant's limit counts all of an employee's claims of the same day (no splitting)
    await as('acc', async () => ok(await call('POST', `expense_claims/${c8}/decide`, { status: 'approved' })));
    const c9 = await as('worker1', async () => ok(await call('POST', 'me/claims', { date: '2026-10-01', description: 'Bolts part 2', amount: 450, project_id: prj })).id);
    await as('acc', async () => no(await call('POST', `expense_claims/${c9}/decide`, { status: 'approved' }), /same day/));
    await as('mgr3', async () => ok(await call('POST', `expense_claims/${c9}/decide`, { status: 'approved' })));
    // D3: a reimbursement above the payment approval limit is recorded by the administrator only
    ok(await call('PUT', 'settings', { pay_approval_limit: '100' }));
    await as('acc', async () => no(await call('POST', 'expense_claims/reimburse', { employee_id: E1, date: '2026-10-05', amount: 510, method: 'bank' }), /approval limit/));
    await as('acc', async () => ok(await call('POST', 'expense_claims/reimburse', { employee_id: E1, date: '2026-10-05', amount: 100, method: 'bank' })));
    // backdated: a reimbursement cannot be dated before the claims it pays existed
    no(await call('POST', 'expense_claims/reimburse', { employee_id: E1, date: '2026-09-30', amount: 410, method: 'bank' }), /not yet reimbursed on 2026-09-30/);
    ok(await call('POST', 'expense_claims/reimburse', { employee_id: E1, date: '2026-10-05', amount: 410, method: 'bank' }));
    ok(await call('PUT', 'settings', { pay_approval_limit: '' }));
    // F5: the bill of an approved claim keeps the claim's figures
    const b8 = ok(await call('GET', `expense_claims/${c8}`)).bill_id;
    no(await call('PUT', `bills/${b8}`, { amount: 1000 }), /expense claim/); no(await call('PUT', `bills/${b8}`, { project_id: '' }), /expense claim/);
    // F3: an employee with claims (or payments) cannot be deleted
    no(await call('DELETE', `employees/${E3}`), /expense claims/);
    const E6 = ok(await call('POST', 'employees', { name: 'Temp Six', join_date: '2026-01-01', basic: 1000, ...WPS })).id;
    ok(await call('POST', 'expense_claims', { employee_id: E6, date: '2026-10-02', description: 'x', amount: 5 }));
    no(await call('DELETE', `employees/${E6}`), /expense claims/);
    // F1: offboarding an employee disables only an employee-portal account; a staff account (here the administrator) is unlinked, not locked out
    const E7 = ok(await call('POST', 'employees', { name: 'Owner Seven', join_date: '2026-01-01', basic: 1000, ...WPS })).id;
    const uAdmin = ok(await call('GET', 'users')).find(u => u.username === 'admin').id;
    ok(await call('PUT', `users/${uAdmin}`, { employee_id: E7 }));
    const offW = await as('hr1', async () => { ok(await call('POST', `hr/offboarding/${E7}`, { last_day: '2026-11-30', reason: 'resignation' })); return ok(await call('POST', `hr/offboarding/${E7}/complete`, { force: true })).warnings; });
    assert.equal(offW.length, 1); assert.match(offW[0], /administrator account "admin".*still active/, 'the administrator is warned, not locked out');
    ok(await call('GET', 'users'), 'the administrator is still signed in');
    assert.equal(ok(await call('GET', 'users')).find(u => u.id === uAdmin).employee_id, null, 'the administrator account is unlinked');
    // F9: an account code 2260 the company already used is not taken over
    const a2260 = ctx.db.prepare("SELECT * FROM accounts WHERE code='2260'").get();
    INV = false;   // the books are broken on purpose here
    ctx.db.prepare("UPDATE accounts SET system=0, name='Other payables' WHERE code='2260'").run();
    const cF9 = await as('worker1', async () => ok(await call('POST', 'me/claims', { date: '2026-10-03', description: 'Paint', amount: 30 })).id);
    await as('mgr3', async () => no(await call('POST', `expense_claims/${cF9}/decide`, { status: 'approved' }), /already used/));
    let chk2 = ok(await call('GET', 'ops/checks')).results.find(r => r.id === 'employee_accounts'); assert.equal(chk2.status, 'fail'); assert.match(chk2.detail, /2260 is already used/);
    ctx.db.prepare('UPDATE accounts SET system=?, name=? WHERE code=?').run(a2260.system, a2260.name, '2260');
    INV = true; invariants('restoring account 2260');

    // ---- accounting review: no double posting, one transaction per posting
    const E11 = ok(await call('POST', 'employees', { name: 'Clerk Eleven', join_date: '2026-01-01', basic: 1000, ...WPS })).id;
    const c11 = ok(await call('POST', 'expense_claims', { employee_id: E11, date: '2026-10-12', description: 'Taxi', amount: 60 })).id;
    ok(await call('POST', `expense_claims/${c11}/decide`, { status: 'approved' }));
    no(await call('POST', `expense_claims/${c11}/decide`, { status: 'approved' }), /already decided/, 'approving twice does not post twice');
    const ct = await call('POST', 'expense_claims', { employee_id: E11, date: '2026-10-12', description: 'Taxi back', amount: 60 }); ok(ct);
    ok(await call('POST', `expense_claims/${ct.j.id}/decide`, { status: 'approved' }));
    const rb = { employee_id: E11, date: '2026-10-20', amount: 60, method: 'bank' };
    ok(await call('POST', 'expense_claims/reimburse', rb));
    const rb2 = await call('POST', 'expense_claims/reimburse', rb); assert.equal(rb2.s, 409); assert.match(rb2.j.error, /^DUPLICATE: /);
    assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM payments WHERE employee_id=? AND notes='claim-reimbursement'").get(E11).n, 1);
    ok(await call('POST', 'expense_claims/reimburse', { ...rb, confirm_duplicate: 1 }), 'a second, confirmed reimbursement of the same amount is allowed');
    // an approval that fails half-way leaves nothing behind: no bill without its payment
    const c12 = ok(await call('POST', 'expense_claims', { employee_id: E11, date: '2026-10-21', description: 'Half', amount: 15 })).id;
    const realPrep = ctx.db.prepare.bind(ctx.db);
    ctx.db.prepare = sql => { if (/^INSERT INTO payments/.test(sql)) throw new Error('disk full'); return realPrep(sql); };
    const half = await call('POST', `expense_claims/${c12}/decide`, { status: 'approved' }); ctx.db.prepare = realPrep;
    assert.equal(half.s, 500); assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM bills WHERE description LIKE '%Half%'").get().n, 0, 'the bill was rolled back');
    assert.equal(ctx.db.prepare('SELECT status FROM expense_claims WHERE id=?').get(c12).status, 'pending');
    invariants('the failed approval');

    // ---- second review
    const claimFor = async (eid, date, amount) => { const id = ok(await call('POST', 'expense_claims', { employee_id: eid, date, description: 'Item ' + date, amount })).id; ok(await call('POST', `expense_claims/${id}/decide`, { status: 'approved' })); return id; };
    // 1. a backdated reimbursement must not leave the claims balance below zero on a past day
    const E8 = ok(await call('POST', 'employees', { name: 'Clerk Eight', join_date: '2026-01-01', basic: 1000, ...WPS })).id;
    await claimFor(E8, '2026-10-10', 100);
    ok(await call('POST', 'expense_claims/reimburse', { employee_id: E8, date: '2026-10-20', amount: 100, method: 'bank' }));
    await claimFor(E8, '2026-11-01', 100);
    no(await call('POST', 'expense_claims/reimburse', { employee_id: E8, date: '2026-10-15', amount: 100, method: 'bank' }), /paid more than the approved claims on 2026-10-20/);
    // … nor taking back an old approval that was already paid back
    const E9 = ok(await call('POST', 'employees', { name: 'Clerk Nine', join_date: '2026-01-01', basic: 1000, ...WPS })).id;
    const c91 = await claimFor(E9, '2026-10-01', 50);
    ok(await call('POST', 'expense_claims/reimburse', { employee_id: E9, date: '2026-10-05', amount: 50, method: 'bank' }));
    const c92 = await claimFor(E9, '2026-10-08', 50);
    no(await call('POST', `expense_claims/${c91}/undo`), /already reimbursed/);
    ok(await call('POST', `expense_claims/${c92}/undo`), 'the later claim, not paid back, can be taken back');
    // 3. a manual journal on 2260 is refused (kept from the claims pages)
    no(await call('POST', 'journal_entries', { date: '2026-10-31', memo: 'adjust', lines: [{ account: '2260', debit: 10 }, { account: '1020', credit: 10 }] }), /kept from the Expense claims/);
    chk2 = ok(await call('GET', 'ops/checks')).results.find(r => r.id === 'employee_accounts'); assert.notEqual(chk2.status, 'fail', chk2.detail); assert.doesNotMatch(chk2.detail || '', /2260/);
    // 4. offboarding with money still open: refused without confirmation, the reason says what is open
    ok(await call('POST', `hr/offboarding/${E8}`, { last_day: '2026-11-30', reason: 'resignation' }));
    no(await call('POST', `hr/offboarding/${E8}/complete`, {}), /Money is still open with this employee — approved expense claims not yet paid back: 100/);
    // 2. offboarding closes every linked account but an administrator's
    const E10 = ok(await call('POST', 'employees', { name: 'Manager Ten', join_date: '2026-01-01', basic: 1000, ...WPS })).id;
    ok(await call('POST', 'users', { username: 'mgr10', password: 'pass1234', role: 'manager', employee_id: E10 }));
    await as('mgr10', async () => ok(await call('POST', 'login', { username: 'mgr10', password: 'pass1234' })));
    await as('mgr10', async () => ok(await call('GET', 'me/statement')));
    ok(await call('POST', `hr/offboarding/${E10}`, { last_day: '2026-11-30', reason: 'resignation' }));
    assert.deepEqual(ok(await call('POST', `hr/offboarding/${E10}/complete`, { force: 1 })).warnings, []);
    assert.equal(ctx.db.prepare("SELECT disabled FROM users WHERE username='mgr10'").get().disabled, 1, 'the manager account is disabled');
    await as('mgr10', async () => assert.equal((await call('GET', 'me/statement')).s, 401, 'and signed out'));
    await as('mgr10x', async () => assert.ok((await call('POST', 'login', { username: 'mgr10', password: 'pass1234' })).s >= 400, 'and cannot sign in'));

    assert.ok(invRuns > 40, 'invariants were checked after every change: ' + invRuns);
    console.log('EMPLOYEE ACCOUNTS TESTS PASSED');
  } catch (e) { console.error(e); process.exitCode = 1; } finally { server.close(); process.exit(process.exitCode || 0); }
});
