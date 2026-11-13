// Tender pipeline and online quote acceptance (public link, signature, decline, expiry, renewal): node --no-warnings test-sales.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-sales-'));
process.env.SALES_NO_SCHEDULER = '1';
const { server } = require('./server.js');

server.listen(0, async () => {
  const root = `http://localhost:${server.address().port}`, base = root + '/api/'; let cookie = '';
  const call = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j }; };
  const pub = async (m, p, b) => { const r = await fetch(root + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j, t, h: r.headers }; };
  const ok = (r, m = '') => { assert.equal(r.s, 200, m + ' ' + JSON.stringify(r.j)); return r.j; };
  const SIG = 'data:image/png;base64,' + 'iVBORw0KGgo' + 'A'.repeat(400) + '=';
  try {
    ok(await call('POST', 'setup', { username: 'admin', password: 'secret12', company: 'Trigon' }));
    ok(await call('PUT', 'settings', { trn: '100123456700003', terms: 'Payment 30 days' }));
    const cl = ok(await call('POST', 'parties', { type: 'client', name: 'Al Waha Developments', trn: '100234567800003', address: 'Dubai South' })).id;

    // ---- pipeline
    assert.equal((await call('POST', 'tenders', { title: '' })).s, 400);
    assert.equal((await call('POST', 'tenders', { title: 'X', stage: 'maybe' })).s, 400);
    const t1 = ok(await call('POST', 'tenders', { title: 'Internal roads — Dubai South', client_id: cl, value: 1000000, probability: 40, stage: 'invited', submission_date: '2026-11-05' })).id;
    const t2 = ok(await call('POST', 'tenders', { title: 'Warehouse yard paving', client_name: 'New Logistics LLC', value: 300000, probability: 20 })).id;
    let d = ok(await call('GET', 'tenders')); assert.equal(d.summary.open, 2); assert.equal(d.summary.pipeline, 1300000); assert.equal(d.summary.weighted, 460000);
    assert.equal(d.rows.find(t => t.id === t2).client, 'New Logistics LLC');
    assert.match((await call('POST', `tenders/${t2}/quote`)).j.error, /client/);
    assert.match((await call('PUT', 'tenders/' + t2, { stage: 'lost' })).j.error, /reason/);
    ok(await call('PUT', 'tenders/' + t2, { stage: 'lost', lost_reason: 'price' }));
    assert.equal(ok(await call('GET', 'tenders')).rows.find(t => t.id === t2).probability, 0);

    // ---- quotation from the tender, shared with the client
    const qid = ok(await call('POST', `tenders/${t1}/quote`)).quote_id;
    assert.equal(ok(await call('GET', 'tenders')).rows.find(t => t.id === t1).stage, 'preparing');
    ok(await call('PUT', 'quotes/' + qid, { items: [{ description: 'Asphalt', qty: 1000, rate: 900 }], validity_days: 30, date: new Date().toISOString().slice(0, 10) }));
    const sh = ok(await call('POST', `quotes/${qid}/share`, {})); assert.match(sh.path, /^\/q\/[a-f0-9]{48}$/);
    assert.equal(ok(await call('GET', 'quotes/' + qid)).status, 'sent');
    const pg = await pub('GET', sh.path);
    assert.equal(pg.s, 200); assert.match(pg.t, /Accept this quotation/); assert.match(pg.t, /Asphalt/); assert.match(pg.h.get('content-security-policy'), /script-src 'self'/); assert.ok(!/<script>/.test(pg.t), 'no inline script');
    assert.equal((await pub('GET', '/qa.js')).s, 200);
    assert.equal((await pub('GET', '/q/' + 'a'.repeat(48))).s, 404);
    // ---- accept with name + signature
    assert.match((await pub('POST', `/pub${sh.path}/accept`, { name: 'Ahmed Saeed', signature: 'data:image/png;base64,xx' })).j.error, /sign/);
    assert.match((await pub('POST', `/pub${sh.path}/accept`, { name: 'Al', signature: SIG })).j.error, /name/);
    ok(await pub('POST', `/pub${sh.path}/accept`, { name: 'Ahmed Saeed', signature: SIG }));
    const q = ok(await call('GET', 'quotes/' + qid)); assert.equal(q.status, 'accepted'); assert.equal(q.accepted_by, 'Ahmed Saeed'); assert.equal(q.signature, SIG);
    assert.equal(ok(await call('GET', 'tenders')).rows.find(t => t.id === t1).stage, 'won');
    assert.ok(ok(await call('GET', 'notifications')).items.some(n => /accepted/i.test(n.title)));
    assert.equal((await pub('POST', `/pub${sh.path}/accept`, { name: 'Ahmed Saeed', signature: SIG })).s, 409);
    assert.match((await pub('GET', sh.path)).t, /Accepted by Ahmed Saeed/);
    const printed = await fetch(`${base}doc/quotes/${qid}?cover=0`, { headers: { cookie } }).then(r => r.text()); assert.match(printed, /Accepted online by the client/);
    assert.equal((await call('POST', `quotes/${qid}/share`, {})).s, 400, 'answered quotations are not shared again');
    // ---- won → project
    const pr = ok(await call('POST', `quotes/${qid}/convert`)); ok(await call('PUT', 'tenders/' + t1, { project_id: pr.project_id }));
    d = ok(await call('GET', 'tenders')); assert.equal(d.summary.won_value, 1000000); assert.equal(d.summary.win_rate, 50);

    // ---- decline with a comment; renewing the link cancels the old one; expired offers cannot be accepted
    const t3 = ok(await call('POST', 'tenders', { title: 'Villa access road', client_id: cl, value: 80000, stage: 'submitted' })).id;
    const q3 = ok(await call('POST', `tenders/${t3}/quote`)).quote_id;
    const old = ok(await call('POST', `quotes/${q3}/share`, {})), renewed = ok(await call('POST', `quotes/${q3}/share`, { renew: 1 }));
    assert.notEqual(old.path, renewed.path); assert.equal((await pub('GET', old.path)).s, 404);
    ok(await pub('POST', `/pub${renewed.path}/reject`, { comment: 'Please reduce the asphalt rate' }));
    assert.equal(ok(await call('GET', 'quotes/' + q3)).status, 'rejected');
    assert.equal(ok(await call('GET', 'tenders')).rows.find(t => t.id === t3).stage, 'negotiation');
    const q4 = ok(await call('POST', 'quotes', { client_id: cl, date: '2025-01-01', validity_days: 30, items: [{ description: 'Old', qty: 1, rate: 1 }] })).id;
    const s4 = ok(await call('POST', `quotes/${q4}/share`, {}));
    assert.equal((await pub('POST', `/pub${s4.path}/accept`, { name: 'Ahmed Saeed', signature: SIG })).s, 410);
    assert.match((await pub('GET', s4.path)).t, /expired/);

    // ---- quotation as a bill of quantities: sections, sub-totals, provisional items outside the total, cover fields
    const bq = ok(await call('POST', 'quotes', { client_id: cl, project_name: 'Sample Paving Works', validity_days: 30, date: '2026-11-11', attention: 'Mr. Sample', location: 'Business Bay, Dubai, UAE', plot_no: '000-0000', noc_ref: 'NOC-TEST-0001',
      scope: 'External paving works — complete', contract_basis: 'Re-measurable', payment_terms: '50% - Upon signing of the agreement\n50%: Upon completion of the works', terms: '1. All items are all-inclusive.\nQuantities are approximate.', notes: 'Prices exclude VAT.',
      items: [{ section: 'Pre-construction', description: 'Approvals', unit: 'LS', qty: 1, rate: 1000 }, { section: 'Paving works', description: 'Sub base', unit: 'm2', qty: 10, rate: 100 }, { section: 'Paving works', description: 'Block paving', unit: 'm2', qty: 10, rate: 200 },
        { section: 'Pre-construction', description: 'Surveys', unit: 'LS', qty: 1, rate: 500 }, { description: 'Road markings', unit: 'LS', qty: 1, rate: 700, provisional: true }] })).id;
    let bqd = ok(await call('GET', 'quotes/' + bq));
    assert.equal(bqd.subtotal, 4500, 'provisional items are not part of the total'); assert.equal(bqd.vat, 225); assert.equal(bqd.total, 4725); assert.equal(bqd.provisional_total, 700);
    assert.equal(bqd.attention, 'Mr. Sample'); assert.equal(bqd.plot_no, '000-0000'); assert.equal(bqd.contract_basis, 'Re-measurable');
    const bh = await fetch(`${base}doc/quotes/${bq}`, { headers: { cookie } }).then(r => r.text());
    for (const re of [/<td>ATTENTION<\/td><td>Mr\. Sample<\/td>/, /<td>Location<\/td><td>Business Bay, Dubai, UAE<\/td>/, /<td>Plot No\.<\/td><td>000-0000<\/td>/, /<td>NOC Reference<\/td><td>NOC-TEST-0001<\/td>/, /<td>Scope of Work<\/td><td>External paving works — complete<\/td>/, /<td>Contract Basis<\/td><td>Re-measurable<\/td>/,
      /class="cv-pay"><div><b>50%<\/b><span>Upon signing of the agreement<\/span><\/div><div><b>50%<\/b><span>Upon completion of the works<\/span><\/div>/, /<span>TOTAL AMOUNT \(Excl\. VAT 5%\)<\/span><b class="mono">AED 4,500\.00<\/b>/, /<span>TOTAL INCLUSIVE OF VAT 5%<\/span><b class="mono">AED 4,725\.00<\/b>/]) assert.match(bh, re);
    for (const re of [/BILL OF QUANTITIES — SAMPLE PAVING WORKS/, /Client: Al Waha Developments \| Sample Paving Works \| Business Bay, Dubai, UAE \| Plot 000-0000/, /Ref: [^|]+ \| Date: 11 November 2026 \| Currency: AED \| Valid: 30 Days \| Prices Exclude VAT 5%/,
      /<tr class="sec"><td colspan="6">PRE-CONSTRUCTION<\/td><\/tr><tr><td>A1<\/td><td>Approvals<\/td>.*<tr><td>A2<\/td><td>Surveys<\/td>.*SUB-TOTAL — PRE-CONSTRUCTION<\/td><td class="n">1,500\.00<\/td>/s, /<tr class="sec"><td colspan="6">PAVING WORKS<\/td><\/tr><tr><td>B1<\/td><td>Sub base<\/td>.*<td>B2<\/td><td>Block paving<\/td>.*SUB-TOTAL — PAVING WORKS<\/td><td class="n">3,000\.00<\/td>/s,
      /GRAND TOTAL \(Excl\. VAT 5%\)<\/td><td class="n">4,500\.00<\/td>/, /VAT 5% \(added at invoice stage\)<\/td><td class="n">225\.00<\/td>/, /TOTAL INCLUSIVE OF VAT 5%<\/td><td class="n">4,725\.00<\/td>/,
      /PROVISIONAL ITEMS — Payable only if executed \/ instructed \(NOT included in Grand Total\)/, /<td>P1<\/td><td>Road markings<\/td>/, /TOTAL PROVISIONAL \(if all executed\)<\/td><td class="n">700\.00<\/td>/,
      /<h4>NOTES<\/h4><ol><li>All items are all-inclusive\.<\/li><li>Quantities are approximate\.<\/li><li>Prices exclude VAT\.<\/li><\/ol>/]) assert.match(bh, re);
    const plain = await fetch(`${base}doc/quotes/${qid}?cover=0`, { headers: { cookie } }).then(r => r.text());              // no sections: plain numbering, no sub-totals
    assert.match(plain, /<tr><td>1<\/td><td>Asphalt<\/td>/); assert.ok(!/SUB-TOTAL/.test(plain) && !/PROVISIONAL ITEMS/.test(plain)); assert.match(plain, /GRAND TOTAL/);
    const bp = ok(await call('POST', `quotes/${bq}/convert`)).project_id, bproj = ok(await call('GET', 'projects/' + bp));
    assert.equal(bproj.contract_value, 4500, 'contract value = the quotation total without the provisional items');
    const bboq = ok(await call('GET', 'boq_items?project_id=' + bp)).filter(x => x.project_id === bp);
    assert.deepEqual(bboq.map(x => x.section), ['Pre-construction', 'Paving works', 'Paving works', 'Pre-construction', 'Provisional items']);

    // ---- roles
    ok(await call('POST', 'users', { username: 'viewer1', password: 'pass1234', role: 'viewer' }));
    cookie = ''; ok(await call('POST', 'login', { username: 'viewer1', password: 'pass1234' }));
    assert.equal((await call('GET', 'tenders')).s, 200); assert.equal((await call('POST', 'tenders', { title: 'x' })).s, 403); assert.equal((await call('POST', `quotes/${q3}/share`, {})).s, 403);
    console.log('✔ tender pipeline (stages, weighted value, win rate, lost reason), quotation from tender, public acceptance link (CSP, signature, decline, renewal, expiry), notifications, print, roles');
    console.log('SALES TESTS PASSED');
  } catch (e) { console.error('FAIL', e); process.exitCode = 1; }
  finally { server.close(); setTimeout(() => process.exit(process.exitCode || 0), 100); }
});
