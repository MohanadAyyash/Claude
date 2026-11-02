// Subcontractor payment certificate in the cumulative PC layout: node --no-warnings test-subpc.js
// Same figures as a real main-contractor PC: 478,030.00 contract, work done 212,649.12, retention 10%, contra 26,400.00,
// previous payments 149,067.19 → net 15,917.02, VAT on the net 795.85, certified 16,712.87; VAT 8,249.21 cumulative.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-subpc-'));
process.env.ZOHO_NO_SCHEDULER = '1'; process.env.SALES_NO_SCHEDULER = '1';
const { server } = require('./server.js');
server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api/`; let cookie = '';
  const call = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; return { s: r.status, j: await r.json().catch(() => null) }; };
  const ok = (r, l) => { assert.equal(r.s, 200, `${l || ''} → ${r.s} ${JSON.stringify(r.j).slice(0, 300)}`); return r.j; };
  const near = (a, b, l) => assert.ok(Math.abs(a - b) < 0.006, `${l}: ${a} ≠ ${b}`);
  try {
    ok(await call('POST', 'setup', { username: 'admin', password: 'secret12', company: 'Trigon' }));
    ok(await call('PUT', 'settings', { trn: '100123456700003', company_name: 'Trigon Civil Contracting L.L.C', legal_name: 'Trigon Civil L.L.C', sub_cert_signatories: 'QS / SQS, CE / Sr.SE / CM, Project Manager, Sr. Com. Mgr' }));
    const sub = ok(await call('POST', 'parties', { type: 'subcontractor', name: 'Kerb Laying Subcontractor LLC', trn: '100555666700003' })).id;
    const cl = ok(await call('POST', 'parties', { type: 'client', name: 'Client' })).id;
    const p = ok(await call('POST', 'projects', { code: 'EM831', name: 'Missing links', client_id: cl, main_contract: 'R1093 Implementing Missing Links of Internal Roads at Various Locations in Dubai', status: 'active' })).id;
    const sc = ok(await call('POST', 'subcontracts', { project_id: p, party_id: sub, description: 'Trial trench works, kerbs works, tile works', contract_value: 478030, retention_pct: 10, status: 'active',
      agreement_no: 'EM831/2197/2024', agreement_date: '2025-01-02', start_date: '2024-10-21', completion_date: '2026-04-14', vat_basis: 'net', contra_uplift: 12 })).id;
    const c1 = ok(await call('POST', 'sub_certs', { subcontract_id: sc, date: '2025-12-05', period_to: '2025-11-30', cumulative: 178000, deductions: 11132.81 })).id;
    ok(await call('POST', `sub_certs/${c1}/approve`));
    const c2 = ok(await call('POST', 'sub_certs', { subcontract_id: sc, date: '2026-02-05', period_to: '2025-12-31', cumulative: 212649.12, deductions: 15267.19, app_ref: 'SC Payment Application No.6, dated 16 January 2026',
      cost_codes: 'G120 93,880.00\nR231 59,637.91\nR232 43,046.67\nR310 10,663.24\nR320 3,910.18\nR340 832.30\nR350 472.72\nR330 206.10' })).id;
    const v = ok(await call('GET', 'sub_certs/' + c2));
    near(v.A, 212649.12, 'certified amount (A)'); near(v.retention_cum, 21264.91, 'retention'); near(v.contra_cum, 26400, 'contra'); near(v.prev_payments, 149067.19, 'previous payments');
    near(v.B, 196732.10, 'total deductions'); near(v.net_this, 15917.02, 'net'); near(v.vat, 795.85, 'VAT on net'); near(v.payable_now, 16712.87, 'certified incl. VAT');
    near(v.prev_vat, 7453.36, 'previous VAT'); near(v.vat_cum, 8249.21, 'cumulative VAT'); near(v.contract_vat, 23901.50, 'contract VAT'); near(v.adjusted, 501931.50, 'adjusted contract value');
    const doc = await fetch(base + 'doc/sub_certs/' + c2, { headers: { cookie } }), html = await doc.text();
    assert.equal(doc.status, 200);
    for (const t of ['PAYMENT CERTIFICATE FOR SUBCONTRACTOR', '16,712.87', 'Sixteen Thousand Seven Hundred Twelve and Fils 87/100', 'EM831/2197/2024', 'SC Payment Application No.6', 'R231', 'Sr. Com. Mgr', 'Trigon Civil L.L.C', '8,249.21', '501,931.50'])
      assert.ok(html.includes(t), 'printed: ' + t);
    ok(await call('POST', `sub_certs/${c2}/approve`));
    const bill = ok(await call('GET', 'bills')).find(b => b.reference === v.number);
    near(bill.amount, 34649.12 - 15267.19, 'cost booked = work less contra'); near(bill.vat_amount, 795.85, 'input VAT as certified');
    // release of retention later (VAT on the release under the net basis)
    const c3 = ok(await call('POST', 'sub_certs', { subcontract_id: sc, date: '2026-06-01', cumulative: 212649.12, release: 10632.46 })).id;
    const v3 = ok(await call('GET', 'sub_certs/' + c3)); near(v3.net_this, 10632.46, 'release'); near(v3.vat, 531.62, 'VAT on the release'); near(v3.payable_now, 11164.08);
    ok(await call('POST', `sub_certs/${c3}/approve`));
    const b3 = ok(await call('GET', 'bills')).find(b => b.reference === v3.number); near(b3.amount, 0, 'a release is no new cost'); near(b3.vat_amount, 531.62);
    // gross basis (existing subcontracts): VAT on the work value
    const sg = ok(await call('POST', 'subcontracts', { project_id: p, party_id: sub, description: 'Gross', contract_value: 100000, retention_pct: 10, status: 'active' })).id;
    const g1 = ok(await call('POST', 'sub_certs', { subcontract_id: sg, cumulative: 10000 })).id;
    const vg = ok(await call('GET', 'sub_certs/' + g1)); near(vg.vat, 500, 'gross basis VAT'); near(vg.payable_now, 9500, '10,000 − 1,000 + 500');
    // changing the subcontract's basis later does not change certificates already issued
    const s0 = ok(await call('GET', 'subcontracts/' + sc));
    ok(await call('PUT', 'subcontracts/' + sc, { ...s0, vat_basis: 'gross' }));
    near(ok(await call('GET', 'sub_certs/' + c2)).vat, 795.85, 'approved certificate keeps its VAT'); near(ok(await call('GET', 'sub_certs/' + c2)).prev_vat, 7453.36);
    console.log('✔ subcontractor PC (cumulative layout as a main contractor PC): A − B, VAT on the net or gross, VAT summary, amount in words, cost codes, signatories, legal name; booking; retention release');
    console.log('SUB-PC TESTS PASSED');
  } catch (e) { console.error(e); process.exitCode = 1; }
  finally { server.close(); setTimeout(() => process.exit(), 100); }
});
