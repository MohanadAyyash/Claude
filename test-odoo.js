// Odoo bridge test against an in-process mock Odoo (JSON-RPC for v18, JSON-2 for v20): node --no-warnings test-odoo.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-odoo-'));
process.env.ODOO_NO_SCHEDULER = '1';
const { server } = require('./server.js');

const mockOdoo = require('./tools/odoo-mock.js');

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api/`;
  let cookie = '';
  const call = async (m, u, b) => {
    const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie }, body: b ? JSON.stringify(b) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch { j = text; }
    return { s: r.status, j };
  };
  const odoo = mockOdoo(18); await new Promise(ok => odoo.srv.listen(0, ok));
  const odooUrl = `http://127.0.0.1:${odoo.srv.address().port}`;
  try {
    assert.equal((await call('POST', 'setup', { username: 'admin', password: 'secret12', company: 'Trigon' })).s, 200);
    assert.equal((await call('PUT', 'settings', { trn: '100123456700003' })).s, 200);
    const client = (await call('POST', 'parties', { type: 'client', name: 'Emaar Test', trn: '100000000000003', email: 'ap@emaar.test' })).j.id;
    const supplier = (await call('POST', 'parties', { type: 'supplier', name: 'Steel Supplier LLC' })).j.id;
    const proj = (await call('POST', 'projects', { name: 'Villa 12', client_id: client, retention_pct: 10 })).j.id;
    const D = '2026-10-20';
    const inv = (await call('POST', 'invoices', { project_id: proj, date: D, retention_pct: 10, items: [{ description: 'Excavation', qty: 100, rate: 50 }, { description: 'Backfill', qty: 10, rate: 20 }] })).j;
    inv.number = (await call('GET', 'invoices/' + inv.id)).j.number;
    const bill = (await call('POST', 'bills', { date: D, party_id: supplier, project_id: proj, category: 'materials', description: 'Rebar', amount: 1000, vat_amount: 50, reference: 'SUP-77' })).j;
    const bill2 = (await call('POST', 'bills', { date: D, category: 'transport', description: 'Taxi', amount: 40, vat_amount: 0 })).j;
    assert.equal((await call('POST', 'payments', { kind: 'in', date: D, amount: 2000, method: 'bank', reference: 'TT-1', invoice_id: inv.id })).s, 200);
    assert.equal((await call('POST', 'payments', { kind: 'out', date: D, amount: 1050, method: 'cash', bill_id: bill.id })).s, 200);
    assert.equal((await call('POST', 'payments', { kind: 'out', date: D, amount: 99, method: 'bank', reference: 'misc' })).s, 200);     // not linked → skipped

    // ---- daily report and CSV import files work before any Odoo account exists
    const rep = (await call('GET', 'odoo/report?date=' + D)).j;
    assert.equal(rep.rows.length, 6); assert.equal(rep.totals.invoiced, 5460); assert.equal(rep.totals.output_vat, 260); assert.equal(rep.totals.bills, 1090); assert.equal(rep.totals.received, 2000); assert.equal(rep.totals.pending, 6);
    const csvInv = (await call('GET', `odoo/export?kind=invoices&from=${D}&to=${D}`)).j;
    assert.match(csvInv, /^\ufeff?id,move_type,partner_id,invoice_date/); assert.match(csvInv, /trigon_invoice_\d+,out_invoice,Emaar Test,2026-10-20/); assert.match(csvInv, /\n,,,,,,,Backfill,10,20,VAT 5%/);
    assert.match((await call('GET', 'odoo/export?kind=partners')).j, /trigon_partner_\d+,Emaar Test,True,100000000000003/);
    assert.match((await call('GET', `odoo/export?kind=payments&from=${D}`)).j, /inbound,customer,Emaar Test,2000,2026-10-20/);
    assert.equal((await call('GET', 'odoo/export?kind=nope')).s, 400);

    // ---- configuration: key never comes back; validation; roles
    assert.equal((await call('POST', 'odoo/sync', {})).s, 400);                          // switched off
    assert.equal((await call('PUT', 'odoo/config', { url: 'ftp://x' })).s, 400);
    assert.equal((await call('PUT', 'odoo/config', { url: odooUrl + '/', db: odoo.DB, login: odoo.LOGIN, key: 'wrong-key', enabled: '1', start: '2026-10-01', post: '1' })).s, 200);
    const st = (await call('GET', 'odoo')).j; assert.equal(st.config.key, undefined); assert.equal(st.config.key_set, '1'); assert.equal(st.config.url, odooUrl);
    assert.ok(!JSON.stringify((await call('GET', 'settings')).j).includes('wrong-key'));
    const t0 = await call('POST', 'odoo/test'); assert.equal(t0.s, 400); assert.match(t0.j.error, /rejected/);
    assert.equal((await call('PUT', 'odoo/config', { key: odoo.KEY })).s, 200);
    const t1 = (await call('POST', 'odoo/test')).j; assert.equal(t1.ok, true); assert.equal(t1.api, 'jsonrpc'); assert.equal(t1.major, 18); assert.deepEqual(t1.missing, []);

    // ---- first sync: contacts, invoice, bills, payments
    const s1 = (await call('POST', 'odoo/sync', {})).j;
    assert.equal(s1.failed, 0, JSON.stringify(s1)); assert.equal(s1.skipped, 1);
    const partners = odoo.T['res.partner'];
    assert.ok(partners.find(p => p.name === 'Emaar Test' && p.vat === '100000000000003' && p.ref === `TRG-P${client}`));
    assert.ok(partners.find(p => p.ref === 'TRG-MISC'), 'misc supplier for the bill without a supplier');
    const mv = odoo.T['account.move'], oi = mv.find(m => m.move_type === 'out_invoice');
    assert.equal(oi.ref, inv.number); assert.equal(oi.state, 'posted'); assert.equal(oi.journal_id, 1); assert.equal(oi.lines.length, 2);
    assert.deepEqual(oi.lines[0].tax_ids, [[6, 0, [1]]]); assert.match(oi.narration, /Retention 10% = 520\.00 AED/);
    const ob = mv.find(m => m.move_type === 'in_invoice' && m.ref === 'SUP-77'); assert.deepEqual(ob.lines[0].tax_ids, [[6, 0, [2]]]); assert.equal(ob.lines[0].price_unit, 1000);
    assert.deepEqual(mv.find(m => m.ref === `TRG-B${bill2.id}`).lines[0].tax_ids, [[6, 0, []]]);
    const pays = odoo.T['account.payment']; assert.equal(pays.length, 2);
    const pin = pays.find(p => p.payment_type === 'inbound'); assert.equal(pin.amount, 2000); assert.equal(pin.journal_id, 3); assert.match(pin.memo, /TT-1/); assert.equal(pin.state, 'posted');
    assert.equal(pays.find(p => p.payment_type === 'outbound').journal_id, 4);           // cash → cash journal

    // ---- second sync sends nothing again (idempotent)
    const before = odoo.calls.filter(c => c.endsWith('.create')).length;
    const s2 = (await call('POST', 'odoo/sync', {})).j; assert.equal(s2.sent, 0); assert.equal(s2.failed, 0);
    assert.equal(odoo.calls.filter(c => c.endsWith('.create')).length, before);

    // ---- editing a posted invoice is flagged, not silently overwritten; contact edits update the contact
    assert.equal((await call('PUT', 'parties/' + client, { type: 'client', name: 'Emaar Test', trn: '100000000000003', email: 'new@emaar.test' })).s, 200);
    assert.equal((await call('PUT', 'invoices/' + inv.id, { project_id: proj, date: D, items: [{ description: 'Excavation', qty: 120, rate: 50 }] })).s, 200);
    const s3 = (await call('POST', 'odoo/sync', {})).j; assert.equal(s3.failed, 1); assert.ok(s3.updated >= 1);
    assert.equal(partners.find(p => p.ref === `TRG-P${client}`).email, 'new@emaar.test');
    assert.ok((await call('GET', 'odoo/log')).j.find(l => l.kind === 'invoice' && l.status === 'changed'));
    assert.equal((await call('GET', 'odoo/report?date=' + D)).j.totals.errors, 1);

    // ---- draft moves are updated in place (auto-post off)
    assert.equal((await call('PUT', 'odoo/config', { post: '0' })).s, 200);
    const b3 = (await call('POST', 'bills', { date: D, party_id: supplier, description: 'Cement', amount: 300, vat_amount: 15, reference: 'SUP-78' })).j;
    await call('POST', 'odoo/sync', {}); const ob3 = mv.find(m => m.ref === 'SUP-78'); assert.equal(ob3.state, 'draft');
    assert.equal((await call('PUT', 'bills/' + b3.id, { date: D, party_id: supplier, description: 'Cement', amount: 400, vat_amount: 20, reference: 'SUP-78' })).s, 200);
    const s4 = (await call('POST', 'odoo/sync', {})).j; assert.equal(s4.updated, 1); assert.equal(ob3.lines[0].price_unit, 400); assert.equal(mv.filter(m => m.ref === 'SUP-78').length, 1);

    // ---- voiding an invoice cancels it in Odoo
    const inv2 = (await call('POST', 'invoices', { project_id: proj, date: D, items: [{ description: 'Extra', qty: 1, rate: 100 }] })).j; inv2.number = (await call('GET', 'invoices/' + inv2.id)).j.number;
    await call('POST', 'odoo/sync', {}); assert.equal(mv.find(m => m.ref === inv2.number).state, 'draft');
    assert.equal((await call('POST', `invoices/${inv2.id}/void`, { reason: 'duplicate' })).s, 200);
    await call('POST', 'odoo/sync', {}); assert.equal(mv.find(m => m.ref === inv2.number).state, 'cancel');

    // ---- records dated before the start date are not sent
    await call('POST', 'bills', { date: '2026-09-15', party_id: supplier, description: 'Old', amount: 10, vat_amount: 0, reference: 'OLD-1' });
    await call('POST', 'odoo/sync', {}); assert.ok(!mv.find(m => m.ref === 'OLD-1'));

    // ---- roles: viewer/manager cannot see the bridge; accountant can sync but not change the connection
    for (const [u, role] of [['viewer1', 'viewer'], ['acc1', 'accountant']]) assert.equal((await call('POST', 'users', { username: u, password: 'pass1234', role })).s, 200);
    const admin = cookie;
    cookie = ''; await call('POST', 'login', { username: 'viewer1', password: 'pass1234' }); assert.equal((await call('GET', 'odoo')).s, 403); assert.equal((await call('GET', 'odoo/export?kind=partners')).s, 403);
    cookie = ''; await call('POST', 'login', { username: 'acc1', password: 'pass1234' }); assert.equal((await call('GET', 'odoo')).s, 200);
    assert.equal((await call('PUT', 'odoo/config', { url: 'https://evil.example' })).s, 403); assert.equal((await call('POST', 'odoo/sync', {})).s, 200);
    cookie = admin;
    console.log('✔ Odoo 18 (JSON-RPC): contacts, invoices, bills, payments, idempotent re-sync, edit detection, draft update, void → cancel, start date, roles');

    // ---- Odoo 20 (JSON-2 API, bearer key)
    const o20 = mockOdoo(20); await new Promise(ok => o20.srv.listen(0, ok));
    await call('PUT', 'odoo/config', { url: `http://127.0.0.1:${o20.srv.address().port}`, key: o20.KEY, post: '1' });
    await call('POST', 'odoo/retry');
    const t20 = (await call('POST', 'odoo/test')).j; assert.equal(t20.api, 'json2'); assert.equal(t20.major, 20);
    // a new database: forget the old links so everything is sent again
    const { DatabaseSync } = require('node:sqlite'); const raw = new DatabaseSync(path.join(process.env.DATA_DIR, 'erp.db')); raw.exec('DELETE FROM odoo_sync'); raw.close();
    const s20 = (await call('POST', 'odoo/sync', {})).j; assert.equal(s20.failed, 0, JSON.stringify(s20));
    assert.ok(o20.T['account.move'].find(m => m.ref === inv.number && m.state === 'posted')); assert.ok(o20.T['account.payment'].length >= 2);
    console.log('✔ Odoo 20 (JSON-2 API with bearer key)');
    o20.srv.close();
    console.log('ODOO TESTS PASSED');
  } catch (e) { console.error('FAIL', e); process.exitCode = 1; }
  finally { odoo.srv.close(); server.close(); setTimeout(() => process.exit(process.exitCode || 0), 100); }
});
