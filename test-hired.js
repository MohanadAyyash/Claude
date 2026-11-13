// Hired labour (supplier / daily cash workers) and rented equipment, all worked out by the hour: node --no-warnings test-hired.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-hired-'));
process.env.ZOHO_NO_SCHEDULER = '1'; process.env.SALES_NO_SCHEDULER = '1';
const { server } = require('./server.js');

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api/`; let cookie = '';
  const call = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j }; };
  const ok = (r, l) => { assert.equal(r.s, 200, `${l || ''} → ${r.s} ${JSON.stringify(r.j).slice(0, 300)}`); return r.j; };
  const jar = {}; const as = async (u, fn) => { const keep = cookie; cookie = jar[u] || ''; if (!cookie) ok(await call('POST', 'login', { username: u, password: 'secret12' })); jar[u] = cookie; try { return await fn(); } finally { cookie = keep; } };
  const local = d => new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10), day = o => local(new Date(Date.now() + o * 864e5));
  const tb = async () => Object.fromEntries(ok(await call('GET', `financials?from=2000-01-01&to=${day(0)}`)).trial_balance.map(a => [a.code, Math.round((a.debit - a.credit) * 100) / 100]));
  try {
    ok(await call('POST', 'setup', { username: 'admin', password: 'secret12', company: 'Test Co' }));
    const cl = ok(await call('POST', 'parties', { type: 'client', name: 'Client' })).id, lessor = ok(await call('POST', 'parties', { type: 'supplier', name: 'Rental Co', trn: '100000000000011' })).id, agency = ok(await call('POST', 'parties', { type: 'supplier', name: 'Manpower Co' })).id;
    const P = ok(await call('POST', 'projects', { name: 'Roads', client_id: cl, status: 'active' })).id, P2 = ok(await call('POST', 'projects', { name: 'Other', client_id: cl, status: 'active' })).id;
    for (const [u, role] of [['fore', 'foreman'], ['acc', 'accountant'], ['view', 'viewer']]) { const id = ok(await call('POST', 'users', { username: u, password: 'secret12', role })).id; if (role === 'foreman') ok(await call('PUT', 'users/' + id, { projects: [P] })); }

    // ---- rented equipment: monthly rate worked out by the hour (13,000 / 260 h = 50 per hour)
    for (const b of [{ name: '' }, { rate: 0 }, { basis: 'year' }, { party_id: 999 }, { base_hours: 0.5 }, { end_date: day(-30), start_date: day(-10) }])
      assert.equal((await call('POST', 'hire/items', { type: 'equipment', name: 'Excavator', party_id: lessor, basis: 'month', rate: 13000, base_hours: 260, ...b })).s, 400, JSON.stringify(b));
    const ex = ok(await call('POST', 'hire/items', { type: 'equipment', name: 'Excavator 20t', party_id: lessor, project_id: P, basis: 'month', rate: 13000, base_hours: 260, start_date: day(-20), end_date: day(40) })).id;
    const roller = ok(await call('POST', 'hire/items', { type: 'equipment', name: 'Roller', party_id: lessor, project_id: P, basis: 'day', rate: 800, base_hours: 10, start_date: day(-10) })).id;   // daily hire: 80 per hour
    ok(await as('fore', () => call('POST', 'hire/logs', { item_id: ex, date: day(-3), hours: 10 })));
    ok(await as('fore', () => call('POST', 'hire/logs', { item_id: ex, date: day(-2), hours: 12 })));                // 2 extra hours cost the same hourly rate
    ok(await as('fore', () => call('POST', 'hire/logs', { item_id: roller, date: day(-2), hours: 6 })));             // a short day costs 6 hours, not the day rate
    assert.equal((await as('fore', () => call('POST', 'hire/logs', { item_id: ex, date: day(-2), hours: 4 }))).s, 400, 'one entry per machine, project and day');
    assert.equal((await as('fore', () => call('POST', 'hire/logs', { item_id: ex, date: day(-1), project_id: P2, hours: 4 }))).s, 403, 'not his project');
    for (const b of [{ hours: 0 }, { hours: 25 }, { date: day(2) }, { date: day(-60) }, { item_id: 999 }]) assert.equal((await call('POST', 'hire/logs', { item_id: ex, date: day(-1), hours: 5, ...b })).s, 400, JSON.stringify(b));
    let it = ok(await call('GET', 'hire?type=equipment')).find(r => r.id === ex); assert.equal(it.hourly_rate, 50); assert.equal(it.hours_open, 22); assert.equal(it.accrued, 1100);
    assert.equal(ok(await call('GET', 'hire?type=equipment')).find(r => r.id === roller).accrued, 480);
    const fi = ok(await as('fore', () => call('GET', 'hire?type=equipment'))).find(r => r.id === ex); assert.equal(fi.rate, undefined); assert.equal(fi.accrued, undefined); assert.equal(fi.hours_open, 22, 'site roles see hours, not money');
    assert.ok(ok(await as('fore', () => call('GET', 'hire/logs'))).every(l => l.amount === undefined)); assert.equal((await as('fore', () => call('GET', 'hire/accrued'))).s, 403);
    assert.equal(ok(await call('GET', `projects/${P}/budget`)).lines.find(l => l.category === 'equipment').committed, 1580, 'unbilled hours are committed cost on the project');
    console.log('✔ rented equipment: month / day rates worked out by the hour, daily hours per project, accrued cost, site roles without money');

    // ---- the rental company's invoice against the logged hours
    assert.equal((await as('view', () => call('POST', 'hire/invoice', { type: 'equipment', party_id: lessor, project_id: P }))).s, 403);
    assert.equal((await call('POST', 'hire/invoice', { type: 'equipment', party_id: lessor, project_id: P2 })).s, 400, 'nothing logged there');
    const pre = ok(await call('POST', 'hire/invoice', { type: 'equipment', party_id: lessor, project_id: P, amount: 1700, preview: 1 })); assert.equal(pre.accrued, 1580); assert.equal(pre.difference, 120);
    const inv = ok(await as('acc', () => call('POST', 'hire/invoice', { type: 'equipment', party_id: lessor, project_id: P, amount: 1580, vat_amount: 79, reference: 'RC-1001', date: day(0) })));
    const bill = ok(await call('GET', 'bills/' + inv.bill_id)); assert.equal(bill.category, 'equipment'); assert.equal(bill.total, 1659); assert.equal(bill.project_id, P); assert.equal(bill.party_id, lessor);
    assert.equal(ok(await call('GET', 'hire?type=equipment')).find(r => r.id === ex).accrued, 0); assert.equal((await call('POST', 'hire/invoice', { type: 'equipment', party_id: lessor, project_id: P })).s, 400, 'already invoiced');
    const billed = ok(await call('GET', 'hire/logs?type=equipment')).find(l => l.billed); assert.equal((await call('DELETE', 'hire/logs/' + billed.id)).s, 400, 'invoiced hours are locked');
    let t = await tb(); assert.equal(t['5400'], 1580); assert.equal(t['1200'], 79); assert.equal(t['2000'], -1659);
    assert.equal(ok(await call('GET', `projects/${P}/budget`)).lines.find(l => l.category === 'equipment').committed, 0, 'now actual cost, no longer committed');
    console.log('✔ supplier invoice: matched to the logged hours (difference shown), becomes an ordinary bill, hours locked');

    // ---- labour: supply company (invoiced) and daily workers (cash)
    const helpers = ok(await call('POST', 'hire/items', { type: 'labour', source: 'supplier', name: 'Helpers', party_id: agency, project_id: P, basis: 'hour', rate: 12, start_date: day(-10) })).id;
    assert.equal((await call('POST', 'hire/items', { type: 'labour', source: 'supplier', name: 'Helpers', basis: 'hour', rate: 12 })).s, 400, 'a supply company is required');
    const mason = ok(await call('POST', 'hire/items', { type: 'labour', source: 'daily', name: 'Mason (daily)', project_id: P, basis: 'day', rate: 150, base_hours: 10, start_date: day(-10) })).id;
    ok(await as('fore', () => call('POST', 'hire/logs', { item_id: helpers, date: day(-2), qty: 6, hours: 10 })));    // 6 × 10 × 12 = 720
    ok(await as('fore', () => call('POST', 'hire/logs', { item_id: mason, date: day(-2), qty: 2, hours: 10 })));      // 2 × 150 = 300
    ok(await as('fore', () => call('POST', 'hire/logs', { item_id: mason, date: day(-1), qty: 2, hours: 5 })));       // half a day: 150
    assert.equal((await call('POST', 'hire/logs', { item_id: mason, date: day(-1), qty: 1.5, hours: 5 })).s, 400);
    const acc = ok(await call('GET', 'hire/accrued')); assert.equal(acc.find(a => a.source === 'daily').amount, 450); assert.equal(acc.find(a => a.party_id === agency).amount, 720);
    const paid = ok(await as('acc', () => call('POST', 'hire/pay-daily', { project_id: P, method: 'cash', date: day(0) }))); assert.equal(paid.amount, 450);
    const pb = ok(await call('GET', 'bills/' + paid.bill_id)); assert.equal(pb.category, 'labour'); assert.equal(pb.balance, 0, 'paid in cash at once'); assert.equal(pb.party_id, null);
    assert.equal((await call('POST', 'hire/pay-daily', { project_id: P })).s, 400, 'nothing left to pay');
    ok(await call('POST', 'hire/invoice', { type: 'labour', party_id: agency, project_id: P, amount: 720, vat_amount: 36, reference: 'MP-55' }));
    t = await tb(); assert.equal(t['5200'], 1170, 'supplier labour 720 + daily labour 450'); assert.equal(t['1020'], -450, 'cash paid to the daily workers');
    assert.ok(Math.abs(Object.values(t).reduce((s, v) => s + v, 0)) < 0.01, 'trial balance balances');
    assert.equal(ok(await call('GET', 'hire/accrued')).length, 0);
    console.log('✔ hired labour: supply company invoiced, daily workers paid in cash, both reach the ledger as labour cost');

    // ---- alerts, closing, period lock, approval limit
    ok(await call('PUT', 'hire/items/' + ex, { end_date: day(-1) }));
    ok(await call('POST', 'hire/items', { type: 'equipment', name: 'Pump', party_id: lessor, project_id: P, basis: 'day', rate: 200, base_hours: 10, start_date: day(-9) }));       // on hire for 9 days, never used
    const al = ok(await call('GET', 'compliance')); assert.ok(al.some(a => a.key === 'hire_overdue' && /Excavator/.test(a.who))); assert.ok(al.some(a => a.key === 'hire_idle' && a.who === 'Pump')); assert.ok(!al.some(a => a.key === 'hire_idle' && a.who === 'Roller'), 'the roller worked 2 days ago');
    ok(await call('PUT', 'hire/items/' + ex, { returned_date: day(0) })); assert.equal(ok(await call('GET', 'hire?type=equipment')).find(r => r.id === ex).status, 'closed');
    assert.equal((await call('DELETE', 'hire/items/' + ex)).s, 400, 'kept: it has hours'); const empty = ok(await call('POST', 'hire/items', { type: 'equipment', name: 'Crane', party_id: lessor, basis: 'hour', rate: 300 })).id; ok(await call('DELETE', 'hire/items/' + empty));
    ok(await call('POST', 'hire/logs', { item_id: mason, date: day(-1), project_id: P2, qty: 4, hours: 10 }));        // 600 on the other project
    ok(await call('PUT', 'settings', { pay_approval_limit: 500 }));
    assert.equal((await as('acc', () => call('POST', 'hire/pay-daily', { project_id: P2 }))).s, 403, 'above the approval limit');
    ok(await call('PUT', 'period', { lock_date: day(0) }));
    assert.equal((await call('POST', 'hire/pay-daily', { project_id: P2, date: day(0) })).s, 400, 'the period is closed');
    assert.equal((await call('POST', 'hire/logs', { item_id: mason, date: day(-1), qty: 1, hours: 5 })).s, 400, 'no hours into a closed period');
    ok(await call('PUT', 'period', { lock_date: '' })); assert.equal(ok(await call('POST', 'hire/pay-daily', { project_id: P2, date: day(0) })).amount, 600);
    console.log('✔ alerts for items past their end date / idle machines; closed agreements kept; closed period and approval limit respected');
    console.log('HIRED RESOURCES TESTS PASSED');
  } catch (err) { console.error('FAIL', err); process.exitCode = 1; }
  finally { server.close(); setTimeout(() => process.exit(process.exitCode || 0), 100); }
});
