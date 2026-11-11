// Contractor ERP — zero-dependency server (Node >= 22.5, built-in SQLite)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');
const C = require('./lib/compliance');
const { sendMail, validEmail } = require('./lib/mailer');
const { docHtml, toText } = require('./lib/docs');
const ACLX = require('./lib/acl');

// secrets (Zoho OAuth client…) live in .env next to server.js — never in the code, the database or git
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* no .env */ }
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'erp.db'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE, salt TEXT, hash TEXT);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER, created INTEGER);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS parties(id INTEGER PRIMARY KEY, type TEXT DEFAULT 'client', name TEXT NOT NULL, trn TEXT, phone TEXT, email TEXT, address TEXT, notes TEXT, bank_name TEXT, iban TEXT);
CREATE TABLE IF NOT EXISTS projects(id INTEGER PRIMARY KEY, code TEXT, name TEXT NOT NULL, client_id INTEGER, location TEXT, contract_value REAL DEFAULT 0, start_date TEXT, end_date TEXT, status TEXT DEFAULT 'active', notes TEXT, emirate TEXT DEFAULT 'dubai', retention_pct REAL DEFAULT 0);
CREATE TABLE IF NOT EXISTS quotes(id INTEGER PRIMARY KEY, number TEXT, date TEXT, client_id INTEGER, project_name TEXT, validity_days INTEGER DEFAULT 30, status TEXT DEFAULT 'draft', items TEXT DEFAULT '[]', vat_pct REAL DEFAULT 5, notes TEXT, terms TEXT, project_id INTEGER);
CREATE TABLE IF NOT EXISTS invoices(id INTEGER PRIMARY KEY, number TEXT, date TEXT, due_date TEXT, project_id INTEGER, items TEXT DEFAULT '[]', vat_pct REAL DEFAULT 5, retention_pct REAL DEFAULT 0, notes TEXT, kind TEXT DEFAULT 'invoice', original_id INTEGER, voided INTEGER DEFAULT 0, void_reason TEXT);
CREATE TABLE IF NOT EXISTS bills(id INTEGER PRIMARY KEY, date TEXT, party_id INTEGER, project_id INTEGER, category TEXT DEFAULT 'materials', description TEXT, amount REAL DEFAULT 0, vat_amount REAL DEFAULT 0, reference TEXT);
CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, date TEXT, amount REAL DEFAULT 0, method TEXT DEFAULT 'bank', reference TEXT, invoice_id INTEGER, bill_id INTEGER, is_retention INTEGER DEFAULT 0, notes TEXT, cheque_date TEXT, cheque_status TEXT DEFAULT 'cleared');
CREATE TABLE IF NOT EXISTS employees(id INTEGER PRIMARY KEY, name TEXT NOT NULL, person_code TEXT, emirates_id TEXT, passport_no TEXT, nationality TEXT, designation TEXT, join_date TEXT, end_date TEXT, status TEXT DEFAULT 'active',
  basic REAL DEFAULT 0, housing REAL DEFAULT 0, other_allowance REAL DEFAULT 0, bank_name TEXT, routing_code TEXT, iban TEXT, project_id INTEGER, eid_expiry TEXT, visa_expiry TEXT, passport_expiry TEXT, card_expiry TEXT, notes TEXT);
CREATE TABLE IF NOT EXISTS payroll(id INTEGER PRIMARY KEY, month TEXT, employee_id INTEGER, project_id INTEGER, days_worked REAL DEFAULT 30, leave_days REAL DEFAULT 0, ot_normal_hours REAL DEFAULT 0, ot_special_hours REAL DEFAULT 0,
  bonus REAL DEFAULT 0, deductions REAL DEFAULT 0, fixed REAL DEFAULT 0, overtime REAL DEFAULT 0, gross REAL DEFAULT 0, net REAL DEFAULT 0, status TEXT DEFAULT 'draft', paid_date TEXT, notes TEXT, UNIQUE(month, employee_id));
CREATE TABLE IF NOT EXISTS boq_items(id INTEGER PRIMARY KEY, project_id INTEGER, section TEXT, description TEXT, unit TEXT, qty REAL DEFAULT 0, rate REAL DEFAULT 0, cost_rate REAL DEFAULT 0, done_pct REAL DEFAULT 0, billed_pct REAL DEFAULT 0);
CREATE TABLE IF NOT EXISTS variations(id INTEGER PRIMARY KEY, project_id INTEGER, number TEXT, date TEXT, description TEXT, amount REAL DEFAULT 0, status TEXT DEFAULT 'pending');
CREATE TABLE IF NOT EXISTS site_reports(id INTEGER PRIMARY KEY, project_id INTEGER, date TEXT, weather TEXT, labour_count INTEGER DEFAULT 0, work_done TEXT, issues TEXT, notes TEXT);
CREATE TABLE IF NOT EXISTS audit_log(id INTEGER PRIMARY KEY, ts TEXT, user TEXT, action TEXT, tbl TEXT, rec INTEGER, detail TEXT);
`);
const addCol = (t, c, d) => { if (!db.prepare(`PRAGMA table_info(${t})`).all().some(x => x.name === c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`); };
[['users','display_name','TEXT'],['users','job_title','TEXT'],['users','mobile','TEXT'],['users','employee_id','INTEGER'],['payments','reconciled','INTEGER DEFAULT 0'],['users','role',"TEXT DEFAULT 'admin'"],['projects','retention_pct','REAL DEFAULT 0'],['parties','bank_name','TEXT'],['parties','iban','TEXT'],['projects','emirate',"TEXT DEFAULT 'dubai'"],['invoices','kind',"TEXT DEFAULT 'invoice'"],['invoices','original_id','INTEGER'],['invoices','voided','INTEGER DEFAULT 0'],['invoices','void_reason','TEXT'],['payments','cheque_date','TEXT'],['payments','cheque_status',"TEXT DEFAULT 'cleared'"]].forEach(a => addCol(...a));

// Editable columns per table (whitelist) and numeric columns
const bad = m => { const e = new Error(m); e.status = 400; throw e; };
const TABLES = {
  parties:  { cols: ['type','name','trn','phone','email','address','notes','bank_name','iban'],
    check: r => { if (r.trn && !C.validTrn(r.trn)) bad('TRN must be 15 digits'); if (r.iban && !C.validIban(r.iban)) bad('Invalid UAE IBAN'); } },
  projects: { cols: ['code','name','client_id','location','emirate','contract_value','retention_pct','start_date','end_date','status','notes'], num: ['contract_value','retention_pct'] },
  boq_items: { cols: ['project_id','section','description','unit','qty','rate','cost_rate','done_pct'], num: ['qty','rate','cost_rate','done_pct'], check: r => { if (r.done_pct !== undefined && (r.done_pct < 0 || r.done_pct > 100)) bad('Completion % must be between 0 and 100'); } },
  variations: { cols: ['project_id','number','date','description','amount','status'], num: ['amount'] },
  site_reports: { cols: ['project_id','date','weather','labour_count','work_done','issues','notes'], num: ['labour_count'] },
  quotes:   { cols: ['number','date','client_id','project_name','validity_days','status','items','vat_pct','notes','terms'], num: ['validity_days','vat_pct'], json: ['items'], prefix: 'QT' },
  invoices: { cols: ['number','date','due_date','project_id','items','vat_pct','retention_pct','notes'], num: ['vat_pct','retention_pct'], json: ['items'], prefix: 'INV' },
  bills:    { cols: ['date','party_id','project_id','category','description','amount','vat_amount','reference'], num: ['amount','vat_amount'] },
  payments: { cols: ['kind','date','amount','method','reference','invoice_id','bill_id','is_retention','notes','cheque_date','cheque_status','bank_account_id'], num: ['amount'] },
  employees: { cols: ['name','person_code','emirates_id','passport_no','nationality','designation','join_date','end_date','status','basic','housing','other_allowance','bank_name','routing_code','iban','project_id','eid_expiry','visa_expiry','passport_expiry','card_expiry','notes'], num: ['basic','housing','other_allowance'],
    check: r => { if (r.person_code && !C.validPersonCode(r.person_code)) bad('Person code / labour card no. must be 14 digits'); if (r.emirates_id && !C.validEid(r.emirates_id)) bad('Emirates ID must be 15 digits starting with 784');
      if (r.routing_code && !C.validRouting(r.routing_code)) bad('Bank routing code must be 9 digits'); if (r.iban && !C.validIban(r.iban)) bad('Invalid UAE IBAN'); } },
};

const round = n => Math.round((n + Number.EPSILON) * 100) / 100;
const getSettings = () => Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(r => [r.key, r.value]));
const today = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };   // local date (UTC would still be yesterday before 4am in the UAE)
const all = (t) => db.prepare(`SELECT * FROM ${t} ORDER BY id DESC`).all();

const docTotals = C.docTotals;
const parseItems = r => { try { return JSON.parse(r.items || '[]'); } catch { return []; } };

// Brand-guideline reference: TC26/01-CLIENT  (company prefix + 2-digit year / sequence in year - short client or entity code)
function brandRef(table, col, entity) {
  const pre = (db.prepare("SELECT value FROM settings WHERE key='doc_prefix'").get()?.value || 'TC').toUpperCase(), yy = String(new Date().getFullYear()).slice(2), head = `${pre}${yy}/`;
  const max = db.prepare(`SELECT ${col} v FROM ${table} WHERE ${col} LIKE ?`).all(head + '%').reduce((m, r) => Math.max(m, parseInt(String(r.v).slice(head.length), 10) || 0), 0);
  const code = String(entity || '').split(/[\s,.-]+/).filter(w => !/^(the|al|llc|l\.l\.c|co|ltd|est|trading|general)$/i.test(w))[0] || '';
  return `${head}${String(max + 1).padStart(2, '0')}${code ? '-' + code.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 8) : ''}`;
}
function nextNumber(table, prefix, col = 'number') {
  const year = new Date().getFullYear();
  const like = `${prefix}-${year}-%`;
  const head = `${prefix}-${year}-`.length;                                 // highest sequence of the year, whatever the row order (a renumbered document must not make the next number repeat)
  const n = db.prepare(`SELECT ${col} v FROM ${table} WHERE ${col} LIKE ?`).all(like).reduce((m, r) => Math.max(m, parseInt(String(r.v).slice(head), 10) || 0), 0) + 1;
  return `${prefix}-${year}-${String(n).padStart(3, '0')}`;
}

// ---- enriched views -------------------------------------------------------
const countable = p => p.cheque_status !== 'bounced';           // bounced cheques never settle anything
function enrich() {
  const parties = Object.fromEntries(all('parties').map(p => [p.id, p]));
  const projects = Object.fromEntries(all('projects').map(p => [p.id, p]));
  const pays = all('payments').filter(countable);
  const raw = all('invoices'), ipcs = ctx.ipcIds ? ctx.ipcIds() : new Set();
  const invoices = raw.map(r => {
    const items = parseItems(r), tt = docTotals(items, r.vat_pct, r.retention_pct, { retention: r.retention_amount, vatBasis: r.vat_basis });
    const sign = r.kind === 'credit_note' ? -1 : 1, dead = !!r.voided;
    const k = dead ? 0 : sign;                                       // voided documents keep their number but carry no value
    for (const f of Object.keys(tt)) tt[f] = round(tt[f] * k);
    const mine = pays.filter(p => p.kind === 'in' && p.invoice_id === r.id);
    const paid = round(mine.filter(p => !p.is_retention).reduce((s, p) => s + p.amount, 0));
    const released = round(mine.filter(p => p.is_retention).reduce((s, p) => s + p.amount, 0));
    let credited = 0, credited_total = 0, retention_credited = 0;         // credit notes against this invoice: net of retention / gross / the retention they cancel
    if (r.kind !== 'credit_note') for (const c of raw) if (c.kind === 'credit_note' && !c.voided && c.original_id === r.id) { const t = docTotals(parseItems(c), c.vat_pct, c.retention_pct, { retention: c.retention_amount, vatBasis: c.vat_basis }); credited += t.total - t.retention; credited_total += t.total; retention_credited += t.retention; }
    credited = round(credited); credited_total = round(credited_total); retention_credited = round(retention_credited);
    const dueNow = round(tt.total - tt.retention);
    const balance = r.kind === 'credit_note' ? 0 : round(dueNow - paid - credited);
    const retention_open = r.kind === 'credit_note' ? 0 : round(tt.retention - retention_credited - released);
    const orig_kind = r.kind === 'credit_note' ? (raw.find(o => o.id === r.original_id)?.kind || '') : '';
    const proj = projects[r.project_id], client = parties[proj?.client_id];
    const status = dead ? 'void' : r.kind === 'credit_note' ? 'credit' : balance <= 0.005 ? (retention_open > 0.005 ? 'retention' : 'paid') : (r.due_date && r.due_date < today() ? 'overdue' : (paid > 0 ? 'partial' : 'unpaid'));
    const warnings = [];
    if (client && !client.trn) warnings.push('customer_trn_missing');
    if (client && !client.address) warnings.push('customer_address_missing');
    const revenue = r.kind === 'advance' || orig_kind === 'advance' ? 0 : round(tt.subtotal + tt.recovery - tt.release);   // an advance is a liability until recovered; recovery lines don't reduce the work value; a retention release is not new revenue
    return { ...r, items, ...tt, revenue, orig_kind, ipc: ipcs.has(r.id), due_now: dueNow, paid, released, credited, credited_total, retention_credited, balance, retention_open, status, warnings,
      project_name: proj?.name, emirate: proj?.emirate, contract_ref: proj?.client_contract_ref || '', main_contract: proj?.main_contract || '', client_id: proj?.client_id, client_name: client?.name, client_trn: client?.trn, client_address: client?.address, client_email: client?.email };
  });
  // retention released by invoice (main-contractor PCs): settles the oldest open retention of the same project first
  const relBy = {};
  for (const i of invoices) if (!i.voided && i.release > 0) relBy[i.project_id] = round((relBy[i.project_id] || 0) + i.release);
  for (const [pid, amt] of Object.entries(relBy)) {
    let left = amt;
    for (const i of invoices.filter(x => x.project_id === +pid && !x.voided && x.retention_open > 0.004).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id))) {
      const take = round(Math.min(left, i.retention_open)); if (!(take > 0)) break;
      i.retention_open = round(i.retention_open - take); left = round(left - take);
      if (i.balance <= 0.005 && i.retention_open <= 0.005 && i.status === 'retention') i.status = 'paid';
    }
  }
  const bills = all('bills').map(r => {
    const total = round(r.amount + r.vat_amount);
    const paid = round(pays.filter(p => p.kind === 'out' && p.bill_id === r.id).reduce((s, p) => s + p.amount, 0));
    const balance = round(total - paid), party = parties[r.party_id];
    let allocation = []; try { allocation = JSON.parse(r.allocation || '[]').map(a => ({ project_id: +a.project_id, pct: +a.pct })); } catch { /* not split */ }
    return { ...r, allocation, total, paid, balance, status: balance <= 0.005 ? 'paid' : (paid > 0 ? 'partial' : 'unpaid'),
      party_name: party?.name, party_trn: party?.trn, project_name: projects[r.project_id]?.name };
  });
  const quotes = all('quotes').map(r => {
    const items = parseItems(r);
    return { ...r, items, ...docTotals(items, r.vat_pct), client_name: parties[r.client_id]?.name, client_email: parties[r.client_id]?.email };
  });
  const payments = all('payments').map(p => {
    const inv = invoices.find(i => i.id === p.invoice_id), bill = bills.find(b => b.id === p.bill_id);
    return { ...p, ref_label: inv ? inv.number : bill ? (bill.description || ('#' + bill.id)) : '',
      party_name: inv ? inv.client_name : bill ? bill.party_name : '',
      project_name: inv ? inv.project_name : bill ? bill.project_name : '' };
  });
  return { parties, projects, invoices, bills, quotes, payments };
}
// cash that has really moved: pending/bounced cheques excluded
const inCash = p => p.method !== 'offset' && (p.method !== 'cheque' || p.cheque_status === 'cleared' || !p.cheque_status);
const payrollCost = (from, to) => db.prepare("SELECT * FROM payroll WHERE status='final' AND month>=? AND month<=?").all((from || '0000-00').slice(0, 7), (to || '9999-99').slice(0, 7));

function projectRows() {
  const { projects, invoices, bills } = enrich();
  return Object.values(projects).sort((a, b) => b.id - a.id).map(p => {
    const inv = invoices.filter(i => i.project_id === p.id && !i.voided), direct = bills.filter(b => b.project_id === p.id && !b.allocation.length);
    // a shared expense split across projects counts its share here (office rent, a roller used on three sites…)
    const bl = [...direct, ...bills.filter(b => b.allocation.some(a => a.project_id === p.id)).map(b => { const pct = b.allocation.find(a => a.project_id === p.id).pct; return { ...b, amount: round(b.amount * pct / 100), balance: round(b.balance * pct / 100) }; })];
    const invoiced = round(inv.reduce((s, i) => s + i.revenue, 0));
    const collected = round(inv.reduce((s, i) => s + i.paid, 0) + inv.reduce((s, i) => s + (i.retention - i.retention_open), 0));
    const pr = ctx.projectPayrollCost ? ctx.projectPayrollCost(p.id) : db.prepare("SELECT COALESCE(SUM(gross),0) g FROM payroll WHERE status='final' AND project_id=?").get(p.id).g;
    const costBills = bl.filter(b => b.category !== 'asset');
    const cost = round(costBills.reduce((s, b) => s + b.amount, 0) + pr + (ctx.projectEosCost ? ctx.projectEosCost(p.id) : 0));
    const byCat = {};
    costBills.forEach(b => byCat[b.category] = round((byCat[b.category] || 0) + b.amount));
    if (pr) byCat.payroll = round(pr);
    const eos = ctx.projectEosCost ? ctx.projectEosCost(p.id) : 0;      // end-of-service provision of the staff on this project
    if (eos) byCat.eos = eos;
    const vars = round(db.prepare("SELECT COALESCE(SUM(amount),0) a FROM variations WHERE project_id=? AND status='approved'").get(p.id).a);
    const boq = db.prepare('SELECT * FROM boq_items WHERE project_id=?').all(p.id);
    const boqValue = round(boq.reduce((x, i) => x + i.qty * i.rate, 0)), boqCost = round(boq.reduce((x, i) => x + i.qty * i.cost_rate, 0));
    const earned = round(boq.reduce((x, i) => x + i.qty * i.rate * i.done_pct / 100, 0));
    const revised = round(p.contract_value + vars);
    return { ...p, variations: vars, revised_value: revised, boq_value: boqValue, boq_budget_cost: boqCost, boq_earned: earned, boq_progress: boqValue ? round(earned / boqValue * 100) : 0, invoiced, collected, receivable: round(inv.reduce((s, i) => s + i.balance + i.retention_open, 0)),
      retention_held: round(inv.reduce((s, i) => s + i.retention_open, 0)),
      cost, payable: round(bl.reduce((s, b) => s + b.balance, 0)), profit: round(invoiced - cost),
      margin: invoiced ? round((invoiced - cost) / invoiced * 100) : 0,
      billed_pct: revised ? round(invoiced / revised * 100) : 0, cost_by_category: byCat };
  });
}

function dashboard() {
  const { invoices, bills, payments } = enrich();
  const projs = projectRows();
  const inc = payments.filter(p => p.kind === 'in' && countable(p) && inCash(p)), out = payments.filter(p => p.kind === 'out' && countable(p) && inCash(p));
  const months = [];
  const d = new Date(); d.setDate(1);
  for (let i = 5; i >= 0; i--) {
    const x = new Date(d.getFullYear(), d.getMonth() - i, 1), m = `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`;   // local month (toISOString would give the month before, east of UTC)
    months.push({ month: m,
      in: round(inc.filter(p => (p.date || '').startsWith(m)).reduce((s, p) => s + p.amount, 0)),
      out: round(out.filter(p => (p.date || '').startsWith(m)).reduce((s, p) => s + p.amount, 0)) });
  }
  return {
    active_projects: projs.filter(p => p.status === 'active').length,
    contract_value: round(projs.filter(p => p.status !== 'cancelled').reduce((s, p) => s + p.revised_value, 0)),
    invoiced: round(invoices.reduce((s, i) => s + i.revenue, 0)),
    expenses: round(bills.filter(b => b.category !== 'asset').reduce((s, b) => s + b.amount, 0) + db.prepare("SELECT COALESCE(SUM(gross),0) g FROM payroll WHERE status='final'").get().g),
    receivable: round(invoices.reduce((s, i) => s + i.balance, 0)),
    retention_held: round(invoices.reduce((s, i) => s + i.retention_open, 0)),
    payable: round(bills.reduce((s, b) => s + b.balance, 0)),
    cash: round(inc.reduce((s, p) => s + p.amount, 0) - out.reduce((s, p) => s + p.amount, 0)),
    overdue: invoices.filter(i => i.status === 'overdue'),
    pdc: payments.filter(p => p.method === 'cheque' && p.cheque_status === 'pending').length,
    months, projects: projs.slice(0, 8), alerts: compliance(),
  };
}

function vatReport(from, to) {
  const { invoices, bills } = enrich();
  const inR = (dt) => (!from || dt >= from) && (!to || dt <= to);
  const sales = invoices.filter(i => !i.voided && inR(i.date)), purch = bills.filter(b => inR(b.date) && b.vat_amount > 0);
  const byEmirate = Object.fromEntries(Object.keys(C.EMIRATES).map(k => [k, { amount: 0, vat: 0 }]));
  for (const i of sales) { const e = byEmirate[i.emirate] || byEmirate.dubai; e.amount = round(e.amount + i.std_total); e.vat = round(e.vat + i.vat); }
  const out = round(sales.reduce((s, i) => s + i.vat, 0)), inn = round(purch.reduce((s, b) => s + b.vat_amount, 0));
  const warnings = [];
  for (const b of purch) if (!b.party_trn) warnings.push({ type: 'input_vat_no_supplier_trn', id: b.id, label: `${b.date} ${b.party_name || ''} ${b.description || ''}`.trim() });
  return { from, to, standard_sales: round(sales.reduce((s, i) => s + i.std_total, 0)), zero_rated_sales: round(sales.reduce((s, i) => s + i.zero_total, 0)),
    exempt_sales: round(sales.reduce((s, i) => s + i.exempt_total, 0)), sales_total: round(sales.reduce((s, i) => s + i.subtotal, 0)), by_emirate: byEmirate,
    output_vat: out, purchases_total: round(purch.reduce((s, b) => s + b.amount, 0)), input_vat: inn, net_vat: round(out - inn), warnings, sales, purchases: purch };
}

function corporateTaxReport(from, to) {
  const { invoices, bills } = enrich();
  const inR = dt => (!from || dt >= from) && (!to || dt <= to);
  const revenue = round(invoices.filter(i => !i.voided && inR(i.date)).reduce((s, i) => s + i.revenue, 0));
  const billCost = round(bills.filter(b => inR(b.date) && b.category !== 'asset').reduce((s, b) => s + b.amount, 0));
  const depreciation = ctx.depreciation(from, to || today());
  const payroll = round(payrollCost(from, to).reduce((s, r) => s + r.gross, 0));
  const r = C.corporateTax({ revenue, expenses: billCost + payroll + depreciation, periodEnd: to });
  return { from, to, ...r, bills_cost: billCost, payroll_cost: payroll, depreciation };
}

function compliance() {
  const st = getSettings(), alerts = [], t = today(), soon = new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10);
  const add = (level, key, extra = {}) => alerts.push({ level, key, ...extra });
  if (st.vat_registered !== '0' && !C.validTrn(st.trn)) add('bad', 'company_trn');
  if (!C.validEstablishment(st.mohre_id)) add('warn', 'mohre_id');
  if (!C.validRouting(st.employer_routing)) add('warn', 'employer_routing');
  if (st.license_expiry) { if (st.license_expiry < t) add('bad', 'license_expired', { date: st.license_expiry }); else if (st.license_expiry < soon) add('warn', 'license_soon', { date: st.license_expiry }); }
  for (const e of db.prepare("SELECT * FROM employees WHERE status='active'").all())
    for (const [f, key] of [['eid_expiry', 'eid'], ['visa_expiry', 'visa'], ['passport_expiry', 'passport'], ['card_expiry', 'card']])
      if (e[f] && e[f] < soon) add(e[f] < t ? 'bad' : 'warn', 'doc_' + key, { who: e.name, date: e[f] });
  // salaries: final run unpaid more than 15 days after month end -> WPS delay
  for (const m of db.prepare("SELECT DISTINCT month FROM payroll WHERE status='final' AND paid_date IS NULL").all()) {
    const y = +m.month.slice(0, 4), mo = +m.month.slice(5, 7), due = mo === 12 ? `${y + 1}-01-15` : `${y}-${String(mo + 1).padStart(2, '0')}-15`;
    if (due < t) add('bad', 'wps_late', { month: m.month });
  }
  for (const d of db.prepare('SELECT name,entity,expiry_date FROM documents WHERE expiry_date IS NOT NULL AND expiry_date<? ORDER BY expiry_date').all(soon)) add(d.expiry_date < t ? 'bad' : 'warn', 'doc_file', { who: d.name, date: d.expiry_date });
  const bounced = db.prepare("SELECT COUNT(*) n FROM payments WHERE cheque_status='bounced'").get().n;
  if (bounced) add('bad', 'bounced', { count: bounced });
  if (ctx.chequeAlerts) ctx.chequeAlerts(add);                              // post-dated cheques due this week / past their date
  if (ctx.backupStatus && fs.existsSync(path.join(DATA_DIR, 'backups'))) { const bk = ctx.backupStatus(); if (bk.stale) add('bad', 'backup_stale', { days: bk.age_days }); if (bk.last_copy && !bk.last_copy.ok) add('bad', 'backup_copy', { who: bk.last_copy.dir }); }
  const { invoices } = enrich();
  const noTrn = new Set(invoices.filter(i => !i.voided && i.warnings.includes('customer_trn_missing')).map(i => i.client_name));
  if (noTrn.size) add('warn', 'customer_trn', { who: [...noTrn].join(', ') });
  if (ctx.hooks.alerts) ctx.hooks.alerts(add, t);                         // modules add their own (e.g. retention due for release)
  return alerts;
}

// ---- auth -----------------------------------------------------------------
const isHttps = req => req.headers['x-forwarded-proto'] === 'https' || process.env.SECURE_COOKIES === '1';
const cookie = (req, token, maxAge) => `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
const fails = new Map();                                    // ip -> [timestamps of failed logins]
// behind the reverse proxy the client address is the LAST X-Forwarded-For hop (the one the proxy added); earlier hops are whatever the client sent
const clientIp = req => (process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',').pop().trim();
const locked = (key, max = 8) => { const t = (fails.get(key) || []).filter(x => Date.now() - x < 15 * 60e3); if (fails.size > 5000) fails.clear(); fails.set(key, t); return t.length >= max; };
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
function createSession(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(token, userId, Date.now());
  return token;
}
function sessionUser(req) {
  const m = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  const s = db.prepare('SELECT user_id FROM sessions WHERE token=? AND created>?').get(m[1], Date.now() - 30 * 864e5);
  return s ? db.prepare('SELECT id,username,role,employee_id FROM users WHERE id=? AND COALESCE(disabled,0)=0').get(s.user_id) : null;
}

// ---- http -----------------------------------------------------------------
const MIME = { '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
const gzipOk = res => zlib.gzipSync && /\bgzip\b/.test((res.req && res.req.headers['accept-encoding']) || '');
const send = (res, code, body, headers = {}) => {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  if (isObj && res._scope && code === 200) body = scopeFilter(res._scope, body);
  let out = isObj ? JSON.stringify(body) : body;
  const h = { 'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', ...headers };
  if (isObj && out.length > 2048 && gzipOk(res)) { out = zlib.gzipSync(out); h['Content-Encoding'] = 'gzip'; h.Vary = 'Accept-Encoding'; }   // big lists load faster on mobile data
  res.writeHead(code, h);
  res.end(out);
};
const readBody = (req, max = 5e6) => req._body !== undefined ? Promise.resolve(req._body) : new Promise((ok, no) => {
  let b = '', over = false; req.on('data', c => { if (over) return; b += c; if (b.length > max) { over = true; b = ''; no(Object.assign(new Error('the request is too large'), { status: 413 })); req.resume(); } });
  req.on('end', () => { if (over) return; try { ok(b ? JSON.parse(b) : {}); } catch (e) { no(Object.assign(new Error('invalid request body'), { status: 400 })); } });
});

// ---- site roles (site engineer, foreman) work only on the projects assigned to them in Users ----
db.exec('CREATE TABLE IF NOT EXISTS user_projects(user_id INTEGER, project_id INTEGER, PRIMARY KEY(user_id, project_id))');
const SITE_ROLES = ['site_engineer', 'foreman'];
function siteScope(me) {
  if (!SITE_ROLES.includes(me.role)) return null;
  const projects = new Set(db.prepare('SELECT project_id FROM user_projects WHERE user_id=?').all(me.id).map(r => r.project_id));
  const emps = new Set(projects.size ? db.prepare(`SELECT id FROM employees WHERE project_id IN (${[...projects].map(() => '?').join(',')})`).all(...projects).map(r => r.id) : []);
  return { projects, emps, list: null };
}
// list responses: drop rows of other projects (and of crews on other projects)
function scopeFilter(sc, body) {
  const keep = x => {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return true;
    if (sc.list === 'projects') return sc.projects.has(x.id);
    if ('employee_id' in x && x.employee_id != null) return sc.emps.has(x.employee_id);
    if ('project_id' in x && x.project_id != null) return sc.projects.has(x.project_id);
    if (x.entity === 'project' && x.entity_id) return sc.projects.has(x.entity_id);
    return true;
  };
  if (Array.isArray(body)) return body.filter(keep);
  if (body && typeof body === 'object' && sc.list !== 'projects') { const o = { ...body }; for (const k of Object.keys(o)) if (Array.isArray(o[k])) o[k] = o[k].filter(x => keep(x) && (k !== 'roster' || sc.emps.has(x.id))); return o; }
  return body;
}
async function scopeCheck(sc, req, method, url, a, b) {
  const p = x => x == null || x === '' || sc.projects.has(+x), e = x => x == null || x === '' || sc.emps.has(+x);
  if (a === 'projects' && b && !sc.projects.has(+b)) return false;
  if (!p(url.searchParams.get('project_id'))) return false;
  if (url.searchParams.get('entity') === 'project' && !p(url.searchParams.get('entity_id'))) return false;
  if (b && /^\d+$/.test(b) && TABLES[a]?.cols.includes('project_id')) { const row = db.prepare(`SELECT project_id FROM ${a} WHERE id=?`).get(+b); if (row && !p(row.project_id)) return false; }
  if (a === 'documents' && b && /^\d+$/.test(b)) { const d = db.prepare('SELECT entity, entity_id FROM documents WHERE id=?').get(+b); if (d && d.entity === 'project' && !p(d.entity_id)) return false; }
  if (['POST', 'PUT', 'DELETE'].includes(method)) {
    const x = req._body = await readBody(req, a === 'documents' ? 12e6 : 5e6);
    if (!p(x.project_id) || !e(x.employee_id) || (x.entity === 'project' && !p(x.entity_id))) return false;
    if (Array.isArray(x.employee_ids) && !x.employee_ids.every(e)) return false;
  }
  if (a === 'projects' && !b) sc.list = 'projects';
  return true;
}

function clean(table, body) {
  const spec = TABLES[table], out = {};
  for (const c of spec.cols) {
    if (!(c in body)) continue;
    let v = body[c];
    if (spec.json?.includes(c)) v = JSON.stringify(Array.isArray(v) ? v : []);
    else if (spec.num?.includes(c)) v = +v || 0;
    else if (v === '') v = null;
    if (v != null && (c === 'date' || c.endsWith('_date') || c.endsWith('_expiry')) && !/^\d{4}-\d\d-\d\d$/.test(String(v))) bad(`${c.replace(/_/g, ' ')} must be a date (YYYY-MM-DD)`);
    out[c] = v;
  }
  return out;
}

const { ROLES } = ACLX, can = ACLX.can;
const { money } = require('./lib/render');
const SETTING_KEYS = ['sc_template','sc_signatory','legal_name','sub_cert_signatories','po_notes','po_conditions','mail_method','graph_tenant','graph_client','address_ar','license_authority','doc_prefix','company_name_ar','website','po_box','footer_text','legal_form','smtp_host','smtp_port','smtp_user','smtp_from','smtp_secure','company_name','trn','address','phone','email','vat_pct','terms','bank_details','currency','vat_registered','ct_trn','license_no','license_expiry','mohre_id','employer_routing','employer_bank','employer_iban','hr_work_hours','hr_break_min','hr_rest_day','hr_geofence','hr_ramadan_from','hr_ramadan_to','hr_midday_from','hr_midday_to','hr_midday_start','hr_midday_end','hr_sif_days','kpi_manday_target','backup_copy_dir'];
function audit(req, action, tbl, rec, detail = '') {
  db.prepare('INSERT INTO audit_log(ts,user,action,tbl,rec,detail) VALUES(?,?,?,?,?,?)').run(new Date().toISOString(), sessionUser(req)?.username || '', action, tbl, rec, String(detail).slice(0, 500));
}
const monthOk = m => /^\d{4}-(0[1-9]|1[0-2])$/.test(m || '');
function payrollRows(month) {
  return db.prepare(`SELECT p.*, e.name, e.person_code, e.routing_code, e.iban, e.designation FROM payroll p JOIN employees e ON e.id=p.employee_id WHERE p.month=? ORDER BY e.name`).all(month)
    .map(r => ({ ...r, deduction_ratio: r.gross ? r.deductions / r.gross : 0 }));
}
// days of the month the employee is on the payroll: a full month is 30 days whatever its length (February included)
function payrollBaseDays(e, m) {
  const first = `${m}-01`, last = `${m}-${String(C.daysInMonth(m)).padStart(2, '0')}`;
  const from = e.join_date && e.join_date > first ? e.join_date : first, to = e.end_date && e.end_date < last ? e.end_date : last;
  return from === first && to === last ? 30 : Math.max(0, Math.min(30, Math.round((new Date(to) - new Date(from)) / 864e5) + 1));
}
function applyPayroll(id, inp) {
  const row = db.prepare('SELECT * FROM payroll WHERE id=?').get(id), emp = db.prepare('SELECT * FROM employees WHERE id=?').get(row.employee_id);
  const m = { ...row }; for (const k of ['days_worked','leave_days','ot_normal_hours','ot_special_hours','bonus','deductions','notes']) if (k in inp) m[k] = k === 'notes' ? inp[k] : +inp[k] || 0;
  const c = C.computePayroll(emp, m);
  db.prepare('UPDATE payroll SET days_worked=?,leave_days=?,ot_normal_hours=?,ot_special_hours=?,bonus=?,deductions=?,fixed=?,overtime=?,gross=?,net=?,notes=? WHERE id=?')
    .run(m.days_worked, m.leave_days, m.ot_normal_hours, m.ot_special_hours, m.bonus, m.deductions, c.fixed, c.overtime, c.gross, c.net, m.notes ?? null, id);
}

// ---- feature modules ------------------------------------------------------------
const mailCfgFor = () => {
  const st = getSettings();
  if (st.mail_method === 'graph') {
    if (!st.graph_tenant || !st.graph_client || !st.graph_secret || !st.smtp_from) bad('Email is not configured — set the Microsoft 365 details in Settings');
    return { method: 'graph', tenant: st.graph_tenant, client: st.graph_client, secret: st.graph_secret, from: st.smtp_from, fromName: st.company_name,
      loginBase: process.env.MS_LOGIN_BASE || 'https://login.microsoftonline.com', graphBase: process.env.MS_GRAPH_BASE || 'https://graph.microsoft.com/v1.0' };
  }
  if (!st.smtp_host || !st.smtp_from) bad('Email is not configured — set the SMTP details in Settings');
  return { host: st.smtp_host, port: st.smtp_port, secure: st.smtp_secure === '1', user: st.smtp_user, pass: st.smtp_pass, from: st.smtp_from, fromName: st.company_name };
};
const ctx = { brandRef, vatReport: (...a) => vatReport(...a), db, send, bad, audit, readBody, getSettings, enrich, today, round, C, nextNumber, parseItems, TABLES, ROLES, DATA_DIR, inCash, countable, sessionUser, projectRows, payrollRows, applyPayroll, mailCfg: mailCfgFor, sendMail, validEmail, docHtml, toText, hooks: {} };
ctx.siteScope = me => siteScope(me);
ctx.applyPayroll = (...a) => applyPayroll(...a);
// brand e-mail signature: Arial text block + the one-line logo as an inline image
ctx.signature = user => {
  const S = getSettings(), prof = db.prepare('SELECT username,display_name,job_title,mobile FROM users WHERE id=?').get(user.id) || user, logo = ctx.brandBuf && ctx.brandBuf('logo_line');
  return { html: require('./lib/docs').signatureHtml({ S, user: prof, logoCid: logo ? 'brandlogo' : null }), inline: logo ? [{ cid: 'brandlogo', mime: 'image/png', content: logo }] : [] };
};
// (static requires so the same code can be bundled for the browser — see standalone/)
const MODULES = [require('./modules/brand'), require('./modules/push'), require('./modules/documents'), require('./modules/print'), require('./modules/hr'), require('./modules/workforce'), require('./modules/payroll2'), require('./modules/contract'), require('./modules/claims'), require('./modules/ipc'), require('./modules/statements'), require('./modules/collab'), require('./modules/sales'), require('./modules/procurement'), require('./modules/scagreement'), require('./modules/assets'), require('./modules/accounting'), require('./modules/zoho'), require('./modules/controls')].map(f => f(ctx));
for (const m of MODULES) if (m.tables) Object.assign(TABLES, m.tables);

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // after /api
  const [a, b, c] = parts, method = req.method;

  if (a === 'status') return send(res, 200, { setup: db.prepare('SELECT COUNT(*) n FROM users').get().n === 0, token_required: !!process.env.SETUP_TOKEN, user: sessionUser(req) });
  if (a === 'setup' && method === 'POST') {
    if (db.prepare('SELECT COUNT(*) n FROM users').get().n) return send(res, 403, { error: 'already set up' });
    const { username, password, company, token } = await readBody(req);
    if (process.env.SETUP_TOKEN && !(typeof token === 'string' && token.length === process.env.SETUP_TOKEN.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(process.env.SETUP_TOKEN)))) return send(res, 403, { error: 'invalid setup token' });
    if (!username || !password || password.length < 6) return send(res, 400, { error: 'password must be at least 6 characters' });
    const salt = crypto.randomBytes(16).toString('hex');
    const r = db.prepare('INSERT INTO users(username,salt,hash,role) VALUES(?,?,?,?)').run(username, salt, hashPw(password, salt), 'admin');
    const ins = db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)');
    ins.run('company_name', company || 'Trigon Civil Contracting LLC'); ins.run('company_name_ar', company ? '' : 'تريجون سيفيل للمقاولات ذ م م'); ins.run('vat_pct', '5'); ins.run('currency', 'AED');
    ins.run('terms', '1. Payment: 30 days from invoice date.\n2. Prices exclude VAT unless stated.\n3. Variations to be agreed in writing.');
    return send(res, 200, { ok: 1 }, { 'Set-Cookie': cookie(req, createSession(r.lastInsertRowid), 2592000) });
  }
  if (a === 'login' && method === 'POST') {
    const { username, password } = await readBody(req), ip = clientIp(req), acct = 'user:' + String(username || '').toLowerCase();
    if (locked(ip) | locked(acct, 12)) return send(res, 429, { error: 'too many failed attempts — try again in 15 minutes' });   // per address and per account (both lists are refreshed)
    const u = db.prepare('SELECT * FROM users WHERE username=?').get(username || '');
    if (!u || !crypto.timingSafeEqual(Buffer.from(hashPw(password || '', u.salt)), Buffer.from(u.hash))) { fails.get(ip).push(Date.now()); fails.get(acct).push(Date.now()); return send(res, 401, { error: 'invalid credentials' }); }
    fails.delete(ip); fails.delete(acct);
    if (u.disabled) return send(res, 403, { error: 'this account is disabled' });                    // employee who has left
    return send(res, 200, { ok: 1 }, { 'Set-Cookie': cookie(req, createSession(u.id), 2592000) });
  }
  if (a === 'logout') {
    const m = /sid=([a-f0-9]+)/.exec(req.headers.cookie || '');
    if (m) db.prepare('DELETE FROM sessions WHERE token=?').run(m[1]);
    return send(res, 200, { ok: 1 }, { 'Set-Cookie': cookie(req, '', 0) });
  }

  if (a === 'brand' && method === 'GET' && ['logo', 'logo_white', 'mark'].includes(b)) return void await MODULES[0].handle(req, res, url, parts, null);   // logos are public (login screen)
  const me = sessionUser(req);
  if (!me) return send(res, 401, { error: 'unauthorized' });
  if (!can(me.role, method, a, b, c)) return send(res, 403, { error: 'your role does not allow this action' });
  const scope = siteScope(me);
  if (scope) { if (!await scopeCheck(scope, req, method, url, a, b)) return send(res, 403, { error: 'this project is not assigned to you' }); res._scope = scope; }
  if (ctx.periodGuard) await ctx.periodGuard(req, method, url, parts);          // closed accounting period

  const mailCfg = mailCfgFor;
  if (a === 'settings' && b === 'test-email' && method === 'POST') {
    const { to } = await readBody(req);
    if (!validEmail(to)) bad('Enter a valid email address');
    const sig = ctx.signature(me), tHtml = '<p>Email settings are working. / إعدادات البريد تعمل بنجاح.</p>' + sig.html;
    await sendMail(mailCfg(), { to, subject: 'Test email / رسالة تجريبية', html: tHtml, text: toText(tHtml), inline: sig.inline });
    audit(req, 'email', 'settings', 0, `test to ${to}`);
    return send(res, 200, { ok: 1 });
  }
  if (['invoices', 'quotes'].includes(a) && c === 'email' && method === 'POST') {
    const { to, message, reminder } = await readBody(req), e = enrich();
    const doc = (a === 'invoices' ? e.invoices : e.quotes).find(x => x.id === +b);
    if (!doc) return send(res, 404, { error: 'not found' });
    if (doc.voided) bad('Cannot email a voided document');
    if (!validEmail(to)) bad('Enter a valid email address');
    const st = getSettings(), html = docHtml({ kind: a, doc: { ...doc, client_trn: e.parties[doc.client_id]?.trn }, settings: st, message, reminder: !!reminder && a === 'invoices' });
    const label = a === 'quotes' ? 'Quotation' : doc.kind === 'credit_note' ? 'Credit note' : reminder ? 'Payment reminder — Invoice' : 'Tax invoice';
    let attachments = [];
    try { attachments = [{ filename: `${doc.number}.pdf`, mime: 'application/pdf', content: await ctx.pdf(ctx.renderPage(a, doc.id, me).html) }]; } catch { /* no browser available: send the HTML body only */ }
    const sig = ctx.signature(me), full = html + sig.html;
    await sendMail(mailCfg(), { to, subject: `${label} ${doc.number} — ${st.company_name || ''}`, html: full, text: toText(full), attachments, inline: sig.inline });
    audit(req, 'email', a, doc.id, `${doc.number} to ${to}${reminder ? ' (reminder)' : ''}`);
    return send(res, 200, { ok: 1 });
  }

  // ---- users: admin manages all; HR may only manage employee-portal accounts ----
  if (a === 'users') {
    const admins = () => db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin'").get().n;
    const hrOnly = me.role === 'hr';
    if (method === 'GET') return send(res, 200, db.prepare(`SELECT u.id,u.username,u.role,u.employee_id,e.name employee_name FROM users u LEFT JOIN employees e ON e.id=u.employee_id ${hrOnly ? "WHERE u.role='employee'" : ''} ORDER BY u.id`).all()
      .map(u => ({ ...u, projects: db.prepare('SELECT project_id FROM user_projects WHERE user_id=?').all(u.id).map(r => r.project_id) })));
    const body = ['POST', 'PUT'].includes(method) ? await readBody(req) : {};
    if (method === 'POST') {
      if (!body.username || !/^[\w.@-]{3,40}$/.test(body.username)) bad('Username must be 3–40 characters (letters, digits, . _ - @)');
      if (!body.password || body.password.length < 6) bad('Password must be at least 6 characters');
      if (!ROLES.includes(body.role)) bad('Invalid role');
      if (hrOnly && body.role !== 'employee') bad('HR can only create employee accounts');
      if (body.role === 'employee') { if (!db.prepare('SELECT 1 FROM employees WHERE id=?').get(+body.employee_id)) bad('Select the employee this account belongs to'); if (db.prepare('SELECT 1 FROM users WHERE employee_id=?').get(+body.employee_id)) bad('This employee already has an account'); }
      if (db.prepare('SELECT 1 FROM users WHERE username=?').get(body.username)) bad('Username already exists');
      const salt = crypto.randomBytes(16).toString('hex');
      const r = db.prepare('INSERT INTO users(username,salt,hash,role,employee_id) VALUES(?,?,?,?,?)').run(body.username, salt, hashPw(body.password, salt), body.role, body.role === 'employee' ? +body.employee_id : null);
      audit(req, 'create', 'users', Number(r.lastInsertRowid), `${body.username} (${body.role})`);
      return send(res, 200, { id: Number(r.lastInsertRowid) });
    }
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(+b);
    if (!u) return send(res, 404, { error: 'not found' });
    if (hrOnly && u.role !== 'employee') return send(res, 403, { error: 'your role does not allow this action' });
    if (method === 'PUT') {
      if (body.role) {
        if (!ROLES.includes(body.role) || (hrOnly && body.role !== 'employee')) bad('Invalid role');
        if (u.role === 'admin' && body.role !== 'admin' && admins() <= 1) bad('There must be at least one admin');
        db.prepare('UPDATE users SET role=? WHERE id=?').run(body.role, u.id);
      }
      if (body.password) {
        if (body.password.length < 6) bad('Password must be at least 6 characters');
        const salt = crypto.randomBytes(16).toString('hex');
        db.prepare('UPDATE users SET salt=?, hash=? WHERE id=?').run(salt, hashPw(body.password, salt), u.id);
        db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
      }
      if (Array.isArray(body.projects) && !hrOnly) {                          // projects a site engineer / foreman works on
        db.prepare('DELETE FROM user_projects WHERE user_id=?').run(u.id);
        for (const pid of body.projects) if (db.prepare('SELECT 1 FROM projects WHERE id=?').get(+pid)) db.prepare('INSERT OR IGNORE INTO user_projects VALUES(?,?)').run(u.id, +pid);
      }
      audit(req, 'update', 'users', u.id, `${u.username}${body.role ? ' role=' + body.role : ''}${body.password ? ' password reset' : ''}${Array.isArray(body.projects) ? ' projects=' + body.projects.join(',') : ''}`);
      return send(res, 200, { ok: 1 });
    }
    if (method === 'DELETE') {
      if (u.id === me.id) bad('You cannot delete your own account');
      if (u.role === 'admin' && admins() <= 1) bad('There must be at least one admin');
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id); db.prepare('DELETE FROM users WHERE id=?').run(u.id);
      audit(req, 'delete', 'users', u.id, u.username);
      return send(res, 200, { ok: 1 });
    }
  }

  if (a === 'settings') {
    if (method === 'PUT') {
      const body = await readBody(req), ins = db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)');
      if (body.trn && !C.validTrn(body.trn)) return send(res, 400, { error: 'TRN must be 15 digits' });
      if (body.mohre_id && !C.validEstablishment(body.mohre_id)) return send(res, 400, { error: 'MOHRE establishment ID must be 13 digits' });
      if (body.employer_routing && !C.validRouting(body.employer_routing)) return send(res, 400, { error: 'Routing code must be 9 digits' });
      if (body.employer_iban && !C.validIban(body.employer_iban)) return send(res, 400, { error: 'Invalid UAE IBAN' });
      for (const k of SETTING_KEYS) if (k in body) ins.run(k, String(body[k] ?? '').trim());
      if (body.smtp_pass) ins.run('smtp_pass', String(body.smtp_pass));                // password only changes when a new one is typed
      if (body.graph_secret) ins.run('graph_secret', String(body.graph_secret).trim());     // same for the Microsoft 365 client secret
      if (body.smtp_from && !validEmail(body.smtp_from)) return send(res, 400, { error: 'SMTP "from" must be a valid email address' });
      audit(req, 'update', 'settings', 0, 'company settings');
    }
    const st = getSettings(); st.smtp_pass_set = st.smtp_pass ? '1' : ''; delete st.smtp_pass; st.graph_secret_set = st.graph_secret ? '1' : ''; delete st.graph_secret;       // never send secrets back
    if (me.role === 'employee') return send(res, 200, { company_name: st.company_name, company_name_ar: st.company_name_ar, currency: st.currency });
    return send(res, 200, st);
  }
  if (a === 'profile') {
    if (method === 'PUT') { const x = await readBody(req); db.prepare('UPDATE users SET display_name=?, job_title=?, mobile=? WHERE id=?').run(String(x.display_name || '').slice(0, 80), String(x.job_title || '').slice(0, 80), String(x.mobile || '').slice(0, 30), me.id); }
    return send(res, 200, db.prepare('SELECT username,display_name,job_title,mobile FROM users WHERE id=?').get(me.id)), true;
  }
  if (a === 'password' && method === 'POST') {
    const { password, current } = await readBody(req), u = db.prepare('SELECT * FROM users WHERE id=?').get(sessionUser(req).id);
    if (!crypto.timingSafeEqual(Buffer.from(hashPw(String(current || ''), u.salt)), Buffer.from(u.hash))) return send(res, 400, { error: 'current password is not correct' });
    if (!password || password.length < 6) return send(res, 400, { error: 'password must be at least 6 characters' });
    const salt = crypto.randomBytes(16).toString('hex');
    db.prepare('UPDATE users SET salt=?, hash=? WHERE id=?').run(salt, hashPw(password, salt), u.id);
    const sid = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie || '');                       // every other device is signed out
    db.prepare('DELETE FROM sessions WHERE user_id=? AND token!=?').run(u.id, sid ? sid[1] : '');
    return send(res, 200, { ok: 1 });
  }
  if (a === 'dashboard') { const d = dashboard(); if (!['admin', 'accountant'].includes(me.role)) d.alerts = []; return send(res, 200, d); }
  if (a === 'vat') return send(res, 200, vatReport(url.searchParams.get('from'), url.searchParams.get('to')));
  if (a === 'project-summary' && !b) return send(res, 200, projectRows());
  if (a === 'backup' && !b && method === 'GET') {
    const file = path.join(DATA_DIR, 'backup.db'); fs.rmSync(file, { force: true });
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    return send(res, 200, fs.readFileSync(file), { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="erp-backup-${today()}.db"` });
  }

  if (a === 'compliance') return send(res, 200, compliance());
  if (a === 'corporate-tax') return send(res, 200, corporateTaxReport(url.searchParams.get('from'), url.searchParams.get('to')));
  if (a === 'audit') return send(res, 200, db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 300').all());

  // ---- invoices: credit notes & voiding (tax invoices must stay sequential — no deletion) ----
  if (a === 'invoices' && c === 'credit-note' && method === 'POST') {
    const orig = enrich().invoices.find(i => i.id === +b);
    if (!orig || orig.kind === 'credit_note' || orig.voided) return send(res, 400, { error: 'cannot issue a credit note for this document' });
    const body = await readBody(req), partial = Array.isArray(body.items) && body.items.length, cnItems = partial ? body.items : orig.items;
    // the credit note cancels the retention of what it credits (same % as the invoice; the fixed amount when the whole invoice is credited)
    const ret = partial ? null : orig.retention_amount ?? null, basis = orig.vat_basis || null;
    const tot = docTotals(cnItems, orig.vat_pct, orig.retention_pct, { retention: ret, vatBasis: basis });
    if (!(tot.total > 0)) return send(res, 400, { error: 'the credit note must have a value' });
    if (round(orig.credited_total + tot.total) > orig.total + 0.01) return send(res, 400, { error: `credit notes cannot exceed the invoice: ${money(orig.total)} invoiced, ${money(orig.credited_total)} already credited` });
    const r = db.prepare("INSERT INTO invoices(number,date,project_id,items,vat_pct,retention_pct,notes,kind,original_id,retention_amount,vat_basis) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(nextNumber('invoices', 'CN'), today(), orig.project_id, JSON.stringify(cnItems), orig.vat_pct, orig.retention_pct || 0, `Credit note against ${orig.number}${body.reason ? ' — ' + body.reason : ''}`, 'credit_note', orig.id, ret, basis);
    audit(req, 'create', 'credit_note', Number(r.lastInsertRowid), `against ${orig.number}`);
    return send(res, 200, { id: Number(r.lastInsertRowid) });
  }
  if (a === 'invoices' && c === 'void' && method === 'POST') {
    const { reason } = await readBody(req);
    if (!reason) return send(res, 400, { error: 'a reason is required to void a tax invoice' });
    const inv = enrich().invoices.find(i => i.id === +b);
    if (!inv) return send(res, 404, { error: 'not found' });
    if (inv.voided) return send(res, 409, { error: 'already voided' });
    if (inv.paid > 0 || inv.released > 0) return send(res, 409, { error: 'invoice has payments — issue a credit note instead' });
    if (inv.kind !== 'credit_note' && inv.credited_total > 0) return send(res, 409, { error: 'invoice has credit notes — void them first' });
    const ipc = ctx.ipcOf ? ctx.ipcOf(+b) : null;
    if (ipc) {                                                              // progress invoice: only the latest one can be voided, and its lines become unbilled again
      if (db.prepare('SELECT 1 FROM ipcs p JOIN invoices i ON i.id=p.invoice_id WHERE p.project_id=? AND p.id>? AND COALESCE(i.voided,0)=0').get(ipc.project_id, ipc.id)) return send(res, 409, { error: 'a later progress invoice exists — void that one first, or issue a credit note' });
      for (const l of JSON.parse(ipc.lines || '[]')) if (l.cum_pct > l.prev_pct) db.prepare('UPDATE boq_items SET billed_pct=? WHERE id=? AND project_id=?').run(l.prev_pct, l.boq_id, ipc.project_id);
    }
    db.prepare('UPDATE invoices SET voided=1, void_reason=? WHERE id=?').run(reason, +b);
    db.prepare("UPDATE pay_apps SET status='certified' WHERE id IN (SELECT app_id FROM client_pcs WHERE invoice_id=?)").run(+b);   // a PC whose invoice is voided can be invoiced again
    db.prepare("UPDATE client_pcs SET status='recorded', invoice_id=NULL WHERE invoice_id=?").run(+b);
    audit(req, 'void', 'invoices', +b, `${inv.number}: ${reason}`);
    return send(res, 200, { ok: 1 });
  }

  // ---- employees / payroll / WPS ----
  if (a === 'employees' && c === 'gratuity') {
    const e = db.prepare('SELECT * FROM employees WHERE id=?').get(+b);
    if (!e) return send(res, 404, { error: 'not found' });
    const end = url.searchParams.get('end') || today();
    return send(res, 200, C.gratuity(e, end, ctx.unpaidDays ? ctx.unpaidDays(e, end) : 0));
  }
  if (a === 'payroll') {
    const month = url.searchParams.get('month') || '';
    if (b === 'generate' && method === 'POST') {
      const { month: m } = await readBody(req);
      if (!monthOk(m)) return send(res, 400, { error: 'month must be YYYY-MM' });
      const first = `${m}-01`, last = `${m}-${String(C.daysInMonth(m)).padStart(2, '0')}`;
      let n = 0;
      for (const e of db.prepare("SELECT * FROM employees WHERE (join_date IS NULL OR join_date<=?) AND (end_date IS NULL OR end_date>=?) AND (status='active' OR (end_date IS NOT NULL AND end_date>=?))").all(last, first, first)) {
        if (ctx.salaryInSettlement && ctx.salaryInSettlement(e.id, m)) continue;   // the last month was paid in the final settlement
        if (db.prepare('SELECT 1 FROM payroll WHERE month=? AND employee_id=?').get(m, e.id)) continue;
        const days = payrollBaseDays(e, m);
        const r = db.prepare('INSERT INTO payroll(month,employee_id,project_id,days_worked) VALUES(?,?,?,?)').run(m, e.id, e.project_id, days);
        const inp = ctx.hooks.payrollInputs ? ctx.hooks.payrollInputs(e, m, days) : {};
        applyPayroll(Number(r.lastInsertRowid), inp);
        if (ctx.syncLoanDeduction) ctx.syncLoanDeduction(Number(r.lastInsertRowid));   // advance instalments due up to this month
        n++;
      }
      audit(req, 'generate', 'payroll', 0, `${m}: ${n} rows`);
      return send(res, 200, { created: n });
    }
    if (b === 'refresh' && method === 'POST') {                                       // re-read attendance, leave and advances into the draft rows (bonus and manual deductions are kept)
      const { month: m } = await readBody(req);
      if (!monthOk(m)) return send(res, 400, { error: 'month must be YYYY-MM' });
      let n = 0;
      for (const row of db.prepare("SELECT * FROM payroll WHERE month=? AND status!='final'").all(m)) {
        const e = db.prepare('SELECT * FROM employees WHERE id=?').get(row.employee_id); if (!e) continue;
        const inp = ctx.hooks.payrollInputs ? ctx.hooks.payrollInputs(e, m, payrollBaseDays(e, m)) : { days_worked: payrollBaseDays(e, m) };
        applyPayroll(row.id, inp); if (ctx.syncLoanDeduction) ctx.syncLoanDeduction(row.id); n++;
      }
      audit(req, 'refresh', 'payroll', 0, `${m}: ${n} rows`);
      return send(res, 200, { updated: n });
    }
    if (b === 'finalize' && method === 'POST') {
      const { month: m } = await readBody(req);
      if (!monthOk(m)) return send(res, 400, { error: 'month must be YYYY-MM' });
      if (!db.prepare('SELECT 1 FROM payroll WHERE month=?').get(m)) return send(res, 400, { error: 'no payroll rows for this month — generate it first' });
      const issues = C.payrollIssues(getSettings(), payrollRows(m)).filter(i => !i.warn);
      if (issues.length) return send(res, 400, { error: 'WPS data incomplete', issues });
      db.prepare("UPDATE payroll SET status='final' WHERE month=?").run(m);
      if (ctx.hooks.onPayrollFinal) ctx.hooks.onPayrollFinal(m);   // end-of-service provision + project cost split
      audit(req, 'finalize', 'payroll', 0, m);
      return send(res, 200, { ok: 1 });
    }
    if (b === 'pay' && method === 'POST') {
      const { month: m, date } = await readBody(req);
      if (db.prepare("SELECT COUNT(*) n FROM payroll WHERE month=? AND status!='final'").get(m).n) return send(res, 400, { error: 'finalize the payroll first' });
      db.prepare('UPDATE payroll SET paid_date=? WHERE month=?').run(date || today(), m);
      audit(req, 'paid', 'payroll', 0, `${m} on ${date || today()}`);
      return send(res, 200, { ok: 1 });
    }
    if (b === 'check') return send(res, 200, C.payrollIssues(getSettings(), payrollRows(month)));
    if (b === 'sif') {
      const rows = payrollRows(month);
      if (!rows.length || rows.some(r => r.status !== 'final')) return send(res, 400, { error: 'finalize the payroll for this month first' });
      const issues = C.payrollIssues(getSettings(), rows).filter(i => !i.warn);
      if (issues.length) return send(res, 400, { error: 'WPS data incomplete', issues });
      const sif = C.buildSif(getSettings(), rows, month);
      audit(req, 'sif', 'payroll', 0, `${month} ${sif.file} total ${sif.total}`);
      return send(res, 200, sif.content, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="${sif.file}"` });
    }
    if (!b && method === 'GET') return send(res, 200, payrollRows(month));
    if (b && method === 'PUT') {
      const row = db.prepare('SELECT * FROM payroll WHERE id=?').get(+b);
      if (!row) return send(res, 404, { error: 'not found' });
      if (row.status === 'final') return send(res, 409, { error: 'payroll is finalized' });
      const inp = await readBody(req), LIM = { days_worked: 30, leave_days: 31, ot_normal_hours: 400, ot_special_hours: 400, bonus: 1e9, deductions: 1e9 };
      for (const k in LIM) if (k in inp && !(Number.isFinite(+inp[k]) && +inp[k] >= 0 && +inp[k] <= LIM[k])) return send(res, 400, { error: `${k.replace(/_/g, ' ')} must be between 0 and ${LIM[k]}` });
      applyPayroll(+b, inp); if ('deductions' in inp && ctx.capLoanToDeductions) ctx.capLoanToDeductions(+b);
      audit(req, 'update', 'payroll', +b, row.month);
      return send(res, 200, { ok: 1 });
    }
    const dropRow = id => { db.prepare('DELETE FROM payroll WHERE id=?').run(id); for (const t of ['loan_repayments', 'payroll_alloc']) db.prepare(`DELETE FROM ${t} WHERE payroll_id=?`).run(id); };
    if (!b && method === 'DELETE') {                                                  // a whole draft month; a finalized month stays locked
      if (!monthOk(month)) return send(res, 400, { error: 'month must be YYYY-MM' });
      const rows = db.prepare('SELECT id, status FROM payroll WHERE month=?').all(month);
      if (rows.some(r => r.status === 'final')) return send(res, 409, { error: 'payroll is finalized' });
      rows.forEach(r => dropRow(r.id)); audit(req, 'delete', 'payroll', 0, `${month}: ${rows.length} rows`);
      return send(res, 200, { deleted: rows.length });
    }
    if (b && method === 'DELETE') {
      const row = db.prepare('SELECT * FROM payroll WHERE id=?').get(+b);
      if (!row) return send(res, 404, { error: 'not found' });
      if (row.status === 'final') return send(res, 409, { error: 'payroll is finalized' });
      dropRow(+b); audit(req, 'delete', 'payroll', +b, row.month);
      return send(res, 200, { ok: 1 });
    }
  }

  if (a === 'projects' && c === 'progress-invoice' && method === 'POST') {
    const proj = db.prepare('SELECT * FROM projects WHERE id=?').get(+b);
    if (!proj) return send(res, 404, { error: 'not found' });
    const st = getSettings(); if (st.vat_registered !== '0' && !C.validTrn(st.trn)) bad('Enter your company TRN (15 digits) in Settings before issuing tax invoices');
    const lines = db.prepare('SELECT * FROM boq_items WHERE project_id=? AND done_pct>billed_pct+0.0001 ORDER BY id').all(+b);
    if (!lines.length) bad('No unbilled progress — update the completion % on the BOQ first');
    const x = await readBody(req).catch(() => ({})), date = x && x.date ? x.date : today();          // optional certificate date (end of the valuation period)
    if (!/^\d{4}-\d\d-\d\d$/.test(date)) bad('Invalid date');
    const items = lines.map(i => ({ description: `${i.description} (${i.billed_pct}% → ${i.done_pct}%)`, unit: i.unit, qty: round(i.qty * (i.done_pct - i.billed_pct) / 100), rate: i.rate, vat: 'std' }));
    const rec = ctx.advanceRecoveryLine && ctx.advanceRecoveryLine(proj, round(items.reduce((s, i) => s + i.qty * i.rate, 0)));
    if (rec) items.push(rec);                                               // contract advance recovered from each progress invoice
    const r = db.prepare('INSERT INTO invoices(number,date,project_id,items,vat_pct,retention_pct,notes) VALUES(?,?,?,?,?,?,?)')
      .run(nextNumber('invoices', 'INV'), date, proj.id, JSON.stringify(items), (st.vat_registered === '0' ? 0 : +st.vat_pct || 5), proj.retention_pct || 0, 'Progress invoice');
    if (ctx.ipcSnapshot) ctx.ipcSnapshot(proj.id, Number(r.lastInsertRowid));   // payment certificate: previous / this period / cumulative per BOQ item
    db.prepare('UPDATE boq_items SET billed_pct=done_pct WHERE project_id=? AND done_pct>billed_pct+0.0001').run(+b);   // only the lines on this invoice: a line corrected downwards keeps what was billed
    audit(req, 'create', 'progress_invoice', Number(r.lastInsertRowid), `project ${proj.name}`);
    return send(res, 200, { id: Number(r.lastInsertRowid) });
  }
  if (a === 'quotes' && c === 'convert' && method === 'POST') {
    const q = enrich().quotes.find(x => x.id === +b);
    if (!q) return send(res, 404, { error: 'not found' });
    if (q.project_id) return send(res, 400, { error: 'already converted' });
    const code = nextNumber('projects', 'PRJ', 'code');
    const r = db.prepare('INSERT INTO projects(code,name,client_id,contract_value,start_date,status) VALUES(?,?,?,?,?,?)')
      .run(code, q.project_name || q.number, q.client_id, q.subtotal, today(), 'active');
    const ins = db.prepare('INSERT INTO boq_items(project_id,section,description,unit,qty,rate) VALUES(?,?,?,?,?,?)');
    for (const i of q.items) ins.run(r.lastInsertRowid, '', i.description, i.unit || '', +i.qty || 0, +i.rate || 0);
    db.prepare("UPDATE quotes SET status='accepted', project_id=? WHERE id=?").run(r.lastInsertRowid, q.id);
    return send(res, 200, { project_id: Number(r.lastInsertRowid) });
  }

  for (const m of MODULES) if (m.handle && await m.handle(req, res, url, parts, me)) return;

  if (TABLES[a] && !c) {
    const spec = TABLES[a], id = b ? +b : null;
    const has = t => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
    // receipts and payments: a real amount against a live document, never more than what is open; reconciled ones are locked
    const checkPayment = (row, cur) => {
      const p = { ...(cur || {}), ...row };
      if (!['in', 'out'].includes(p.kind)) bad('Payment kind must be in or out');
      if (!(Number.isFinite(+p.amount) && +p.amount > 0)) bad('Amount must be greater than zero');
      if (p.date && !/^\d{4}-\d\d-\d\d$/.test(p.date)) bad('Invalid date');
      const e = enrich(), own = cur && countable(cur) ? +cur.amount : 0, bounced = p.cheque_status === 'bounced';
      if (p.kind === 'in' && p.invoice_id) {
        const inv = e.invoices.find(i => i.id === +p.invoice_id); if (!inv) bad('Invoice not found');
        if (inv.voided) bad('This invoice is voided'); if (inv.kind === 'credit_note') bad('A receipt cannot be recorded against a credit note');
        const sameTarget = cur && +cur.invoice_id === inv.id && !!cur.is_retention === !!p.is_retention ? own : 0, open = round((p.is_retention ? inv.retention_open : inv.balance) + sameTarget);
        if (!bounced && +p.amount > open + 0.01) bad(`Amount is more than the open ${p.is_retention ? 'retention' : 'balance'} of ${inv.number} (${money(open)})`);
      }
      if (p.kind === 'out' && p.bill_id) {
        const bill = e.bills.find(x => x.id === +p.bill_id); if (!bill) bad('Bill not found');
        const open = round(bill.balance + (cur && +cur.bill_id === bill.id ? own : 0));
        if (!bounced && +p.amount > open + 0.01) bad(`Amount is more than the open balance of this bill (${money(open)})`);
      }
    };
    const reconciled = pid => has('bank_lines') && db.prepare('SELECT 1 FROM bank_lines WHERE payment_id=?').get(pid);
    // site engineers record progress on the BOQ; quantities, rates and new items stay with QS / management
    if (a === 'boq_items' && me.role === 'site_engineer' && method !== 'GET' && method !== 'PUT') return send(res, 403, { error: 'your role does not allow this action' });
    if (method === 'GET') {
      const e = enrich();
      // "site roles never see money": contract terms and BOQ rates are dropped for roles outside MONEY
      const HIDE = { projects: ['contract_value', 'retention_pct', 'advance_pct', 'advance_recovery_pct', 'budget'], boq_items: ['rate', 'cost_rate'], variations: ['amount', 'cost'] }[a];
      const strip = x => { if (!x || !HIDE || ACLX.MONEY.includes(me.role)) return x; const o = { ...x }; for (const k of HIDE) delete o[k]; return o; };
      const out = rows => send(res, 200, id ? strip(rows.find(x => x.id === id)) || null : rows.map(strip));
      if (['boq_items','variations','site_reports'].includes(a)) { const pid = url.searchParams.get('project_id'); return out(pid ? db.prepare(`SELECT * FROM ${a} WHERE project_id=? ORDER BY ${a === 'site_reports' ? 'date DESC,' : ''} id`).all(+pid) : all(a)); }
      if (a === 'quotes') {                                                   // the acceptance link lets its holder sign for the client: only for those who can send quotations; the signature image only on the single record
        const mayShare = can(me.role, 'PUT', 'quotes');
        return send(res, 200, id ? (q => q ? { ...q, share_token: mayShare ? q.share_token : undefined } : null)(e.quotes.find(x => x.id === id)) : e.quotes.map(({ signature, share_token, ...q }) => ({ ...q, signed: !!signature, shared: !!share_token })));
      }
      if (e[a] && Array.isArray(e[a]) ) return send(res, 200, id ? e[a].find(x => x.id === id) || null : e[a]);
      if (!id) return out(all(a));
      return send(res, 200, strip(db.prepare(`SELECT * FROM ${a} WHERE id=?`).get(id)));
    }
    const guardInvoice = () => { const st = getSettings(); if (a === 'invoices' && st.vat_registered !== '0' && !C.validTrn(st.trn)) bad('Enter your company TRN (15 digits) in Settings before issuing tax invoices'); };
    if (method === 'POST') {
      const row = clean(a, await readBody(req));
      guardInvoice(); spec.check?.(row);
      if (a === 'payments') checkPayment(row, null);
      if (a === 'invoices' && row.number && db.prepare('SELECT 1 FROM invoices WHERE number=?').get(row.number)) bad(`Invoice number ${row.number} already exists`);
      if (a === 'quotes' && !row.number) row.number = brandRef('quotes', 'number', db.prepare('SELECT name FROM parties WHERE id=?').get(+row.client_id)?.name);
      else if (spec.prefix && !row.number) row.number = nextNumber(a, spec.prefix);
      if (a === 'projects' && !row.code) row.code = nextNumber('projects', 'PRJ', 'code');
      if (['quotes','invoices'].includes(a) && row.vat_pct === undefined) { const st = getSettings(); row.vat_pct = (st.vat_registered === '0' ? 0 : +st.vat_pct || 5); }                // not VAT-registered → 0%
      if (!row.date && spec.cols.includes('date')) row.date = today();
      const ks = Object.keys(row);
      const r = db.prepare(`INSERT INTO ${a}(${ks.join(',')}) VALUES(${ks.map(() => '?').join(',')})`).run(...Object.values(row));
      audit(req, 'create', a, Number(r.lastInsertRowid), row.number || row.name || row.description || '');
      return send(res, 200, { id: Number(r.lastInsertRowid) });
    }
    if (method === 'PUT' && id) {
      let row = clean(a, await readBody(req));
      if (a === 'boq_items' && me.role === 'site_engineer') row = 'done_pct' in row ? { done_pct: row.done_pct } : {};
      const ks = Object.keys(row);
      spec.check?.(row);
      if (a === 'invoices') {
        const cur = enrich().invoices.find(i => i.id === id); if (cur?.voided) bad('voided invoices cannot be edited');
        if (cur && row.number && row.number !== cur.number && db.prepare('SELECT 1 FROM invoices WHERE number=? AND id!=?').get(row.number, id)) bad(`Invoice number ${row.number} already exists`);
        const same = k => k === 'items' ? JSON.stringify(JSON.parse(row.items || '[]')) === JSON.stringify(cur.items) : String(row[k] ?? '') === String(cur[k] ?? '') || (+row[k] === +cur[k] && row[k] !== '' && row[k] != null);
        const changed = ks => ks.some(k => k in row && !same(k));
        // an invoice matched to a main-contractor payment certificate, or a credit note, keeps its figures
        if (cur && (cur.kind === 'credit_note' || (has('client_pcs') && db.prepare('SELECT 1 FROM client_pcs WHERE invoice_id=?').get(id))) && changed(['number', 'project_id', 'items', 'vat_pct', 'retention_pct'])) bad('This document is tied to a payment certificate or is a credit note — its figures cannot be changed.');
        // with money or credit notes on it: the number and project are fixed, and it can never drop below what was received / credited
        if (cur && (cur.paid > 0 || cur.released > 0 || cur.credited_total > 0)) {
          if (changed(['number', 'project_id'])) bad('This invoice has payments or credit notes — its number and project cannot be changed.');
          if (changed(['items', 'vat_pct', 'retention_pct'])) {
            const t = docTotals('items' in row ? JSON.parse(row.items || '[]') : cur.items, 'vat_pct' in row ? row.vat_pct : cur.vat_pct, 'retention_pct' in row ? row.retention_pct : cur.retention_pct, { retention: cur.retention_amount, vatBasis: cur.vat_basis });
            if (round(t.total - t.retention) < round(cur.paid + cur.credited) - 0.01 || t.retention < round(cur.released + cur.retention_credited) - 0.01 || t.total < cur.credited_total - 0.01)
              bad(`This invoice cannot go below what was already received or credited (${money(round(cur.paid + cur.released))} received, ${money(cur.credited_total)} credited). Issue a credit note instead.`);
          }
        }
      }
      if (a === 'payments') {
        const cur = db.prepare('SELECT * FROM payments WHERE id=?').get(id); if (!cur) return send(res, 404, { error: 'not found' });
        if (reconciled(id) && ['kind', 'amount', 'date', 'invoice_id', 'bill_id', 'bank_account_id', 'method'].some(k => k in row && String(row[k] ?? '') !== String(cur[k] ?? '') && +row[k] !== +cur[k])) bad('This payment is matched to a bank statement line — unmatch it first');
        checkPayment(row, cur);
      }
      if (a === 'quotes') {                                                   // what the client signed stays as signed
        const cur = db.prepare('SELECT * FROM quotes WHERE id=?').get(id);
        if (cur?.accepted_at) for (const k of ['items', 'vat_pct', 'client_id', 'number']) if (k in row && (k === 'items' ? JSON.stringify(JSON.parse(row.items || '[]')) !== JSON.stringify(parseItems(cur)) : String(row[k] ?? '') !== String(cur[k] ?? '') && +row[k] !== +cur[k])) bad('This quotation was accepted and signed by the client — its prices cannot be changed. Create a new quotation instead.');
      }
      audit(req, 'update', a, id, ks.join(','));
      if (ks.length) db.prepare(`UPDATE ${a} SET ${ks.map(k => k + '=?').join(',')} WHERE id=?`).run(...Object.values(row), id);
      return send(res, 200, { ok: 1 });
    }
    if (method === 'DELETE' && id) {
      if (a === 'invoices') return send(res, 409, { error: 'Tax invoices cannot be deleted (sequential numbering). Void it or issue a credit note.' });
      if (a === 'employees' && db.prepare('SELECT COUNT(*) n FROM payroll WHERE employee_id=?').get(id).n) return send(res, 409, { error: 'employee has payroll records — mark as left instead' });
      if (a === 'payments' && reconciled(id)) return send(res, 409, { error: 'This payment is matched to a bank statement line — unmatch it first' });
      if (a === 'bills') {                                                    // a bill raised by a certificate or a purchase order belongs to it
        const sc = has('sub_certs') && db.prepare('SELECT number FROM sub_certs WHERE bill_id=?').get(id), po = has('purchase_orders') && db.prepare('SELECT number FROM purchase_orders WHERE bill_id=?').get(id);
        if (sc) return send(res, 409, { error: `This bill belongs to payment certificate ${sc.number} — it cannot be deleted on its own` });
        if (po) return send(res, 409, { error: `This bill belongs to purchase order ${po.number} — cancel the purchase order instead` });
        if (db.prepare('SELECT 1 FROM payments p WHERE p.bill_id=? AND EXISTS (SELECT 1 FROM bank_lines l WHERE l.payment_id=p.id)').get(id)) return send(res, 409, { error: 'A payment of this bill is matched to a bank statement line — unmatch it first' });
      }
      audit(req, 'delete', a, id);
      if (a === 'bills') db.prepare('DELETE FROM payments WHERE bill_id=?').run(id);
      if (a === 'projects') {
        const used = db.prepare('SELECT (SELECT COUNT(*) FROM invoices WHERE project_id=?)+(SELECT COUNT(*) FROM bills WHERE project_id=?) n').get(id, id).n;
        if (used) return send(res, 409, { error: 'project has invoices or expenses' });
        const linked = ['purchase_orders', 'subcontracts', 'rfqs', 'pay_apps', 'payroll', 'stock_moves', 'fixed_assets'].filter(t => has(t) && db.prepare(`SELECT 1 FROM ${t} WHERE project_id=?`).get(id));
        if (linked.length) return send(res, 409, { error: `project is in use (${linked.join(', ').replace(/_/g, ' ')})` });
        for (const t of ['boq_items', 'variations', 'site_reports']) db.prepare(`DELETE FROM ${t} WHERE project_id=?`).run(id);
      }
      if (a === 'parties') {
        const used = db.prepare('SELECT (SELECT COUNT(*) FROM projects WHERE client_id=?)+(SELECT COUNT(*) FROM bills WHERE party_id=?)+(SELECT COUNT(*) FROM quotes WHERE client_id=?) n').get(id, id, id).n;
        if (used) return send(res, 409, { error: 'party is in use' });
      }
      db.prepare(`DELETE FROM ${a} WHERE id=?`).run(id);
      return send(res, 200, { ok: 1 });
    }
  }
  return send(res, 404, { error: 'not found' });
}

const PUB = path.join(__dirname, 'public');
// static files: kept in memory with a content hash (ETag → 304 when unchanged) and pre-gzipped text; sw.js carries the
// version of the whole app so phones fetch the new files exactly once after each update
const staticCache = new Map();
let appVersion = null;
const versionOf = () => {
  if (appVersion) return appVersion;
  const h = crypto.createHash('sha256'), walk = d => { for (const f of fs.readdirSync(d).sort()) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (f !== 'sw.js') h.update(f).update(fs.readFileSync(p)); } };
  walk(PUB); return (appVersion = h.digest('hex').slice(0, 12));
};
function serveStatic(req, res, file) {
  const mtime = fs.statSync(file).mtimeMs; let c = staticCache.get(file);
  if (!c || c.mtime !== mtime) {
    let raw = fs.readFileSync(file);
    if (path.basename(file) === 'sw.js') raw = Buffer.from(raw.toString('utf8').replace('__VERSION__', versionOf()));
    const text = /\.(js|css|html|webmanifest|svg|txt)$/.test(file);
    c = { mtime, raw, gz: text && raw.length > 1024 && zlib.gzipSync ? zlib.gzipSync(raw) : null, etag: '"' + crypto.createHash('sha256').update(raw).digest('hex').slice(0, 20) + '"' };
    staticCache.set(file, c);
  }
  const h = { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ETag: c.etag, Vary: 'Accept-Encoding' };
  if (path.basename(file) === 'sw.js') h['Service-Worker-Allowed'] = '/';
  if (req.headers['if-none-match'] === c.etag) { res.writeHead(304, h); return res.end(); }
  if (c.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) { h['Content-Encoding'] = 'gzip'; res.writeHead(200, h); return res.end(c.gz); }
  res.writeHead(200, h); res.end(c.raw);
}
const server = http.createServer(async (req, res) => {
  try {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'same-origin');
    if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if ((url.pathname.startsWith('/q/') || url.pathname.startsWith('/pub/q/')) && ctx.publicHandler && await ctx.publicHandler(req, res, url)) return;   // client quote acceptance (no login)
    let p = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    if (p === '/' || p === '\\') p = '/index.html';
    const file = path.join(PUB, p);
    if (!file.startsWith(PUB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Not found');
    serveStatic(req, res, file);
  } catch (e) {
    if (!e.status) console.error(e); send(res, e.upstream ? 502 : e.status || 500, { error: String(e.message || e) });
  }
});
// one failed background callback (e.g. a locked temp file while a PDF is cleaned up on Windows) must not take the office server down
if (require.main === module) for (const ev of ['uncaughtException', 'unhandledRejection']) process.on(ev, e => console.error(new Date().toISOString(), ev, e));
if (require.main === module) server.listen(PORT, process.env.HOST || '0.0.0.0', () => { console.log(`Contractor ERP running → http://localhost:${PORT}`); if (ctx.startBackups) ctx.startBackups(); });
module.exports = { server };
