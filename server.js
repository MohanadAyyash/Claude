// Contractor ERP — zero-dependency server (Node >= 22.5, built-in SQLite)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const C = require('./lib/compliance');
const { sendMail, validEmail } = require('./lib/mailer');
const { docHtml, toText } = require('./lib/docs');
const ACLX = require('./lib/acl');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'erp.db'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');

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
  payments: { cols: ['kind','date','amount','method','reference','invoice_id','bill_id','is_retention','notes','cheque_date','cheque_status'], num: ['amount'] },
  employees: { cols: ['name','person_code','emirates_id','passport_no','nationality','designation','join_date','end_date','status','basic','housing','other_allowance','bank_name','routing_code','iban','project_id','eid_expiry','visa_expiry','passport_expiry','card_expiry','notes'], num: ['basic','housing','other_allowance'],
    check: r => { if (r.person_code && !C.validPersonCode(r.person_code)) bad('Person code / labour card no. must be 14 digits'); if (r.emirates_id && !C.validEid(r.emirates_id)) bad('Emirates ID must be 15 digits starting with 784');
      if (r.routing_code && !C.validRouting(r.routing_code)) bad('Bank routing code must be 9 digits'); if (r.iban && !C.validIban(r.iban)) bad('Invalid UAE IBAN'); } },
};

const round = n => Math.round((n + Number.EPSILON) * 100) / 100;
const getSettings = () => Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(r => [r.key, r.value]));
const today = () => new Date().toISOString().slice(0, 10);
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
  const row = db.prepare(`SELECT ${col} v FROM ${table} WHERE ${col} LIKE ? ORDER BY id DESC LIMIT 1`).get(like);
  const n = row ? (parseInt(row.v.split('-').pop(), 10) || 0) + 1 : 1;
  return `${prefix}-${year}-${String(n).padStart(3, '0')}`;
}

// ---- enriched views -------------------------------------------------------
const countable = p => p.cheque_status !== 'bounced';           // bounced cheques never settle anything
function enrich() {
  const parties = Object.fromEntries(all('parties').map(p => [p.id, p]));
  const projects = Object.fromEntries(all('projects').map(p => [p.id, p]));
  const pays = all('payments').filter(countable);
  const raw = all('invoices');
  const invoices = raw.map(r => {
    const items = parseItems(r), tt = docTotals(items, r.vat_pct, r.retention_pct);
    const sign = r.kind === 'credit_note' ? -1 : 1, dead = !!r.voided;
    const k = dead ? 0 : sign;                                       // voided documents keep their number but carry no value
    for (const f of Object.keys(tt)) tt[f] = round(tt[f] * k);
    const mine = pays.filter(p => p.kind === 'in' && p.invoice_id === r.id);
    const paid = round(mine.filter(p => !p.is_retention).reduce((s, p) => s + p.amount, 0));
    const released = round(mine.filter(p => p.is_retention).reduce((s, p) => s + p.amount, 0));
    const credited = r.kind === 'credit_note' ? 0 : round(raw.filter(c => c.kind === 'credit_note' && !c.voided && c.original_id === r.id).reduce((s, c) => s + docTotals(parseItems(c), c.vat_pct).total, 0));
    const dueNow = round(tt.total - tt.retention);
    const balance = r.kind === 'credit_note' ? 0 : round(dueNow - paid - credited);
    const retention_open = round(tt.retention - released);
    const proj = projects[r.project_id], client = parties[proj?.client_id];
    const status = dead ? 'void' : r.kind === 'credit_note' ? 'credit' : balance <= 0.005 ? (retention_open > 0.005 ? 'retention' : 'paid') : (r.due_date && r.due_date < today() ? 'overdue' : (paid > 0 ? 'partial' : 'unpaid'));
    const warnings = [];
    if (client && !client.trn) warnings.push('customer_trn_missing');
    if (client && !client.address) warnings.push('customer_address_missing');
    return { ...r, items, ...tt, due_now: dueNow, paid, credited, balance, retention_open, status, warnings,
      project_name: proj?.name, emirate: proj?.emirate, client_id: proj?.client_id, client_name: client?.name, client_trn: client?.trn, client_address: client?.address, client_email: client?.email };
  });
  const bills = all('bills').map(r => {
    const total = round(r.amount + r.vat_amount);
    const paid = round(pays.filter(p => p.kind === 'out' && p.bill_id === r.id).reduce((s, p) => s + p.amount, 0));
    const balance = round(total - paid), party = parties[r.party_id];
    return { ...r, total, paid, balance, status: balance <= 0.005 ? 'paid' : (paid > 0 ? 'partial' : 'unpaid'),
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
    const inv = invoices.filter(i => i.project_id === p.id && !i.voided), bl = bills.filter(b => b.project_id === p.id);
    const invoiced = round(inv.reduce((s, i) => s + i.subtotal, 0));
    const collected = round(inv.reduce((s, i) => s + i.paid, 0) + inv.reduce((s, i) => s + (i.retention - i.retention_open), 0));
    const pr = db.prepare("SELECT COALESCE(SUM(gross),0) g FROM payroll WHERE status='final' AND project_id=?").get(p.id).g;
    const costBills = bl.filter(b => b.category !== 'asset');
    const cost = round(costBills.reduce((s, b) => s + b.amount, 0) + pr);
    const byCat = {};
    costBills.forEach(b => byCat[b.category] = round((byCat[b.category] || 0) + b.amount));
    if (pr) byCat.payroll = round(pr);
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
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1).toISOString().slice(0, 7);
    months.push({ month: m,
      in: round(inc.filter(p => (p.date || '').startsWith(m)).reduce((s, p) => s + p.amount, 0)),
      out: round(out.filter(p => (p.date || '').startsWith(m)).reduce((s, p) => s + p.amount, 0)) });
  }
  return {
    active_projects: projs.filter(p => p.status === 'active').length,
    contract_value: round(projs.filter(p => p.status !== 'cancelled').reduce((s, p) => s + p.revised_value, 0)),
    invoiced: round(invoices.reduce((s, i) => s + i.subtotal, 0)),
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
  const revenue = round(invoices.filter(i => !i.voided && inR(i.date)).reduce((s, i) => s + i.subtotal, 0));
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
    const due = new Date(+m.month.slice(0, 4), +m.month.slice(5, 7), 15).toISOString().slice(0, 10);
    if (due < t) add('bad', 'wps_late', { month: m.month });
  }
  for (const d of db.prepare('SELECT name,entity,expiry_date FROM documents WHERE expiry_date IS NOT NULL AND expiry_date<? ORDER BY expiry_date').all(soon)) add(d.expiry_date < t ? 'bad' : 'warn', 'doc_file', { who: d.name, date: d.expiry_date });
  const bounced = db.prepare("SELECT COUNT(*) n FROM payments WHERE cheque_status='bounced'").get().n;
  if (bounced) add('bad', 'bounced', { count: bounced });
  const { invoices } = enrich();
  const noTrn = new Set(invoices.filter(i => !i.voided && i.warnings.includes('customer_trn_missing')).map(i => i.client_name));
  if (noTrn.size) add('warn', 'customer_trn', { who: [...noTrn].join(', ') });
  return alerts;
}

// ---- auth -----------------------------------------------------------------
const isHttps = req => req.headers['x-forwarded-proto'] === 'https' || process.env.SECURE_COOKIES === '1';
const cookie = (req, token, maxAge) => `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
const fails = new Map();                                    // ip -> [timestamps of failed logins]
const clientIp = req => (process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const locked = ip => { const t = (fails.get(ip) || []).filter(x => Date.now() - x < 15 * 60e3); fails.set(ip, t); return t.length >= 8; };
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
  return s ? db.prepare('SELECT id,username,role,employee_id FROM users WHERE id=?').get(s.user_id) : null;
}

// ---- http -----------------------------------------------------------------
const MIME = { '.woff2': 'font/woff2', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const send = (res, code, body, headers = {}) => {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(code, { 'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
};
const readBody = (req, max = 5e6) => new Promise((ok, no) => {
  let b = ''; req.on('data', c => { b += c; if (b.length > max) req.destroy(); });
  req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { no(e); } });
});

function clean(table, body) {
  const spec = TABLES[table], out = {};
  for (const c of spec.cols) {
    if (!(c in body)) continue;
    let v = body[c];
    if (spec.json?.includes(c)) v = JSON.stringify(Array.isArray(v) ? v : []);
    else if (spec.num?.includes(c)) v = +v || 0;
    else if (v === '') v = null;
    out[c] = v;
  }
  return out;
}

const { ROLES } = ACLX, can = ACLX.can;
const SETTING_KEYS = ['address_ar','license_authority','doc_prefix','company_name_ar','website','po_box','footer_text','legal_form','smtp_host','smtp_port','smtp_user','smtp_from','smtp_secure','company_name','trn','address','phone','email','vat_pct','terms','bank_details','currency','vat_registered','ct_trn','license_no','license_expiry','mohre_id','employer_routing','employer_bank','employer_iban'];
function audit(req, action, tbl, rec, detail = '') {
  db.prepare('INSERT INTO audit_log(ts,user,action,tbl,rec,detail) VALUES(?,?,?,?,?,?)').run(new Date().toISOString(), sessionUser(req)?.username || '', action, tbl, rec, String(detail).slice(0, 500));
}
const monthOk = m => /^\d{4}-(0[1-9]|1[0-2])$/.test(m || '');
function payrollRows(month) {
  return db.prepare(`SELECT p.*, e.name, e.person_code, e.routing_code, e.iban, e.designation FROM payroll p JOIN employees e ON e.id=p.employee_id WHERE p.month=? ORDER BY e.name`).all(month)
    .map(r => ({ ...r, deduction_ratio: r.gross ? r.deductions / r.gross : 0 }));
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
  if (!st.smtp_host || !st.smtp_from) bad('Email is not configured — set the SMTP details in Settings');
  return { host: st.smtp_host, port: st.smtp_port, secure: st.smtp_secure === '1', user: st.smtp_user, pass: st.smtp_pass, from: st.smtp_from, fromName: st.company_name };
};
const ctx = { brandRef, vatReport: (...a) => vatReport(...a), db, send, bad, audit, readBody, getSettings, enrich, today, round, C, nextNumber, parseItems, TABLES, ROLES, DATA_DIR, inCash, countable, sessionUser, projectRows, payrollRows, applyPayroll, mailCfg: mailCfgFor, sendMail, validEmail, docHtml, toText, hooks: {} };
// brand e-mail signature: Arial text block + the one-line logo as an inline image
ctx.signature = user => {
  const S = getSettings(), prof = db.prepare('SELECT username,display_name,job_title,mobile FROM users WHERE id=?').get(user.id) || user, logo = ctx.brandBuf && ctx.brandBuf('logo_line');
  return { html: require('./lib/docs').signatureHtml({ S, user: prof, logoCid: logo ? 'brandlogo' : null }), inline: logo ? [{ cid: 'brandlogo', mime: 'image/png', content: logo }] : [] };
};
const MODULES = ['brand', 'documents', 'print', 'hr', 'procurement', 'assets', 'accounting'].map(n => require('./modules/' + n)(ctx));
for (const m of MODULES) if (m.tables) Object.assign(TABLES, m.tables);

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // after /api
  const [a, b, c] = parts, method = req.method;

  if (a === 'status') return send(res, 200, { setup: db.prepare('SELECT COUNT(*) n FROM users').get().n === 0, user: sessionUser(req) });
  if (a === 'setup' && method === 'POST') {
    if (db.prepare('SELECT COUNT(*) n FROM users').get().n) return send(res, 403, { error: 'already set up' });
    const { username, password, company } = await readBody(req);
    if (!username || !password || password.length < 6) return send(res, 400, { error: 'password must be at least 6 characters' });
    const salt = crypto.randomBytes(16).toString('hex');
    const r = db.prepare('INSERT INTO users(username,salt,hash,role) VALUES(?,?,?,?)').run(username, salt, hashPw(password, salt), 'admin');
    const ins = db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)');
    ins.run('company_name', company || 'Trigon Civil Contracting LLC'); ins.run('company_name_ar', company ? '' : 'تريجون سيفيل للمقاولات ذ م م'); ins.run('vat_pct', '5'); ins.run('currency', 'AED');
    ins.run('terms', '1. Payment: 30 days from invoice date.\n2. Prices exclude VAT unless stated.\n3. Variations to be agreed in writing.');
    return send(res, 200, { ok: 1 }, { 'Set-Cookie': cookie(req, createSession(r.lastInsertRowid), 2592000) });
  }
  if (a === 'login' && method === 'POST') {
    const { username, password } = await readBody(req), ip = clientIp(req);
    if (locked(ip)) return send(res, 429, { error: 'too many failed attempts — try again in 15 minutes' });
    const u = db.prepare('SELECT * FROM users WHERE username=?').get(username || '');
    if (!u || !crypto.timingSafeEqual(Buffer.from(hashPw(password || '', u.salt)), Buffer.from(u.hash))) { fails.get(ip).push(Date.now()); return send(res, 401, { error: 'invalid credentials' }); }
    fails.delete(ip);
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

  const mailCfg = () => {
    const st = getSettings();
    if (!st.smtp_host || !st.smtp_from) bad('Email is not configured — set the SMTP details in Settings');
    return { host: st.smtp_host, port: st.smtp_port, secure: st.smtp_secure === '1', user: st.smtp_user, pass: st.smtp_pass, from: st.smtp_from, fromName: st.company_name };
  };
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
    if (method === 'GET') return send(res, 200, db.prepare(`SELECT u.id,u.username,u.role,u.employee_id,e.name employee_name FROM users u LEFT JOIN employees e ON e.id=u.employee_id ${hrOnly ? "WHERE u.role='employee'" : ''} ORDER BY u.id`).all());
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
      audit(req, 'update', 'users', u.id, `${u.username}${body.role ? ' role=' + body.role : ''}${body.password ? ' password reset' : ''}`);
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
      if (body.smtp_from && !validEmail(body.smtp_from)) return send(res, 400, { error: 'SMTP "from" must be a valid email address' });
      audit(req, 'update', 'settings', 0, 'company settings');
    }
    const st = getSettings(); st.smtp_pass_set = st.smtp_pass ? '1' : ''; delete st.smtp_pass;       // never send the SMTP password back
    if (me.role === 'employee') return send(res, 200, { company_name: st.company_name, company_name_ar: st.company_name_ar, currency: st.currency });
    return send(res, 200, st);
  }
  if (a === 'profile') {
    if (method === 'PUT') { const x = await readBody(req); db.prepare('UPDATE users SET display_name=?, job_title=?, mobile=? WHERE id=?').run(String(x.display_name || '').slice(0, 80), String(x.job_title || '').slice(0, 80), String(x.mobile || '').slice(0, 30), me.id); }
    return send(res, 200, db.prepare('SELECT username,display_name,job_title,mobile FROM users WHERE id=?').get(me.id)), true;
  }
  if (a === 'password' && method === 'POST') {
    const { password } = await readBody(req);
    if (!password || password.length < 6) return send(res, 400, { error: 'password must be at least 6 characters' });
    const salt = crypto.randomBytes(16).toString('hex');
    db.prepare('UPDATE users SET salt=?, hash=? WHERE id=?').run(salt, hashPw(password, salt), sessionUser(req).id);
    return send(res, 200, { ok: 1 });
  }
  if (a === 'dashboard') { const d = dashboard(); if (!['admin', 'accountant'].includes(me.role)) d.alerts = []; return send(res, 200, d); }
  if (a === 'vat') return send(res, 200, vatReport(url.searchParams.get('from'), url.searchParams.get('to')));
  if (a === 'project-summary') return send(res, 200, projectRows());
  if (a === 'backup') {
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
    const body = await readBody(req);
    const r = db.prepare("INSERT INTO invoices(number,date,project_id,items,vat_pct,notes,kind,original_id) VALUES(?,?,?,?,?,?,?,?)")
      .run(nextNumber('invoices', 'CN'), today(), orig.project_id, JSON.stringify(Array.isArray(body.items) && body.items.length ? body.items : orig.items), orig.vat_pct, `Credit note against ${orig.number}${body.reason ? ' — ' + body.reason : ''}`, 'credit_note', orig.id);
    audit(req, 'create', 'credit_note', Number(r.lastInsertRowid), `against ${orig.number}`);
    return send(res, 200, { id: Number(r.lastInsertRowid) });
  }
  if (a === 'invoices' && c === 'void' && method === 'POST') {
    const { reason } = await readBody(req);
    if (!reason) return send(res, 400, { error: 'a reason is required to void a tax invoice' });
    const inv = enrich().invoices.find(i => i.id === +b);
    if (!inv) return send(res, 404, { error: 'not found' });
    if (inv.paid > 0) return send(res, 409, { error: 'invoice has payments — issue a credit note instead' });
    db.prepare('UPDATE invoices SET voided=1, void_reason=? WHERE id=?').run(reason, +b);
    audit(req, 'void', 'invoices', +b, `${inv.number}: ${reason}`);
    return send(res, 200, { ok: 1 });
  }

  // ---- employees / payroll / WPS ----
  if (a === 'employees' && c === 'gratuity') {
    const e = db.prepare('SELECT * FROM employees WHERE id=?').get(+b);
    return e ? send(res, 200, C.gratuity(e, url.searchParams.get('end'))) : send(res, 404, { error: 'not found' });
  }
  if (a === 'payroll') {
    const month = url.searchParams.get('month') || '';
    if (b === 'generate' && method === 'POST') {
      const { month: m } = await readBody(req);
      if (!monthOk(m)) return send(res, 400, { error: 'month must be YYYY-MM' });
      const first = `${m}-01`, last = `${m}-${String(C.daysInMonth(m)).padStart(2, '0')}`;
      let n = 0;
      for (const e of db.prepare("SELECT * FROM employees WHERE (join_date IS NULL OR join_date<=?) AND (end_date IS NULL OR end_date>=?) AND status='active'").all(last, first)) {
        if (db.prepare('SELECT 1 FROM payroll WHERE month=? AND employee_id=?').get(m, e.id)) continue;
        const from = e.join_date && e.join_date > first ? e.join_date : first, to = e.end_date && e.end_date < last ? e.end_date : last;
        const days = Math.min(30, Math.round((new Date(to) - new Date(from)) / 864e5) + 1);
        const r = db.prepare('INSERT INTO payroll(month,employee_id,project_id,days_worked) VALUES(?,?,?,?)').run(m, e.id, e.project_id, days);
        applyPayroll(Number(r.lastInsertRowid), ctx.hooks.payrollInputs ? ctx.hooks.payrollInputs(e, m, days) : {}); n++;
      }
      audit(req, 'generate', 'payroll', 0, `${m}: ${n} rows`);
      return send(res, 200, { created: n });
    }
    if (b === 'finalize' && method === 'POST') {
      const { month: m } = await readBody(req);
      const issues = C.payrollIssues(getSettings(), payrollRows(m)).filter(i => !i.warn);
      if (issues.length) return send(res, 400, { error: 'WPS data incomplete', issues });
      db.prepare("UPDATE payroll SET status='final' WHERE month=?").run(m);
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
      applyPayroll(+b, await readBody(req)); audit(req, 'update', 'payroll', +b, row.month);
      return send(res, 200, { ok: 1 });
    }
    if (b && method === 'DELETE') {
      const row = db.prepare('SELECT * FROM payroll WHERE id=?').get(+b);
      if (row?.status === 'final') return send(res, 409, { error: 'payroll is finalized' });
      db.prepare('DELETE FROM payroll WHERE id=?').run(+b);
      return send(res, 200, { ok: 1 });
    }
  }

  if (a === 'projects' && c === 'progress-invoice' && method === 'POST') {
    const proj = db.prepare('SELECT * FROM projects WHERE id=?').get(+b);
    if (!proj) return send(res, 404, { error: 'not found' });
    const st = getSettings(); if (st.vat_registered !== '0' && !C.validTrn(st.trn)) bad('Enter your company TRN (15 digits) in Settings before issuing tax invoices');
    const lines = db.prepare('SELECT * FROM boq_items WHERE project_id=? AND done_pct>billed_pct+0.0001 ORDER BY id').all(+b);
    if (!lines.length) bad('No unbilled progress — update the completion % on the BOQ first');
    const items = lines.map(i => ({ description: `${i.description} (${i.billed_pct}% → ${i.done_pct}%)`, unit: i.unit, qty: round(i.qty * (i.done_pct - i.billed_pct) / 100), rate: i.rate, vat: 'std' }));
    const r = db.prepare('INSERT INTO invoices(number,date,project_id,items,vat_pct,retention_pct,notes) VALUES(?,?,?,?,?,?,?)')
      .run(nextNumber('invoices', 'INV'), today(), proj.id, JSON.stringify(items), +st.vat_pct || 5, proj.retention_pct || 0, 'Progress invoice');
    db.prepare('UPDATE boq_items SET billed_pct=done_pct WHERE project_id=?').run(+b);
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

  if (TABLES[a]) {
    const spec = TABLES[a], id = b ? +b : null;
    if (method === 'GET') {
      const e = enrich();
      if (['boq_items','variations','site_reports'].includes(a)) { const pid = url.searchParams.get('project_id'); const rows = pid ? db.prepare(`SELECT * FROM ${a} WHERE project_id=? ORDER BY ${a === 'site_reports' ? 'date DESC,' : ''} id`).all(+pid) : all(a); return send(res, 200, id ? rows.find(x => x.id === id) || null : rows); }
      if (e[a] && Array.isArray(e[a]) ) return send(res, 200, id ? e[a].find(x => x.id === id) || null : e[a]);
      return send(res, 200, id ? db.prepare(`SELECT * FROM ${a} WHERE id=?`).get(id) : all(a));
    }
    const guardInvoice = () => { const st = getSettings(); if (a === 'invoices' && st.vat_registered !== '0' && !C.validTrn(st.trn)) bad('Enter your company TRN (15 digits) in Settings before issuing tax invoices'); };
    if (method === 'POST') {
      const row = clean(a, await readBody(req));
      guardInvoice(); spec.check?.(row);
      if (a === 'quotes' && !row.number) row.number = brandRef('quotes', 'number', db.prepare('SELECT name FROM parties WHERE id=?').get(+row.client_id)?.name);
      else if (spec.prefix && !row.number) row.number = nextNumber(a, spec.prefix);
      if (a === 'projects' && !row.code) row.code = nextNumber('projects', 'PRJ', 'code');
      if (['quotes','invoices'].includes(a) && row.vat_pct === undefined) row.vat_pct = +getSettings().vat_pct || 5;
      if (!row.date && spec.cols.includes('date')) row.date = today();
      const ks = Object.keys(row);
      const r = db.prepare(`INSERT INTO ${a}(${ks.join(',')}) VALUES(${ks.map(() => '?').join(',')})`).run(...Object.values(row));
      audit(req, 'create', a, Number(r.lastInsertRowid), row.number || row.name || row.description || '');
      return send(res, 200, { id: Number(r.lastInsertRowid) });
    }
    if (method === 'PUT' && id) {
      const row = clean(a, await readBody(req)), ks = Object.keys(row);
      spec.check?.(row);
      if (a === 'invoices') { const cur = db.prepare('SELECT voided FROM invoices WHERE id=?').get(id); if (cur?.voided) bad('voided invoices cannot be edited'); }
      audit(req, 'update', a, id, ks.join(','));
      if (ks.length) db.prepare(`UPDATE ${a} SET ${ks.map(k => k + '=?').join(',')} WHERE id=?`).run(...Object.values(row), id);
      return send(res, 200, { ok: 1 });
    }
    if (method === 'DELETE' && id) {
      if (a === 'invoices') return send(res, 409, { error: 'Tax invoices cannot be deleted (sequential numbering). Void it or issue a credit note.' });
      if (a === 'employees' && db.prepare('SELECT COUNT(*) n FROM payroll WHERE employee_id=?').get(id).n) return send(res, 409, { error: 'employee has payroll records — mark as left instead' });
      audit(req, 'delete', a, id);
      if (a === 'bills') db.prepare('DELETE FROM payments WHERE bill_id=?').run(id);
      if (a === 'projects') {
        const used = db.prepare('SELECT (SELECT COUNT(*) FROM invoices WHERE project_id=?)+(SELECT COUNT(*) FROM bills WHERE project_id=?) n').get(id, id).n;
        if (used) return send(res, 409, { error: 'project has invoices or expenses' });
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
const server = http.createServer(async (req, res) => {
  try {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'same-origin');
    if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    let p = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    if (p === '/' || p === '\\') p = '/index.html';
    const file = path.join(PUB, p);
    if (!file.startsWith(PUB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    if (!e.status) console.error(e); send(res, e.status || 500, { error: String(e.message || e) });
  }
});
if (require.main === module) server.listen(PORT, process.env.HOST || '0.0.0.0', () => console.log(`Contractor ERP running → http://localhost:${PORT}`));
module.exports = { server };
