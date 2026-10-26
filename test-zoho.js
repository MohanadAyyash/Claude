// Zoho Books bridge test against an in-process mock of Zoho accounts + Books API v3: node --no-warnings test-zoho.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-zoho-'));
process.env.ZOHO_NO_SCHEDULER = '1';
const { server } = require('./server.js');

const mockZoho = require('./tools/zoho-mock.js');

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api/`;
  let cookie = '';
  const call = async (m, u, b) => {
    const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie }, body: b ? JSON.stringify(b) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch { j = text; }
    return { s: r.status, j, text };
  };
  const zoho = mockZoho(); await new Promise(ok => zoho.srv.listen(0, ok));
  process.env.ZOHO_ACCOUNTS_URL = zoho.accountsUrl;
  const posts = () => zoho.calls.filter(c => c.startsWith('POST') || c.startsWith('PUT')).length;
  try {
    assert.equal((await call('POST', 'setup', { username: 'admin', password: 'secret12', company: 'Trigon' })).s, 200);
    assert.equal((await call('PUT', 'settings', { trn: '100123456700003' })).s, 200);
    const client = (await call('POST', 'parties', { type: 'client', name: 'Emaar Test', trn: '100000000000003', email: 'ap@emaar.test' })).j.id;
    const supplier = (await call('POST', 'parties', { type: 'supplier', name: 'Steel Supplier LLC' })).j.id;
    const proj = (await call('POST', 'projects', { name: 'Villa 12', client_id: client, retention_pct: 10, emirate: 'sharjah' })).j.id;
    const D = '2026-10-20';
    const inv = (await call('POST', 'invoices', { project_id: proj, date: D, retention_pct: 10, items: [{ description: 'Excavation', qty: 100, rate: 50 }, { description: 'Backfill', qty: 10, rate: 20 }] })).j;
    inv.number = (await call('GET', 'invoices/' + inv.id)).j.number;
    const bill = (await call('POST', 'bills', { date: D, party_id: supplier, project_id: proj, category: 'materials', description: 'Rebar', amount: 1000, vat_amount: 50, reference: 'SUP-77' })).j;
    const bill2 = (await call('POST', 'bills', { date: D, category: 'transport', description: 'Taxi', amount: 40, vat_amount: 0 })).j;
    assert.equal((await call('POST', 'payments', { kind: 'in', date: D, amount: 2000, method: 'bank', reference: 'TT-1', invoice_id: inv.id })).s, 200);
    assert.equal((await call('POST', 'payments', { kind: 'out', date: D, amount: 1050, method: 'cash', bill_id: bill.id })).s, 200);
    assert.equal((await call('POST', 'payments', { kind: 'out', date: D, amount: 40, method: 'cash', bill_id: bill2.id })).s, 200);       // paid expense → part of the expense
    assert.equal((await call('POST', 'payments', { kind: 'out', date: D, amount: 99, method: 'bank', reference: 'misc' })).s, 200);         // not linked → skipped

    // ---- daily report and CSV import files work before any Zoho account exists
    const rep = (await call('GET', 'zoho/report?date=' + D)).j;
    assert.equal(rep.rows.length, 7); assert.equal(rep.totals.invoiced, 5460); assert.equal(rep.totals.output_vat, 260); assert.equal(rep.totals.bills, 1090); assert.equal(rep.totals.input_vat, 50);
    assert.equal(rep.totals.received, 2000); assert.equal(rep.totals.paid, 1189); assert.equal(rep.totals.pending, 7);
    assert.ok(rep.rows.find(r => r.type === 'expense' && r.total === 40));
    const csvInv = (await call('GET', `zoho/export?kind=invoices&from=${D}&to=${D}`)).j;
    assert.match(csvInv, /^﻿?Invoice Number,Invoice Date,Due Date,Customer Name,Place of Supply/);
    assert.match(csvInv, new RegExp(`${inv.number},2026-10-20,[^,]*,Emaar Test,SH,Villa 12,.*Excavation,,100,50,Standard Rate,5`, 's'));
    assert.match(csvInv, new RegExp(`${inv.number},2026-10-20,[^,]*,Emaar Test,SH,.*Backfill,,10,20,Standard Rate,5`, 's'));   // every line repeats the invoice fields
    assert.match((await call('GET', 'zoho/export?kind=customers')).j, /Emaar Test,Emaar Test,ap@emaar.test,,,vat_registered,100000000000003/);
    assert.ok(!(await call('GET', 'zoho/export?kind=customers')).j.includes('Steel Supplier'));
    assert.match((await call('GET', 'zoho/export?kind=vendors')).j, /Steel Supplier LLC/);
    assert.match((await call('GET', `zoho/export?kind=bills&from=${D}`)).j, /SUP-77,2026-10-20,Steel Supplier LLC,SH,Villa 12,.*Rebar,1,1000,Standard Rate,5,Materials/s);
    assert.match((await call('GET', `zoho/export?kind=expenses&from=${D}`)).j, /2026-10-20,Cost of Goods Sold,Petty Cash,40,,,false,TRG-B\d+,/);
    assert.match((await call('GET', `zoho/export?kind=customer_payments&from=${D}`)).j, /2026-10-20,Emaar Test,banktransfer,Bank,2000,TT-1,.*,INV-?\d+.*,2000/s);
    assert.equal((await call('GET', 'zoho/export?kind=nope')).s, 400);

    // ---- connection: Self Client code exchange; secrets never come back; validation
    assert.equal((await call('POST', 'zoho/sync', {})).s, 400);                          // switched off
    assert.equal((await call('PUT', 'zoho/config', { dc: 'mars' })).s, 400);
    assert.equal((await call('POST', 'zoho/connect', { code: 'x' })).s, 400);             // no client yet
    assert.equal((await call('PUT', 'zoho/config', { dc: 'ae', client_id: zoho.CLIENT_ID, client_secret: 'wrong-secret' })).s, 200);
    const c0 = await call('POST', 'zoho/connect', { code: '1000.code.one' }); assert.equal(c0.s, 400); assert.match(c0.j.error, /Client ID/);
    assert.equal((await call('PUT', 'zoho/config', { client_secret: zoho.CLIENT_SECRET })).s, 200);
    const c1 = await call('POST', 'zoho/connect', { code: '1000.code.bad' }); assert.equal(c1.s, 400); assert.match(c1.j.error, /code/);
    const c2 = await call('POST', 'zoho/connect', { code: '1000.code.one' }); assert.equal(c2.s, 200, JSON.stringify(c2.j));
    assert.equal(c2.j.connected, '1'); assert.equal(c2.j.org, zoho.ORG); assert.equal(c2.j.org_name, 'Trigon Civil Road Contracting');
    const st = await call('GET', 'zoho');
    for (const secret of [zoho.CLIENT_SECRET, 'rt-', 'at-', 'wrong-secret']) assert.ok(!st.text.includes(secret), 'leaked ' + secret);
    assert.equal(st.j.config.secret_set, '1'); assert.match(st.j.scope, /ZohoBooks\.invoices\.ALL/);
    assert.ok(!(await call('GET', 'settings')).text.includes(zoho.CLIENT_SECRET));
    assert.equal((await call('PUT', 'zoho/config', { org: '123' })).s, 400);             // only an organisation from the account
    const t1 = (await call('POST', 'zoho/test')).j; assert.equal(t1.ok, true, JSON.stringify(t1)); assert.equal(t1.lookups.tax, 'Standard Rate'); assert.deepEqual(t1.missing, []);

    // ---- first sync: contacts, invoice, bill, expense, payments
    assert.equal((await call('PUT', 'zoho/config', { enabled: '1', start: '2026-10-01', post: '1' })).s, 200);
    const s1 = (await call('POST', 'zoho/sync', {})).j;
    assert.equal(s1.failed, 0, JSON.stringify(s1)); assert.equal(s1.skipped, 1);
    const ct = zoho.T.contacts, emaar = ct.find(c => c.contact_name === 'Emaar Test');
    assert.equal(emaar.contact_type, 'customer'); assert.equal(emaar.tax_reg_no, '100000000000003'); assert.equal(emaar.tax_treatment, 'vat_registered'); assert.equal(emaar.contact_persons[0].email, 'ap@emaar.test');
    assert.equal(ct.find(c => c.contact_name === 'Steel Supplier LLC').contact_type, 'vendor'); assert.equal(ct.length, 2);
    const zi = zoho.T.invoices.find(i => i.invoice_number === inv.number);
    assert.equal(zi.place_of_supply, 'SH'); assert.equal(zi.line_items.length, 2); assert.equal(zi.line_items[0].tax_id, '1001'); assert.equal(zi.total, 5460);
    assert.match(zi.notes, /Retention 10% = 520\.00 AED/); assert.equal(zi.balance, 3460); assert.equal(zi.status, 'partially_paid');
    const zb = zoho.T.bills.find(b => b.bill_number === 'SUP-77');
    assert.equal(zb.line_items[0].account_id, '3002'); assert.equal(zb.line_items[0].tax_id, '1001'); assert.equal(zb.line_items[0].rate, 1000); assert.equal(zb.status, 'paid');
    const ze = zoho.T.expenses[0]; assert.equal(zoho.T.expenses.length, 1);
    assert.equal(ze.reference_number, `TRG-B${bill2.id}`); assert.equal(ze.account_id, '3001'); assert.equal(ze.paid_through_account_id, '2002'); assert.equal(ze.tax_id, undefined); assert.equal(ze.amount, 40);
    const cp = zoho.T.customerpayments; assert.equal(cp.length, 1);
    assert.equal(cp[0].amount, 2000); assert.equal(cp[0].account_id, '2001'); assert.equal(cp[0].payment_mode, 'banktransfer'); assert.deepEqual(cp[0].invoices, [{ invoice_id: zi.invoice_id, amount_applied: 2000 }]);
    const vp = zoho.T.vendorpayments; assert.equal(vp.length, 1); assert.equal(vp[0].paid_through_account_id, '2002'); assert.equal(vp[0].payment_mode, 'cash'); assert.equal(vp[0].bills[0].amount_applied, 1050);
    const log1 = (await call('GET', 'zoho/log')).j;
    assert.ok(log1.find(l => l.kind === 'payment' && l.status === 'included')); assert.ok(log1.find(l => l.kind === 'payment' && l.status === 'skipped'));
    assert.ok(log1.every(l => l.status !== 'ok' || /^\d+$/.test(l.zoho_id)), 'ids stored as exact strings');

    // ---- second sync sends nothing again (idempotent), also after the access token expired
    const before = posts(); zoho.expireAccessTokens();
    const s2 = (await call('POST', 'zoho/sync', {})).j; assert.equal(s2.sent, 0); assert.equal(s2.failed, 0, JSON.stringify(s2));
    assert.equal(posts(), before);

    // ---- contact edits update the same contact person; editing a part-paid invoice is flagged, not overwritten
    assert.equal((await call('PUT', 'parties/' + client, { type: 'client', name: 'Emaar Test', trn: '100000000000003', email: 'new@emaar.test' })).s, 200);
    assert.equal((await call('PUT', 'invoices/' + inv.id, { project_id: proj, date: D, items: [{ description: 'Excavation', qty: 120, rate: 50 }] })).s, 200);
    const s3 = (await call('POST', 'zoho/sync', {})).j; assert.equal(s3.failed, 1); assert.equal(s3.updated, 1);
    assert.equal(emaar.contact_persons.length, 1); assert.equal(emaar.contact_persons[0].email, 'new@emaar.test');
    assert.equal(zi.line_items.length, 2);
    assert.ok((await call('GET', 'zoho/log')).j.find(l => l.kind === 'invoice' && l.status === 'changed' && /paid in Zoho/.test(l.error)));
    assert.equal((await call('GET', 'zoho/report?date=' + D)).j.totals.errors, 1);

    // ---- drafts are updated in place (auto-send off); paying a draft bill opens it first
    assert.equal((await call('PUT', 'zoho/config', { post: '0' })).s, 200);
    const b3 = (await call('POST', 'bills', { date: D, party_id: supplier, description: 'Cement', amount: 300, vat_amount: 15, reference: 'SUP-78' })).j;
    await call('POST', 'zoho/sync', {}); const zb3 = zoho.T.bills.find(b => b.bill_number === 'SUP-78'); assert.equal(zb3.status, 'draft');
    assert.equal((await call('PUT', 'bills/' + b3.id, { date: D, party_id: supplier, description: 'Cement', amount: 400, vat_amount: 20, reference: 'SUP-78' })).s, 200);
    const s4 = (await call('POST', 'zoho/sync', {})).j; assert.equal(s4.updated, 1); assert.equal(zb3.line_items[0].rate, 400); assert.equal(zoho.T.bills.filter(b => b.bill_number === 'SUP-78').length, 1);
    assert.equal((await call('POST', 'payments', { kind: 'out', date: D, amount: 420, method: 'bank', bill_id: b3.id })).s, 200);
    const s5 = (await call('POST', 'zoho/sync', {})).j; assert.equal(s5.failed, 0, JSON.stringify(s5)); assert.equal(zb3.status, 'paid');

    // ---- voiding an invoice voids it in Zoho; credit notes keep our number and point at the invoice
    const inv2 = (await call('POST', 'invoices', { project_id: proj, date: D, items: [{ description: 'Extra', qty: 1, rate: 100 }] })).j; inv2.number = (await call('GET', 'invoices/' + inv2.id)).j.number;
    await call('POST', 'zoho/sync', {}); assert.equal(zoho.T.invoices.find(i => i.invoice_number === inv2.number).status, 'draft');
    assert.equal((await call('POST', `invoices/${inv2.id}/void`, { reason: 'duplicate' })).s, 200);
    await call('POST', 'zoho/sync', {}); assert.equal(zoho.T.invoices.find(i => i.invoice_number === inv2.number).status, 'void');
    const cn = await call('POST', `invoices/${inv.id}/credit-note`, { items: [{ description: 'Excavation adjustment', qty: 1, rate: 100 }], reason: 'adjustment' }); assert.equal(cn.s, 200, JSON.stringify(cn.j));
    const s6 = (await call('POST', 'zoho/sync', {})).j; assert.equal(s6.failed, 0, JSON.stringify(s6));
    const zc = zoho.T.creditnotes[0]; assert.match(zc.creditnote_number, /CN/); assert.equal(zc.reference_number, inv.number); assert.equal(zc.total, 105); assert.equal(zc.customer_id, emaar.contact_id);
    assert.match((await call('GET', 'zoho/export?kind=creditnotes')).j, new RegExp(`${zc.creditnote_number},.*Emaar Test,SH,${inv.number}`));

    // ---- records dated before the start date are not sent
    await call('POST', 'bills', { date: '2026-09-15', party_id: supplier, description: 'Old', amount: 10, vat_amount: 0, reference: 'OLD-1' });
    await call('POST', 'zoho/sync', {}); assert.ok(!zoho.T.bills.find(b => b.bill_number === 'OLD-1'));

    // ---- roles: viewer/manager cannot see the bridge; accountant can sync but not change the connection
    for (const [u, role] of [['viewer1', 'viewer'], ['acc1', 'accountant']]) assert.equal((await call('POST', 'users', { username: u, password: 'pass1234', role })).s, 200);
    const admin = cookie;
    cookie = ''; await call('POST', 'login', { username: 'viewer1', password: 'pass1234' }); assert.equal((await call('GET', 'zoho')).s, 403); assert.equal((await call('GET', 'zoho/export?kind=customers')).s, 403);
    cookie = ''; await call('POST', 'login', { username: 'acc1', password: 'pass1234' }); assert.equal((await call('GET', 'zoho')).s, 200);
    assert.equal((await call('PUT', 'zoho/config', { client_id: 'evil' })).s, 403); assert.equal((await call('POST', 'zoho/connect', { code: 'x' })).s, 403); assert.equal((await call('POST', 'zoho/disconnect')).s, 403);
    assert.equal((await call('POST', 'zoho/sync', {})).s, 200);
    cookie = admin;

    // ---- disconnect revokes the refresh token and switches the link off
    const dc = (await call('POST', 'zoho/disconnect')).j; assert.equal(dc.connected, ''); assert.equal(dc.enabled, '0');
    assert.equal((await call('POST', 'zoho/test')).s, 400);
    console.log('✔ Zoho Books: Self Client sign-in, secrets kept on the server, contacts, invoices, credit notes, bills, expenses, payments applied to their documents,');
    console.log('  idempotent re-sync, token renewal, paid-edit detection, draft update, void, start date, CSV import files, roles, disconnect');
    console.log('ZOHO TESTS PASSED');
  } catch (e) { console.error('FAIL', e); process.exitCode = 1; }
  finally { zoho.srv.close(); server.close(); setTimeout(() => process.exit(process.exitCode || 0), 100); }
});
