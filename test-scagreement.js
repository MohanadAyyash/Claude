// Sub-contract agreement: standard clauses with fields, per-subcontract wording, appendices: node --no-warnings test-scagreement.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-sca-'));
process.env.ZOHO_NO_SCHEDULER = '1'; process.env.SALES_NO_SCHEDULER = '1';
const { server } = require('./server.js');
server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api/`; let cookie = '';
  const call = async (m, u, b, ck) => { const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie: ck || cookie }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); if (sc && !ck) cookie = sc.split(';')[0]; return { s: r.status, j: await r.json().catch(() => null), h: r.headers }; };
  const ok = (r, l) => { assert.equal(r.s, 200, `${l || ''} → ${r.s} ${JSON.stringify(r.j).slice(0, 300)}`); return r.j; };
  const page = async u => (await fetch(base + u, { headers: { cookie } })).text();
  try {
    ok(await call('POST', 'setup', { username: 'admin', password: 'secret12', company: 'Trigon' }));
    ok(await call('PUT', 'settings', { trn: '100123456700003', legal_name: 'Trigon Civil L.L.C', license_no: '1656279', sc_signatory: 'Mohanad Ayyash, General Manager' }));
    const sub = ok(await call('POST', 'parties', { type: 'subcontractor', name: 'Kerb Masters LLC', trn: '100555666700003', address: 'Al Quoz, Dubai' })).id;
    const cl = ok(await call('POST', 'parties', { type: 'client', name: 'Emaar Properties' })).id;
    const p = ok(await call('POST', 'projects', { code: 'P-9', name: 'Oasis roads', client_id: cl, main_contract: 'The Oasis Development — Roads & Shallow Services', status: 'active' })).id;
    const sc = ok(await call('POST', 'subcontracts', { project_id: p, party_id: sub, description: 'Precast kerbstone fixing works (labour only)', contract_value: 0, retention_pct: 10, status: 'active', agreement_no: 'TCC/SC/2026/021', agreement_date: '2026-09-30', start_date: '2026-10-05', contra_uplift: 12 })).id;
    const a0 = ok(await call('GET', 'sc-agreement/' + sc)); assert.ok(a0.matrix.length > 10, 'default responsibility matrix'); assert.ok(/\{\{subcontractor\}\}/.test(a0.template));
    ok(await call('PUT', 'sc-agreement/' + sc, { payment_days: 90, dlp_months: 12, sub_licence: '1082486', particular: 'Scope: fixing of upstand, roll over, flush and transition kerbs as per drawings.\nAll permanent materials supplied by the Contractor.',
      boq: [{ item: 'A', description: 'Roll over kerb', unit: 'm', qty: 7500, rate: 16 }, { item: 'B', description: 'Upstand kerb', unit: 'm', qty: 500, rate: 12 }, { item: 'C', description: 'Flush kerb', unit: 'm', qty: 1200, rate: 12 }, { item: 'D', description: 'Transition kerb', unit: 'm', qty: 100, rate: 12 }],
      matrix: [{ group: 'Temporary services' }, { item: 'Water', by: 'contractor' }, { item: 'Transportation of labour', by: 'sub' }], use_boq_value: 1 }));
    assert.equal(ok(await call('GET', 'subcontracts/' + sc)).contract_value, 141600, 'contract value from the BOQ');
    let html = await page('doc/sc_agreement/' + sc);
    for (const t of ['SUB-CONTRACT AGREEMENT', 'TCC/SC/2026/021', '30 September 2026', 'Trigon Civil L.L.C', 'Kerb Masters LLC', 'trade licence 1082486', 'AED 141,600.00', 'Dirhams One Hundred Forty-One Thousand Six Hundred only',
      'within 90 days', 'Retention of 10%', 'cost plus 12%', '5 October 2026', 'Emaar Properties', 'The Oasis Development', 'APPENDIX 1', 'Roll over kerb', '148,680.00', 'APPENDIX 2', 'All permanent materials supplied by the Contractor', 'APPENDIX 3', 'Transportation of labour', 'Mohanad Ayyash', 'General Manager'])
      assert.ok(html.includes(t), 'printed: ' + t);
    assert.ok(!/\{\{\w+\}\}/.test(html), 'every field filled');
    // wording changed for this subcontract only
    ok(await call('PUT', 'sc-agreement/' + sc, { text: '1. Special\nOnly for {{subcontractor}} at {{value}}.' }));
    html = await page('doc/sc_agreement/' + sc); assert.ok(html.includes('Only for Kerb Masters LLC at AED 141,600.00') && !html.includes('2. Scope of the Sub-Contract Works'), 'own wording');
    ok(await call('PUT', 'sc-agreement/' + sc, { text: '' })); html = await page('doc/sc_agreement/' + sc); assert.ok(html.includes('2. Scope of the Sub-Contract Works'), 'back to the standard');
    // roles: a site engineer cannot see it; procurement can read, not change
    for (const [u, r] of [['site1', 'site_engineer'], ['proc1', 'procurement']]) ok(await call('POST', 'users', { username: u, password: 'secret12', role: r }));
    const ck = async u => (await call('POST', 'login', { username: u, password: 'secret12' }, 'x')).h.get('set-cookie').split(';')[0];
    const site = await ck('site1'), proc = await ck('proc1');
    assert.equal((await call('GET', 'sc-agreement/' + sc, null, site)).s, 403); assert.equal((await call('GET', 'sc-agreement/' + sc, null, proc)).s, 200); assert.equal((await call('PUT', 'sc-agreement/' + sc, { payment_days: 1 }, proc)).s, 403);
    console.log('✔ sub-contract agreement: standard clauses with fields (names, value in words, retention, payment days, contra uplift, dates), own wording per subcontract, BOQ / particular conditions / responsibility matrix appendices, roles');
    console.log('SC AGREEMENT TESTS PASSED');
  } catch (e) { console.error(e); process.exitCode = 1; }
  finally { server.close(); setTimeout(() => process.exit(), 100); }
});
