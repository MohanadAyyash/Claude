// Contract terms: advance payment invoice (with VAT, booked as a liability), recovery from progress invoices until cleared,
// retention on the gross work value, two-stage retention release with alerts: node --no-warnings test-contract.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-contract-'));
const { server } = require('./server.js');

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api/`; let cookie = '';
  const call = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j }; };
  const ok = (r, m = '') => { assert.equal(r.s, 200, m + ' ' + JSON.stringify(r.j)); return r.j; };
  try {
    ok(await call('POST', 'setup', { username: 'admin', password: 'secret12', company: 'Trigon' }));
    ok(await call('PUT', 'settings', { trn: '100123456700003', vat_pct: '5' }));
    const client = ok(await call('POST', 'parties', { type: 'client', name: 'Al Waha Developments', trn: '100234567800003', address: 'Dubai South' })).id;
    const p = ok(await call('POST', 'projects', { name: 'Internal Roads', client_id: client, contract_value: 1000000, retention_pct: 10, advance_pct: 10, advance_recovery_pct: 10, handover_date: '2026-09-01', dlp_months: 12, retention_handover_pct: 50, status: 'active' })).id;
    const A = ok(await call('POST', 'boq_items', { project_id: p, description: 'Asphalt', unit: 'm2', qty: 100, rate: 5000 })).id;
    const B = ok(await call('POST', 'boq_items', { project_id: p, description: 'Earthworks', unit: 'ls', qty: 1, rate: 500000 })).id;
    assert.equal((await call('PUT', 'projects/' + p, { advance_pct: 120 })).s, 400);

    // ---- advance invoice: 10% of the contract, with VAT, only once
    const adv = ok(await call('POST', `projects/${p}/advance-invoice`, {})); assert.equal(adv.amount, 100000);
    const ai = ok(await call('GET', 'invoices/' + adv.id)); assert.equal(ai.kind, 'advance'); assert.equal(ai.total, 105000); assert.equal(ai.retention, 0); assert.equal(ai.revenue, 0);
    assert.equal((await call('POST', `projects/${p}/advance-invoice`, {})).s, 400);

    // ---- progress invoice 1: 200,000 work → 20,000 recovered; retention on the gross 200,000
    ok(await call('PUT', 'boq_items/' + A, { done_pct: 40 }));
    const i1 = ok(await call('POST', `projects/${p}/progress-invoice`)).id;
    let inv = ok(await call('GET', 'invoices/' + i1));
    const rec = inv.items.find(x => x.recovery); assert.equal(rec.rate, -20000); assert.match(rec.description, /^Less: advance payment recovery \(10%/);
    assert.equal(inv.subtotal, 180000); assert.equal(inv.vat, 9000); assert.equal(inv.retention, 20000); assert.equal(inv.recovery, 20000); assert.equal(inv.revenue, 200000); assert.equal(inv.due_now, 169000);
    let s = ok(await call('GET', `projects/${p}/contract`)); assert.equal(s.advance.recovered, 20000); assert.equal(s.advance.remaining, 80000);

    // ---- books: revenue is the work value, the advance is a liability; VAT on everything invoiced
    let fin = ok(await call('GET', 'financials?from=2026-01-01&to=2030-12-31'));
    assert.equal(fin.tb_debit, fin.tb_credit); assert.equal(fin.revenue, 200000);
    const liab = JSON.stringify(fin.balance_sheet); assert.match(liab, /Advances from customers/);
    assert.equal(ok(await call('GET', 'project-summary')).find(x => x.id === p).invoiced, 200000);
    const vat = ok(await call('GET', 'vat?from=2026-01-01&to=2030-12-31')); assert.equal(vat.standard_sales, 280000); assert.equal(vat.output_vat, 14000);

    // ---- editing the invoice keeps the recovery recognised by its wording
    ok(await call('PUT', 'invoices/' + i1, { items: inv.items.map(({ recovery, ...x }) => x) }));
    assert.equal(ok(await call('GET', `projects/${p}/contract`)).advance.recovered, 20000);

    // ---- later invoices recover until the advance is cleared, then stop
    ok(await call('PUT', 'boq_items/' + B, { done_pct: 100 }));
    const i2 = ok(await call('POST', `projects/${p}/progress-invoice`)).id;
    assert.equal(ok(await call('GET', 'invoices/' + i2)).recovery, 50000);
    ok(await call('PUT', 'boq_items/' + A, { done_pct: 100 }));
    const i3 = ok(await call('POST', `projects/${p}/progress-invoice`)).id;
    inv = ok(await call('GET', 'invoices/' + i3)); assert.equal(inv.recovery, 30000); assert.match(inv.items.find(x => x.recovery).description, /balance 0\.00/);
    const C3 = ok(await call('POST', 'boq_items', { project_id: p, description: 'Extra kerbs', unit: 'm', qty: 100, rate: 100, done_pct: 100 })).id;
    const i4 = ok(await call('POST', `projects/${p}/progress-invoice`)).id;
    inv = ok(await call('GET', 'invoices/' + i4)); assert.equal(inv.recovery, 0); assert.ok(!inv.items.some(x => x.recovery));
    s = ok(await call('GET', `projects/${p}/contract`)); assert.equal(s.advance.remaining, 0);
    fin = ok(await call('GET', 'financials?from=2026-01-01&to=2030-12-31')); assert.equal(fin.tb_debit, fin.tb_credit); assert.equal(fin.revenue, 1010000);

    // ---- retention: 10% of 1,010,000 = 101,000; half due at handover (date passed), half after 12 months
    assert.equal(s.retention.held, 101000); assert.equal(s.retention.handover.amount, 50500); assert.equal(s.retention.dlp.date, '2027-09-01');
    let al = ok(await call('GET', 'dashboard')).alerts; assert.ok(al.some(a => a.key === 'retention_handover' && a.amount === 50500), JSON.stringify(al));
    ok(await call('POST', 'payments', { kind: 'in', date: '2026-10-01', amount: 20000, method: 'bank', invoice_id: i1, is_retention: 1 }));
    ok(await call('POST', 'payments', { kind: 'in', date: '2026-10-01', amount: 30500, method: 'bank', invoice_id: i2, is_retention: 1 }));
    s = ok(await call('GET', `projects/${p}/contract`)); assert.equal(s.retention.released, 50500); assert.equal(s.retention.handover.outstanding, 0); assert.equal(s.retention.dlp.outstanding, 50500);
    al = ok(await call('GET', 'dashboard')).alerts; assert.ok(!al.some(a => a.key === 'retention_handover'));

    // ---- only finance issues the advance invoice
    ok(await call('POST', 'users', { username: 'pm1', password: 'pass1234', role: 'manager' }));
    const p2 = ok(await call('POST', 'projects', { name: 'Villa', contract_value: 50000, advance_pct: 20 })).id;
    cookie = ''; ok(await call('POST', 'login', { username: 'pm1', password: 'pass1234' }));
    assert.equal((await call('POST', `projects/${p2}/advance-invoice`, {})).s, 403);
    assert.equal(ok(await call('GET', `projects/${p2}/contract`)).advance.pct, 20);
    console.log('✔ advance invoice (VAT, liability), recovery across progress invoices until cleared, retention on gross, books balance, two-stage retention release + alerts, roles');
    console.log('CONTRACT TESTS PASSED');
  } catch (e) { console.error('FAIL', e); process.exitCode = 1; }
  finally { server.close(); setTimeout(() => process.exit(process.exitCode || 0), 100); }
});
