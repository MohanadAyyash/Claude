// General ledger derived from the operational documents + manual journals; trial balance, statements, bank reconciliation, CSV exports.
const CHART = [
  ['1000', 'Bank accounts', 'الحسابات البنكية', 'asset'], ['1010', 'Petty cash', 'العهدة النقدية', 'asset'], ['1020', 'Cash on hand', 'النقدية', 'asset'], ['1050', 'Cheques in hand (PDC)', 'شيكات برسم التحصيل', 'asset'],
  ['1100', 'Accounts receivable', 'ذمم العملاء', 'asset'], ['1150', 'Retention receivable', 'محتجزات لدى العملاء', 'asset'], ['1200', 'VAT input (recoverable)', 'ضريبة القيمة المضافة - مدخلات', 'asset'],
  ['1400', 'Advances to subcontractors', 'دفعات مقدمة لمقاولي الباطن', 'asset'], ['1600', 'Fixed assets (cost)', 'الأصول الثابتة', 'asset'], ['1690', 'Accumulated depreciation', 'مجمع الإهلاك', 'asset'],
  ['2000', 'Accounts payable', 'ذمم الموردين', 'liability'], ['2050', 'Cheques issued (PDC payable)', 'شيكات برسم الدفع', 'liability'], ['2100', 'VAT output', 'ضريبة القيمة المضافة - مخرجات', 'liability'],
  ['2200', 'Salaries payable', 'رواتب مستحقة', 'liability'], ['2250', 'Employee deductions payable', 'خصومات موظفين مستحقة', 'liability'], ['2300', 'End-of-service provision', 'مخصص نهاية الخدمة', 'liability'],
  ['3000', 'Share capital', 'رأس المال', 'equity'], ['3100', 'Retained earnings / owner current account', 'أرباح مبقاة / جاري الشريك', 'equity'],
  ['4000', 'Contract revenue', 'إيرادات العقود', 'revenue'],
  ['5100', 'Materials', 'مواد', 'expense'], ['5200', 'Labour & payroll', 'عمالة ورواتب', 'expense'], ['5300', 'Subcontractors', 'مقاولو الباطن', 'expense'], ['5400', 'Equipment', 'معدات', 'expense'],
  ['5500', 'Transport', 'نقل', 'expense'], ['5600', 'Permits & fees', 'رسوم وتراخيص', 'expense'], ['5700', 'Other direct costs', 'تكاليف مباشرة أخرى', 'expense'], ['6000', 'Overheads', 'مصاريف عمومية', 'expense'], ['6100', 'Depreciation', 'الإهلاك', 'expense'],
];
const CAT = { materials: '5100', labour: '5200', subcontract: '5300', equipment: '5400', transport: '5500', permits: '5600', overhead: '6000', other: '5700', asset: '1600' };
const TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'];

module.exports = ctx => {
  const { db, send, bad, audit, readBody, today, round, enrich, C } = ctx;
  db.exec(`CREATE TABLE IF NOT EXISTS accounts(code TEXT PRIMARY KEY, name TEXT, name_ar TEXT, type TEXT, system INTEGER DEFAULT 0);
  CREATE TABLE IF NOT EXISTS journal_entries(id INTEGER PRIMARY KEY, date TEXT, memo TEXT, lines TEXT DEFAULT '[]', created_by TEXT);
  CREATE TABLE IF NOT EXISTS bank_lines(id INTEGER PRIMARY KEY, date TEXT, description TEXT, amount REAL, payment_id INTEGER);`);
  const seed = db.prepare('INSERT OR IGNORE INTO accounts(code,name,name_ar,type,system) VALUES(?,?,?,?,1)'); for (const c of CHART) seed.run(...c);
  const acct = () => Object.fromEntries(db.prepare('SELECT * FROM accounts ORDER BY code').all().map(a => [a.code, a]));

  const mk = (acc, dr = 0, cr = 0) => { dr = round(dr); cr = round(cr); if (dr < 0) { cr = round(cr - dr); dr = 0; } if (cr < 0) { dr = round(dr - cr); cr = 0; } return { account: acc, debit: dr, credit: cr }; };
  const monthEnd = ym => `${ym}-${String(C.daysInMonth(ym)).padStart(2, '0')}`;
  const bankAcct = (p, kind) => p.method === 'cash' ? '1020' : p.method === 'petty' ? '1010' : p.method === 'offset' ? '1400' : p.method === 'cheque' && p.cheque_status === 'pending' ? (kind === 'in' ? '1050' : '2050') : '1000';

  function entries() {
    const out = [], e = enrich();
    const add = (date, ref, memo, source, lines) => { lines = lines.filter(l => l.debit || l.credit); if (lines.length) out.push({ date, ref, memo, source, lines }); };
    for (const i of e.invoices) if (!i.voided) add(i.date, i.number, `${i.kind === 'credit_note' ? 'Credit note' : 'Invoice'} — ${i.client_name || ''}`, 'invoice', [mk('1100', i.due_now), mk('1150', i.retention), mk('4000', 0, i.subtotal), mk('2100', 0, i.vat)]);
    for (const b of e.bills) add(b.date, b.reference || `BILL-${b.id}`, `${b.party_name || 'Expense'} — ${b.description || ''}`, 'bill', [mk(CAT[b.category] || '5700', b.amount), mk('1200', b.vat_amount), mk('2000', 0, b.total)]);
    for (const p of e.payments) {
      if (p.cheque_status === 'bounced') continue;
      if (p.kind === 'in') add(p.date, p.ref_label, `Receipt — ${p.party_name || ''}${p.is_retention ? ' (retention)' : ''}`, 'receipt', [mk(bankAcct(p, 'in'), p.amount), mk(p.is_retention ? '1150' : '1100', 0, p.amount)]);
      else add(p.date, p.ref_label, `Payment — ${p.party_name || ''}`, 'payment', [mk('2000', p.amount), mk(bankAcct(p, 'out'), 0, p.amount)]);
    }
    for (const t of db.prepare('SELECT * FROM petty_topups').all()) add(t.date, 'PETTY', `Petty cash top-up ${t.note || ''}`, 'petty', [mk('1010', t.amount), mk('1000', 0, t.amount)]);
    for (const r of db.prepare("SELECT * FROM payroll WHERE status='final'").all()) {
      add(monthEnd(r.month), `PAY-${r.month}`, `Payroll ${r.month}`, 'payroll', [mk('5200', r.gross), mk('2200', 0, r.net), mk('2250', 0, r.deductions)]);
      if (r.paid_date) add(r.paid_date, `PAY-${r.month}`, `Salaries paid ${r.month}`, 'payroll', [mk('2200', r.net), mk('1000', 0, r.net)]);
    }
    for (const a of ctx.assetRegister('9999-12-31')) {
      if (!a.purchase_date) continue;
      const end = (a.status === 'disposed' && a.disposal_date) ? a.disposal_date.slice(0, 7) : today().slice(0, 7), monthly = (a.cost - a.salvage) / Math.max(1, a.life_years * 12);
      let ym = a.purchase_date.slice(0, 7), done = 0;
      while (ym <= end && done < a.cost - a.salvage - 0.005) { const amt = Math.min(monthly, a.cost - a.salvage - done); done += amt; add(monthEnd(ym), `DEP-${a.id}`, `Depreciation — ${a.name}`, 'depreciation', [mk('6100', amt), mk('1690', 0, amt)]); const d = new Date(+ym.slice(0, 4), +ym.slice(5, 7), 1); ym = d.toISOString().slice(0, 7); }
    }
    for (const j of db.prepare('SELECT * FROM journal_entries').all()) add(j.date, `JV-${j.id}`, j.memo, 'journal', JSON.parse(j.lines || '[]').map(l => mk(l.account, +l.debit || 0, +l.credit || 0)));
    return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }
  const flat = (from, to) => entries().filter(x => (!from || x.date >= from) && (!to || x.date <= to)).flatMap(x => x.lines.map(l => ({ ...l, date: x.date, ref: x.ref, memo: x.memo, source: x.source })));

  function financials(from, to) {
    const A = acct(), cum = {}, per = {};
    for (const l of flat(null, to)) cum[l.account] = round((cum[l.account] || 0) + l.debit - l.credit);
    for (const l of flat(from, to)) per[l.account] = round((per[l.account] || 0) + l.debit - l.credit);
    const tb = Object.values(A).filter(a => cum[a.code]).map(a => ({ code: a.code, name: a.name, name_ar: a.name_ar, type: a.type, debit: cum[a.code] > 0 ? cum[a.code] : 0, credit: cum[a.code] < 0 ? -cum[a.code] : 0 }));
    const sum = (rows, k) => round(rows.reduce((s, r) => s + r[k], 0));
    const pl = Object.values(A).filter(a => ['revenue', 'expense'].includes(a.type) && per[a.code]).map(a => ({ code: a.code, name: a.name, name_ar: a.name_ar, type: a.type, amount: a.type === 'revenue' ? -per[a.code] : per[a.code] }));
    const revenue = sum(pl.filter(x => x.type === 'revenue'), 'amount'), expenses = sum(pl.filter(x => x.type === 'expense'), 'amount');
    const bal = type => Object.values(A).filter(a => a.type === type && cum[a.code]).map(a => ({ code: a.code, name: a.name, name_ar: a.name_ar, amount: type === 'asset' ? cum[a.code] : -cum[a.code] }));
    const earnings = round(-Object.values(A).filter(a => ['revenue', 'expense'].includes(a.type)).reduce((s, a) => s + (cum[a.code] || 0), 0));
    const assets = bal('asset'), liabilities = bal('liability'), equity = bal('equity');
    return { from, to, trial_balance: tb, tb_debit: sum(tb, 'debit'), tb_credit: sum(tb, 'credit'), pl, revenue, expenses, net_profit: round(revenue - expenses),
      balance_sheet: { assets, liabilities, equity, current_earnings: earnings, total_assets: sum(assets, 'amount'), total_liabilities: sum(liabilities, 'amount'), total_equity: round(sum(equity, 'amount') + earnings) } };
  }

  // ---- bank reconciliation ----
  const eligible = () => db.prepare("SELECT p.* FROM payments p WHERE p.reconciled=0 AND p.method IN ('bank','card','cheque') AND COALESCE(p.cheque_status,'cleared')!='bounced' AND p.method!='petty'").all()
    .filter(p => p.method !== 'cheque' || p.cheque_status === 'cleared').map(p => ({ ...p, signed: p.kind === 'in' ? p.amount : -p.amount }));
  const parseCsv = text => String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => l.split(/[,;\t]/).map(x => x.replace(/^"|"$/g, '').trim()))
    .filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r[0]) || /^\d{1,2}[/-]\d{1,2}[/-]\d{4}$/.test(r[0]))
    .map(r => { let d = r[0]; if (!/^\d{4}/.test(d)) { const [dd, mm, yy] = d.split(/[/-]/); d = `${yy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`; } return { date: d, description: r.slice(1, -1).join(' ') || '', amount: +String(r[r.length - 1]).replace(/,/g, '') }; });
  const csv = rows => '﻿' + rows.map(r => r.map(v => { v = v ?? ''; v = String(v); return /[",\r\n;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; }).join(',')).join('\r\n') + '\r\n';

  return {
    async handle(req, res, url, [a, b, c], me) {
      const m = req.method, q = k => url.searchParams.get(k);
      if (a === 'accounts') {
        if (m === 'GET') return send(res, 200, Object.values(acct())), true;
        const x = ['POST', 'PUT'].includes(m) ? await readBody(req) : {};
        if (m === 'POST') {
          if (!/^\d{3,6}$/.test(x.code || '')) bad('Account code must be 3–6 digits'); if (!x.name) bad('Enter the account name'); if (!TYPES.includes(x.type)) bad('Invalid account type');
          if (acct()[x.code]) bad('Account code already exists');
          db.prepare('INSERT INTO accounts(code,name,name_ar,type,system) VALUES(?,?,?,?,0)').run(x.code, x.name, x.name_ar || '', x.type); audit(req, 'create', 'accounts', 0, `${x.code} ${x.name}`); return send(res, 200, { ok: 1 }), true;
        }
        const acc = acct()[b]; if (!acc) return send(res, 404, { error: 'not found' }), true;
        if (m === 'PUT') { db.prepare('UPDATE accounts SET name=?, name_ar=? WHERE code=?').run(x.name || acc.name, x.name_ar ?? acc.name_ar, b); return send(res, 200, { ok: 1 }), true; }
        if (m === 'DELETE') {
          if (acc.system) bad('Built-in accounts cannot be deleted');
          if (db.prepare("SELECT 1 FROM journal_entries WHERE lines LIKE ?").get(`%"${b}"%`)) bad('This account is used in journal entries');
          db.prepare('DELETE FROM accounts WHERE code=?').run(b); return send(res, 200, { ok: 1 }), true;
        }
      }
      if (a === 'journal_entries') {
        if (m === 'GET') return send(res, 200, db.prepare('SELECT * FROM journal_entries ORDER BY date DESC, id DESC').all().map(j => ({ ...j, lines: JSON.parse(j.lines || '[]') }))), true;
        const check = x => {
          if (!/^\d{4}-\d\d-\d\d$/.test(x.date || '')) bad('Enter a valid date'); const A = acct(), ls = Array.isArray(x.lines) ? x.lines : [];
          if (ls.length < 2) bad('A journal entry needs at least two lines');
          for (const l of ls) { if (!A[l.account]) bad(`Unknown account ${l.account}`); if ((+l.debit || 0) < 0 || (+l.credit || 0) < 0 || ((+l.debit || 0) && (+l.credit || 0))) bad('Each line must have either a debit or a credit amount'); }
          const d = round(ls.reduce((s, l) => s + (+l.debit || 0), 0)), k = round(ls.reduce((s, l) => s + (+l.credit || 0), 0));
          if (!d || Math.abs(d - k) > 0.005) bad(`Entry is not balanced (debit ${d}, credit ${k})`);
          return JSON.stringify(ls.map(l => ({ account: l.account, debit: +l.debit || 0, credit: +l.credit || 0 })));
        };
        if (m === 'POST') { const x = await readBody(req), lines = check(x); const r = db.prepare('INSERT INTO journal_entries(date,memo,lines,created_by) VALUES(?,?,?,?)').run(x.date, x.memo || '', lines, me.username); audit(req, 'create', 'journal_entries', Number(r.lastInsertRowid), x.memo || ''); return send(res, 200, { id: Number(r.lastInsertRowid) }), true; }
        if (m === 'PUT') { const x = await readBody(req), lines = check(x); db.prepare('UPDATE journal_entries SET date=?, memo=?, lines=? WHERE id=?').run(x.date, x.memo || '', lines, +b); audit(req, 'update', 'journal_entries', +b); return send(res, 200, { ok: 1 }), true; }
        if (m === 'DELETE') { db.prepare('DELETE FROM journal_entries WHERE id=?').run(+b); audit(req, 'delete', 'journal_entries', +b); return send(res, 200, { ok: 1 }), true; }
      }
      if (a === 'ledger' && m === 'GET') {
        const code = q('account'), from = q('from'), to = q('to'), A = acct();
        const prior = code && from ? round(flat(null, new Date(new Date(from).getTime() - 864e5).toISOString().slice(0, 10)).filter(l => l.account === code).reduce((s, l) => s + l.debit - l.credit, 0)) : 0;
        let run = prior; const lines = flat(from, to).filter(l => !code || l.account === code).map(l => ({ ...l, balance: (run = round(run + l.debit - l.credit)), account_name: A[l.account]?.name }));
        return send(res, 200, { account: A[code] || null, opening: prior, lines: lines.slice(-3000) }), true;
      }
      if (a === 'financials' && m === 'GET') return send(res, 200, financials(q('from') || `${new Date().getFullYear()}-01-01`, q('to') || today())), true;

      if (a === 'bank') {
        if (m === 'GET' && !b) {
          const lines = db.prepare('SELECT l.*, p.kind pkind, p.reference pref FROM bank_lines l LEFT JOIN payments p ON p.id=l.payment_id ORDER BY l.date DESC, l.id DESC').all(), pay = eligible();
          const bookBal = round(flat(null, today()).filter(l => l.account === '1000').reduce((s, l) => s + l.debit - l.credit, 0));
          const unL = lines.filter(l => !l.payment_id);
          return send(res, 200, { lines, unmatched_payments: pay, summary: { statement_balance: round(lines.reduce((s, l) => s + l.amount, 0)), book_balance: bookBal, unmatched_lines: round(unL.reduce((s, l) => s + l.amount, 0)), unmatched_payments: round(pay.reduce((s, p) => s + p.signed, 0)) } }), true;
        }
        if (m === 'POST' && b === 'import') {
          const x = await readBody(req, 3e6), rows = Array.isArray(x.lines) ? x.lines : parseCsv(x.csv); let added = 0;
          for (const r of rows) {
            if (!/^\d{4}-\d\d-\d\d$/.test(r.date || '') || !Number.isFinite(+r.amount)) continue;
            if (db.prepare('SELECT 1 FROM bank_lines WHERE date=? AND description=? AND amount=?').get(r.date, r.description || '', +r.amount)) continue;
            db.prepare('INSERT INTO bank_lines(date,description,amount) VALUES(?,?,?)').run(r.date, r.description || '', +r.amount); added++;
          }
          audit(req, 'import', 'bank', 0, `${added} lines`); return send(res, 200, { added, skipped: rows.length - added }), true;
        }
        if (m === 'POST' && b === 'match') {
          const x = await readBody(req), l = db.prepare('SELECT * FROM bank_lines WHERE id=?').get(+x.line_id), p = eligible().find(y => y.id === +x.payment_id);
          if (!l || l.payment_id) bad('Statement line not available'); if (!p) bad('Payment not available for matching');
          if (Math.abs(l.amount - p.signed) > 0.005 && !x.force) bad(`Amounts differ (statement ${l.amount}, book ${p.signed})`);
          db.prepare('UPDATE bank_lines SET payment_id=? WHERE id=?').run(p.id, l.id); db.prepare('UPDATE payments SET reconciled=1 WHERE id=?').run(p.id);
          return send(res, 200, { ok: 1 }), true;
        }
        if (m === 'POST' && b === 'unmatch') { const x = await readBody(req), l = db.prepare('SELECT * FROM bank_lines WHERE id=?').get(+x.line_id); if (l?.payment_id) { db.prepare('UPDATE payments SET reconciled=0 WHERE id=?').run(l.payment_id); db.prepare('UPDATE bank_lines SET payment_id=NULL WHERE id=?').run(l.id); } return send(res, 200, { ok: 1 }), true; }
        if (m === 'POST' && b === 'auto-match') {
          let n = 0;
          for (const l of db.prepare('SELECT * FROM bank_lines WHERE payment_id IS NULL ORDER BY date').all()) {
            const cand = eligible().filter(p => Math.abs(p.signed - l.amount) < 0.005 && Math.abs(new Date(p.date) - new Date(l.date)) <= 7 * 864e5);
            if (cand.length >= 1) { db.prepare('UPDATE bank_lines SET payment_id=? WHERE id=?').run(cand[0].id, l.id); db.prepare('UPDATE payments SET reconciled=1 WHERE id=?').run(cand[0].id); n++; }
          }
          return send(res, 200, { matched: n }), true;
        }
        if (m === 'DELETE') { const l = db.prepare('SELECT * FROM bank_lines WHERE id=?').get(+c); if (l?.payment_id) bad('Unmatch the line first'); db.prepare('DELETE FROM bank_lines WHERE id=?').run(+c); return send(res, 200, { ok: 1 }), true; }
      }

      if (a === 'einvoice' && m === 'GET') {
        const e = enrich(), st = ctx.getSettings(), rows = e.invoices.filter(i => !i.voided), issues = [];
        for (const i of rows) { const p = []; if (!i.client_trn) p.push('buyer TRN'); if (!i.client_address) p.push('buyer address'); if (i.items.some(x => !x.unit)) p.push('line unit of measure'); if (p.length) issues.push({ number: i.number, missing: p }); }
        return send(res, 200, { company_trn: C.validTrn(st.trn), invoices: rows.length, with_issues: issues.length, issues: issues.slice(0, 100) }), true;
      }

      if (a === 'export' && m === 'GET') {
        const e = enrich(), from = q('from'), to = q('to'), inR = d => (!from || d >= from) && (!to || d <= to);
        const T = {
          invoices: () => [['Number', 'Type', 'Date', 'Due', 'Client', 'Project', 'Subtotal', 'VAT', 'Total', 'Retention', 'Paid', 'Balance', 'Status'], ...e.invoices.filter(i => inR(i.date)).map(i => [i.number, i.kind, i.date, i.due_date, i.client_name, i.project_name, i.subtotal, i.vat, i.total, i.retention, i.paid, i.balance, i.status])],
          bills: () => [['Date', 'Supplier', 'Project', 'Category', 'Description', 'Reference', 'Amount', 'VAT', 'Total', 'Paid', 'Balance'], ...e.bills.filter(x => inR(x.date)).map(x => [x.date, x.party_name, x.project_name, x.category, x.description, x.reference, x.amount, x.vat_amount, x.total, x.paid, x.balance])],
          payments: () => [['Date', 'Type', 'Party', 'Reference', 'Method', 'Amount', 'Cheque status'], ...e.payments.filter(x => inR(x.date)).map(x => [x.date, x.kind, x.party_name, x.ref_label, x.method, x.amount, x.cheque_status])],
          parties: () => [['Type', 'Name', 'TRN', 'Phone', 'Email', 'Address', 'Bank', 'IBAN'], ...Object.values(e.parties).map(x => [x.type, x.name, x.trn, x.phone, x.email, x.address, x.bank_name, x.iban])],
          projects: () => [['Code', 'Name', 'Client', 'Contract', 'Variations', 'Invoiced', 'Cost', 'Profit', 'Margin %', 'Status'], ...ctx.projectRows().map(p => [p.code, p.name, e.parties[p.client_id]?.name, p.contract_value, p.variations, p.invoiced, p.cost, p.profit, p.margin, p.status])],
          employees: () => [['Name', 'Designation', 'Person code', 'Basic', 'Housing', 'Other', 'Join date', 'Status'], ...db.prepare('SELECT * FROM employees ORDER BY name').all().map(x => [x.name, x.designation, x.person_code, x.basic, x.housing, x.other_allowance, x.join_date, x.status])],
          payroll: () => [['Month', 'Employee', 'Days', 'Fixed', 'Overtime', 'Bonus', 'Deductions', 'Net', 'Status'], ...ctx.payrollRows(q('month')).map(x => [x.month, x.name, x.days_worked, x.fixed, x.overtime, x.bonus, x.deductions, x.net, x.status])],
          vat: () => { const v = ctx.vatReport(from, to); return [['Section', 'Date', 'Document', 'Party', 'Net', 'VAT'], ...v.sales.map(i => ['Sales', i.date, i.number, i.client_name, i.subtotal, i.vat]), ...v.purchases.map(x => ['Purchases', x.date, x.reference || x.id, x.party_name, x.amount, x.vat_amount])]; },
          trial_balance: () => { const f = financials(from || `${new Date().getFullYear()}-01-01`, to || today()); return [['Code', 'Account', 'Debit', 'Credit'], ...f.trial_balance.map(r => [r.code, r.name, r.debit, r.credit]), ['', 'Total', f.tb_debit, f.tb_credit]]; },
          journal: () => [['Date', 'Ref', 'Memo', 'Account', 'Debit', 'Credit'], ...flat(from, to).map(l => [l.date, l.ref, l.memo, l.account, l.debit, l.credit])],
          assets: () => [['Name', 'Category', 'Purchase date', 'Cost', 'Accumulated depreciation', 'Net book value'], ...ctx.assetRegister(to || today()).map(x => [x.name, x.category, x.purchase_date, x.cost, x.accumulated, x.nbv])],
          stock: () => [['Code', 'Item', 'Unit', 'Min qty'], ...db.prepare('SELECT * FROM stock_items').all().map(x => [x.code, x.name, x.unit, x.min_qty])],
        };
        if (!T[b]) return send(res, 404, { error: 'unknown export' }), true;
        const body = csv(T[b]());
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${b}-${today()}.csv"` });
        return res.end(body), true;
      }
      return false;
    },
  };
};
