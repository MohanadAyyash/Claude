// Main-contractor work: payment application (proforma) → PC received → tax invoice that equals the PC: node --no-warnings test-claims.js
// Figures from a real main-contractor PC: work done 212,649.12, retention 10% 21,264.91, contra charges 26,400.00,
// previous payments 149,067.19 → net 15,917.02, VAT 5% on the net 795.85, certified 16,712.87.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-claims-'));
process.env.ZOHO_NO_SCHEDULER = '1'; process.env.SALES_NO_SCHEDULER = '1';
const { server } = require('./server.js');
const { docHtml } = require('./lib/docs.js');
const { amountInWords } = require('./lib/words.js');

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api/`; let cookie = '';
  const call = async (m, u, b, ck) => { const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie: ck || cookie }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); if (sc && !ck) cookie = sc.split(';')[0]; return { s: r.status, j: await r.json().catch(() => null), r }; };
  const ok = (r, l) => { assert.equal(r.s, 200, `${l || ''} → ${r.s} ${JSON.stringify(r.j).slice(0, 400)}`); return r.j; };
  const near = (a, b, l) => assert.ok(Math.abs(a - b) < 0.006, `${l}: ${a} ≠ ${b}`);
  try {
    assert.equal(amountInWords(16712.87), 'Dirhams Sixteen Thousand Seven Hundred Twelve and Fils 87/100 only');
    assert.equal(amountInWords(1000000), 'Dirhams One Million only');
    ok(await call('POST', 'setup', { username: 'admin', password: 'secret12', company: 'Trigon' }));
    ok(await call('PUT', 'settings', { trn: '100123456700003', vat_pct: '5' }));
    const cl = ok(await call('POST', 'parties', { type: 'client', name: 'Main Contractor LLC', trn: '100245186000003', address: 'Dubai' })).id;
    const p = ok(await call('POST', 'projects', { code: 'EM831', name: 'Missing links & footpaths', client_id: cl, contract_value: 478030, retention_pct: 10, status: 'active',
      main_contract: 'R1093 Implementing Missing Links of Internal Roads', client_contract_ref: 'EM831/2197/2024 dated 02 January 2025', vat_basis: 'net', payment_terms_days: 90 })).id;
    // BOQ (rates as in the sub-contract)
    const b1 = ok(await call('POST', 'boq_items', { project_id: p, section: 'Kerbs', description: 'Roll over kerb', unit: 'm', qty: 7500, rate: 16, done_pct: 0 })).id;
    const b2 = ok(await call('POST', 'boq_items', { project_id: p, section: 'Kerbs', description: 'Upstand kerb', unit: 'm', qty: 500, rate: 12, done_pct: 0 })).id;
    const b3 = ok(await call('POST', 'boq_items', { project_id: p, section: 'Tiles', description: 'Interlock tiles', unit: 'm2', qty: 10000, rate: 16, done_pct: 0 })).id;
    const q3 = 5990.57;                                                      // certified so far: 7,000 m + 400 m + tiles = 212,649.12
    const lines6 = [{ key: 'b' + b1, qty: 7500, rate: 16, cert_qty: 7000 }, { key: 'b' + b2, qty: 500, rate: 12, cert_qty: 400 }, { key: 'b' + b3, qty: 10000, rate: 16, cert_qty: q3 }];

    // ---- the first PC recorded mid-contract (PC No. 6): previous values entered once ----
    const f = ok(await call('GET', `claims/pcs/new?project_id=${p}`));
    assert.equal(f.first, true); assert.equal(f.prev_payments, 0);
    const pc6 = ok(await call('POST', 'claims/pcs', { ...f, number: '6', issue_date: '2026-02-05', period_to: '2025-12-31', work_cum: 212649.12, retention_cum: 21264.91, contra_cum: 26400,
      prev_payments: 149067.19, vat_certified: 795.85, prev_work: 178000, prev_retention: 17800, prev_contra: 11132.81, prev_vat: 7453.36, lines: lines6 }), 'record PC 6');
    near(pc6.A, 212649.12, 'A'); near(pc6.B, 196732.10, 'B'); near(pc6.net, 15917.02, 'net'); near(pc6.vat_calc, 795.85, 'VAT'); near(pc6.total, 16712.87, 'total'); near(pc6.vat_cum, 8249.21, 'cumulative VAT');
    assert.deepEqual(pc6.checks, [], 'arithmetic agrees with the PC ' + JSON.stringify(pc6.checks));
    // accountant only issues the tax invoice
    ok(await call('POST', 'users', { username: 'qs1', password: 'secret12', role: 'qs' }));
    const qs = (await call('POST', 'login', { username: 'qs1', password: 'secret12' }, 'x')).r.headers.get('set-cookie').split(';')[0];
    assert.equal((await call('POST', `claims/pc-invoice/${pc6.id}`, {}, qs)).s, 403, 'QS cannot issue tax invoices');
    assert.equal((await call('GET', `claims?project_id=${p}`, null, qs)).s, 200, 'QS sees the claims');
    const inv = ok(await call('POST', `claims/pc-invoice/${pc6.id}`, { date: '2026-02-10' }), 'invoice from PC 6');
    near(inv.total, 16712.87, 'invoice = PC');
    const iv = ok(await call('GET', 'invoices/' + inv.id));
    near(iv.due_now, 16712.87, 'due now'); near(iv.vat, 795.85, 'invoice VAT'); near(iv.retention, 3464.91, 'retention this period'); near(iv.revenue, 34649.12 - 15267.19, 'revenue = work less contra');
    near(iv.std_total, 15917.02, 'VAT base for the return'); assert.equal(iv.due_date, '2026-05-11', '90 days payment terms'); assert.equal(iv.client_ref, 'PC 6');
    assert.equal(iv.contract_ref, 'EM831/2197/2024 dated 02 January 2025');
    const html = docHtml({ kind: 'invoices', doc: iv, settings: ok(await call('GET', 'settings')), mode: 'print' });
    assert.ok(/EM831\/2197\/2024/.test(html) && /PC 6/.test(html) && /after retention/.test(html), 'contract ref, PC and VAT basis on the invoice');
    assert.equal((await call('POST', `claims/pc-invoice/${pc6.id}`, {})).s, 400, 'only one invoice per PC');
    assert.equal((await call('PUT', `claims/pcs/${pc6.id}`, { notes: 'x' })).s, 400, 'an invoiced PC is locked');
    // VAT return: the base is the amount after retention
    const vat = ok(await call('GET', 'vat?from=2026-01-01&to=2026-12-31')); near(vat.output_vat, 795.85, 'output VAT'); near(vat.standard_sales, 15917.02, 'standard-rated sales');
    // books balance; retention receivable without VAT
    const fin = ok(await call('GET', 'financials?from=2026-01-01&to=2026-12-31'));
    near(fin.tb_debit, fin.tb_credit, 'trial balance');
    const ret = fin.trial_balance.find(r => r.code === '1150'); near(ret.debit - ret.credit, 3464.91, 'retention receivable');

    // ---- payment application No. 1 → PC 7 ----
    near(ok(await call('GET', `boq_items?project_id=${p}`)).find(x => x.id === b1).billed_pct, 7000 / 7500 * 100, 'billed % = certified on PC 6');
    ok(await call('PUT', 'boq_items/' + b1, { done_pct: 96 }));             // 7,200 m done
    const app = ok(await call('POST', 'claims/apps', { project_id: p, date: '2026-02-20', period_to: '2026-01-31' }));
    assert.equal(app.seq, 1); assert.match(app.number, /^PF-\d{4}-001$/); assert.equal(app.previous_pc, '6');
    near(app.prev_payments, 164984.21, 'previous payments = cumulative net certified (149,067.19 + 15,917.02)');
    const l1 = app.lines.find(l => l.key === 'b' + b1); assert.equal(l1.prev_qty, 7000); assert.equal(l1.cum_qty, 7200);
    const app2 = ok(await call('PUT', 'claims/apps/' + app.id, { lines: [{ key: 'b' + b2, cum_qty: 500 }], status: 'submitted' }));
    near(app2.work, 7200 * 16 + 500 * 12 + 95849.12, 'work claimed (cumulative)'); assert.equal(app2.status, 'submitted');
    near(app2.retention_cum, app2.work * 0.1, 'retention 10%'); near(app2.contra_cum, 26400, 'contra as last certified');
    near(app2.net, app2.work - app2.retention_cum - 26400 - 164984.21, 'net claimed'); near(app2.vat, app2.net * 0.05, 'VAT on net');
    const pa = await fetch(base + 'doc/pay_app/' + app.id, { headers: { cookie } }); const pt = await pa.text();
    assert.equal(pa.status, 200); assert.ok(/PROFORMA INVOICE/.test(pt) && /Application no\./.test(pt) && /Dirhams/.test(pt) && /EM831\/2197/.test(pt), 'printable proforma');
    assert.ok(!/TRN|VAT|IBAN|Bank details|tax invoice/i.test(pt.replace(/the tax invoice will be issued/i, '')), 'no VAT, TRN or bank details on the proforma');
    // the main contractor certifies less (cuts 100 m of roll over kerb) and deducts 1,000 more contra charges
    const f7 = ok(await call('GET', `claims/pcs/new?project_id=${p}&app_id=${app.id}`));
    assert.equal(f7.first, false); near(f7.prev_payments, 164984.21, 'prefilled previous payments'); near(f7.prev_work, 212649.12, 'prefilled previous work');
    const lines = f7.lines.map(l => (l.key === 'b' + b1 ? { ...l, cert_qty: 7100 } : l)), work = 7100 * 16 + 500 * 12 + 95849.12;
    const pc7 = ok(await call('POST', 'claims/pcs', { ...f7, number: '7', issue_date: '2026-03-05', lines, work_cum: work, retention_cum: Math.round(work * 10) / 100, contra_cum: 27400 }), 'record PC 7');
    assert.deepEqual(pc7.checks.map(c => c.code), [], JSON.stringify(pc7.checks));
    near(pc7.claimed_net, app2.net, 'claim shown on the PC');
    const apps = ok(await call('GET', `claims?project_id=${p}`)); assert.equal(apps.apps[0].status, 'certified');
    // a PC whose VAT does not agree is held for review
    ok(await call('PUT', `claims/pcs/${pc7.id}`, { ...pc7, lines, vat_certified: 10 }));
    const held = await call('POST', `claims/pc-invoice/${pc7.id}`, {}); assert.equal(held.s, 409); assert.equal(held.j.checks[0].code, 'vat');
    ok(await call('PUT', `claims/pcs/${pc7.id}`, { ...pc7, lines, vat_certified: '' }));
    const inv7 = ok(await call('POST', `claims/pc-invoice/${pc7.id}`, { date: '2026-03-06' }));
    const v7 = ok(await call('GET', `claims/pcs/${pc7.id}`)); near(inv7.total, v7.total, 'invoice 7 = PC 7');
    const boq = ok(await call('GET', `boq_items?project_id=${p}`)); near(boq.find(x => x.id === b1).billed_pct, 7100 / 7500 * 100, 'billed % follows the certified qty');
    assert.equal(ok(await call('GET', `claims?project_id=${p}`)).apps[0].status, 'invoiced');

    // ---- release of retention on PC 8 (VAT on the released retention under the net basis) ----
    const f8 = ok(await call('GET', `claims/pcs/new?project_id=${p}`));
    const pc8 = ok(await call('POST', 'claims/pcs', { ...f8, number: '8', issue_date: '2026-06-01', release_cum: 10000 }));
    near(pc8.net, 10000, 'release only'); near(pc8.vat_calc, 500, 'VAT on the release');
    assert.ok(pc8.checks.some(c => c.code === 'release_exceeds' && Math.abs(c.expected - 3744.91) < 0.01), 'warns: most of the retention was held before the system');
    const inv8 = ok(await call('POST', `claims/pc-invoice/${pc8.id}`, { date: '2026-06-02' })); near(inv8.total, 10500, 'release invoice');
    const i8 = ok(await call('GET', 'invoices/' + inv8.id)); near(i8.revenue, 0, 'a release is not new revenue'); near(i8.release, 10000);
    const all = ok(await call('GET', 'invoices')).filter(x => x.project_id === p && x.kind !== 'credit_note');
    near(all.reduce((s, x) => s + x.retention_open, 0), 0, 'open retention settled by the release (never below zero)');
    const fin2 = ok(await call('GET', 'financials?from=2026-01-01&to=2026-12-31')); near(fin2.tb_debit, fin2.tb_credit, 'trial balance after the release');

    // ---- void → the PC can be invoiced again; delete rules ----
    ok(await call('POST', `invoices/${inv8.id}/void`, { reason: 'wrong date' }));
    assert.equal(ok(await call('GET', `claims/pcs/${pc8.id}`)).status, 'recorded');
    ok(await call('POST', `claims/pc-invoice/${pc8.id}`, { date: '2026-06-03' }));
    assert.equal((await call('DELETE', `claims/apps/${app.id}`)).s, 400, 'a certified application stays');
    const app3 = ok(await call('POST', 'claims/apps', { project_id: p })); ok(await call('DELETE', `claims/apps/${app3.id}`));

    // ---- gross basis: VAT on the work value, retention at its full value ----
    const p2 = ok(await call('POST', 'projects', { name: 'Gross', client_id: cl, retention_pct: 10, status: 'active' })).id;
    const g = ok(await call('GET', `claims/pcs/new?project_id=${p2}`));
    const pg = ok(await call('POST', 'claims/pcs', { ...g, number: '1', issue_date: '2026-04-01', work_cum: 100000, retention_cum: 10000 }));
    near(pg.net, 90000); near(pg.vat_calc, 5000, 'gross basis: VAT on 100,000'); near(pg.total, 95000);
    const ig = ok(await call('POST', `claims/pc-invoice/${pg.id}`, {})); near(ig.total, 95000, 'gross-basis invoice = PC');
    const fin3 = ok(await call('GET', 'financials?from=2026-01-01&to=2026-12-31')); near(fin3.tb_debit, fin3.tb_credit, 'trial balance (gross basis)');
    console.log('✔ payment application (proforma, cumulative, printable) → PC received (arithmetic checks, previous values carried) → tax invoice equal to the PC;\n  VAT after retention and contra charges (net basis) or on the work value (gross), retention release, BOQ billed % from the certified qty, void, roles');
    console.log('CLAIMS TESTS PASSED');
  } catch (e) { console.error(e); process.exitCode = 1; }
  finally { server.close(); setTimeout(() => process.exit(), 100); }
});
