// Controls: closed accounting period (no document dated on or before the lock date can be created, changed or removed),
// database backups (daily safety net, status, optional copy to a second folder) and the post-dated cheque register.
// Additive: no new tables — the lock date and the copy folder are settings; cheques are the payments paid by cheque.
const fs = require('node:fs'), path = require('node:path');

module.exports = ctx => {
  const { db, send, bad, audit, readBody, getSettings, enrich, today, round, DATA_DIR, C } = ctx;

  // ======================= closed period =======================
  const isDate = d => /^\d{4}-\d\d-\d\d$/.test(d || '');
  const lockDate = () => { const d = getSettings().lock_date; return isDate(d) ? d : ''; };
  const closed = d => { const l = lockDate(); return !!l && isDate(d) && d <= l; };
  const refuse = (what, d) => bad(`The accounting period is closed up to ${lockDate()} — ${what} dated ${d} cannot be added or changed. Use a date after the closing date (for a correction: a credit note or a journal entry in the open period), or ask the administrator to reopen the period in Settings.`);
  const DATED = { invoices: 'date', bills: 'date', payments: 'date', petty_topups: 'date', journal_entries: 'date', sub_certs: 'date', stock_moves: 'date' };   // records that feed the ledger
  const OPEN_ACTIONS = ['credit-note', 'email', 'pdf', 'share', 'remind', 'statement'];   // allowed on a closed document: they add nothing to the closed period
  const has = t => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  const monthEnd = m => `${m}-${String(C.daysInMonth(m)).padStart(2, '0')}`;
  // called by the server for every write, after the role and site-scope checks
  ctx.periodGuard = async (req, method, url, [a, b, c]) => {
    if (!lockDate() || method === 'GET') return;
    const body = ['POST', 'PUT', 'DELETE'].includes(method) && a !== 'documents' && a !== 'brand' ? (req._body = await readBody(req)) : {};
    if (a === 'payroll') {                                                   // a payroll month belongs to its last day
      let m = (body && body.month) || url.searchParams.get('month') || '';
      if (b && /^\d+$/.test(b)) m = db.prepare('SELECT month FROM payroll WHERE id=?').get(+b)?.month || m;
      if (/^\d{4}-\d\d$/.test(m) && closed(monthEnd(m))) refuse('payroll', m);
      if (b === 'pay' && closed(body.date || today())) refuse('a salary payment', body.date || today());
      return;
    }
    if (DATED[a] && b && /^\d+$/.test(b) && has(a) && !OPEN_ACTIONS.includes(c)) {
      const cur = db.prepare(`SELECT * FROM ${a} WHERE id=?`).get(+b);
      // a post-dated cheque received or issued in a closed period can still be marked cleared / bounced
      const chequeOnly = a === 'payments' && method === 'PUT' && body && Object.keys(body).every(k => ['cheque_status', 'bank_account_id'].includes(k));
      if (cur && closed(cur[DATED[a]]) && !chequeOnly) refuse('a document', cur[DATED[a]]);
    }
    if ((DATED[a] || ['projects', 'claims', 'client_pcs', 'pay_apps', 'bank', 'purchase_orders', 'hire'].includes(a)) && body && isDate(body.date) && closed(body.date) && !(a === 'purchase_orders' && c !== 'receive')) refuse('a document', body.date);
  };

  // ======================= backups =======================
  const BK = path.join(DATA_DIR, 'backups'), KEEP = +process.env.KEEP_DAYS || 30;
  const stamp = d => new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().replace('T', ' ').slice(0, 16);
  const list = () => { try { return fs.readdirSync(BK).filter(f => /^erp-\d{4}-\d\d-\d\d\.db$/.test(f)).map(f => { const s = fs.statSync(path.join(BK, f)); return { name: f, date: f.slice(4, 14), size: s.size, at: stamp(s.mtime), ms: s.mtimeMs }; }).sort((x, y) => (x.name < y.name ? 1 : -1)); } catch { return []; } };
  let lastCopy = null;                                                     // result of the last copy to the second folder
  function copyOut(file) {
    const dir = (getSettings().backup_copy_dir || '').trim(); if (!dir) return (lastCopy = null);
    try { fs.mkdirSync(dir, { recursive: true }); fs.copyFileSync(file, path.join(dir, path.basename(file))); lastCopy = { ok: true, at: stamp(new Date()), dir }; }
    catch (e) { lastCopy = { ok: false, at: stamp(new Date()), dir, error: String(e.message || e) }; }
    return lastCopy;
  }
  function runBackup() {
    fs.mkdirSync(BK, { recursive: true });
    const file = path.join(BK, `erp-${today()}.db`), tmp = file + '.tmp';
    fs.rmSync(tmp, { force: true }); db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`); fs.rmSync(file, { force: true }); fs.renameSync(tmp, file);   // written aside, then swapped: a half-written file never replaces a good one
    for (const f of list()) if (Date.now() - f.ms > KEEP * 864e5) fs.rmSync(path.join(BK, f.name), { force: true });
    copyOut(file);
    return file;
  }
  const status = () => {
    const files = list(), latest = files[0] || null, age = latest ? Math.floor((Date.now() - latest.ms) / 864e5) : null;
    return { folder: BK, files: files.slice(0, 30).map(({ ms, ...f }) => f), latest: latest && { name: latest.name, at: latest.at, size: latest.size }, age_days: age, stale: !latest || age >= 2,
      copy_dir: (getSettings().backup_copy_dir || '').trim(), last_copy: lastCopy, keep_days: KEEP };
  };
  ctx.backupStatus = status;
  // safety net next to the Windows scheduled task: once a day (first check after 02:00) the running server writes today's backup itself
  ctx.startBackups = () => {
    if (process.env.BACKUP_NO_SCHEDULER) return;
    const tick = () => { try { if (new Date().getHours() >= 2 && !list().some(f => f.date === today())) runBackup(); } catch (e) { console.error(new Date().toISOString(), 'backup failed', e.message); } };
    setTimeout(tick, 60e3).unref(); setInterval(tick, 3600e3).unref();
  };

  // ======================= post-dated cheques =======================
  function cheques() {
    const t = today(), d7 = new Date(Date.parse(t + 'T00:00:00Z') + 7 * 864e5).toISOString().slice(0, 10);
    const rows = enrich().payments.filter(p => p.method === 'cheque').map(p => {
      const due = p.cheque_date || p.date, st = p.cheque_status || 'cleared';
      return { id: p.id, kind: p.kind, date: p.date, due, status: st, amount: round(p.amount), reference: p.reference || '', party_name: p.party_name || '', ref_label: p.ref_label || '', project_name: p.project_name || '',
        bank_account_id: p.bank_account_id || null, days: Math.round((Date.parse(due + 'T00:00:00Z') - Date.parse(t + 'T00:00:00Z')) / 864e5), overdue: st === 'pending' && due < t, soon: st === 'pending' && due >= t && due <= d7 };
    }).sort((x, y) => (x.status === 'pending') === (y.status === 'pending') ? (x.due < y.due ? -1 : x.due > y.due ? 1 : x.id - y.id) : x.status === 'pending' ? -1 : 1);
    const sum = f => round(rows.filter(f).reduce((s, r) => s + r.amount, 0)), pend = k => r => r.status === 'pending' && r.kind === k;
    return { today: t, rows, summary: { in_pending: sum(pend('in')), out_pending: sum(pend('out')), in_week: sum(r => pend('in')(r) && (r.soon || r.overdue)), out_week: sum(r => pend('out')(r) && (r.soon || r.overdue)),
      overdue: rows.filter(r => r.overdue).length, bounced: rows.filter(r => r.status === 'bounced').length } };
  }
  ctx.chequeAlerts = add => {
    const { rows } = cheques(), pend = rows.filter(r => r.status === 'pending');
    for (const k of ['in', 'out']) {
      const late = pend.filter(r => r.kind === k && r.overdue), soon = pend.filter(r => r.kind === k && r.soon), amt = l => round(l.reduce((s, r) => s + r.amount, 0));
      if (late.length) add(k === 'out' ? 'bad' : 'warn', 'pdc_overdue_' + k, { count: late.length, amount: amt(late) });
      if (soon.length) add('warn', 'pdc_soon_' + k, { count: soon.length, amount: amt(soon) });
    }
  };

  return {
    async handle(req, res, url, [a, b], me) {
      const m = req.method;
      if (a === 'cheques' && m === 'GET') return send(res, 200, cheques()), true;
      if (a === 'backup' && b === 'status' && m === 'GET') return send(res, 200, status()), true;
      if (a === 'backup' && b === 'run' && m === 'POST') { const f = runBackup(); audit(req, 'backup', 'database', 0, path.basename(f)); return send(res, 200, status()), true; }
      if (a === 'period' && m === 'GET') return send(res, 200, { lock_date: lockDate() }), true;
      if (a === 'period' && m === 'PUT') {                                    // close up to a date, or reopen with an empty date
        const x = await readBody(req), d = String(x.lock_date || '').trim(), old = lockDate();
        if (d && (!isDate(d) || isNaN(Date.parse(d)))) bad('Closing date must be a date (YYYY-MM-DD)');
        if (d > today()) bad('The closing date cannot be in the future');
        db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run('lock_date', d);
        audit(req, d ? (old && d < old ? 'reopen' : 'close') : 'reopen', 'period', 0, `${old || 'open'} → ${d || 'open'}${x.reason ? ' — ' + String(x.reason).slice(0, 200) : ''}`);
        return send(res, 200, { lock_date: d }), true;
      }
      return false;
    },
  };
};
