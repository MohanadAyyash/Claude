// Payroll additions: monthly end-of-service provision (account 2300) and its settlement, salary advances with a repayment
// schedule deducted in payroll, payroll cost split across projects by attendance days (fixed when the month is finalised),
// transport allowance, rest-day compensation choice (pay +50% or a substitute day), unpaid-absence days for the gratuity.
// Everything here is additive: new tables and columns only (scripts/rollback-phase2.sql removes them).
module.exports = ctx => {
  const { db, send, bad, audit, readBody, today, round, C } = ctx;
  db.exec(`
  CREATE TABLE IF NOT EXISTS eos_provisions(id INTEGER PRIMARY KEY, month TEXT, employee_id INTEGER, amount REAL, days_rate REAL, created TEXT, UNIQUE(month, employee_id));
  CREATE TABLE IF NOT EXISTS eos_settlements(id INTEGER PRIMARY KEY, employee_id INTEGER UNIQUE, date TEXT, provision REAL, gratuity REAL, created TEXT);
  CREATE TABLE IF NOT EXISTS loans(id INTEGER PRIMARY KEY, employee_id INTEGER, request_id INTEGER, amount REAL, installments INTEGER, start_month TEXT, note TEXT, created TEXT, created_by TEXT, method TEXT DEFAULT 'bank');
  CREATE TABLE IF NOT EXISTS loan_repayments(id INTEGER PRIMARY KEY, loan_id INTEGER, payroll_id INTEGER, month TEXT, amount REAL, UNIQUE(loan_id, payroll_id));
  CREATE TABLE IF NOT EXISTS payroll_alloc(id INTEGER PRIMARY KEY, payroll_id INTEGER, project_id INTEGER, days REAL, amount REAL);
  CREATE INDEX IF NOT EXISTS payroll_alloc_pay ON payroll_alloc(payroll_id);`);
  const addCol = (t, c, d) => { if (!db.prepare(`PRAGMA table_info(${t})`).all().some(x => x.name === c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`); };
  addCol('employees', 'transport', 'REAL DEFAULT 0'); addCol('hr_requests', 'installments', 'INTEGER DEFAULT 1'); addCol('attendance', 'rest_comp', "TEXT DEFAULT 'pay'"); addCol('loans', 'method', "TEXT DEFAULT 'bank'");
  ctx.TABLES.employees.cols.push('transport'); ctx.TABLES.employees.num.push('transport');
  const now = () => new Date().toISOString().replace('T', ' ').slice(0, 16);
  const emp = id => db.prepare('SELECT * FROM employees WHERE id=?').get(id);
  const addMonths = (ym, n) => { let y = +ym.slice(0, 4), m = +ym.slice(5, 7) + n; while (m > 12) { m -= 12; y++; } while (m < 1) { m += 12; y--; } return `${y}-${String(m).padStart(2, '0')}`; };
  const monthsBetween = (a, b) => (+b.slice(0, 4) - +a.slice(0, 4)) * 12 + (+b.slice(5, 7) - +a.slice(5, 7));
  const monthEnd = ym => `${ym}-${String(C.daysInMonth(ym)).padStart(2, '0')}`;

  // ---------- days of absence without pay (gratuity, Art. 51) ----------
  // unpaid leave, days marked absent and sick days without pay (beyond 45 in the year, or in probation), each date once; half-pay sick days stay service
  ctx.unpaidDays = (e, end) => {
    const from = e.join_date || '0000-00-00', days = new Set(), iso = t => new Date(t).toISOString().slice(0, 10);
    for (const l of db.prepare("SELECT start_date,end_date FROM leave_requests WHERE employee_id=? AND type='unpaid' AND status='approved' AND start_date<=? AND end_date>=?").all(e.id, end, from))
      for (let t = Date.parse((l.start_date < from ? from : l.start_date) + 'T00:00:00Z'), z = Date.parse((l.end_date > end ? end : l.end_date) + 'T00:00:00Z'); t <= z; t += 864e5) days.add(iso(t));
    for (const r of db.prepare("SELECT date FROM attendance WHERE employee_id=? AND status='absent' AND date<=? AND date>=?").all(e.id, end, from)) days.add(r.date);
    if (ctx.sickCuts) for (const [d, cut] of ctx.sickCuts(e, end)) if (cut === 1 && d >= from) days.add(d);
    return days.size;
  };

  // ---------- advances: schedule and balance ----------
  const loanRows = eid => db.prepare('SELECT * FROM loans WHERE employee_id=? ORDER BY id').all(eid);
  const repaid = loanId => round(db.prepare("SELECT COALESCE(SUM(r.amount),0) s FROM loan_repayments r JOIN payroll p ON p.id=r.payroll_id WHERE r.loan_id=? AND p.status='final'").get(loanId).s);
  const scheduled = (l, month) => {                                        // instalment due in this month (the last one takes the rounding)
    const k = monthsBetween(l.start_month, month); if (k < 0 || k >= l.installments) return 0;
    const inst = round(l.amount / l.installments); return k === l.installments - 1 ? round(l.amount - inst * (l.installments - 1)) : inst;
  };
  const balance = l => round(l.amount - repaid(l.id));
  ctx.loanBalance = eid => round(loanRows(eid).reduce((s, l) => s + balance(l), 0));
  function createLoan({ employee_id, amount, installments, start_month, request_id, note, method }, by) {
    if (method && !['bank', 'cash'].includes(method)) bad('Paid by must be bank or cash');
    if (!emp(employee_id)) bad('Employee not found');
    if (!(+amount > 0)) bad('Advance amount must be more than 0');
    const n = Math.round(+installments || 1); if (!(n >= 1 && n <= 60)) bad('Instalments must be 1–60');
    if (start_month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(start_month)) bad('Start month must be YYYY-MM');
    let sm = start_month || today().slice(0, 7);
    if (!start_month && db.prepare("SELECT 1 FROM payroll WHERE month=? AND employee_id=? AND status='final'").get(sm, employee_id)) sm = addMonths(sm, 1);   // this month already paid → next
    const r = db.prepare('INSERT INTO loans(employee_id,request_id,amount,installments,start_month,note,created,created_by,method) VALUES(?,?,?,?,?,?,?,?,?)').run(employee_id, request_id || null, round(+amount), n, sm, note || '', now(), by || '', method || 'bank');
    return Number(r.lastInsertRowid);
  }
  ctx.hooks.onAdvanceApproved = (r, by) => { if (!db.prepare('SELECT 1 FROM loans WHERE request_id=?').get(r.id)) createLoan({ employee_id: r.employee_id, amount: r.amount, installments: r.installments || 1, request_id: r.id, note: r.details }, by); };
  // payroll generation asks for this month's deduction (hr.js payrollInputs); the repayment is linked to the payroll row
  ctx.hooks.loanDeduction = (e, month) => {
    let amt = 0; const parts = [];
    for (const l of loanRows(e.id)) { const due = Math.min(scheduled(l, month), balance(l)); if (due > 0.004) { amt += due; parts.push({ loan: l.id, amount: round(due) }); } }
    return { amount: round(amt), parts };
  };
  ctx.hooks.afterPayrollRow = (payrollId, e, month, parts) => { for (const p of parts || []) db.prepare('INSERT OR IGNORE INTO loan_repayments(loan_id,payroll_id,month,amount) VALUES(?,?,?,?)').run(p.loan, payrollId, month, p.amount); };
  ctx.loanInfo = row => {                                                  // for the payslip: deducted this month and what is left after it
    const ded = round(db.prepare('SELECT COALESCE(SUM(amount),0) s FROM loan_repayments WHERE payroll_id=?').get(row.id).s);
    const left = round(loanRows(row.employee_id).reduce((s, l) => s + l.amount - db.prepare('SELECT COALESCE(SUM(r.amount),0) s FROM loan_repayments r JOIN payroll p ON p.id=r.payroll_id WHERE r.loan_id=? AND (p.status=\'final\' OR p.id=?)').get(l.id, row.id).s, 0));
    return { deducted: ded, balance: left };
  };

  // ---------- month finalised: end-of-service provision + project split by attendance ----------
  ctx.hooks.onPayrollFinal = month => {
    const last = monthEnd(month), days = C.daysInMonth(month);
    for (const r of db.prepare("SELECT * FROM payroll WHERE month=? AND status='final'").all(month)) {
      const e = emp(r.employee_id); if (!e) continue;
      // provision: 1/12 of a year's gratuity rate on the basic wage (21 days in the first 5 years, 30 after), never above 2 years' wage in total
      if (!db.prepare('SELECT 1 FROM eos_provisions WHERE month=? AND employee_id=?').get(month, e.id)) {
        const years = e.join_date ? (Date.parse(last + 'T00:00:00Z') - Date.parse(e.join_date + 'T00:00:00Z')) / 864e5 / 365 : 0, rate = years < 5 ? 21 : 30;
        const sofar = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM eos_provisions WHERE employee_id=?').get(e.id).s;
        const amt = round(Math.max(0, Math.min((+e.basic || 0) / 30 * rate / 12, 24 * (+e.basic || 0) - sofar)));
        if (amt > 0) db.prepare('INSERT INTO eos_provisions(month,employee_id,amount,days_rate,created) VALUES(?,?,?,?,?)').run(month, e.id, amt, rate, now());
      }
      // cost split: present days on each project; other days of the month (leave, rest, no record) go to the main project
      if (!db.prepare('SELECT 1 FROM payroll_alloc WHERE payroll_id=?').get(r.id)) {
        const byProj = db.prepare("SELECT project_id, COUNT(*) n FROM attendance WHERE employee_id=? AND date>=? AND date<=? AND status='present' AND project_id IS NOT NULL GROUP BY project_id").all(e.id, `${month}-01`, last);
        const counted = byProj.reduce((s, x) => s + x.n, 0), main = r.project_id || null, shares = byProj.map(x => ({ project_id: x.project_id, days: x.n }));
        if (counted < days) { const m = shares.find(s => s.project_id === main); if (m) m.days += days - counted; else shares.push({ project_id: main, days: days - counted }); }
        let left = r.gross;
        shares.forEach((s, i) => { const amt = i === shares.length - 1 ? round(left) : round(r.gross * s.days / days); left = round(left - amt); db.prepare('INSERT INTO payroll_alloc(payroll_id,project_id,days,amount) VALUES(?,?,?,?)').run(r.id, s.project_id, s.days, amt); });
      }
    }
  };
  // payroll cost of a project: the split when there is one, the whole row on its project otherwise (months finalised before the split existed)
  ctx.projectPayrollCost = pid => round(
    db.prepare("SELECT COALESCE(SUM(a.amount),0) s FROM payroll_alloc a JOIN payroll p ON p.id=a.payroll_id WHERE p.status='final' AND a.project_id=?").get(pid).s +
    db.prepare("SELECT COALESCE(SUM(gross),0) s FROM payroll p WHERE status='final' AND project_id=? AND NOT EXISTS (SELECT 1 FROM payroll_alloc a WHERE a.payroll_id=p.id)").get(pid).s);

  // end-of-service cost of a project: each month's provision split like that month's salary (payroll_alloc, else the row's project);
  // at settlement the difference between provision and gratuity goes to the employee's main project (a release lowers the cost)
  ctx.projectEosCost = pid => {
    let t = 0;
    for (const v of db.prepare(`SELECT v.amount, p.id pay_id, p.gross, p.project_id FROM eos_provisions v JOIN payroll p ON p.month=v.month AND p.employee_id=v.employee_id AND p.status='final'`).all()) {
      const al = db.prepare('SELECT project_id, amount FROM payroll_alloc WHERE payroll_id=?').all(v.pay_id);
      if (al.length) { const mine = al.filter(a => a.project_id === pid).reduce((s, a) => s + a.amount, 0); if (mine && v.gross) t += v.amount * mine / v.gross; }
      else if (v.project_id === pid) t += v.amount;
    }
    for (const s of db.prepare('SELECT s.* FROM eos_settlements s JOIN employees e ON e.id=s.employee_id WHERE e.project_id=?').all(pid)) t += s.gratuity - s.provision;
    return round(t);
  };

  // ---------- leaving: settle the provision against the gratuity actually due ----------
  ctx.hooks.onOffboard = (e, lastDay, gratuityDue) => {
    if (db.prepare('SELECT 1 FROM eos_settlements WHERE employee_id=?').get(e.id)) return;
    const prov = round(db.prepare('SELECT COALESCE(SUM(amount),0) s FROM eos_provisions WHERE employee_id=?').get(e.id).s);
    db.prepare('INSERT INTO eos_settlements(employee_id,date,provision,gratuity,created) VALUES(?,?,?,?,?)').run(e.id, lastDay, prov, round(+gratuityDue || 0), now());
  };
  // ledger lines (accounting.js): provision Dr 5260 / Cr 2300; settlement Dr 2300 (all provided) / Cr 2200 (gratuity due) / the difference to 5260
  ctx.eosEntries = () => [
    ...db.prepare('SELECT month, SUM(amount) a FROM eos_provisions GROUP BY month').all().map(r => ({ date: monthEnd(r.month), ref: `EOS-${r.month}`, memo: `End-of-service provision ${r.month}`, lines: [['5260', r.a, 0], ['2300', 0, r.a]] })),
    ...db.prepare('SELECT s.*, e.name FROM eos_settlements s JOIN employees e ON e.id=s.employee_id').all().map(s => {
      const diff = round(s.provision - s.gratuity);
      return { date: s.date, ref: `EOS-SET-${s.employee_id}`, memo: `End-of-service settlement — ${s.name}`, lines: [['2300', s.provision, 0], ['2200', 0, s.gratuity], ['5260', diff < 0 ? -diff : 0, diff > 0 ? diff : 0]] };
    }),
  ];

  return {
    async handle(req, res, url, [a, b, c], me) {
      if (a !== 'hr' || b !== 'loans') return false;
      if (req.method === 'GET') {
        const rows = db.prepare('SELECT l.*, e.name FROM loans l JOIN employees e ON e.id=l.employee_id ORDER BY l.id DESC').all();
        return send(res, 200, rows.map(l => ({ ...l, repaid: repaid(l.id), balance: balance(l), end_month: addMonths(l.start_month, l.installments - 1), monthly: round(l.amount / l.installments) }))), true;
      }
      // how an advance created from an approved request was paid out (bank by default)
      if (req.method === 'PUT' && c) { const x = await readBody(req); if (!['bank', 'cash'].includes(x.method)) bad('Paid by must be bank or cash'); db.prepare('UPDATE loans SET method=? WHERE id=?').run(x.method, +c); audit(req, 'update', 'loans', +c, x.method); return send(res, 200, { ok: 1 }), true; }
      if (req.method === 'POST' && !c) { const x = await readBody(req), id = createLoan(x, me.username); audit(req, 'create', 'loans', id, `${x.amount} / ${x.installments}`); return send(res, 200, { id }), true; }
      return false;
    },
  };
};
