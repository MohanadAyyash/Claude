// Cash-flow forecast, bank guarantees and the over-budget / cash-shortfall alerts: node --no-warnings test-treasury.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-treasury-'));
process.env.ZOHO_NO_SCHEDULER = '1'; process.env.SALES_NO_SCHEDULER = '1';
const { server } = require('./server.js');

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api/`; let cookie = '';
  const call = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j }; };
  const ok = (r, l) => { assert.equal(r.s, 200, `${l || ''} → ${r.s} ${JSON.stringify(r.j).slice(0, 300)}`); return r.j; };
  const local = d => new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10), day = o => local(new Date(Date.now() + o * 864e5));
  const ym = d => d.slice(0, 7), nextM = m => { const y = +m.slice(0, 4), k = +m.slice(5, 7); return k === 12 ? `${y + 1}-01` : `${y}-${String(k + 1).padStart(2, '0')}`; };
  try {
    ok(await call('POST', 'setup', { username: 'admin', password: 'secret12', company: 'Trigon' }));
    ok(await call('PUT', 'settings', { trn: '100123456700003' }));
    const cl = ok(await call('POST', 'parties', { type: 'client', name: 'Client', trn: '100000000000003' })).id, sup = ok(await call('POST', 'parties', { type: 'supplier', name: 'Supplier' })).id;
    const P = ok(await call('POST', 'projects', { name: 'Roads', client_id: cl, status: 'active' })).id;
    const t = day(0), m0 = ym(t), m1 = nextM(m0), in1 = `${m1}-15`;

    // ---- forecast: money in the bank, an overdue invoice (due now), an invoice due next month, a bill, cheques both ways
    const paid = ok(await call('POST', 'invoices', { project_id: P, date: day(-60), due_date: day(-40), items: [{ description: 'Old', qty: 1, rate: 10000 }] })).id;
    ok(await call('POST', 'payments', { kind: 'in', date: day(-30), amount: 10500, method: 'bank', invoice_id: paid }));
    ok(await call('POST', 'invoices', { project_id: P, date: day(-50), due_date: day(-20), items: [{ description: 'Late', qty: 1, rate: 2000 }] }));
    const due = ok(await call('POST', 'invoices', { project_id: P, date: day(-5), due_date: in1, items: [{ description: 'Next month', qty: 1, rate: 4000 }] })).id;
    const bill = ok(await call('POST', 'bills', { date: day(-40), party_id: sup, project_id: P, category: 'materials', description: 'Steel', amount: 20000, vat_amount: 1000 })).id;
    ok(await call('POST', 'payments', { kind: 'out', date: day(-1), amount: 6000, method: 'cheque', cheque_date: in1, cheque_status: 'pending', reference: 'CHQ 9', bill_id: bill }));
    ok(await call('POST', 'payments', { kind: 'in', date: day(-1), amount: 1200, method: 'cheque', cheque_date: in1, cheque_status: 'pending', reference: 'CHQ 7', invoice_id: due }));
    const f = ok(await call('GET', 'cashflow?months=2'));
    assert.equal(f.opening, 10500, 'pending cheques are not cash'); assert.equal(f.buckets.length, 3); assert.equal(f.buckets[0].month, m0);
    const b0 = f.buckets[0], b1 = f.buckets[1];
    assert.equal(b0.in, 2100, 'the overdue invoice is expected now'); assert.equal(b0.out, 15000, 'the bill balance (21,000 − the 6,000 cheque) is past its credit days');
    assert.equal(b1.in, 4200, 'invoice balance 3,000 + cheque 1,200'); assert.equal(b1.out, 6000);
    assert.equal(b0.closing, -2400); assert.equal(b1.closing, -4200); assert.equal(f.lowest.balance, -4200); assert.equal(f.totals.late_in, 2100);
    assert.ok(f.items.find(i => i.kind === 'invoice' && i.late && i.date === t));
    assert.ok(ok(await call('GET', 'compliance')).some(a => a.key === 'cash_short' && a.amount === 4200));
    console.log('✔ cash-flow forecast: cash now, late items due now, invoices / bills / cheques in their month, running balance and shortfall alert');

    // ---- bank guarantees
    assert.equal((await call('POST', 'bank_guarantees', { type: 'zzz', number: 'x', amount: 5 })).s, 400);
    assert.equal((await call('POST', 'bank_guarantees', { type: 'performance', number: 'PG-1', amount: 0, expiry_date: day(10) })).s, 400);
    assert.equal((await call('POST', 'bank_guarantees', { type: 'performance', number: 'PG-1', amount: 5, expiry_date: '10/10/2026' })).s, 400);
    const g1 = ok(await call('POST', 'bank_guarantees', { type: 'performance', project_id: P, beneficiary: 'Client', bank: 'ENBD', number: 'PG-1', amount: 100000, margin: 10000, issue_date: day(-300), expiry_date: day(10), status: 'active' })).id;
    const g2 = ok(await call('POST', 'bank_guarantees', { type: 'advance', project_id: P, number: 'AG-1', amount: 50000, expiry_date: day(-5), status: 'active' })).id;
    let gs = ok(await call('GET', 'bank_guarantees')); assert.equal(gs.find(g => g.id === g1).soon, true); assert.equal(gs.find(g => g.id === g2).expired, true); assert.equal(gs.find(g => g.id === g1).project_name, 'Roads');
    let keys = ok(await call('GET', 'compliance')).map(a => a.key); assert.ok(keys.includes('guarantee_soon') && keys.includes('guarantee_expired'));
    ok(await call('PUT', 'bank_guarantees/' + g2, { status: 'released' })); ok(await call('PUT', 'bank_guarantees/' + g1, { expiry_date: day(200) }));
    keys = ok(await call('GET', 'compliance')).map(a => a.key); assert.ok(!keys.includes('guarantee_soon') && !keys.includes('guarantee_expired'));
    ok(await call('POST', 'users', { username: 'view', password: 'secret12', role: 'viewer' })); ok(await call('POST', 'users', { username: 'fore', password: 'secret12', role: 'foreman' }));
    const admin = cookie; cookie = ''; ok(await call('POST', 'login', { username: 'view', password: 'secret12' }));
    assert.equal((await call('GET', 'bank_guarantees')).s, 200); assert.equal((await call('GET', 'cashflow')).s, 200); assert.equal((await call('POST', 'bank_guarantees', { number: 'x', amount: 1 })).s, 403);
    cookie = ''; ok(await call('POST', 'login', { username: 'fore', password: 'secret12' }));
    assert.equal((await call('GET', 'bank_guarantees')).s, 403); assert.equal((await call('GET', 'cashflow')).s, 403); cookie = admin;
    console.log('✔ bank guarantees: validated, expiry alerts (30 days / expired), cleared when released or extended, read-only and site roles respected');

    // ---- over budget
    ok(await call('PUT', `projects/${P}/budget`, { lines: { materials: 5000 } }));
    assert.ok(ok(await call('GET', 'compliance')).some(a => a.key === 'over_budget' && /Roads/.test(a.who)), 'Roads spent 20,000 against a 5,000 budget');
    console.log('✔ alert when a project is forecast to finish over its budget');
    console.log('TREASURY TESTS PASSED');
  } catch (err) { console.error('FAIL', err); process.exitCode = 1; }
  finally { server.close(); setTimeout(() => process.exit(process.exitCode || 0), 100); }
});
