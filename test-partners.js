// Partner accounts: capital, partner loans, current accounts, expenses a partner paid, transfers, effective-dated shares,
// year-end profit allocation (day-weighted when shares change), statements, period lock, roles, and the reconciliation of the
// partner sub-ledger with the general ledger.   node --no-warnings test-partners.js
// Fake names and amounts only.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-partners-'));
const { server, ctx } = require('./server.js');

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api/`; let cookie = '';
  const call = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j, t }; };
  const ok = (r, m = '') => { assert.equal(r.s, 200, m + ' ' + JSON.stringify(r.j)); return r.j; };
  const no = (r, re, m = '') => { assert.ok(r.s >= 400, m + ' expected a refusal, got ' + r.s); if (re) assert.match(JSON.stringify(r.j), re, m); return r.j; };
  const tb = async () => { const f = ok(await call('GET', 'financials?from=2000-01-01&to=2099-12-31')); return { f, cr: code => { const r = f.trial_balance.find(x => x.code === code); return r ? Math.round((r.credit - r.debit) * 100) / 100 : 0; } }; };
  const near = (a, b, m) => assert.ok(Math.abs(a - b) < 0.006, `${m}: ${a} ≠ ${b}`);
  try {
    ok(await call('POST', 'setup', { username: 'admin', password: 'secret12', company: 'Test Contracting' }));
    ok(await call('PUT', 'settings', { trn: '100123456700003' }));
    // capital already in the books before partners existed (the old way: a manual journal to 3000)
    ok(await call('POST', 'journal_entries', { date: '2025-01-02', memo: 'Opening capital', lines: [{ account: '1000', debit: 30000 }, { account: '3000', credit: 30000 }] }));

    const A = ok(await call('POST', 'partners', { name: 'Partner Alpha' })).id, B = ok(await call('POST', 'partners', { name: 'Partner Beta' })).id, Cp = ok(await call('POST', 'partners', { name: 'Partner Gamma' })).id;
    no(await call('POST', 'partners', { name: ' ' }), /name/);
    // new accounts exist
    const acc = ok(await call('GET', 'accounts')).map(a => a.code); for (const c of ['2500', '3110', '3900']) assert.ok(acc.includes(c), c);

    // ---- shares 40/40/20, then from 1 July: 40/30/30
    for (const [p, pct] of [[A, 40], [B, 40], [Cp, 20]]) ok(await call('POST', `partners/${p}/shares`, { pct, from_date: '2025-01-01' }));
    const w = ok(await call('POST', `partners/${B}/shares`, { pct: 30, from_date: '2025-07-01' })); assert.match(w.warning || '', /90%/, 'warning while the shares do not add up');
    ok(await call('POST', `partners/${Cp}/shares`, { pct: 30, from_date: '2025-07-01' }));
    no(await call('POST', `partners/${Cp}/shares`, { pct: 30, from_date: '2025-07-01' }), /already/);
    no(await call('POST', `partners/${Cp}/shares`, { pct: 130, from_date: '2025-08-01' }), /between 0 and 100/);
    let L = ok(await call('GET', 'partners')); assert.equal(L.shares_today, 100); assert.equal(L.partners.find(p => p.id === B).share, 30);

    // ---- capital, loans, current account
    no(await call('POST', 'partner_txns', { partner_id: A, date: '2025-01-05', type: 'capital_in', amount: 0, method: 'bank' }), /greater than zero/);
    no(await call('POST', 'partner_txns', { partner_id: A, date: '2025-01-05', type: 'nonsense', amount: 1 }), /type/);
    ok(await call('POST', 'partner_txns', { partner_id: A, date: '2025-01-05', type: 'capital_in', amount: 40000, method: 'bank', reference: 'TT-1' }));
    ok(await call('POST', 'partner_txns', { partner_id: B, date: '2025-01-05', type: 'capital_in', amount: 40000, method: 'bank' }));
    // Gamma's capital is the 30,000 already in the books: assigned, not posted again
    no(await call('POST', 'partner_txns', { partner_id: Cp, date: '2025-01-05', type: 'capital_in', amount: 30000.01, method: 'books' }), /Only 30000/);
    ok(await call('POST', 'partner_txns', { partner_id: Cp, date: '2025-01-05', type: 'capital_in', amount: 30000, method: 'books' }));
    no(await call('POST', 'partner_txns', { partner_id: Cp, date: '2025-01-05', type: 'capital_in', amount: 1, method: 'books' }), /Only 0/);
    no(await call('POST', 'partner_txns', { partner_id: Cp, date: '2025-01-05', type: 'loan_in', amount: 1, method: 'books' }), /capital and current/);
    let T = await tb(); assert.equal(T.cr('3000'), 110000, 'capital = 40,000 + 40,000 + 30,000 (the books part not doubled)');

    ok(await call('POST', 'partner_txns', { partner_id: A, date: '2025-02-01', type: 'loan_in', amount: 50000, method: 'bank' }));
    ok(await call('POST', 'partner_txns', { partner_id: A, date: '2025-06-01', type: 'loan_repay', amount: 20000, method: 'bank' }));
    no(await call('POST', 'partner_txns', { partner_id: A, date: '2025-06-02', type: 'loan_repay', amount: 30000.5, method: 'bank' }), /loan balance on 2025-06-02 is 30000/);
    no(await call('POST', 'partner_txns', { partner_id: B, date: '2025-06-02', type: 'capital_out', amount: 40001, method: 'bank' }), /capital balance on 2025-06-02 is 40000/);
    // backdated: a repayment before the loan existed, or one that leaves a later repayment uncovered
    no(await call('POST', 'partner_txns', { partner_id: A, date: '2025-01-20', type: 'loan_repay', amount: 100, method: 'bank' }), /loan balance on 2025-01-20 is 0/);
    no(await call('POST', 'partner_txns', { partner_id: A, date: '2025-03-01', type: 'loan_repay', amount: 30001, method: 'bank' }), /below zero on 2025-06-01/);
    ok(await call('POST', 'partner_txns', { partner_id: B, date: '2025-03-01', type: 'withdrawal', amount: 5000, method: 'cash' }));   // a current account may go negative (drawings)
    ok(await call('POST', 'partner_txns', { partner_id: Cp, date: '2025-01-01', type: 'withdrawal', amount: 500, method: 'opening' }));   // opening balance owed by the partner
    ok(await call('POST', 'partner_txns', { partner_id: Cp, date: '2025-04-01', type: 'deposit', amount: 1000, method: 'bank' }));

    // ---- an expense a partner paid for the company (new bill, on a project) and a supplier bill he paid
    const cl = ok(await call('POST', 'parties', { type: 'client', name: 'Test Client' })).id, sup = ok(await call('POST', 'parties', { type: 'supplier', name: 'Test Supplier' })).id;
    const prj = ok(await call('POST', 'projects', { name: 'Test Project', client_id: cl })).id;
    no(await call('POST', `partners/${A}/expense`, { date: '2025-03-10', description: '', amount: 10 }), /description/);
    const ex = ok(await call('POST', `partners/${A}/expense`, { date: '2025-03-10', description: 'Site fuel', amount: 1000, vat_amount: 50, category: 'equipment', project_id: prj }));
    // Zoho: an expense with no supplier paid by a partner is not sent (Zoho would book it as paid from the company bank)
    const zx = await call('GET', 'zoho/export?kind=expenses'); assert.equal(zx.s, 200); assert.doesNotMatch(zx.t, /Site fuel/);
    const probe = ok(await call('POST', 'bills', { date: '2025-03-10', description: 'Probe expense', amount: 10 })).id;
    assert.match((await call('GET', 'zoho/export?kind=expenses')).t, /Probe expense/, 'an ordinary expense without a supplier is exported'); ok(await call('DELETE', `bills/${probe}`));
    const bills = ok(await call('GET', 'bills')), eb = bills.find(b => b.id === ex.bill_id);
    assert.equal(eb.project_id, prj); assert.equal(eb.balance, 0, 'the bill is paid');
    const sb = ok(await call('POST', 'bills', { date: '2025-03-12', party_id: sup, description: 'Cement', amount: 2000, vat_amount: 100 })).id;
    no(await call('POST', `partners/${A}/expense`, { date: '2025-03-15', bill_id: sb, amount: 2100.5 }), /open balance/);
    const ex2 = ok(await call('POST', `partners/${A}/expense`, { date: '2025-03-15', bill_id: sb }));
    assert.equal(ok(await call('GET', 'bills')).find(b => b.id === sb).balance, 0);
    // the partner payments are kept from the Partners page only
    no(await call('POST', 'payments', { kind: 'out', date: '2025-03-16', amount: 10, method: 'partner', bill_id: sb }), /Partners page/);
    no(await call('PUT', `payments/${ex2.payment_id}`, { amount: 1 }), /Partners page/);
    no(await call('DELETE', `payments/${ex2.payment_id}`), /Partners page/);
    no(await call('DELETE', `bills/${sb}`), /Partners page/);

    // ---- transfer: current account → capital
    no(await call('POST', 'partner_txns', { partner_id: A, date: '2025-05-01', type: 'transfer', amount: 10, from_section: 'current', to_section: 'current' }), /two different/);
    no(await call('POST', 'partner_txns', { partner_id: A, date: '2025-05-01', type: 'transfer', amount: 3151, from_section: 'current', to_section: 'capital' }), /current account balance on 2025-05-01 is 3150/);
    ok(await call('POST', 'partner_txns', { partner_id: A, date: '2025-05-01', type: 'transfer', amount: 150, from_section: 'current', to_section: 'capital' }));

    // ---- statements
    let s = ok(await call('GET', `partners/${A}/statement?to=2025-12-31`));
    assert.equal(s.sections.capital.closing, 40150); assert.equal(s.sections.loan.closing, 30000); assert.equal(s.sections.current.closing, 3000); assert.equal(s.total, 73150);
    s = ok(await call('GET', `partners/${A}/statement?from=2025-03-01&to=2025-12-31`));
    assert.equal(s.sections.loan.opening, 50000); assert.equal(s.sections.loan.lines.length, 1); assert.equal(s.sections.current.opening, 0); assert.equal(s.sections.current.lines.length, 3);
    s = ok(await call('GET', `partners/${Cp}/statement`)); assert.equal(s.sections.current.closing, 500); assert.equal(s.sections.capital.closing, 30000);
    s = ok(await call('GET', `partners/${B}/statement`)); assert.equal(s.sections.current.closing, -5000, 'drawings: owed by the partner');
    const doc = await call('GET', `doc/partner_statement/${A}?to=2025-12-31`); assert.equal(doc.s, 200); assert.match(doc.t, /Partner statement of account/); assert.match(doc.t, /Partner Alpha/); assert.match(doc.t, /73,150\.00/);

    // ---- general ledger = partner sub-ledger
    T = await tb();
    // a partner-paid expense moves no company money: bank = 30,000 + 40,000 + 40,000 + 50,000 − 20,000 + 1,000; cash = −5,000 (withdrawal)
    assert.equal(T.cr('1000'), -141000, 'bank (debit balance)'); assert.equal(T.cr('1020'), 5000, 'cash (credit balance: the withdrawal)');
    assert.equal(T.cr('3000'), 110150); assert.equal(T.cr('2500'), 30000); assert.equal(T.cr('3110'), 3000 - 5000 + 500); assert.equal(T.cr('3900'), 500, 'opening: the partner owed 500 (debit 3110) against opening equity');
    assert.equal(T.f.tb_debit, T.f.tb_credit, 'trial balance balances');
    L = ok(await call('GET', 'partners')); for (const r of L.reconciliation.rows) assert.equal(r.difference, 0, r.section);
    assert.equal(L.totals.capital, 110150); assert.equal(L.totals.loan, 30000); assert.equal(L.totals.current, -1500);
    const led = ok(await call('GET', 'ledger?account=3110')); assert.ok(led.lines.some(l => /Paid|Payment/.test(l.memo)), 'the partner-paid expense is in the ledger');
    assert.equal(ok(await call('GET', 'ledger?account=1200')).lines.reduce((t, l) => t + l.debit - l.credit, 0), 150, 'input VAT of the partner-paid expenses');
    let chk = ok(await call('GET', 'ops/checks')).results.find(r => r.id === 'partner_accounts'); assert.equal(chk.status, 'ok', chk.detail);

    // manual journals cannot touch the partner accounts any more
    no(await call('POST', 'journal_entries', { date: '2025-05-05', lines: [{ account: '1000', debit: 10 }, { account: '3110', credit: 10 }] }), /Partners page/);
    no(await call('POST', 'journal_entries', { date: '2025-05-05', lines: [{ account: '1000', debit: 10 }, { account: '2500', credit: 10 }] }), /Partners page/);
    no(await call('POST', 'journal_entries', { date: '2025-05-05', lines: [{ account: '1000', debit: 10 }, { account: '3000', credit: 10 }] }), /per partner/);

    // deleting a movement may not leave a capital below zero later
    const out = ok(await call('POST', 'partner_txns', { partner_id: B, date: '2025-09-01', type: 'capital_out', amount: 10000, method: 'bank' })).id;
    const capB = ok(await call('GET', 'partner_txns')).find(t => t.partner_id === B && t.type === 'capital_in').id;
    no(await call('DELETE', `partner_txns/${capB}`), /below zero/);
    ok(await call('DELETE', `partner_txns/${out}`));

    // ---- profit allocation 2025 (revenue 100,000 − expenses 3,000 = 97,000), day-weighted: 181 days 40/40/20, 184 days 40/30/30
    ok(await call('POST', 'invoices', { project_id: prj, date: '2025-10-01', vat_pct: 0, items: [{ description: 'Works', qty: 1, rate: 100000 }] }));
    let pv = ok(await call('GET', 'partners/allocation-preview?year=2025'));
    assert.equal(pv.ok, true, pv.problems.join(';')); assert.equal(pv.net_profit, 97000); assert.equal(pv.segments.length, 2); assert.equal(pv.segments[0].days, 181); assert.equal(pv.segments[1].days, 184);
    const la = pv.lines.find(l => l.partner_id === A), lb = pv.lines.find(l => l.partner_id === B), lc = pv.lines.find(l => l.partner_id === Cp);
    assert.equal(la.pct, 40); near(lb.pct, 34.96, 'Beta'); near(lc.pct, 25.04, 'Gamma');
    near(lb.amount, 97000 * (181 * 40 + 184 * 30) / 36500, 'Beta amount'); near(lc.amount, 97000 * (181 * 20 + 184 * 30) / 36500, 'Gamma amount');
    assert.equal(Math.round((la.amount + lb.amount + lc.amount) * 100), 9700000, 'the whole profit, to the cent');
    assert.equal(ok(await call('GET', 'partners/allocation-preview?year=2099')).ok, false, 'a year that has not ended');
    const al = ok(await call('POST', 'partner_allocations', { year: 2025 }));
    no(await call('POST', 'partner_allocations', { year: 2025 }), /already allocated/);
    no(await call('POST', `partners/${A}/shares`, { pct: 50, from_date: '2025-12-01' }), /already allocated/);
    T = await tb(); assert.equal(T.cr('3110'), -1500 + 97000); assert.equal(T.cr('3100'), -97000); assert.equal(T.f.tb_debit, T.f.tb_credit);
    s = ok(await call('GET', `partners/${A}/statement`)); assert.equal(s.sections.current.closing, round2(3000 + la.amount));
    L = ok(await call('GET', 'partners')); for (const r of L.reconciliation.rows) assert.equal(r.difference, 0, 'after allocation ' + r.section);
    // a late 2025 expense: the allocation is out of date → warning, then allocate again
    ok(await call('POST', 'bills', { date: '2025-12-20', party_id: sup, description: 'Late bill', amount: 1000 }));
    chk = ok(await call('GET', 'ops/checks')).results.find(r => r.id === 'partner_accounts'); assert.equal(chk.status, 'warn'); assert.match(chk.detail, /changed after it was allocated/); assert.doesNotMatch(chk.detail, /\d{4,}\.\d|96000|97000/, 'no amounts in the daily check');
    ok(await call('DELETE', `partner_allocations/${al.id}`));
    pv = ok(await call('POST', 'partner_allocations', { year: 2025 })); assert.equal(pv.net_profit, 96000);
    chk = ok(await call('GET', 'ops/checks')).results.find(r => r.id === 'partner_accounts'); assert.equal(chk.status, 'ok', chk.detail);

    // ---- closed period
    ok(await call('PUT', 'period', { lock_date: '2025-12-31' }));
    no(await call('POST', 'partner_txns', { partner_id: A, date: '2025-11-01', type: 'deposit', amount: 10, method: 'bank' }), /closed/);
    no(await call('DELETE', `partner_txns/${ok(await call('GET', 'partner_txns')).find(t => t.date < '2025-12-31').id}`), /closed/);
    no(await call('DELETE', `partners/expense/${ex.payment_id}`), /closed/);
    no(await call('DELETE', `partner_allocations/${pv.id}`), /closed/);
    no(await call('POST', `partners/${A}/expense`, { date: '2025-11-01', description: 'x', amount: 10 }), /closed/);
    ok(await call('POST', 'partner_txns', { partner_id: A, date: '2026-01-10', type: 'deposit', amount: 10, method: 'bank' }));
    ok(await call('PUT', 'period', { lock_date: '' }));
    ok(await call('DELETE', `partners/expense/${ex.payment_id}`));
    assert.ok(!ok(await call('GET', 'bills')).some(b => b.id === ex.bill_id), 'the bill the partner page created goes with its payment');

    // a partner-paid expense is not a company cash payment: the dashboard cash-out of this month does not move
    const outNow = () => call('GET', 'dashboard').then(r => { const m = ok(r).months; return m[m.length - 1].out; });
    const before = await outNow(), exNow = ok(await call('POST', `partners/${B}/expense`, { description: 'Taxi', amount: 75 }));
    assert.equal(await outNow(), before, 'cash out unchanged'); ok(await call('DELETE', `partners/expense/${exNow.payment_id}`));
    // ---- review fixes
    // F4: the journal that put capital in the books cannot be moved away or deleted once partners exist
    const jvCap = ok(await call('GET', 'journal_entries')).find(j => j.memo === 'Opening capital').id;
    no(await call('PUT', `journal_entries/${jvCap}`, { date: '2025-01-02', memo: 'moved', lines: [{ account: '1000', debit: 30000 }, { account: '3100', credit: 30000 }] }), /per partner/);
    no(await call('DELETE', `journal_entries/${jvCap}`), /per partner/);
    assert.equal((await tb()).cr('3000'), 110150, 'capital unchanged');
    // F5: a bill paid by a partner keeps its amounts; no bill can drop below what was paid
    const b5 = ok(await call('POST', 'bills', { date: '2026-01-05', party_id: sup, description: 'Steel', amount: 1000 })).id;
    ok(await call('POST', 'payments', { kind: 'out', date: '2026-01-06', amount: 400, method: 'bank', bill_id: b5 }));
    no(await call('PUT', `bills/${b5}`, { amount: 100 }), /below what was already paid/);
    ok(await call('POST', `partners/${A}/expense`, { date: '2026-01-07', bill_id: b5 }));
    no(await call('PUT', `bills/${b5}`, { amount: 1000, vat_amount: 50 }), /paid by a partner/);
    no(await call('PUT', `bills/${b5}`, { date: '2026-01-08' }), /paid by a partner/);
    ok(await call('PUT', `bills/${b5}`, { description: 'Steel bars' }), 'description can still change');
    // F6: deleting a partner payment of an existing supplier bill never deletes the bill (whatever the note says)
    const b6 = ok(await call('POST', 'bills', { date: '2026-01-05', party_id: sup, description: 'Sand', amount: 300 })).id;
    const p6 = ok(await call('POST', `partners/${A}/expense`, { date: '2026-01-07', bill_id: b6, note: 'partner-expense' })).payment_id;
    ok(await call('DELETE', `partners/expense/${p6}`));
    assert.ok(ok(await call('GET', 'bills')).some(b => b.id === b6), 'the supplier bill stays');
    // F8: VAT on a partner expense is at most 5% of the amount
    no(await call('POST', `partners/${A}/expense`, { date: '2026-01-07', description: 'x', amount: 100, vat_amount: 5.02 }), /VAT is more than 5%/);
    // F9: an account code the company already used for something else is not taken over
    const before3110 = ctx.db.prepare("SELECT * FROM accounts WHERE code='2500'").get();
    ctx.db.prepare("UPDATE accounts SET system=0, name='Bank loan' WHERE code='2500'").run();      // as if the company had its own 2500 before the upgrade
    no(await call('POST', 'partner_txns', { partner_id: A, date: '2026-02-02', type: 'loan_in', amount: 10, method: 'bank' }), /already used/);
    ok(await call('POST', 'journal_entries', { date: '2026-02-02', memo: 'own bank loan', lines: [{ account: '1000', debit: 10 }, { account: '2500', credit: 10 }] }), 'the company keeps using its own 2500');
    chk = ok(await call('GET', 'ops/checks')).results.find(r => r.id === 'partner_accounts'); assert.equal(chk.status, 'fail'); assert.match(chk.detail, /2500 is already used/);
    ok(await call('DELETE', `journal_entries/${ok(await call('GET', 'journal_entries')).find(j => j.memo === 'own bank loan').id}`));
    ctx.db.prepare('UPDATE accounts SET system=?, name=? WHERE code=?').run(before3110.system, before3110.name, '2500');

    // a partner with movements cannot be deleted; an unused one can
    no(await call('DELETE', `partners/${A}`), /inactive/);
    const D = ok(await call('POST', 'partners', { name: 'Partner Delta' })).id; ok(await call('DELETE', `partners/${D}`));

    // ---- roles: partner accounts are for the administrator and the accountant only
    for (const [u, role] of [['acc1', 'accountant'], ['pm1', 'manager'], ['view1', 'viewer']]) ok(await call('POST', 'users', { username: u, password: 'pass1234', role }));
    const admin = cookie;
    ok(await call('POST', 'login', { username: 'pm1', password: 'pass1234' }));
    assert.equal((await call('GET', 'partners')).s, 403); assert.equal((await call('GET', `partners/${A}/statement`)).s, 403); assert.equal((await call('GET', `doc/partner_statement/${A}`)).s, 403);
    assert.equal((await call('POST', 'partner_txns', { partner_id: A, date: '2026-02-01', type: 'deposit', amount: 1, method: 'bank' })).s, 403);
    cookie = admin; ok(await call('POST', 'login', { username: 'acc1', password: 'pass1234' }));
    ok(await call('GET', 'partners')); ok(await call('POST', 'partner_txns', { partner_id: A, date: '2026-02-01', type: 'deposit', amount: 1, method: 'bank' }));

    console.log('PARTNERS TESTS PASSED');
  } catch (e) { console.error(e); process.exitCode = 1; } finally { server.close(); process.exit(process.exitCode || 0); }
});
function round2(x) { return Math.round(x * 100) / 100; }
