// Project control & teamwork: budget vs actual vs committed with forecast, weekly updates, tasks with assignees and
// notifications, notes with @mentions, permissions: node --no-warnings test-collab.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-collab-'));
const { server } = require('./server.js');

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api/`; const jar = {}; let who = 'admin';
  const call = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie: jar[who] || '' }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) jar[who] = sc.split(';')[0]; const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j }; };
  const as = async (u, fn) => { const p = who; who = u; try { return await fn(); } finally { who = p; } };
  const ok = (r, m = '') => { assert.equal(r.s, 200, m + ' ' + JSON.stringify(r.j)); return r.j; };
  try {
    ok(await call('POST', 'setup', { username: 'admin', password: 'secret12', company: 'Trigon' }));
    for (const [u, role] of [['pm1', 'manager'], ['acc1', 'accountant'], ['view1', 'viewer']]) ok(await call('POST', 'users', { username: u, password: 'pass1234', role }));
    const emp = ok(await call('POST', 'employees', { name: 'Imran', join_date: '2025-01-01', basic: 3000 })).id;
    ok(await call('POST', 'users', { username: 'imran', password: 'pass1234', role: 'employee', employee_id: emp }));
    for (const u of ['pm1', 'acc1', 'view1', 'imran']) await as(u, () => call('POST', 'login', { username: u, password: 'pass1234' }));
    const ids = Object.fromEntries(ok(await call('GET', 'users')).map(u => [u.username, u.id]));
    const sup = ok(await call('POST', 'parties', { type: 'supplier', name: 'Steel LLC' })).id, sub = ok(await call('POST', 'parties', { type: 'subcontractor', name: 'Kerb Co' })).id;
    const p = ok(await call('POST', 'projects', { name: 'Internal Roads', contract_value: 1000000, status: 'active' })).id;
    const bq = ok(await call('POST', 'boq_items', { project_id: p, description: 'Asphalt', qty: 100, rate: 10000, cost_rate: 8000 })).id;

    // ---- budget vs actual vs committed, forecast
    assert.equal((await as('view1', () => call('PUT', `projects/${p}/budget`, { lines: { materials: 1 } }))).s, 403);
    assert.equal((await call('PUT', `projects/${p}/budget`, { lines: { cement: 5 } })).s, 400);
    ok(await call('PUT', `projects/${p}/budget`, { lines: { materials: 400000, labour: 200000, subcontract: 150000, equipment: 50000 } }));
    ok(await call('POST', 'bills', { date: '2026-09-01', party_id: sup, project_id: p, category: 'materials', description: 'Asphalt mix', amount: 120000, vat_amount: 6000 }));
    ok(await call('POST', 'bills', { date: '2026-09-02', project_id: p, category: 'labour', description: 'Crew', amount: 30000, vat_amount: 0 }));
    ok(await call('POST', 'purchase_orders', { date: '2026-09-05', party_id: sup, project_id: p, status: 'sent', items: [{ description: 'Kerbs', qty: 1000, rate: 50 }] }));
    ok(await call('POST', 'purchase_orders', { date: '2026-09-05', party_id: sup, project_id: p, status: 'draft', items: [{ description: 'Not ordered', qty: 1, rate: 99999 }] }));
    ok(await call('POST', 'subcontracts', { project_id: p, party_id: sub, description: 'Kerb laying', contract_value: 90000, status: 'active' }));
    ok(await call('PUT', 'boq_items/' + bq, { done_pct: 25 }));
    let b = ok(await call('GET', `projects/${p}/budget`)), L = Object.fromEntries(b.lines.map(l => [l.category, l]));
    assert.equal(L.materials.actual, 120000); assert.equal(L.materials.committed, 50000); assert.equal(L.materials.remaining, 230000); assert.equal(L.materials.used_pct, 42.5);
    assert.equal(L.labour.actual, 30000); assert.equal(L.subcontract.committed, 90000);
    assert.equal(b.totals.budget, 800000); assert.equal(b.totals.actual, 150000); assert.equal(b.totals.committed, 140000);
    assert.equal(b.progress, 25); assert.equal(b.forecast.cost_at_completion, 750000, '150,000 spent + 75% of the 800,000 budget still to do'); assert.equal(b.forecast.margin, 250000); assert.equal(b.forecast.over_budget, false);

    // ---- weekly updates with a snapshot; at-risk tells the admin
    assert.equal((await call('POST', `projects/${p}/updates`, { status: 'great', progress: 10 })).s, 400);
    ok(await as('pm1', () => call('POST', `projects/${p}/updates`, { status: 'at_risk', progress: 25, summary: 'Asphalt plant delay', date: '2026-10-21' })));
    const ups = ok(await call('GET', `projects/${p}/updates`)); assert.equal(ups[0].status, 'at_risk'); assert.equal(ups[0].author, 'pm1'); assert.equal(ups[0].snapshot.actual, 150000);
    assert.ok(ok(await call('GET', 'notifications')).items.some(n => /at risk/.test(n.title) && /plant delay/.test(n.body)));
    assert.equal((await as('view1', () => call('POST', `projects/${p}/updates`, { status: 'on_track', progress: 1 }))).s, 403);

    // ---- tasks: assignee notified, sub-tasks, assignee may only change the status, creator told when done
    assert.equal((await call('POST', 'tasks', { title: '' })).s, 400);
    const t1 = ok(await as('pm1', () => call('POST', 'tasks', { project_id: p, title: 'Authority NOCs (RTA, DEWA)', tag: 'authorities', due_date: '2026-10-01', assignee_user_id: ids.acc1 })));
    assert.equal(t1.overdue, true);
    assert.ok(ok(await as('acc1', () => call('GET', 'notifications'))).items.some(n => /New task/.test(n.title) && /Authority NOCs/.test(n.body)));
    ok(await as('pm1', () => call('POST', 'tasks', { parent_id: t1.id, title: 'DEWA NOC', assignee_user_id: ids.acc1 })));
    assert.equal(ok(await call('GET', 'tasks/' + t1.id)).subtasks.length, 1);
    assert.equal(ok(await call('GET', `tasks?project_id=${p}`)).length, 1, 'sub-tasks are listed under their parent');
    assert.equal(ok(await as('acc1', () => call('GET', 'tasks?mine=1'))).length, 1);
    assert.equal((await as('acc1', () => call('PUT', 'tasks/' + t1.id, { title: 'renamed' }))).j.title, 'renamed', 'accountants may edit tasks');
    const t2 = ok(await as('pm1', () => call('POST', 'tasks', { title: 'Site toolbox talk', tag: 'hse', assignee_user_id: ids.imran })));
    assert.equal((await as('imran', () => call('PUT', 'tasks/' + t2.id, { title: 'x' }))).s, 403, 'an assignee changes only the status');
    ok(await as('imran', () => call('PUT', 'tasks/' + t2.id, { status: 'done' })));
    assert.ok(ok(await as('pm1', () => call('GET', 'notifications'))).items.some(n => /Task done/.test(n.title)));
    assert.equal(ok(await as('imran', () => call('GET', 'tasks'))).length, 1, 'portal users see only their tasks');
    assert.equal((await as('imran', () => call('GET', 'tasks/' + t1.id))).s, 404);
    assert.equal((await as('imran', () => call('POST', 'tasks', { title: 'x' }))).s, 403);
    assert.equal((await as('view1', () => call('DELETE', 'tasks/' + t1.id))).s, 403);
    ok(await as('pm1', () => call('DELETE', 'tasks/' + t1.id))); assert.equal(ok(await call('GET', `tasks?project_id=${p}`)).length, 0);

    // ---- notes with @mentions
    const n1 = ok(await as('pm1', () => call('POST', 'notes', { entity: 'project', entity_id: p, body: 'Need 5 electricians and 20 labourers — @acc1 please raise the PO, @nobody' })));
    assert.deepEqual(n1.mentioned, ['acc1']);
    assert.ok(ok(await as('acc1', () => call('GET', 'notifications'))).items.some(n => /mentioned you/.test(n.title) && n.url === `#projects/${p}`));
    assert.equal(ok(await call('GET', `notes?entity=project&id=${p}`))[0].username, 'pm1');
    assert.equal((await call('POST', 'notes', { entity: 'nuclear', entity_id: 1, body: 'x' })).s, 400);
    assert.equal((await as('imran', () => call('GET', `notes?entity=project&id=${p}`))).s, 403);
    assert.equal((await as('acc1', () => call('DELETE', 'notes/' + n1.id))).s, 403); ok(await as('pm1', () => call('DELETE', 'notes/' + n1.id)));
    console.log('✔ budget vs actual vs committed + forecast at completion, weekly updates with snapshot + alert, tasks (assign, sub-tasks, status-only for assignees, done notice), notes with @mentions, roles');
    console.log('COLLAB TESTS PASSED');
  } catch (e) { console.error('FAIL', e); process.exitCode = 1; }
  finally { server.close(); setTimeout(() => process.exit(process.exitCode || 0), 100); }
});
