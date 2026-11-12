// Operations: health check, error log and daily data-integrity checks.
//   GET /api/health        public, for uptime monitors — says only whether the server and database answer
//   GET /api/ops/checks    administrator — runs the integrity checks now
//   GET /api/ops/errors    administrator — recent server errors (no request bodies, no personal data)
// The same checks run from the command line: node scripts/daily-check.js
const STARTED = Date.now();

module.exports = ctx => {
  const { db, send, round } = ctx;
  db.exec('CREATE TABLE IF NOT EXISTS error_log(id INTEGER PRIMARY KEY, ts TEXT, method TEXT, path TEXT, message TEXT, stack TEXT)');

  // ---- error log: unexpected (500) errors only; ids in the path are kept, query strings and bodies are not ----
  const KEEP_ERRORS = 5000;
  ctx.logError = (err, req) => {
    try {
      const p = String(req?.url || '').split('?')[0].slice(0, 200);
      db.prepare('INSERT INTO error_log(ts,method,path,message,stack) VALUES(?,?,?,?,?)')
        .run(new Date().toISOString(), String(req?.method || ''), p, String(err?.message || err).slice(0, 500), String(err?.stack || '').slice(0, 4000));
      db.prepare('DELETE FROM error_log WHERE id <= (SELECT MAX(id) FROM error_log) - ?').run(KEEP_ERRORS);
    } catch { /* logging must never break the response */ }
  };

  function health() {
    try {
      db.prepare('SELECT 1').get();
      return { ok: true, db: 'ok', uptime_s: Math.round((Date.now() - STARTED) / 1000), time: new Date().toISOString() };
    } catch (e) {
      return { ok: false, db: 'error', error: String(e.message || e).slice(0, 200), time: new Date().toISOString() };
    }
  }

  // ---- integrity checks: each returns { id, title, status: ok|warn|fail, detail, items? } ----
  // Items carry document numbers and record ids only — never names, amounts of individual people, IBANs or IDs.
  const CHECKS = [
    ['db_integrity', 'Database file integrity (SQLite quick_check)', () => {
      const r = db.prepare('PRAGMA quick_check').all().map(x => Object.values(x)[0]);
      return r.length === 1 && r[0] === 'ok' ? ok() : fail(`${r.length} problem(s)`, r.slice(0, 20));
    }],
    ['trial_balance', 'Trial balance: total debit equals total credit', () => {
      if (!ctx.financials) return warn('accounting module not loaded');
      const f = ctx.financials('0000-01-01', '9999-12-31'), diff = round(f.tb_debit - f.tb_credit);
      return Math.abs(diff) < 0.01 ? ok(`debit = credit = ${f.tb_debit}`) : fail(`debit ${f.tb_debit} ≠ credit ${f.tb_credit} (difference ${diff})`);
    }],
    ['manual_journals', 'Manual journal entries are balanced', () => {
      const bad = db.prepare('SELECT id, lines FROM journal_entries').all().filter(j => {
        let l; try { l = JSON.parse(j.lines || '[]'); } catch { return true; }
        const s = (l || []).reduce((t, x) => t + (+x.debit || 0) - (+x.credit || 0), 0);
        return Math.abs(round(s)) >= 0.01;
      }).map(j => `JV-${j.id}`);
      return bad.length ? fail(`${bad.length} unbalanced or unreadable entr${bad.length === 1 ? 'y' : 'ies'}`, bad) : ok();
    }],
    ['invoice_numbers', 'Tax invoice / credit note numbers: no duplicates, no gaps', () => {
      const rows = db.prepare('SELECT number FROM invoices WHERE number IS NOT NULL').all().map(r => r.number);
      const dup = [...new Set(rows.filter((n, i) => rows.indexOf(n) !== i))];
      const seq = {};
      for (const n of rows) { const m = /^(INV|CN)-(\d{4})-(\d+)$/.exec(n); if (m) (seq[`${m[1]}-${m[2]}`] ||= []).push(+m[3]); }
      const gaps = [];
      for (const [k, list] of Object.entries(seq)) {
        const have = new Set(list), max = Math.max(...list);
        for (let i = 1; i <= max && gaps.length < 50; i++) if (!have.has(i)) gaps.push(`${k}-${String(i).padStart(3, '0')}`);
      }
      if (dup.length) return fail(`${dup.length} duplicate number(s)`, dup.slice(0, 50));
      return gaps.length ? warn(`${gaps.length} missing number(s) in the sequence — check they were not deleted outside the system`, gaps) : ok(`${rows.length} document(s)`);
    }],
    ['invoice_items', 'Tax invoices have readable line items', () => {
      const bad = db.prepare('SELECT number, items FROM invoices WHERE COALESCE(voided,0)=0').all().filter(r => {
        try { const x = JSON.parse(r.items || '[]'); return !Array.isArray(x); } catch { return true; }
      }).map(r => r.number);
      return bad.length ? fail(`${bad.length} invoice(s) with corrupt items`, bad.slice(0, 50)) : ok();
    }],
    ['payment_links', 'Payments point to existing invoices / bills', () => {
      const inv = db.prepare('SELECT p.id FROM payments p LEFT JOIN invoices i ON i.id=p.invoice_id WHERE p.invoice_id IS NOT NULL AND i.id IS NULL').all();
      const bil = db.prepare('SELECT p.id FROM payments p LEFT JOIN bills b ON b.id=p.bill_id WHERE p.bill_id IS NOT NULL AND b.id IS NULL').all();
      const bad = [...inv, ...bil].map(r => `payment #${r.id}`);
      return bad.length ? fail(`${bad.length} payment(s) linked to a missing document`, bad.slice(0, 50)) : ok();
    }],
    ['payroll_math', 'Payroll rows: net = gross − deductions, no negatives', () => {
      const bad = db.prepare('SELECT id, month, gross, deductions, net FROM payroll').all()
        .filter(r => r.gross < 0 || r.net < 0 || Math.abs(round((r.gross || 0) - (r.deductions || 0) - (r.net || 0))) >= 0.01)
        .map(r => `payroll #${r.id} (${r.month})`);
      return bad.length ? warn(`${bad.length} row(s) to review`, bad.slice(0, 50)) : ok();
    }],
    ['errors_24h', 'Server errors in the last 24 hours', () => {
      const since = new Date(Date.now() - 864e5).toISOString();
      const rows = db.prepare('SELECT path, message, COUNT(*) n FROM error_log WHERE ts >= ? GROUP BY path, message ORDER BY n DESC LIMIT 20').all(since);
      const n = rows.reduce((s, r) => s + r.n, 0);
      return n ? warn(`${n} error(s)`, rows.map(r => `${r.n}× ${r.path} — ${r.message}`)) : ok();
    }],
  ];
  const ok = (detail = '') => ({ status: 'ok', detail }), warn = (detail, items) => ({ status: 'warn', detail, items }), fail = (detail, items) => ({ status: 'fail', detail, items });

  function runChecks() {
    const results = CHECKS.map(([id, title, fn]) => {
      try { return { id, title, ...fn() }; } catch (e) { return { id, title, status: 'fail', detail: `check crashed: ${String(e.message || e).slice(0, 300)}` }; }
    });
    const status = results.some(r => r.status === 'fail') ? 'fail' : results.some(r => r.status === 'warn') ? 'warn' : 'ok';
    return { status, time: new Date().toISOString(), results };
  }
  ctx.health = health; ctx.runChecks = runChecks;

  return {
    async handle(req, res, url, [a, b], me) {
      if (a !== 'ops' || req.method !== 'GET' || me?.role !== 'admin') return false;
      if (b === 'checks') return send(res, 200, runChecks()), true;
      if (b === 'errors') return send(res, 200, db.prepare('SELECT * FROM error_log ORDER BY id DESC LIMIT 200').all()), true;
      return false;
    },
  };
};
