// Interim payment certificates (IPC) for progress invoices: per BOQ item contract qty/rate, previous, this period, cumulative and %;
// summary with cumulative work, previously certified, retention (cumulative / previous / this), advance recovery, net, VAT, due.
// Revenue per worker-day: certified work of a month ÷ present days on the project's attendance, against a target (default AED 219).
const { esc, money } = require('../lib/render');

module.exports = ctx => {
  const { db, send, bad, enrich, getSettings, round, today } = ctx;
  db.exec('CREATE TABLE IF NOT EXISTS ipcs(id INTEGER PRIMARY KEY, invoice_id INTEGER UNIQUE, project_id INTEGER, seq INTEGER, lines TEXT, created TEXT)');
  const notFound = () => { const e = new Error('not found'); e.status = 404; throw e; };

  // called by the progress invoice (server.js) before billed_pct moves: the whole BOQ with its previous and new completion
  ctx.ipcSnapshot = (projectId, invoiceId) => {
    const lines = db.prepare('SELECT id, section, description, unit, qty, rate, billed_pct, done_pct FROM boq_items WHERE project_id=? ORDER BY id').all(projectId)
      .map(i => ({ boq_id: i.id, section: i.section || '', description: i.description, unit: i.unit || '', qty: i.qty, rate: i.rate, prev_pct: i.billed_pct || 0, cum_pct: Math.max(i.done_pct || 0, i.billed_pct || 0) }));
    const seq = db.prepare('SELECT COUNT(*) n FROM ipcs WHERE project_id=?').get(projectId).n + 1;
    db.prepare('INSERT INTO ipcs(invoice_id,project_id,seq,lines,created) VALUES(?,?,?,?,?)').run(invoiceId, projectId, seq, JSON.stringify(lines), today());
  };
  ctx.ipcIds = () => new Set(db.prepare('SELECT invoice_id FROM ipcs').all().map(r => r.invoice_id));

  function certificate(invoiceId) {
    const ipc = db.prepare('SELECT * FROM ipcs WHERE invoice_id=?').get(invoiceId); if (!ipc) notFound();
    const e = enrich(), inv = e.invoices.find(i => i.id === invoiceId); if (!inv) notFound();
    if (inv.voided) bad('This invoice was voided');
    const p = e.projects[ipc.project_id] || {};
    // earlier certified work of the project: progress / manual work invoices before this one (advances and credit notes excluded)
    const prior = e.invoices.filter(i => i.project_id === ipc.project_id && i.id < invoiceId && !i.voided && i.kind !== 'advance' && i.kind !== 'credit_note');
    const sum = (rows, k) => round(rows.reduce((s, i) => s + (i[k] || 0), 0));
    const lines = JSON.parse(ipc.lines).map(l => {
      const prevQ = round(l.qty * l.prev_pct / 100), cumQ = round(l.qty * l.cum_pct / 100), prevA = round(prevQ * l.rate), cumA = round(cumQ * l.rate);
      return { ...l, prev_qty: prevQ, prev_amount: prevA, this_qty: round(cumQ - prevQ), this_amount: round(cumA - prevA), cum_qty: cumQ, cum_amount: cumA };
    });
    const work = { previous: sum(prior, 'revenue'), this: inv.revenue }; work.cumulative = round(work.previous + work.this);
    const ret = { previous: sum(prior, 'retention'), this: inv.retention }; ret.cumulative = round(ret.previous + ret.this);
    const rec = { previous: sum(prior, 'recovery'), this: inv.recovery || 0 }; rec.cumulative = round(rec.previous + rec.this);   // docTotals gives the recovery as a positive amount
    const vars = round(db.prepare("SELECT COALESCE(SUM(amount),0) a FROM variations WHERE project_id=? AND status='approved'").get(ipc.project_id).a);
    return { number: `IPC-${String(ipc.seq).padStart(2, '0')}`, seq: ipc.seq, invoice: inv, project: p, contract_value: p.contract_value || 0, variations: vars, lines, work, retention: ret, recovery: rec,
      retention_pct: inv.retention_pct || 0, net: round(work.this - ret.this - rec.this), vat_pct: inv.vat_pct, vat: inv.vat, due: inv.due_now,
      boq_total: round(lines.reduce((s, l) => s + l.qty * l.rate, 0)) };
  }
  ctx.ipcCertificate = certificate;

  ctx.renderers.ipc = id => {
    const c = certificate(id), S = getSettings(), q = n => (+n || 0).toLocaleString('en-US', { maximumFractionDigits: 3 });
    const row = (label, prev, cur, cum, strong) => `<tr${strong ? ' style="font-weight:700"' : ''}><td>${label}</td><td class="n">${prev == null ? '' : money(prev)}</td><td class="n">${money(cur)}</td><td class="n">${cum == null ? '' : money(cum)}</td></tr>`;
    const body = `<style>@page{size:A4 landscape;margin:12mm 12mm 14mm} .ipc td,.ipc th{font-size:8pt;padding:1.2mm 1.5mm} .ipc th{text-align:center} h2.t{margin:2mm 0} .box{margin:2mm 0;padding:2mm 3mm} .sign{margin-top:3mm} .sign .seal{height:16mm}</style>
<h2 class="t">Interim Payment Certificate No. ${c.seq} — ${esc(c.number)}</h2>
<div class="box"><b>Project:</b> ${esc(c.project.name || '')}${c.project.code ? ` (${esc(c.project.code)})` : ''}<br><b>Employer:</b> ${esc(c.invoice.client_name || '')}${c.invoice.client_trn ? ` · TRN ${esc(c.invoice.client_trn)}` : ''}<br>
<b>Contractor:</b> ${esc(S.company_name || '')}${S.trn ? ` · TRN ${esc(S.trn)}` : ''}<br><b>Tax invoice:</b> ${esc(c.invoice.number)} · <b>Date:</b> ${esc(c.invoice.date)} · <b>Contract value:</b> AED ${money(c.contract_value)}${c.variations ? ` · <b>Approved variations:</b> AED ${money(c.variations)}` : ''}</div>
<table class="ipc"><thead><tr><th rowspan="2">#</th><th rowspan="2">Description</th><th rowspan="2">Unit</th><th rowspan="2">Contract qty</th><th rowspan="2">Rate</th><th colspan="2">Previous</th><th colspan="2">This period</th><th colspan="2">Cumulative</th><th rowspan="2">%</th></tr>
<tr><th>Qty</th><th>Amount</th><th>Qty</th><th>Amount</th><th>Qty</th><th>Amount</th></tr></thead><tbody>
${c.lines.map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.description)}</td><td>${esc(l.unit)}</td><td class="n">${q(l.qty)}</td><td class="n">${money(l.rate)}</td><td class="n">${q(l.prev_qty)}</td><td class="n">${money(l.prev_amount)}</td><td class="n">${q(l.this_qty)}</td><td class="n">${money(l.this_amount)}</td><td class="n">${q(l.cum_qty)}</td><td class="n">${money(l.cum_amount)}</td><td class="n">${round(l.cum_pct)}%</td></tr>`).join('')}
</tbody><tfoot><tr style="font-weight:700"><td></td><td>Total</td><td></td><td></td><td></td><td></td><td class="n">${money(c.lines.reduce((s, l) => s + l.prev_amount, 0))}</td><td></td><td class="n">${money(c.lines.reduce((s, l) => s + l.this_amount, 0))}</td><td></td><td class="n">${money(c.lines.reduce((s, l) => s + l.cum_amount, 0))}</td><td></td></tr></tfoot></table>
<table class="ipc" style="max-width:150mm;margin-top:3mm"><thead><tr><th style="text-align:start">Summary (AED)</th><th class="n">Previous</th><th class="n">This certificate</th><th class="n">Cumulative</th></tr></thead><tbody>
${row('Value of work done', c.work.previous, c.work.this, c.work.cumulative)}
${row(`Less: retention ${c.retention_pct}%`, -c.retention.previous, -c.retention.this, -c.retention.cumulative)}
${c.recovery.cumulative ? row('Less: advance payment recovery', -c.recovery.previous, -c.recovery.this, -c.recovery.cumulative) : ''}
${row('Net amount certified', null, c.net, null, 1)}
${row(`Add: VAT ${c.vat_pct}%`, null, c.vat, null)}
${row('Amount due this certificate', null, c.due, null, 1)}</tbody></table>
<p style="font-size:8pt">Gross cumulative ${money(c.work.cumulative)} less previously certified ${money(c.work.previous)} = this certificate ${money(c.work.this)}. VAT is charged on the work value net of the advance recovery; retention is held on the work value.</p>`;
    return { title: `Payment Certificate ${c.number}`, filename: `${c.project.code || 'PRJ'}-${c.number}`, body, ref: c.number, date: c.invoice.date, label: 'For the Contractor', receiver: 'Certified by the Employer / Consultant' };
  };

  // ---------- revenue per worker-day ----------
  const target = () => +getSettings().kpi_manday_target || 219;
  function manday(month, projectId) {
    const first = `${month}-01`, last = `${month}-31`;
    const work = enrich().invoices.filter(i => !i.voided && i.kind !== 'advance' && i.kind !== 'credit_note' && i.project_id && i.date >= first && i.date <= last && (!projectId || i.project_id === projectId));
    const days = db.prepare(`SELECT project_id, COUNT(*) n FROM attendance WHERE status='present' AND project_id IS NOT NULL AND date>=? AND date<=? ${projectId ? 'AND project_id=?' : ''} GROUP BY project_id`).all(...[first, last, ...(projectId ? [projectId] : [])]);
    const ids = new Set([...work.map(i => i.project_id), ...days.map(d => d.project_id)]), t = target();
    const names = Object.fromEntries(db.prepare('SELECT id, name, code FROM projects').all().map(p => [p.id, p]));
    const rows = [...ids].map(pid => {
      const certified = round(work.filter(i => i.project_id === pid).reduce((s, i) => s + i.revenue, 0)), wd = (days.find(d => d.project_id === pid) || {}).n || 0;
      const value = wd ? round(certified / wd) : null;
      return { project_id: pid, project: names[pid]?.name || '', code: names[pid]?.code || '', certified, worker_days: wd, per_worker_day: value, target: t, on_target: value == null ? null : value >= t };
    }).sort((a, b) => (b.per_worker_day ?? -1) - (a.per_worker_day ?? -1));
    return { month, target: t, rows };
  }
  ctx.manday = manday;

  return {
    async handle(req, res, url, [a, b], me) {
      if (a === 'project-summary' && b === 'manday' && req.method === 'GET') {
        const month = url.searchParams.get('month') || today().slice(0, 7);
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) bad('month must be YYYY-MM');
        return send(res, 200, manday(month, +url.searchParams.get('project_id') || 0)), true;
      }
      if (a === 'invoices' && b && /^\d+$/.test(b) && url.pathname.endsWith('/certificate') && req.method === 'GET') return send(res, 200, certificate(+b)), true;
      return false;
    },
  };
};
