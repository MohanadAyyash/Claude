// Hired resources: labour that is not on the payroll (from a labour-supply company, or daily workers paid in cash) and rented
// equipment. Every agreement has a rate per month, day or hour and the hours that rate covers, so everything is worked out by the
// hour:  cost = workers × hours × (rate ÷ hours covered).  Hours are logged per day and project; the unbilled hours are the
// amount accrued (shown as committed cost on the project budget) until the supplier's invoice is matched or the daily workers
// are paid — which creates an ordinary bill (and, for cash, its payment), so the ledger only ever sees the invoice.
// Additive: two new tables.
module.exports = ctx => {
  const { db, send, bad, audit, readBody, getSettings, today, round } = ctx;
  const ACL = require('../lib/acl'), MONEY = ACL.MONEY;
  db.exec(`CREATE TABLE IF NOT EXISTS hire_items(id INTEGER PRIMARY KEY, type TEXT, source TEXT DEFAULT 'supplier', party_id INTEGER, name TEXT NOT NULL, ref TEXT, project_id INTEGER,
    basis TEXT DEFAULT 'month', rate REAL DEFAULT 0, base_hours REAL DEFAULT 260, start_date TEXT, end_date TEXT, returned_date TEXT, status TEXT DEFAULT 'active', notes TEXT, created TEXT);
  CREATE TABLE IF NOT EXISTS hire_logs(id INTEGER PRIMARY KEY, item_id INTEGER, date TEXT, project_id INTEGER, qty REAL DEFAULT 1, hours REAL DEFAULT 0, note TEXT, bill_id INTEGER, created_by TEXT);
  CREATE INDEX IF NOT EXISTS hire_logs_item ON hire_logs(item_id, date);`);
  const TYPES = ['labour', 'equipment'], BASIS = { month: 260, day: 10, hour: 1 };            // usual hours covered: 26 days × 10 h, one 10-hour day, one hour
  const isDate = d => /^\d{4}-\d\d-\d\d$/.test(d || '') && !isNaN(Date.parse(d));
  const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
  const hourly = i => (i.base_hours > 0 ? i.rate / i.base_hours : 0);
  const names = () => ({ P: Object.fromEntries(db.prepare('SELECT id, name FROM projects').all().map(p => [p.id, p.name])), S: Object.fromEntries(db.prepare('SELECT id, name FROM parties').all().map(p => [p.id, p.name])) });
  const cost = (l, i) => round((+l.qty || 0) * (+l.hours || 0) * hourly(i));

  function items(me, type) {
    const money = MONEY.includes(me.role), { P, S } = names(), t = today(), month = t.slice(0, 7), week = addDays(t, -5);
    return db.prepare(`SELECT * FROM hire_items ${type ? 'WHERE type=?' : ''} ORDER BY (status='active') DESC, name`).all(...(type ? [type] : [])).map(i => {
      const logs = db.prepare('SELECT * FROM hire_logs WHERE item_id=?').all(i.id), open = logs.filter(l => !l.bill_id), h = ls => round(ls.reduce((s, l) => s + l.qty * l.hours, 0));
      const last = logs.reduce((m, l) => (l.date > m ? l.date : m), ''), active = i.status === 'active';
      const { rate, base_hours, ...pub } = i;
      return { ...pub, party_name: S[i.party_id] || '', project_name: P[i.project_id] || '', hours_total: h(logs), hours_month: h(logs.filter(l => l.date.startsWith(month))), hours_open: h(open), last_log: last || null,
        overdue: active && !!i.end_date && i.end_date < t,                                                                    // still on hire after the agreed end / return date
        idle: active && i.type === 'equipment' && (i.start_date || '') <= week && (!last || last < week),                    // rented machine with no hours for 5 days
        ...(money ? { rate, base_hours, hourly_rate: round(hourly(i)), accrued: round(open.reduce((s, l) => s + cost(l, i), 0)) } : {}) };
    });
  }
  function logs(me, q) {
    const money = MONEY.includes(me.role), { P } = names(), it = Object.fromEntries(db.prepare('SELECT * FROM hire_items').all().map(i => [i.id, i]));
    const w = [], a = []; if (q.item_id) { w.push('item_id=?'); a.push(+q.item_id); } if (q.open) w.push('bill_id IS NULL');
    return db.prepare(`SELECT * FROM hire_logs ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY date DESC, id DESC LIMIT 600`).all(...a).filter(l => it[l.item_id] && (!q.type || it[l.item_id].type === q.type))
      .map(l => ({ ...l, item_name: it[l.item_id].name, type: it[l.item_id].type, source: it[l.item_id].source, project_name: P[l.project_id] || '', billed: !!l.bill_id, ...(money ? { amount: cost(l, it[l.item_id]) } : {}) }));
  }
  // unbilled hours of a project, by cost category — the project budget shows them as committed
  ctx.hiredAccrued = pid => {
    const out = { labour: 0, equipment: 0 };
    for (const l of db.prepare('SELECT l.*, i.type, i.rate, i.base_hours FROM hire_logs l JOIN hire_items i ON i.id=l.item_id WHERE l.bill_id IS NULL AND l.project_id=?').all(pid)) out[l.type] = round(out[l.type] + cost(l, l));
    return out;
  };
  function cleanItem(x, cur) {
    const o = { ...(cur || {}), ...x };
    if (!TYPES.includes(o.type)) bad('Type must be labour or equipment');
    const source = o.type === 'equipment' ? 'supplier' : o.source === 'daily' ? 'daily' : 'supplier';
    const name = String(o.name || '').trim(); if (!name) bad(o.type === 'equipment' ? 'Enter the equipment' : 'Enter the trade or the worker');
    const party = +o.party_id || null; if (source === 'supplier' && !db.prepare('SELECT 1 FROM parties WHERE id=?').get(party)) bad(o.type === 'equipment' ? 'Select the rental company' : 'Select the labour supplier');
    if (!Object.keys(BASIS).includes(o.basis)) bad('Rate basis must be month, day or hour');
    const rate = +o.rate; if (!(rate > 0)) bad('Enter the rate');
    const base = o.basis === 'hour' ? 1 : +o.base_hours || BASIS[o.basis]; if (!(base >= 1 && base <= 744)) bad('Hours covered by the rate must be between 1 and 744');
    for (const k of ['start_date', 'end_date', 'returned_date']) if (o[k] && !isDate(o[k])) bad('Check the dates');
    if (o.start_date && o.end_date && o.end_date < o.start_date) bad('The end date is before the start date');
    return { type: o.type, source, party_id: source === 'daily' ? null : party, name: name.slice(0, 200), ref: String(o.ref || '').slice(0, 100), project_id: +o.project_id || null, basis: o.basis, rate: round(rate), base_hours: base,
      start_date: o.start_date || null, end_date: o.end_date || null, returned_date: o.returned_date || null, status: o.returned_date || o.status === 'closed' ? 'closed' : 'active', notes: String(o.notes || '').slice(0, 500) };
  }
  // what is being settled: the unbilled logs of one supplier (or of the daily workers) on one project in a date range
  function pick(x, daily) {
    if (!daily && !TYPES.includes(x.type)) bad('Type must be labour or equipment');
    const pid = +x.project_id || null, from = isDate(x.from) ? x.from : '0000-00-00', to = isDate(x.to) ? x.to : today();
    const rows = db.prepare(`SELECT l.*, i.type, i.rate, i.base_hours, i.name, i.party_id, i.source FROM hire_logs l JOIN hire_items i ON i.id=l.item_id
      WHERE l.bill_id IS NULL AND l.date>=? AND l.date<=? AND COALESCE(l.project_id,0)=? AND ${daily ? "i.source='daily'" : "i.source='supplier' AND i.type=? AND i.party_id=?"}`).all(from, to, pid || 0, ...(daily ? [] : [x.type, +x.party_id]));
    if (!rows.length) bad('No unbilled hours for this selection');
    return { rows, pid, from: rows.reduce((m, r) => (r.date < m ? r.date : m), rows[0].date), to: rows.reduce((m, r) => (r.date > m ? r.date : m), rows[0].date), accrued: round(rows.reduce((s, r) => s + cost(r, r), 0)), hours: round(rows.reduce((s, r) => s + r.qty * r.hours, 0)) };
  }

  ctx.hiredAlerts = add => {
    for (const i of items({ role: 'admin' })) { if (i.overdue) add('warn', 'hire_overdue', { who: i.name, date: i.end_date }); else if (i.idle) add('warn', 'hire_idle', { who: i.name, date: i.last_log || i.start_date || '' }); }
  };

  return {
    async handle(req, res, url, [a, b, c], me) {
      if (a !== 'hire') return false;
      const m = req.method, q = Object.fromEntries(url.searchParams), money = MONEY.includes(me.role), fin = ACL.can(me.role, 'POST', 'bills');
      const scope = ctx.siteScope ? ctx.siteScope(me) : null, inScope = pid => !scope || pid == null || scope.projects.has(pid);
      if (m === 'GET' && !b) return send(res, 200, items(me, TYPES.includes(q.type) ? q.type : null)), true;
      if (m === 'GET' && b === 'logs') return send(res, 200, logs(me, q)), true;
      if (m === 'GET' && b === 'accrued') {                                    // what is owed and not invoiced yet: per supplier / project, and the daily workers per project
        if (!money) return send(res, 403, { error: 'your role does not allow this action' }), true;
        const { P, S } = names(), g = {};
        for (const l of db.prepare('SELECT l.*, i.type, i.rate, i.base_hours, i.party_id, i.source FROM hire_logs l JOIN hire_items i ON i.id=l.item_id WHERE l.bill_id IS NULL').all()) {
          const k = [l.source, l.type, l.party_id || 0, l.project_id || 0].join(':'), o = g[k] || (g[k] = { source: l.source, type: l.type, party_id: l.party_id, party_name: S[l.party_id] || '', project_id: l.project_id, project_name: P[l.project_id] || '', hours: 0, amount: 0, from: l.date, to: l.date });
          o.hours = round(o.hours + l.qty * l.hours); o.amount = round(o.amount + cost(l, l)); if (l.date < o.from) o.from = l.date; if (l.date > o.to) o.to = l.date;
        }
        return send(res, 200, Object.values(g).sort((x, y) => y.amount - x.amount)), true;
      }
      // ---- agreements (rate cards): office roles ----
      if (b === 'items' && ['POST', 'PUT', 'DELETE'].includes(m)) {
        if (!(ACL.OPS.includes(me.role) || me.role === 'procurement')) return send(res, 403, { error: 'your role does not allow this action' }), true;
        const cur = c ? db.prepare('SELECT * FROM hire_items WHERE id=?').get(+c) : null; if (c && !cur) return send(res, 404, { error: 'not found' }), true;
        if (m === 'DELETE') { if (db.prepare('SELECT 1 FROM hire_logs WHERE item_id=?').get(cur.id)) bad('Hours were logged on this agreement — close it instead of deleting it'); db.prepare('DELETE FROM hire_items WHERE id=?').run(cur.id); audit(req, 'delete', 'hire_items', cur.id, cur.name); return send(res, 200, { ok: 1 }), true; }
        const r = cleanItem(await readBody(req), cur);
        if (cur && db.prepare('SELECT 1 FROM hire_logs WHERE item_id=? AND bill_id IS NOT NULL').get(cur.id) && cur.type !== r.type) bad('The type cannot change after hours were invoiced');
        if (cur) { db.prepare('UPDATE hire_items SET type=?,source=?,party_id=?,name=?,ref=?,project_id=?,basis=?,rate=?,base_hours=?,start_date=?,end_date=?,returned_date=?,status=?,notes=? WHERE id=?').run(r.type, r.source, r.party_id, r.name, r.ref, r.project_id, r.basis, r.rate, r.base_hours, r.start_date, r.end_date, r.returned_date, r.status, r.notes, cur.id); audit(req, 'update', 'hire_items', cur.id, `${r.name} ${r.rate}/${r.basis}`); return send(res, 200, { ok: 1 }), true; }
        const x = db.prepare('INSERT INTO hire_items(type,source,party_id,name,ref,project_id,basis,rate,base_hours,start_date,end_date,returned_date,status,notes,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(r.type, r.source, r.party_id, r.name, r.ref, r.project_id, r.basis, r.rate, r.base_hours, r.start_date, r.end_date, r.returned_date, r.status, r.notes, today());
        audit(req, 'create', 'hire_items', Number(x.lastInsertRowid), `${r.name} ${r.rate}/${r.basis}`); return send(res, 200, { id: Number(x.lastInsertRowid) }), true;
      }
      // ---- daily hours: office and site roles (each for the projects they may work on) ----
      if (b === 'logs' && m === 'POST' && !c) {
        const x = await readBody(req), it = db.prepare('SELECT * FROM hire_items WHERE id=?').get(+x.item_id); if (!it) bad('Select the agreement');
        if (!isDate(x.date)) bad('Enter the date'); if (x.date > today()) bad('The date cannot be in the future'); if (it.start_date && x.date < it.start_date) bad(`This agreement starts on ${it.start_date}`);
        const qty = it.type === 'equipment' ? 1 : +x.qty || 1, hours = +x.hours; if (!(qty >= 1 && qty <= 500 && Number.isInteger(qty))) bad('Number of workers must be a whole number from 1 to 500'); if (!(hours > 0 && hours <= 24)) bad('Hours must be between 0 and 24 for one day');
        const pid = +x.project_id || it.project_id || null; if (!inScope(pid)) return send(res, 403, { error: 'this project is not assigned to you' }), true;
        if (it.type === 'equipment' && db.prepare('SELECT 1 FROM hire_logs WHERE item_id=? AND date=? AND COALESCE(project_id,0)=?').get(it.id, x.date, pid || 0)) bad('Hours for this machine on this project and date are already logged — edit or delete that entry');
        const r = db.prepare('INSERT INTO hire_logs(item_id,date,project_id,qty,hours,note,created_by) VALUES(?,?,?,?,?,?,?)').run(it.id, x.date, pid, qty, round(hours), String(x.note || '').slice(0, 300), me.username);
        audit(req, 'create', 'hire_logs', Number(r.lastInsertRowid), `${it.name} ${x.date} ${qty}×${hours}h`); return send(res, 200, { id: Number(r.lastInsertRowid) }), true;
      }
      if (b === 'logs' && c && m === 'DELETE') {
        const l = db.prepare('SELECT * FROM hire_logs WHERE id=?').get(+c); if (!l) return send(res, 404, { error: 'not found' }), true;
        if (l.bill_id) bad('These hours were already invoiced or paid'); if (!inScope(l.project_id)) return send(res, 403, { error: 'this project is not assigned to you' }), true;
        db.prepare('DELETE FROM hire_logs WHERE id=?').run(l.id); audit(req, 'delete', 'hire_logs', l.id, `${l.date} ${l.qty}×${l.hours}h`); return send(res, 200, { ok: 1 }), true;
      }
      // ---- supplier's invoice against the logged hours: creates the bill and closes those hours ----
      if (b === 'invoice' && m === 'POST') {
        if (!fin) return send(res, 403, { error: 'your role cannot record supplier bills' }), true;
        const x = await readBody(req), sup = db.prepare('SELECT * FROM parties WHERE id=?').get(+x.party_id); if (!sup) bad('Select the supplier');
        const s = pick(x, false), date = x.date || today(); if (!isDate(date)) bad('Invalid date');
        const amount = x.amount === undefined || x.amount === '' ? s.accrued : +x.amount, vat = x.vat_amount === undefined || x.vat_amount === '' ? 0 : +x.vat_amount; if (!(amount > 0) || vat < 0) bad('Check the invoice amount and VAT');
        if (x.preview) return send(res, 200, { ...s, rows: undefined, lines: s.rows.length, amount, difference: round(amount - s.accrued) }), true;
        const bill = db.prepare('INSERT INTO bills(date,party_id,project_id,category,description,amount,vat_amount,reference) VALUES(?,?,?,?,?,?,?,?)').run(date, sup.id, s.pid, x.type === 'equipment' ? 'equipment' : 'labour',
          `${x.type === 'equipment' ? 'Equipment rental' : 'Hired labour'} ${s.from} → ${s.to} — ${s.hours} h${Math.abs(amount - s.accrued) > 0.01 ? ` (logged ${s.accrued.toFixed(2)})` : ''}`, round(amount), round(vat), String(x.reference || '').slice(0, 100) || null);
        const id = Number(bill.lastInsertRowid); for (const r of s.rows) db.prepare('UPDATE hire_logs SET bill_id=? WHERE id=?').run(id, r.id);
        audit(req, 'invoice', 'hire', id, `${sup.name} ${s.from}→${s.to} logged ${s.accrued} invoiced ${amount}`); return send(res, 200, { bill_id: id, accrued: s.accrued, amount: round(amount), difference: round(amount - s.accrued) }), true;
      }
      // ---- daily workers paid in cash: an expense with its payment, closes those hours ----
      if (b === 'pay-daily' && m === 'POST') {
        if (!fin) return send(res, 403, { error: 'your role cannot record payments' }), true;
        const x = await readBody(req), s = pick(x, true), date = x.date || today(), method = x.method === 'petty' ? 'petty' : 'cash'; if (!isDate(date)) bad('Invalid date');
        if (x.preview) return send(res, 200, { ...s, rows: undefined, lines: s.rows.length, amount: s.accrued }), true;
        const lim = +getSettings().pay_approval_limit; if (lim > 0 && s.accrued > lim && me.role !== 'admin') return send(res, 403, { error: `This payment is above the approval limit of ${lim} — the administrator pays it, or pay a shorter period` }), true;
        if (method === 'petty' && ctx.pettyBalance && s.accrued > ctx.pettyBalance() + 1e-9) bad(`Insufficient petty cash (balance ${ctx.pettyBalance()})`);
        const workers = [...new Set(s.rows.map(r => r.name))].slice(0, 6).join(', ');
        const bill = db.prepare('INSERT INTO bills(date,party_id,project_id,category,description,amount,vat_amount,reference) VALUES(?,?,?,?,?,?,?,?)').run(date, null, s.pid, 'labour', `Daily labour ${s.from} → ${s.to} — ${s.hours} h — ${workers}`.slice(0, 300), s.accrued, 0, 'daily labour');
        const id = Number(bill.lastInsertRowid); db.prepare("INSERT INTO payments(kind,date,amount,method,reference,bill_id) VALUES('out',?,?,?,?,?)").run(date, s.accrued, method, 'daily labour', id);
        for (const r of s.rows) db.prepare('UPDATE hire_logs SET bill_id=? WHERE id=?').run(id, r.id);
        audit(req, 'pay', 'hire', id, `daily labour ${s.from}→${s.to} ${s.accrued} ${method}`); return send(res, 200, { bill_id: id, amount: s.accrued }), true;
      }
      return send(res, 404, { error: 'not found' }), true;
    },
  };
};
