// Spend approval by amount (purchase orders and supplier payments): node --no-warnings test-spend.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-spend-')); process.env.SKIP_PDF = '1';
process.env.ZOHO_NO_SCHEDULER = '1'; process.env.SALES_NO_SCHEDULER = '1';
const { server } = require('./server.js');

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api/`; let cookie = '';
  const call = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j }; };
  const ok = (r, l) => { assert.equal(r.s, 200, `${l || ''} → ${r.s} ${JSON.stringify(r.j).slice(0, 300)}`); return r.j; };
  const jar = {}; const as = async (u, fn) => { const keep = cookie; cookie = jar[u] || ''; if (!cookie) ok(await call('POST', 'login', { username: u, password: 'secret12' })); jar[u] = cookie; try { return await fn(); } finally { cookie = keep; } };
  const no = async (p, re, code = 403) => { const r = await p; assert.equal(r.s, code, JSON.stringify(r.j).slice(0, 200)); if (re) assert.match(r.j.error || '', re); };
  try {
    ok(await call('POST', 'setup', { username: 'admin', password: 'secret12', company: 'Trigon' }));
    ok(await call('PUT', 'settings', { trn: '100123456700003' }));
    for (const [u, role] of [['acc', 'accountant'], ['buyer', 'procurement']]) ok(await call('POST', 'users', { username: u, password: 'secret12', role }));
    const sup = ok(await call('POST', 'parties', { type: 'supplier', name: 'Steel LLC' })).id, cl = ok(await call('POST', 'parties', { type: 'client', name: 'Client' })).id;
    const P = ok(await call('POST', 'projects', { name: 'Roads', client_id: cl, status: 'active' })).id;
    const po = (rate, status = 'draft') => ({ party_id: sup, project_id: P, date: '2026-11-01', status, vat_pct: 5, items: [{ description: 'Rebar', unit: 't', qty: 10, rate }] });

    // ---- control off: nothing changes
    const free = ok(await as('buyer', () => call('POST', 'purchase_orders', po(5000, 'sent')))).id;
    assert.equal((await as('buyer', () => call('GET', 'doc/purchase_orders/' + free))).s, 200);

    // ---- purchase orders above the limit
    ok(await call('PUT', 'settings', { po_approval_limit: 10000, pay_approval_limit: 5000 }));
    const small = ok(await as('buyer', () => call('POST', 'purchase_orders', po(500, 'sent')))).id;                 // 5,250 — under the limit
    assert.equal((await as('buyer', () => call('GET', 'doc/purchase_orders/' + small))).s, 200);
    await no(as('buyer', () => call('POST', 'purchase_orders', po(2000, 'sent'))), /needs the administrator's approval/);
    const big = ok(await as('buyer', () => call('POST', 'purchase_orders', po(2000)))).id;                           // 21,000 draft
    await no(as('buyer', () => call('PUT', 'purchase_orders/' + big, { status: 'sent' })), /above the approval limit/);
    await no(as('buyer', () => call('GET', 'doc/purchase_orders/' + big)), /printed/);
    await no(as('acc', () => call('POST', `purchase_orders/${big}/receive`, {})), /received/);
    let v = ok(await as('buyer', () => call('GET', 'spend-approvals'))); assert.equal(v.need_po.length, 2, 'the new order and the one issued before the limit'); assert.equal(v.can_decide, false);
    const rq = ok(await as('buyer', () => call('POST', 'spend-approvals', { kind: 'po', ref_id: big, note: 'urgent' }))).id;
    await no(as('buyer', () => call('POST', 'spend-approvals', { kind: 'po', ref_id: big })), /already waiting/, 400);
    await no(as('buyer', () => call('PUT', 'spend-approvals/' + rq, { status: 'approved' })), /administrator/);
    assert.ok(ok(await call('GET', 'compliance')).some(a => a.key === 'spend_pending' && a.count === 1));
    assert.ok(ok(await call('GET', 'notifications')).items.some(n => /Spend approval requested/.test(n.title)), 'the administrator is notified');
    // the order is changed while the request waits → the approval is refused until asked again
    ok(await as('buyer', () => call('PUT', 'purchase_orders/' + big, { items: po(3000).items })));
    await no(call('PUT', 'spend-approvals/' + rq, { status: 'approved' }), /changed after the request/, 400);
    ok(await as('buyer', () => call('PUT', 'purchase_orders/' + big, { items: po(2000).items })));
    ok(await call('PUT', 'spend-approvals/' + rq, { status: 'approved' }));
    ok(await as('buyer', () => call('PUT', 'purchase_orders/' + big, { status: 'sent' })));
    assert.equal((await as('buyer', () => call('GET', 'doc/purchase_orders/' + big))).s, 200);
    ok(await as('buyer', () => call('PUT', 'purchase_orders/' + big, { items: po(2500).items })));                   // raised after approval → needs it again
    await no(as('buyer', () => call('GET', 'doc/purchase_orders/' + big)), /above the approval limit/);
    assert.equal((await call('GET', 'doc/purchase_orders/' + big)).s, 200, 'the administrator printing it is the approval');
    assert.equal((await as('buyer', () => call('GET', 'doc/purchase_orders/' + big))).s, 200);
    console.log('✔ purchase orders above the limit: cannot be issued, printed or received until approved; a changed order asks again; the administrator acts directly');

    // ---- supplier payments above the limit
    const bill = ok(await call('POST', 'bills', { date: '2026-11-02', party_id: sup, project_id: P, category: 'materials', description: 'Rebar', amount: 20000, vat_amount: 1000 })).id;
    ok(await as('acc', () => call('POST', 'payments', { kind: 'out', date: '2026-11-03', amount: 4000, method: 'bank', bill_id: bill })), 'under the limit');
    await no(as('acc', () => call('POST', 'payments', { kind: 'out', date: '2026-11-03', amount: 9000, method: 'bank', bill_id: bill })), /above the approval limit/);
    await no(as('acc', () => call('POST', 'payments', { kind: 'out', date: '2026-11-03', amount: 9000, method: 'bank' })), /only be recorded by the administrator/);
    v = ok(await as('acc', () => call('GET', 'spend-approvals'))); assert.equal(v.need_pay.length, 1); assert.equal(v.need_pay[0].balance, 17000);
    await no(as('acc', () => call('POST', 'spend-approvals', { kind: 'payment', ref_id: bill, amount: 99999 })), /open balance/, 400);
    const pr = ok(await as('acc', () => call('POST', 'spend-approvals', { kind: 'payment', ref_id: bill, amount: 9000 }))).id;
    ok(await call('PUT', 'spend-approvals/' + pr, { status: 'approved' }));
    await no(as('acc', () => call('POST', 'payments', { kind: 'out', date: '2026-11-04', amount: 9500, method: 'bank', bill_id: bill })), /approved so far/);
    const pay = ok(await as('acc', () => call('POST', 'payments', { kind: 'out', date: '2026-11-04', amount: 9000, method: 'cheque', cheque_date: '2026-12-01', cheque_status: 'pending', bill_id: bill }))).id;
    ok(await as('acc', () => call('PUT', 'payments/' + pay, { cheque_status: 'cleared' })), 'clearing the cheque is not a new payment');
    await no(as('acc', () => call('POST', 'payments', { kind: 'out', date: '2026-11-05', amount: 8000, method: 'bank', bill_id: bill })), /above the approval limit/);
    ok(await call('POST', 'payments', { kind: 'out', date: '2026-11-05', amount: 8000, method: 'bank', bill_id: bill }), 'the administrator pays directly');
    const rej = ok(await as('buyer', () => call('POST', 'spend-approvals', { kind: 'po', ref_id: free }))).id;
    ok(await call('PUT', 'spend-approvals/' + rej, { status: 'rejected', note: 'too expensive' })); await no(call('PUT', 'spend-approvals/' + rej, { status: 'approved' }), /already decided/, 400);
    assert.ok(ok(await as('buyer', () => call('GET', 'notifications'))).items.some(n => /rejected/.test(n.title)));
    console.log('✔ supplier payments above the limit: need an approved request covering them; cheque clearing and smaller payments pass; the administrator pays directly');
    console.log('SPEND APPROVAL TESTS PASSED');
  } catch (err) { console.error('FAIL', err); process.exitCode = 1; }
  finally { server.close(); setTimeout(() => process.exit(process.exitCode || 0), 100); }
});
