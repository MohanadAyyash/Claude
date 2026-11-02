// Purchase order: item code, line discount, supplier/purchaser TRNs, delivery and agreement period, amount in words, conditions page: node --no-warnings test-po.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-po-'));
process.env.ZOHO_NO_SCHEDULER = '1'; process.env.SALES_NO_SCHEDULER = '1';
const { server } = require('./server.js');
server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api/`; let cookie = '';
  const call = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; return { s: r.status, j: await r.json().catch(() => null) }; };
  const ok = (r, l) => { assert.equal(r.s, 200, `${l || ''} → ${r.s} ${JSON.stringify(r.j).slice(0, 300)}`); return r.j; };
  const near = (a, b, l) => assert.ok(Math.abs(a - b) < 0.006, `${l}: ${a} ≠ ${b}`);
  const page = async u => { const r = await fetch(base + u, { headers: { cookie } }); return r.text(); };
  try {
    ok(await call('POST', 'setup', { username: 'admin', password: 'secret12', company: 'Trigon' }));
    ok(await call('PUT', 'settings', { trn: '100123456700003', legal_name: 'Trigon Civil L.L.C' }));
    const sup = ok(await call('POST', 'parties', { type: 'supplier', name: 'Road Materials Trading LLC', trn: '100245186000003', phone: '+971 4 000 0001', email: 'sales@rmt.example', address: 'Al Quoz, Dubai' })).id;
    const p = ok(await call('POST', 'projects', { code: 'P-1', name: 'Roads', status: 'active' })).id;
    const po = ok(await call('POST', 'purchase_orders', { party_id: sup, project_id: p, date: '2026-04-08', status: 'sent', vat_pct: 5, payment_terms: '60 days credit', deliver_to: 'Site P-1', site_contact: 'Site engineer 050 000 0000',
      valid_from: '2026-04-08', valid_to: '2026-10-08', pr_ref: 'PR-2026-014', quote_ref: 'Q-778 dated 01-04-2026', terms: '50% on submission, 50% on approval',
      items: [{ code: 'G7-999-725', description: 'As-built drawing preparation\nRoad and utility works', unit: 'nr', qty: 1, rate: 450, disc: 0, vat: 'std' }, { code: 'KB-150', description: 'Precast kerb 150 mm', unit: 'm', qty: 100, rate: 30, disc: 10, vat: 'std' }] })).id;
    const v = ok(await call('GET', 'purchase_orders/' + po));
    near(v.gross, 3450, 'gross'); near(v.discount, 300, 'discount'); near(v.subtotal, 3150, 'net'); near(v.vat, 157.5, 'VAT on net'); near(v.total, 3307.5, 'total');
    assert.equal(v.items[1].code, 'KB-150'); assert.equal(v.items[1].disc, 10);
    let html = await page('doc/purchase_orders/' + po);
    for (const t of ['PURCHASE ORDER', 'G7-999-725', 'Road Materials Trading LLC', '100245186000003', 'Trigon Civil L.L.C', '100123456700003', 'PR-2026-014', 'Q-778', '60 days credit', 'Site engineer', '2026-10-08', 'Total order discount', '3,307.50',
      'Dirhams Three Thousand Three Hundred Seven and Fils 50/100 only', 'Purchase order number to be shown', 'GENERAL CONDITIONS OF PURCHASE', 'Signed and sealed for the supplier', '50% on submission'])
      assert.ok(html.includes(t), 'printed: ' + t);
    assert.ok(html.indexOf('Signed and sealed for the supplier') < html.indexOf('GENERAL CONDITIONS'), 'signatures before the conditions page');
    // conditions and notes from Settings; empty = no conditions page
    ok(await call('PUT', 'settings', { po_conditions: '', po_notes: 'Quote the PO number on every delivery note.' }));
    html = await page('doc/purchase_orders/' + po); assert.ok(!html.includes('GENERAL CONDITIONS') && html.includes('Quote the PO number'), 'settings texts');
    // committed cost and the bill on receipt use the net amount
    const bud = ok(await call('GET', `projects/${p}/budget`)); near(bud.lines.find(l => l.category === 'materials').committed, 3150, 'committed cost after the discount');
    ok(await call('POST', `purchase_orders/${po}/receive`, { date: '2026-05-01' }));
    const bill = ok(await call('GET', 'bills')).find(b => b.reference === v.number); near(bill.amount, 3150, 'bill = net'); near(bill.vat_amount, 157.5);
    console.log('✔ purchase order: item codes, line discounts, both TRNs, PR/quotation refs, payment terms, deliver-to & site contact, agreement period, amount in words, standard notes, conditions page; net to bill and committed cost');
    console.log('PO TESTS PASSED');
  } catch (e) { console.error(e); process.exitCode = 1; }
  finally { server.close(); setTimeout(() => process.exit(), 100); }
});
