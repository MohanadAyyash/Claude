// Partners (owners): capital, partner loans and current accounts per partner, profit shares with effective dates, optional
// year-end profit allocation, expenses a partner paid for the company, statements of account, and the reconciliation of the
// partner sub-ledger with the general ledger.
//
// Like the rest of the ledger, nothing here stores ledger lines: every partner movement is a record (partner_txns,
// partner_allocations, or a payment of a bill with method 'partner') and both the ledger (ctx.partnerEntries, read by
// modules/accounting.js) and the partner statement are derived from the same records.
//
// Accounts: 3000 Share capital (per partner), 2500 Partner loans (liability: the company owes it back), 3110 Partner current
// accounts (deposits, withdrawals, expenses paid for the company, allocated profit), 3900 Opening balance equity (balances that
// existed before the system), 3100 Retained earnings (profit allocated to the partners leaves it).
// Sign convention in a partner statement: positive = in the partner's favour (the company owes it to the partner / partner equity).
const { esc, money, bi } = require('../lib/render');

const SECTIONS = { capital: '3000', loan: '2500', current: '3110' };
const TYPES = {                       // type -> [section, sign]
  capital_in: ['capital', 1], capital_out: ['capital', -1], loan_in: ['loan', 1], loan_repay: ['loan', -1], deposit: ['current', 1], withdrawal: ['current', -1],
};
const LABEL = {
  capital_in: ['Capital paid in', 'دفع رأس مال'], capital_out: ['Capital returned', 'إرجاع رأس مال'], loan_in: ['Loan to the company', 'قرض للشركة'],
  loan_repay: ['Loan repaid by the company', 'سداد قرض من الشركة'], deposit: ['Deposit to current account', 'إيداع في الحساب الجاري'],
  withdrawal: ['Withdrawal', 'سحب'], transfer: ['Transfer between accounts', 'تحويل بين الحسابات'],
};
const SEC_LABEL = { capital: ['Capital', 'رأس المال'], loan: ['Partner loan', 'قرض الشريك'], current: ['Current account', 'الحساب الجاري'] };
const METHODS = ['bank', 'cash', 'opening', 'books'];

module.exports = ctx => {
  const { db, send, bad, audit, readBody, today, round, getSettings } = ctx;
  db.exec(`CREATE TABLE IF NOT EXISTS partners(id INTEGER PRIMARY KEY, name TEXT NOT NULL, name_ar TEXT, user_id INTEGER, employee_id INTEGER, active INTEGER DEFAULT 1, notes TEXT, created TEXT);
  CREATE TABLE IF NOT EXISTS partner_shares(id INTEGER PRIMARY KEY, partner_id INTEGER NOT NULL, pct REAL NOT NULL, from_date TEXT NOT NULL, created TEXT, created_by TEXT);
  CREATE TABLE IF NOT EXISTS partner_txns(id INTEGER PRIMARY KEY, partner_id INTEGER NOT NULL, date TEXT NOT NULL, type TEXT NOT NULL, amount REAL NOT NULL, method TEXT, bank_account_id INTEGER,
    from_section TEXT, to_section TEXT, reference TEXT, note TEXT, created TEXT, created_by TEXT);
  CREATE TABLE IF NOT EXISTS partner_allocations(id INTEGER PRIMARY KEY, year INTEGER UNIQUE NOT NULL, date TEXT NOT NULL, net_profit REAL NOT NULL, lines TEXT NOT NULL, created TEXT, created_by TEXT);`);
  if (!db.prepare('PRAGMA table_info(payments)').all().some(c => c.name === 'partner_id')) db.exec('ALTER TABLE payments ADD COLUMN partner_id INTEGER');
  if (!db.prepare('PRAGMA table_info(payments)').all().some(c => c.name === 'created_bill')) db.exec('ALTER TABLE payments ADD COLUMN created_bill INTEGER DEFAULT 0');   // 1 = the bill was created together with this payment
  const seed = db.prepare('INSERT OR IGNORE INTO accounts(code,name,name_ar,type,system) VALUES(?,?,?,?,1)');
  // loaded after modules/accounting.js (which creates the chart of accounts). A code the company already used for an account of
  // its own (system=0, e.g. 2500 "Bank loan") is never taken over: partner movements are refused and the daily check fails.
  seed.run('2500', 'Partner loans', 'قروض الشركاء', 'liability'); seed.run('3110', 'Partner current accounts', 'جاري الشركاء', 'equity'); seed.run('3900', 'Opening balance equity', 'حقوق ملكية افتتاحية', 'equity');
  const taken = () => db.prepare("SELECT code, name FROM accounts WHERE code IN ('2500','3110','3900') AND COALESCE(system,0)=0").all();
  const takenMsg = t => `Account ${t.map(x => `${x.code} is already used by your own account "${x.name}"`).join(', ')} — partner accounts cannot be used until that account is given another code (ask your administrator / support)`;
  const needCodes = () => { const t = taken(); if (t.length) bad(takenMsg(t)); };

  const isDate = d => /^\d{4}-\d\d-\d\d$/.test(d || '');
  const lockDate = () => { const d = getSettings().lock_date; return isDate(d) ? d : ''; };
  const guardDate = (d, what) => { const l = lockDate(); if (l && d <= l) bad(`The accounting period is closed up to ${l} — ${what} dated ${d} cannot be added, changed or removed.`); };
  const partner = id => db.prepare('SELECT * FROM partners WHERE id=?').get(+id);
  const partnersList = () => db.prepare('SELECT * FROM partners ORDER BY active DESC, id').all();
  const cashAcct = t => t.method === 'cash' ? '1020' : t.method === 'opening' ? '3900' : ctx.bankCode ? ctx.bankCode(t.bank_account_id) : '1000';
  const mk = (account, debit = 0, credit = 0) => [account, round(debit), round(credit)];
  const desc = t => t.type === 'transfer' ? `${LABEL.transfer[0]}: ${SEC_LABEL[t.from_section][0]} → ${SEC_LABEL[t.to_section][0]}` : LABEL[t.type][0];

  // ---------------- shares (effective-dated) ----------------
  const sharesRows = () => db.prepare('SELECT * FROM partner_shares ORDER BY from_date, id').all();
  // share of every partner on a date: the latest row on or before that date (a later row with 0 means the partner left)
  const sharesOn = (date, rows = sharesRows()) => {
    const out = {};
    for (const r of rows) if (r.from_date <= date) out[r.partner_id] = r.pct;
    for (const k of Object.keys(out)) if (!out[k]) delete out[k];
    return out;
  };
  const sumPct = s => round(Object.values(s).reduce((a, b) => a + b, 0));

  // ---------------- profit allocation ----------------
  const daysIn = y => ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0) ? 366 : 365;
  const addDay = d => new Date(Date.parse(d + 'T00:00:00Z') + 864e5).toISOString().slice(0, 10);
  // day-weighted shares over the year: [{from, to, days, shares}], and the problems that block an allocation
  function yearSegments(y) {
    const rows = sharesRows(), start = `${y}-01-01`, end = `${y}-12-31`;
    const cuts = [...new Set([start, ...rows.map(r => r.from_date).filter(d => d > start && d <= end)])].sort();
    const segs = cuts.map((from, i) => {
      const to = i + 1 < cuts.length ? new Date(Date.parse(cuts[i + 1] + 'T00:00:00Z') - 864e5).toISOString().slice(0, 10) : end;
      return { from, to, days: Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 864e5) + 1, shares: sharesOn(from, rows) };
    });
    const problems = segs.filter(s => Math.abs(sumPct(s.shares) - 100) > 0.01).map(s => `Shares from ${s.from} to ${s.to} add up to ${sumPct(s.shares)}%, not 100%`);
    return { segs, problems };
  }
  function allocationPreview(y) {
    y = +y; const problems = [];
    if (!Number.isInteger(y) || y < 2000 || y > 2999) bad('Enter a valid year');
    if (`${y}-12-31` >= today()) problems.push(`The year ${y} has not ended yet`);
    if (db.prepare('SELECT 1 FROM partner_allocations WHERE year=?').get(y)) problems.push(`The profit of ${y} is already allocated`);
    const { segs, problems: sp } = yearSegments(y); problems.push(...sp);
    if (!sharesRows().length) problems.push('No partner shares are recorded');
    const f = ctx.financials(`${y}-01-01`, `${y}-12-31`), profit = round(f.net_profit), N = daysIn(y);
    const weight = {};
    for (const s of segs) for (const [pid, pct] of Object.entries(s.shares)) weight[pid] = (weight[pid] || 0) + s.days * pct;
    let lines = Object.entries(weight).map(([pid, w]) => ({ partner_id: +pid, name: partner(pid)?.name || `#${pid}`, name_ar: partner(pid)?.name_ar || '', pct: round(w / N), amount: round(profit * w / (100 * N)) }));
    const diff = round(profit - lines.reduce((s, l) => s + l.amount, 0));
    if (lines.length && Math.abs(diff) >= 0.005 && !problems.length) { const big = lines.reduce((a, b) => (b.pct > a.pct ? b : a)); big.amount = round(big.amount + diff); }   // the rounding cent goes to the largest share
    lines = lines.filter(l => l.amount || l.pct);
    return { year: y, date: `${y}-12-31`, net_profit: profit, revenue: f.revenue, expenses: f.expenses, segments: segs, lines, problems, ok: !problems.length };
  }
  const allocations = () => db.prepare('SELECT * FROM partner_allocations ORDER BY year').all().map(a => ({ ...a, lines: JSON.parse(a.lines || '[]') }));

  // ---------------- ledger entries (read by modules/accounting.js) ----------------
  ctx.partnerEntries = () => {
    const out = [], names = Object.fromEntries(partnersList().map(p => [p.id, p.name]));
    for (const t of db.prepare('SELECT * FROM partner_txns ORDER BY date, id').all()) {
      const who = names[t.partner_id] || `#${t.partner_id}`, ref = `PTR-${t.id}`, memo = `${desc(t)} — ${who}${t.note ? ' — ' + t.note : ''}`;
      if (t.type === 'transfer') { out.push({ date: t.date, ref, memo, lines: [mk(SECTIONS[t.from_section], t.amount), mk(SECTIONS[t.to_section], 0, t.amount)] }); continue; }
      const [sec, sign] = TYPES[t.type], acc = SECTIONS[sec];
      if (t.method === 'books') {
        if (sec === 'capital') continue;                            // capital already credited to 3000 by an earlier journal: only assigned to the partner
        const lines = sign > 0 ? [mk('3100', t.amount), mk(acc, 0, t.amount)] : [mk(acc, t.amount), mk('3100', 0, t.amount)];   // owner movements kept in 3100 move to the partner's current account
        out.push({ date: t.date, ref, memo, lines }); continue;
      }
      const cash = cashAcct(t);
      out.push({ date: t.date, ref, memo, lines: sign > 0 ? [mk(cash, t.amount), mk(acc, 0, t.amount)] : [mk(acc, t.amount), mk(cash, 0, t.amount)] });
    }
    for (const a of allocations()) for (const l of a.lines) {
      if (!l.amount) continue;
      const who = names[l.partner_id] || `#${l.partner_id}`, memo = `${l.amount >= 0 ? 'Profit' : 'Loss'} ${a.year} allocated — ${who} (${l.pct}%)`;
      out.push({ date: a.date, ref: `PALLOC-${a.year}`, memo, lines: l.amount > 0 ? [mk('3100', l.amount), mk('3110', 0, l.amount)] : [mk('3110', -l.amount), mk('3100', 0, -l.amount)] });
    }
    return out;
  };

  // ---------------- partner statement ----------------
  function moves(pid) {
    const out = [];
    for (const t of db.prepare('SELECT * FROM partner_txns WHERE partner_id=? ORDER BY date, id').all(pid)) {
      const base = { date: t.date, ref: `PTR-${t.id}`, id: t.id, kind: 'txn', type: t.type, method: t.method, note: t.note || '', reference: t.reference || '' };
      if (t.type === 'transfer') {
        const ar = `${LABEL.transfer[1]}: ${SEC_LABEL[t.from_section][1]} ← ${SEC_LABEL[t.to_section][1]}`;
        out.push({ ...base, section: t.from_section, amount: -t.amount, description: desc(t), description_ar: ar });
        out.push({ ...base, section: t.to_section, amount: t.amount, description: desc(t), description_ar: ar });
      } else {
        const [sec, sign] = TYPES[t.type], how = t.method === 'opening' ? [' (opening balance)', ' (رصيد افتتاحي)'] : t.method === 'books' ? [' (already in the books)', ' (مسجّل مسبقاً)'] : ['', ''];
        out.push({ ...base, section: sec, amount: sign * t.amount, description: LABEL[t.type][0] + how[0], description_ar: LABEL[t.type][1] + how[1] });
      }
    }
    for (const p of db.prepare("SELECT p.*, b.description bdesc, b.reference bref, b.project_id, pr.name project_name, pa.name supplier FROM payments p LEFT JOIN bills b ON b.id=p.bill_id LEFT JOIN projects pr ON pr.id=b.project_id LEFT JOIN parties pa ON pa.id=b.party_id WHERE p.method='partner' AND p.kind='out' AND p.partner_id=? ORDER BY p.date, p.id").all(pid))
      out.push({ date: p.date, ref: p.bref || `BILL-${p.bill_id}`, id: p.id, kind: 'expense', bill_id: p.bill_id, section: 'current', amount: round(p.amount),
        description: `Paid for the company — ${[p.supplier, p.bdesc, p.project_name].filter(Boolean).join(' — ')}`, description_ar: `دفعه عن الشركة — ${[p.supplier, p.bdesc, p.project_name].filter(Boolean).join(' — ')}`, note: p.notes || '', reference: p.reference || '' });
    for (const a of allocations()) for (const l of a.lines) if (l.partner_id === pid && l.amount)
      out.push({ date: a.date, ref: `PALLOC-${a.year}`, id: a.id, kind: 'allocation', section: 'current', amount: round(l.amount), description: `${l.amount > 0 ? 'Share of profit' : 'Share of loss'} ${a.year} (${l.pct}%)`, description_ar: `${l.amount > 0 ? 'نصيبه من ربح' : 'نصيبه من خسارة'} ${a.year} (${l.pct}%)` });
    return out.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : (x.ref < y.ref ? -1 : 1)));
  }
  // first date on which the capital or the loan of a partner would be below zero (with extra moves added / one txn left out)
  function lowPoint(pid, extra = [], skipTxn = null) {
    const all = moves(pid).filter(m => !(skipTxn && m.kind === 'txn' && m.id === skipTxn)).concat(extra)
      .sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : (y.amount - x.amount)));   // same day: money in before money out
    const run = { capital: 0, loan: 0 };
    for (const m of all) if (m.section in run) { run[m.section] = round(run[m.section] + m.amount); if (run[m.section] < -0.005) return { section: m.section, date: m.date }; }
    return null;
  }
  function balances(pid, asOf = '9999-12-31') {
    const b = { capital: 0, loan: 0, current: 0 };
    for (const m of moves(pid)) if (m.date <= asOf) b[m.section] = round(b[m.section] + m.amount);
    return { ...b, total: round(b.capital + b.loan + b.current) };
  }
  function statement(pid, from, to) {
    const p = partner(pid); if (!p) { const e = new Error('not found'); e.status = 404; throw e; }
    to = isDate(to) ? to : today(); from = isDate(from) ? from : null;
    const all = moves(p.id), sec = {};
    for (const s of Object.keys(SECTIONS)) {
      const mine = all.filter(m => m.section === s);
      const opening = round(mine.filter(m => from && m.date < from).reduce((t, m) => t + m.amount, 0));
      let bal = opening; const lines = [];
      for (const m of mine) if ((!from || m.date >= from) && m.date <= to) { bal = round(bal + m.amount); lines.push({ ...m, balance: bal }); }
      sec[s] = { account: SECTIONS[s], opening, lines, closing: bal };
    }
    const total = round(sec.capital.closing + sec.loan.closing + sec.current.closing);
    return { partner: { id: p.id, name: p.name, name_ar: p.name_ar, active: !!p.active, employee_id: p.employee_id, user_id: p.user_id }, share: sharesOn(to)[p.id] || 0, from, to, sections: sec, total };
  }

  // ---------------- reconciliation with the general ledger ----------------
  function reconcile() {
    if (!ctx.financials) return null;
    const tb = ctx.financials('0000-01-01', '9999-12-31').trial_balance, credit = code => { const r = tb.find(x => x.code === code); return r ? round(r.credit - r.debit) : 0; };
    const sub = { capital: 0, loan: 0, current: 0 };
    for (const p of partnersList()) { const b = balances(p.id); for (const k of Object.keys(sub)) sub[k] = round(sub[k] + b[k]); }
    const rows = Object.entries(SECTIONS).map(([s, code]) => ({ section: s, account: code, ledger: credit(code), partners: sub[s], difference: round(credit(code) - sub[s]) }));
    return { rows, unassigned_capital: rows[0].difference };
  }
  ctx.partnerChecks = () => {
    const out = [], parts = partnersList(), t = taken();
    if (t.length) out.push({ status: 'fail', detail: t.map(x => `account ${x.code} is already used by an account of the company's own, so the partner accounts cannot use it`).join('; ') });
    if (!parts.length) return out;
    const r = reconcile();
    if (r) {
      const loanCur = r.rows.filter(x => x.section !== 'capital' && Math.abs(x.difference) >= 0.01);
      // no amounts here: the daily report may be posted to a GitHub issue
      out.push(loanCur.length ? { status: 'fail', detail: loanCur.map(x => `account ${x.account}: the general ledger and the partner accounts differ`).join('; ') }
        : r.unassigned_capital <= -0.01 ? { status: 'fail', detail: 'the partners hold more share capital than account 3000 shows — a capital journal entry was changed or removed after it was assigned' }
        : Math.abs(r.unassigned_capital) >= 0.01 ? { status: 'warn', detail: 'part of the share capital (3000) in the books is not assigned to a partner — record it per partner with "already in the books"' }
          : { status: 'ok', detail: 'capital, partner loans and current accounts equal the general ledger' });
    }
    const s = sumPct(sharesOn(today()));
    if (Math.abs(s - 100) > 0.01) out.push({ status: 'warn', detail: 'partner shares today do not add up to 100%' });
    for (const a of allocations()) {
      const now = round(ctx.financials(`${a.year}-01-01`, `${a.year}-12-31`).net_profit);
      if (Math.abs(now - a.net_profit) >= 0.01) out.push({ status: 'warn', detail: `the profit of ${a.year} changed after it was allocated to the partners — delete and allocate the year again` });
    }
    return out;
  };

  // ---------------- checks for records ----------------
  function checkTxn(x) {
    const p = partner(x.partner_id); if (!p) bad('Select a partner');
    if (!isDate(x.date)) bad('Enter a valid date');
    const amount = round(+x.amount); if (!(amount > 0)) bad('The amount must be greater than zero');
    if (x.type === 'transfer') {
      if (!SECTIONS[x.from_section] || !SECTIONS[x.to_section] || x.from_section === x.to_section) bad('Choose two different accounts to transfer between');
      const bal = balances(p.id, x.date)[x.from_section];
      if (amount > bal + 0.005) bad(`The ${SEC_LABEL[x.from_section][0].toLowerCase()} balance on ${x.date} is ${bal}`);
      const low = lowPoint(p.id, [{ date: x.date, section: x.from_section, amount: -amount }]);
      if (low) bad(`The ${SEC_LABEL[low.section][0].toLowerCase()} would go below zero on ${low.date}`);
      return { partner_id: p.id, date: x.date, type: 'transfer', amount, method: null, bank_account_id: null, from_section: x.from_section, to_section: x.to_section };
    }
    if (!TYPES[x.type]) bad('Choose the type of movement');
    const method = x.method || 'bank'; if (!METHODS.includes(method)) bad('Choose how it was paid');
    const [sec, sign] = TYPES[x.type];
    if (method === 'books') {
      if (sec === 'loan') bad('"Already in the books" is for capital and current accounts only');
      if (sec === 'capital') {
        if (sign < 0) bad('"Already in the books" capital can only be assigned, not returned');
        const r = reconcile(), free = r ? r.unassigned_capital : 0;
        if (amount > free + 0.005) bad(`Only ${free} of share capital in the books is not yet assigned to a partner`);
      }
    }
    if (sign < 0 && sec !== 'current') {                            // capital or a loan cannot go below zero, on that date or later
      const bal = balances(p.id, x.date)[sec];
      if (amount > bal + 0.005) bad(`The ${SEC_LABEL[sec][0].toLowerCase()} balance on ${x.date} is ${bal}`);
      const low = lowPoint(p.id, [{ date: x.date, section: sec, amount: -amount }]);
      if (low) bad(`The ${SEC_LABEL[sec][0].toLowerCase()} would go below zero on ${low.date}`);
    }
    let bank = null;
    if (method === 'bank') { bank = +x.bank_account_id || null; if (bank && !db.prepare('SELECT 1 FROM bank_accounts WHERE id=?').get(bank)) bad('Unknown bank account'); }
    return { partner_id: p.id, date: x.date, type: x.type, amount, method, bank_account_id: bank, from_section: null, to_section: null };
  }
  const journalBlock = lines => {                                     // the partner accounts are kept from the Partners page only (checked on new, edited and deleted journals)
    const used = new Set((lines || []).map(l => String(l.account))), mine = c => !taken().some(t => t.code === c);
    if ((used.has('2500') && mine('2500')) || (used.has('3110') && mine('3110'))) bad('Accounts 2500 (partner loans) and 3110 (partner current accounts) are kept from the Partners page — record the movement there');
    if (used.has('3000') && partnersList().length) bad('Share capital (3000) is kept per partner from the Partners page — record the movement there');
  };
  ctx.journalGuard = journalBlock;

  const view = p => { const b = balances(p.id); return { ...p, active: !!p.active, share: sharesOn(today())[p.id] || 0, balances: b }; };

  // ---------------- printable statement ----------------
  function renderStatement(id, me, qp) {
    const s = statement(id, qp && qp.get ? qp.get('from') : null, qp && qp.get ? qp.get('to') : null), S = getSettings();
    const sign = v => v >= 0 ? money(v) : `(${money(-v)})`;
    const table = k => {
      const x = s.sections[k], L = SEC_LABEL[k];
      if (!x.lines.length && !x.opening && !x.closing) return '';
      return `<h2 style="font-size:11pt;margin:5mm 0 1mm">${bi(S, L[0], L[1])} <span style="font-weight:normal;color:#8A8578">(${x.account})</span></h2>
      <table class="items"><thead><tr><th>Date</th><th>Ref</th><th>Description</th><th>Amount</th><th>Balance</th></tr></thead><tbody>
      ${s.from ? `<tr><td>${esc(s.from)}</td><td></td><td>${bi(S, 'Opening balance', 'رصيد افتتاحي')}</td><td></td><td class="n">${sign(x.opening)}</td></tr>` : ''}
      ${x.lines.map(l => `<tr><td>${esc(l.date)}</td><td>${esc(l.ref)}</td><td>${esc(bi(S, l.description, l.description_ar || l.description))}${l.note && l.note !== 'partner-expense' ? ` — ${esc(l.note)}` : ''}</td><td class="n">${sign(l.amount)}</td><td class="n">${sign(l.balance)}</td></tr>`).join('')}
      <tr><td colspan="4"><b>${bi(S, 'Closing balance', 'الرصيد الختامي')}</b></td><td class="n"><b>${sign(x.closing)}</b></td></tr></tbody></table>`;
    };
    const body = `<h1 style="font-size:16pt;margin:0 0 2mm">${bi(S, 'Partner statement of account', 'كشف حساب شريك')}</h1>
      <p><b>${esc(s.partner.name)}</b>${s.partner.name_ar ? ` · ${esc(s.partner.name_ar)}` : ''}${s.share ? ` · ${bi(S, 'Share', 'الحصة')} ${s.share}%` : ''}<br>${s.from ? `${esc(s.from)} → ` : 'Up to '}${esc(s.to)} · AED</p>
      ${Object.keys(SECTIONS).map(table).join('')}
      <table class="items" style="margin-top:6mm"><tbody>
      ${Object.keys(SECTIONS).map(k => `<tr><td>${bi(S, SEC_LABEL[k][0], SEC_LABEL[k][1])}</td><td class="n">${sign(s.sections[k].closing)}</td></tr>`).join('')}
      <tr><td><b>${bi(S, 'Total in the partner\'s favour', 'الإجمالي لصالح الشريك')}</b></td><td class="n"><b>${sign(s.total)}</b></td></tr></tbody></table>
      <p style="font-size:8pt;color:#8A8578;margin-top:4mm">${bi(S, 'Positive amounts are in the partner\'s favour; amounts in brackets are owed by the partner to the company.', 'المبالغ الموجبة لصالح الشريك؛ المبالغ بين قوسين مستحقة على الشريك للشركة.')}</p>`;
    return { title: `Partner statement — ${s.partner.name}`, filename: `partner-statement-${s.partner.name.replace(/\s+/g, '-')}-${s.to}`, body, date: s.to, label: bi(S, 'Accounts', 'الحسابات'), stamp: true };
  }
  ctx.renderers = ctx.renderers || {};
  ctx.renderers.partner_statement = renderStatement;

  return {
    async handle(req, res, url, [a, b, c], me) {
      const m = req.method, q = k => url.searchParams.get(k);
      if (a === 'partners') {
        if (m === 'GET' && !b) {
          const list = partnersList().map(view), r = reconcile();
          const tot = k => round(list.reduce((s, p) => s + p.balances[k], 0));
          return send(res, 200, { partners: list, shares: sharesRows(), shares_today: sumPct(sharesOn(today())), totals: { capital: tot('capital'), loan: tot('loan'), current: tot('current'), total: tot('total') }, reconciliation: r, allocations: allocations() }), true;
        }
        if (m === 'GET' && b === 'allocation-preview') return send(res, 200, allocationPreview(q('year'))), true;
        if (m === 'POST' && !b) {
          const x = req._body || await readBody(req);
          if (!String(x.name || '').trim()) bad('Enter the partner name');
          if (x.employee_id && !db.prepare('SELECT 1 FROM employees WHERE id=?').get(+x.employee_id)) bad('Unknown employee');
          if (x.user_id && !db.prepare('SELECT 1 FROM users WHERE id=?').get(+x.user_id)) bad('Unknown user');
          const r = db.prepare('INSERT INTO partners(name,name_ar,user_id,employee_id,active,notes,created) VALUES(?,?,?,?,1,?,?)').run(String(x.name).trim(), x.name_ar || '', +x.user_id || null, +x.employee_id || null, x.notes || '', new Date().toISOString());
          audit(req, 'create', 'partners', Number(r.lastInsertRowid), String(x.name).trim()); return send(res, 200, { id: Number(r.lastInsertRowid) }), true;
        }
        if (b && /^\d+$/.test(b)) {
          const p = partner(b); if (!p) return send(res, 404, { error: 'not found' }), true;
          if (m === 'GET' && !c) return send(res, 200, view(p)), true;
          if (m === 'GET' && c === 'statement') return send(res, 200, statement(p.id, q('from'), q('to'))), true;
          if (m === 'PUT' && !c) {
            const x = req._body || await readBody(req);
            if ('name' in x && !String(x.name || '').trim()) bad('Enter the partner name');
            if (x.employee_id && !db.prepare('SELECT 1 FROM employees WHERE id=?').get(+x.employee_id)) bad('Unknown employee');
            db.prepare('UPDATE partners SET name=?, name_ar=?, user_id=?, employee_id=?, active=?, notes=? WHERE id=?').run('name' in x ? String(x.name).trim() : p.name, x.name_ar ?? p.name_ar, 'user_id' in x ? (+x.user_id || null) : p.user_id,
              'employee_id' in x ? (+x.employee_id || null) : p.employee_id, 'active' in x ? (+x.active ? 1 : 0) : p.active, x.notes ?? p.notes, p.id);
            audit(req, 'update', 'partners', p.id, Object.keys(x).join(',')); return send(res, 200, { ok: 1 }), true;
          }
          if (m === 'DELETE' && !c) {
            const used = db.prepare('SELECT (SELECT COUNT(*) FROM partner_txns WHERE partner_id=?)+(SELECT COUNT(*) FROM partner_shares WHERE partner_id=?)+(SELECT COUNT(*) FROM payments WHERE partner_id=?) n').get(p.id, p.id, p.id).n;
            if (used || allocations().some(al => al.lines.some(l => l.partner_id === p.id))) return send(res, 409, { error: 'This partner has shares or movements — mark the partner inactive instead' }), true;
            db.prepare('DELETE FROM partners WHERE id=?').run(p.id); audit(req, 'delete', 'partners', p.id, p.name); return send(res, 200, { ok: 1 }), true;
          }
          if (m === 'POST' && c === 'shares') {
            const x = req._body || await readBody(req), pct = round(+x.pct);
            if (!isDate(x.from_date)) bad('Enter the date the share applies from');
            if (!(pct >= 0 && pct <= 100)) bad('The share must be between 0 and 100%');
            for (const al of allocations()) if (x.from_date <= `${al.year}-12-31`) bad(`The profit of ${al.year} is already allocated with the shares of that year — a share can only start after ${al.year}-12-31 (or delete that allocation first)`);
            if (db.prepare('SELECT 1 FROM partner_shares WHERE partner_id=? AND from_date=?').get(p.id, x.from_date)) bad('This partner already has a share from that date — delete it first');
            const r = db.prepare('INSERT INTO partner_shares(partner_id,pct,from_date,created,created_by) VALUES(?,?,?,?,?)').run(p.id, pct, x.from_date, new Date().toISOString(), me.username);
            audit(req, 'create', 'partner_shares', Number(r.lastInsertRowid), `${p.name} ${pct}% from ${x.from_date}`);
            const total = sumPct(sharesOn(x.from_date));
            return send(res, 200, { id: Number(r.lastInsertRowid), total_on_date: total, warning: Math.abs(total - 100) > 0.01 ? `Shares on ${x.from_date} now add up to ${total}% — record the other partners' shares from the same date` : null }), true;
          }
          if (m === 'POST' && c === 'expense') {                        // an expense the partner paid for the company: a bill paid from the partner's current account
            needCodes();
            const x = req._body || await readBody(req), date = x.date || today(); if (!isDate(date)) bad('Enter a valid date'); guardDate(date, 'an expense');
            if (!p.active) bad('This partner is inactive');
            let billId;
            if (x.bill_id) {
              const bill = ctx.enrich().bills.find(k => k.id === +x.bill_id); if (!bill) bad('Bill not found');
              const amt = round(+x.amount || bill.balance); if (!(amt > 0)) bad('The amount must be greater than zero'); if (amt > bill.balance + 0.005) bad(`The open balance of this bill is ${bill.balance}`);
              billId = bill.id;
              const id = ctx.postOnce(me, `partner_expense|${p.id}|${date}|bill ${billId}|${amt}`, x, () => {
                const r = db.prepare("INSERT INTO payments(kind,date,amount,method,reference,bill_id,partner_id,notes) VALUES('out',?,?,'partner',?,?,?,?)").run(date, amt, x.reference || '', billId, p.id, x.note || '');
                audit(req, 'create', 'partner_expense', Number(r.lastInsertRowid), `${p.name} paid bill #${billId} ${amt}`); return Number(r.lastInsertRowid);
              }, 'payments');
              return send(res, 200, { payment_id: id, bill_id: billId }), true;
            }
            const amount = round(+x.amount), vat = round(+x.vat_amount || 0);
            if (!(amount > 0)) bad('Enter the expense amount'); if (vat < 0) bad('VAT cannot be negative'); if (vat > amount * 0.05 + 0.01) bad('VAT is more than 5% of the amount'); if (!String(x.description || '').trim()) bad('Enter a description');
            if (x.project_id && !db.prepare('SELECT 1 FROM projects WHERE id=?').get(+x.project_id)) bad('Unknown project');
            if (x.party_id && !db.prepare('SELECT 1 FROM parties WHERE id=?').get(+x.party_id)) bad('Unknown supplier');
            const id = ctx.postOnce(me, `partner_expense|${p.id}|${date}|${amount}|${vat}|${String(x.description).trim()}`, x, () => {
              const bill = db.prepare('INSERT INTO bills(date,party_id,project_id,category,description,amount,vat_amount,reference) VALUES(?,?,?,?,?,?,?,?)').run(date, +x.party_id || null, +x.project_id || null, x.category || 'other', String(x.description).trim(), amount, vat, x.reference || '');
              billId = Number(bill.lastInsertRowid);
              const r = db.prepare("INSERT INTO payments(kind,date,amount,method,reference,bill_id,partner_id,notes,created_bill) VALUES('out',?,?,'partner',?,?,?,?,1)").run(date, round(amount + vat), x.reference || '', billId, p.id, String(x.note || ''));
              audit(req, 'create', 'partner_expense', Number(r.lastInsertRowid), `${p.name} ${String(x.description).trim()} ${round(amount + vat)}`); return Number(r.lastInsertRowid);
            }, 'payments');
            return send(res, 200, { payment_id: id, bill_id: billId }), true;
          }
        }
        if (b === 'shares' && c && m === 'DELETE') {
          const s = db.prepare('SELECT * FROM partner_shares WHERE id=?').get(+c); if (!s) return send(res, 404, { error: 'not found' }), true;
          for (const al of allocations()) if (s.from_date <= `${al.year}-12-31`) bad(`The profit of ${al.year} was allocated with this share — delete that allocation first`);
          db.prepare('DELETE FROM partner_shares WHERE id=?').run(s.id); audit(req, 'delete', 'partner_shares', s.id, `${s.pct}% from ${s.from_date}`); return send(res, 200, { ok: 1 }), true;
        }
        if (b === 'expense' && c && m === 'DELETE') {
          const pay = db.prepare("SELECT * FROM payments WHERE id=? AND method='partner'").get(+c); if (!pay) return send(res, 404, { error: 'not found' }), true;
          guardDate(pay.date, 'an expense');
          ctx.tx(() => {
            db.prepare('DELETE FROM payments WHERE id=?').run(pay.id);
            const bill = pay.bill_id && db.prepare('SELECT * FROM bills WHERE id=?').get(pay.bill_id);
            if (bill && pay.created_bill && !db.prepare('SELECT 1 FROM payments WHERE bill_id=?').get(bill.id)) { db.prepare('DELETE FROM bills WHERE id=?').run(bill.id); audit(req, 'delete', 'bills', bill.id, 'created with a partner expense'); }   // the bill this page created goes with it
            audit(req, 'delete', 'partner_expense', pay.id, `${pay.amount}`);
          });
          return send(res, 200, { ok: 1 }), true;
        }
        return false;
      }
      if (a === 'partner_txns') {
        if (m === 'GET') return send(res, 200, db.prepare('SELECT * FROM partner_txns ORDER BY date DESC, id DESC').all()), true;
        if (m === 'POST' && !b) {
          needCodes();
          const x = req._body || await readBody(req), t = checkTxn(x); guardDate(t.date, 'a partner movement');
          const id = ctx.postOnce(me, `partner_txn|${t.partner_id}|${t.date}|${t.type}|${t.amount}|${t.method}|${t.from_section}|${t.to_section}`, x, () => {
            const r = db.prepare('INSERT INTO partner_txns(partner_id,date,type,amount,method,bank_account_id,from_section,to_section,reference,note,created,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
              .run(t.partner_id, t.date, t.type, t.amount, t.method, t.bank_account_id, t.from_section, t.to_section, x.reference || '', x.note || '', new Date().toISOString(), me.username);
            audit(req, 'create', 'partner_txns', Number(r.lastInsertRowid), `${t.type} ${t.amount}`); return Number(r.lastInsertRowid);
          }, 'partner_txns');
          return send(res, 200, { id }), true;
        }
        if (m === 'DELETE' && b) {
          const t = db.prepare('SELECT * FROM partner_txns WHERE id=?').get(+b); if (!t) return send(res, 404, { error: 'not found' }), true;
          guardDate(t.date, 'a partner movement');
          // removing a movement must not leave a capital or loan balance below zero at any later point
          const low = lowPoint(t.partner_id, [], t.id);
          if (low) bad(`This movement cannot be deleted: the ${SEC_LABEL[low.section][0].toLowerCase()} would go below zero on ${low.date} — delete the later movements first`);
          db.prepare('DELETE FROM partner_txns WHERE id=?').run(t.id); audit(req, 'delete', 'partner_txns', t.id, `${t.type} ${t.amount}`); return send(res, 200, { ok: 1 }), true;
        }
        return false;
      }
      if (a === 'partner_allocations') {
        if (m === 'GET') return send(res, 200, allocations()), true;
        if (m === 'POST') {
          needCodes();
          const x = req._body || await readBody(req), pv = allocationPreview(x.year);
          if (!pv.ok) bad(pv.problems.join('. '));
          guardDate(pv.date, 'a profit allocation');
          const r = db.prepare('INSERT INTO partner_allocations(year,date,net_profit,lines,created,created_by) VALUES(?,?,?,?,?,?)').run(pv.year, pv.date, pv.net_profit, JSON.stringify(pv.lines.map(l => ({ partner_id: l.partner_id, pct: l.pct, amount: l.amount }))), new Date().toISOString(), me.username);
          audit(req, 'create', 'partner_allocations', Number(r.lastInsertRowid), `${pv.year} ${pv.net_profit}`); return send(res, 200, { id: Number(r.lastInsertRowid), ...pv }), true;
        }
        if (m === 'DELETE' && b) {
          const al = db.prepare('SELECT * FROM partner_allocations WHERE id=?').get(+b); if (!al) return send(res, 404, { error: 'not found' }), true;
          guardDate(al.date, 'a profit allocation');
          db.prepare('DELETE FROM partner_allocations WHERE id=?').run(al.id); audit(req, 'delete', 'partner_allocations', al.id, `${al.year}`); return send(res, 200, { ok: 1 }), true;
        }
        return false;
      }
      return false;
    },
  };

};
