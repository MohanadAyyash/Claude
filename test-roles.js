// Contracting roles: what each role may and may not do on the server: node --no-warnings test-roles.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-roles-'));
process.env.ZOHO_NO_SCHEDULER = '1'; process.env.SALES_NO_SCHEDULER = '1';
const { server } = require('./server.js');

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api/`; const jar = {}; let who = 'admin';
  const call = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie: jar[who] || '' }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) jar[who] = sc.split(';')[0]; const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j }; };
  const as = async (u, fn) => { const p = who; who = u; try { return await fn(); } finally { who = p; } };
  const expect = async (u, m, path_, body, status, label) => { const r = await as(u, () => call(m, path_, body)); assert.equal(r.s, status, `${u} ${m} ${path_} (${label || ''}) → ${r.s} ${JSON.stringify(r.j).slice(0, 120)}`); return r.j; };
  try {
    await call('POST', 'setup', { username: 'admin', password: 'secret12', company: 'Trigon' });
    await call('PUT', 'settings', { trn: '100123456700003' });
    const roles = ['site_engineer', 'foreman', 'qs', 'procurement', 'storekeeper'];
    const uname = r => r === 'qs' ? 'qs1' : r.replace('_', '');
    for (const r of roles) { assert.equal((await call('POST', 'users', { username: uname(r), password: 'pass1234', role: r })).s, 200, r); await as(uname(r), () => call('POST', 'login', { username: uname(r), password: 'pass1234' })); }
    const cl = (await call('POST', 'parties', { type: 'client', name: 'Client', trn: '100234567800003', address: 'Dubai' })).j.id;
    const sup = (await call('POST', 'parties', { type: 'supplier', name: 'Supplier' })).j.id;
    const p = (await call('POST', 'projects', { name: 'Roads', client_id: cl, contract_value: 100000, status: 'active' })).j.id;
    const bq = (await call('POST', 'boq_items', { project_id: p, description: 'Interlock', unit: 'm2', qty: 1000, rate: 11 })).j.id;
    const emp = (await call('POST', 'employees', { name: 'Worker', join_date: '2025-01-01', basic: 1500, project_id: p })).j.id;
    await call('POST', 'invoices', { project_id: p, items: [{ description: 'x', qty: 1, rate: 100 }] });

    // ---- site roles see only the projects assigned to them
    const p2 = (await call('POST', 'projects', { name: 'Villas', client_id: cl, status: 'active' })).j.id;
    const bq2 = (await call('POST', 'boq_items', { project_id: p2, description: 'Paving', unit: 'm2', qty: 10, rate: 5 })).j.id;
    const emp2 = (await call('POST', 'employees', { name: 'Other Crew', join_date: '2025-01-01', basic: 1500, project_id: p2 })).j.id;
    const users = (await call('GET', 'users')).j, uid = n => users.find(u => u.username === n).id;
    assert.equal((await as('siteengineer', () => call('GET', 'projects'))).j.length, 0, 'nothing assigned → no projects');
    for (const n of ['siteengineer', 'foreman']) assert.equal((await call('PUT', 'users/' + uid(n), { projects: [p] })).s, 200);
    assert.deepEqual((await call('GET', 'users')).j.find(u => u.username === 'foreman').projects, [p]);
    const seP = (await as('siteengineer', () => call('GET', 'projects'))).j; assert.deepEqual(seP.map(x => x.id), [p], 'only own project listed');
    await expect('siteengineer', 'GET', 'projects/' + p2, null, 403, 'other project');
    await expect('siteengineer', 'GET', 'boq_items?project_id=' + p2, null, 403);
    await expect('siteengineer', 'PUT', 'boq_items/' + bq2, { done_pct: 10 }, 403, 'other project BOQ');
    await expect('siteengineer', 'POST', 'site_reports', { project_id: p2, date: '2026-10-27', labour_count: 3 }, 403);
    await expect('foreman', 'POST', 'attendance/clock', { employee_ids: [emp2], kind: 'in' }, 403, 'crew of another project');
    const roster = (await as('foreman', () => call('GET', 'attendance?date=2026-10-27'))).j.roster.map(r => r.id);
    assert.ok(roster.includes(emp) && !roster.includes(emp2), 'roster limited to own crew');
    assert.equal((await as('siteengineer', () => call('GET', 'boq_items'))).j.every(i => i.project_id === p), true);

    // ---- site engineer: progress, site diary, crews, material requests — no money
    const SE = 'siteengineer';
    await expect(SE, 'GET', 'projects', null, 200);
    for (const u of ['project-summary', 'dashboard', 'invoices', 'bills', 'payroll?month=2026-10', `projects/${p}/budget`, `projects/${p}/contract`, `projects/${p}/updates`]) await expect(SE, 'GET', u, null, 403, 'no money');
    await expect(SE, 'PUT', 'boq_items/' + bq, { done_pct: 40, rate: 1 }, 200);
    const item = (await call('GET', 'boq_items?project_id=' + p)).j[0]; assert.equal(item.done_pct, 40); assert.equal(item.rate, 11, 'rate untouched');
    await expect(SE, 'POST', 'boq_items', { project_id: p, description: 'x', qty: 1, rate: 1 }, 403); await expect(SE, 'DELETE', 'boq_items/' + bq, null, 403);
    await expect(SE, 'POST', 'site_reports', { project_id: p, date: '2026-10-27', labour_count: 12, work_done: 'Sub-base' }, 200);
    await expect(SE, 'POST', 'attendance/clock', { employee_ids: [emp], kind: 'in' }, 200);
    await expect(SE, 'POST', 'rfqs', { project_id: p, title: 'Kerbs' }, 200);
    await expect(SE, 'POST', 'purchase_orders', { party_id: sup, project_id: p, items: [] }, 403);
    await expect(SE, 'POST', 'tasks', { project_id: p, title: 'Survey' }, 200);

    // ---- foreman: crew attendance and site diary only
    const FM = 'foreman';
    await expect(FM, 'POST', 'attendance/clock', { employee_ids: [emp], kind: 'out' }, 200);
    await expect(FM, 'POST', 'site_reports', { project_id: p, date: '2026-10-27', labour_count: 10 }, 200);
    await expect(FM, 'GET', 'projects', null, 200);
    for (const u of ['boq_items?project_id=' + p, 'project-summary', 'invoices', 'employees', 'payroll?month=2026-10', 'quotes']) await expect(FM, 'GET', u, null, 403);
    await expect(FM, 'POST', 'attendance/clock', { employee_ids: [emp], kind: 'in', at: '2026-10-01 07:00' }, 400, 'past time = HR only');

    // ---- quantity surveyor: BOQ, variations, quotations, tenders, subcontract valuations; reads invoices but cannot issue them
    const QS = 'qs1';
    for (const u of ['project-summary', 'invoices', `projects/${p}/budget`]) await expect(QS, 'GET', u, null, 200);
    await expect(QS, 'POST', 'boq_items', { project_id: p, description: 'Kerb', unit: 'm', qty: 100, rate: 65 }, 200);
    await expect(QS, 'POST', 'variations', { project_id: p, description: 'Extra', amount: 5000 }, 200);
    await expect(QS, 'POST', 'quotes', { client_id: cl, items: [{ description: 'x', qty: 1, rate: 1 }] }, 200);
    await expect(QS, 'POST', 'tenders', { title: 'New tender', value: 50000 }, 200);
    await expect(QS, 'POST', 'invoices', { project_id: p, items: [{ description: 'x', qty: 1, rate: 1 }] }, 403);
    await expect(QS, 'POST', `projects/${p}/progress-invoice`, null, 403);
    for (const u of ['payroll?month=2026-10', 'employees', 'ledger', 'dashboard']) await expect(QS, 'GET', u, null, 403);

    // ---- procurement: suppliers, RFQs, POs, stock; sees bills, cannot post them
    const PR = 'procurement';
    await expect(PR, 'POST', 'parties', { type: 'supplier', name: 'Steel LLC' }, 200);
    await expect(PR, 'POST', 'purchase_orders', { party_id: sup, project_id: p, items: [{ description: 'Kerbs', qty: 10, rate: 50 }] }, 200);
    await expect(PR, 'GET', 'bills', null, 200); await expect(PR, 'POST', 'bills', { amount: 1 }, 403);
    for (const u of ['invoices', 'project-summary', 'payroll?month=2026-10']) await expect(PR, 'GET', u, null, 403);

    // ---- storekeeper: stock and deliveries
    const SK = 'storekeeper';
    const st = await expect(SK, 'POST', 'stock_items', { code: 'KB-1', name: 'Kerbstone', unit: 'pc' }, 200);
    await expect(SK, 'GET', 'purchase_orders', null, 200); await expect(SK, 'POST', 'purchase_orders', { party_id: sup, items: [] }, 403);
    for (const u of ['invoices', 'bills', 'project-summary', 'parties']) await expect(SK, 'GET', u, null, 403);
    assert.ok(st.id);
    console.log('✔ site roles: only assigned projects and their crews (lists, details, BOQ, diary, clocking)');
    console.log('✔ site engineer (progress only on BOQ, no money), foreman (crew + diary), QS (commercial, no invoicing), procurement, storekeeper');
    console.log('ROLE TESTS PASSED');
  } catch (e) { console.error('FAIL', e); process.exitCode = 1; }
  finally { server.close(); setTimeout(() => process.exit(process.exitCode || 0), 100); }
});
