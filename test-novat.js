// Not VAT-registered: 0% VAT by default, "Invoice" (not "Tax Invoice"), Zoho without a VAT tax: node --no-warnings test-novat.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-novat-'));
process.env.ZOHO_NO_SCHEDULER = '1'; process.env.SALES_NO_SCHEDULER = '1';
const zoho = require('./tools/zoho-mock.js')();
process.env.ZOHO_CLIENT_ID = zoho.CLIENT_ID; process.env.ZOHO_CLIENT_SECRET = zoho.CLIENT_SECRET;
const { server } = require('./server.js');
const { docHtml } = require('./lib/docs.js');

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api/`; let cookie = '';
  const call = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j }; };
  const ok = (r, l) => { assert.equal(r.s, 200, `${l || ''} → ${r.s} ${JSON.stringify(r.j).slice(0, 300)}`); return r.j; };
  await new Promise(r => zoho.srv.listen(0, r)); process.env.ZOHO_ACCOUNTS_URL = zoho.accountsUrl;
  try {
    ok(await call('POST', 'setup', { username: 'admin', password: 'secret12', company: 'Trigon' }));
    ok(await call('PUT', 'settings', { vat_registered: '0', trn: '' }));
    zoho.T.taxes.length = 0;                                                         // the Zoho organisation has no VAT set up
    const cl = ok(await call('POST', 'parties', { type: 'client', name: 'Client' })).id, sup = ok(await call('POST', 'parties', { type: 'supplier', name: 'Supplier' })).id;
    const p = ok(await call('POST', 'projects', { name: 'P', client_id: cl, status: 'active' })).id;
    const inv = ok(await call('POST', 'invoices', { project_id: p, date: '2026-11-05', items: [{ description: 'Works', qty: 1, rate: 1000 }] }), 'invoice without a TRN');
    const iv = ok(await call('GET', 'invoices/' + inv.id)); assert.equal(iv.vat_pct, 0); assert.equal(iv.vat, 0); assert.equal(iv.total, 1000);
    const S = ok(await call('GET', 'settings')), html = docHtml({ kind: 'invoices', doc: iv, settings: S });
    assert.ok(/Invoice \/ فاتورة/.test(html) && !/Tax Invoice/.test(html), 'title is "Invoice", not "Tax Invoice"');
    ok(await call('POST', 'bills', { date: '2026-11-06', party_id: sup, project_id: p, category: 'materials', description: 'Sand', amount: 200, vat_amount: 10 }));
    ok(await call('POST', 'zoho/connect', { code: '1000.code.one' }));
    ok(await call('PUT', 'zoho/config', { enabled: '1', start: '2026-11-01', post: '0' }));
    const r = ok(await call('POST', 'zoho/sync', { from: '2026-11-01', to: '2026-12-31' })); assert.equal(r.failed, 0, r.message);
    assert.ok(!zoho.T.invoices[0].line_items[0].tax_id, 'invoice sent without tax'); assert.equal(zoho.T.invoices[0].total, 1000);
    assert.equal(zoho.T.bills[0].line_items[0].rate, 210, 'supplier VAT included in the cost'); assert.ok(!zoho.T.bills[0].line_items[0].tax_id);
    console.log('✔ not VAT-registered: invoice 0% VAT titled "Invoice"; Zoho without VAT: invoice sent untaxed, supplier VAT 10 added to the cost (210)');
    console.log('NO-VAT TESTS PASSED');
  } catch (e) { console.error('FAIL', e); process.exitCode = 1; }
  finally { server.close(); zoho.srv.close(); setTimeout(() => process.exit(process.exitCode || 0), 100); }
});
