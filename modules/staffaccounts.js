// Employee accounts: what the company owes each employee and what each employee owes the company, in one statement —
// salaries due and paid (2200), salary advances and their instalments (1300), expense claims (2260) — and the expense claims
// themselves: an employee paid a company expense from own money, asks for it back with the receipt, an approver decides,
// the expense is booked on the project and the amount is owed to the employee until it is reimbursed.
//
// Approval rule for staff money (expense claims here, petty-cash requests later): the administrator and the manager approve
// any amount; the accountant approves up to the limit in Settings (staff_approval_accountant_limit; empty or 0 = the
// accountant cannot approve) and never a claim he entered himself (two people for anything the accounts pay out);
// nobody approves a claim of their own.
//
// Nothing here stores ledger lines: an approved claim is a bill paid with method 'employee' (credit 2260), a reimbursement is
// a payment with the employee and no bill (debit 2260); modules/accounting.js derives both. The statement reads the same
// records as the ledger, and the daily check compares them.
const { esc, money, bi } = require('../lib/render');

const SEC = { salary: ['2200', 'Salaries', 'الرواتب'], advance: ['1300', 'Salary advances', 'السلف'], claims: ['2260', 'Expense claims', 'مطالبات المصاريف'] };
const IMG = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];

module.exports = ctx => {
  const { db, send, bad, audit, readBody, today, round, getSettings, C } = ctx;
  db.exec(`CREATE TABLE IF NOT EXISTS expense_claims(id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL, date TEXT NOT NULL, description TEXT NOT NULL, amount REAL NOT NULL, vat_amount REAL DEFAULT 0,
    category TEXT DEFAULT 'other', project_id INTEGER, party_id INTEGER, reference TEXT, status TEXT DEFAULT 'pending', requested_by TEXT, requested_by_id INTEGER, created TEXT,
    decided_by TEXT, decided_by_id INTEGER, decided_at TEXT, decision_note TEXT, bill_id INTEGER, payment_id INTEGER)`);
  if (!db.prepare('PRAGMA table_info(payments)').all().some(c => c.name === 'employee_id')) db.exec('ALTER TABLE payments ADD COLUMN employee_id INTEGER');
  db.prepare('INSERT OR IGNORE INTO accounts(code,name,name_ar,type,system) VALUES(?,?,?,?,1)').run('2260', 'Employee expense claims payable', 'مطالبات مصاريف الموظفين المستحقة', 'liability');

  const isDate = d => /^\d{4}-\d\d-\d\d$/.test(d || '');
  const now = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().replace('T', ' ').slice(0, 16); };
  const lockDate = () => { const d = getSettings().lock_date; return isDate(d) ? d : ''; };
  const guardDate = (d, what) => { const l = lockDate(); if (l && d <= l) bad(`The accounting period is closed up to ${l} — ${what} dated ${d} cannot be added, changed or removed.`); };
  const monthEnd = ym => `${ym}-${String(C.daysInMonth(ym)).padStart(2, '0')}`;
  const emp = id => db.prepare('SELECT * FROM employees WHERE id=?').get(+id);
  const claim = id => db.prepare('SELECT * FROM expense_claims WHERE id=?').get(+id);
  const refuse = msg => { const e = new Error(msg); e.status = 403; throw e; };
  const has = t => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);

  // ---------------- approval rule ----------------
  const accLimit = () => { const v = +getSettings().staff_approval_accountant_limit; return v > 0 ? round(v) : 0; };
  // why `me` may not approve an amount for an employee (null = may approve)
  function approvalBlock(me, amount, employeeId, requestedById) {
    if (me.employee_id && +me.employee_id === +employeeId) return 'Nobody can approve a request of their own';
    if (me.role === 'admin' || me.role === 'manager') return null;
    if (me.role === 'accountant') {
      if (requestedById && +requestedById === +me.id) return 'The accountant cannot approve a claim he entered — the manager or the administrator approves it';
      const l = accLimit(); return l && amount <= l + 0.005 ? null : l ? `Above the accountant's approval limit (${money(l)}) — the manager or the administrator approves it` : 'The accountant\'s approval limit is not set (Settings) — the manager or the administrator approves it'; }
    return 'Your role cannot approve';
  }
  ctx.staffApproval = { block: approvalBlock, accountantLimit: accLimit };
  const approverIds = amount => db.prepare("SELECT id, role FROM users WHERE COALESCE(disabled,0)=0 AND role IN ('admin','manager','accountant')").all()
    .filter(u => u.role !== 'accountant' || (accLimit() && amount <= accLimit() + 0.005)).map(u => u.id);
  const ping = (ids, title, body, url) => { if (ctx.notify && ids.length) ctx.notify(ids, { title, body, url }).catch(() => {}); };

  // ---------------- claims ----------------
  const total = c => round((+c.amount || 0) + (+c.vat_amount || 0));
  const claimView = c => {
    const e = emp(c.employee_id), pr = c.project_id ? db.prepare('SELECT name, code FROM projects WHERE id=?').get(c.project_id) : null;
    const receipts = db.prepare("SELECT id, name, mime, size, created FROM documents WHERE entity='expense_claim' AND entity_id=? ORDER BY id").all(c.id);
    return { ...c, total: total(c), employee_name: e ? e.name : '', project_name: pr ? pr.name : '', receipts };
  };
  function checkClaim(x, employeeId) {
    if (!emp(employeeId)) bad('Select the employee');
    const date = x.date || today(); if (!isDate(date)) bad('Enter a valid date'); if (date > today()) bad('The date of an expense cannot be in the future');
    const amount = round(+x.amount), vat = round(+x.vat_amount || 0);
    if (!(amount > 0)) bad('Enter the amount'); if (vat < 0) bad('VAT cannot be negative'); if (vat > amount * 0.05 + 0.01) bad('VAT is more than 5% of the amount');
    if (!String(x.description || '').trim()) bad('Enter what was paid for');
    if (x.project_id && !db.prepare('SELECT 1 FROM projects WHERE id=?').get(+x.project_id)) bad('Unknown project');
    if (x.party_id && !db.prepare('SELECT 1 FROM parties WHERE id=?').get(+x.party_id)) bad('Unknown supplier');
    const cats = ['materials', 'labour', 'subcontract', 'equipment', 'transport', 'permits', 'overhead', 'other', 'accommodation', 'visa', 'insurance'];
    const category = cats.includes(x.category) ? x.category : 'other';
    return { employee_id: +employeeId, date, description: String(x.description).trim().slice(0, 300), amount, vat_amount: vat, category, project_id: +x.project_id || null, party_id: +x.party_id || null, reference: String(x.reference || '').slice(0, 100) };
  }
  function createClaim(x, employeeId, me) {
    const c = checkClaim(x, employeeId);
    const r = db.prepare('INSERT INTO expense_claims(employee_id,date,description,amount,vat_amount,category,project_id,party_id,reference,status,requested_by,requested_by_id,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(c.employee_id, c.date, c.description, c.amount, c.vat_amount, c.category, c.project_id, c.party_id, c.reference, 'pending', me.username, me.id, now());
    const id = Number(r.lastInsertRowid);
    ping(approverIds(total(c)).filter(u => u !== me.id), 'مطالبة مصروف بانتظار موافقتك / Expense claim to approve', `${emp(c.employee_id).name} — ${c.description} — ${money(total(c))} AED`, '#claims');
    return id;
  }
  function saveReceipt(c, body, me, req) {
    const f = ctx.parseDataUrl(body.data);
    if (!f || !IMG.includes(f.mime)) bad('The receipt must be a photo or a PDF');
    if (f.buf.length > 8 * 1024 * 1024) bad('File is larger than 8 MB');
    const name = String(body.name || 'receipt').replace(/[\r\n"\\/]/g, '_').slice(0, 120);
    const r = db.prepare('INSERT INTO documents(entity,entity_id,category,name,mime,size,data,uploaded_by,created) VALUES(?,?,?,?,?,?,?,?,?)').run('expense_claim', c.id, 'receipt', name, f.mime, f.buf.length, f.buf, me.username, today());
    audit(req, 'upload', 'documents', Number(r.lastInsertRowid), `expense_claim ${c.id}: ${name}`);
    return Number(r.lastInsertRowid);
  }
  function decide(c, me, x, req) {
    if (c.status !== 'pending') bad('This claim was already decided');
    if (!['approved', 'rejected'].includes(x.status)) bad('Decision must be approved or rejected');
    const why = approvalBlock(me, total(c), c.employee_id, c.requested_by_id); if (why) refuse(why);
    if (x.status === 'rejected') {
      if (!String(x.note || '').trim()) bad('Write the reason for the rejection');
      db.prepare("UPDATE expense_claims SET status='rejected', decided_by=?, decided_by_id=?, decided_at=?, decision_note=? WHERE id=?").run(me.username, me.id, now(), String(x.note).trim(), c.id);
    } else {
      guardDate(c.date, 'an expense');
      const bill = db.prepare('INSERT INTO bills(date,party_id,project_id,category,description,amount,vat_amount,reference) VALUES(?,?,?,?,?,?,?,?)').run(c.date, c.party_id, c.project_id, c.category, `${c.description} (claim of ${emp(c.employee_id).name})`, c.amount, c.vat_amount, c.reference || `CLAIM-${c.id}`);
      const billId = Number(bill.lastInsertRowid);
      const pay = db.prepare("INSERT INTO payments(kind,date,amount,method,reference,bill_id,employee_id,notes) VALUES('out',?,?,'employee',?,?,?,'expense-claim')").run(c.date, total(c), `CLAIM-${c.id}`, billId, c.employee_id);
      db.prepare("UPDATE expense_claims SET status='approved', decided_by=?, decided_by_id=?, decided_at=?, decision_note=?, bill_id=?, payment_id=? WHERE id=?").run(me.username, me.id, now(), String(x.note || '').trim(), billId, Number(pay.lastInsertRowid), c.id);
    }
    audit(req, x.status, 'expense_claims', c.id, `${total(c)}`);
    const owner = db.prepare('SELECT id FROM users WHERE employee_id=?').all(c.employee_id).map(u => u.id);
    ping(owner, x.status === 'approved' ? 'تمت الموافقة على مطالبتك / Your expense claim was approved' : 'رُفضت مطالبتك / Your expense claim was rejected', `${c.description} — ${money(total(c))} AED${x.note ? ' — ' + x.note : ''}`, '#myaccount');
  }

  // ---------------- employee statement ----------------
  const reimbursements = eid => db.prepare("SELECT * FROM payments WHERE kind='out' AND employee_id=? AND bill_id IS NULL ORDER BY date, id").all(eid);
  function moves(eid) {
    const out = [];
    for (const r of db.prepare("SELECT * FROM payroll WHERE employee_id=? AND status='final' ORDER BY month").all(eid)) {
      out.push({ date: monthEnd(r.month), ref: `PAY-${r.month}`, section: 'salary', amount: round(r.net), description: `Net salary ${r.month}`, description_ar: `صافي راتب ${r.month}` });
      if (r.paid_date) out.push({ date: r.paid_date, ref: `PAY-${r.month}`, section: 'salary', amount: -round(r.net), description: `Salary paid ${r.month}`, description_ar: `دُفع راتب ${r.month}` });
    }
    if (has('eos_settlements')) for (const s of db.prepare('SELECT * FROM eos_settlements WHERE employee_id=?').all(eid))
      if (s.gratuity) out.push({ date: s.date, ref: `EOS-SET-${eid}`, section: 'salary', amount: round(s.gratuity), description: 'End-of-service gratuity due', description_ar: 'مكافأة نهاية الخدمة المستحقة' });
    if (has('loans')) {
      for (const l of db.prepare('SELECT * FROM loans WHERE employee_id=?').all(eid)) out.push({ date: String(l.created || '').slice(0, 10), ref: `ADV-${l.id}`, section: 'advance', amount: -round(l.amount), description: 'Salary advance paid', description_ar: 'سلفة على الراتب' });
      for (const r of db.prepare("SELECT r.amount, p.month FROM loan_repayments r JOIN payroll p ON p.id=r.payroll_id JOIN loans l ON l.id=r.loan_id WHERE l.employee_id=? AND p.status='final'").all(eid))
        out.push({ date: monthEnd(r.month), ref: `PAY-${r.month}`, section: 'advance', amount: round(r.amount), description: `Advance instalment deducted ${r.month}`, description_ar: `قسط سلفة مخصوم من راتب ${r.month}` });
    }
    for (const c of db.prepare("SELECT * FROM expense_claims WHERE employee_id=? AND status='approved'").all(eid))
      out.push({ date: c.date, ref: `CLAIM-${c.id}`, id: c.id, kind: 'claim', section: 'claims', amount: total(c), description: `Expense claim — ${c.description}`, description_ar: `مطالبة مصروف — ${c.description}` });
    for (const p of reimbursements(eid))
      out.push({ date: p.date, ref: p.reference || `PAY-${p.id}`, id: p.id, kind: 'reimbursement', section: 'claims', amount: -round(p.amount), description: `Reimbursed (${p.method})`, description_ar: `صُرف للموظف (${p.method === 'cash' ? 'نقداً' : 'بنك'})` });
    for (const x of ctx.custodyMoves ? ctx.custodyMoves(eid) : []) out.push(x);   // petty cash held by the employee (modules/pettycustody.js)
    return out.filter(m => m.date).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (b.amount - a.amount)));
  }
  const sections = () => ({ ...SEC, ...(ctx.custodySection ? { custody: ctx.custodySection } : {}) });
  function balances(eid, asOf = '9999-12-31') {
    const b = Object.fromEntries(Object.keys(sections()).map(k => [k, 0]));
    for (const m of moves(eid)) if (m.date <= asOf) b[m.section] = round((b[m.section] || 0) + m.amount);
    return { ...b, total: round(Object.values(b).reduce((s, v) => s + v, 0)) };
  }
  function statement(eid, from, to) {
    const e = emp(eid); if (!e) { const er = new Error('not found'); er.status = 404; throw er; }
    to = isDate(to) ? to : today(); from = isDate(from) ? from : null;
    const all = moves(e.id), sec = {};
    for (const [k, v] of Object.entries(sections())) {
      const mine = all.filter(m => m.section === k), opening = round(mine.filter(m => from && m.date < from).reduce((s, m) => s + m.amount, 0));
      let bal = opening; const lines = [];
      for (const m of mine) if ((!from || m.date >= from) && m.date <= to) { bal = round(bal + m.amount); lines.push({ ...m, balance: bal }); }
      sec[k] = { account: v[0], name: v[1], name_ar: v[2], opening, lines, closing: bal };
    }
    const prov = has('eos_provisions') && !(has('eos_settlements') && db.prepare('SELECT 1 FROM eos_settlements WHERE employee_id=?').get(e.id))
      ? round(db.prepare('SELECT COALESCE(SUM(amount),0) s FROM eos_provisions WHERE employee_id=? AND month<=?').get(e.id, to.slice(0, 7)).s) : 0;
    const partner = has('partners') ? db.prepare('SELECT id, name FROM partners WHERE employee_id=?').get(e.id) : null;
    return { employee: { id: e.id, name: e.name, designation: e.designation, status: e.status }, from, to, sections: sec, total: round(Object.values(sec).reduce((s, x) => s + x.closing, 0)),
      eos_provision: prov, partner: partner || null, pending_claims: db.prepare("SELECT COUNT(*) n, COALESCE(SUM(amount+vat_amount),0) t FROM expense_claims WHERE employee_id=? AND status='pending'").get(e.id) };
  }
  const claimsOwed = eid => balances(eid).claims;

  // ---------------- reconciliation with the general ledger ----------------
  ctx.staffChecks = () => {
    if (!ctx.financials) return [];
    const tb = ctx.financials('0000-01-01', '9999-12-31').trial_balance, bal = code => { const r = tb.find(x => x.code === code); return r ? round(r.credit - r.debit) : 0; };
    const sub = Object.fromEntries(Object.keys(sections()).map(k => [k, 0]));
    for (const e of db.prepare('SELECT id FROM employees').all()) { const b = balances(e.id); for (const k of Object.keys(sub)) sub[k] = round(sub[k] + (b[k] || 0)); }
    const out = [];   // no amounts: the daily report may be posted to a GitHub issue
    // statement sign = credit − debit of the account: salaries / claims owed are credits, advances / petty cash held are debits
    for (const [k, v] of Object.entries(sections())) {
      const diff = round(bal(v[0]) - sub[k]);
      if (Math.abs(diff) >= 0.01) out.push({ status: k === 'claims' || k === 'custody' ? 'fail' : 'warn', detail: `account ${v[0]} (${v[1].toLowerCase()}): the general ledger and the employee statements differ${k === 'claims' || k === 'custody' ? '' : ' — usually a manual journal entry on this account'}` });
    }
    return out.length ? out : [{ status: 'ok', detail: 'salaries, advances and expense claims equal the general ledger' }];
  };

  // ---------------- printable statement ----------------
  ctx.renderers = ctx.renderers || {};
  ctx.renderers.employee_statement = (id, me, qp) => {
    const s = statement(id, qp && qp.get ? qp.get('from') : null, qp && qp.get ? qp.get('to') : null), S = getSettings();
    const sign = v => v >= 0 ? money(v) : `(${money(-v)})`;
    const table = k => {
      const x = s.sections[k]; if (!x.lines.length && !x.opening && !x.closing) return '';
      return `<h2 style="font-size:11pt;margin:5mm 0 1mm">${bi(S, x.name, x.name_ar)} <span style="font-weight:normal;color:#8A8578">(${x.account})</span></h2>
      <table class="items"><thead><tr><th>Date</th><th>Ref</th><th>Description</th><th>Amount</th><th>Balance</th></tr></thead><tbody>
      ${s.from ? `<tr><td>${esc(s.from)}</td><td></td><td>${bi(S, 'Opening balance', 'رصيد افتتاحي')}</td><td></td><td class="n">${sign(x.opening)}</td></tr>` : ''}
      ${x.lines.map(l => `<tr><td>${esc(l.date)}</td><td>${esc(l.ref)}</td><td>${esc(bi(S, l.description, l.description_ar || l.description))}</td><td class="n">${sign(l.amount)}</td><td class="n">${sign(l.balance)}</td></tr>`).join('')}
      <tr><td colspan="4"><b>${bi(S, 'Closing balance', 'الرصيد الختامي')}</b></td><td class="n"><b>${sign(x.closing)}</b></td></tr></tbody></table>`;
    };
    const body = `<h1 style="font-size:16pt;margin:0 0 2mm">${bi(S, 'Employee statement of account', 'كشف حساب موظف')}</h1>
      <p><b>${esc(s.employee.name)}</b>${s.employee.designation ? ` · ${esc(s.employee.designation)}` : ''}<br>${s.from ? `${esc(s.from)} → ` : 'Up to '}${esc(s.to)} · AED</p>
      ${Object.keys(s.sections).map(table).join('')}
      <table class="items" style="margin-top:6mm"><tbody>${Object.values(s.sections).map(x => `<tr><td>${bi(S, x.name, x.name_ar)}</td><td class="n">${sign(x.closing)}</td></tr>`).join('')}
      <tr><td><b>${bi(S, 'Net in the employee\'s favour', 'الصافي لصالح الموظف')}</b></td><td class="n"><b>${sign(s.total)}</b></td></tr></tbody></table>
      ${s.eos_provision ? `<p style="margin-top:3mm">${bi(S, 'End-of-service gratuity accrued (provision, not yet due)', 'مكافأة نهاية الخدمة المتراكمة (مخصص، غير مستحقة بعد)')}: <b>${money(s.eos_provision)}</b></p>` : ''}
      <p style="font-size:8pt;color:#8A8578;margin-top:4mm">${bi(S, 'Positive amounts are owed by the company to the employee; amounts in brackets are owed by the employee.', 'المبالغ الموجبة مستحقة للموظف على الشركة؛ المبالغ بين قوسين مستحقة على الموظف.')}</p>`;
    return { title: `Employee statement — ${s.employee.name}`, filename: `employee-statement-${s.employee.name.replace(/\s+/g, '-')}-${s.to}`, body, date: s.to, label: bi(S, 'Accounts', 'الحسابات'), stamp: true };
  };

  const listClaims = (where = '', args = []) => db.prepare(`SELECT * FROM expense_claims ${where} ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, date DESC, id DESC LIMIT 1000`).all(...args).map(claimView);

  return {
    async handle(req, res, url, [a, b, c, d], me) {
      const m = req.method, q = k => url.searchParams.get(k);
      // ---------- my account (any user linked to an employee) ----------
      if (a === 'me' && (b === 'statement' || b === 'claims')) {
        if (!me.employee_id) return send(res, 403, { error: 'this account is not linked to an employee' }), true;
        if (b === 'statement' && m === 'GET') return send(res, 200, statement(me.employee_id, q('from'), q('to'))), true;
        if (b === 'claims' && m === 'GET' && !c) return send(res, 200, listClaims('WHERE employee_id=?', [me.employee_id])), true;
        if (b === 'claims' && m === 'POST' && !c) { const x = await readBody(req); const id = createClaim(x, me.employee_id, me); audit(req, 'create', 'expense_claims', id, ''); return send(res, 200, { id }), true; }
        const mine = c && claim(c); if (!mine || mine.employee_id !== +me.employee_id) return send(res, 404, { error: 'not found' }), true;
        if (m === 'POST' && d === 'receipt') { if (mine.status !== 'pending') bad('Receipts can be added while the claim is pending'); const x = await readBody(req, 12e6); return send(res, 200, { id: saveReceipt(mine, x, me, req) }), true; }
        if (m === 'DELETE' && !d) { if (mine.status !== 'pending') bad('Only a pending claim can be withdrawn'); db.prepare('DELETE FROM expense_claims WHERE id=?').run(mine.id); db.prepare("DELETE FROM documents WHERE entity='expense_claim' AND entity_id=?").run(mine.id); audit(req, 'delete', 'expense_claims', mine.id, 'withdrawn'); return send(res, 200, { ok: 1 }), true; }
        return send(res, 404, { error: 'not found' }), true;
      }
      // ---------- staff statements ----------
      if (a === 'staff_statements' && m === 'GET') {
        if (b) return send(res, 200, statement(+b, q('from'), q('to'))), true;
        const rows = db.prepare("SELECT id, name, designation, status FROM employees ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, name").all().map(e => ({ ...e, balances: balances(e.id) }));
        const totals = Object.fromEntries([...Object.keys(sections()), 'total'].map(k => [k, round(rows.reduce((s, r) => s + (r.balances[k] || 0), 0))]));
        return send(res, 200, { rows, totals, sections: Object.fromEntries(Object.entries(sections()).map(([k, v]) => [k, { account: v[0], name: v[1], name_ar: v[2] }])) }), true;
      }
      // ---------- expense claims (approvers and accounts) ----------
      if (a === 'expense_claims') {
        if (m === 'GET' && !b) {
          const st = q('status'), rows = listClaims(st ? 'WHERE status=?' : '', st ? [st] : []);
          return send(res, 200, { rows: rows.map(r => ({ ...r, can_decide: r.status === 'pending' && !approvalBlock(me, r.total, r.employee_id, r.requested_by_id), block: r.status === 'pending' ? approvalBlock(me, r.total, r.employee_id, r.requested_by_id) : null })), accountant_limit: accLimit() }), true;
        }
        if (m === 'POST' && !b) { const x = await readBody(req); const id = createClaim(x, x.employee_id, me); audit(req, 'create', 'expense_claims', id, 'on behalf'); return send(res, 200, { id }), true; }
        if (m === 'POST' && b === 'reimburse') {                       // pay the employee what the approved claims owe him
          if (!['admin', 'accountant'].includes(me.role)) refuse('Reimbursements are paid by the accounts (administrator or accountant)');
          const x = await readBody(req), e = emp(x.employee_id); if (!e) bad('Select the employee');
          const date = x.date || today(); if (!isDate(date)) bad('Enter a valid date'); guardDate(date, 'a reimbursement');
          const amount = round(+x.amount); if (!(amount > 0)) bad('Enter the amount');
          const owed = claimsOwed(e.id); if (amount > owed + 0.005) bad(`Approved claims not yet reimbursed: ${owed}`);
          const method = x.method === 'cash' ? 'cash' : 'bank', bank = method === 'bank' ? (+x.bank_account_id || null) : null;
          if (bank && !db.prepare('SELECT 1 FROM bank_accounts WHERE id=?').get(bank)) bad('Unknown bank account');
          const r = db.prepare("INSERT INTO payments(kind,date,amount,method,reference,employee_id,bank_account_id,notes) VALUES('out',?,?,?,?,?,?,'claim-reimbursement')").run(date, amount, method, x.reference || `CLAIMS-${e.id}`, e.id, bank);
          audit(req, 'create', 'claim_reimbursement', Number(r.lastInsertRowid), `${e.name} ${amount}`); return send(res, 200, { id: Number(r.lastInsertRowid) }), true;
        }
        if (m === 'DELETE' && b === 'reimburse' && c) {
          if (!['admin', 'accountant'].includes(me.role)) refuse('Reimbursements are kept by the accounts');
          const p = db.prepare("SELECT * FROM payments WHERE id=? AND employee_id IS NOT NULL AND bill_id IS NULL AND notes='claim-reimbursement'").get(+c); if (!p) return send(res, 404, { error: 'not found' }), true;
          guardDate(p.date, 'a reimbursement');
          if (db.prepare('SELECT 1 FROM bank_lines WHERE payment_id=?').get(p.id)) bad('This payment is matched to a bank statement line — unmatch it first');
          db.prepare('DELETE FROM payments WHERE id=?').run(p.id); audit(req, 'delete', 'claim_reimbursement', p.id, `${p.amount}`); return send(res, 200, { ok: 1 }), true;
        }
        const cl = b && /^\d+$/.test(b) && claim(b); if (!cl) return send(res, 404, { error: 'not found' }), true;
        if (m === 'GET' && !c) return send(res, 200, claimView(cl)), true;
        if (m === 'POST' && c === 'decide') { const x = await readBody(req); decide(cl, me, x, req); return send(res, 200, claimView(claim(cl.id))), true; }
        if (m === 'POST' && c === 'receipt') { const x = await readBody(req, 12e6); return send(res, 200, { id: saveReceipt(cl, x, me, req) }), true; }
        if (m === 'POST' && c === 'undo') {                            // take back an approval: the bill and its payment go, the claim is pending again
          if (me.role !== 'admin') refuse('Only the administrator can take back an approval');
          if (cl.status !== 'approved') bad('Only an approved claim can be taken back');
          guardDate(cl.date, 'an expense');
          if (claimsOwed(cl.employee_id) - total(cl) < -0.005) bad('This employee was already reimbursed for this claim — delete the reimbursement first');
          db.prepare('DELETE FROM payments WHERE id=?').run(cl.payment_id); db.prepare('DELETE FROM bills WHERE id=?').run(cl.bill_id);
          db.prepare("UPDATE expense_claims SET status='pending', decided_by=NULL, decided_by_id=NULL, decided_at=NULL, decision_note=NULL, bill_id=NULL, payment_id=NULL WHERE id=?").run(cl.id);
          audit(req, 'undo', 'expense_claims', cl.id, ''); return send(res, 200, { ok: 1 }), true;
        }
        if (m === 'DELETE' && !c) {
          if (cl.status === 'approved') bad('An approved claim is in the books — take the approval back first');
          db.prepare('DELETE FROM expense_claims WHERE id=?').run(cl.id); db.prepare("DELETE FROM documents WHERE entity='expense_claim' AND entity_id=?").run(cl.id);
          audit(req, 'delete', 'expense_claims', cl.id, ''); return send(res, 200, { ok: 1 }), true;
        }
        return false;
      }
      return false;
    },
  };
};
