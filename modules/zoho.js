// Zoho Books bridge: pushes the day's transactions (contacts, tax invoices / credit notes, supplier bills / expenses, receipts / payments)
// to Zoho Books API v3, keeps a per-record sync log so nothing is sent twice, produces a daily transactions report, and offers
// Zoho-ready CSV import files for organisations without API access. The OAuth secrets live in their own table and never reach the browser.
const Z = require('../lib/zoho');

module.exports = ctx => {
  const { db, send, audit, readBody, today, round, enrich } = ctx;
  db.exec(`CREATE TABLE IF NOT EXISTS zoho_config(key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS zoho_sync(id INTEGER PRIMARY KEY, kind TEXT, local_id INTEGER, zoho_id TEXT, zoho_type TEXT, status TEXT, error TEXT, hash TEXT, synced_at TEXT, UNIQUE(kind, local_id));
  CREATE TABLE IF NOT EXISTS zoho_map(kind TEXT, local_key TEXT, zoho_id TEXT, label TEXT, PRIMARY KEY(kind, local_key));
  CREATE TABLE IF NOT EXISTS zoho_runs(id INTEGER PRIMARY KEY, started TEXT, finished TEXT, trigger TEXT, user TEXT, sent INTEGER DEFAULT 0, updated INTEGER DEFAULT 0, failed INTEGER DEFAULT 0, skipped INTEGER DEFAULT 0, message TEXT);`);
  // the send log is also the outbound queue and the exactly-once mapping (one row per Trigon record):
  //   attempts / next_at: retry with back-off · pending_create: a create was sent and its answer not recorded (look it up before sending again)
  //   doc_date: the record's date (closed periods) · sent_eff: the accounting effect last sent (read-back and Zoho-side edits) · recon*: last reconciliation
  // zoho_map also records what the account provisioning found or created in Zoho
  const addCol = (t, c, d) => { if (!db.prepare(`PRAGMA table_info(${t})`).all().some(x => x.name === c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`); };
  for (const [c, d] of [['attempts', 'INTEGER DEFAULT 0'], ['next_at', 'TEXT'], ['created_at', 'TEXT'], ['verified_at', 'TEXT'], ['doc_date', 'TEXT'], ['sent_eff', 'TEXT'], ['pending_create', 'INTEGER DEFAULT 0'], ['recon', 'TEXT'], ['recon_at', 'TEXT'], ['recon_note', 'TEXT']]) addCol('zoho_sync', c, d);
  for (const [c, d] of [['zoho_code', 'TEXT'], ['zoho_name', 'TEXT'], ['zoho_type', 'TEXT'], ['parent_id', 'TEXT'], ['created_by_trigon', 'INTEGER DEFAULT 0'], ['mapped_at', 'TEXT'], ['verified_at', 'TEXT'], ['partner_id', 'INTEGER']]) addCol('zoho_map', c, d);
  // no real transaction is sent until the read-only preflight has reached READY (set by the account provisioning, modules/zohoacct.js)
  db.prepare("INSERT OR IGNORE INTO zoho_config(key,value) VALUES('gate_required','1')").run();
  const SECRETS = ['client_secret', 'refresh_token'];
  // the OAuth client (and optionally the refresh token) come from .env when set there; they then cannot be changed from the screen
  const ENV = { client_id: 'ZOHO_CLIENT_ID', client_secret: 'ZOHO_CLIENT_SECRET', dc: 'ZOHO_DC', refresh_token: 'ZOHO_REFRESH_TOKEN' };
  const envOf = k => String(process.env[ENV[k]] || '').trim();
  const cfg = () => {
    const o = { dc: 'ae', hour: '23', post: '0' }; for (const r of db.prepare('SELECT key,value FROM zoho_config').all()) o[r.key] = r.value;
    for (const k of Object.keys(ENV)) if (envOf(k)) o[k] = envOf(k);
    o.env = Object.keys(ENV).filter(envOf).join(',');
    return o;
  };
  const setCfg = (k, v) => db.prepare('INSERT INTO zoho_config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, v == null ? '' : String(v));
  const accountsUrl = c => process.env.ZOHO_ACCOUNTS_URL || Z.ACCOUNTS[c.dc] || Z.ACCOUNTS.ae;      // env override: development mock only
  const orgsOf = c => { try { return JSON.parse(c.orgs || '[]'); } catch { return []; } };
  const publicCfg = c => {
    const o = { ...c, secret_set: c.client_secret ? '1' : '', connected: c.refresh_token ? '1' : '', orgs: orgsOf(c) };
    for (const k of [...SECRETS, 'api_domain']) delete o[k];
    return o;
  };
  const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
  const canFin = me => ['admin', 'accountant'].includes(me.role);
  const tokenCache = {};                                                               // access token (1 hour), shared by all runs
  const client = (c, readOnly = false) => {
    if (!c.client_id || !c.client_secret || !c.refresh_token) throw new Error('Connect to Zoho first (Client ID, Client Secret and a grant code)');
    if (!c.org) throw new Error('Choose the Zoho Books organisation first');
    return Z.createClient({ accounts: accountsUrl(c), client_id: c.client_id, client_secret: c.client_secret, refresh_token: c.refresh_token, api_domain: c.api_domain, org: c.org, cache: tokenCache, readOnly, net: readOnly ? ctx.zohoNet || null : null });
  };

  const hashOf = o => { const s = JSON.stringify(o); let h = 0; for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0; return String(h >>> 0); };
  let dry = null;                                                                     // during a dry run: { recs, ops, items, accts } — nothing is written or sent
  // preflight report: what would happen to each record, and how each Trigon account would be resolved in Zoho
  const note = (kind, id, ref, action, why) => { if (dry) dry.items.push({ kind, local_id: id, ref: String(ref || ''), action, why: why || '' }); };
  const useAcct = (code, label, zohoId, how) => { if (dry && !dry.accts.has(String(code))) dry.accts.set(String(code), { code: String(code), label, zoho_id: zohoId || null, how }); };
  const rec = (kind, id) => (dry && dry.recs.has(kind + ':' + id) ? dry.recs.get(kind + ':' + id) || undefined : db.prepare('SELECT * FROM zoho_sync WHERE kind=? AND local_id=?').get(kind, id));
  const WAIT = ['error', 'retrying', 'blocked'];                                      // a row in one of these keeps its retry count
  const mark = (kind, id, zohoId, type, status, error, hash, x = {}) => dry ? void dry.recs.set(kind + ':' + id, { kind, local_id: id, zoho_id: x.clearZohoId ? null : zohoId == null ? (rec(kind, id) || {}).zoho_id : String(zohoId), zoho_type: type, status, error, hash }) : db.prepare(`INSERT INTO zoho_sync(kind,local_id,zoho_id,zoho_type,status,error,hash,synced_at,created_at,doc_date,sent_eff,verified_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(kind,local_id) DO UPDATE SET zoho_id=CASE WHEN ? THEN NULL ELSE COALESCE(excluded.zoho_id,zoho_id) END, zoho_type=COALESCE(excluded.zoho_type,zoho_type), status=excluded.status, error=excluded.error, hash=COALESCE(excluded.hash,hash), synced_at=excluded.synced_at,
      doc_date=COALESCE(excluded.doc_date,doc_date), sent_eff=COALESCE(excluded.sent_eff,sent_eff), verified_at=COALESCE(excluded.verified_at,verified_at),
      pending_create=CASE WHEN ? OR excluded.zoho_id IS NOT NULL THEN 0 ELSE pending_create END,
      attempts=CASE WHEN excluded.status IN ('error','retrying','blocked') THEN attempts ELSE 0 END, next_at=CASE WHEN excluded.status IN ('error','retrying','blocked') THEN next_at ELSE NULL END`)
    .run(kind, id, zohoId == null ? null : String(zohoId), type ?? null, status, error ?? null, hash ?? null, now(), now(), x.date || null, x.eff ? JSON.stringify(x.eff) : null, x.verified || null, x.clearZohoId ? 1 : 0, x.clearZohoId ? 1 : 0);
  // a create is about to be sent: if its answer is lost (timeout, crash), the next attempt looks it up in Zoho instead of sending it twice
  const pendingCreate = (kind, id, type, date) => { if (dry) return; mark(kind, id, null, type, (rec(kind, id) || {}).status === 'ok' ? 'ok' : 'sending', null, null, { date });
    db.prepare('UPDATE zoho_sync SET pending_create=1 WHERE kind=? AND local_id=?').run(kind, id); };
  const blocked = (code, msg) => Object.assign(new Error(`${code}: ${msg}`), { blocked: code });
  // held: deliberately not sent yet, re-checked on every run (no Zoho call is made for it) — VAT pending, or an account whose
  // accounting treatment is still to be decided (DEFERRED). Released by itself once the condition is gone.
  const held = (code, msg) => Object.assign(new Error(`${code}: ${msg}`), { held: code });
  const DEFERRED = { 6150: 'gain / loss on asset disposal: separate gain (Other Income) and loss (Other Expense) treatment, the same in Trigon and Zoho, is pending an accounting change' };
  const vatPending = () => cfg().gate === 'READY_NON_VAT';                              // the gate opened for non-VAT records only (VAT registration pending)
  // closed accounting period (Settings → closing date): nothing dated on or before it is created, changed or removed in Zoho
  const lockDate = () => { try { const v = (db.prepare("SELECT value FROM settings WHERE key='lock_date'").get() || {}).value; return /^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : ''; } catch { return ''; } };
  const guardPeriod = (date, what) => { const l = lockDate(); if (l && date && date <= l) throw blocked('CLOSED_PERIOD', `${what} dated ${date} is in the closed period (closed up to ${l}) — not changed in Zoho`); };
  const newMode = () => cfg().gate_required === '1';
  // ---------- accounting effect of a Zoho object (what it posts), to compare what was sent with what Zoho holds ----------
  // { date, total, lines: [[amount, tax, account, …]] } — an empty account means "Zoho's default account" (not compared)
  function effect(type, o, lk) {
    if (!o) return null;
    const pct = id => { const t = ((lk && lk.taxes) || []).find(x => String(x.tax_id) === String(id)); return t ? +t.tax_percentage : 0; };
    if (['invoice', 'creditnote', 'bill'].includes(type)) {
      const lines = (o.line_items || []).map(l => [round((+l.quantity || 0) * (+l.rate || 0)), l.tax_id ? String(l.tax_id) : '', l.account_id ? String(l.account_id) : '']);
      const byLine = round(lines.reduce((s, l) => s + l[0] + round(l[0] * pct(l[1]) / 100), 0)), byTotal = round(lines.reduce((s, l) => s + l[0] * (1 + pct(l[1]) / 100), 0));
      return { date: o.date, total: o.total != null && o.line_items && !o.__sent ? round(+o.total) : byTotal, alt: byLine, lines, status: o.status || '' };
    }
    if (type === 'expense' || type === 'expense2') { const a = round(+o.amount || 0); return { date: o.date, total: round(a * (1 + pct(o.tax_id) / 100)), alt: round(a + round(a * pct(o.tax_id) / 100)), lines: [[a, o.tax_id ? String(o.tax_id) : '', String(o.account_id || ''), String(o.paid_through_account_id || '')]] }; }
    if (type === 'journal') { const lines = (o.line_items || []).map(l => [round(+l.amount || 0), l.debit_or_credit, String(l.account_id || '')]); return { date: o.journal_date, total: round(lines.filter(l => l[1] === 'debit').reduce((s, l) => s + l[0], 0)), lines, status: o.status || '' }; }
    if (type === 'customerpayment' || type === 'vendorpayment') return { date: o.date, total: round(+o.amount || 0), lines: [[round(+o.amount || 0), '', String((type === 'customerpayment' ? o.account_id : o.paid_through_account_id) || '')]] };
    return null;
  }
  const sentEff = (type, vals, lk) => effect(type, { ...vals, __sent: true }, lk);
  // MATCH · AMOUNT_MISMATCH · ACCOUNT_MISMATCH · DATE_MISMATCH (in that order of gravity); tolerance: the ledger's 2 decimals
  function compareEff(exp, got) {
    if (!exp || !got) return 'AMOUNT_MISMATCH';
    const near = (a, b) => Math.abs(a - b) < 0.005;
    if (!near(exp.total, got.total) && !(exp.alt != null && near(exp.alt, got.total))) return 'AMOUNT_MISMATCH';
    const key = (l, withAcct) => l.map((v, i) => (i === 2 || i === 3) && !withAcct ? '' : typeof v === 'number' ? v.toFixed(2) : v).join('|');
    const a = exp.lines.map(l => key(l, false)).sort(), b = got.lines.map(l => key(l, false)).sort();
    if (a.length !== b.length || a.some((x, i) => x !== b[i])) return 'AMOUNT_MISMATCH';
    const unmatched = [...got.lines];                                                   // each expected line finds a Zoho line with the same amount and the expected account
    for (const l of exp.lines) { const i = unmatched.findIndex(g => key(g, false) === key(l, false) && l.every((v, k) => !(k === 2 || k === 3) || !v || String(g[k]) === String(v)));
      if (i < 0) return 'ACCOUNT_MISMATCH'; unmatched.splice(i, 1); }
    return exp.date === got.date ? 'MATCH' : 'DATE_MISMATCH';
  }
  // Zoho changed it after Trigon sent it? (only when the effect sent is known — rows sent before this version have none)
  const modifiedInZoho = (r, type, cur, lk) => !!(r && r.sent_eff && cur && compareEff(JSON.parse(r.sent_eff), effect(type, cur, lk)) !== 'MATCH');
  const gone = e => e.status === 404 || e.code === 1002 || /does not exist/i.test(e.message);

  // ---------- our accounts / projects → Zoho accounts / projects or reporting-tag options ----------
  // the transaction types added later (petty cash, custody, claims, partners, assets, salaries paid by date, expenses paid through
  // their real account) are sent only for records dated on or after this date (zoho_config start_v2): history is never resent
  const v2From = () => cfg().start_v2 || '';
  const isV2 = d => { const s = v2From(); return !!(s && d && d >= s); };
  const PARTNER_CODES = ['3000', '2500', '3110'];                                     // each partner has his own Zoho accounts
  const LEDGER2 = { 1050: 'Cheques in hand (PDC received)', 2400: 'Advances from customers', 1010: 'Office petty cash', 1030: 'Employee cash custody', 2260: 'Expense claims owed to employees (e.g. Zoho Employee Reimbursements)', 2050: 'Cheques issued (PDC payable)', 3100: 'Retained earnings / owner current account', 3900: 'Opening balance equity', 1600: 'Fixed assets (cost)', 1690: 'Accumulated depreciation', 6100: 'Depreciation', 6150: 'Gain / loss on disposal of assets' };
  const LEDGER = { 1100: 'Accounts receivable (default: Zoho Accounts Receivable)', 5200: 'Site labour salaries (projects)', 6200: 'Head-office salaries', 2200: 'Salaries payable', 2250: 'Employee deductions payable', 1300: 'Employee advances', 5260: 'End-of-service benefits (expense)', 2300: 'End-of-service provision', 1150: 'Retention receivable' };
  const partnerName = id => (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='partners'").get() && (db.prepare('SELECT name FROM partners WHERE id=?').get(id) || {}).name) || `#${id}`;
  const mapOf = (kind, key) => (db.prepare('SELECT zoho_id FROM zoho_map WHERE kind=? AND local_key=?').get(kind, String(key)) || {}).zoho_id || null;
  // a Trigon ledger code → its Zoho account: our mapping first (per partner for 3000 / 2500 / 3110); banks, cash on hand, receivable
  // and retention keep their automatic fallbacks; anything else must be mapped (the preflight lists what is missing)
  const zAcct = (code, lk, partnerId) => {
    code = String(code);
    const own = partnerId && PARTNER_CODES.includes(code), key = own ? `acct:${code}:p${partnerId}` : 'acct:' + code, m = mapOf('account', key);
    const bank = ctx.bankAccounts && ctx.bankAccounts().find(b => b.ledger_code === code);
    const auto = m ? null : bank ? (lk.bank || lk.cash) : code === '1020' ? (lk.cash || lk.bank) : code === '1100' ? lk.ar : code === '2000' ? lk.ap : code === '1150' ? lk.retention : null;
    const name = (db.prepare('SELECT name FROM accounts WHERE code=?').get(code) || {}).name || LEDGER2[code] || LEDGER[code] || code;
    const label = own ? `${name} — ${partnerName(partnerId)}` : bank ? `Bank — ${bank.name}` : name;
    useAcct(key.slice(5), label, m || (auto && auto.account_id), m ? 'mapped' : auto ? 'automatic (Zoho default account of that type)' : 'missing');
    if (!m && !auto) throw new Error(`map our account ${key.slice(5).replace(':p', ' of partner #')} (${label}) to a Zoho account first`);
    if (m && newMode() && lk.coa && !dry) {                                            // the mapped Zoho account must still exist, be active and have a type that fits
      const a = lk.coa.find(x => String(x.account_id) === String(m)), types = expectTypes(key);
      if (!a) throw blocked('ACCOUNT_CONFLICT', `${key.slice(5)} is mapped to Zoho account ${m}, which no longer exists or is inactive — nothing is sent with it`);
      if (types && !types.includes(a.account_type)) throw blocked('ACCOUNT_CONFLICT', `${key.slice(5)} is mapped to "${a.account_name}" of type ${a.account_type}; expected ${types.join(' or ')}`);
    }
    return m || auto.account_id;
  };
  // a project's reference on a line: a Zoho project (project:<id>) or a reporting-tag option (tag:<tag_id>:<option_id>)
  const projectRef = pid => {
    const v = pid && mapOf('project', pid); if (!v) return {};
    const [k, a, b] = v.split(':');
    return k === 'project' ? { project_id: a } : k === 'tag' ? { tags: [{ tag_id: a, tag_option_id: b }] } : {};
  };

  // ---------- what goes to Zoho (pure mapping, also used by the CSV export and the daily report) ----------
  const PLACE = { abu_dhabi: 'AB', dubai: 'DU', sharjah: 'SH', ajman: 'AJ', uaq: 'UM', rak: 'RA', fujairah: 'FU' };   // Zoho's UAE place-of-supply codes
  const CAT = { asset: 'Fixed asset', materials: 'Materials', labour: 'Labour', subcontract: 'Subcontract', equipment: 'Equipment', transport: 'Transport', permits: 'Permits', accommodation: 'Accommodation', visa: 'Visas & labour fees', insurance: 'Medical insurance', overhead: 'Overhead', other: 'Other' };
  const TAX_NAME = { std: 'Standard Rate', zero: 'Zero Rate', exempt: 'Exempt' }, TAX_PCT = { std: 5, zero: 0, exempt: 0 };
  const MODE = { cash: 'cash', petty: 'cash', cheque: 'check', bank: 'banktransfer', card: 'creditcard' };
  function data(from, to) {
    const e = enrich(), inRange = d => d && (!from || d >= from) && (!to || d <= to);
    const invoices = e.invoices.filter(i => inRange(i.date));
    // an expense without a supplier that a partner paid from own money: Zoho would record it as paid from the company's bank or
    // cash, so it is not sent (the accountant records it in Zoho against the partner's account). A supplier bill a partner paid is
    // sent as a bill; its payment is not (see below).
    // From the new types' start date these go too: a bill without a supplier paid by a partner / an employee (as an expense or a
    // sundry-supplier bill paid through the partner's account / 2260), and the payment of a supplier bill a partner / an employee paid.
    const partnerPaid = new Set(e.payments.filter(p => p.method === 'partner' || p.method === 'employee').map(p => p.bill_id));   // (also an employee's approved expense claim)
    const bills = e.bills.filter(b => inRange(b.date) && !(!b.party_id && partnerPaid.has(b.id) && !isV2(b.date)));
    const payments = e.payments.filter(p => inRange(p.date) && !(p.method === 'cheque' && p.cheque_status === 'bounced') && ((p.method !== 'partner' && p.method !== 'employee') || (isV2(p.date) && p.bill_id)) && !(p.employee_id && p.method !== 'petty' && !p.bill_id));   // a reimbursement (employee, no bill) goes as a journal
    return { e, invoices, bills, payments };
  }
  const invoiceDoc = (i, e) => ({
    type: i.kind === 'credit_note' ? 'creditnote' : 'invoice', number: i.number, date: i.date, due: i.due_date || '', client_id: i.client_id, place: PLACE[i.emirate] || 'DU', project: i.project_name || '',
    original: i.original_id ? (e.invoices.find(o => o.id === i.original_id) || {}).number || '' : '',
    notes: [i.project_name && `Project: ${i.project_name}`, i.retention > 0 && `Retention ${i.retention_pct}% = ${i.retention.toFixed(2)} AED (held by client)`, i.notes].filter(Boolean).join('\n'),
    // adv: an advance invoice (or its credit note) and the "less: advance recovery" line of a progress invoice belong to 2400
    lines: (i.items || []).map(x => ({ name: String(x.description || '-'), quantity: +x.qty || 0, rate: +x.rate || 0, tax: x.vat === 'zero' || x.vat === 'exempt' ? x.vat : (+i.vat_pct || 0) > 0 ? 'std' : 'zero',
      adv: i.kind === 'advance' || i.orig_kind === 'advance' || ctx.C.isRecovery(x) })),
    voided: !!i.voided, total: Math.abs(i.total),
  });
  const billDoc = (b, e) => {
    const pay = e.payments.find(p => p.kind === 'out' && p.bill_id === b.id);
    // from the new start date, a bill without a supplier is a Zoho expense only when one payment paid it in full on its own date
    // (then the expense equals the bill + its payment); otherwise it is a bill from the "sundry suppliers" contact and its payments
    // follow as vendor payments, so the dates and accounts in Zoho are those of Trigon
    const pays = e.payments.filter(p => p.kind === 'out' && p.bill_id === b.id && p.cheque_status !== 'bounced' && !(p.method === 'cheque' && p.cheque_status === 'pending'));
    // a bill already sent the old way (an expense paid from the first bank / cash account) keeps that treatment: history is not rewritten
    const sent = rec('bill', b.id), legacy = !!(sent && sent.zoho_id && sent.zoho_type === 'expense');
    const v2 = !b.party_id && isV2(b.date) && !legacy, sameDay = pays.length === 1 && pays[0].date === b.date && Math.abs(pays[0].amount - b.total) < 0.005;
    return { type: b.party_id ? 'bill' : v2 ? (sameDay ? 'expense2' : 'sundry') : 'expense', v2, pay: v2 && sameDay ? pays[0] : null, number: b.reference || `TRG-B${b.id}`, date: b.date, party_id: b.party_id, place: PLACE[(e.projects[b.project_id] || {}).emirate] || 'DU',
      project: b.project_name || '', category: b.category || '', description: b.description || CAT[b.category] || 'Expense', amount: round(b.amount), vat: round(b.vat_amount), total: b.total,
      notes: [b.project_name && `Project: ${b.project_name}`, b.category && `Category: ${CAT[b.category] || b.category}`].filter(Boolean).join('\n'),
      cash: pay ? ['cash', 'petty'].includes(pay.method) : true };
  };
  const payHash = d => hashOf([d.amount, d.date, d.inbound, d.inv ? 'i' + d.inv.id : d.bill ? 'b' + d.bill.id : '']);
  const payDoc = (p, e) => {
    const inv = p.invoice_id ? e.invoices.find(i => i.id === p.invoice_id) : null, bill = p.bill_id ? e.bills.find(b => b.id === p.bill_id) : null;
    const v2 = isV2(p.date);
    return { inbound: p.kind === 'in', amount: round(p.amount), date: p.method === 'cheque' && p.cheque_date && (!v2 || p.cheque_date > p.date) ? p.cheque_date : p.date, mode: MODE[p.method] || 'banktransfer', inv, bill,
      memo: [p.reference, inv && inv.number, bill && (bill.reference || bill.description), p.is_retention ? 'retention release' : '', p.method === 'cheque' && p.cheque_date ? `cheque ${p.cheque_date}` : ''].filter(Boolean).join(' · ') || `TRG-PAY${p.id}`,
      party_id: inv ? inv.client_id : bill ? bill.party_id : null, cash: ['cash', 'petty'].includes(p.method), v2 };
  };

  // ---------- push ----------
  const EXPENSE_TYPES = ['cost_of_goods_sold', 'expense', 'other_expense'];
  async function lookups(cl) {
    const taxes = (await cl.get('/settings/taxes')).taxes || [];
    const banks = ((await cl.get('/bankaccounts')).bankaccounts || []).filter(a => a.is_active !== false && a.status !== 'inactive');
    const coa = ((await cl.get('/chartofaccounts', { filter_by: 'AccountType.Active' })).chartofaccounts || []);
    const tax = (pct, re) => taxes.find(t => +t.tax_percentage === pct && t.tax_type !== 'tax_group' && (!re || re.test(t.tax_name || '')));
    const expense = coa.filter(a => EXPENSE_TYPES.includes(a.account_type));
    return { taxes, std: tax(5), zero: tax(0, /zero/i), exempt: tax(0, /exempt/i), bank: banks.find(a => a.account_type === 'bank'), cash: banks.find(a => a.account_type === 'cash'), ar: coa.find(a => a.account_type === 'accounts_receivable'), ap: coa.find(a => a.account_type === 'accounts_payable'), retention: coa.find(a => /retention/i.test(a.account_name || '') && /asset/.test(a.account_type || '')),
      coa: [...coa, ...banks], expense, assets: coa.filter(a => a.account_type === 'fixed_asset'), cogs: expense.find(a => /^cost of goods sold$/i.test(a.account_name || '')) || expense.find(a => a.account_type === 'cost_of_goods_sold') || expense[0] };   // the standard account, not another COGS account (e.g. site salaries)
  }
  const taxOf = (lk, k) => (k === 'std' ? lk.std : k === 'zero' ? lk.zero : k === 'exempt' ? lk.exempt : null);
  // expense account for a bill category: an account whose name contains the category (e.g. "Materials"), else Cost of Goods Sold
  const accountFor = (lk, category) => {
    const code = ctx.expenseCode ? ctx.expenseCode(category) : category, name = `Expense category — ${CAT[category] || category || 'Other'}`;
    const m = mapOf('account', 'cat:' + category); if (m) { useAcct(code, name, m, 'mapped'); return { account_id: m }; }
    if (category === 'asset' && lk.assets[0]) { useAcct(code, name, lk.assets[0].account_id, 'automatic (first fixed-asset account)'); return lk.assets[0]; }
    const label = (CAT[category] || '').toLowerCase();
    const hit = label && lk.expense.find(a => String(a.account_name || '').toLowerCase().includes(label));
    if (hit) { useAcct(code, name, hit.account_id, 'automatic (name contains the category)'); return hit; }
    useAcct(code, name, lk.cogs && lk.cogs.account_id, lk.cogs ? 'fallback (Cost of Goods Sold)' : 'missing'); return lk.cogs;
  };
  async function test() {
    const c = cfg(), cl = client(c);
    const orgs = (await cl.get('/organizations')).organizations || [], org = orgs.find(o => String(o.organization_id) === String(c.org));
    if (!org) throw new Error('The chosen organisation is not in this Zoho account any more — connect again');
    const lk = await lookups(cl), missing = [];
    if (!lk.std) missing.push('5% VAT tax (needed only once VAT-registered)'); if (!lk.bank && !lk.cash) missing.push('bank or cash account'); if (!lk.cogs) missing.push('expense account');
    return { ok: true, org: org.name, currency: org.currency_code, lookups: { tax: lk.std && lk.std.tax_name, zero: lk.zero && lk.zero.tax_name, exempt: lk.exempt && lk.exempt.tax_name,
      bank: lk.bank && lk.bank.account_name, cash: lk.cash && lk.cash.account_name, expense: lk.cogs && lk.cogs.account_name }, missing };
  }

  async function contactId(cl, partyId, run) {
    const p = run.e.parties[partyId]; if (!p) throw new Error('contact not found');
    const vals = { contact_name: p.name, company_name: p.name, contact_type: p.type === 'client' ? 'customer' : 'vendor', tax_treatment: p.trn ? 'vat_registered' : 'vat_not_registered',
      ...(p.trn ? { tax_reg_no: p.trn } : {}), billing_address: { address: p.address || '' }, notes: [`Trigon ERP TRG-P${p.id}`, p.notes].filter(Boolean).join('\n') };
    const person = p.email || p.phone ? { first_name: p.name.slice(0, 100), email: p.email || '', phone: p.phone || '', is_primary_contact: true } : null;
    const h = hashOf([vals, person]), r = rec('contact', p.id);
    if (r && ['ok', 'error'].includes(r.status) && r.zoho_id) {
      if (r.hash === h && r.status === 'ok') { note('contact', p.id, p.name, 'unchanged', 'already in Zoho'); return r.zoho_id; }
      try {
        const cp = (((await cl.get('/contacts/' + r.zoho_id)).contact || {}).contact_persons || [])[0];        // update the existing person instead of adding another
        await cl.put('/contacts/' + r.zoho_id, { ...vals, ...(person ? { contact_persons: [{ ...(cp ? { contact_person_id: cp.contact_person_id } : {}), ...person }] } : {}) });
        mark('contact', p.id, r.zoho_id, 'contact', 'ok', null, h); note('contact', p.id, p.name, 'update', 'changed here since it was sent'); run.updated++; return r.zoho_id;
      } catch (e) { if (!gone(e)) throw e; }                                          // deleted in Zoho → create it again below
    }
    const found = ((await cl.get('/contacts', { contact_name: p.name })).contacts || []).find(x => x.contact_name === p.name);
    const id = found ? found.contact_id : (await cl.post('/contacts', { ...vals, contact_persons: person ? [person] : [] })).contact.contact_id;
    if (found) await cl.put('/contacts/' + id, vals);
    note('contact', p.id, p.name, found ? 'link' : 'create', found ? 'a Zoho contact with the same name exists but is not in the send log — it would be linked (and updated), not created again' : '');
    mark('contact', p.id, id, 'contact', 'ok', null, h); run.sent++; return id;
  }

  // the contact for bills without a supplier (new types): one "Sundry suppliers" vendor, created once and remembered in the mapping
  async function sundryId(cl, run) {
    const m = mapOf('contact', 'sundry'); if (m) return m;
    const name = 'Sundry suppliers (Trigon ERP)';
    const found = ((await cl.get('/contacts', { contact_name: name })).contacts || []).find(x => x.contact_name === name);
    const id = found ? found.contact_id : (await cl.post('/contacts', { contact_name: name, company_name: name, contact_type: 'vendor', tax_treatment: 'vat_not_registered', notes: 'Expenses entered in Trigon ERP without a supplier' })).contact.contact_id;
    note('contact', 0, name, found ? 'link' : 'create', found ? 'the sundry suppliers contact already exists in Zoho — it would be used' : 'one vendor for bills entered without a supplier');
    if (!dry) db.prepare('INSERT INTO zoho_map(kind,local_key,zoho_id,label) VALUES(?,?,?,?) ON CONFLICT(kind,local_key) DO UPDATE SET zoho_id=excluded.zoho_id').run('contact', 'sundry', String(id), name);
    if (!found) run.sent++;
    return id;
  }

  const DOC = {
    invoice: { path: '/invoices', key: 'invoice', id: 'invoice_id', num: 'invoice_number', post: 'sent' },
    creditnote: { path: '/creditnotes', key: 'creditnote', id: 'creditnote_id', num: 'creditnote_number', post: 'open' },
    bill: { path: '/bills', key: 'bill', id: 'bill_id', num: 'bill_number', post: 'open' },
    expense: { path: '/expenses', key: 'expense', id: 'expense_id' },
    expense2: { path: '/expenses', key: 'expense', id: 'expense_id' },                  // an expense paid through the account that paid it (new types)
  };
  const LOCKED = ['paid', 'partially_paid', 'closed'];                                  // money has been applied in Zoho → never overwrite
  const lineItems = (lines, lk, pid, adv) => lines.map(l => { const t = taxOf(lk, l.tax); return { name: l.name.slice(0, 100), description: l.name.length > 100 ? l.name : '', quantity: l.quantity, rate: l.rate, ...(t ? { tax_id: t.tax_id } : {}), ...(adv && l.adv ? { account_id: adv } : {}), ...projectRef(pid) }; });

  // read-back after a send (new mode): what Zoho holds must be what was sent, else the record is blocked for review
  async function verifySent(cl, kind, localId, type, path, key, id, sent, lk) {
    if (dry || !newMode()) return;
    const got = effect(type, (await cl.get(`${path}/${id}`))[key], lk), res = compareEff(sent, got);
    if (res !== 'MATCH') throw blocked('VERIFY_MISMATCH', `read back from Zoho: ${res.toLowerCase().replace('_', ' ')} — check it in Zoho`);
    db.prepare('UPDATE zoho_sync SET verified_at=? WHERE kind=? AND local_id=?').run(now(), kind, localId);
  }
  async function pushDoc(cl, kind, localId, type, vals, { voided, find, label }, run) {
    const t = DOC[type], h = hashOf(vals), r = rec(kind, localId), q = t.num ? { ignore_auto_number_generation: 'true' } : undefined, lk = run.lk, eff = sentEff(type, vals, lk);
    if (dry) dry.vals.set(kind + ':' + localId, { type, eff });
    if (voided) {                                                                     // cancelled here → void there (if it was sent)
      if (!r || !r.zoho_id) { note(kind, localId, label, 'skip', 'void here, never sent'); mark(kind, localId, null, type, 'skipped', 'void — not sent', h); run.skipped++; return; }
      if (r.status === 'cancelled') { note(kind, localId, label, 'unchanged', 'already void in Zoho'); return; }
      guardPeriod(r.doc_date || vals.date, label);
      if (r.sent_eff) { let cur = null; try { cur = (await cl.get(`${t.path}/${r.zoho_id}`))[t.key]; } catch (e) { if (!gone(e)) throw e; } if (modifiedInZoho(r, type, cur, lk)) throw blocked('ZOHO_MODIFIED', `${label} was changed in Zoho after Trigon sent it — not voided automatically`); }
      await cl.post(`${t.path}/${r.zoho_id}/status/void`); note(kind, localId, label, 'void', 'void here — would be voided in Zoho'); mark(kind, localId, r.zoho_id, type, 'cancelled', null, h); run.updated++; return;
    }
    let again = false;
    if (r && r.zoho_id && ['ok', 'changed', 'error', 'retrying'].includes(r.status)) {     // 'error' with a Zoho id: it IS there (a later update failed) → update it, never post a second one
      if (r.zoho_type && r.zoho_type !== type) { note(kind, localId, label, 'conflict', 'changed between bill and expense after it was sent'); if (r.status !== 'changed') { mark(kind, localId, r.zoho_id, null, 'changed', `${label} changed between bill and expense after it was sent — fix it in Zoho`, null); run.failed++; } return; }
      if (r.hash === h && r.status === 'ok') { note(kind, localId, label, 'unchanged', 'already in Zoho'); return; }
      let cur = null; try { cur = (await cl.get(`${t.path}/${r.zoho_id}`))[t.key]; } catch (e) { if (!gone(e)) throw e; }
      if (cur && r.hash === h) { note(kind, localId, label, 'unchanged', 'already in Zoho (an earlier error is cleared)'); mark(kind, localId, r.zoho_id, type, 'ok', null, h); return; }          // unchanged since it was sent: only the error flag is cleared
      if (cur && !LOCKED.includes(cur.status)) {
        guardPeriod(r.doc_date, label); guardPeriod(vals.date, label);
        if (modifiedInZoho(r, type, cur, lk)) { note(kind, localId, label, 'conflict', 'changed in Zoho after Trigon sent it — not overwritten'); throw blocked('ZOHO_MODIFIED', `${label} was changed in Zoho after Trigon sent it — not overwritten (review it in Zoho, then retry)`); }
        await cl.put(`${t.path}/${r.zoho_id}`, vals, q); note(kind, localId, label, 'update', `changed here; ${cur.status} in Zoho`); mark(kind, localId, r.zoho_id, type, 'ok', null, h, { date: vals.date, eff }); run.updated++;
        return verifySent(cl, kind, localId, type, t.path, t.key, r.zoho_id, eff, lk);
      }
      if (cur) { note(kind, localId, label, 'conflict', `edited here after it was ${cur.status} in Zoho — correct it in Zoho or issue a credit note`); if (r.status !== 'changed') { mark(kind, localId, r.zoho_id, type, 'changed', 'edited here after it was paid in Zoho — correct it in Zoho or issue a credit note', null); run.failed++; } return; }
      again = true;                                                                    // deleted in Zoho → send it again
    }
    guardPeriod(vals.date, label);
    let id = null;
    let hitStatus = '';
    if (find) { const hit = ((await cl.get(t.path, find))[t.key + 's'] || []).find(x => x[t.num] === vals[t.num]); if (hit) { id = hit[t.id]; hitStatus = hit.status; } }
    else if (r && r.pending_create && vals.reference_number) {                          // an earlier create may have reached Zoho: look for it
      const hits = ((await cl.get(t.path, { reference_number: vals.reference_number }))[t.key + 's'] || []).filter(x => x.reference_number === vals.reference_number && x.date === vals.date);
      if (hits.length > 1) throw blocked('POSSIBLE_DUPLICATE', `${hits.length} ${t.key}s with reference ${vals.reference_number} on ${vals.date} in Zoho — check them`);
      if (hits.length) { id = hits[0][t.id]; hitStatus = hits[0].status; }
    }
    if (id && r && r.pending_create && t.post && hitStatus === 'draft' && cfg().post === '1') await cl.post(`${t.path}/${id}/status/${t.post}`);   // our own lost create: finish it as a fresh one
    note(kind, localId, label, id ? 'link' : 'create', id ? `${vals[t.num] || vals.reference_number} already exists in Zoho but is not in the send log — it would be linked, not created again (check that it is the same document)` : again ? 'deleted in Zoho — would be sent again' : '');
    if (!id) {
      pendingCreate(kind, localId, type, vals.date);
      id = (await cl.post(t.path, vals, q))[t.key][t.id];
      mark(kind, localId, id, type, 'ok', null, h, { date: vals.date, eff });           // the Zoho id is kept at once
      if (t.post && cfg().post === '1') await cl.post(`${t.path}/${id}/status/${t.post}`);
    }
    mark(kind, localId, id, type, 'ok', null, h, { date: vals.date, eff }); run.sent++;
    return verifySent(cl, kind, localId, type, t.path, t.key, id, eff, lk);
  }

  async function pushPayment(cl, p, lk, run) {
    const r = rec('payment', p.id), label = `${p.kind === 'in' ? 'receipt' : 'payment'} ${p.reference || '#' + p.id}`;
    if (dry && r && r.zoho_id) { const d0 = payDoc(p, run.e); dry.vals.set('payment:' + p.id, { type: r.zoho_type, eff: { date: d0.date, total: d0.amount, lines: [[d0.amount, '', '']] } }); }
    if (r && (['ok', 'skipped', 'included'].includes(r.status) || (['error', 'retrying'].includes(r.status) && r.zoho_id))) { note('payment', p.id, label, r.status === 'ok' || r.zoho_id ? 'unchanged' : 'skip', r.status === 'ok' || r.zoho_id ? 'already in Zoho' : r.error || r.status); return; }   // already in Zoho (a payment is never posted twice)
    if (p.method === 'cheque' && p.cheque_status === 'pending') { note('payment', p.id, label, 'skip', 'post-dated cheque — sent once it clears'); return; }   // post-dated cheque: sent once it clears
    const d = payDoc(p, run.e), skip = why => { note('payment', p.id, label, 'skip', why); mark('payment', p.id, null, null, 'skipped', why, null); run.skipped++; };
    if (p.method === 'offset') return skip('offset against another balance — record it in Zoho directly');
    const sundry = d.bill && !d.bill.party_id && (rec('bill', d.bill.id) || {}).zoho_type === 'bill';   // a bill without a supplier sent as a sundry-supplier bill
    if (d.bill && !d.bill.party_id && !sundry) { note('payment', p.id, label, 'skip', 'paid expense — part of the Zoho expense'); return void mark('payment', p.id, null, 'expense', 'included', 'paid expense — already in Zoho as an expense', null); }
    if (!d.inv && !d.bill) return skip('not linked to an invoice or bill — record it in Zoho directly');
    const docRec = rec(d.inv ? 'invoice' : 'bill', (d.inv || d.bill).id);
    if (docRec && docRec.zoho_type === 'creditnote') return skip('refund of a credit note — record it in Zoho as a credit note refund');
    const docVat = d.inv ? Math.abs(d.inv.vat || 0) : d.bill ? Math.abs(d.bill.vat_amount || 0) : 0;
    if (newMode() && !(docRec && docRec.zoho_id) && ((docRec && docRec.status === 'held') || (docVat > 0.004 && (vatPending() || !lk.std)))) throw held('VAT_PENDING', `its ${d.inv ? 'invoice' : 'bill'} carries VAT and is held while VAT is not configured in Zoho — the payment follows it`);
    if (!docRec || !docRec.zoho_id || !['ok', 'changed'].includes(docRec.status)) throw new Error(`its ${d.inv ? 'invoice' : 'bill'} is not in Zoho yet`);
    const t = DOC[docRec.zoho_type], doc = (await cl.get(`${t.path}/${docRec.zoho_id}`))[t.key];
    if (doc.status === 'void') throw new Error(`its ${t.key} is void in Zoho`);
    if (doc.status === 'draft') await cl.post(`${t.path}/${docRec.zoho_id}/status/${t.post}`);   // a paid document is no longer a draft
    const apply = round(Math.min(d.amount, +doc.balance || 0)), contact = sundry ? await sundryId(cl, run) : await contactId(cl, d.party_id, run);
    let acct;
    if (d.v2 && ctx.payAccount) acct = { account_id: zAcct(ctx.payAccount(p, p.kind), lk, p.partner_id) };   // the same account as Trigon's ledger (bank, cash, 1010, 1030, 2260, the partner's account…)
    else {
      const mapped = !d.cash && ctx.bankCode && mapOf('account', 'acct:' + ctx.bankCode(p.bank_account_id));   // several bank accounts: each mapped to its Zoho bank
      acct = mapped ? { account_id: mapped } : d.cash ? (lk.cash || lk.bank) : (lk.bank || lk.cash);
      const pcode = d.cash ? (p.method === 'petty' ? (p.employee_id ? '1030' : '1010') : '1020') : ctx.bankCode ? ctx.bankCode(p.bank_account_id) : '1000';
      useAcct(pcode, d.cash ? (p.method === 'petty' ? 'Petty cash' : 'Cash on hand') : 'Bank', acct && acct.account_id, mapped ? 'mapped' : acct ? `automatic (first Zoho ${d.cash && lk.cash ? 'cash' : 'bank'} account)` : 'missing');
    }
    const ref = String(p.reference || '').slice(0, 100), ztype = d.inbound ? 'customerpayment' : 'vendorpayment', path = d.inbound ? '/customerpayments' : '/vendorpayments', party = d.inbound ? 'customer_id' : 'vendor_id';
    guardPeriod(d.date, label);
    const vals = d.inbound
      ? { customer_id: contact, payment_mode: d.mode, amount: d.amount, date: d.date, reference_number: ref, description: d.memo, ...(acct ? { account_id: acct.account_id } : {}), invoices: apply > 0 ? [{ invoice_id: docRec.zoho_id, amount_applied: apply }] : [] }
      : { vendor_id: contact, payment_mode: d.mode, amount: d.amount, date: d.date, reference_number: ref, description: d.memo, ...(acct ? { paid_through_account_id: acct.account_id } : {}), bills: apply > 0 ? [{ bill_id: docRec.zoho_id, amount_applied: apply }] : [] };
    const eff = sentEff(ztype, vals, lk);
    let id = null;
    if (r && r.pending_create) {                                                       // an earlier send may have reached Zoho: same contact, date and amount
      const hits = ((await cl.get(path, { date: d.date }))[path.slice(1)] || []).filter(x => String(x[party]) === String(contact) && Math.abs(+x.amount - d.amount) < 0.005 && x.date === d.date);
      if (hits.length > 1) throw blocked('POSSIBLE_DUPLICATE', `${hits.length} payments of ${d.amount} on ${d.date} for this contact in Zoho — check them`);
      if (hits.length) id = hits[0].payment_id;
    }
    note('payment', p.id, label, id ? 'link' : 'create', `${d.inbound ? 'customer payment' : 'vendor payment'} applied to ${d.inv ? d.inv.number : d.bill.reference || 'bill #' + d.bill.id}${id ? ' — found in Zoho from an earlier attempt, linked' : ''}`);
    if (!id) {
      pendingCreate('payment', p.id, ztype, d.date);
      id = d.inbound ? (await cl.post(path, vals)).payment.payment_id : (await cl.post(path, vals)).vendorpayment.payment_id;
    }
    mark('payment', p.id, id, ztype, 'ok', null, payHash(d), { date: d.date, eff }); run.sent++;
    return verifySent(cl, 'payment', p.id, ztype, path, d.inbound ? 'payment' : 'vendorpayment', id, eff, lk);
  }

  // ---------- manual journals: payroll by project, salaries paid, end-of-service provision / settlement, salary advances, retention ----------
  const ym = m => +m.replace('-', ''), mEnd = m => `${m}-${String(ctx.C.daysInMonth(m)).padStart(2, '0')}`;
  const has = t => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  // a payroll row's cost by project: the attendance split when there is one, else its own project (null = head office)
  // a payroll row's cost by project: the one allocation engine (modules/payroll2.js), shared with Trigon's ledger and project costs
  const split = r => (ctx.payrollSplit ? ctx.payrollSplit(r) : [{ project_id: r.project_id || null, amount: r.gross }]);
  function journals(from, to) {
    const out = [], inR = d => (!from || d >= from) && (!to || d <= to), add = (byProj, acctProj, acctHq, dc, desc) => Object.entries(byProj).map(([p, a]) => ({ acct: p === 'null' ? acctHq : acctProj, dc, amount: round(a), project_id: p === 'null' ? null : +p, desc }));
    const months = db.prepare("SELECT month, MAX(paid_date) paid, SUM(paid_date IS NULL) unpaid FROM payroll WHERE status='final' GROUP BY month").all();
    for (const m of months) {
      const rows = db.prepare("SELECT * FROM payroll WHERE status='final' AND month=?").all(m.month), cost = {};
      for (const r of rows) for (const s of split(r)) cost[s.project_id] = (cost[s.project_id] || 0) + s.amount;
      const net = round(rows.reduce((s, r) => s + r.net, 0)), ded = round(rows.reduce((s, r) => s + r.deductions, 0));
      const loan = has('loan_repayments') ? round(db.prepare(`SELECT COALESCE(SUM(amount),0) a FROM loan_repayments WHERE payroll_id IN (${rows.map(() => '?').join(',')})`).get(...rows.map(r => r.id)).a) : 0;
      if (inR(mEnd(m.month))) out.push({ kind: 'jv_payroll', local_id: ym(m.month), date: mEnd(m.month), ref: `PAY-${m.month}`, notes: `Payroll ${m.month} (Trigon ERP) — ${rows.length} employees`,
        lines: [...add(cost, 5200, 6200, 'debit', `Salaries ${m.month}`), { acct: 2200, dc: 'credit', amount: net, desc: 'Net salaries payable (WPS)' }, { acct: 2250, dc: 'credit', amount: round(ded - loan), desc: 'Deductions' }, { acct: 1300, dc: 'credit', amount: loan, desc: 'Advance instalments' }] });
      const sentWhole = (rec('jv_paypaid', ym(m.month)) || {}).zoho_id;               // a month already sent as one journal keeps it
      if (!sentWhole && v2From()) {                                                    // new types: one journal per payment date, like the ledger (a held salary does not hold the month back)
        for (const g of db.prepare("SELECT paid_date d, SUM(net) n FROM payroll WHERE status='final' AND month=? AND paid_date IS NOT NULL GROUP BY paid_date").all(m.month)) {
          if (!isV2(g.d) || !inR(g.d)) continue;
          out.push({ kind: 'jv_paypaid_d', local_id: ym(m.month) * 10000 + +g.d.slice(5, 7) * 100 + +g.d.slice(8, 10), date: g.d, ref: `PAY-${m.month}-${g.d}`, notes: `Salaries ${m.month} paid on ${g.d}`, codes: true,
            lines: [{ acct: '2200', dc: 'debit', amount: round(g.n), desc: 'Salaries paid' }, { acct: '1000', dc: 'credit', amount: round(g.n), desc: 'WPS transfer' }] });
        }
        continue;
      }
      if (!m.unpaid && m.paid && inR(m.paid)) out.push({ kind: 'jv_paypaid', local_id: ym(m.month), date: m.paid, ref: `PAY-${m.month}`, notes: `Salaries paid ${m.month} by WPS`,
        lines: [{ acct: 2200, dc: 'debit', amount: net, desc: 'Salaries paid' }, { acct: 'bank', dc: 'credit', amount: net, desc: 'WPS transfer' }] });
    }
    if (has('eos_provisions')) {
      for (const m of db.prepare('SELECT DISTINCT month FROM eos_provisions').all()) {
        if (!inR(mEnd(m.month))) continue;
        const byProj = {}; let total = 0;
        for (const v of db.prepare('SELECT * FROM eos_provisions WHERE month=?').all(m.month)) {
          total += v.amount; const r = db.prepare("SELECT * FROM payroll WHERE month=? AND employee_id=? AND status='final'").get(m.month, v.employee_id);
          const parts = r ? split(r) : [{ project_id: null, amount: 1 }], sum = parts.reduce((s, p) => s + p.amount, 0) || 1;
          for (const p of parts) byProj[p.project_id] = (byProj[p.project_id] || 0) + v.amount * p.amount / sum;
        }
        // the project shares are rounded one by one: the cent left over goes to the largest share, so the journal balances
        const shares = add(byProj, 5260, 5260, 'debit', 'End-of-service provision'), cent = round(round(total) - shares.reduce((s, l) => s + l.amount, 0));
        if (cent && shares.length) { const big = shares.reduce((x, l) => (l.amount > x.amount ? l : x)); big.amount = round(big.amount + cent); }
        out.push({ kind: 'jv_eos', local_id: ym(m.month), date: mEnd(m.month), ref: `EOS-${m.month}`, notes: `End-of-service provision ${m.month}`,
          lines: [...shares, { acct: 2300, dc: 'credit', amount: round(total), desc: 'End-of-service provision' }] });
      }
      for (const s of db.prepare('SELECT s.*, e.name, e.project_id FROM eos_settlements s JOIN employees e ON e.id=s.employee_id').all()) {
        if (!inR(s.date)) continue; const diff = round(s.gratuity - s.provision);
        out.push({ kind: 'jv_eos_set', local_id: s.employee_id, date: s.date, ref: `EOS-SET-${s.employee_id}`, notes: `End-of-service settlement — ${s.name}`,
          lines: [{ acct: 2300, dc: 'debit', amount: s.provision, desc: 'Provision used' }, { acct: 2200, dc: 'credit', amount: s.gratuity, desc: 'Gratuity payable' }, { acct: 5260, dc: diff > 0 ? 'debit' : 'credit', amount: Math.abs(diff), project_id: s.project_id || null, desc: diff > 0 ? 'Gratuity above the provision' : 'Provision released' }] });
      }
    }
    // retention: the invoice goes at full value, then the retained part moves from the client's receivable to 1150; a release receipt moves it back
    const { e: E, invoices, payments } = data(from, to);
    for (const i of invoices) if (i.kind !== 'credit_note' && (i.retention > 0.004 || i.voided))          // a void invoice: removes a journal sent earlier
      out.push({ kind: 'jv_retention', local_id: i.id, date: i.date, ref: `RET-${i.number}`, notes: `Retention ${i.retention_pct}% held on ${i.number}${i.project_name ? ' — ' + i.project_name : ''}`, voided: !!i.voided, invoice: i.id,
        lines: [{ acct: 1150, dc: 'debit', amount: i.retention, project_id: i.project_id || null, desc: `Retention on ${i.number}` }, { acct: 'ar', customer: i.client_id, dc: 'credit', amount: i.retention, desc: `Retention on ${i.number}` }] });
    for (const p of payments) {
      if (p.kind !== 'in' || !p.is_retention || !p.invoice_id || (p.method === 'cheque' && p.cheque_status === 'pending')) continue;
      const d = payDoc(p, E); if (!d.inv) continue;
      out.push({ kind: 'jv_ret_release', local_id: p.id, date: d.date, ref: `RET-REL-${d.inv.number}`, notes: `Retention released on ${d.inv.number}`,
        lines: [{ acct: 'ar', customer: d.inv.client_id, dc: 'debit', amount: round(p.amount), desc: 'Retention released' }, { acct: 1150, dc: 'credit', amount: round(p.amount), project_id: d.inv.project_id || null, desc: 'Retention released' }] });
    }
    out.push(...ledgerJournals(from, to));
    if (has('loans')) for (const l of db.prepare('SELECT l.*, e.name FROM loans l JOIN employees e ON e.id=l.employee_id').all()) {
      const d = l.created.slice(0, 10); if (!inR(d)) continue;
      out.push({ kind: 'jv_advance', local_id: l.id, date: d, ref: `ADV-${l.id}`, notes: `Salary advance — ${l.name} (${l.installments} instalments)`,
        lines: [{ acct: 1300, dc: 'debit', amount: l.amount, desc: 'Salary advance' }, { acct: l.method === 'cash' ? 'cash' : 'bank', dc: 'credit', amount: l.amount, desc: l.method === 'cash' ? 'Paid in cash' : 'Paid by bank' }] });
    }
    return out;
  }
  // ---------- new types: movements that only touch the ledger, sent as balanced journals with Trigon's own account codes ----------
  // (codes: true — each line is resolved with zAcct, per partner for 3000 / 2500 / 3110). Only records dated from start_v2.
  const V2_KINDS = ['jv_petty', 'jv_reimb', 'jv_partner', 'jv_palloc', 'jv_dep', 'jv_asset', 'jv_pdc', 'jv_pdc_clr'];
  const dcLines = (lines, partner) => lines.flatMap(([acct, dr, cr]) => [...(dr > 0.004 ? [{ acct, dc: 'debit', amount: round(dr), partner }] : []), ...(cr > 0.004 ? [{ acct, dc: 'credit', amount: round(cr), partner }] : [])]);
  function ledgerJournals(from, to, all = false) {
    const out = [], inR = d => isV2(d) && (all || ((!from || d >= from) && (!to || d <= to)));
    if (!v2From()) return out;
    // petty cash: the office float (1010) and petty cash held by employees (1030) — hand-over / top-up and return
    if (has('petty_topups')) for (const t of db.prepare('SELECT * FROM petty_topups').all()) {
      if (!inR(t.date)) continue;
      const src = t.method === 'cash' ? '1020' : ctx.bankCode ? ctx.bankCode(t.bank_account_id) : '1000', acc = t.employee_id ? '1030' : '1010', ret = t.kind === 'return';
      out.push({ kind: 'jv_petty', local_id: t.id, date: t.date, ref: `PETTY-${t.id}`, notes: `Petty cash ${ret ? 'returned' : t.employee_id ? 'handed over to an employee' : 'top-up'}${t.note ? ' — ' + t.note : ''}`, codes: true,
        lines: dcLines(ret ? [[src, t.amount, 0], [acc, 0, t.amount]] : [[acc, t.amount, 0], [src, 0, t.amount]]) });
    }
    // expense claims reimbursed to an employee (a payment with the employee and no bill): Dr 2260 / Cr the account that paid
    const e = enrich();
    for (const p of e.payments) {
      if (!(p.kind === 'out' && p.employee_id && !p.bill_id) || !inR(p.date)) continue;
      out.push({ kind: 'jv_reimb', local_id: p.id, date: p.date, ref: `REIMB-${p.id}`, notes: `Expense claims reimbursed${p.reference ? ' — ' + p.reference : ''}`, codes: true, voided: p.cheque_status === 'bounced',
        lines: dcLines([['2260', p.amount, 0], [ctx.pdcTwoStep && ctx.pdcTwoStep(p) ? '2050' : ctx.payAccount(p, 'out'), 0, p.amount]]) });
    }
    // post-dated cheques (Trigon's ledger rules): into 1050 / 2050 against the customer / supplier on the cheque's date, and out again
    // on the cheque date once cleared (when Zoho also receives the payment itself, applied to the invoice / bill)
    for (const p of e.payments) {
      if (!(ctx.pdcTwoStep && ctx.pdcTwoStep(p)) || !inR(p.date)) continue;
      const inv = p.invoice_id && e.invoices.find(i => i.id === p.invoice_id), bill = p.bill_id && e.bills.find(b => b.id === p.bill_id), cleared = p.cheque_status === 'cleared';
      const reimb = p.kind === 'out' && p.employee_id && !p.bill_id;
      if (!reimb && !(p.kind === 'in' ? inv : bill)) continue;                          // a cheque not linked to a document is not sent to Zoho
      const party = p.kind === 'in' ? { acct: p.is_retention ? '1150' : '1100', customer: p.is_retention ? undefined : inv.client_id } : bill ? { acct: '2000', customer: bill.party_id || undefined, sundry: !bill.party_id } : null;
      const pdc = p.kind === 'in' ? '1050' : '2050', with_ = (l, x) => ({ ...l, ...(x && x.customer ? { customer: x.customer } : {}), ...(x && x.sundry ? { sundry: true } : {}) });
      if (!reimb) out.push({ kind: 'jv_pdc', local_id: p.id, date: p.date, ref: `PDC-${p.id}`, notes: `Post-dated cheque ${p.kind === 'in' ? 'received' : 'issued'}${p.reference ? ' — ' + p.reference : ''} (due ${p.cheque_date})`, codes: true,
        lines: p.kind === 'in' ? [{ acct: pdc, dc: 'debit', amount: round(p.amount) }, with_({ acct: party.acct, dc: 'credit', amount: round(p.amount) }, party)] : [with_({ acct: '2000', dc: 'debit', amount: round(p.amount) }, party), { acct: pdc, dc: 'credit', amount: round(p.amount) }] });
      if (cleared && inR(p.cheque_date)) out.push({ kind: 'jv_pdc_clr', local_id: p.id, date: p.cheque_date, ref: `PDC-CLR-${p.id}`, notes: `Post-dated cheque cleared${p.reference ? ' — ' + p.reference : ''}`, codes: true,
        lines: reimb ? [{ acct: pdc, dc: 'debit', amount: round(p.amount) }, { acct: ctx.payAccount(p, 'out'), dc: 'credit', amount: round(p.amount) }]
          : p.kind === 'in' ? [with_({ acct: party.acct, dc: 'debit', amount: round(p.amount) }, party), { acct: pdc, dc: 'credit', amount: round(p.amount) }] : [{ acct: pdc, dc: 'debit', amount: round(p.amount) }, with_({ acct: '2000', dc: 'credit', amount: round(p.amount) }, party)] });
    }
    // partners: capital, loans, current account, transfers, profit allocation — the ledger's own lines, each partner on his accounts
    for (const x of ctx.partnerEntries ? ctx.partnerEntries() : []) {
      if (!inR(x.date) || !x.partner_id) continue;
      const alloc = x.year != null;
      out.push({ kind: alloc ? 'jv_palloc' : 'jv_partner', local_id: alloc ? x.year * 100000 + x.partner_id : x.txn_id, date: x.date, ref: x.ref, notes: x.memo, codes: true, lines: dcLines(x.lines, x.partner_id) });
    }
    // fixed assets: monthly depreciation, disposal, an asset brought in from before the system
    for (const x of ctx.ledgerEntries ? ctx.ledgerEntries() : []) {
      if (!['depreciation', 'asset'].includes(x.source) || !inR(x.date)) continue;
      const [kind, id] = x.ref.split('-'), lines = dcLines(x.lines.map(l => [l.account, l.debit, l.credit]));
      out.push(kind === 'DEP' ? { kind: 'jv_dep', local_id: +id * 1000000 + +x.date.slice(0, 4) * 100 + +x.date.slice(5, 7), date: x.date, ref: `${x.ref}-${x.date.slice(0, 7)}`, notes: x.memo, codes: true, lines }
        : { kind: 'jv_asset', local_id: +id * 10 + (kind === 'DISP' ? 2 : 1), date: x.date, ref: x.ref, notes: x.memo, codes: true, lines });
    }
    return out;
  }

  async function pushJournal(cl, j, lk, run) {
    const r0 = rec(j.kind, j.local_id);
    if (j.voided) {                                                                   // invoice cancelled here → its retention journal is removed there
      if (!r0 || !r0.zoho_id || r0.status === 'cancelled') { note(j.kind, j.local_id, j.ref, 'skip', 'its invoice is void; nothing in Zoho'); return; }
      note(j.kind, j.local_id, j.ref, 'remove', 'its invoice is void here — the journal would be deleted in Zoho');
      guardPeriod(r0.doc_date || j.date, j.ref);
      if (r0.sent_eff) { let cur = null; try { cur = (await cl.get('/journals/' + r0.zoho_id)).journal; } catch (e) { if (!gone(e)) throw e; } if (modifiedInZoho(r0, 'journal', cur, lk)) throw blocked('ZOHO_MODIFIED', `${j.ref} was changed in Zoho after Trigon sent it — not deleted automatically`); }
      try { await cl.del('/journals/' + r0.zoho_id); } catch (e) { if (!gone(e)) throw e; }
      mark(j.kind, j.local_id, r0.zoho_id, 'journal', 'cancelled', null, null); run.updated++; return;
    }
    if (newMode()) {
      const codes = j.lines.filter(l => l.amount > 0.004).map(l => String(l.acct));
      const def = codes.find(c => DEFERRED[c]); if (def) throw held('ACCOUNTING_CHANGE_PENDING', `${j.ref} uses ${def} (${DEFERRED[def]}) — held`);
      if ((vatPending() || !lk.std) && codes.some(c => c === '1200' || c === '2100')) throw held('VAT_PENDING', `${j.ref} moves VAT (1200 / 2100); VAT is not configured in Zoho yet — held`);
    }
    if (j.invoice) { const ir = rec('invoice', j.invoice); if (!ir || ir.status !== 'ok') { note(j.kind, j.local_id, j.ref, 'skip', 'waits until its invoice is in Zoho'); return; } }          // retention follows its invoice: not sent / not updated while the invoice is not in step
    const lines = [];
    for (const l of j.lines.filter(l => l.amount > 0.004)) {
      const acc = j.codes ? zAcct(l.acct, lk, l.partner) : l.acct === 'bank' ? (mapOf('account', 'acct:1000') || (lk.bank || {}).account_id) : l.acct === 'cash' ? (mapOf('account', 'acct:1020') || (lk.cash || lk.bank || {}).account_id)
        : l.acct === 'ar' ? (mapOf('account', 'acct:1100') || (lk.ar || {}).account_id) : l.acct === 1150 ? (mapOf('account', 'acct:1150') || (lk.retention || {}).account_id) : mapOf('account', 'acct:' + l.acct);
      if (!j.codes) { const code = l.acct === 'bank' ? '1000' : l.acct === 'cash' ? '1020' : l.acct === 'ar' ? '1100' : String(l.acct), mapped = mapOf('account', 'acct:' + code);
        useAcct(code, LEDGER[code] || (code === '1000' ? 'Bank' : code === '1020' ? 'Cash on hand' : code), acc, mapped ? 'mapped' : acc ? 'automatic (Zoho default account of that type)' : 'missing'); }
      if (!acc && !j.codes) throw new Error(`map our account ${l.acct === 'ar' ? '1100 (Accounts receivable)' : l.acct}${LEDGER[l.acct] ? ' (' + LEDGER[l.acct] + ')' : ''} to a Zoho account first`);
      lines.push({ account_id: acc, debit_or_credit: l.dc, amount: round(l.amount), description: l.desc || '', ...(l.customer ? { customer_id: await contactId(cl, l.customer, run) } : l.sundry ? { customer_id: await sundryId(cl, run) } : {}), ...projectRef(l.project_id) });
    }
    const dr = round(lines.reduce((s, l) => s + (l.debit_or_credit === 'debit' ? l.amount : 0), 0)), cr = round(lines.reduce((s, l) => s + (l.debit_or_credit === 'credit' ? l.amount : 0), 0));
    if (Math.abs(dr - cr) > 0.004) throw new Error(`journal not balanced (debit ${dr.toFixed(2)}, credit ${cr.toFixed(2)}) — not sent; report this to the developer`);
    const vals = { journal_date: j.date, reference_number: j.ref.slice(0, 100), notes: j.notes, line_items: lines }, h = hashOf(vals), r = rec(j.kind, j.local_id), eff = sentEff('journal', vals, lk);
    if (dry) dry.vals.set(j.kind + ':' + j.local_id, { type: 'journal', eff });
    if (r && ['ok', 'error', 'retrying'].includes(r.status) && r.zoho_id) {        // also after a failed update: the journal exists there, so it is updated, not posted twice
      if (r.hash === h && r.status === 'ok') { note(j.kind, j.local_id, j.ref, 'unchanged', 'already in Zoho'); return; }
      let cur = null; if (r.sent_eff) try { cur = (await cl.get('/journals/' + r.zoho_id)).journal; } catch (e) { if (!gone(e)) throw e; }
      if (!r.sent_eff || cur) {
        guardPeriod(r.doc_date, j.ref); guardPeriod(j.date, j.ref);
        if (modifiedInZoho(r, 'journal', cur, lk)) { note(j.kind, j.local_id, j.ref, 'conflict', 'changed in Zoho after Trigon sent it — not overwritten'); throw blocked('ZOHO_MODIFIED', `${j.ref} was changed in Zoho after Trigon sent it — not overwritten (review it in Zoho, then retry)`); }
        try { await cl.put('/journals/' + r.zoho_id, vals); note(j.kind, j.local_id, j.ref, 'update', 'changed here since it was sent'); mark(j.kind, j.local_id, r.zoho_id, 'journal', 'ok', null, h, { date: j.date, eff }); run.updated++; return verifySent(cl, j.kind, j.local_id, 'journal', '/journals', 'journal', r.zoho_id, eff, lk); } catch (e) { if (!gone(e)) throw e; }
      }
    }
    guardPeriod(j.date, j.ref);
    let id = null;
    if (r && r.pending_create) {                                                       // an earlier create may have reached Zoho: look for it by reference and date
      const hits = ((await cl.get('/journals', { reference_number: vals.reference_number })).journals || []).filter(x => x.reference_number === vals.reference_number && x.journal_date === j.date);
      if (hits.length > 1) throw blocked('POSSIBLE_DUPLICATE', `${hits.length} journals ${vals.reference_number} on ${j.date} in Zoho — check them`);
      if (hits.length) { id = hits[0].journal_id; if (hits[0].status === 'draft' && cfg().post === '1') await cl.post(`/journals/${id}/status/publish`); }   // our own lost create: finish it as a fresh one
    }
    note(j.kind, j.local_id, j.ref, id ? 'link' : 'create', id ? 'found in Zoho from an earlier attempt — linked, not created again' : '');
    if (!id) {
      pendingCreate(j.kind, j.local_id, 'journal', j.date);
      id = (await cl.post('/journals', vals)).journal.journal_id;
      mark(j.kind, j.local_id, id, 'journal', 'ok', null, h, { date: j.date, eff });     // the Zoho id is kept at once
      if (cfg().post === '1') await cl.post(`/journals/${id}/status/publish`);
    }
    mark(j.kind, j.local_id, id, 'journal', 'ok', null, h, { date: j.date, eff }); run.sent++;
    return verifySent(cl, j.kind, j.local_id, 'journal', '/journals', 'journal', id, eff, lk);
  }

  // dry run: real reads when connected (offline stand-ins otherwise), every write is recorded instead of sent
  function dryClient(c) {
    let real = null; try { real = client(c, true); } catch { /* not connected: offline */ }
    let n = 0; const fake = () => new Proxy({}, { get: (t, k) => (typeof k !== 'string' || k === 'then' || k === 'toJSON' ? undefined : /_id$/.test(k) ? (t[k] ??= 'DRY-' + ++n) : (t[k] ??= fake())) });
    const OFF = { '/settings/taxes': { taxes: [{ tax_id: 'DRY-VAT5', tax_name: 'Standard Rate', tax_percentage: 5, tax_type: 'tax' }, { tax_id: 'DRY-ZERO', tax_name: 'Zero Rate', tax_percentage: 0, tax_type: 'tax' }, { tax_id: 'DRY-EXEMPT', tax_name: 'Exempt', tax_percentage: 0, tax_type: 'tax' }] },
      '/bankaccounts': { bankaccounts: [{ account_id: 'DRY-BANK', account_name: '(bank)', account_type: 'bank' }, { account_id: 'DRY-CASH', account_name: '(cash)', account_type: 'cash' }] },
      '/chartofaccounts': { chartofaccounts: [{ account_id: 'DRY-COGS', account_name: 'Cost of Goods Sold', account_type: 'cost_of_goods_sold' }] } };
    const draft = { status: 'draft', balance: 1e15, contact_persons: [] };
    const get = async (p, q) => {
      if (p.includes('/DRY-')) return { invoice: draft, creditnote: draft, bill: draft, contact: draft, journal: draft };
      if (real) return real.get(p, q);
      return OFF[p] || { [p.slice(1)]: [] };
    };
    const write = method => async (p, body) => { dry.ops.push({ method, path: p.replace(/\/\d{6,}/g, '/:id'), what: body ? (body.invoice_number || body.creditnote_number || body.bill_number || body.reference_number || body.contact_name || body.journal_date || '') : '', amount: body ? (body.amount ?? (body.line_items ? round(body.line_items.reduce((s, l) => s + (l.debit_or_credit === 'credit' ? 0 : (l.amount ?? l.quantity * l.rate)), 0)) : '')) : '', body }); return fake(); };
    return { get, post: write('POST'), put: write('PUT'), del: write('DELETE'), offline: !real };
  }

  // the preflight report of a dry run: which organisation, what is already linked and synced, what would be created / updated /
  // left alone, conflicts and possible duplicates, and how every Trigon account the sync uses resolves in Zoho
  // ---------- the accounts the proposed synchronisation needs (this one, the missing transactions and the ledger alignment) ----------
  // Each Trigon code with the Zoho account types that fit it. Validation is by type and by our mapping, never by a similar name.
  const REQUIRED = [
    ['1000', 'Bank', ['bank'], 'now'], ['1010', 'Petty cash (office float)', ['cash'], 'new types'], ['1020', 'Cash on hand', ['cash'], 'now'],
    ['1030', 'Employee cash custody', ['cash'], 'new types'], ['1050', 'Cheques in hand (post-dated received)', ['other_current_asset'], 'ledger alignment'],
    ['1100', 'Accounts receivable', ['accounts_receivable'], 'now'], ['1150', 'Retention receivable', ['other_current_asset', 'accounts_receivable'], 'now'],
    ['1200', 'VAT input', 'tax', 'now'], ['1300', 'Employee advances', ['other_current_asset'], 'now'],
    ['1600', 'Fixed assets (cost)', ['fixed_asset'], 'new types'], ['1690', 'Accumulated depreciation', ['fixed_asset'], 'new types'],
    ['2000', 'Accounts payable', ['accounts_payable'], 'now'], ['2050', 'Cheques issued (post-dated payable)', ['other_current_liability'], 'ledger alignment'],
    ['2100', 'VAT output', 'tax', 'now'], ['2200', 'Salaries payable', ['other_current_liability'], 'now'], ['2250', 'Payroll deductions payable', ['other_current_liability'], 'now'],
    ['2260', 'Employee expense claims payable', ['other_current_liability'], 'new types'], ['2300', 'End-of-service provision', ['long_term_liability', 'other_liability', 'other_current_liability'], 'now'],
    ['2400', 'Advances from customers', ['other_current_liability'], 'ledger alignment'],
    ['3100', 'Retained earnings', ['equity'], 'new types'], ['3900', 'Opening balance equity', ['equity'], 'new types'],
    ['5200', 'Site labour (payroll cost)', ['cost_of_goods_sold', 'expense'], 'now'], ['6200', 'Head-office salaries', ['expense'], 'now'], ['5260', 'End-of-service expense', ['expense', 'cost_of_goods_sold'], 'now'],
    ['6100', 'Depreciation', ['expense', 'other_expense'], 'new types'], ['6150', 'Gain / loss on disposal of assets', ['other_expense', 'other_income', 'expense'], 'new types'],
  ];
  const PARTNER_REQ = [['3000', 'Capital', 'Partner Capital', ['equity']], ['2500', 'Loan', 'Partner Loans', ['long_term_liability', 'other_liability', 'other_current_liability']], ['3110', 'Current', 'Partner Current Accounts', ['equity']]];
  const AUTO = { 1000: 'bank', 1020: 'cash', 1100: 'accounts_receivable', 2000: 'accounts_payable' };
  const expectTypes = key => { const [, code, p] = String(key).split(':'); if (p) { const r = PARTNER_REQ.find(x => x[0] === code); return r ? r[3] : null; } const r = REQUIRED.find(x => x[0] === code); return r && Array.isArray(r[2]) ? r[2] : null; };   // Zoho's own account of that type, if there is exactly one
  function requiredAccounts(coa, lk, partners) {
    const byId = new Map((coa || []).map(a => [String(a.account_id), a])), mapped = key => mapOf('account', key);
    const view = a => a ? { id: String(a.account_id), name: a.account_name || '', type: a.account_type || '', code: a.account_code || '', parent: a.parent_account_name || '' } : null;
    const check = (key, types, auto) => {
      const m = mapped(key);
      if (m) { const a = byId.get(String(m)); if (!a) return { status: 'not_found', zoho: { id: String(m) }, note: 'mapped to a Zoho account that does not exist in this organisation (or is inactive)' };
        return types.includes(a.account_type) ? { status: 'mapped', zoho: view(a) } : { status: 'type_mismatch', zoho: view(a), note: `Zoho type is ${a.account_type}; expected ${types.join(' or ')}` }; }
      if (auto) { const same = (coa || []).filter(a => a.account_type === auto && a.is_active !== false);
        if (same.length === 1) return { status: 'automatic', zoho: view(same[0]), note: `the only Zoho account of type ${auto}` };
        if (same.length > 1) return { status: 'ambiguous', zoho: null, note: `${same.length} Zoho accounts of type ${auto} — map the right one`, candidates: same.slice(0, 8).map(view) }; }
      return { status: 'missing', zoho: null, note: 'not mapped', candidates: (coa || []).filter(a => types.includes(a.account_type)).slice(0, 8).map(view) };
    };
    const rows = REQUIRED.map(([code, label, types, needed]) => {
      if (types === 'tax') { const t = lk && lk.std; return { code, label, needed, expected: 'Zoho tax 5%', ...(t ? { status: 'mapped', zoho: { id: String(t.tax_id), name: t.tax_name, type: 'tax', code: `${t.tax_percentage}%` } } : { status: 'missing', zoho: null, note: 'no 5% tax in this Zoho organisation' }) }; }
      return { code, label, needed, expected: types.join(' / '), ...check('acct:' + code, types, AUTO[code]) };
    });
    for (const cat of Object.keys(CAT)) { const code = ctx.expenseCode ? ctx.expenseCode(cat) : cat, types = cat === 'asset' ? ['fixed_asset'] : ['cost_of_goods_sold', 'expense'];
      const r = check('cat:' + cat, types); rows.push({ code: `${code} (${cat})`, label: `Expense category — ${CAT[cat]}`, needed: 'now', expected: types.join(' / '), ...r, ...(r.status === 'missing' ? { note: 'not mapped — today the send would pick an account by a similar name or fall back to Cost of Goods Sold' } : {}) }); }
    const partnerRows = (partners || []).map(p => ({ partner: p.name, id: p.id, accounts: PARTNER_REQ.map(([code, suffix, parent, types]) => ({ code, parent, proposed: `${p.name} ${suffix}`, expected: types.join(' / '), ...check(`acct:${code}:p${p.id}`, types) })) }));
    return { rows, partners: partnerRows };
  }
  // the connection, before anything is read: data centre, the URLs it resolves to, and whether they belong together
  function connection(c) {
    const acc = accountsUrl(c), mock = !!process.env.ZOHO_ACCOUNTS_URL;
    let api = ''; try { api = c.api_domain ? new URL(c.api_domain).origin : ''; } catch { /* not connected */ }
    const expected = (Z.ACCOUNTS[c.dc] || '').replace('://accounts.zoho.', '://www.zohoapis.');
    const dcOk = mock ? null : !!(api && expected && api === expected && acc === Z.ACCOUNTS[c.dc]);
    // where each credential comes from — never its value: '.env' (or the Windows environment), 'database' or 'missing'
    const db0 = Object.fromEntries(db.prepare('SELECT key,value FROM zoho_config').all().map(r => [r.key, r.value]));
    const src = k => envOf(k) ? '.env' : db0[k] ? 'database' : 'missing';
    const credentials = { client_id: src('client_id'), client_secret: src('client_secret'), refresh_token: src('refresh_token'), dc: c.dc || '', dc_source: envOf('dc') ? '.env' : db0.dc ? 'database' : 'default', organization_id: c.org ? 'set' : 'missing', api_domain: c.api_domain ? 'set' : 'missing' };
    return { credentials, connected: !!(c.client_id && c.client_secret && c.refresh_token), organization_id: c.org || '', data_centre: c.dc, uae: c.dc === 'ae', accounts_url: acc, api_base_url: api ? api + '/books/v3' : '', expected_api_base_url: expected ? expected + '/books/v3' : '',
      data_centre_ok: dcOk, note: mock ? 'development mock (ZOHO_ACCOUNTS_URL set) — data centre not checked' : dcOk ? `API and sign-in on the ${c.dc} data centre` : `the API domain ${api || '(none)'} does not belong to the ${c.dc} data centre (expected ${expected})` };
  }
  ctx.zohoNet = null;                                                                  // set by scripts/zoho-preflight.js only (timeouts, one connect retry)
  ctx.zohoProbe = () => client(cfg(), true).probe();                                   // read-only connectivity probe, no token, no organisation
  ctx.zohoConnection = () => connection(cfg());
  ctx.zohoOrganization = async () => { const c = cfg(); const o = ((await client(c, true).get('/organizations')).organizations || []).find(x => String(x.organization_id) === String(c.org)); return o ? { id: String(o.organization_id), name: o.name, currency: o.currency_code, country: o.country || '' } : null; };
  ctx.zohoPreflight = (from, to) => sync({ trigger: 'preflight', user: 'preflight script', from, to, dryRun: true });

  async function preflight(c, offline, items, accts, coa, from, to, lk, errors = []) {
    const names = Object.fromEntries((coa || []).map(a => [String(a.account_id), `${a.account_name}${a.account_code ? ' (' + a.account_code + ')' : ''}`]));
    let organization = { id: c.org || '', name: c.org_name || '' };
    if (!offline) {
      try { const o = ((await client(c, true).get('/organizations')).organizations || []).find(x => String(x.organization_id) === String(c.org)); organization = o ? { id: String(o.organization_id), name: o.name, currency: o.currency_code } : { ...organization, error: 'not found in this Zoho account' }; }
      catch (e) { organization = { ...organization, error: e.message }; }
    }
    const plan = {}; for (const i of items) { const k = plan[i.kind] ||= {}; k[i.action] = (k[i.action] || 0) + 1; }
    const accounts = [...accts.values()].sort((a, b) => a.code.localeCompare(b.code)).map(a => ({ ...a, zoho_name: a.zoho_id ? names[String(a.zoho_id)] || (/^DRY-/.test(a.zoho_id) ? '(stand-in, not connected)' : '') : '' }));
    let host = ''; try { host = c.api_domain ? new URL(c.api_domain).host : ''; } catch { /* not connected */ }
    return { read_only: true, offline, period: { from, to }, organization, data_centre: c.dc, api_host: host,
      mappings: db.prepare('SELECT kind, local_key, zoho_id, label FROM zoho_map ORDER BY kind, local_key').all(),
      synced: db.prepare('SELECT kind, status, COUNT(*) n FROM zoho_sync GROUP BY kind, status ORDER BY kind, status').all(),
      plan, conflicts: items.filter(i => ['conflict', 'link'].includes(i.action)), missing_accounts: accounts.filter(a => a.how.startsWith('missing')), accounts, items: items.slice(0, 2000),
      ...readiness(c, offline, organization, items, coa, lk, errors) };
  }
  // what is already in the send log, grouped as the accountant reads it; the required accounts; the verdict and what to configure
  function readiness(c, offline, organization, items, coa, lk, errors) {
    const GROUP = k => (k === 'invoice' ? 'invoices' : k === 'bill' ? 'bills' : k === 'payment' ? 'payments' : k === 'contact' ? 'contacts' : /^jv_(payroll|paypaid|eos|advance)/.test(k) ? 'payroll' : /^jv_/.test(k) ? 'journals' : k);
    const already = {}; for (const r of db.prepare('SELECT kind, status, COUNT(*) n FROM zoho_sync GROUP BY kind, status').all()) { const g = already[GROUP(r.kind)] ||= {}; g[r.status] = (g[r.status] || 0) + r.n; }
    const count = act => items.filter(i => act.includes(i.action)).length;
    const summary = { would_create: count(['create']), would_update: count(['update']), would_delete: count(['remove', 'void']), unchanged_already_synced: count(['unchanged']), possible_duplicates: count(['link']), conflicts: count(['conflict']), skipped: count(['skip']), errors: count(['error']) };
    const partners = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='partners'").get() ? db.prepare('SELECT id, name FROM partners ORDER BY id').all() : [];
    const req = requiredAccounts(coa, lk, partners), conn = connection(c);
    const all = [...req.rows, ...req.partners.flatMap(p => p.accounts.map(a => ({ ...a, label: `${a.proposed} (under ${a.parent})` })))];
    const blockers = [], todo = [];
    if (!conn.connected) blockers.push('Not connected to Zoho');
    if (offline) blockers.push('Zoho could not be reached (offline) — nothing was checked against the organisation');
    if (organization.error) blockers.push(`Organisation ${c.org || '(none)'}: ${organization.error}`);
    if (conn.data_centre_ok === false) blockers.push(conn.note);
    for (const a of all.filter(a => a.status === 'type_mismatch')) blockers.push(`${a.code} ${a.label}: mapped to "${a.zoho.name}" — ${a.note}`);
    for (const a of all.filter(a => a.status === 'not_found')) blockers.push(`${a.code} ${a.label}: ${a.note} (id ${a.zoho.id})`);
    if (summary.conflicts) blockers.push(`${summary.conflicts} conflict(s): documents edited in Trigon after they were paid in Zoho — correct them in Zoho or with a credit note`);
    if (summary.possible_duplicates) blockers.push(`${summary.possible_duplicates} possible duplicate(s): documents already in Zoho with the same number but not in Trigon's send log — confirm each is the same document`);
    const apiErr = (errors || []).filter(e => !/map our account|first\b|not mapped/i.test(e)); if (apiErr.length) blockers.push(`${apiErr.length} error(s) while reading Zoho — see the errors list`);
    for (const a of all.filter(a => ['missing', 'ambiguous'].includes(a.status))) todo.push(a.code.includes('(') || !a.parent
      ? `${a.code} ${a.label}: ${a.status === 'ambiguous' ? a.note : `create (or choose) a Zoho account of type ${a.expected}`} and map it on the Zoho page${a.needed && a.needed !== 'now' ? ` (needed by: ${a.needed})` : ''}`
      : `Partner ${a.proposed}: create a Zoho account of type ${a.expected} under the parent account "${a.parent}" and map it (code ${a.code})`);
    const verdict = blockers.length ? 'BLOCKED' : todo.length ? 'READY WITH MISSING MAPPINGS' : 'READY';
    return { connection: conn, already_synced: already, summary, required_accounts: req.rows, partner_accounts: req.partners, verdict, blockers, to_configure: todo };
  }

  let running = null;
  async function sync({ trigger = 'manual', user = '', from, to, dryRun = false, keepVals = false } = {}) {
    if (running) throw new Error('A sync is already running');
    const c = cfg(); if (!dryRun && c.enabled !== '1') throw new Error('The Zoho link is switched off');
    if (!dryRun && c.gate_required === '1' && !['READY', 'READY_NON_VAT'].includes(c.gate)) throw new Error('GATE: nothing is sent to Zoho until the read-only preflight reaches READY (or READY_NON_VAT while VAT is pending): 0 missing mappings, 0 wrong account types, 0 ambiguous matches, 0 blocking conflicts — run it on the Zoho page');
    const run = { sent: 0, updated: 0, failed: 0, skipped: 0, errors: [] }, started = now();
    if (dryRun) dry = { recs: new Map(), ops: [], items: [], accts: new Map(), vals: new Map() };
    let offline = false;
    running = (async () => {
      const cl = dryRun ? dryClient(c) : client(c), lk = await lookups(cl); offline = !!cl.offline; run.coa = lk.coa; run.cl = cl; run.lk = lk;
      const { e, invoices, bills, payments } = data(from || c.start || null, to || today()); run.e = e;
      // one record at a time. Continuous runs respect each record's back-off and leave blocked records alone (they need a person).
      // A failure: blocked (closed period, conflict, Zoho-side edit…) · retrying (Zoho or the network failed) · error (the record itself)
      const nowIso = new Date().toISOString();
      const each = async (kind, id, label, fn) => {
        const r0 = !dryRun && trigger === 'continuous' ? rec(kind, id) : null;
        if (r0 && (r0.status === 'blocked' || (WAIT.includes(r0.status) && r0.next_at && r0.next_at > nowIso))) { run.waiting = (run.waiting || 0) + 1; return; }
        try { await fn(); }
        catch (err) {
          const transient = !err.blocked && (!!err.diag || (err.upstream && (!(err.status > 0) || err.status >= 500 || err.status === 429)));
          const status = err.held ? 'held' : err.blocked ? 'blocked' : transient ? 'retrying' : 'error';
          run.failed++; run.errors.push(`${label}: ${err.message}`); note(kind, id, label, 'error', err.message);
          mark(kind, id, null, null, status, err.message.slice(0, 500), null);
          if (!dryRun) { const n = ((rec(kind, id) || {}).attempts || 0) + 1, wait = Math.min(60, 2 ** (n - 1));      // 1, 2, 4, 8, 16, 32, 60, 60 … minutes
            if (status === 'held') db.prepare('UPDATE zoho_sync SET attempts=0, next_at=NULL WHERE kind=? AND local_id=?').run(kind, id);
            else db.prepare('UPDATE zoho_sync SET attempts=?, next_at=? WHERE kind=? AND local_id=?').run(n, status === 'blocked' ? null : new Date(Date.now() + wait * 60000).toISOString(), kind, id); }
        }
      };
      if (dryRun) {                                                                    // accounts every invoice / bill uses in Zoho without a mapping of ours
        useAcct('4000', 'Contract revenue', null, "Zoho default (the line's sales account)"); useAcct('1100', 'Accounts receivable', (lk.ar || {}).account_id, 'automatic (Zoho Accounts Receivable)');
        useAcct('2100', 'VAT output', lk.std && lk.std.tax_id, lk.std ? `Zoho tax ${lk.std.tax_name}` : 'missing (no 5% tax in Zoho)'); useAcct('1200', 'VAT input', lk.std && lk.std.tax_id, lk.std ? `Zoho tax ${lk.std.tax_name}` : 'missing (no 5% tax in Zoho)');
        useAcct('2000', 'Accounts payable', null, 'automatic (Zoho Accounts Payable)');
      }
      for (const i of invoices) await each('invoice', i.id, i.number, async () => {
        if ((i.vat_basis === 'net' && i.retention > 0.004) || i.release > 0.004 || (i.items || []).some(x => x.contra)) {   // PC invoices: VAT after retention / contra / retention release
          note('invoice', i.id, i.number, 'skip', 'invoice from a main-contractor PC (VAT after retention, contra charges or retention release) — entered in Zoho by hand');
          if ((rec('invoice', i.id) || {}).status !== 'skipped') { mark('invoice', i.id, null, null, 'skipped', 'invoice from a main-contractor PC (VAT after retention, contra charges or retention release) — enter it in Zoho by hand for now', null); run.skipped++; }
          return;
        }
        if (newMode() && (vatPending() || !lk.std) && Math.abs(i.vat || 0) > 0.004) throw held('VAT_PENDING', `${i.number} carries VAT ${Math.abs(i.vat).toFixed(2)}; VAT is not configured in Zoho yet — held, sent once the gate is READY`);
        if (!i.client_id) throw new Error('invoice project has no client');
        if (!lk.std && i.vat > 0.004) throw new Error('this invoice has VAT but Zoho Books has no 5% VAT tax — set up UAE VAT in Zoho first');
        const d = invoiceDoc(i, e), cust = await contactId(cl, i.client_id, run), credit = d.type === 'creditnote';
        const head = { customer_id: cust, [credit ? 'creditnote_number' : 'invoice_number']: d.number, date: d.date, ...(!credit && d.due ? { due_date: d.due } : {}),
          reference_number: (credit ? d.original : d.project).slice(0, 100), place_of_supply: d.place, is_inclusive_tax: false, notes: d.notes };
        // new rules: advance lines on "advances from customers" (2400) until recovered, like Trigon's ledger. An invoice already sent
        // the old way and unchanged since keeps its content (history is not rewritten)
        const old = { ...head, line_items: lineItems(d.lines, lk, i.project_id) }, sent = rec('invoice', i.id);
        const adv = isV2(i.date) && d.lines.some(l => l.adv) && !(sent && sent.zoho_id && sent.hash === hashOf(old)) ? zAcct('2400', lk) : null;
        const vals = adv ? { ...head, line_items: lineItems(d.lines, lk, i.project_id, adv) } : old;
        await pushDoc(cl, 'invoice', i.id, d.type, vals, { voided: d.voided, find: { [credit ? 'creditnote_number' : 'invoice_number']: d.number }, label: i.number }, run);
      });
      for (const b of bills) await each('bill', b.id, b.reference || b.description || `#${b.id}`, async () => {
        if (b.category === 'sub_advance') { note('bill', b.id, b.reference || `#${b.id}`, 'skip', 'advance to a subcontractor — recorded in Zoho as a vendor advance by hand'); if ((rec('bill', b.id) || {}).status !== 'skipped') { mark('bill', b.id, null, null, 'skipped', 'advance paid to a subcontractor — record it in Zoho as a vendor advance', null); run.skipped++; } return; }
        if (newMode() && (vatPending() || !lk.std) && Math.abs(b.vat_amount || 0) > 0.004) throw held('VAT_PENDING', `${b.reference || b.description || '#' + b.id} carries VAT ${Math.abs(b.vat_amount).toFixed(2)}; VAT is not configured in Zoho yet — held, sent once the gate is READY`);
        const d = billDoc(b, e), acct = accountFor(lk, d.category), tax = d.vat > 0.004 ? lk.std : null;
        if (d.vat > 0.004 && !tax) { d.amount = round(d.amount + d.vat); d.notes = [d.notes, `VAT ${d.vat.toFixed(2)} not recoverable (not VAT-registered) — included in the cost`].filter(Boolean).join('\n'); }   // not registered: input VAT is part of the cost
        if (!acct) throw new Error('no expense account in Zoho');
        const pct = +(tax && tax.tax_percentage) || 5, exact = !tax || Math.abs(d.vat - round(d.amount * pct / 100)) <= 0.05, taxable = exact ? d.amount : round(d.vat * 100 / pct);
        if (!exact && taxable > d.amount + 0.05) throw new Error(`VAT ${d.vat.toFixed(2)} is more than ${pct}% of the amount — check the bill`);
        if (d.type === 'expense2' && !exact) d.type = 'sundry';                         // new types: a sundry-supplier bill can carry the part without VAT
        if (d.type === 'expense' && !exact) {                                           // an expense has one amount and one tax in Zoho
          note('bill', b.id, d.number, 'skip', 'VAT is not 5% of the amount — entered in Zoho by hand');
          if ((rec('bill', b.id) || {}).status !== 'skipped') { mark('bill', b.id, null, null, 'skipped', `VAT ${d.vat.toFixed(2)} is not ${pct}% of the amount (partly outside VAT) — enter this expense in Zoho by hand`, null); run.skipped++; }
          return;
        }
        if (d.type === 'expense' || d.type === 'expense2') {
          let paid;
          if (d.v2) paid = { account_id: zAcct(ctx.payAccount(d.pay, 'out'), lk, d.pay.partner_id) };   // paid through the account that paid it in Trigon
          else {
            paid = d.cash ? (lk.cash || lk.bank) : (lk.bank || lk.cash); if (!paid) throw new Error('no bank or cash account in Zoho');
            useAcct(d.cash ? '1020' : '1000', d.cash ? 'Cash (expenses paid in cash)' : 'Bank (expenses paid by bank)', paid.account_id, `automatic (first Zoho ${d.cash && lk.cash ? 'cash' : 'bank'} account)`);
          }
          const vals = { account_id: acct.account_id, paid_through_account_id: paid.account_id, date: d.date, amount: d.amount, ...(tax ? { tax_id: tax.tax_id } : {}), is_inclusive_tax: false,
            reference_number: d.number.slice(0, 100), description: [d.description, d.notes].filter(Boolean).join('\n'), place_of_supply: d.place };
          return pushDoc(cl, 'bill', b.id, d.type, vals, { label: d.number }, run);
        }
        const vendor = d.type === 'sundry' ? await sundryId(cl, run) : await contactId(cl, b.party_id, run);
        const vals = { vendor_id: vendor, bill_number: d.number, date: d.date, reference_number: d.project.slice(0, 100), place_of_supply: d.place, is_inclusive_tax: false, notes: d.notes,
          line_items: exact ? [{ account_id: acct.account_id, description: d.description, quantity: 1, rate: d.amount, ...(tax ? { tax_id: tax.tax_id } : {}), ...projectRef(b.project_id) }]
            : [{ account_id: acct.account_id, description: d.description, quantity: 1, rate: taxable, tax_id: tax.tax_id, ...projectRef(b.project_id) },      // the part that carries VAT …
              { account_id: acct.account_id, description: `${d.description} — part without VAT (retention / outside VAT)`, quantity: 1, rate: round(d.amount - taxable), ...projectRef(b.project_id) }] };   // … and the rest, so the VAT equals the VAT on the document
        await pushDoc(cl, 'bill', b.id, 'bill', vals, { find: { bill_number: d.number, vendor_id: vendor }, label: d.number }, run);
      });
      // receipts / payments already in Zoho that bounced, became pending, were deleted or were changed here: removed there
      for (const r of db.prepare("SELECT * FROM zoho_sync WHERE kind='payment' AND status IN ('ok','error','retrying','blocked') AND zoho_id IS NOT NULL").all().filter(r => r.status === 'ok' || e.payments.some(p => p.id === r.local_id && p.method === 'cheque' && p.cheque_status === 'pending'))) await each('payment', r.local_id, `payment #${r.local_id}`, async () => {
        const p = e.payments.find(x => x.id === r.local_id), pending = p && p.method === 'cheque' && p.cheque_status === 'pending', live = p && p.cheque_status !== 'bounced' && !pending;
        const reason = !p ? 'deleted here' : pending ? 'cheque pending' : 'cheque bounced';
        if (live && (!r.hash || r.hash === payHash(payDoc(p, e)))) return;
        note('payment', r.local_id, `payment #${r.local_id}`, 'remove', !live ? `${reason} — would be removed from Zoho` : 'changed here — would be removed from Zoho and sent again');
        const zpath = `/${r.zoho_type === 'vendorpayment' ? 'vendorpayments' : 'customerpayments'}/${r.zoho_id}`;
        let cur = null; if (!r.doc_date || r.sent_eff) try { cur = (await cl.get(zpath))[r.zoho_type === 'vendorpayment' ? 'vendorpayment' : 'payment']; } catch (err) { if (!gone(err)) throw err; }
        guardPeriod(r.doc_date || (cur && cur.date), `payment #${r.local_id}`); if (live) guardPeriod(payDoc(p, e).date, `payment #${r.local_id}`);
        if (modifiedInZoho(r, r.zoho_type, cur, lk)) throw blocked('ZOHO_MODIFIED', `payment #${r.local_id} was changed in Zoho after Trigon sent it — not removed automatically`);
        try { await cl.del(zpath); } catch (err) { if (!gone(err)) throw err; }
        if (dryRun) { if (live) dry.recs.set('payment:' + r.local_id, null); else mark('payment', r.local_id, null, r.zoho_type, 'cancelled', null, null, { clearZohoId: pending }); run.updated++; return; }
        if (live) db.prepare("DELETE FROM zoho_sync WHERE kind='payment' AND local_id=?").run(r.local_id);
        else mark('payment', r.local_id, null, r.zoho_type, 'cancelled', `${reason} — removed from Zoho`, null, { clearZohoId: pending });
        run.updated++;
      });
      for (const p of payments) await each('payment', p.id, `${p.kind === 'in' ? 'receipt' : 'payment'} ${p.reference || '#' + p.id}`, () => pushPayment(cl, p, lk, run));
      for (const j of journals(from || c.start || null, to || today())) await each(j.kind, j.local_id, j.ref, () => pushJournal(cl, j, lk, run));
      // a new-type journal whose movement no longer exists here (deleted, or no longer from the start date): removed from Zoho
      const alive = new Set(ledgerJournals(null, null, true).map(j => j.kind + ':' + j.local_id));
      for (const r of db.prepare(`SELECT * FROM zoho_sync WHERE kind IN (${V2_KINDS.map(() => '?').join(',')}) AND status='ok' AND zoho_id IS NOT NULL`).all(...V2_KINDS)) {
        if (alive.has(r.kind + ':' + r.local_id) || (dry && dry.recs.has(r.kind + ':' + r.local_id) && !dry.recs.get(r.kind + ':' + r.local_id))) continue;
        await each(r.kind, r.local_id, `${r.kind} #${r.local_id}`, async () => {
          note(r.kind, r.local_id, `${r.kind} #${r.local_id}`, 'remove', 'deleted here — would be removed from Zoho');
          let cur = null; if (!r.doc_date || r.sent_eff) try { cur = (await cl.get('/journals/' + r.zoho_id)).journal; } catch (err) { if (!gone(err)) throw err; }
          guardPeriod(r.doc_date || (cur && cur.journal_date), `${r.kind} #${r.local_id}`);
          if (modifiedInZoho(r, 'journal', cur, lk)) throw blocked('ZOHO_MODIFIED', `${r.kind} #${r.local_id} was changed in Zoho after Trigon sent it — not deleted automatically`);
          try { await cl.del('/journals/' + r.zoho_id); } catch (err) { if (!gone(err)) throw err; }
          mark(r.kind, r.local_id, r.zoho_id, 'journal', 'cancelled', 'deleted here — removed from Zoho', null); run.updated++;
        });
      }
    })();
    let message = '';
    try { await running; } catch (err) { message = err.message; run.failed++; } finally { running = null; }
    if (!message && run.errors.length) message = run.errors.slice(0, 5).join(' | ');
    if (dryRun) {
      const { ops, items, accts, vals } = dry; dry = null;
      return { dry_run: true, offline, ...(keepVals ? { vals, items_all: items } : {}), would_send: run.sent, would_update: run.updated, failed: run.failed, skipped: run.skipped, errors: message && !run.errors.length ? [message] : run.errors,
        ops: ops.map(({ body, ...o }) => o), payloads: ops.slice(0, 200), preflight: await preflight(c, offline, items, accts, run.coa, from || c.start || null, to || today(), run.lk, run.errors) };
    }
    db.prepare('INSERT INTO zoho_runs(started,finished,trigger,user,sent,updated,failed,skipped,message) VALUES(?,?,?,?,?,?,?,?,?)').run(started, now(), trigger, user, run.sent, run.updated, run.failed, run.skipped, message);
    setCfg('last_run', today());
    return { sent: run.sent, updated: run.updated, failed: run.failed, skipped: run.skipped, waiting: run.waiting || 0, message, errors: run.errors.slice(0, 50) };
  }

  // for the account provisioning, the continuous sync and the reconciliation (modules/zohoacct.js)
  ctx.zohoX = { cfg, setCfg, client, lookups, mapOf, sync, isRunning: () => !!running, effect, compareEff, hashOf, has, partnerName, REQUIRED, PARTNER_REQ, AUTO, LEDGER, LEDGER2, CAT, journals, data,
    lockDate, rec, expectTypes, DEFERRED, bankAccounts: () => (ctx.bankAccounts ? ctx.bankAccounts() : []) };

  // nightly run on the server edition (the browser-only edition cannot call Zoho: CORS + no background process)
  if (typeof window === 'undefined' && !process.env.ZOHO_NO_SCHEDULER) {
    const tick = () => {
      const c = cfg(), h = new Date().getHours();
      if (c.enabled === '1' && c.auto === '1' && h === +c.hour && c.last_run !== today() && !running) sync({ trigger: 'nightly' }).catch(() => {});
    };
    setInterval(tick, 10 * 60 * 1000).unref();
  }

  // ---------- daily report ----------
  function report(date) {
    const { invoices, bills, payments } = data(date, date), st = (k, id) => rec(k, id) || { status: 'pending' };
    const rows = [
      ...invoices.map(i => ({ type: i.kind === 'credit_note' ? 'credit_note' : 'invoice', ref: i.number, party: i.client_name, project: i.project_name, net: i.subtotal, vat: i.vat, total: i.total, void: !!i.voided, sync: st('invoice', i.id) })),
      ...bills.map(b => ({ type: b.party_id ? 'bill' : 'expense', ref: b.reference || `#${b.id}`, party: b.party_name, project: b.project_name, net: round(b.amount), vat: round(b.vat_amount), total: b.total, sync: st('bill', b.id) })),
      ...payments.map(p => ({ type: p.kind === 'in' ? 'receipt' : 'payment', ref: p.reference || p.ref_label || `#${p.id}`, party: p.party_name, project: p.project_name, net: round(p.amount), vat: 0, total: round(p.kind === 'in' ? p.amount : -p.amount), method: p.method, sync: st('payment', p.id) })),
    ].map(r => ({ ...r, sync_status: r.sync.status, sync_error: r.sync.error || '', zoho_id: r.sync.zoho_id || null, sync: undefined }));
    const sum = (...t) => round(rows.filter(r => t.includes(r.type) && !r.void).reduce((s, r) => s + r.total, 0));
    const vat = (...t) => round(rows.filter(r => t.includes(r.type) && !r.void).reduce((s, r) => s + r.vat, 0));
    return { date, rows, totals: { invoiced: sum('invoice', 'credit_note'), output_vat: vat('invoice', 'credit_note'), bills: sum('bill', 'expense'), input_vat: vat('bill', 'expense'),
      received: sum('receipt'), paid: round(-sum('payment')), pending: rows.filter(r => r.sync_status === 'pending').length, errors: rows.filter(r => ['error', 'changed'].includes(r.sync_status)).length } };
  }

  // ---------- CSV files for Zoho Books' import wizard (works without API access: <module> → ⋯ → Import) ----------
  const cell = v => { let s = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = rows => '﻿' + rows.map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
  const KINDS = ['customers', 'vendors', 'invoices', 'creditnotes', 'bills', 'expenses', 'customer_payments', 'vendor_payments'];
  function exportCsv(kind, from, to) {
    const { e, invoices, bills, payments } = data(from, to), name = id => (e.parties[id] || {}).name || '';
    if (kind === 'customers' || kind === 'vendors') {
      const out = [['Display Name', 'Company Name', 'Email ID', 'Phone', 'Billing Address', 'Tax Treatment', 'TRN', 'Notes']];
      for (const p of Object.values(e.parties)) if ((p.type === 'client') === (kind === 'customers'))
        out.push([p.name, p.name, p.email, p.phone, p.address, p.trn ? 'vat_registered' : 'vat_not_registered', p.trn, `Trigon ERP TRG-P${p.id}`]);
      return csv(out);
    }
    if (kind === 'invoices' || kind === 'creditnotes') {
      const cn = kind === 'creditnotes';
      const out = [[cn ? 'Credit Note Number' : 'Invoice Number', cn ? 'Credit Note Date' : 'Invoice Date', 'Due Date', 'Customer Name', 'Place of Supply', 'Reference Number', 'Notes', 'Item Name', 'Item Description', 'Quantity', 'Item Price', 'Item Tax', 'Item Tax %']];
      for (const i of invoices) if (!i.voided && (i.kind === 'credit_note') === cn) {
        const d = invoiceDoc(i, e);
        for (const l of d.lines) out.push([d.number, d.date, cn ? '' : d.due, name(d.client_id), d.place, cn ? d.original : d.project, d.notes, l.name.slice(0, 100), l.name.length > 100 ? l.name : '', l.quantity, l.rate, TAX_NAME[l.tax], TAX_PCT[l.tax]]);
      }
      return csv(out);
    }
    if (kind === 'bills' || kind === 'expenses') {
      const docs = bills.map(b => billDoc(b, e)).filter(d => (kind === 'bills' ? ['bill', 'sundry'] : ['expense', 'expense2']).includes(d.type)), tax = d => (d.vat > 0.004 ? 'std' : null);
      const out = kind === 'bills'
        ? [['Bill Number', 'Bill Date', 'Vendor Name', 'Place of Supply', 'Reference Number', 'Notes', 'Account', 'Description', 'Quantity', 'Rate', 'Tax Name', 'Tax %', 'Category']]
        : [['Expense Date', 'Expense Account', 'Paid Through', 'Amount', 'Tax Name', 'Tax %', 'Is Inclusive Tax', 'Reference#', 'Description', 'Place of Supply', 'Category']];
      for (const d of docs) out.push(kind === 'bills'
        ? [d.number, d.date, d.type === 'sundry' ? 'Sundry suppliers (Trigon ERP)' : name(d.party_id), d.place, d.project, d.notes, 'Cost of Goods Sold', d.description, 1, d.amount, tax(d) ? TAX_NAME.std : '', tax(d) ? 5 : '', CAT[d.category] || d.category]
        : [d.date, 'Cost of Goods Sold', d.cash ? 'Petty Cash' : 'Bank', d.amount, tax(d) ? TAX_NAME.std : '', tax(d) ? 5 : '', 'false', d.number, d.description, d.place, CAT[d.category] || d.category]);
      return csv(out);
    }
    if (kind === 'customer_payments' || kind === 'vendor_payments') {
      const inbound = kind === 'customer_payments';
      const out = [['Date', inbound ? 'Customer Name' : 'Vendor Name', 'Mode', inbound ? 'Deposit To' : 'Paid Through', 'Amount', 'Reference Number', 'Description', inbound ? 'Invoice Number' : 'Bill Number', inbound ? 'Amount Applied to Invoice' : 'Amount Applied to Bill']];
      for (const p of payments) {
        const d = payDoc(p, e); if (d.inbound !== inbound || !d.party_id || p.method === 'offset' || (p.method === 'cheque' && p.cheque_status === 'pending')) continue;
        const doc = d.inv || d.bill;
        out.push([d.date, name(d.party_id), d.mode, d.cash ? 'Petty Cash' : 'Bank', d.amount, p.reference, d.memo, d.inv ? d.inv.number : (d.bill.reference || `TRG-B${d.bill.id}`), Math.min(d.amount, Math.abs(doc.total))]);
      }
      return csv(out);
    }
    return null;
  }

  return {
    async handle(req, res, url, [a, b], me) {
      if (a !== 'zoho') return false;
      if (!canFin(me)) return send(res, 403, { error: 'forbidden' }), true;
      const m = req.method, q = url.searchParams, admin = me.role === 'admin';
      const adminOnly = () => send(res, 403, { error: 'only an administrator can change the Zoho connection' });
      if (m === 'GET' && !b) {
        const c = cfg(), counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM zoho_sync GROUP BY status').all().map(r => [r.status, r.n]));
        return send(res, 200, { config: publicCfg(c), counts, running: !!running, runs: db.prepare('SELECT * FROM zoho_runs ORDER BY id DESC LIMIT 20').all(), server: typeof window === 'undefined',
          scope: Z.SCOPE, console: accountsUrl(c).replace('://accounts.', '://api-console.'), centres: Object.keys(Z.ACCOUNTS) }), true;
      }
      if (m === 'PUT' && b === 'config') {
        if (!admin) return adminOnly(), true;
        const body = await readBody(req), c = cfg();
        for (const k of ['dc', 'client_id', 'client_secret']) if (envOf(k)) delete body[k];          // set in .env — the screen cannot change it
        if (body.dc != null && !Z.ACCOUNTS[body.dc]) return send(res, 400, { error: 'Unknown Zoho data centre' }), true;
        if (body.start && !/^\d{4}-\d{2}-\d{2}$/.test(body.start)) return send(res, 400, { error: 'Start date must be YYYY-MM-DD' }), true;
        if (body.start_v2 && !/^\d{4}-\d{2}-\d{2}$/.test(body.start_v2)) return send(res, 400, { error: 'The start date of the new transaction types must be YYYY-MM-DD' }), true;
        if (body.hour != null && body.hour !== '' && !(+body.hour >= 0 && +body.hour <= 23)) return send(res, 400, { error: 'Hour must be 0–23' }), true;
        if (body.org != null && body.org !== '' && !orgsOf(c).some(o => o.id === String(body.org))) return send(res, 400, { error: 'Unknown organisation' }), true;
        const changed = k => body[k] != null && String(body[k]).trim() !== (c[k] || '');
        if (changed('dc') || changed('client_id')) {                                      // another account → the old sign-in is useless
          for (const k of ['refresh_token', 'api_domain', 'org', 'orgs', 'org_name']) setCfg(k, '');
          Object.keys(tokenCache).forEach(k => delete tokenCache[k]);
        }
        if (changed('org') && c.org) db.exec('DELETE FROM zoho_sync');                    // another organisation → everything is sent again
        for (const k of ['dc', 'client_id', 'org', 'start', 'start_v2', 'hour', 'enabled', 'auto', 'post']) if (body[k] !== undefined) setCfg(k, String(body[k]).trim());
        if (body.org !== undefined) setCfg('org_name', (orgsOf(cfg()).find(o => o.id === String(body.org)) || {}).name || '');
        if (body.client_secret) setCfg('client_secret', String(body.client_secret).trim());   // the secret only changes when a new one is typed
        audit(req, 'update', 'zoho_config', 0, 'connection settings');
        return send(res, 200, publicCfg(cfg())), true;
      }
      if (m === 'POST' && b === 'connect') {
        if (!admin) return adminOnly(), true;
        const body = await readBody(req), c = cfg(), code = String(body.code || '').trim();
        if (!c.client_id || !c.client_secret) return send(res, 400, { error: 'Put ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET in the .env file (or save them here) first' }), true;
        if (!code && !envOf('refresh_token')) return send(res, 400, { error: 'Paste the code generated in the Zoho API console' }), true;
        try {
          const t = code ? await Z.exchangeCode({ accounts: accountsUrl(c), client_id: c.client_id, client_secret: c.client_secret, code })
            : { refresh_token: c.refresh_token, api_domain: c.api_domain || '' };                          // refresh token from .env: just load the organisations
          if (code) { setCfg('refresh_token', t.refresh_token); setCfg('api_domain', t.api_domain); Object.assign(tokenCache, { token: t.access_token, exp: Date.now() + t.expires_in * 1000 }); }
          const cl = Z.createClient({ accounts: accountsUrl(c), client_id: c.client_id, client_secret: c.client_secret, refresh_token: t.refresh_token, api_domain: t.api_domain, org: '', cache: tokenCache });
          const orgs = ((await cl.get('/organizations')).organizations || []).map(o => ({ id: String(o.organization_id), name: o.name }));
          setCfg('orgs', JSON.stringify(orgs));
          const keep = orgs.find(o => o.id === c.org) || (orgs.length === 1 ? orgs[0] : null);
          if (c.org && (!keep || keep.id !== c.org)) db.exec('DELETE FROM zoho_sync');
          setCfg('org', keep ? keep.id : ''); setCfg('org_name', keep ? keep.name : '');
          audit(req, 'update', 'zoho_config', 0, 'connected');
          return send(res, 200, publicCfg(cfg())), true;
        } catch (e) { return send(res, 400, { error: e.message }), true; }
      }
      if (m === 'POST' && b === 'disconnect') {
        if (!admin) return adminOnly(), true;
        const c = cfg(); await Z.revoke({ accounts: accountsUrl(c), token: c.refresh_token });
        for (const k of ['refresh_token', 'api_domain']) setCfg(k, '');
        setCfg('enabled', '0'); Object.keys(tokenCache).forEach(k => delete tokenCache[k]);
        audit(req, 'update', 'zoho_config', 0, 'disconnected');
        return send(res, 200, publicCfg(cfg())), true;
      }
      if (m === 'POST' && b === 'test') { try { return send(res, 200, await test()), true; } catch (e) { return send(res, 400, { error: e.message }), true; } }
      if (m === 'POST' && b === 'sync') {
        const body = await readBody(req);
        try { const r = await sync({ trigger: 'manual', user: me.username, from: body.from, to: body.to }); audit(req, 'sync', 'zoho', 0, JSON.stringify(r).slice(0, 300)); return send(res, 200, r), true; }
        catch (e) { return send(res, 400, { error: e.message }), true; }
      }
      if (m === 'POST' && b === 'dry-run') {
        const body = await readBody(req);
        try { const r = await sync({ trigger: 'dry-run', user: me.username, from: body.from, to: body.to, dryRun: true }); audit(req, 'dry-run', 'zoho', 0, `${r.ops.length} operations`); return send(res, 200, r), true; }
        catch (e) { dry = null; return send(res, 400, { error: e.message }), true; }
      }
      if (b === 'mapping') {
        if (m === 'PUT') {
          if (!admin) return adminOnly(), true;
          const x = await readBody(req);
          if (!['account', 'project'].includes(x.kind) || !x.local_key) return send(res, 400, { error: 'kind and local_key are required' }), true;
          const dc = ['acct:1010', 'acct:1020', 'acct:1030'];                              // never on one Zoho account
          if (x.zoho_id && x.kind === 'account' && dc.includes(String(x.local_key))) { const clash = db.prepare(`SELECT local_key FROM zoho_map WHERE kind='account' AND zoho_id=? AND local_key<>? AND local_key IN (${dc.map(() => '?').join(',')})`).get(String(x.zoho_id), String(x.local_key), ...dc);
            if (clash) return send(res, 400, { error: `${x.local_key} cannot use the Zoho account already used by ${clash.local_key}: 1010, 1020 and 1030 must be different accounts` }), true; }
          if (x.zoho_id) db.prepare('INSERT INTO zoho_map(kind,local_key,zoho_id,label) VALUES(?,?,?,?) ON CONFLICT(kind,local_key) DO UPDATE SET zoho_id=excluded.zoho_id, label=excluded.label').run(x.kind, String(x.local_key), String(x.zoho_id), String(x.label || ''));
          else db.prepare('DELETE FROM zoho_map WHERE kind=? AND local_key=?').run(x.kind, String(x.local_key));
          audit(req, 'update', 'zoho_map', 0, `${x.kind} ${x.local_key} → ${x.zoho_id || '(none)'}`);
          return send(res, 200, { ok: 1 }), true;
        }
        if (m === 'GET') {
          const saved = db.prepare('SELECT * FROM zoho_map').all();
          const local = { accounts: [...Object.entries(CAT).map(([k, v]) => ({ key: 'cat:' + k, label: `Expense category — ${v}` })), ...Object.entries(LEDGER).map(([k, v]) => ({ key: 'acct:' + k, label: `${k} ${v}` })), ...Object.entries(LEDGER2).map(([k, v]) => ({ key: 'acct:' + k, label: `${k} ${v}` })),
            ...(has('partners') ? db.prepare('SELECT id, name FROM partners ORDER BY id').all() : []).flatMap(p => [['3000', 'Capital'], ['2500', 'Partner loan'], ['3110', 'Current account']].map(([k, v]) => ({ key: `acct:${k}:p${p.id}`, label: `${k} ${v} — ${p.name}` }))), ...(ctx.bankAccounts ? ctx.bankAccounts() : [{ ledger_code: '1000', name: 'Bank' }]).map(k => ({ key: 'acct:' + k.ledger_code, label: `${k.ledger_code} Bank — ${k.name}${k.ledger_code === '1000' ? ' (also salaries and advances)' : ''}` })), { key: 'acct:1020', label: '1020 Cash (advances paid in cash)' }],
            projects: db.prepare('SELECT id, code, name FROM projects ORDER BY id DESC').all() };
          let zoho = null, error = null;
          try {
            const cl = client(cfg());
            const coa = ((await cl.get('/chartofaccounts', { filter_by: 'AccountType.Active' })).chartofaccounts || []).map(a => ({ id: String(a.account_id), name: a.account_name, type: a.account_type }));
            const tags = [];
            for (const t of ((await cl.get('/reportingtags').catch(() => ({}))).reporting_tags || [])) tags.push({ id: String(t.tag_id), name: t.tag_name, options: (((await cl.get(`/reportingtags/${t.tag_id}/options/all`).catch(() => ({}))).results) || []).map(o => ({ id: String(o.option_id), name: o.option_name })) });
            const projects = ((await cl.get('/projects').catch(() => ({}))).projects || []).map(p => ({ id: String(p.project_id), name: p.project_name }));
            zoho = { accounts: coa, tags, projects };
          } catch (e) { error = e.message; }
          return send(res, 200, { local, saved, zoho, error }), true;
        }
      }
      // (a create whose answer was lost keeps its row: it is looked up in Zoho before it is sent again)
      if (m === 'POST' && b === 'retry') { db.prepare("DELETE FROM zoho_sync WHERE status IN ('error','skipped') AND zoho_id IS NULL AND COALESCE(pending_create,0)=0").run(); return send(res, 200, { ok: true }), true; }
      if (m === 'GET' && b === 'log') return send(res, 200, db.prepare('SELECT * FROM zoho_sync ORDER BY synced_at DESC, id DESC LIMIT 300').all()), true;
      if (m === 'GET' && b === 'report') { const d = q.get('date') || today(); if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return send(res, 400, { error: 'date must be YYYY-MM-DD' }), true; return send(res, 200, report(d)), true; }
      if (m === 'GET' && b === 'export') {
        const kind = q.get('kind'), body = KINDS.includes(kind) ? exportCsv(kind, q.get('from') || null, q.get('to') || null) : null;
        if (body == null) return send(res, 400, { error: 'kind must be one of ' + KINDS.join(', ') }), true;
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="zoho-${kind}-${q.get('from') || 'all'}-${q.get('to') || today()}.csv"` });
        return res.end(body), true;
      }
      return send(res, 404, { error: 'not found' }), true;
    },
    sync, report,
  };
};
