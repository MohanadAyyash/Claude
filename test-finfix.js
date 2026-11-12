// Finance review fixes: progress billing never repeats, void gives the progress back, credit notes capped and carrying retention,
// credit note against an advance, payment / invoice / bill guards, subcontract certificate limits, depreciation, stock:
// node --no-warnings test-finfix.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-finfix-'));
process.env.ZOHO_NO_SCHEDULER = '1'; process.env.SALES_NO_SCHEDULER = '1';
const { server } = require('./server.js');

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api/`; let cookie = '';
  const call = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j }; };
  const ok = (r, l) => { assert.equal(r.s, 200, `${l || ''} → ${r.s} ${JSON.stringify(r.j).slice(0, 300)}`); return r.j; };
  const no = async (p, re) => { const r = await p; assert.ok(r.s >= 400, 'expected a refusal, got ' + r.s + ' ' + JSON.stringify(r.j).slice(0, 200)); if (re) assert.match(r.j.error || '', re); };
  const inv = async id => ok(await call('GET', 'invoices/' + id));
  try {
    ok(await call('POST', 'setup', { username: 'admin', password: 'secret12', company: 'Trigon' }));
    ok(await call('PUT', 'settings', { trn: '100123456700003' }));
    const client = ok(await call('POST', 'parties', { type: 'client', name: 'Client', trn: '100000000000003', address: 'Dubai' })).id;
    const p = ok(await call('POST', 'projects', { name: 'Roads', client_id: client, contract_value: 1000000, retention_pct: 10, status: 'active' })).id;
    const A = ok(await call('POST', 'boq_items', { project_id: p, description: 'A', unit: 'm', qty: 100, rate: 1000 })).id;
    const B = ok(await call('POST', 'boq_items', { project_id: p, description: 'B', unit: 'm', qty: 100, rate: 1000 })).id;
    const boq = async () => Object.fromEntries(ok(await call('GET', 'boq_items?project_id=' + p)).map(i => [i.id, i]));

    // ---- progress: a line corrected downwards keeps what was billed
    ok(await call('PUT', 'boq_items/' + A, { done_pct: 60 }));
    const i1 = ok(await call('POST', `projects/${p}/progress-invoice`, {})).id; assert.equal((await inv(i1)).subtotal, 60000);
    ok(await call('PUT', 'boq_items/' + A, { done_pct: 50 })); ok(await call('PUT', 'boq_items/' + B, { done_pct: 10 }));
    const i2 = ok(await call('POST', `projects/${p}/progress-invoice`, {})).id; assert.equal((await inv(i2)).subtotal, 10000);
    assert.equal((await boq())[A].billed_pct, 60, 'A stays billed at 60%');
    ok(await call('PUT', 'boq_items/' + A, { done_pct: 60 }));
    await no(call('POST', `projects/${p}/progress-invoice`, {}), /No unbilled progress/);
    console.log('✔ progress invoice: no second billing after a downward correction (70,000 earned = 70,000 invoiced)');

    // ---- void: only the latest progress invoice, and its lines become unbilled again
    await no(call('POST', `invoices/${i1}/void`, { reason: 'x' }), /later progress invoice/);
    ok(await call('POST', `invoices/${i2}/void`, { reason: 'wrong date' })); assert.equal((await boq())[B].billed_pct, 0);
    const i3 = ok(await call('POST', `projects/${p}/progress-invoice`, {})).id; assert.equal((await inv(i3)).subtotal, 10000, 'can be invoiced again');
    console.log('✔ voiding a progress invoice returns its progress, so it can be re-issued');

    // ---- credit notes: carry the retention, capped at the invoice, block void
    let x = await inv(i1); assert.equal(x.total, 63000); assert.equal(x.retention, 6000); assert.equal(x.balance, 57000);
    const cn = ok(await call('POST', `invoices/${i1}/credit-note`, { reason: 'cancelled' })).id;
    x = await inv(i1); assert.equal(x.balance, 0); assert.equal(x.retention_open, 0); assert.equal(x.status, 'paid');
    await no(call('POST', `invoices/${i1}/credit-note`, {}), /cannot exceed/);
    await no(call('POST', `invoices/${i1}/void`, { reason: 'x' }), /credit notes/);
    const cnDoc = await inv(cn); assert.equal(cnDoc.total, -63000); assert.equal(cnDoc.retention, -6000);
    console.log('✔ credit note: releases the retention, cannot exceed the invoice, invoice with credit notes cannot be voided');

    // ---- credit note against an advance invoice reverses the advance, not revenue
    const p2 = ok(await call('POST', 'projects', { name: 'Adv', client_id: client, contract_value: 1000000, advance_pct: 10, advance_recovery_pct: 10, status: 'active' })).id;
    const adv = ok(await call('POST', `projects/${p2}/advance-invoice`, {})).id;
    const tb0 = ok(await call('GET', 'financials'));
    const acn = ok(await call('POST', `invoices/${adv}/credit-note`, {})).id; assert.equal((await inv(acn)).revenue, 0);
    const cs = ok(await call('GET', `projects/${p2}/contract`)); assert.equal(cs.advance.invoiced, 0); assert.equal(cs.advance.remaining, 0);
    const tb1 = ok(await call('GET', 'financials')); assert.equal(JSON.stringify(tb1.income), JSON.stringify(tb0.income), 'revenue untouched');
    console.log('✔ credit note against an advance: liability reversed, revenue untouched, nothing left to recover');

    // ---- payments
    await no(call('POST', 'payments', { kind: 'in', amount: -500, invoice_id: i3 }), /greater than zero/);
    await no(call('POST', 'payments', { kind: 'in', amount: 'abc', invoice_id: i3 }));
    await no(call('POST', 'payments', { kind: 'zzz', amount: 5, invoice_id: i3 }));
    await no(call('POST', 'payments', { kind: 'in', amount: 99999, invoice_id: i3 }), /open balance/);
    await no(call('POST', 'payments', { kind: 'in', amount: 5, invoice_id: i2 }), /voided/);
    const pay = ok(await call('POST', 'payments', { kind: 'in', amount: 4000, invoice_id: i3, method: 'bank' })).id;
    ok(await call('PUT', 'payments/' + pay, { amount: 9500 })); await no(call('PUT', 'payments/' + pay, { amount: 9501 }), /open balance/);
    console.log('✔ payments: positive, against a live document, never above the open balance');

    // ---- invoices: paid ones cannot drop below the money received; numbers unique and never reused
    await no(call('PUT', 'invoices/' + i3, { items: [{ description: 'x', qty: 1, rate: 100 }] }), /below what was already received/);
    await no(call('PUT', 'invoices/' + i3, { number: 'INV-2099-001' }), /number/);
    const free = ok(await call('POST', 'invoices', { project_id: p, items: [{ description: 'manual', qty: 1, rate: 100 }] })).id, y = new Date().getFullYear();
    await no(call('PUT', 'invoices/' + free, { number: (await inv(i1)).number }), /already exists/);
    ok(await call('PUT', 'invoices/' + free, { number: `INV-${y}-001-R` }));
    const next = ok(await call('POST', 'invoices', { project_id: p, items: [{ description: 'manual', qty: 1, rate: 100 }] })).id;
    const nums = ok(await call('GET', 'invoices')).map(i => i.number); assert.equal(new Set(nums).size, nums.length, 'no duplicate numbers: ' + nums.join(' '));
    assert.equal((await call('DELETE', `projects/${p}/progress-invoice`)).s, 404, 'a sub-route is not a delete'); assert.ok(ok(await call('GET', 'projects/' + p)));
    console.log('✔ invoices: floor at money received, unique numbers, next number never repeats');

    // ---- subcontract certificates stay inside the subcontract; their bill cannot be deleted
    const sub = ok(await call('POST', 'parties', { type: 'subcontractor', name: 'Sub' })).id;
    const sc = ok(await call('POST', 'subcontracts', { project_id: p, party_id: sub, description: 'Works', contract_value: 100000, retention_pct: 10, advance: 10000, status: 'active' })).id;
    await no(call('POST', 'sub_certs', { subcontract_id: sc, cumulative: 500000 }), /more than the subcontract value/);
    await no(call('POST', 'sub_certs', { subcontract_id: sc, cumulative: 50000, advance_recovery: 50000 }), /Advance recovery/);
    await no(call('POST', 'sub_certs', { subcontract_id: sc, cumulative: 50000, release: 99999 }), /Retention release/);
    const c1 = ok(await call('POST', 'sub_certs', { subcontract_id: sc, cumulative: 50000, advance_recovery: 5000 })).id;
    const bill = ok(await call('POST', `sub_certs/${c1}/approve`)).bill_id;
    await no(call('DELETE', 'bills/' + bill), /payment certificate/);
    console.log('✔ subcontract certificate: within contract value, advance and retention held; its bill is protected');

    // ---- stock: never below zero in date order
    const it = ok(await call('POST', 'stock_items', { name: 'Cement', unit: 'bag' })).id;
    ok(await call('POST', 'stock_moves', { item_id: it, type: 'in', qty: 10, unit_cost: 5, date: '2026-01-10' }));
    await no(call('POST', 'stock_moves', { item_id: it, type: 'out', qty: 10, date: '2026-01-05' }), /below zero/);
    await no(call('POST', 'stock_moves', { item_id: it, type: 'in', qty: 1, unit_cost: -100, date: '2026-01-11' }), /negative/);
    await no(call('POST', 'stock_moves', { item_id: it, type: 'adjust', qty: -50, date: '2026-01-12' }), /below zero/);
    ok(await call('POST', 'stock_moves', { item_id: it, type: 'out', qty: 8, date: '2026-01-15' }));
    const inMove = ok(await call('GET', 'stock_moves?item_id=' + it)).find(m => m.type === 'in').id;
    await no(call('DELETE', 'stock_moves/' + inMove), /below zero/);
    console.log('✔ stock: issues, adjustments and deletions cannot take the balance below zero');

    // ---- depreciation: register = ledger, and the months add up to exactly the depreciable amount
    ok(await call('POST', 'fixed_assets', { name: 'Mixer', purchase_date: '2023-01-05', cost: 10000, salvage: 0, life_years: 3, status: 'active' }));
    const reg = ok(await call('GET', 'fixed_assets?as_of=2026-03-31'))[0]; assert.equal(reg.accumulated, 10000);
    const led = ok(await call('GET', 'ledger?account=1690&from=2020-01-01&to=2026-03-31'));
    const credit = Math.round((led.lines || led.entries || led.rows || []).reduce((s, l) => s + (l.credit || 0) - (l.debit || 0), 0) * 100) / 100;
    assert.equal(credit, 10000, 'ledger accumulated depreciation = cost, not 10,000.08');
    const mid = ok(await call('GET', 'fixed_assets?as_of=2023-02-10'))[0]; assert.equal(mid.accumulated, 277.78, 'only January is charged on 10 Feb');
    console.log('✔ depreciation: asset register and ledger agree (month-end charges, exact total)');
    console.log('FINANCE FIX TESTS PASSED');
  } catch (err) { console.error('FAIL', err); process.exitCode = 1; }
  finally { server.close(); setTimeout(() => process.exit(process.exitCode || 0), 100); }
});
