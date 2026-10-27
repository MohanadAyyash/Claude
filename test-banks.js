// Several bank accounts: own ledger account, payments and statements per account: node --no-warnings test-banks.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-banks-'));
process.env.ZOHO_NO_SCHEDULER = '1'; process.env.SALES_NO_SCHEDULER = '1';
const { server } = require('./server.js');

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api/`; let cookie = '';
  const call = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j }; };
  const ok = (r, l) => { assert.equal(r.s, 200, `${l || ''} → ${r.s} ${JSON.stringify(r.j).slice(0, 200)}`); return r.j; };
  try {
    ok(await call('POST', 'setup', { username: 'admin', password: 'secret12', company: 'Trigon' }));
    ok(await call('PUT', 'settings', { trn: '100123456700003' }));
    const accs = ok(await call('GET', 'bank_accounts')); assert.equal(accs.length, 1); assert.equal(accs[0].ledger_code, '1000');
    assert.equal((await call('POST', 'bank_accounts', { name: 'EI', iban: 'AE000000000000000000000' })).s, 400, 'bad IBAN');
    const ei = ok(await call('POST', 'bank_accounts', { name: 'Emirates Islamic — current', bank: 'Emirates Islamic', iban: 'AE070331234567890123456' }));
    assert.equal(ei.ledger_code, '1001');
    const cl = ok(await call('POST', 'parties', { type: 'client', name: 'Client', trn: '100234567800003', address: 'Dubai' })).id;
    const p = ok(await call('POST', 'projects', { name: 'P', client_id: cl })).id;
    const inv = ok(await call('POST', 'invoices', { project_id: p, date: '2026-10-01', items: [{ description: 'x', qty: 1, rate: 1000 }] })).id;
    ok(await call('POST', 'payments', { kind: 'in', date: '2026-10-02', amount: 600, method: 'bank', invoice_id: inv }));                       // main account
    ok(await call('POST', 'payments', { kind: 'in', date: '2026-10-03', amount: 450, method: 'bank', invoice_id: inv, bank_account_id: ei.id }));
    const bal = async code => { const l = ok(await call('GET', 'ledger?account=' + code)).lines; return l.length ? l.at(-1).balance : 0; };
    assert.equal(await bal('1000'), 600); assert.equal(await bal('1001'), 450);
    // statements per account
    ok(await call('POST', `bank/import?account=${ei.id}`, { csv: '2026-10-03,TRANSFER CLIENT,450.00' }));
    ok(await call('POST', 'bank/import', { csv: '2026-10-02,TRANSFER CLIENT,600.00' }));
    const r1 = ok(await call('POST', `bank/auto-match?account=${ei.id}`)); assert.equal(r1.matched, 1);
    const v1 = ok(await call('GET', `bank?account=${ei.id}`)); assert.equal(v1.lines.length, 1); assert.equal(v1.summary.book_balance, 450); assert.equal(v1.summary.statement_balance, 450); assert.equal(v1.unmatched_payments.length, 0);
    const v0 = ok(await call('GET', 'bank')); assert.equal(v0.lines.length, 1); assert.equal(v0.summary.book_balance, 600); assert.equal(v0.unmatched_payments.length, 1, 'the 600 receipt is still open on the main account');
    const fin = ok(await call('GET', 'financials?from=2026-01-01&to=2026-12-31')); assert.equal(fin.tb_debit, fin.tb_credit);
    console.log('✔ bank accounts: 1000 + 1001, receipts posted to their own account, statements imported and matched per account, trial balance balanced');
    console.log('BANK ACCOUNT TESTS PASSED');
  } catch (e) { console.error('FAIL', e); process.exitCode = 1; }
  finally { server.close(); setTimeout(() => process.exit(process.exitCode || 0), 100); }
});
