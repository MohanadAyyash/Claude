// Site operations: equipment running log (hours on each project, fuel, maintenance with the next service due) on top of the
// asset register, and the project programme (activities with planned dates and progress, shown as a Gantt chart).
// Additive: two new tables and one column (fixed_assets.hourly_rate). The logs are operating records — they post nothing to the
// ledger (fuel and repairs reach the accounts through their supplier bills; depreciation through the asset register).
module.exports = ctx => {
  const { db, send, bad, audit, readBody, today, round } = ctx;
  const { MONEY } = require('../lib/acl');
  db.exec(`CREATE TABLE IF NOT EXISTS equipment_logs(id INTEGER PRIMARY KEY, asset_id INTEGER, date TEXT, kind TEXT, project_id INTEGER, hours REAL DEFAULT 0, litres REAL DEFAULT 0, cost REAL DEFAULT 0,
    description TEXT, operator TEXT, next_due_date TEXT, next_due_hours REAL, created_by TEXT);
  CREATE INDEX IF NOT EXISTS equipment_logs_asset ON equipment_logs(asset_id, date);
  CREATE TABLE IF NOT EXISTS schedule_items(id INTEGER PRIMARY KEY, project_id INTEGER, title TEXT NOT NULL, start_date TEXT, end_date TEXT, progress REAL DEFAULT 0, boq_item_id INTEGER, sort INTEGER DEFAULT 0, notes TEXT);
  CREATE INDEX IF NOT EXISTS schedule_items_project ON schedule_items(project_id, sort);`);
  if (!db.prepare('PRAGMA table_info(fixed_assets)').all().some(c => c.name === 'hourly_rate')) db.exec('ALTER TABLE fixed_assets ADD COLUMN hourly_rate REAL DEFAULT 0');
  if (ctx.TABLES.fixed_assets) { ctx.TABLES.fixed_assets.cols.push('hourly_rate'); ctx.TABLES.fixed_assets.num.push('hourly_rate'); }
  const isDate = d => /^\d{4}-\d\d-\d\d$/.test(d || '') && !isNaN(Date.parse(d));
  const days = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);
  const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
  const pname = () => Object.fromEntries(db.prepare('SELECT id, name, code FROM projects').all().map(p => [p.id, p]));

  // ======================= equipment =======================
  const KINDS = ['usage', 'fuel', 'maintenance'];
  function equipment(me) {
    const money = MONEY.includes(me.role), P = pname(), t = today(), soon = addDays(t, 14);
    const logs = db.prepare('SELECT * FROM equipment_logs ORDER BY date DESC, id DESC').all();
    return db.prepare("SELECT * FROM fixed_assets WHERE COALESCE(status,'active')!='disposed' ORDER BY name").all().map(a => {
      const mine = logs.filter(l => l.asset_id === a.id), sum = (k, f) => round(mine.filter(l => l.kind === k).reduce((s, l) => s + (+l[f] || 0), 0));
      const hours = sum('usage', 'hours'), litres = sum('fuel', 'litres'), fuel = sum('fuel', 'cost'), maint = sum('maintenance', 'cost');
      const last = mine.find(l => l.kind === 'maintenance' && (l.next_due_date || l.next_due_hours));          // the latest service sets the next one
      const dueDate = last && last.next_due_date ? last.next_due_date : null, dueHours = last && last.next_due_hours > 0 ? last.next_due_hours : null;
      const overdue = !!((dueDate && dueDate < t) || (dueHours && hours >= dueHours)), dueSoon = !overdue && !!((dueDate && dueDate <= soon) || (dueHours && hours >= dueHours - 25));
      return { id: a.id, name: a.name, category: a.category || '', serial: a.serial || '', project_id: a.project_id || null, project_name: (P[a.project_id] || {}).name || '',
        hours, litres, litres_per_hour: hours > 0 ? round(litres / hours) : null, last_used: (mine.find(l => l.kind === 'usage') || {}).date || null,
        next_service_date: dueDate, next_service_hours: dueHours, service_overdue: overdue, service_soon: dueSoon,
        ...(money ? { hourly_rate: +a.hourly_rate || 0, fuel_cost: fuel, maintenance_cost: maint, running_cost: round(fuel + maint), cost_per_hour: hours > 0 ? round((fuel + maint) / hours) : null } : {}) };
    });
  }
  const logRows = (me, assetId) => {
    const money = MONEY.includes(me.role), P = pname(), A = Object.fromEntries(db.prepare('SELECT id, name FROM fixed_assets').all().map(a => [a.id, a.name]));
    return db.prepare(`SELECT * FROM equipment_logs ${assetId ? 'WHERE asset_id=?' : ''} ORDER BY date DESC, id DESC LIMIT 500`).all(...(assetId ? [assetId] : []))
      .map(({ cost, ...l }) => ({ ...l, ...(money ? { cost } : {}), asset_name: A[l.asset_id] || '', project_name: (P[l.project_id] || {}).name || '' }));
  };
  // hours on each project × the internal hourly rate: what each project "used" of the company's equipment (management view, not posted)
  function byProject(from, to) {
    const P = pname(), out = {};
    for (const l of db.prepare("SELECT l.*, a.hourly_rate, a.name FROM equipment_logs l JOIN fixed_assets a ON a.id=l.asset_id WHERE l.kind='usage' AND l.date>=? AND l.date<=?").all(from || '0000-00-00', to || '9999-12-31')) {
      const k = l.project_id || 0, o = out[k] || (out[k] = { project_id: l.project_id || null, project_name: (P[l.project_id] || {}).name || '', hours: 0, charge: 0 });
      o.hours = round(o.hours + (+l.hours || 0)); o.charge = round(o.charge + (+l.hours || 0) * (+l.hourly_rate || 0));
    }
    return Object.values(out).sort((a, b) => b.charge - a.charge || b.hours - a.hours);
  }
  function cleanLog(x, cur) {
    const o = { ...(cur || {}), ...x };
    if (!db.prepare('SELECT 1 FROM fixed_assets WHERE id=?').get(+o.asset_id)) bad('Select the equipment');
    if (!KINDS.includes(o.kind)) bad('Entry type must be usage, fuel or maintenance');
    if (!isDate(o.date)) bad('Enter the date'); if (o.date > today()) bad('The date cannot be in the future');
    const n = k => { const v = +o[k] || 0; if (v < 0) bad('Amounts cannot be negative'); return v; };
    const r = { asset_id: +o.asset_id, date: o.date, kind: o.kind, project_id: +o.project_id || null, hours: 0, litres: 0, cost: 0, description: String(o.description || '').slice(0, 500), operator: String(o.operator || '').slice(0, 100), next_due_date: null, next_due_hours: null };
    if (o.kind === 'usage') { r.hours = n('hours'); if (!(r.hours > 0 && r.hours <= 24)) bad('Working hours must be between 0 and 24 for one day'); }
    if (o.kind === 'fuel') { r.litres = n('litres'); r.cost = n('cost'); if (!(r.litres > 0)) bad('Enter the litres'); }
    if (o.kind === 'maintenance') {
      r.cost = n('cost'); if (!r.description) bad('Describe the maintenance done');
      if (o.next_due_date) { if (!isDate(o.next_due_date)) bad('Next service date must be a date'); r.next_due_date = o.next_due_date; }
      if (+o.next_due_hours > 0) r.next_due_hours = +o.next_due_hours;
    }
    return r;
  }

  // ======================= programme (Gantt) =======================
  function schedule(pid) {
    const p = db.prepare('SELECT id, name, code, start_date, end_date, status FROM projects WHERE id=?').get(pid); if (!p) return null;
    const t = today(), boq = Object.fromEntries(db.prepare('SELECT id, description, done_pct FROM boq_items WHERE project_id=?').all(pid).map(b => [b.id, b]));
    const items = db.prepare('SELECT * FROM schedule_items WHERE project_id=? ORDER BY sort, start_date, id').all(pid).map(i => {
      const linked = i.boq_item_id && boq[i.boq_item_id], progress = round(linked ? +linked.done_pct || 0 : +i.progress || 0), dur = Math.max(1, days(i.start_date, i.end_date) + 1);
      const planned = t < i.start_date ? 0 : t >= i.end_date ? 100 : Math.round((days(i.start_date, t) + 1) / dur * 100);   // straight-line plan: where it should be today
      const status = progress >= 100 ? 'done' : i.end_date < t ? 'late' : planned - progress > 10 ? 'behind' : t < i.start_date ? 'upcoming' : 'on_track';
      return { ...i, progress, duration: dur, planned, status, boq_description: linked ? linked.description : '' };
    });
    const first = items.length ? items.reduce((m, i) => (i.start_date < m ? i.start_date : m), items[0].start_date) : p.start_date || t;
    const last = items.length ? items.reduce((m, i) => (i.end_date > m ? i.end_date : m), items[0].end_date) : p.end_date || t;
    const w = items.reduce((s, i) => s + i.duration, 0), avg = f => (w ? Math.round(items.reduce((s, i) => s + i[f] * i.duration, 0) / w) : 0);       // weighted by duration
    return { project: p, today: t, from: first, to: last, items, summary: { activities: items.length, progress: avg('progress'), planned: avg('planned'), late: items.filter(i => i.status === 'late').length, behind: items.filter(i => i.status === 'behind').length,
      finish: last, contract_finish: p.end_date || null, overrun_days: p.end_date && last > p.end_date ? days(p.end_date, last) : 0 } };
  }
  function cleanItem(x, cur) {
    const o = { ...(cur || {}), ...x };
    const title = String(o.title || '').trim(); if (!title) bad('Enter the activity name');
    if (!isDate(o.start_date) || !isDate(o.end_date)) bad('Enter the start and finish dates'); if (o.end_date < o.start_date) bad('The finish date is before the start date');
    const pr = +o.progress || 0; if (pr < 0 || pr > 100) bad('Progress must be between 0 and 100');
    const boq = +o.boq_item_id || null; if (boq && !db.prepare('SELECT 1 FROM boq_items WHERE id=? AND project_id=?').get(boq, +o.project_id)) bad('That BOQ item is not in this project');
    return { title: title.slice(0, 200), start_date: o.start_date, end_date: o.end_date, progress: round(pr), boq_item_id: boq, sort: Math.round(+o.sort || 0), notes: String(o.notes || '').slice(0, 500) };
  }

  // ---------- alerts ----------
  ctx.siteAlerts = add => {
    for (const e of equipment({ role: 'admin' })) { if (e.service_overdue) add('bad', 'service_overdue', { who: e.name }); else if (e.service_soon) add('warn', 'service_soon', { who: e.name, date: e.next_service_date || '' }); }
    for (const p of db.prepare("SELECT DISTINCT s.project_id id FROM schedule_items s JOIN projects p ON p.id=s.project_id WHERE p.status='active'").all()) {
      const s = schedule(p.id); if (s && s.summary.late) add('warn', 'schedule_late', { who: s.project.name, count: s.summary.late });
    }
  };

  return {
    async handle(req, res, url, [a, b, c], me) {
      const m = req.method, q = url.searchParams;
      if (a === 'equipment') {
        if (m === 'GET' && !b) return send(res, 200, equipment(me)), true;
        if (m === 'GET' && b === 'logs') return send(res, 200, logRows(me, +q.get('asset_id') || null)), true;
        if (m === 'GET' && b === 'by-project') { if (!MONEY.includes(me.role)) return send(res, 403, { error: 'your role does not allow this action' }), true; return send(res, 200, byProject(q.get('from'), q.get('to'))), true; }
        if (b === 'logs' && m === 'POST' && !c) { const r = cleanLog(await readBody(req)); const x = db.prepare('INSERT INTO equipment_logs(asset_id,date,kind,project_id,hours,litres,cost,description,operator,next_due_date,next_due_hours,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(r.asset_id, r.date, r.kind, r.project_id, r.hours, r.litres, r.cost, r.description, r.operator, r.next_due_date, r.next_due_hours, me.username); audit(req, 'create', 'equipment_logs', Number(x.lastInsertRowid), `${r.kind} ${r.date}`); return send(res, 200, { id: Number(x.lastInsertRowid) }), true; }
        if (b === 'logs' && c && ['PUT', 'DELETE'].includes(m)) {
          const cur = db.prepare('SELECT * FROM equipment_logs WHERE id=?').get(+c); if (!cur) return send(res, 404, { error: 'not found' }), true;
          const sc = ctx.siteScope ? ctx.siteScope(me) : null; if (sc && cur.project_id && !sc.projects.has(cur.project_id)) return send(res, 403, { error: 'this project is not assigned to you' }), true;
          if (m === 'DELETE') { db.prepare('DELETE FROM equipment_logs WHERE id=?').run(cur.id); audit(req, 'delete', 'equipment_logs', cur.id, `${cur.kind} ${cur.date}`); return send(res, 200, { ok: 1 }), true; }
          const r = cleanLog(await readBody(req), cur);
          db.prepare('UPDATE equipment_logs SET asset_id=?,date=?,kind=?,project_id=?,hours=?,litres=?,cost=?,description=?,operator=?,next_due_date=?,next_due_hours=? WHERE id=?').run(r.asset_id, r.date, r.kind, r.project_id, r.hours, r.litres, r.cost, r.description, r.operator, r.next_due_date, r.next_due_hours, cur.id);
          audit(req, 'update', 'equipment_logs', cur.id, r.kind); return send(res, 200, { ok: 1 }), true;
        }
        return send(res, 404, { error: 'not found' }), true;
      }
      if (a === 'schedule') {
        if (m === 'GET') { const s = schedule(+q.get('project_id')); return send(res, s ? 200 : 404, s || { error: 'not found' }), true; }
        if (m === 'POST' && b === 'from-boq') {                               // a first programme from the BOQ: one activity per item, spread evenly over the project dates
          const x = await readBody(req), p = db.prepare('SELECT * FROM projects WHERE id=?').get(+x.project_id); if (!p) bad('Project not found');
          if (db.prepare('SELECT 1 FROM schedule_items WHERE project_id=?').get(p.id)) bad('This project already has a programme — add or edit its activities instead');
          const boq = db.prepare('SELECT * FROM boq_items WHERE project_id=? ORDER BY id').all(p.id); if (!boq.length) bad('Add the BOQ items to the project first');
          const from = isDate(x.start_date) ? x.start_date : isDate(p.start_date) ? p.start_date : today(), to = isDate(x.end_date) ? x.end_date : isDate(p.end_date) && p.end_date > from ? p.end_date : addDays(from, boq.length * 14 - 1);
          const total = days(from, to) + 1, step = total / boq.length, ins = db.prepare('INSERT INTO schedule_items(project_id,title,start_date,end_date,progress,boq_item_id,sort) VALUES(?,?,?,?,?,?,?)');
          boq.forEach((it, i) => ins.run(p.id, `${it.section ? it.section + ' — ' : ''}${it.description}`.slice(0, 200), addDays(from, Math.floor(i * step)), addDays(from, Math.max(Math.floor(i * step), Math.floor((i + 1) * step) - 1)), 0, it.id, i + 1));
          audit(req, 'create', 'schedule', p.id, `${boq.length} activities from the BOQ`); return send(res, 200, { created: boq.length }), true;
        }
        if (m === 'POST' && !b) {
          const x = await readBody(req); if (!db.prepare('SELECT 1 FROM projects WHERE id=?').get(+x.project_id)) bad('Project not found');
          const r = cleanItem(x), sort = r.sort || (db.prepare('SELECT MAX(sort) n FROM schedule_items WHERE project_id=?').get(+x.project_id).n || 0) + 1;
          const i = db.prepare('INSERT INTO schedule_items(project_id,title,start_date,end_date,progress,boq_item_id,sort,notes) VALUES(?,?,?,?,?,?,?,?)').run(+x.project_id, r.title, r.start_date, r.end_date, r.progress, r.boq_item_id, sort, r.notes);
          return send(res, 200, { id: Number(i.lastInsertRowid) }), true;
        }
        if (b && /^\d+$/.test(b) && ['PUT', 'DELETE'].includes(m)) {
          const cur = db.prepare('SELECT * FROM schedule_items WHERE id=?').get(+b); if (!cur) return send(res, 404, { error: 'not found' }), true;
          const sc = ctx.siteScope ? ctx.siteScope(me) : null; if (sc && !sc.projects.has(cur.project_id)) return send(res, 403, { error: 'this project is not assigned to you' }), true;
          if (m === 'DELETE') { db.prepare('DELETE FROM schedule_items WHERE id=?').run(cur.id); return send(res, 200, { ok: 1 }), true; }
          const x = await readBody(req), r = cleanItem(me.role === 'site_engineer' ? { progress: x.progress } : x, cur);                // the site engineer reports progress; dates stay with the office
          db.prepare('UPDATE schedule_items SET title=?,start_date=?,end_date=?,progress=?,boq_item_id=?,sort=?,notes=? WHERE id=?').run(r.title, r.start_date, r.end_date, r.progress, r.boq_item_id, r.sort, r.notes, cur.id);
          return send(res, 200, { ok: 1 }), true;
        }
        return send(res, 404, { error: 'not found' }), true;
      }
      return false;
    },
  };
};
