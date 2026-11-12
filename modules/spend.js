// Spend approval by amount: purchase orders and supplier payments above a limit set in Settings need the administrator's
// approval before they go out. Derived, not stored on the documents: an approval is a row in spend_approvals, and a purchase
// order is "approved" while an approved row covers its current total (raising the total afterwards asks again).
// Limits empty / 0 = the control is off (default), so nothing changes until the administrator sets them.
module.exports = ctx => {
  const { db, send, bad, audit, readBody, getSettings, enrich, today, round } = ctx;
  db.exec(`CREATE TABLE IF NOT EXISTS spend_approvals(id INTEGER PRIMARY KEY, kind TEXT, ref_id INTEGER, amount REAL DEFAULT 0, status TEXT DEFAULT 'pending', note TEXT,
    requested_by TEXT, requested_by_id INTEGER, requested_at TEXT, decided_by TEXT, decided_at TEXT, decision_note TEXT);
  CREATE INDEX IF NOT EXISTS spend_approvals_ref ON spend_approvals(kind, ref_id);`);
  const now = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().replace('T', ' ').slice(0, 16); };
  const money = n => (+n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const limit = k => { const v = +getSettings()[k]; return v > 0 ? v : 0; };
  const refuse = msg => { const e = new Error(msg); e.status = 403; throw e; };
  const notify = (target, title, body) => { if (ctx.notify) ctx.notify(target, { title, body, url: '#spend' }).catch(() => {}); };

  // ---------- purchase orders ----------
  const poRow = id => { const r = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(id); return r && ctx.poView ? ctx.poView(r) : r; };
  const approvedPo = (id, total) => db.prepare("SELECT * FROM spend_approvals WHERE kind='po' AND ref_id=? AND status='approved' AND amount>=? ORDER BY id DESC LIMIT 1").get(id, round(total - 0.01));
  const poState = po => {                                                  // none (under the limit / control off) | approved | pending | rejected | required
    const lim = limit('po_approval_limit'); if (!lim || !po || !(po.total > lim)) return 'none';
    if (approvedPo(po.id, po.total)) return 'approved';
    const last = db.prepare("SELECT status, amount FROM spend_approvals WHERE kind='po' AND ref_id=? ORDER BY id DESC LIMIT 1").get(po.id);
    return last && last.status !== 'approved' && Math.abs(last.amount - po.total) < 0.011 ? last.status : 'required';
  };
  ctx.poApproval = poState;
  const approve = (kind, refId, amount, me, note) => db.prepare("INSERT INTO spend_approvals(kind,ref_id,amount,status,note,requested_by,requested_by_id,requested_at,decided_by,decided_at,decision_note) VALUES(?,?,?,'approved',?,?,?,?,?,?,?)")
    .run(kind, refId, round(amount), note || '', me.username, me.id, now(), me.username, now(), 'by the administrator');
  // the administrator acting on a purchase order above the limit is the approval; anyone else needs it first
  const needPo = (po, me, req, what) => {
    const st = poState(po); if (st === 'none' || st === 'approved') return;
    if (me.role === 'admin') { approve('po', po.id, po.total, me, what); audit(req, 'approve', 'purchase_orders', po.id, `${po.number} ${money(po.total)} (${what})`); return; }
    refuse(`Purchase order ${po.number} (${money(po.total)}) is above the approval limit of ${money(limit('po_approval_limit'))} — it needs the administrator's approval before it can be ${what}. Ask for it from the Spend approvals screen.`);
  };

  // ---------- supplier payments ----------
  // payments of a bill that needed approval (each one above the limit); smaller ones never use up an approval
  const paidOut = billId => round(db.prepare("SELECT COALESCE(SUM(amount),0) s FROM payments WHERE kind='out' AND bill_id=? AND COALESCE(cheque_status,'')!='bounced' AND method!='offset' AND amount>?").get(billId, limit('pay_approval_limit')).s);
  const approvedPay = billId => round(db.prepare("SELECT COALESCE(SUM(amount),0) s FROM spend_approvals WHERE kind='payment' AND ref_id=? AND status='approved'").get(billId).s);

  // called by the server for every write and for printable documents, after the role checks
  ctx.spendGuard = async (req, method, url, [a, b, c, d], me) => {
    if (!me) return;
    if (a === 'doc' && b === 'purchase_orders' && c && /^\d+$/.test(c)) { const po = poRow(+c); if (po) needPo(po, me, req, 'printed'); return; }
    if (method === 'GET') return;
    if (a === 'purchase_orders' && b && /^\d+$/.test(b)) {
      const po = poRow(+b); if (!po) return;
      if (['receive', 'email'].includes(c)) return needPo(po, me, req, c === 'email' ? 'sent' : 'received');
      if (method === 'PUT' && !c) {                                           // moving it out of draft; the new figures are judged after the save (the state is derived)
        const body = req._body = await readBody(req);
        if (body.status && body.status !== 'draft' && body.status !== po.status) {
          const next = ctx.poView ? ctx.poView({ ...po, items: JSON.stringify(Array.isArray(body.items) ? body.items : po.items), vat_pct: body.vat_pct ?? po.vat_pct }) : po;
          needPo({ ...next, id: po.id, number: po.number }, me, req, 'issued');
        }
      }
      return;
    }
    if (a === 'purchase_orders' && method === 'POST' && !b && me.role !== 'admin') {   // a new order above the limit starts as a draft
      const body = req._body = await readBody(req), lim = limit('po_approval_limit');
      if (lim && body.status && body.status !== 'draft' && ctx.poView && ctx.poView({ party_id: null, project_id: null, items: JSON.stringify(body.items || []), vat_pct: body.vat_pct ?? 5 }).total > lim)
        refuse(`A purchase order above ${money(lim)} needs the administrator's approval — save it as a draft, then ask for approval from the Spend approvals screen.`);
      return;
    }
    if (a === 'payments' && method === 'POST' && !b && me.role === 'admin') {     // the administrator paying above the limit approves it by doing so (keeps the approved / paid totals in step)
      const lim = limit('pay_approval_limit'), body = lim ? (req._body = await readBody(req)) : {};
      const bl = lim && body.bill_id ? enrich().bills.find(x => x.id === +body.bill_id) : null;                 // only a payment that will be accepted (within the open balance)
      if (bl && body.kind === 'out' && +body.amount > lim && +body.amount <= bl.balance + 0.01 && body.method !== 'offset') approve('payment', +body.bill_id, +body.amount, me, 'paid by the administrator');
      return;
    }
    if (a === 'payments' && ['POST', 'PUT'].includes(method) && me.role !== 'admin') {
      const lim = limit('pay_approval_limit'); if (!lim) return;
      const body = req._body = await readBody(req), cur = b && /^\d+$/.test(b) ? db.prepare('SELECT * FROM payments WHERE id=?').get(+b) : null, p = { ...(cur || {}), ...body };
      if (p.kind !== 'out' || !(+p.amount > lim) || p.method === 'offset') return;
      if (cur && +cur.amount === +p.amount && +cur.bill_id === +p.bill_id) return;      // not a money change (e.g. a cheque clearing)
      if (!p.bill_id) refuse(`A payment above ${money(lim)} that is not against a supplier bill can only be recorded by the administrator.`);
      const after = round(paidOut(+p.bill_id) - (cur && +cur.bill_id === +p.bill_id && +cur.amount > lim ? +cur.amount : 0) + +p.amount), okd = approvedPay(+p.bill_id);
      if (after > okd + 0.01) refuse(`This payment of ${money(p.amount)} is above the approval limit of ${money(lim)} — ask for the administrator's approval from the Spend approvals screen first (approved so far for this bill: ${money(okd)}).`);
    }
  };

  // ---------- lists ----------
  function view(me) {
    const e = enrich(), bills = Object.fromEntries(e.bills.map(b => [b.id, b])), lp = limit('po_approval_limit'), ly = limit('pay_approval_limit');
    const pos = db.prepare('SELECT * FROM purchase_orders ORDER BY id DESC').all().map(r => (ctx.poView ? ctx.poView(r) : r));
    const poById = Object.fromEntries(pos.map(p => [p.id, p]));
    const rows = db.prepare('SELECT * FROM spend_approvals ORDER BY (status=\'pending\') DESC, id DESC LIMIT 300').all().map(r => {
      const po = r.kind === 'po' ? poById[r.ref_id] : null, bill = r.kind === 'payment' ? bills[r.ref_id] : null;
      return { ...r, label: po ? `${po.number} — ${po.supplier_name || ''}` : bill ? `${bill.party_name || 'Expense'} — ${bill.description || bill.reference || '#' + bill.id}` : `#${r.ref_id}`,
        project_name: (po || bill || {}).project_name || '', doc_total: po ? po.total : bill ? bill.total : null, balance: bill ? bill.balance : null,
        stale: !!po && r.status !== 'rejected' && Math.abs(po.total - r.amount) > 0.011 };   // the order changed after the request
    });
    // what still needs a request: purchase orders above the limit with no live request; open bills above the limit not fully approved
    const need_po = lp ? pos.filter(p => p.status !== 'closed' && !p.bill_id && poState(p) === 'required').map(p => ({ id: p.id, number: p.number, supplier_name: p.supplier_name, project_name: p.project_name, total: p.total, status: p.status })) : [];
    const pendingPay = new Set(rows.filter(r => r.kind === 'payment' && r.status === 'pending').map(r => r.ref_id));
    const need_pay = ly ? e.bills.filter(b => b.balance > ly && !pendingPay.has(b.id) && round(approvedPay(b.id) - paidOut(b.id)) < ly).map(b => ({ id: b.id, label: `${b.party_name || 'Expense'} — ${b.description || b.reference || '#' + b.id}`, project_name: b.project_name || '', total: b.total, balance: b.balance, approved_left: Math.max(0, round(approvedPay(b.id) - paidOut(b.id))) })) : [];
    return { limits: { po: lp, payment: ly }, can_decide: me.role === 'admin', rows, need_po, need_pay, pending: rows.filter(r => r.status === 'pending').length };
  }
  ctx.spendAlerts = add => { const n = db.prepare("SELECT COUNT(*) n FROM spend_approvals WHERE status='pending'").get().n; if (n) add('warn', 'spend_pending', { count: n }); };

  return {
    async handle(req, res, url, [a, b], me) {
      if (a !== 'spend-approvals') return false;
      const m = req.method;
      if (m === 'GET') return send(res, 200, view(me)), true;
      if (m === 'POST' && !b) {                                              // ask for approval
        const x = await readBody(req), kind = x.kind, id = +x.ref_id;
        if (!['po', 'payment'].includes(kind)) bad('Invalid request');
        let amount, label;
        if (kind === 'po') {
          const po = poRow(id); if (!po) bad('Purchase order not found'); if (poState(po) === 'none') bad('This purchase order does not need approval'); if (poState(po) === 'approved') bad('This purchase order is already approved');
          amount = po.total; label = `PO ${po.number} — ${po.supplier_name || ''}`;
        } else {
          const bill = enrich().bills.find(r => r.id === id); if (!bill) bad('Bill not found');
          amount = round(+x.amount || bill.balance); if (!(amount > 0)) bad('Amount must be greater than zero'); if (amount > bill.balance + 0.01) bad(`Amount is more than the open balance of this bill (${money(bill.balance)})`);
          label = `Payment — ${bill.party_name || 'Expense'}: ${bill.description || bill.reference || '#' + bill.id}`;
        }
        if (db.prepare("SELECT 1 FROM spend_approvals WHERE kind=? AND ref_id=? AND status='pending'").get(kind, id)) bad('A request for this document is already waiting');
        const r = db.prepare('INSERT INTO spend_approvals(kind,ref_id,amount,note,requested_by,requested_by_id,requested_at) VALUES(?,?,?,?,?,?,?)').run(kind, id, amount, String(x.note || '').slice(0, 500), me.username, me.id, now());
        audit(req, 'request', 'spend_approvals', Number(r.lastInsertRowid), `${label} ${money(amount)}`);
        notify({ roles: ['admin'] }, 'طلب اعتماد صرف / Spend approval requested', `${label} — ${money(amount)} (${me.username})`);
        return send(res, 200, { id: Number(r.lastInsertRowid) }), true;
      }
      if (m === 'PUT' && b) {                                                // decide (administrator)
        if (me.role !== 'admin') return send(res, 403, { error: 'only the administrator decides spend approvals' }), true;
        const r = db.prepare('SELECT * FROM spend_approvals WHERE id=?').get(+b); if (!r) return send(res, 404, { error: 'not found' }), true;
        const x = await readBody(req); if (!['approved', 'rejected'].includes(x.status)) bad('Decision must be approved or rejected'); if (r.status !== 'pending') bad('This request was already decided');
        if (r.kind === 'po' && x.status === 'approved') { const po = poRow(r.ref_id); if (!po) bad('The purchase order no longer exists'); if (Math.abs(po.total - r.amount) > 0.011) bad(`The purchase order changed after the request (now ${money(po.total)}) — ask for approval again`); }
        db.prepare('UPDATE spend_approvals SET status=?, decided_by=?, decided_at=?, decision_note=? WHERE id=?').run(x.status, me.username, now(), String(x.note || '').slice(0, 500), r.id);
        audit(req, x.status === 'approved' ? 'approve' : 'reject', 'spend_approvals', r.id, `${r.kind} #${r.ref_id} ${money(r.amount)}`);
        if (r.requested_by_id) notify(r.requested_by_id, x.status === 'approved' ? 'تم اعتماد طلب الصرف / Spend request approved' : 'تم رفض طلب الصرف / Spend request rejected', `${money(r.amount)}${x.note ? ' — ' + x.note : ''}`);
        return send(res, 200, { ok: 1 }), true;
      }
      if (m === 'DELETE' && b) {                                             // withdraw a waiting request (its author or the administrator)
        const r = db.prepare('SELECT * FROM spend_approvals WHERE id=?').get(+b); if (!r) return send(res, 404, { error: 'not found' }), true;
        if (r.status !== 'pending') bad('Only a waiting request can be withdrawn'); if (!(me.role === 'admin' || r.requested_by_id === me.id)) return send(res, 403, { error: 'forbidden' }), true;
        db.prepare('DELETE FROM spend_approvals WHERE id=?').run(r.id); audit(req, 'withdraw', 'spend_approvals', r.id, `${r.kind} #${r.ref_id}`);
        return send(res, 200, { ok: 1 }), true;
      }
      return false;
    },
  };
};
