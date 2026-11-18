// Petty cash held by employees (custody): an employee asks for petty cash, an approver decides (same rule as expense claims:
// ctx.staffApproval), the accounts hand it over (bank or cash), the employee records what was spent with the receipts — as
// expense claims "paid from my petty cash", approved under the same rule and booked on the project — and returns what is left.
//
// Account 1010 stays the petty-cash account. A hand-over is a petty_topups row with the employee (Dr 1010 / Cr bank or cash), a
// return is a petty_topups row of kind 'return' (Dr bank or cash / Cr 1010), an approved custody expense is a bill paid with
// method 'petty' and the employee (Cr 1010). Rows without an employee are the general float, as before.
// In the employee statement the cash an employee holds shows in brackets (owed to the company until spent or returned).
const { esc, money, bi } = require('../lib/render');

module.exports = ctx => {
  const { db, send, bad, audit, readBody, today, round, getSettings } = ctx;
  const cols = t => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
  for (const [c, def] of [['employee_id', 'INTEGER'], ['kind', "TEXT DEFAULT 'topup'"], ['method', "TEXT DEFAULT 'bank'"], ['bank_account_id', 'INTEGER'], ['request_id', 'INTEGER'], ['reference', 'TEXT'], ['created_by', 'TEXT']])
    if (!cols('petty_topups').includes(c)) db.exec(`ALTER TABLE petty_topups ADD COLUMN ${c} ${def}`);
  if (!cols('expense_claims').includes('paid_from')) db.exec("ALTER TABLE expense_claims ADD COLUMN paid_from TEXT DEFAULT 'own'");
  db.exec(`CREATE TABLE IF NOT EXISTS petty_requests(id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL, amount REAL NOT NULL, purpose TEXT, status TEXT DEFAULT 'pending',
    requested_by TEXT, requested_by_id INTEGER, created TEXT, decided_by TEXT, decided_by_id INTEGER, decided_at TEXT, decision_note TEXT, topup_id INTEGER)`);

  const isDate = d => /^\d{4}-\d\d-\d\d$/.test(d || '');
  const now = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().replace('T', ' ').slice(0, 16); };
  const lockDate = () => { const d = getSettings().lock_date; return isDate(d) ? d : ''; };
  const guardDate = (d, what) => { const l = lockDate(); if (l && d <= l) bad(`The accounting period is closed up to ${l} — ${what} dated ${d} cannot be added, changed or removed.`); };
  const refuse = msg => { const e = new Error(msg); e.status = 403; throw e; };
  const emp = id => db.prepare('SELECT * FROM employees WHERE id=?').get(+id);
  const FIN = me => ['admin', 'accountant'].includes(me.role);
  const ping = (ids, title, body, url) => { if (ctx.notify && ids.length) ctx.notify(ids, { title, body, url }).catch(() => {}); };

  // ---------------- custody per employee ----------------
  ctx.custodySection = ['1010', 'Petty cash held', 'عهدة نقدية بحوزته'];
  ctx.custodyMoves = eid => {
    const out = [];
    for (const t of db.prepare('SELECT * FROM petty_topups WHERE employee_id=? ORDER BY date, id').all(eid))
      out.push(t.kind === 'return'
        ? { date: t.date, ref: `PETTY-${t.id}`, id: t.id, kind: 'return', section: 'custody', amount: round(t.amount), description: 'Petty cash returned to the company', description_ar: 'إرجاع عهدة للشركة' }
        : { date: t.date, ref: `PETTY-${t.id}`, id: t.id, kind: 'handover', section: 'custody', amount: -round(t.amount), description: `Petty cash handed over${t.note ? ' — ' + t.note : ''}`, description_ar: `استلام عهدة نقدية${t.note ? ' — ' + t.note : ''}` });
    for (const p of db.prepare("SELECT p.*, b.description bdesc FROM payments p LEFT JOIN bills b ON b.id=p.bill_id WHERE p.method='petty' AND p.kind='out' AND p.employee_id=? ORDER BY p.date, p.id").all(eid))
      out.push({ date: p.date, ref: p.reference || `PAY-${p.id}`, id: p.id, kind: 'spent', section: 'custody', amount: round(p.amount), description: `Spent from petty cash — ${p.bdesc || ''}`, description_ar: `مصروف من العهدة — ${p.bdesc || ''}` });
    return out;
  };
  const held = eid => round(-ctx.custodyMoves(eid).reduce((s, m) => s + m.amount, 0));          // cash the employee holds
  const pendingSpend = eid => round(db.prepare("SELECT COALESCE(SUM(amount+vat_amount),0) s FROM expense_claims WHERE employee_id=? AND status='pending' AND paid_from='custody'").get(eid).s);
  ctx.custodyHeld = held;
  // the lowest point the employee's petty cash reaches over time, with a change applied (a spend added, a movement left out) —
  // a backdated spend or return, or deleting an old hand-over, must never leave the employee holding less than nothing on any day.
  // Same day: hand-overs first, then spends, then returns.
  const lowest = (eid, { spend, skip } = {}) => {
    const ord = { handover: 0, spent: 1, return: 2 };
    const mv = ctx.custodyMoves(eid).filter(m => !(skip && m.kind !== 'spent' && m.id === skip));
    if (spend) mv.push({ date: spend.date, kind: spend.kind || 'spent', amount: round(spend.amount) });
    mv.sort((x, y) => x.date < y.date ? -1 : x.date > y.date ? 1 : ord[x.kind] - ord[y.kind]);
    let bal = 0, min = 0, at = null;
    for (const m of mv) { bal = round(bal - m.amount); if (bal < min - 0.005) { min = bal; at = m.date; } }
    return { min, at };
  };
  ctx.custodyLowest = lowest;
  ctx.custodyAvailable = eid => round(held(eid) - pendingSpend(eid));                          // what is left to spend after the claims already waiting
  // 1010 movements that are not petty cash held by an employee — the office float, petty-cash payments and receipts with no
  // employee, manual journal lines on 1010 — as credit − debit, so the daily check can compare the rest with the statements
  ctx.custodyUnassigned = () => {
    const t = db.prepare("SELECT COALESCE(SUM(CASE WHEN kind='return' THEN amount ELSE -amount END),0) s FROM petty_topups WHERE employee_id IS NULL").get().s;
    const p = db.prepare("SELECT COALESCE(SUM(CASE WHEN kind='in' THEN -amount ELSE amount END),0) s FROM payments WHERE method='petty' AND employee_id IS NULL AND COALESCE(cheque_status,'')!='bounced'").get().s;
    let j = 0;
    for (const r of db.prepare('SELECT lines FROM journal_entries').all()) { let ls = []; try { ls = JSON.parse(r.lines || '[]'); } catch {} for (const l of ls) if (String(l.account) === '1010') j += (+l.credit || 0) - (+l.debit || 0); }
    return round(t + p + j);
  };

  // ---------------- requests ----------------
  // the accountant's limit counts everything of this employee asked for the same day (no splitting a request in two)
  const reqDayTotal = r => round(db.prepare("SELECT COALESCE(SUM(amount),0) s FROM petty_requests WHERE employee_id=? AND substr(created,1,10)=? AND status!='rejected'").get(r.employee_id, String(r.created || '').slice(0, 10)).s);
  const reqView = r => ({ ...r, employee_name: emp(r.employee_id)?.name || '', held: held(r.employee_id) });
  function createRequest(x, eid, me) {
    if (!emp(eid)) bad('Select the employee');
    const amount = round(+x.amount); if (!(amount > 0)) bad('Enter the amount');
    if (!String(x.purpose || '').trim()) bad('Write what the petty cash is for');
    const r = db.prepare('INSERT INTO petty_requests(employee_id,amount,purpose,status,requested_by,requested_by_id,created) VALUES(?,?,?,?,?,?,?)').run(+eid, amount, String(x.purpose).trim().slice(0, 300), 'pending', me.username, me.id, now());
    const ids = db.prepare("SELECT id, role FROM users WHERE COALESCE(disabled,0)=0 AND role IN ('admin','manager','accountant')").all()
      .filter(u => u.role !== 'accountant' || (ctx.staffApproval.accountantLimit() && amount <= ctx.staffApproval.accountantLimit() + 0.005)).map(u => u.id).filter(i => i !== me.id);
    ping(ids, 'طلب عهدة بانتظار موافقتك / Petty cash request to approve', `${emp(eid).name} — ${money(amount)} AED — ${String(x.purpose).trim()}`, '#claims');
    return Number(r.lastInsertRowid);
  }

  // ---------------- hand-over / return ----------------
  function moveCash(x, kind, me, req) {
    if (!FIN(me)) refuse('Petty cash is handed over and received by the accounts (administrator or accountant)');
    const e = emp(x.employee_id); if (!e) bad('Select the employee');
    const date = x.date || today(); if (!isDate(date)) bad('Enter a valid date'); guardDate(date, 'a petty cash movement');
    const amount = round(+x.amount); if (!(amount > 0)) bad('Enter the amount');
    const method = x.method === 'cash' ? 'cash' : 'bank', bank = method === 'bank' ? (+x.bank_account_id || null) : null;
    if (bank && !db.prepare('SELECT 1 FROM bank_accounts WHERE id=?').get(bank)) bad('Unknown bank account');
    let rq = null;
    if (kind === 'topup' && x.request_id) {
      rq = db.prepare('SELECT * FROM petty_requests WHERE id=?').get(+x.request_id);
      if (!rq || rq.employee_id !== e.id) bad('Request not found for this employee'); if (rq.status !== 'approved') bad('This request is not approved (or was already paid)');
      if (amount > rq.amount + 0.005) bad(`More than the approved amount (${rq.amount})`);
    } else if (kind === 'topup' && me.role !== 'admin') bad('Hand over petty cash against an approved request (the administrator may hand it over directly)');
    // the supplier-payment approval limit (Spend approvals) applies to petty cash handed over too
    const payLim = +getSettings().pay_approval_limit > 0 ? round(+getSettings().pay_approval_limit) : 0;
    if (kind === 'topup' && payLim && amount > payLim + 0.005 && me.role !== 'admin') refuse(`Above the payment approval limit (${money(payLim)}) — only the administrator can hand this over`);
    if (kind === 'return') {
      const h = held(e.id), free = round(h - pendingSpend(e.id));
      if (amount > h + 0.005) bad(`${e.name} holds ${h} of petty cash`);
      if (amount > free + 0.005) bad(`${e.name} holds ${h}, of which ${round(h - free)} is in expenses waiting for approval — decide those first`);
      const lo = lowest(e.id, { spend: { date, amount, kind: 'return' } }); if (lo.at) bad(`${e.name} did not hold that much petty cash on ${lo.at} — check the date`);
    }
    const r = db.prepare('INSERT INTO petty_topups(date,amount,note,employee_id,kind,method,bank_account_id,request_id,reference,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(date, amount, String(x.note || (rq ? rq.purpose : '') || '').slice(0, 300), e.id, kind, method, bank, rq ? rq.id : null, x.reference || '', me.username);
    const id = Number(r.lastInsertRowid);
    if (rq) db.prepare("UPDATE petty_requests SET status='paid', topup_id=? WHERE id=?").run(id, rq.id);
    audit(req, 'create', 'petty_custody', id, `${kind} ${e.name} ${amount}`);
    return id;
  }

  // ---------------- printable acknowledgement of receipt ----------------
  ctx.renderers = ctx.renderers || {};
  ctx.renderers.custody_receipt = id => {
    const t = db.prepare("SELECT * FROM petty_topups WHERE id=? AND employee_id IS NOT NULL AND COALESCE(kind,'topup')='topup'").get(+id);
    if (!t) { const er = new Error('not found'); er.status = 404; throw er; }
    const e = emp(t.employee_id), S = getSettings();
    const body = `<h1 style="font-size:16pt;margin:0 0 4mm">${bi(S, 'Acknowledgement of petty cash received', 'إقرار استلام عهدة نقدية')}</h1>
      <p>${bi(S, 'Reference', 'المرجع')}: <b>PETTY-${t.id}</b> · ${bi(S, 'Date', 'التاريخ')}: <b>${esc(t.date)}</b></p>
      <p style="margin-top:4mm">I, <b>${esc(e ? e.name : '')}</b>${e && e.designation ? `, ${esc(e.designation)}` : ''}, received <b>AED ${money(t.amount)}</b> in ${t.method === 'cash' ? 'cash' : 'a bank transfer'} as petty cash of ${esc(S.company_name || 'the company')}${t.note ? ` for: ${esc(t.note)}` : ''}.
        I will spend it on company business only, record each expense with its receipt, and return any amount not spent when asked or when I leave.</p>
      <p dir="rtl" style="margin-top:3mm">أقرّ أنا <b>${esc(e ? e.name : '')}</b> باستلام مبلغ <b>${money(t.amount)} درهم</b> ${t.method === 'cash' ? 'نقداً' : 'بتحويل بنكي'} كعهدة نقدية من ${esc(S.company_name_ar || S.company_name || 'الشركة')}${t.note ? ` لـ: ${esc(t.note)}` : ''}،
        وأتعهد بصرفه على أعمال الشركة فقط، وتسجيل كل مصروف مع إيصاله، وإرجاع ما لم يُصرف عند الطلب أو عند ترك العمل.</p>
      <table style="width:100%;margin-top:18mm"><tr><td style="width:50%">${bi(S, 'Employee signature', 'توقيع الموظف')}: ____________________</td><td>${bi(S, 'Handed over by', 'سلّمه')}: ${esc(t.created_by || '')} ____________________</td></tr></table>`;
    return { title: `Petty cash acknowledgement PETTY-${t.id}`, filename: `petty-cash-PETTY-${t.id}`, body, ref: `PETTY-${t.id}`, date: t.date, stamp: false, signature: false };
  };

  const custodians = () => {
    const ids = db.prepare('SELECT DISTINCT employee_id id FROM petty_topups WHERE employee_id IS NOT NULL UNION SELECT DISTINCT employee_id FROM petty_requests UNION SELECT DISTINCT employee_id FROM payments WHERE method=\'petty\' AND employee_id IS NOT NULL').all().map(r => r.id);
    return ids.map(i => ({ id: i, name: emp(i)?.name || `#${i}`, status: emp(i)?.status || '', held: held(i), pending: pendingSpend(i) })).sort((a, b) => b.held - a.held || a.name.localeCompare(b.name));
  };

  return {
    async handle(req, res, url, [a, b, c, d], me) {
      const m = req.method;
      // ---------- my petty cash (any user linked to an employee) ----------
      if (a === 'me' && b === 'petty') {
        if (!me.employee_id) return send(res, 403, { error: 'this account is not linked to an employee' }), true;
        if (m === 'GET' && !c) return send(res, 200, { held: held(me.employee_id), available: ctx.custodyAvailable(me.employee_id), moves: ctx.custodyMoves(me.employee_id),
          requests: db.prepare('SELECT * FROM petty_requests WHERE employee_id=? ORDER BY id DESC LIMIT 100').all(me.employee_id) }), true;
        if (m === 'POST' && c === 'requests' && !d) { const x = await readBody(req); const id = createRequest(x, me.employee_id, me); audit(req, 'create', 'petty_requests', id, ''); return send(res, 200, { id }), true; }
        if (m === 'DELETE' && c === 'requests' && d) {
          const r = db.prepare('SELECT * FROM petty_requests WHERE id=? AND employee_id=?').get(+d, me.employee_id); if (!r) return send(res, 404, { error: 'not found' }), true;
          if (r.status !== 'pending') bad('Only a pending request can be withdrawn');
          db.prepare('DELETE FROM petty_requests WHERE id=?').run(r.id); audit(req, 'delete', 'petty_requests', r.id, 'withdrawn'); return send(res, 200, { ok: 1 }), true;
        }
        return send(res, 404, { error: 'not found' }), true;
      }
      // ---------- requests (approvers) ----------
      if (a === 'petty_requests') {
        if (m === 'GET' && !b) {
          const st = url.searchParams.get('status'), rows = db.prepare(`SELECT * FROM petty_requests ${st ? 'WHERE status=?' : ''} ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, id DESC LIMIT 500`).all(...(st ? [st] : [])).map(reqView);
          return send(res, 200, rows.map(r => { const why = r.status === 'pending' ? ctx.staffApproval.block(me, r.amount, r.employee_id, r.requested_by_id, reqDayTotal(r)) : null; return { ...r, can_decide: r.status === 'pending' && !why, block: why }; })), true;
        }
        if (m === 'POST' && !b) { const x = await readBody(req); const id = createRequest(x, x.employee_id, me); audit(req, 'create', 'petty_requests', id, 'on behalf'); return send(res, 200, { id }), true; }
        const r = b && db.prepare('SELECT * FROM petty_requests WHERE id=?').get(+b); if (!r) return send(res, 404, { error: 'not found' }), true;
        if (m === 'POST' && c === 'decide') {
          const x = await readBody(req);
          if (r.status !== 'pending') bad('This request was already decided');
          if (!['approved', 'rejected'].includes(x.status)) bad('Decision must be approved or rejected');
          const why = ctx.staffApproval.block(me, r.amount, r.employee_id, r.requested_by_id, reqDayTotal(r)); if (why) refuse(why);
          if (x.status === 'rejected' && !String(x.note || '').trim()) bad('Write the reason for the rejection');
          db.prepare('UPDATE petty_requests SET status=?, decided_by=?, decided_by_id=?, decided_at=?, decision_note=? WHERE id=?').run(x.status, me.username, me.id, now(), String(x.note || '').trim(), r.id);
          audit(req, x.status, 'petty_requests', r.id, `${r.amount}`);
          ping(db.prepare('SELECT id FROM users WHERE employee_id=?').all(r.employee_id).map(u => u.id), x.status === 'approved' ? 'تمت الموافقة على طلب العهدة / Petty cash request approved' : 'رُفض طلب العهدة / Petty cash request rejected', `${money(r.amount)} AED${x.note ? ' — ' + x.note : ''}`, '#myaccount');
          if (x.status === 'approved') ping(db.prepare("SELECT id FROM users WHERE COALESCE(disabled,0)=0 AND role IN ('admin','accountant')").all().map(u => u.id).filter(i => i !== me.id), 'عهدة معتمدة بانتظار التسليم / Approved petty cash to hand over', `${emp(r.employee_id)?.name || ''} — ${money(r.amount)} AED`, '#petty');
          return send(res, 200, reqView(db.prepare('SELECT * FROM petty_requests WHERE id=?').get(r.id))), true;
        }
        if (m === 'DELETE' && !c) {
          if (!FIN(me)) refuse('Only the accounts can delete a request');
          if (r.status === 'paid') bad('This request was handed over — delete the hand-over first');
          db.prepare('DELETE FROM petty_requests WHERE id=?').run(r.id); audit(req, 'delete', 'petty_requests', r.id, ''); return send(res, 200, { ok: 1 }), true;
        }
        return false;
      }
      // ---------- custody: hand-over and return (the accounts) ----------
      if (a === 'petty_custody') {
        if (m === 'GET' && !b) {
          const st = ctx.pettyState ? ctx.pettyState() : null;
          return send(res, 200, { custodians: custodians(), float: st ? st.balance : null, held_by_employees: round(custodians().reduce((s, x) => s + x.held, 0)),
            handovers: db.prepare("SELECT t.*, e.name employee_name FROM petty_topups t JOIN employees e ON e.id=t.employee_id ORDER BY t.date DESC, t.id DESC LIMIT 300").all(),
            approved_requests: db.prepare("SELECT * FROM petty_requests WHERE status='approved' ORDER BY id").all().map(reqView) }), true;
        }
        if (m === 'GET' && b && /^\d+$/.test(b)) { const e = emp(b); if (!e) return send(res, 404, { error: 'not found' }), true; return send(res, 200, { employee: { id: e.id, name: e.name }, held: held(e.id), available: ctx.custodyAvailable(e.id), moves: ctx.custodyMoves(e.id) }), true; }
        if (m === 'POST' && (b === 'handover' || b === 'return')) { const x = await readBody(req); return send(res, 200, { id: moveCash(x, b === 'handover' ? 'topup' : 'return', me, req) }), true; }
        if (m === 'DELETE' && b && /^\d+$/.test(b)) {
          if (!FIN(me)) refuse('Only the accounts can delete a petty cash movement');
          const t = db.prepare('SELECT * FROM petty_topups WHERE id=? AND employee_id IS NOT NULL').get(+b); if (!t) return send(res, 404, { error: 'not found' }), true;
          guardDate(t.date, 'a petty cash movement');
          if (t.kind !== 'return') {
            if (held(t.employee_id) - t.amount < -0.005 || lowest(t.employee_id, { skip: t.id }).at) bad('This petty cash was already spent — the employee would hold less than nothing');
            if (held(t.employee_id) - t.amount - pendingSpend(t.employee_id) < -0.005) bad('Part of this petty cash is in expenses waiting for approval — decide those first');
          }
          db.prepare('DELETE FROM petty_topups WHERE id=?').run(t.id);
          if (t.request_id) db.prepare("UPDATE petty_requests SET status='approved', topup_id=NULL WHERE id=?").run(t.request_id);
          audit(req, 'delete', 'petty_custody', t.id, `${t.kind} ${t.amount}`); return send(res, 200, { ok: 1 }), true;
        }
        return false;
      }
      return false;
    },
  };
};
