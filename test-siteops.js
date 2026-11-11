// Equipment running log and project programme (Gantt): node --no-warnings test-siteops.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-siteops-'));
process.env.ZOHO_NO_SCHEDULER = '1'; process.env.SALES_NO_SCHEDULER = '1';
const { server } = require('./server.js');

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api/`; let cookie = '';
  const call = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j }; };
  const ok = (r, l) => { assert.equal(r.s, 200, `${l || ''} → ${r.s} ${JSON.stringify(r.j).slice(0, 300)}`); return r.j; };
  const jar = {}; const as = async (u, fn) => { const keep = cookie; cookie = jar[u] || ''; if (!cookie) ok(await call('POST', 'login', { username: u, password: 'secret12' })); jar[u] = cookie; try { return await fn(); } finally { cookie = keep; } };
  const local = d => new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10), day = o => local(new Date(Date.now() + o * 864e5));
  try {
    ok(await call('POST', 'setup', { username: 'admin', password: 'secret12', company: 'Trigon' }));
    const cl = ok(await call('POST', 'parties', { type: 'client', name: 'Client' })).id;
    const P = ok(await call('POST', 'projects', { name: 'Roads', client_id: cl, status: 'active', start_date: day(-20), end_date: day(39) })).id, P2 = ok(await call('POST', 'projects', { name: 'Other', client_id: cl, status: 'active' })).id;
    for (const [u, role] of [['eng', 'site_engineer'], ['fore', 'foreman'], ['view', 'viewer']]) { const id = ok(await call('POST', 'users', { username: u, password: 'secret12', role })).id; if (role !== 'viewer') ok(await call('PUT', 'users/' + id, { projects: [P] })); }
    const ex = ok(await call('POST', 'fixed_assets', { name: 'Excavator CAT 320', category: 'equipment', purchase_date: '2025-01-01', cost: 300000, life_years: 8, status: 'active', project_id: P, hourly_rate: 150 })).id;

    // ---- equipment: usage, fuel, maintenance
    ok(await as('fore', () => call('POST', 'equipment/logs', { asset_id: ex, kind: 'usage', date: day(-2), project_id: P, hours: 8, operator: 'Ali' })));
    ok(await as('fore', () => call('POST', 'equipment/logs', { asset_id: ex, kind: 'usage', date: day(-1), project_id: P, hours: 6 })));
    ok(await call('POST', 'equipment/logs', { asset_id: ex, kind: 'usage', date: day(-1), project_id: P2, hours: 2 }));
    ok(await call('POST', 'equipment/logs', { asset_id: ex, kind: 'fuel', date: day(-1), project_id: P, litres: 240, cost: 720 }));
    const mt = ok(await call('POST', 'equipment/logs', { asset_id: ex, kind: 'maintenance', date: day(-1), cost: 880, description: 'Oil and filters', next_due_date: day(10), next_due_hours: 500 })).id;
    for (const b of [{ kind: 'usage', hours: 30 }, { kind: 'usage', hours: -1 }, { kind: 'fuel', litres: 0 }, { kind: 'maintenance', description: '' }, { kind: 'zzz' }, { kind: 'usage', hours: 5, date: day(3) }])
      assert.equal((await call('POST', 'equipment/logs', { asset_id: ex, date: day(-1), ...b })).s, 400, JSON.stringify(b));
    assert.equal((await as('fore', () => call('POST', 'equipment/logs', { asset_id: ex, kind: 'usage', date: day(-1), project_id: P2, hours: 4 }))).s, 403, 'not his project');
    let e = ok(await call('GET', 'equipment'))[0]; assert.equal(e.hours, 16); assert.equal(e.litres, 240); assert.equal(e.litres_per_hour, 15); assert.equal(e.running_cost, 1600); assert.equal(e.cost_per_hour, 100);
    assert.equal(e.next_service_date, day(10)); assert.equal(e.service_soon, true); assert.equal(e.service_overdue, false);
    assert.ok(ok(await call('GET', 'compliance')).some(a => a.key === 'service_soon'));
    ok(await call('PUT', 'equipment/logs/' + mt, { next_due_date: day(-3) })); assert.equal(ok(await call('GET', 'equipment'))[0].service_overdue, true);
    assert.ok(ok(await call('GET', 'compliance')).some(a => a.key === 'service_overdue' && /Excavator/.test(a.who)));
    const bp = ok(await call('GET', 'equipment/by-project')); assert.equal(bp[0].project_name, 'Roads'); assert.equal(bp[0].hours, 14); assert.equal(bp[0].charge, 2100); assert.equal(bp[1].charge, 300);
    // site roles: no money, only their project's entries
    const fe = ok(await as('fore', () => call('GET', 'equipment')))[0]; assert.equal(fe.running_cost, undefined); assert.equal(fe.hourly_rate, undefined); assert.equal(fe.hours, 16);
    const fl = ok(await as('fore', () => call('GET', 'equipment/logs'))); assert.ok(fl.every(l => l.cost === undefined && (l.project_id == null || l.project_id === P)));
    assert.equal((await as('fore', () => call('GET', 'equipment/by-project'))).s, 403); assert.equal((await as('view', () => call('POST', 'equipment/logs', { asset_id: ex, kind: 'usage', date: day(-1), hours: 1 }))).s, 403);
    console.log('✔ equipment: hours, fuel and maintenance; litres/hour and cost/hour; next service alerts; use by project; site roles see no money and only their project');

    // ---- programme
    const A = ok(await call('POST', 'boq_items', { project_id: P, description: 'Excavation', unit: 'm3', qty: 100, rate: 50 })).id; ok(await call('POST', 'boq_items', { project_id: P, description: 'Sub-base', unit: 'm2', qty: 100, rate: 30 })); ok(await call('POST', 'boq_items', { project_id: P, description: 'Asphalt', unit: 'm2', qty: 100, rate: 80 }));
    assert.equal((await call('POST', 'schedule/from-boq', { project_id: P2 })).s, 400, 'no BOQ');
    assert.equal(ok(await call('POST', 'schedule/from-boq', { project_id: P })).created, 3); assert.equal((await call('POST', 'schedule/from-boq', { project_id: P })).s, 400, 'only once');
    let s = ok(await call('GET', 'schedule?project_id=' + P)); assert.equal(s.items.length, 3); assert.equal(s.from, day(-20)); assert.equal(s.to, day(39)); assert.equal(s.items[0].duration, 20);
    assert.equal(s.items[0].end_date, day(-1)); assert.equal(s.items[0].status, 'late', 'finish date passed at 0%'); assert.equal(s.items[1].status, 'on_track'); assert.equal(s.items[2].status, 'upcoming'); assert.equal(s.summary.late, 1);
    assert.ok(ok(await call('GET', 'compliance')).some(a => a.key === 'schedule_late' && a.count === 1));
    ok(await call('PUT', 'boq_items/' + A, { done_pct: 100 }));                                  // linked to the BOQ item: its progress is the activity's
    s = ok(await call('GET', 'schedule?project_id=' + P)); assert.equal(s.items[0].progress, 100); assert.equal(s.items[0].status, 'done'); assert.equal(s.summary.late, 0); assert.equal(s.summary.progress, 33);
    const extra = ok(await call('POST', 'schedule', { project_id: P, title: 'Handing over', start_date: day(40), end_date: day(49), progress: 0 })).id;
    s = ok(await call('GET', 'schedule?project_id=' + P)); assert.equal(s.summary.overrun_days, 10, 'runs past the project end date');
    for (const b of [{ title: '' }, { end_date: day(-100) }, { progress: 120 }, { start_date: 'x' }]) assert.equal((await call('PUT', 'schedule/' + extra, b)).s, 400, JSON.stringify(b));
    // the site engineer reports progress only; the foreman reads; other projects are closed
    ok(await as('eng', () => call('PUT', 'schedule/' + extra, { progress: 40, end_date: day(400), title: 'hacked' })));
    const it = ok(await call('GET', 'schedule?project_id=' + P)).items.find(i => i.id === extra); assert.equal(it.progress, 40); assert.equal(it.end_date, day(49)); assert.equal(it.title, 'Handing over');
    assert.equal((await as('fore', () => call('PUT', 'schedule/' + extra, { progress: 50 }))).s, 403); assert.equal((await as('fore', () => call('GET', 'schedule?project_id=' + P))).s, 200);
    assert.equal((await as('eng', () => call('GET', 'schedule?project_id=' + P2))).s, 403); assert.equal((await as('eng', () => call('POST', 'schedule', { project_id: P2, title: 'x', start_date: day(0), end_date: day(1) }))).s, 403);
    ok(await call('DELETE', 'schedule/' + extra)); assert.equal(ok(await call('GET', 'schedule?project_id=' + P)).summary.overrun_days, 0);
    console.log('✔ programme: built from the BOQ, progress read from linked BOQ items, late / behind / overrun flagged, site engineer updates progress only');
    console.log('SITE OPERATIONS TESTS PASSED');
  } catch (err) { console.error('FAIL', err); process.exitCode = 1; }
  finally { server.close(); setTimeout(() => process.exit(process.exitCode || 0), 100); }
});
