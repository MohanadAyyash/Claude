// Project control and teamwork: budget per cost category vs actual and committed (open POs / subcontracts) with a forecast
// at completion, weekly project updates (status + progress, with a snapshot of the numbers), tasks (on a project or any record:
// assignee, due date, tag, sub-tasks) and notes with @mentions on records. Assignments and mentions notify people (push.js).
const CATS = ['materials', 'labour', 'subcontract', 'equipment', 'transport', 'permits', 'accommodation', 'visa', 'insurance', 'overhead', 'other'];
const STATUS = ['on_track', 'at_risk', 'off_track', 'on_hold', 'complete'];
const TASK_ST = ['todo', 'doing', 'done', 'cancelled'];
const TAGS = ['site', 'commercial', 'authorities', 'hse', 'qaqc', 'procurement', 'other'];
const ENTITIES = ['project', 'party', 'invoice', 'quote', 'bill', 'po', 'employee', 'task', 'subcontract', 'tender'];

module.exports = ctx => {
  const { db, send, bad, audit, readBody, today, round } = ctx;
  db.exec(`
  CREATE TABLE IF NOT EXISTS project_budgets(project_id INTEGER, category TEXT, amount REAL DEFAULT 0, PRIMARY KEY(project_id, category));
  CREATE TABLE IF NOT EXISTS project_updates(id INTEGER PRIMARY KEY, project_id INTEGER, date TEXT, status TEXT, progress REAL, summary TEXT, author TEXT, snapshot TEXT);
  CREATE TABLE IF NOT EXISTS tasks(id INTEGER PRIMARY KEY, project_id INTEGER, entity TEXT, entity_id INTEGER, parent_id INTEGER, title TEXT NOT NULL, description TEXT, assignee_user_id INTEGER,
    due_date TEXT, status TEXT DEFAULT 'todo', tag TEXT, created_by INTEGER, created TEXT, done_at TEXT);
  CREATE INDEX IF NOT EXISTS tasks_project ON tasks(project_id);
  CREATE TABLE IF NOT EXISTS notes(id INTEGER PRIMARY KEY, entity TEXT, entity_id INTEGER, user_id INTEGER, username TEXT, body TEXT, created TEXT);
  CREATE INDEX IF NOT EXISTS notes_entity ON notes(entity, entity_id);`);
  // shared expenses: bills.allocation = [{ project_id, pct }] totalling 100 %
  if (!db.prepare('PRAGMA table_info(bills)').all().some(x => x.name === 'allocation')) db.exec('ALTER TABLE bills ADD COLUMN allocation TEXT');
  const BT = ctx.TABLES.bills; BT.cols.push('allocation'); BT.json = [...(BT.json || []), 'allocation'];
  const prevBillCheck = BT.check;
  BT.check = r => {
    if (prevBillCheck) prevBillCheck(r);
    if (r.allocation === undefined) return;
    const al = JSON.parse(r.allocation || '[]'); if (!al.length) return;
    if (al.length < 2) bad('Split across at least two projects (or choose one project)');
    for (const a of al) { if (!(+a.pct > 0)) bad('Each share must be more than 0 %'); if (!db.prepare('SELECT 1 FROM projects WHERE id=?').get(+a.project_id)) bad('Project not found in the split'); }
    if (new Set(al.map(a => +a.project_id)).size !== al.length) bad('A project appears twice in the split');
    if (Math.abs(al.reduce((s, a) => s + +a.pct, 0) - 100) > 0.01) bad('The shares must add up to 100 %');
    r.project_id = null;                                                    // split bills belong to no single project
  };
  const now = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().replace('T', ' ').slice(0, 16); };
  const notify = (to, msg) => ctx.notify ? ctx.notify(to, msg).catch(() => {}) : null;
  const staff = me => me.role !== 'employee';
  const manager = me => ['admin', 'manager'].includes(me.role);
  const project = id => db.prepare('SELECT * FROM projects WHERE id=?').get(id);

  // ---------- budget vs actual vs committed, forecast at completion ----------
  function budget(pid) {
    const p = ctx.projectRows().find(r => r.id === pid); if (!p) return null;
    const set = Object.fromEntries(db.prepare('SELECT category, amount FROM project_budgets WHERE project_id=?').all(pid).map(r => [r.category, r.amount]));
    const actual = { ...p.cost_by_category }; actual.labour = round((actual.labour || 0) + (actual.payroll || 0)); delete actual.payroll;
    const committed = {};
    for (const po of db.prepare("SELECT * FROM purchase_orders WHERE project_id=? AND status NOT IN ('draft','cancelled') AND bill_id IS NULL").all(pid)) {
      let items = []; try { items = JSON.parse(po.items || '[]'); } catch { /* bad json */ }
      committed.materials = round((committed.materials || 0) + items.reduce((s, i) => s + (+i.qty || 0) * (+i.rate || 0), 0));
    }
    for (const sc of db.prepare("SELECT * FROM subcontracts WHERE project_id=? AND status='active'").all(pid)) {
      const cert = db.prepare("SELECT COALESCE(MAX(cumulative),0) c FROM sub_certs WHERE subcontract_id=? AND status!='draft'").get(sc.id).c;
      committed.subcontract = round((committed.subcontract || 0) + Math.max(0, sc.contract_value - cert));
    }
    const progress = p.boq_progress || 0, lines = CATS.map(c => {
      const b = set[c] || 0, a = actual[c] || 0, cm = committed[c] || 0;
      return { category: c, budget: b, actual: a, committed: cm, remaining: round(b - a - cm), used_pct: b ? round((a + cm) / b * 100) : null };
    });
    const tot = k => round(lines.reduce((s, l) => s + l[k], 0));
    const budgetTotal = tot('budget') || p.boq_budget_cost, actualTotal = round(p.cost);
    // estimate at completion: spent so far + the budget of the work not yet done (or what is already committed, if more);
    // without a budget, extrapolate the cost so far from the progress
    const eac = budgetTotal > 0 ? round(actualTotal + Math.max(tot('committed'), budgetTotal * (1 - progress / 100)))
      : progress > 0 ? round(Math.max(actualTotal + tot('committed'), actualTotal / (progress / 100))) : round(actualTotal + tot('committed'));
    return { lines, totals: { budget: budgetTotal, actual: actualTotal, committed: tot('committed'), remaining: round(budgetTotal - actualTotal - tot('committed')) },
      progress, revenue: p.revised_value, earned: p.boq_earned, invoiced: p.invoiced,
      forecast: { cost_at_completion: eac, margin: round(p.revised_value - eac), margin_pct: p.revised_value ? round((p.revised_value - eac) / p.revised_value * 100) : 0,
        budget_margin: round(p.revised_value - budgetTotal), over_budget: budgetTotal > 0 && eac > budgetTotal } };
  }

  // ---------- tasks ----------
  const taskRow = t => t && { ...t, assignee: t.assignee_user_id ? (db.prepare('SELECT username, display_name FROM users WHERE id=?').get(t.assignee_user_id) || {}) : null,
    subtasks: db.prepare('SELECT id,title,status,assignee_user_id,due_date FROM tasks WHERE parent_id=? ORDER BY id').all(t.id), overdue: !!(t.due_date && t.due_date < today() && !['done', 'cancelled'].includes(t.status)) };
  const canSee = (t, me) => staff(me) || t.assignee_user_id === me.id || t.created_by === me.id;
  const canEdit = (t, me) => manager(me) || ['hr', 'accountant'].includes(me.role) || t.created_by === me.id;
  function checkTask(x, partial) {
    if (!partial || x.title !== undefined) { if (!String(x.title || '').trim()) bad('Enter the task title'); }
    if (x.status !== undefined && !TASK_ST.includes(x.status)) bad('Invalid status');
    if (x.tag && !TAGS.includes(x.tag)) bad('Invalid tag');
    if (x.due_date && !/^\d{4}-\d\d-\d\d$/.test(x.due_date)) bad('Invalid due date');
    if (x.entity && !ENTITIES.includes(x.entity)) bad('Invalid record type');
    if (x.assignee_user_id && !db.prepare('SELECT 1 FROM users WHERE id=?').get(+x.assignee_user_id)) bad('Assignee not found');
  }
  const pingAssignee = (t, me) => { if (t.assignee_user_id && t.assignee_user_id !== me.id) notify([t.assignee_user_id], { title: 'مهمة جديدة لك / New task for you', body: `${t.title}${t.due_date ? ' — ' + t.due_date : ''} (${me.username})`, url: `#tasks/${t.id}` }); };

  // ---------- notes with @mentions ----------
  function addNote(entity, id, body, me) {
    if (!ENTITIES.includes(entity)) bad('Invalid record type');
    body = String(body || '').trim(); if (!body) bad('Write the note'); if (body.length > 4000) bad('Note too long');
    const r = db.prepare('INSERT INTO notes(entity,entity_id,user_id,username,body,created) VALUES(?,?,?,?,?,?)').run(entity, id, me.id, me.username, body, now());
    const names = [...new Set((body.match(/@([\w.\-@]{3,40})/g) || []).map(m => m.slice(1).toLowerCase()))];
    const users = names.length ? db.prepare(`SELECT id, username FROM users WHERE lower(username) IN (${names.map(() => '?').join(',')}) AND COALESCE(disabled,0)=0`).all(...names).filter(u => u.id !== me.id) : [];
    const link = { project: `#projects/${id}`, task: `#tasks/${id}`, party: '#parties', invoice: '#invoices', quote: '#quotes', bill: '#bills', po: '#po', employee: '#employees', subcontract: '#subcontracts', tender: '#tenders' }[entity];
    if (users.length) notify(users.map(u => u.id), { title: `${me.username} ذكرك / mentioned you`, body: body.slice(0, 180), url: link });
    return { id: Number(r.lastInsertRowid), mentioned: users.map(u => u.username) };
  }

  return {
    async handle(req, res, url, [a, b, c, d], me) {
      const m = req.method, q = url.searchParams;
      // ----- project budget & updates -----
      if (a === 'projects' && b && ['budget', 'updates'].includes(c)) {
        const pid = +b; if (!project(pid)) return send(res, 404, { error: 'not found' }), true;
        if (c === 'budget' && m === 'GET') return send(res, 200, budget(pid)), true;
        if (c === 'budget' && m === 'PUT') {
          if (!['admin', 'accountant', 'manager'].includes(me.role)) return send(res, 403, { error: 'forbidden' }), true;
          const x = await readBody(req), lines = x.lines || {};
          for (const [cat, amt] of Object.entries(lines)) { if (!CATS.includes(cat)) bad('Unknown category ' + cat); if (!(+amt >= 0)) bad('Budget amounts must be 0 or more'); }
          for (const [cat, amt] of Object.entries(lines)) db.prepare('INSERT INTO project_budgets(project_id,category,amount) VALUES(?,?,?) ON CONFLICT(project_id,category) DO UPDATE SET amount=excluded.amount').run(pid, cat, round(+amt));
          audit(req, 'update', 'project_budgets', pid, JSON.stringify(lines).slice(0, 300));
          return send(res, 200, budget(pid)), true;
        }
        if (c === 'updates' && m === 'GET') return send(res, 200, db.prepare('SELECT * FROM project_updates WHERE project_id=? ORDER BY date DESC, id DESC').all(pid).map(u => ({ ...u, snapshot: JSON.parse(u.snapshot || '{}') }))), true;
        if (c === 'updates' && m === 'POST') {
          if (!['admin', 'accountant', 'manager'].includes(me.role)) return send(res, 403, { error: 'forbidden' }), true;
          const x = await readBody(req);
          if (!STATUS.includes(x.status)) bad('Choose the status'); if (!(+x.progress >= 0 && +x.progress <= 100)) bad('Progress must be 0–100');
          const bg = budget(pid), snap = { budget: bg.totals.budget, actual: bg.totals.actual, committed: bg.totals.committed, cost_at_completion: bg.forecast.cost_at_completion, margin: bg.forecast.margin, invoiced: bg.invoiced, boq_progress: bg.progress };
          const r = db.prepare('INSERT INTO project_updates(project_id,date,status,progress,summary,author,snapshot) VALUES(?,?,?,?,?,?,?)').run(pid, x.date || today(), x.status, +x.progress, String(x.summary || ''), me.username, JSON.stringify(snap));
          if (['at_risk', 'off_track'].includes(x.status)) notify({ roles: ['admin'] }, { title: `مشروع ${x.status === 'at_risk' ? 'في خطر' : 'خارج المسار'} / Project ${x.status.replace('_', ' ')}`, body: `${project(pid).name}: ${String(x.summary || '').slice(0, 150)}`, url: `#projects/${pid}` });
          audit(req, 'create', 'project_updates', Number(r.lastInsertRowid), x.status);
          return send(res, 200, { id: Number(r.lastInsertRowid), snapshot: snap }), true;
        }
      }
      // ----- tasks -----
      if (a === 'tasks') {
        if (m === 'GET' && !b) {
          let rows = db.prepare('SELECT * FROM tasks WHERE parent_id IS NULL ORDER BY (status IN (\'done\',\'cancelled\')), COALESCE(due_date,\'9999\'), id').all();
          if (q.get('project_id')) rows = rows.filter(t => t.project_id === +q.get('project_id'));
          if (q.get('entity')) rows = rows.filter(t => t.entity === q.get('entity') && t.entity_id === +q.get('entity_id'));
          if (q.get('mine') || !staff(me)) rows = rows.filter(t => t.assignee_user_id === me.id);            // portal users only ever see their own
          if (q.get('open')) rows = rows.filter(t => !['done', 'cancelled'].includes(t.status));
          return send(res, 200, rows.filter(t => canSee(t, me)).map(taskRow)), true;
        }
        if (m === 'GET' && b === 'people') return send(res, 200, staff(me) ? db.prepare('SELECT id, username, display_name FROM users WHERE COALESCE(disabled,0)=0 ORDER BY username').all() : []), true;   // names only, for assigning
        if (m === 'GET' && b) { const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(+b); if (!t || !canSee(t, me)) return send(res, 404, { error: 'not found' }), true; return send(res, 200, taskRow(t)), true; }
        if (m === 'POST' && !b) {
          if (!staff(me)) return send(res, 403, { error: 'forbidden' }), true;
          const x = await readBody(req); checkTask(x);
          if (x.parent_id && !db.prepare('SELECT 1 FROM tasks WHERE id=?').get(+x.parent_id)) bad('Parent task not found');
          const parent = x.parent_id ? db.prepare('SELECT * FROM tasks WHERE id=?').get(+x.parent_id) : null;
          const r = db.prepare('INSERT INTO tasks(project_id,entity,entity_id,parent_id,title,description,assignee_user_id,due_date,status,tag,created_by,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
            .run(+x.project_id || (parent && parent.project_id) || null, x.entity || null, +x.entity_id || null, +x.parent_id || null, String(x.title).trim(), x.description || '', +x.assignee_user_id || null, x.due_date || null, x.status || 'todo', x.tag || null, me.id, now());
          const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(Number(r.lastInsertRowid)); pingAssignee(t, me);
          audit(req, 'create', 'tasks', t.id, t.title);
          return send(res, 200, taskRow(t)), true;
        }
        if (m === 'PUT' && b) {
          const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(+b); if (!t || !canSee(t, me)) return send(res, 404, { error: 'not found' }), true;
          const x = await readBody(req), keys = canEdit(t, me) ? ['title', 'description', 'assignee_user_id', 'due_date', 'status', 'tag', 'project_id'] : t.assignee_user_id === me.id ? ['status'] : [];
          const upd = Object.fromEntries(Object.entries(x).filter(([k]) => keys.includes(k)));
          if (!Object.keys(upd).length) return send(res, 403, { error: 'you cannot change this task' }), true;
          checkTask(upd, true);
          for (const k of ['assignee_user_id', 'project_id']) if (k in upd) upd[k] = +upd[k] || null;
          if (upd.status) upd.done_at = upd.status === 'done' ? now() : null;
          db.prepare(`UPDATE tasks SET ${Object.keys(upd).map(k => k + '=?').join(',')} WHERE id=?`).run(...Object.values(upd), t.id);
          const n = db.prepare('SELECT * FROM tasks WHERE id=?').get(t.id);
          if (upd.assignee_user_id && upd.assignee_user_id !== t.assignee_user_id) pingAssignee(n, me);
          if (upd.status === 'done' && t.status !== 'done' && t.created_by && t.created_by !== me.id) notify([t.created_by], { title: 'أُنجزت مهمة / Task done', body: `${t.title} — ${me.username}`, url: `#tasks/${t.id}` });
          return send(res, 200, taskRow(n)), true;
        }
        if (m === 'DELETE' && b) {
          const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(+b); if (!t) return send(res, 404, { error: 'not found' }), true;
          if (!(manager(me) || t.created_by === me.id)) return send(res, 403, { error: 'forbidden' }), true;
          db.prepare('DELETE FROM tasks WHERE id=? OR parent_id=?').run(t.id, t.id); db.prepare("DELETE FROM notes WHERE entity='task' AND entity_id=?").run(t.id);
          audit(req, 'delete', 'tasks', t.id, t.title); return send(res, 200, { ok: 1 }), true;
        }
      }
      // ----- notes -----
      if (a === 'notes') {
        if (!staff(me)) return send(res, 403, { error: 'forbidden' }), true;
        if (m === 'GET') return send(res, 200, db.prepare('SELECT id,username,body,created,user_id FROM notes WHERE entity=? AND entity_id=? ORDER BY id DESC LIMIT 200').all(String(q.get('entity')), +q.get('id'))), true;
        if (m === 'POST') { const x = await readBody(req); return send(res, 200, addNote(String(x.entity), +x.entity_id, x.body, me)), true; }
        if (m === 'DELETE' && b) { const n = db.prepare('SELECT * FROM notes WHERE id=?').get(+b); if (!n) return send(res, 404, { error: 'not found' }), true; if (!(n.user_id === me.id || me.role === 'admin')) return send(res, 403, { error: 'forbidden' }), true; db.prepare('DELETE FROM notes WHERE id=?').run(n.id); return send(res, 200, { ok: 1 }), true; }
      }
      return false;
    },
  };
};
