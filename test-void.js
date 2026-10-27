// Voiding a tax invoice is for the administrator only; an accountant corrects with a credit note: node --no-warnings test-void.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-void-'));
process.env.ZOHO_NO_SCHEDULER = '1'; process.env.SALES_NO_SCHEDULER = '1';
const { server } = require('./server.js');

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api/`; let cookie = '';
  const call = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j }; };
  try {
    await call('POST', 'setup', { username: 'admin', password: 'secret12', company: 'Trigon' });
    await call('PUT', 'settings', { trn: '100123456700003' });
    const cl = (await call('POST', 'parties', { type: 'client', name: 'Client', trn: '100234567800003', address: 'Dubai' })).j.id;
    const p = (await call('POST', 'projects', { name: 'P', client_id: cl })).j.id;
    const i1 = (await call('POST', 'invoices', { project_id: p, items: [{ description: 'Works', qty: 1, rate: 1000 }] })).j.id;
    const i2 = (await call('POST', 'invoices', { project_id: p, items: [{ description: 'Works', qty: 1, rate: 500 }] })).j.id;
    assert.equal((await call('POST', 'users', { username: 'acc1', password: 'pass1234', role: 'accountant' })).s, 200);
    const admin = cookie; cookie = ''; await call('POST', 'login', { username: 'acc1', password: 'pass1234' });
    const v = await call('POST', `invoices/${i1}/void`, { reason: 'mistake' }); assert.equal(v.s, 403, 'accountant cannot void');
    assert.equal((await call('GET', 'invoices/' + i1)).j.voided, 0);
    const cn = await call('POST', `invoices/${i1}/credit-note`, { reason: 'correction' }); assert.equal(cn.s, 200, 'accountant issues a credit note');
    assert.equal((await call('DELETE', 'invoices/' + i1)).s, 409);
    cookie = admin;
    assert.equal((await call('POST', `invoices/${i2}/void`, { reason: 'duplicate' })).s, 200, 'administrator can void');
    assert.equal((await call('GET', 'invoices/' + i2)).j.status, 'void');
    console.log('✔ void = administrator only (accountant 403, credit note 200, delete 409; admin void 200)');
    console.log('VOID TESTS PASSED');
  } catch (e) { console.error('FAIL', e); process.exitCode = 1; }
  finally { server.close(); setTimeout(() => process.exit(process.exitCode || 0), 100); }
});
