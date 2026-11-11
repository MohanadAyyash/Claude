// Zoho review fixes: a failed update never leads to a second document, bounced / deleted / changed payments are reconciled,
// bill VAT equals the recorded VAT: node --no-warnings test-zohofix.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-zohofix-'));
process.env.ZOHO_NO_SCHEDULER = '1'; process.env.SALES_NO_SCHEDULER = '1';
const zoho = require('./tools/zoho-mock.js')();
process.env.ZOHO_CLIENT_ID = zoho.CLIENT_ID; process.env.ZOHO_CLIENT_SECRET = zoho.CLIENT_SECRET;
const { server } = require('./server.js');
const { DatabaseSync } = require('node:sqlite');

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api/`; let cookie = '';
  const call = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j }; };
  const ok = (r, l) => { assert.equal(r.s, 200, `${l || ''} → ${r.s} ${JSON.stringify(r.j).slice(0, 300)}`); return r.j; };
  const sql = (q, ...a) => { const d = new DatabaseSync(path.join(process.env.DATA_DIR, 'erp.db')); try { return /^select/i.test(q) ? d.prepare(q).all(...a) : d.prepare(q).run(...a); } finally { d.close(); } };
  await new Promise(r => zoho.srv.listen(0, r)); process.env.ZOHO_ACCOUNTS_URL = zoho.accountsUrl;
  const RANGE = { from: '2026-10-01', to: '2026-12-31' }, sync = async () => ok(await call('POST', 'zoho/sync', RANGE));
  try {
    ok(await call('POST', 'setup', { username: 'admin', password: 'secret12', company: 'Trigon' }));
    ok(await call('PUT', 'settings', { trn: '100123456700003' }));
    const cl = ok(await call('POST', 'parties', { type: 'client', name: 'Client', trn: '100000000000003' })).id, sup = ok(await call('POST', 'parties', { type: 'supplier', name: 'Supplier', trn: '100000000000011' })).id;
    const P = ok(await call('POST', 'projects', { name: 'Roads', client_id: cl, status: 'active' })).id;
    const inv = ok(await call('POST', 'invoices', { project_id: P, date: '2026-11-05', items: [{ description: 'Work', qty: 1, rate: 1000 }] })).id;
    const exp = ok(await call('POST', 'bills', { date: '2026-11-06', project_id: P, category: 'materials', description: 'Cash purchase', amount: 200, vat_amount: 10 })).id;
    const bill = ok(await call('POST', 'bills', { date: '2026-11-07', party_id: sup, project_id: P, category: 'subcontract', description: 'Certificate', amount: 100000, vat_amount: 4500, reference: 'SC-1' })).id;
    const pay = ok(await call('POST', 'payments', { kind: 'in', date: '2026-11-10', amount: 500, method: 'cheque', cheque_date: '2026-11-10', cheque_status: 'cleared', reference: 'CHQ1', invoice_id: inv })).id;
    ok(await call('POST', 'zoho/connect', { code: zoho.newCode() })); ok(await call('PUT', 'zoho/config', { enabled: '1', start: '2026-10-01', post: '0' }));
    let r = await sync(); assert.equal(r.failed, 0, JSON.stringify(r).slice(0, 400));

    // ---- bill VAT = the VAT on the document (100,000 with VAT 4,500 on a net-basis certificate)
    const zb = zoho.T.bills[0]; assert.equal(zb.line_items.length, 2);
    assert.equal(zb.line_items[0].rate, 90000); assert.ok(zb.line_items[0].tax_id); assert.equal(zb.line_items[1].rate, 10000); assert.equal(zb.line_items[1].tax_id, undefined);
    console.log('✔ bill: VAT sent = VAT recorded (90,000 taxable + 10,000 without VAT), not 5% of the whole amount');

    // ---- a record whose update failed is updated, never posted a second time; retry keeps its link
    assert.equal(zoho.T.expenses.length, 1); assert.equal(zoho.T.customerpayments.length, 1);
    sql("UPDATE zoho_sync SET status='error', error='timeout' WHERE kind='bill' AND local_id=?", exp);
    sql("UPDATE zoho_sync SET status='error', error='timeout' WHERE kind='invoice' AND local_id=?", inv);
    ok(await call('POST', 'zoho/retry')); assert.equal(sql("SELECT COUNT(*) n FROM zoho_sync WHERE kind='bill' AND local_id=?", exp)[0].n, 1, 'retry keeps the link');
    ok(await call('PUT', 'bills/' + exp, { description: 'Cash purchase (edited)' }));
    r = await sync(); assert.equal(r.failed, 0, JSON.stringify(r).slice(0, 400));
    assert.equal(zoho.T.expenses.length, 1, 'no duplicate expense'); assert.match(zoho.T.expenses[0].description, /edited/); assert.equal(zoho.T.invoices.length, 1);
    assert.equal(sql("SELECT status FROM zoho_sync WHERE kind='bill' AND local_id=?", exp)[0].status, 'ok'); assert.equal(sql("SELECT status FROM zoho_sync WHERE kind='invoice' AND local_id=?", inv)[0].status, 'ok');
    console.log('✔ after a failed update the record is updated in place — no duplicate expense / invoice');

    // ---- payments: a changed one is replaced, a bounced one is removed
    ok(await call('PUT', 'payments/' + pay, { amount: 700 }));
    r = await sync(); assert.equal(zoho.T.customerpayments.length, 1); assert.equal(zoho.T.customerpayments[0].amount, 700);
    ok(await call('PUT', 'payments/' + pay, { cheque_status: 'bounced' }));
    r = await sync(); assert.equal(zoho.T.customerpayments.length, 0, 'bounced cheque removed from Zoho');
    assert.equal(sql("SELECT status FROM zoho_sync WHERE kind='payment' AND local_id=?", pay)[0].status, 'cancelled');
    r = await sync(); assert.equal(zoho.T.customerpayments.length, 0);
    console.log('✔ payments: edited → replaced in Zoho; bounced → removed from Zoho');
    console.log('ZOHO FIX TESTS PASSED');
  } catch (err) { console.error('FAIL', err); process.exitCode = 1; }
  finally { server.close(); zoho.srv.close(); setTimeout(() => process.exit(process.exitCode || 0), 100); }
});
