// Accounting gaps: assets in the ledger (opening assets, disposals, register vs purchase bills), advance paid to a
// subcontractor (1400 debited, paid, recovered), VAT due in the cash-flow forecast: node --no-warnings test-acctgaps.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-acctgaps-'));
process.env.ZOHO_NO_SCHEDULER = '1'; process.env.SALES_NO_SCHEDULER = '1';
const { server } = require('./server.js');

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api/`; let cookie = '';
  const call = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j }; };
  const ok = (r, l) => { assert.equal(r.s, 200, `${l || ''} → ${r.s} ${JSON.stringify(r.j).slice(0, 300)}`); return r.j; };
  const local = d => new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10), day = o => local(new Date(Date.now() + o * 864e5));
  const tb = async () => { const rows = ok(await call('GET', `financials?from=2000-01-01&to=${day(0)}`)).trial_balance; return Object.fromEntries(rows.map(a => [a.code, Math.round(((a.debit || 0) - (a.credit || 0)) * 100) / 100])); };
  try {
    ok(await call('POST', 'setup', { username: 'admin', password: 'secret12', company: 'Trigon' }));
    ok(await call('PUT', 'settings', { trn: '100123456700003' }));
    const sup = ok(await call('POST', 'parties', { type: 'supplier', name: 'Dealer', trn: '100000000000011' })).id, cl = ok(await call('POST', 'parties', { type: 'client', name: 'Client', trn: '100000000000003' })).id;
    const P = ok(await call('POST', 'projects', { name: 'Roads', client_id: cl, status: 'active' })).id;

    // ---- assets: bought with a bill / owned before the system / disposed
    ok(await call('POST', 'bills', { date: '2024-01-10', party_id: sup, category: 'asset', description: 'Pickup', amount: 60000, vat_amount: 3000 }));
    const bought = ok(await call('POST', 'fixed_assets', { name: 'Pickup', purchase_date: '2024-01-10', cost: 60000, salvage: 0, life_years: 5, status: 'active' })).id;
    let chk = ok(await call('GET', 'fixed_assets/check')); assert.equal(chk.balanced, true);
    const old = ok(await call('POST', 'fixed_assets', { name: 'Old mixer', purchase_date: '2023-01-01', cost: 12000, salvage: 0, life_years: 4, status: 'active' })).id;
    chk = ok(await call('GET', 'fixed_assets/check')); assert.equal(chk.balanced, false); assert.equal(chk.difference, -12000, 'an asset with no bill');
    ok(await call('PUT', 'fixed_assets/' + old, { opening: 1 })); assert.equal(ok(await call('GET', 'fixed_assets/check')).balanced, true);
    let t = await tb(); assert.equal(t['1600'], 72000, 'cost of both assets is in the ledger'); assert.equal(t['3100'], -12000, 'the old asset came in against the owner account');
    // dispose the pickup after exactly 12 months for 40,000: accumulated 12,000 → book value 48,000 → loss 8,000
    assert.equal((await call('PUT', 'fixed_assets/' + bought, { status: 'disposed' })).s, 400, 'a disposal needs its date');
    ok(await call('PUT', 'fixed_assets/' + bought, { status: 'disposed', disposal_date: '2024-12-20', disposal_proceeds: 40000 }));
    t = await tb(); assert.equal(t['1600'], 12000, 'the disposed asset left 1600'); assert.equal(t['6150'], 8000, 'loss on disposal');
    const oldAcc = ok(await call('GET', 'fixed_assets')).find(a => a.id === old).accumulated; assert.equal(t['1690'], -oldAcc, 'only the remaining asset has accumulated depreciation');
    const sum = Object.values(t).reduce((s, v) => s + v, 0); assert.ok(Math.abs(sum) < 0.01, 'trial balance balances: ' + sum);
    console.log('✔ assets: register checked against purchase bills; opening assets and disposals (gain / loss, proceeds) reach the ledger');

    // ---- advance to a subcontractor
    const sub = ok(await call('POST', 'parties', { type: 'subcontractor', name: 'Sub' })).id;
    const sc = ok(await call('POST', 'subcontracts', { project_id: P, party_id: sub, description: 'Kerbs', contract_value: 100000, retention_pct: 10, advance: 10000, status: 'active' })).id;
    const cost0 = ok(await call('GET', 'project-summary')).find(p => p.id === P).cost;
    const adv = ok(await call('POST', `subcontracts/${sc}/advance-bill`, { date: '2026-01-05' })).bill_id;
    assert.equal((await call('POST', `subcontracts/${sc}/advance-bill`, {})).s, 400, 'only once');
    assert.equal(ok(await call('GET', 'subcontracts/' + sc)).advance_bill_id, adv);
    assert.equal(ok(await call('GET', 'project-summary')).find(p => p.id === P).cost, cost0, 'an advance is not a project cost');
    ok(await call('POST', 'payments', { kind: 'out', date: '2026-01-06', amount: 10000, method: 'bank', bill_id: adv }));
    t = await tb(); assert.equal(t['1400'], 10000, 'the advance sits in 1400 once paid'); assert.equal(t['2000'], -63000, 'only the unpaid pickup bill is left in payables');
    const c1 = ok(await call('POST', 'sub_certs', { subcontract_id: sc, date: '2026-02-01', cumulative: 50000, advance_recovery: 5000 })).id; ok(await call('POST', `sub_certs/${c1}/approve`));
    const c2 = ok(await call('POST', 'sub_certs', { subcontract_id: sc, date: '2026-03-01', cumulative: 100000, advance_recovery: 5000 })).id; ok(await call('POST', `sub_certs/${c2}/approve`));
    t = await tb(); assert.equal(t['1400'] || 0, 0, 'fully recovered through the certificates'); assert.equal(t['5300'], 100000, 'the cost is the certified work');
    assert.ok(Math.abs(Object.values(t).reduce((s, v) => s + v, 0)) < 0.01);
    const noSub = ok(await call('POST', 'subcontracts', { project_id: P, party_id: sub, description: 'No advance', contract_value: 5000, status: 'active' })).id;
    assert.equal((await call('POST', `subcontracts/${noSub}/advance-bill`, {})).s, 400);
    console.log('✔ subcontractor advance: booked to 1400, paid like a bill, recovered by the certificates, never a project cost');

    // ---- VAT in the cash-flow forecast
    const q0 = new Date(); const mth = q0.getMonth() + 1, qs = ((mth - 1) % 3) + 1;                              // make the current month the first month of a quarter…
    ok(await call('PUT', 'settings', { vat_quarter_start: qs }));
    ok(await call('POST', 'invoices', { project_id: P, date: day(0), due_date: day(200), items: [{ description: 'Work', qty: 1, rate: 100000 }] }));   // output VAT 5,000 this quarter
    ok(await call('POST', 'bills', { date: day(0), party_id: sup, project_id: P, category: 'materials', description: 'Steel', amount: 20000, vat_amount: 1000 }));
    const f = ok(await call('GET', 'cashflow?months=6')), vat = f.items.filter(i => i.kind === 'vat_est');
    assert.equal(vat.length, 1); assert.equal(vat[0].amount, 4000, 'output 5,000 − input 1,000'); assert.equal(vat[0].estimate, true); assert.equal(f.vat_registered, true);
    const qEnd = new Date(q0.getFullYear(), q0.getMonth() + 3, 0), due = local(new Date(qEnd.getTime() + 28 * 864e5)); assert.equal(vat[0].date, due, 'due 28 days after the quarter ends');
    ok(await call('PUT', 'settings', { vat_registered: '0' })); assert.equal(ok(await call('GET', 'cashflow?months=6')).items.filter(i => /^vat/.test(i.kind)).length, 0, 'not registered → no VAT line');
    console.log('✔ cash-flow forecast: VAT of the quarter (output − input) on its payment date');
    console.log('ACCOUNTING GAP TESTS PASSED');
  } catch (err) { console.error('FAIL', err); process.exitCode = 1; }
  finally { server.close(); setTimeout(() => process.exit(process.exitCode || 0), 100); }
});
