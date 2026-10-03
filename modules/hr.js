// HR: leave, requests, attendance, letters, payslips and the employee self-service portal.
const { letterBody, payslipBody } = require('../lib/letters');
const { CSP } = require('../lib/render');
const LEAVE_TYPES = ['annual', 'sick', 'unpaid', 'maternity', 'paternity', 'bereavement', 'other'];
const REQ_TYPES = ['salary_certificate', 'employment_certificate', 'noc', 'salary_transfer', 'experience', 'advance', 'id_renewal', 'complaint', 'other'];
const LETTER_TYPES = ['salary_certificate', 'employment_certificate', 'noc', 'salary_transfer', 'experience'];
const ATT = ['present', 'absent', 'leave', 'sick', 'holiday', 'off'];

module.exports = ctx => {
  const { db, send, bad, audit, readBody, getSettings, today, round, C } = ctx;
  db.exec(`
  CREATE TABLE IF NOT EXISTS leave_requests(id INTEGER PRIMARY KEY, employee_id INTEGER, type TEXT, start_date TEXT, end_date TEXT, days REAL, reason TEXT, status TEXT DEFAULT 'pending', decided_by TEXT, decided_at TEXT, decision_note TEXT, created TEXT);
  CREATE TABLE IF NOT EXISTS hr_requests(id INTEGER PRIMARY KEY, employee_id INTEGER, type TEXT, details TEXT, amount REAL DEFAULT 0, status TEXT DEFAULT 'pending', decided_by TEXT, decided_at TEXT, decision_note TEXT, created TEXT, letter_id INTEGER);
  CREATE TABLE IF NOT EXISTS attendance(id INTEGER PRIMARY KEY, employee_id INTEGER, date TEXT, status TEXT DEFAULT 'present', ot_normal_hours REAL DEFAULT 0, ot_special_hours REAL DEFAULT 0, project_id INTEGER, note TEXT, UNIQUE(employee_id, date));
  CREATE TABLE IF NOT EXISTS letters(id INTEGER PRIMARY KEY, number TEXT, type TEXT, employee_id INTEGER, date TEXT, addressed_to TEXT, purpose TEXT, created_by TEXT);`);
  for (const [c, d] of [['leave_opening', 'REAL DEFAULT 0'], ['phone', 'TEXT'], ['email', 'TEXT'], ['emergency_contact', 'TEXT']])
    if (!db.prepare('PRAGMA table_info(employees)').all().some(x => x.name === c)) db.exec(`ALTER TABLE employees ADD COLUMN ${c} ${d}`);
  ctx.TABLES.employees.cols.push('leave_opening', 'phone', 'email', 'emergency_contact'); ctx.TABLES.employees.num.push('leave_opening');

  const emp = id => db.prepare('SELECT * FROM employees WHERE id=?').get(id);
  const spanDays = (a, b) => Math.round((new Date(b) - new Date(a)) / 864e5) + 1;
  const fullMonths = (from, to) => { const a = new Date(from), b = new Date(to); if (isNaN(a)) return 0; let m = (b.getFullYear() - a.getFullYear()) * 12 + b.getMonth() - a.getMonth(); if (b.getDate() < a.getDate()) m--; return Math.max(0, m); };

  // UAE labour law (Decree-Law 33/2021): 2 days/month after 6 months of service, 30 days/year after the first year; sick leave up to 90 days/year.
  function balance(e, asOf = today()) {
    const months = fullMonths(e.join_date, asOf);
    const accrued = months < 6 ? 0 : months < 12 ? 2 * months : round(2.5 * months);
    const approved = db.prepare("SELECT type, days, start_date FROM leave_requests WHERE employee_id=? AND status='approved'").all(e.id);
    const used = round(approved.filter(l => l.type === 'annual').reduce((s, l) => s + l.days, 0));
    const yearAgo = new Date(new Date(asOf).getTime() - 365 * 864e5).toISOString().slice(0, 10);
    const sick = round(approved.filter(l => l.type === 'sick' && l.start_date >= yearAgo).reduce((s, l) => s + l.days, 0));
    const unpaid = round(approved.filter(l => l.type === 'unpaid').reduce((s, l) => s + l.days, 0));
    return { months_of_service: months, accrued, opening: e.leave_opening || 0, used, balance: round(accrued + (e.leave_opening || 0) - used), sick_used_12m: sick, sick_left: Math.max(0, 90 - sick), unpaid_taken: unpaid };
  }

  function newLeave(employee_id, b, createdBy) {
    if (!emp(employee_id)) bad('Employee not found');
    if (!LEAVE_TYPES.includes(b.type)) bad('Invalid leave type');
    if (!b.start_date || !b.end_date || b.end_date < b.start_date) bad('Check the leave dates');
    const span = spanDays(b.start_date, b.end_date), days = b.days ? +b.days : span;
    if (!(days > 0) || days > span) bad('Number of days does not match the dates');
    const clash = db.prepare("SELECT 1 FROM leave_requests WHERE employee_id=? AND status IN ('pending','approved') AND start_date<=? AND end_date>=?").get(employee_id, b.end_date, b.start_date);
    if (clash) bad('There is already a leave request covering these dates');
    const r = db.prepare('INSERT INTO leave_requests(employee_id,type,start_date,end_date,days,reason,created) VALUES(?,?,?,?,?,?,?)').run(employee_id, b.type, b.start_date, b.end_date, days, b.reason || '', today());
    return Number(r.lastInsertRowid);
  }
  function newRequest(employee_id, b) {
    if (!emp(employee_id)) bad('Employee not found');
    if (!REQ_TYPES.includes(b.type)) bad('Invalid request type');
    const r = db.prepare('INSERT INTO hr_requests(employee_id,type,details,amount,created) VALUES(?,?,?,?,?)').run(employee_id, b.type, b.details || '', +b.amount || 0, today());
    return Number(r.lastInsertRowid);
  }
  function newLetter(type, employee_id, b, user) {
    if (!LETTER_TYPES.includes(type)) bad('Invalid letter type');
    if (!emp(employee_id)) bad('Employee not found');
    const number = ctx.brandRef('letters', 'number', b.addressed_to || 'HR');
    const r = db.prepare('INSERT INTO letters(number,type,employee_id,date,addressed_to,purpose,created_by) VALUES(?,?,?,?,?,?,?)').run(number, type, employee_id, today(), b.addressed_to || '', b.purpose || '', user);
    return { id: Number(r.lastInsertRowid), number };
  }

  // ---- printable renderers ----
  ctx.renderers.letter = id => {
    const l = db.prepare('SELECT * FROM letters WHERE id=?').get(id); if (!l) { const e = new Error('not found'); e.status = 404; throw e; }
    const out = letterBody(l.type, { emp: emp(l.employee_id), S: getSettings(), letter: l });
    return { title: out.title, filename: l.number.replace(/\//g, '-'), body: out.html, label: 'For the Company / عن الشركة', style: 'official', ref: l.number, date: l.date };
  };
  ctx.renderers.payslips = id => {
    const row = db.prepare('SELECT * FROM payroll WHERE id=?').get(id); if (!row) { const e = new Error('not found'); e.status = 404; throw e; }
    return { title: `Payslip ${row.month}`, filename: `payslip-${row.month}`, body: payslipBody({ emp: emp(row.employee_id), row, S: getSettings() }), stamp: false, signature: false };
  };

  // ---- payroll integration: unpaid leave + absences reduce days, attendance overtime feeds the sheet ----
  ctx.hooks.payrollInputs = (e, month, baseDays) => {
    const first = `${month}-01`, last = `${month}-${String(C.daysInMonth(month)).padStart(2, '0')}`;
    let unpaid = 0;
    for (const l of db.prepare("SELECT * FROM leave_requests WHERE employee_id=? AND type='unpaid' AND status='approved' AND start_date<=? AND end_date>=?").all(e.id, last, first))
      unpaid += spanDays(l.start_date < first ? first : l.start_date, l.end_date > last ? last : l.end_date);
    const att = db.prepare("SELECT COALESCE(SUM(ot_normal_hours),0) n, COALESCE(SUM(ot_special_hours),0) s, SUM(status='absent') a FROM attendance WHERE employee_id=? AND date>=? AND date<=?").get(e.id, first, last);
    const away = Math.min(30, unpaid + (att.a || 0));
    return { days_worked: Math.max(0, baseDays - away), leave_days: away, ot_normal_hours: att.n, ot_special_hours: att.s };
  };

  const isHr = me => ['admin', 'hr'].includes(me.role);
  const decide = (table, id, b, me, req) => {
    const r = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id); if (!r) bad('Not found');
    if (r.status !== 'pending') bad('This request was already decided');
    if (!['approved', 'rejected'].includes(b.status)) bad('Decision must be approved or rejected');
    if (table === 'leave_requests' && b.status === 'approved' && r.type === 'annual' && !b.force) {
      const bal = balance(emp(r.employee_id)).balance;
      if (r.days > bal) bad(`Insufficient annual leave balance (${bal} days available, ${r.days} requested)`);
    }
    db.prepare(`UPDATE ${table} SET status=?, decided_by=?, decided_at=?, decision_note=? WHERE id=?`).run(b.status, me.username, today(), b.note || '', id);
    audit(req, b.status, table, id, `${b.status} #${id}`);
  };

  return {
    async handle(req, res, url, [a, b, c, d], me) {
      const m = req.method;
      // ---------------- employee self-service ----------------
      if (a === 'me') {
        if (!me.employee_id) return send(res, 403, { error: 'this account is not linked to an employee' }), true;
        const e = emp(me.employee_id);
        if (!e) return send(res, 404, { error: 'employee record not found' }), true;
        if (m === 'GET' && !b) {
          return send(res, 200, {
            employee: { id: e.id, name: e.name, designation: e.designation, nationality: e.nationality, join_date: e.join_date, person_code: e.person_code, phone: e.phone, email: e.email, eid_expiry: e.eid_expiry, visa_expiry: e.visa_expiry, passport_expiry: e.passport_expiry, card_expiry: e.card_expiry },
            balance: balance(e),
            leaves: db.prepare('SELECT * FROM leave_requests WHERE employee_id=? ORDER BY id DESC').all(e.id),
            requests: db.prepare('SELECT * FROM hr_requests WHERE employee_id=? ORDER BY id DESC').all(e.id),
            payslips: db.prepare("SELECT id,month,net,paid_date FROM payroll WHERE employee_id=? AND status='final' ORDER BY month DESC").all(e.id),
          }), true;
        }
        if (m === 'POST' && b === 'leave') { const id = newLeave(e.id, await readBody(req)); audit(req, 'create', 'leave_requests', id, e.name); return send(res, 200, { id }), true; }
        if (m === 'POST' && b === 'request') { const id = newRequest(e.id, await readBody(req)); audit(req, 'create', 'hr_requests', id, e.name); return send(res, 200, { id }), true; }
        if (m === 'DELETE' && (b === 'leave' || b === 'request')) {
          const t = b === 'leave' ? 'leave_requests' : 'hr_requests', r = db.prepare(`SELECT * FROM ${t} WHERE id=? AND employee_id=?`).get(+c, e.id);
          if (!r || r.status !== 'pending') bad('Only your pending requests can be cancelled');
          db.prepare(`DELETE FROM ${t} WHERE id=?`).run(r.id); return send(res, 200, { ok: 1 }), true;
        }
        if (m === 'GET' && (b === 'payslip' || b === 'letter')) {
          let ok = false;
          if (b === 'payslip') ok = !!db.prepare("SELECT 1 FROM payroll WHERE id=? AND employee_id=? AND status='final'").get(+c, e.id);
          else ok = !!db.prepare('SELECT 1 FROM hr_requests r JOIN letters l ON l.id=r.letter_id WHERE l.id=? AND r.employee_id=? AND r.status=?').get(+c, e.id, 'approved');
          if (!ok) return send(res, 404, { error: 'not found' }), true;
          const { html, filename } = ctx.renderPage(b === 'payslip' ? 'payslips' : 'letter', +c, me, url.searchParams.get('print') === '1');
          if (d === 'pdf') { let pdf; try { pdf = await ctx.pdf(html); } catch (x) { return send(res, 503, { error: x.message }), true; } res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${filename.replace(/[^\w.-]/g, '_')}.pdf"` }); return res.end(pdf), true; }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP });
          return res.end(html), true;
        }
        return false;
      }

      // ---------------- attendance (HR + site managers) ----------------
      if (a === 'attendance') {
        if (m === 'GET') {
          const date = url.searchParams.get('date'), month = url.searchParams.get('month');
          const rows = date ? db.prepare('SELECT * FROM attendance WHERE date=?').all(date) : db.prepare('SELECT * FROM attendance WHERE date>=? AND date<=? ORDER BY date').all(`${month}-01`, `${month}-31`);
          return send(res, 200, { roster: db.prepare("SELECT id,name,designation,project_id FROM employees WHERE status='active' ORDER BY name").all(), rows }), true;
        }
        if (m === 'PUT') {
          const x = await readBody(req);
          if (!emp(+x.employee_id)) bad('Employee not found'); if (!/^\d{4}-\d\d-\d\d$/.test(x.date || '')) bad('Invalid date'); if (!ATT.includes(x.status)) bad('Invalid status');
          db.prepare(`INSERT INTO attendance(employee_id,date,status,ot_normal_hours,ot_special_hours,project_id,note) VALUES(?,?,?,?,?,?,?)
            ON CONFLICT(employee_id,date) DO UPDATE SET status=excluded.status, ot_normal_hours=excluded.ot_normal_hours, ot_special_hours=excluded.ot_special_hours, project_id=excluded.project_id, note=excluded.note`)
            .run(+x.employee_id, x.date, x.status, +x.ot_normal_hours || 0, +x.ot_special_hours || 0, +x.project_id || null, x.note || '');
          return send(res, 200, { ok: 1 }), true;
        }
        return false;
      }

      // ---------------- HR back office ----------------
      if (a !== 'hr') return false;
      if (b === 'summary' && m === 'GET') {
        const soon = new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10);
        return send(res, 200, {
          pending_leave: db.prepare("SELECT COUNT(*) n FROM leave_requests WHERE status='pending'").get().n, pending_requests: db.prepare("SELECT COUNT(*) n FROM hr_requests WHERE status='pending'").get().n,
          active_employees: db.prepare("SELECT COUNT(*) n FROM employees WHERE status='active'").get().n,
          on_leave_today: db.prepare("SELECT COUNT(*) n FROM leave_requests WHERE status='approved' AND start_date<=? AND end_date>=?").get(today(), today()).n,
          expiring: db.prepare("SELECT name,eid_expiry,visa_expiry,passport_expiry,card_expiry FROM employees WHERE status='active' AND ((eid_expiry IS NOT NULL AND eid_expiry<?) OR (visa_expiry IS NOT NULL AND visa_expiry<?) OR (passport_expiry IS NOT NULL AND passport_expiry<?) OR (card_expiry IS NOT NULL AND card_expiry<?))").all(soon, soon, soon, soon),
        }), true;
      }
      if (b === 'balances' && m === 'GET') return send(res, 200, db.prepare("SELECT * FROM employees WHERE status='active' ORDER BY name").all().map(e => ({ employee_id: e.id, name: e.name, join_date: e.join_date, ...balance(e) }))), true;
      if (b === 'leave') {
        if (m === 'GET') return send(res, 200, db.prepare('SELECT l.*, e.name FROM leave_requests l JOIN employees e ON e.id=l.employee_id ORDER BY (l.status=\'pending\') DESC, l.id DESC').all()), true;
        if (m === 'POST' && !c) { const body = await readBody(req), id = newLeave(+body.employee_id, body); audit(req, 'create', 'leave_requests', id, 'by HR'); return send(res, 200, { id }), true; }
        if (m === 'PUT' && d === 'decide') { decide('leave_requests', +c, await readBody(req), me, req); return send(res, 200, { ok: 1 }), true; }
        if (m === 'DELETE') { db.prepare('DELETE FROM leave_requests WHERE id=?').run(+c); audit(req, 'delete', 'leave_requests', +c); return send(res, 200, { ok: 1 }), true; }
      }
      if (b === 'requests') {
        if (m === 'GET') return send(res, 200, db.prepare('SELECT r.*, e.name FROM hr_requests r JOIN employees e ON e.id=r.employee_id ORDER BY (r.status=\'pending\') DESC, r.id DESC').all()), true;
        if (m === 'POST' && !c) { const body = await readBody(req), id = newRequest(+body.employee_id, body); audit(req, 'create', 'hr_requests', id, 'by HR'); return send(res, 200, { id }), true; }
        if (m === 'PUT' && d === 'decide') { decide('hr_requests', +c, await readBody(req), me, req); return send(res, 200, { ok: 1 }), true; }
        if (m === 'DELETE') { db.prepare('DELETE FROM hr_requests WHERE id=?').run(+c); return send(res, 200, { ok: 1 }), true; }
      }
      if (b === 'letters') {
        if (m === 'POST') {
          const x = await readBody(req), l = newLetter(x.type, +x.employee_id, x, me.username);
          if (x.request_id) db.prepare("UPDATE hr_requests SET letter_id=?, status='approved', decided_by=?, decided_at=? WHERE id=? AND employee_id=? AND status='pending'").run(l.id, me.username, today(), +x.request_id, +x.employee_id);
          if (x.request_id) db.prepare('UPDATE hr_requests SET letter_id=? WHERE id=? AND employee_id=?').run(l.id, +x.request_id, +x.employee_id);
          audit(req, 'issue', 'letters', l.id, `${l.number} ${x.type}`);
          return send(res, 200, l), true;
        }
        if (m === 'GET') return send(res, 200, db.prepare('SELECT l.*, e.name FROM letters l JOIN employees e ON e.id=l.employee_id ORDER BY l.id DESC').all()), true;
      }
      return false;
    },
  };
};
