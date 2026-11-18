// Petty cash held by employees: request, approval rule, hand-over against the approved request, expenses paid from the petty
// cash (as expense claims, same approval rule), return, the employee statement, the office float kept apart, the ledger, the
// acknowledgement of receipt, roles, closed period, Zoho.   node --no-warnings test-pettycustody.js      Fake data only.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-petty-'));
const { server } = require('./server.js');

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api/`; let cookie = '';
  const call = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j, t }; };
  const ok = (r, m = '') => { assert.equal(r.s, 200, m + ' ' + JSON.stringify(r.j)); return r.j; };
  const no = (r, re, m = '') => { assert.ok(r.s >= 400, m + ' expected a refusal, got ' + r.s + ' ' + JSON.stringify(r.j)); if (re) assert.match(JSON.stringify(r.j), re, m); return r.j; };
  const sessions = {};
  const as = async (u, fn) => { const keep = cookie; cookie = sessions[u] || ''; try { return await fn(); } finally { sessions[u] = cookie; cookie = keep; } };
  const credit = async code => { const f = ok(await call('GET', 'financials?from=2000-01-01&to=2099-12-31')); const r = f.trial_balance.find(x => x.code === code); return r ? Math.round((r.credit - r.debit) * 100) / 100 : 0; };
  const WPS = { person_code: '12345678901234', routing_code: '302620122', iban: 'AE070331234567890123456' };
  try {
    ok(await call('POST', 'setup', { username: 'admin', password: 'secret12', company: 'Test Contracting' })); sessions.admin = cookie;
    ok(await call('PUT', 'settings', { trn: '100123456700003', staff_approval_accountant_limit: '500' }));
    const prj = ok(await call('POST', 'projects', { name: 'Test Project', status: 'active' })).id;
    const E1 = ok(await call('POST', 'employees', { name: 'Foreman One', join_date: '2026-01-01', basic: 3000, project_id: prj, ...WPS })).id;
    const E2 = ok(await call('POST', 'employees', { name: 'Driver Two', join_date: '2026-01-01', basic: 2500, project_id: prj, ...WPS })).id;
    for (const [u, role, e] of [['fore1', 'foreman', E1], ['mgr', 'manager', null], ['acc', 'accountant', null], ['view1', 'viewer', null]]) ok(await call('POST', 'users', { username: u, password: 'pass1234', role, ...(e ? { employee_id: e } : {}) }));
    for (const u of ['fore1', 'mgr', 'acc', 'view1']) { cookie = ''; ok(await call('POST', 'login', { username: u, password: 'pass1234' })); sessions[u] = cookie; }
    cookie = sessions.admin;

    // the office float, as before
    ok(await call('POST', 'petty_topups', { date: '2026-09-01', amount: 1000, note: 'office float' }));
    assert.equal(ok(await call('GET', 'petty_topups')).balance, 1000);

    // ---- request → approval → hand-over
    const rq = await as('fore1', async () => {
      no(await call('POST', 'me/petty/requests', { amount: 800 }), /what the petty cash is for/);
      return ok(await call('POST', 'me/petty/requests', { amount: 800, purpose: 'Site consumables for September' })).id;
    });
    await as('acc', async () => {
      const r = ok(await call('GET', 'petty_requests?status=pending')).find(x => x.id === rq); assert.equal(r.can_decide, false); assert.match(r.block, /limit/);
      no(await call('POST', `petty_requests/${rq}/decide`, { status: 'approved' }), /accountant's approval limit/);
      no(await call('POST', 'petty_custody/handover', { employee_id: E1, date: '2026-09-02', amount: 800, method: 'bank', request_id: rq }), /not approved/);
    });
    await as('fore1', async () => assert.equal((await call('POST', `petty_requests/${rq}/decide`, { status: 'approved' })).s, 403, 'a foreman cannot approve'));
    await as('mgr', async () => { no(await call('POST', `petty_requests/${rq}/decide`, { status: 'rejected' }), /reason/); ok(await call('POST', `petty_requests/${rq}/decide`, { status: 'approved', note: 'ok' })); });
    await as('mgr', async () => assert.equal((await call('POST', 'petty_custody/handover', { employee_id: E1, amount: 800, request_id: rq })).s, 403, 'the manager approves, the accounts hand over'));
    const h1 = await as('acc', async () => {
      no(await call('POST', 'petty_custody/handover', { employee_id: E1, date: '2026-09-02', amount: 900, method: 'bank', request_id: rq }), /More than the approved amount/);
      no(await call('POST', 'petty_custody/handover', { employee_id: E1, date: '2026-09-02', amount: 100, method: 'cash' }), /against an approved request/);
      const id = ok(await call('POST', 'petty_custody/handover', { employee_id: E1, date: '2026-09-02', amount: 800, method: 'bank', request_id: rq })).id;
      no(await call('POST', 'petty_custody/handover', { employee_id: E1, date: '2026-09-02', amount: 800, method: 'bank', request_id: rq }), /not approved \(or was already paid\)/);
      return id;
    });
    ok(await call('POST', 'petty_custody/handover', { employee_id: E1, date: '2026-09-03', amount: 100, method: 'cash', note: 'extra' }));   // the administrator may hand over directly
    let me = await as('fore1', async () => ok(await call('GET', 'me/petty'))); assert.equal(me.held, 900); assert.equal(me.requests[0].status, 'paid');
    assert.equal(ok(await call('GET', 'petty_topups')).balance, 1000, 'the office float is not changed by petty cash held by an employee');
    assert.equal(await credit('1010'), -1900, '1010 = office float + petty cash held by employees');

    // ---- spending from the petty cash: an expense claim "paid from my petty cash", same approval rule
    const c1 = await as('fore1', async () => {
      const id = ok(await call('POST', 'me/claims', { date: '2026-09-05', description: 'Drinking water', amount: 300, vat_amount: 15, category: 'other', project_id: prj, paid_from: 'custody' })).id;
      no(await call('POST', 'me/claims', { date: '2026-09-06', description: 'Cement bags', amount: 600, project_id: prj, paid_from: 'custody' }), /available to this employee: 585/);
      return id;
    });
    await as('acc', async () => ok(await call('POST', `expense_claims/${c1}/decide`, { status: 'approved' })));
    const bill = ok(await call('GET', 'bills')).find(b => /Drinking water/.test(b.description));
    assert.equal(bill.project_id, prj); assert.equal(bill.vat_amount, 15); assert.equal(bill.balance, 0); assert.match(bill.description, /petty cash of Foreman One/);
    assert.equal(await credit('2260'), 0, 'not owed to the employee: paid from the company petty cash'); assert.equal(await credit('1010'), -1585);
    me = await as('fore1', async () => ok(await call('GET', 'me/petty'))); assert.equal(me.held, 585);
    let s = ok(await call('GET', `staff_statements/${E1}`)); assert.equal(s.sections.custody.closing, -585, 'cash held: owed to the company until spent or returned'); assert.equal(s.sections.custody.lines.length, 3);
    let chk = ok(await call('GET', 'ops/checks')).results.find(r => r.id === 'employee_accounts'); assert.equal(chk.status, 'ok', chk.detail);
    // an own-money claim still goes to 2260
    const c2 = await as('fore1', async () => ok(await call('POST', 'me/claims', { date: '2026-09-07', description: 'Taxi', amount: 40, project_id: prj })).id);
    await as('acc', async () => ok(await call('POST', `expense_claims/${c2}/decide`, { status: 'approved' })));
    assert.equal(await credit('2260'), 40);

    // ---- return what is left
    await as('acc', async () => {
      no(await call('POST', 'petty_custody/return', { employee_id: E1, date: '2026-09-30', amount: 600, method: 'cash' }), /holds 585/);
      const p3 = await as('fore1', async () => ok(await call('POST', 'me/claims', { date: '2026-09-08', description: 'Rope', amount: 100, project_id: prj, paid_from: 'custody' })).id);
      no(await call('POST', 'petty_custody/return', { employee_id: E1, date: '2026-09-30', amount: 585, method: 'cash' }), /waiting for approval/);
      await as('mgr', async () => ok(await call('POST', `expense_claims/${p3}/decide`, { status: 'rejected', note: 'not needed' })));
      ok(await call('POST', 'petty_custody/return', { employee_id: E1, date: '2026-09-30', amount: 500, method: 'cash' }));
    });
    me = await as('fore1', async () => ok(await call('GET', 'me/petty'))); assert.equal(me.held, 85);
    assert.equal(await credit('1020'), 100 - 500, 'cash on hand: 100 out (direct hand-over), 500 back');
    chk = ok(await call('GET', 'ops/checks')).results.find(r => r.id === 'employee_accounts'); assert.equal(chk.status, 'ok', chk.detail);

    // ---- deletions keep the custody consistent; generic routes cannot touch it
    no(await call('DELETE', `petty_topups/${h1}`), /per employee/); no(await call('PUT', `petty_topups/${h1}`, { amount: 1 }), /per employee/);
    no(await call('DELETE', `petty_custody/${h1}`), /already spent/);
    const ret = ok(await call('GET', 'petty_custody')).handovers.find(t => t.kind === 'return').id;
    ok(await call('DELETE', `petty_custody/${ret}`)); assert.equal((await as('fore1', async () => ok(await call('GET', 'me/petty')))).held, 585);
    await as('acc', async () => ok(await call('POST', 'petty_custody/return', { employee_id: E1, date: '2026-09-30', amount: 500, method: 'cash' })));
    no(await call('DELETE', `bills/${bill.id}`), /take the approval back/);

    // ---- overview, acknowledgement of receipt
    const ov = ok(await call('GET', 'petty_custody')); const c = ov.custodians.find(x => x.id === E1);
    assert.equal(c.held, 85); assert.equal(ov.float, 1000); assert.equal(ov.held_by_employees, 85);
    const doc = await call('GET', `doc/custody_receipt/${h1}`); assert.equal(doc.s, 200);
    assert.match(doc.t, /Acknowledgement of petty cash received/); assert.match(doc.t, /Foreman One/); assert.match(doc.t, /800\.00/); assert.match(doc.t, /أقرّ/);

    // ---- the old petty cash page keeps working on the office float
    ok(await call('POST', 'petty_topups/expense', { description: 'Office tea', amount: 50, project_id: prj }));
    assert.equal(ok(await call('GET', 'petty_topups')).balance, 950); assert.equal((await as('fore1', async () => ok(await call('GET', 'me/petty')))).held, 85);
    chk = ok(await call('GET', 'ops/checks')).results.find(r => r.id === 'employee_accounts'); assert.equal(chk.status, 'ok', chk.detail);

    // ---- roles
    await as('mgr', async () => { ok(await call('GET', 'petty_custody')); ok(await call('GET', 'petty_requests')); assert.equal((await call('POST', 'petty_custody/return', { employee_id: E1, amount: 1 })).s, 403); });
    await as('view1', async () => { assert.equal((await call('GET', 'petty_custody')).s, 403); assert.equal((await call('GET', 'petty_requests')).s, 403); assert.equal((await call('GET', `doc/custody_receipt/${h1}`)).s, 403); });
    await as('fore1', async () => { assert.equal((await call('GET', 'petty_custody')).s, 403); assert.equal((await call('GET', `petty_custody/${E2}`)).s, 403); });
    // withdraw a pending request (own only)
    const rq2 = await as('fore1', async () => ok(await call('POST', 'me/petty/requests', { amount: 50, purpose: 'Fuel' })).id);
    await as('acc', async () => ok(await call('POST', 'petty_requests', { employee_id: E2, amount: 30, purpose: 'Parking' })));
    await as('fore1', async () => ok(await call('DELETE', `me/petty/requests/${rq2}`)));

    // ---- closed period
    ok(await call('PUT', 'period', { lock_date: '2026-09-30' }));
    no(await call('POST', 'petty_custody/handover', { employee_id: E2, date: '2026-09-15', amount: 10 }), /closed/);
    no(await call('DELETE', `petty_custody/${h1}`), /closed/);
    ok(await call('PUT', 'period', { lock_date: '' }));

    // ---- Zoho: an expense paid from petty cash goes as a cash expense like any petty cash expense
    const zx = await call('GET', 'zoho/export?kind=expenses'); assert.match(zx.t, /Drinking water/); assert.match(zx.t, /Petty Cash/); assert.doesNotMatch(zx.t, /Taxi/);

    console.log('PETTY CASH PER EMPLOYEE TESTS PASSED');
  } catch (e) { console.error(e); process.exitCode = 1; } finally { server.close(); process.exit(process.exitCode || 0); }
});
