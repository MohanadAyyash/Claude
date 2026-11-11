// Treasury: cash-flow forecast for the coming months (what is expected in and out, and the balance after each month),
// the bank guarantee register (performance / advance / tender / retention bonds with expiry alerts), and an alert when a
// project is forecast to finish over its budget. Additive: one new table (bank_guarantees).
module.exports = ctx => {
  const { db, send, enrich, today, round, TABLES, C } = ctx;
  db.exec(`CREATE TABLE IF NOT EXISTS bank_guarantees(id INTEGER PRIMARY KEY, type TEXT DEFAULT 'performance', project_id INTEGER, beneficiary TEXT, bank TEXT, number TEXT,
    amount REAL DEFAULT 0, margin REAL DEFAULT 0, issue_date TEXT, expiry_date TEXT, status TEXT DEFAULT 'active', notes TEXT)`);
  const GTYPES = ['performance', 'advance', 'tender', 'retention', 'other'], GSTATUS = ['active', 'released', 'claimed'];
  Object.assign(TABLES, { bank_guarantees: { cols: ['type', 'project_id', 'beneficiary', 'bank', 'number', 'amount', 'margin', 'issue_date', 'expiry_date', 'status', 'notes'], num: ['amount', 'margin'],
    check: r => { if (r.type !== undefined && !GTYPES.includes(r.type)) ctx.bad('Invalid guarantee type'); if (r.status !== undefined && !GSTATUS.includes(r.status)) ctx.bad('Invalid status'); if (r.amount !== undefined && !(r.amount > 0)) ctx.bad('Guarantee amount must be greater than zero'); if (r.margin !== undefined && r.margin < 0) ctx.bad('Cash margin cannot be negative'); } } });

  const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
  const guarantees = () => {
    const t = today(), soon = addDays(t, 30), names = Object.fromEntries(db.prepare('SELECT id, name FROM projects').all().map(p => [p.id, p.name]));
    return db.prepare('SELECT * FROM bank_guarantees ORDER BY (status=\'active\') DESC, expiry_date, id').all().map(g => ({ ...g, project_name: names[g.project_id] || '',
      days: g.expiry_date ? Math.round((Date.parse(g.expiry_date + 'T00:00:00Z') - Date.parse(t + 'T00:00:00Z')) / 864e5) : null,
      expired: g.status === 'active' && !!g.expiry_date && g.expiry_date < t, soon: g.status === 'active' && !!g.expiry_date && g.expiry_date >= t && g.expiry_date <= soon }));
  };

  // ---------- cash-flow forecast ----------
  // Known money only: open invoices at their due date, retention at handover / end of the liability period, post-dated cheques at
  // their date, supplier bills at their date + credit days, salaries (finalized months and an estimate from the last one).
  // Anything already late is expected "now". VAT payments and work not yet invoiced are NOT in it — the screen says so.
  function forecast(months = 3) {
    months = Math.max(1, Math.min(12, Math.round(+months) || 3));
    const t = today(), e = enrich(), S = ctx.getSettings(), apDays = Math.max(0, Math.round(+S.ap_terms_days || 30));
    const pays = e.payments.filter(ctx.countable), cashIn = pays.filter(p => p.kind === 'in' && ctx.inCash(p)), cashOut = pays.filter(p => p.kind === 'out' && ctx.inCash(p));
    const opening = round(cashIn.reduce((s, p) => s + p.amount, 0) - cashOut.reduce((s, p) => s + p.amount, 0));
    const ym = d => d.slice(0, 7), next = m => { const y = +m.slice(0, 4), k = +m.slice(5, 7); return k === 12 ? `${y + 1}-01` : `${y}-${String(k + 1).padStart(2, '0')}`; };
    const buckets = []; for (let m = ym(t), i = 0; i <= months; i++, m = next(m)) buckets.push({ month: m, in: 0, out: 0 });
    const last = buckets[buckets.length - 1].month, items = [];
    const put = (dir, kind, date, amount, label, extra = {}) => {
      amount = round(amount); if (!(amount > 0.004)) return;
      const late = date < t, when = late ? t : date;
      if (ym(when) > last) return;                                           // beyond the horizon
      items.push({ dir, kind, date: when, original_date: date, late, amount, label, ...extra });
      buckets.find(b => b.month === ym(when))[dir] += amount;
    };
    const proj = e.projects;
    for (const i of e.invoices) if (!i.voided && i.kind !== 'credit_note' && i.balance > 0.004) {
      const terms = +(proj[i.project_id] || {}).payment_terms_days || 30;
      put('in', 'invoice', i.due_date || addDays(i.date, terms), i.balance, `${i.number} — ${i.client_name || ''}`, { ref: 'invoices', id: i.id, project_name: i.project_name || '' });
    }
    if (ctx.contractState) for (const p of Object.values(proj)) if (p.handover_date && p.status !== 'cancelled') {
      const r = ctx.contractState(p.id).retention;
      put('in', 'retention', r.handover.date, r.handover.outstanding, `${p.name} — retention at handover`, { project_name: p.name });
      if (r.dlp.date) put('in', 'retention', r.dlp.date, r.dlp.outstanding, `${p.name} — retention after the liability period`, { project_name: p.name });
    }
    for (const p of e.payments) if (p.method === 'cheque' && p.cheque_status === 'pending')
      put(p.kind === 'in' ? 'in' : 'out', 'cheque', p.cheque_date || p.date, p.amount, `${p.reference || 'cheque'} — ${p.party_name || ''}`, { ref: 'cheques', id: p.id, project_name: p.project_name || '' });
    // a pending cheque is not cash yet but already settles its invoice / bill, so it is not counted twice
    for (const b of e.bills) if (b.balance > 0.004) put('out', 'bill', addDays(b.date, apDays), b.balance, `${b.party_name || 'Expense'} — ${b.description || b.reference || '#' + b.id}`, { ref: 'bills', id: b.id, project_name: b.project_name || '' });
    for (const r of db.prepare("SELECT month, SUM(net) net FROM payroll WHERE status='final' AND paid_date IS NULL GROUP BY month").all())
      put('out', 'payroll', `${next(r.month)}-01`, r.net, `Salaries ${r.month}`);
    const lastPay = db.prepare("SELECT month, SUM(net) net FROM payroll WHERE status='final' GROUP BY month ORDER BY month DESC LIMIT 1").get();
    if (lastPay && lastPay.net > 0) {                                        // months not finalized yet: the last finalized month as an estimate, paid on the 1st of the following month
      const done = new Set(db.prepare("SELECT DISTINCT month FROM payroll WHERE status='final'").all().map(r => r.month));
      for (let m = ym(t); next(m) <= last; m = next(m)) if (!done.has(m)) put('out', 'payroll_est', `${next(m)}-01`, lastPay.net, `Salaries ${m} (estimate from ${lastPay.month})`, { estimate: true });
    }
    let bal = opening, low = { balance: opening, month: null };
    for (const b of buckets) { b.in = round(b.in); b.out = round(b.out); b.net = round(b.in - b.out); bal = round(bal + b.net); b.closing = bal; if (bal < low.balance) low = { balance: bal, month: b.month }; }
    items.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.dir === y.dir ? 0 : x.dir === 'in' ? -1 : 1));
    const sum = f => round(items.filter(f).reduce((s, i) => s + i.amount, 0));
    return { as_of: t, months, opening, buckets, items, lowest: low, ap_terms_days: apDays,
      totals: { in: sum(i => i.dir === 'in'), out: sum(i => i.dir === 'out'), late_in: sum(i => i.dir === 'in' && i.late), late_out: sum(i => i.dir === 'out' && i.late) } };
  }
  ctx.cashForecast = forecast;

  // ---------- alerts ----------
  ctx.treasuryAlerts = add => {
    for (const g of guarantees()) { if (g.expired) add('bad', 'guarantee_expired', { who: `${g.number || g.type}${g.project_name ? ' — ' + g.project_name : ''}`, date: g.expiry_date }); else if (g.soon) add('warn', 'guarantee_soon', { who: `${g.number || g.type}${g.project_name ? ' — ' + g.project_name : ''}`, date: g.expiry_date }); }
    if (ctx.projectBudget) for (const p of db.prepare("SELECT id, name FROM projects WHERE status='active'").all()) {
      const b = ctx.projectBudget(p.id); if (b && b.forecast.over_budget) add('warn', 'over_budget', { who: p.name, amount: round(b.forecast.cost_at_completion - b.totals.budget) });
    }
    const f = forecast(3); if (f.lowest.balance < -0.5) add('bad', 'cash_short', { month: f.lowest.month || f.as_of.slice(0, 7), amount: round(-f.lowest.balance) });
  };

  return {
    async handle(req, res, url, [a, b], me) {
      if (a === 'cashflow' && req.method === 'GET') return send(res, 200, forecast(url.searchParams.get('months') || 3)), true;
      if (a === 'bank_guarantees' && req.method === 'GET') { const rows = guarantees(); return send(res, 200, b ? rows.find(r => r.id === +b) || null : rows), true; }
      return false;
    },
  };
};
