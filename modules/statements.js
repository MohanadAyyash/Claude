// Aged receivables / payables (as of any date, buckets by days past due, retention shown apart) and the statement of account
// per customer or supplier (opening balance, running balance, closing) — printable on the letterhead, as PDF, or e-mailed.
const { esc, money } = require('../lib/render');

module.exports = ctx => {
  const { send, bad, audit, readBody, getSettings, today, round, enrich, countable, sendMail, validEmail, toText } = ctx;
  const dateOk = d => /^\d{4}-\d\d-\d\d$/.test(d || '');
  const days = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);
  const BUCKETS = ['current', 'd30', 'd60', 'd90', 'd90p'];
  const bucket = n => n <= 0 ? 'current' : n <= 30 ? 'd30' : n <= 60 ? 'd60' : n <= 90 ? 'd90' : 'd90p';
  const live = p => countable(p) && p.cheque_status !== 'bounced';

  // open documents per party as of a date
  function openDocs(type, asOf) {
    const e = enrich(), out = [];
    if (type === 'receivable') {
      const pays = e.payments.filter(p => p.kind === 'in' && p.invoice_id && live(p) && p.date <= asOf);
      for (const i of e.invoices) {
        if (i.voided || i.kind === 'credit_note' || i.date > asOf || !i.client_id) continue;
        const mine = pays.filter(p => p.invoice_id === i.id);
        const paid = mine.filter(p => !p.is_retention).reduce((s, p) => s + p.amount, 0), released = mine.filter(p => p.is_retention).reduce((s, p) => s + p.amount, 0);
        const credited = e.invoices.filter(c => c.kind === 'credit_note' && !c.voided && c.original_id === i.id && c.date <= asOf).reduce((s, c) => s + Math.abs(c.total), 0);
        const open = round(i.total - i.retention - paid - credited), ret = round(i.retention - released);
        if (open <= 0.005 && ret <= 0.005) continue;
        const due = i.due_date || i.date;
        out.push({ party_id: i.client_id, ref: i.number, date: i.date, due, days: days(due, asOf), open: Math.max(0, open), retention: Math.max(0, ret), doc: 'invoice', id: i.id });
      }
    } else {
      const pays = e.payments.filter(p => p.kind === 'out' && p.bill_id && live(p) && p.date <= asOf);
      for (const b of e.bills) {
        if (b.date > asOf || !b.party_id) continue;
        const open = round(b.total - pays.filter(p => p.bill_id === b.id).reduce((s, p) => s + p.amount, 0));
        if (open <= 0.005) continue;
        out.push({ party_id: b.party_id, ref: b.reference || `#${b.id}`, date: b.date, due: b.date, days: days(b.date, asOf), open, retention: 0, doc: 'bill', id: b.id });
      }
    }
    return { e, docs: out };
  }
  function aging(type, asOf) {
    const { e, docs } = openDocs(type, asOf), rows = {};
    for (const d of docs) {
      const r = rows[d.party_id] || (rows[d.party_id] = { party_id: d.party_id, name: (e.parties[d.party_id] || {}).name || '?', current: 0, d30: 0, d60: 0, d90: 0, d90p: 0, retention: 0, total: 0, docs: [] });
      if (d.open > 0) r[bucket(d.days)] = round(r[bucket(d.days)] + d.open);
      r.retention = round(r.retention + d.retention); r.total = round(r.total + d.open); r.docs.push(d);
    }
    const list = Object.values(rows).sort((a, b) => b.total - a.total);
    const totals = Object.fromEntries([...BUCKETS, 'retention', 'total'].map(k => [k, round(list.reduce((s, r) => s + r[k], 0))]));
    return { type, as_of: asOf, rows: list, totals };
  }

  // statement of account: customers — invoices debit, credit notes and receipts credit; suppliers — bills credit, payments debit
  function statement(partyId, from, to) {
    const e = enrich(), party = e.parties[partyId]; if (!party) { const x = new Error('not found'); x.status = 404; throw x; }
    const supplier = party.type !== 'client', moves = [];
    if (!supplier) {
      const mine = new Set(e.invoices.filter(i => i.client_id === partyId).map(i => i.id));
      for (const i of e.invoices) if (mine.has(i.id) && !i.voided)
        moves.push(i.kind === 'credit_note' ? { date: i.date, ref: i.number, description: `Credit note${i.notes ? ' — ' + i.notes : ''}`, debit: 0, credit: Math.abs(i.total) }
          : { date: i.date, ref: i.number, description: `${i.kind === 'advance' ? 'Advance payment invoice' : 'Tax invoice'}${i.project_name ? ' — ' + i.project_name : ''}${i.retention ? ` (incl. retention ${money(i.retention)})` : ''}`, debit: i.total, credit: 0 });
      for (const p of e.payments) if (p.kind === 'in' && mine.has(p.invoice_id) && live(p))
        moves.push({ date: p.date, ref: p.reference || `RCPT-${p.id}`, description: `${p.is_retention ? 'Retention release received' : 'Payment received'} — ${p.ref_label}${p.method === 'cheque' ? ` (cheque${p.cheque_status === 'pending' ? ' dated ' + (p.cheque_date || '') : ''})` : ''}`, debit: 0, credit: p.amount });
    } else {
      const mine = new Set(e.bills.filter(b => b.party_id === partyId).map(b => b.id));
      for (const b of e.bills) if (mine.has(b.id)) moves.push({ date: b.date, ref: b.reference || `#${b.id}`, description: `Bill — ${b.description || b.category || ''}`, debit: 0, credit: b.total });
      for (const p of e.payments) if (p.kind === 'out' && mine.has(p.bill_id) && live(p)) moves.push({ date: p.date, ref: p.reference || `PAY-${p.id}`, description: `Payment — ${p.ref_label}`, debit: p.amount, credit: 0 });
    }
    moves.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : (b.debit - a.debit));
    const sign = supplier ? -1 : 1;                                        // balance shown as "they owe us" for customers, "we owe them" for suppliers
    const opening = round(moves.filter(m => from && m.date < from).reduce((s, m) => s + sign * (m.debit - m.credit), 0));
    let bal = opening; const lines = [];
    for (const m of moves) if ((!from || m.date >= from) && m.date <= to) { bal = round(bal + sign * (m.debit - m.credit)); lines.push({ ...m, debit: round(m.debit), credit: round(m.credit), balance: bal }); }
    const ag = aging(supplier ? 'payable' : 'receivable', to).rows.find(r => r.party_id === partyId) || null;
    return { party: { id: party.id, name: party.name, type: party.type, trn: party.trn, address: party.address, email: party.email }, supplier, from, to, opening, lines, closing: bal, aging: ag };
  }

  ctx.renderers.statement = (id, me, q) => {
    const to = q && q.get && dateOk(q.get('to')) ? q.get('to') : today(), from = q && q.get && dateOk(q.get('from')) ? q.get('from') : null, s = statement(id, from, to);
    const head = `<h1 style="font-size:16pt;margin:0 0 2mm">Statement of account / كشف حساب</h1>
      <p><b>${esc(s.party.name)}</b>${s.party.trn ? ` · TRN ${esc(s.party.trn)}` : ''}${s.party.address ? `<br>${esc(s.party.address)}` : ''}<br>${from ? `${esc(from)} → ` : 'Up to '}${esc(to)} · AED</p>`;
    const rows = s.lines.map(l => `<tr><td>${esc(l.date)}</td><td>${esc(l.ref)}</td><td>${esc(l.description)}</td><td class="n">${l.debit ? money(l.debit) : ''}</td><td class="n">${l.credit ? money(l.credit) : ''}</td><td class="n">${money(l.balance)}</td></tr>`).join('');
    const ag = s.aging ? `<h2 style="font-size:11pt;margin-top:6mm">Ageing / أعمار الأرصدة (${esc(to)})</h2><table class="items"><thead><tr><th>Not due</th><th>1–30</th><th>31–60</th><th>61–90</th><th>90+</th>${s.supplier ? '' : '<th>Retention (not yet due)</th>'}</tr></thead>
      <tbody><tr>${BUCKETS.map(k => `<td class="n">${money(s.aging[k])}</td>`).join('')}${s.supplier ? '' : `<td class="n">${money(s.aging.retention)}</td>`}</tr></tbody></table>` : '';
    const body = `${head}<table class="items"><thead><tr><th>Date</th><th>Ref</th><th>Description</th><th>Debit</th><th>Credit</th><th>Balance</th></tr></thead><tbody>
      ${from ? `<tr><td>${esc(from)}</td><td></td><td>Opening balance / رصيد افتتاحي</td><td></td><td></td><td class="n">${money(s.opening)}</td></tr>` : ''}${rows}
      <tr><td colspan="5"><b>${s.supplier ? 'Balance we owe / الرصيد المستحق لكم' : 'Balance due / الرصيد المستحق'}</b></td><td class="n"><b>${money(s.closing)}</b></td></tr></tbody></table>${ag}
      <p style="font-size:8pt;color:#8A8578;margin-top:4mm">Please advise us within 15 days of any difference. / يرجى إبلاغنا خلال ١٥ يوماً بأي فروقات.</p>`;
    return { title: `Statement — ${s.party.name}`, filename: `statement-${s.party.name.replace(/\s+/g, '-')}-${to}`, body, date: to, label: 'Accounts / الحسابات', stamp: true };
  };

  return {
    async handle(req, res, url, [a, b, c], me) {
      const q = url.searchParams;
      if (a === 'aging' && req.method === 'GET') {
        const type = b === 'payable' ? 'payable' : 'receivable', asOf = dateOk(q.get('as_of')) ? q.get('as_of') : today();
        return send(res, 200, aging(type, asOf)), true;
      }
      if (a !== 'statement' || !b) return false;
      if (req.method === 'GET') { const to = dateOk(q.get('to')) ? q.get('to') : today(), from = dateOk(q.get('from')) ? q.get('from') : null; return send(res, 200, statement(+b, from, to)), true; }
      if (req.method === 'POST' && c === 'email') {
        const x = await readBody(req), to = dateOk(x.to_date) ? x.to_date : today(), from = dateOk(x.from) ? x.from : null;
        if (!validEmail(x.to)) bad('Enter a valid email address');
        const s = statement(+b, from, to), st = getSettings(), params = new URLSearchParams({ to, ...(from ? { from } : {}) });
        let attachments = [];
        try { attachments = [{ filename: `Statement-${to}.pdf`, mime: 'application/pdf', content: await ctx.pdf(ctx.renderPage('statement', +b, me, false, params).html) }]; } catch { /* no browser: the e-mail body still lists the balance */ }
        const sig = ctx.signature(me);
        const html = `<p>Dear ${esc(s.party.name)},</p><p>${x.message ? esc(x.message) : `Please find attached your statement of account up to ${esc(to)}.`}</p>
          <p>Balance ${s.supplier ? 'payable to you' : 'due'}: <b>AED ${money(s.closing)}</b>${s.aging && s.aging.d30 + s.aging.d60 + s.aging.d90 + s.aging.d90p > 0 ? ` — of which overdue: <b>AED ${money(round(s.aging.d30 + s.aging.d60 + s.aging.d90 + s.aging.d90p))}</b>` : ''}.</p>
          <p>يرجى الاطلاع على كشف الحساب المرفق، وإبلاغنا خلال ١٥ يوماً بأي فروقات.</p>` + sig.html;
        await sendMail(ctx.mailCfg(), { to: x.to, subject: `Statement of account — ${st.company_name || ''} — ${to}`, html, text: toText(html), attachments, inline: sig.inline });
        audit(req, 'email', 'statement', +b, `to ${x.to}`);
        return send(res, 200, { ok: 1, attached: attachments.length > 0 }), true;
      }
      return false;
    },
  };
};
