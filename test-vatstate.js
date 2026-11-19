// VAT registration state with an effective date (accounting review of 2026-11-20): invoices follow the registration on their own
// date (default rate, TRN, "Tax Invoice" title); purchase VAT postings do not change and nothing is reclassified; the daily check
// flags documents dated before the registration. node --no-warnings test-vatstate.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-vatstate-'));
process.env.ZOHO_NO_SCHEDULER = '1'; process.env.SALES_NO_SCHEDULER = '1';
const { server, ctx } = require('./server.js');
const { docHtml } = require('./lib/docs.js');

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api/`; let cookie = '';
  const call = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { s: r.status, j, t }; };
  const ok = (r, l) => { assert.equal(r.s, 200, `${l || ''} → ${r.s} ${r.t.slice(0, 300)}`); return r.j; };
  const no = (r, re) => { assert.ok(r.s >= 400, `expected a refusal, got ${r.s}`); assert.match(r.t, re); };
  const out = [];
  try {
    ok(await call('POST', 'setup', { username: 'admin', password: 'secret12', company: 'Trigon' }));
    const cl = ok(await call('POST', 'parties', { type: 'client', name: 'Client', trn: '100000000000003' })).id, sup = ok(await call('POST', 'parties', { type: 'supplier', name: 'Supplier' })).id;
    const p = ok(await call('POST', 'projects', { name: 'P', client_id: cl, status: 'active', contract_value: 100000, advance_pct: 10, advance_recovery_pct: 10 })).id;
    const inv = async date => ok(await call('GET', 'invoices/' + ok(await call('POST', 'invoices', { project_id: p, date, items: [{ description: 'Works', qty: 1, rate: 1000 }] }), date).id));
    const title = async iv => docHtml({ kind: 'invoices', doc: iv, settings: ok(await call('GET', 'settings')) });
    const chk = async () => ok(await call('GET', 'ops/checks')).results.find(x => x.id === 'vat_registration');

    // ---- no effective date: as before — registered on every date (TRN needed, 5%, "Tax Invoice")
    no(await call('POST', 'invoices', { project_id: p, date: '2026-10-05', items: [{ description: 'Works', qty: 1, rate: 1000 }] }), /TRN/);
    ok(await call('PUT', 'settings', { trn: '100123456700003' }));
    let iv = await inv('2026-10-05'); assert.equal(iv.vat_pct, 5); assert.match(await title(iv), /Tax Invoice/);
    assert.equal((await chk()).status, 'ok'); assert.match((await chk()).detail, /no effective date/);
    out.push('no effective date: unchanged — registered on every date');

    // ---- registered from 1 December 2026 (TRN not known yet before that)
    no(await call('PUT', 'settings', { vat_effective_date: '01/12/2026' }), /YYYY-MM-DD/);
    ok(await call('PUT', 'settings', { vat_registered: '1', vat_effective_date: '2026-12-01', trn: '' }));
    iv = await inv('2026-11-15'); assert.equal(iv.vat_pct, 0, 'before the effective date: 0% by default'); assert.equal(iv.vat, 0);
    const h = await title(iv); assert.ok(/>Invoice</.test(h) && !/Tax Invoice/.test(h), 'before the effective date: "Invoice"');
    no(await call('POST', 'invoices', { project_id: p, date: '2026-12-05', items: [{ description: 'Works', qty: 1, rate: 1000 }] }), /TRN/);
    const advi = ok(await call('POST', `projects/${p}/advance-invoice`, { date: '2026-11-20' })); assert.equal(ok(await call('GET', 'invoices/' + advi.id)).vat_pct, 0, 'advance invoice before the date: 0%');
    ok(await call('PUT', 'settings', { trn: '100123456700003' }));
    iv = await inv('2026-12-05'); assert.equal(iv.vat_pct, 5, 'from the effective date: 5%'); assert.match(await title(iv), /Tax Invoice/);
    out.push('effective 2026-12-01: an invoice of 15 Nov is a plain 0% "Invoice" without TRN; from 1 Dec a 5% "Tax Invoice" with the TRN');

    // ---- purchase VAT: postings unchanged, nothing reclassified; the daily check flags it (and an invoice with VAT before the date)
    const b = ok(await call('POST', 'bills', { party_id: sup, date: '2026-11-18', amount: 1000, vat_amount: 50, category: 'materials', project_id: p })).id;
    const tb = () => Object.fromEntries(ctx.financials('2000-01-01', '2099-12-31').trial_balance.map(a => [a.code, a.debit - a.credit]));
    assert.equal(tb()['1200'], 50, 'supplier VAT stays in 1200 (no posting change)');
    ok(await call('POST', 'invoices', { project_id: p, date: '2026-11-25', vat_pct: 5, items: [{ description: 'Works', qty: 1, rate: 100 }] }));
    const c = await chk(); assert.equal(c.status, 'warn');
    assert.match(c.detail, /2 invoice\(s\) with VAT dated before the VAT registration/);   // 25 Nov, and the October invoice issued with VAT before the effective date was known assert.match(c.detail, /1 supplier bill\(s\) with VAT dated before the VAT registration: recorded as input VAT \(1200\), awaiting the tax adviser — not reclassified/);
    assert.ok(c.items.includes(`bill #${b}`)); assert.doesNotMatch(c.detail, /\b50\b|1000/, 'no amounts in the check text');
    assert.equal(tb()['1200'], 50, 'still 1200 after the check');
    out.push('purchase VAT before registration: stays in 1200, flagged by the daily check, not reclassified');

    // ---- not registered at all: every date, as before
    ok(await call('PUT', 'settings', { vat_registered: '0' }));
    iv = await inv('2027-01-10'); assert.equal(iv.vat_pct, 0); assert.ok(!/Tax Invoice/.test(await title(iv)));
    out.push('"not registered": 0% on every date, as before');

    console.log(out.map(x => '  ✔ ' + x).join('\n'));
    console.log('VAT REGISTRATION STATE TESTS PASSED');
  } finally { server.close(); }
});
