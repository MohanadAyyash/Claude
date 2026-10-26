// Contract terms of a project: advance payment (invoiced with VAT, recovered at a % of every progress invoice until cleared)
// and retention released in two stages — at handover and after the defects-liability period (DLP) — with dashboard alerts when due.
module.exports = ctx => {
  const { db, send, bad, audit, readBody, getSettings, today, round, enrich, nextNumber, C } = ctx;
  const addCol = (t, c, d) => { if (!db.prepare(`PRAGMA table_info(${t})`).all().some(x => x.name === c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`); };
  [['advance_pct', 'REAL DEFAULT 0'], ['advance_recovery_pct', 'REAL DEFAULT 0'], ['handover_date', 'TEXT'], ['dlp_months', 'REAL DEFAULT 12'], ['retention_handover_pct', 'REAL DEFAULT 50']].forEach(([c, d]) => addCol('projects', c, d));
  const T = ctx.TABLES.projects; T.cols.push('advance_pct', 'advance_recovery_pct', 'handover_date', 'dlp_months', 'retention_handover_pct'); T.num = [...(T.num || []), 'advance_pct', 'advance_recovery_pct', 'dlp_months', 'retention_handover_pct'];
  const prevCheck = T.check;
  T.check = r => { prevCheck && prevCheck(r); for (const k of ['advance_pct', 'advance_recovery_pct', 'retention_handover_pct']) if (r[k] !== undefined && (r[k] < 0 || r[k] > 100)) bad('Percentages must be between 0 and 100'); };

  const addMonths = (d, m) => { const x = new Date(Date.parse(d + 'T00:00:00Z')); x.setUTCMonth(x.getUTCMonth() + Math.round(m)); return x.toISOString().slice(0, 10); };
  function state(pid) {
    const p = db.prepare('SELECT * FROM projects WHERE id=?').get(pid); if (!p) return null;
    const inv = enrich().invoices.filter(i => i.project_id === pid && !i.voided);
    const advance = round(inv.filter(i => i.kind === 'advance').reduce((s, i) => s + i.subtotal, 0)), recovered = round(inv.reduce((s, i) => s + (i.recovery || 0), 0));
    const work = inv.filter(i => i.kind !== 'advance' && i.kind !== 'credit_note');
    const held = round(work.reduce((s, i) => s + i.retention, 0)), open = round(work.reduce((s, i) => s + i.retention_open, 0)), released = round(held - open);
    const first = round(held * (p.retention_handover_pct ?? 50) / 100), dlpDate = p.handover_date ? addMonths(p.handover_date, p.dlp_months ?? 12) : null;
    return { project: p,
      advance: { pct: p.advance_pct || 0, recovery_pct: p.advance_recovery_pct || p.advance_pct || 0, invoiced: advance, recovered, remaining: round(advance - recovered), invoices: inv.filter(i => i.kind === 'advance').map(i => ({ id: i.id, number: i.number, date: i.date, subtotal: i.subtotal, total: i.total, status: i.status })) },
      retention: { held, released, open, handover: { date: p.handover_date || null, pct: p.retention_handover_pct ?? 50, amount: first, outstanding: round(Math.max(0, first - released)) },
        dlp: { date: dlpDate, months: p.dlp_months ?? 12, amount: round(held - first), outstanding: round(Math.min(open, held - first)) } } };
  }
  // used by the progress invoice (server.js): the recovery line, or nothing when there is no advance left
  ctx.advanceRecoveryLine = (proj, gross) => {
    const s = state(proj.id); if (!s || s.advance.remaining <= 0.004 || !(gross > 0)) return null;
    const rate = s.advance.recovery_pct, amt = round(Math.min(s.advance.remaining, gross * rate / 100));
    if (!(amt > 0)) return null;
    return { description: `Less: advance payment recovery (${rate}% — balance ${(s.advance.remaining - amt).toFixed(2)} after this invoice)`, unit: '', qty: 1, rate: -amt, vat: 'std', recovery: true };
  };
  ctx.hooks.alerts = (add, t) => {
    for (const p of db.prepare("SELECT id FROM projects WHERE handover_date IS NOT NULL AND status!='cancelled'").all()) {
      const s = state(p.id), r = s.retention;
      if (r.handover.date <= t && r.handover.outstanding > 0.5) add('warn', 'retention_handover', { who: s.project.name, date: r.handover.date, amount: r.handover.outstanding });
      if (r.dlp.date && r.dlp.date <= t && r.dlp.outstanding > 0.5) add('warn', 'retention_dlp', { who: s.project.name, date: r.dlp.date, amount: r.dlp.outstanding });
    }
  };

  return {
    async handle(req, res, url, [a, b, c], me) {
      if (a !== 'projects' || !b) return false;
      if (c === 'contract' && req.method === 'GET') { const s = state(+b); if (!s) return send(res, 404, { error: 'not found' }), true; delete s.project; return send(res, 200, s), true; }
      if (c === 'advance-invoice' && req.method === 'POST') {
        const p = db.prepare('SELECT * FROM projects WHERE id=?').get(+b); if (!p) return send(res, 404, { error: 'not found' }), true;
        const st = getSettings(); if (st.vat_registered !== '0' && !C.validTrn(st.trn)) bad('Enter your company TRN (15 digits) in Settings before issuing tax invoices');
        const x = await readBody(req), pct = +x.pct || p.advance_pct;
        if (!(pct > 0 && pct <= 100)) bad('Set the advance payment % on the project first');
        if (!(p.contract_value > 0)) bad('Enter the contract value first');
        if (state(p.id).advance.invoiced > 0) bad('An advance payment invoice already exists for this project — void it first to issue another');
        const amount = round(p.contract_value * pct / 100), rec = p.advance_recovery_pct || pct;
        const items = [{ description: `Advance payment ${pct}% of the contract value (${p.contract_value.toFixed(2)} AED)`, unit: '', qty: 1, rate: amount, vat: 'std' }];
        const r = db.prepare("INSERT INTO invoices(number,date,due_date,project_id,items,vat_pct,retention_pct,notes,kind) VALUES(?,?,?,?,?,?,0,?,'advance')")
          .run(nextNumber('invoices', 'INV'), x.date || today(), x.due_date || null, p.id, JSON.stringify(items), +st.vat_pct || 5,
            `Advance payment against the advance payment guarantee; recovered at ${rec}% of each progress invoice. VAT is due on the advance (tax point = date of invoice / receipt).`);
        if (!p.advance_pct) db.prepare('UPDATE projects SET advance_pct=? WHERE id=?').run(pct, p.id);
        audit(req, 'create', 'advance_invoice', Number(r.lastInsertRowid), `${p.name} ${pct}%`);
        return send(res, 200, { id: Number(r.lastInsertRowid), amount }), true;
      }
      return false;
    },
  };
};
