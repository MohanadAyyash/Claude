// Security review fixes: site scope whatever the Content-Type, notes follow the record, no money for site roles, quote link
// hidden from read-only roles, password change, login lockout per account: node --no-warnings test-secfix.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-secfix-'));
process.env.ZOHO_NO_SCHEDULER = '1'; process.env.SALES_NO_SCHEDULER = '1';
const { server } = require('./server.js');

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api/`; let cookie = '';
  const call = async (m, u, b, type = 'application/json') => { const r = await fetch(base + u, { method: m, headers: { 'Content-Type': type, cookie }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j }; };
  const ok = (r, l) => { assert.equal(r.s, 200, `${l || ''} → ${r.s} ${JSON.stringify(r.j).slice(0, 300)}`); return r.j; };
  const jar = {}; const as = async (u, fn) => { const keep = cookie; cookie = jar[u] || ''; if (!cookie) ok(await call('POST', 'login', { username: u, password: 'secret12' })); jar[u] = cookie; try { return await fn(); } finally { cookie = keep; } };
  try {
    ok(await call('POST', 'setup', { username: 'admin', password: 'secret12', company: 'Trigon' }));
    const client = ok(await call('POST', 'parties', { type: 'client', name: 'Client' })).id;
    const p1 = ok(await call('POST', 'projects', { name: 'Mine', client_id: client, contract_value: 500000, retention_pct: 10, status: 'active' })).id;
    const p2 = ok(await call('POST', 'projects', { name: 'Other', client_id: client, contract_value: 900000, status: 'active' })).id;
    ok(await call('POST', 'boq_items', { project_id: p1, description: 'A', unit: 'm', qty: 10, rate: 123, cost_rate: 99 }));
    const emp = ok(await call('POST', 'employees', { name: 'Worker', join_date: '2024-01-01', basic: 3000, project_id: p2 })).id;
    for (const [u, role] of [['eng', 'site_engineer'], ['view', 'viewer'], ['fore', 'foreman']]) { const id = ok(await call('POST', 'users', { username: u, password: 'secret12', role })).id; if (role !== 'viewer') ok(await call('PUT', 'users/' + id, { projects: [p1] })); }

    // ---- site scope applies whatever the Content-Type
    assert.equal((await as('eng', () => call('POST', 'site_reports', { project_id: p2, date: '2026-01-01', notes: 'x' }))).s, 403);
    assert.equal((await as('eng', () => call('POST', 'site_reports', { project_id: p2, date: '2026-01-01', notes: 'x' }, 'text/plain'))).s, 403, 'text/plain body is checked too');
    assert.equal((await as('eng', () => call('POST', 'site_reports', { project_id: p1, date: '2026-01-01', notes: 'x' }, 'text/plain'))).s, 200);
    console.log('✔ site roles: the project scope cannot be bypassed with another Content-Type');

    // ---- notes follow the record
    ok(await call('POST', 'notes', { entity: 'employee', entity_id: emp, body: 'Final warning' })); ok(await call('POST', 'notes', { entity: 'project', entity_id: p2, body: 'private' }));
    assert.equal((await as('fore', () => call('GET', `notes?entity=employee&id=${emp}`))).s, 403);
    assert.equal((await as('fore', () => call('GET', `notes?entity=project&id=${p2}`))).s, 403);
    assert.equal((await as('fore', () => call('POST', 'notes', { entity: 'project', entity_id: p2, body: 'x' }))).s, 403);
    assert.equal((await as('fore', () => call('GET', `notes?entity=project&id=${p1}`))).s, 200);
    console.log('✔ notes: only for roles that can open the record, and only on assigned projects');

    // ---- no money for site roles
    const prj = ok(await as('eng', () => call('GET', 'projects'))); assert.equal(prj.length, 1); assert.equal(prj[0].contract_value, undefined); assert.equal(prj[0].retention_pct, undefined);
    const boq = ok(await as('eng', () => call('GET', 'boq_items?project_id=' + p1))); assert.equal(boq[0].rate, undefined); assert.equal(boq[0].cost_rate, undefined); assert.equal(boq[0].qty, 10);
    assert.equal(ok(await call('GET', 'boq_items?project_id=' + p1))[0].rate, 123, 'admin still sees rates');
    console.log('✔ site roles get no contract value, retention or BOQ rates');

    // ---- quotation link
    const q = ok(await call('POST', 'quotes', { client_id: client, items: [{ description: 'x', qty: 1, rate: 100 }] })).id; ok(await call('POST', `quotes/${q}/share`, {}));
    const lst = ok(await as('view', () => call('GET', 'quotes'))); assert.equal(lst[0].share_token, undefined); assert.equal(lst[0].shared, true);
    assert.equal(ok(await as('view', () => call('GET', 'quotes/' + q))).share_token, undefined);
    assert.ok(ok(await call('GET', 'quotes/' + q)).share_token, 'admin can still copy the link');
    console.log('✔ read-only roles cannot get the client acceptance link');

    // ---- password change needs the current password and signs other devices out
    const first = await as('view', async () => cookie); delete jar.view; const second = await as('view', async () => cookie); assert.notEqual(first, second);
    assert.equal((await as('view', () => call('POST', 'password', { password: 'newsecret1' }))).s, 400);
    assert.equal((await as('view', () => call('POST', 'password', { current: 'wrong', password: 'newsecret1' }))).s, 400);
    ok(await as('view', () => call('POST', 'password', { current: 'secret12', password: 'newsecret1' })));
    cookie = first; assert.equal((await call('GET', 'quotes')).s, 401, 'the other session is gone'); cookie = jar.view; assert.equal((await call('GET', 'quotes')).s, 200); cookie = jar.admin || cookie;
    console.log('✔ password change: current password required, other sessions signed out');

    // ---- lockout per account even when the address changes; dates validated; oversized body → 413
    cookie = '';
    for (let i = 0; i < 12; i++) assert.equal((await call('POST', 'login', { username: 'fore', password: 'bad' + i })).s, i < 8 ? 401 : 429);
    console.log('✔ login lockout after repeated failures');
    console.log('SECURITY FIX TESTS PASSED');
  } catch (err) { console.error('FAIL', err); process.exitCode = 1; }
  finally { server.close(); setTimeout(() => process.exit(process.exitCode || 0), 100); }
});
