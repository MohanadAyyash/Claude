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
  const client = c => {
    if (!c.client_id || !c.client_secret || !c.refresh_token) throw new Error('Connect to Zoho first (Client ID, Client Secret and a grant code)');
    if (!c.org) throw new Error('Choose the Zoho Books organisation first');
    return Z.createClient({ accounts: accountsUrl(c), client_id: c.client_id, client_secret: c.client_secret, refresh_token: c.refresh_token, api_domain: c.api_domain, org: c.org, cache: tokenCache });
  };

  const hashOf = o => { const s = JSON.stringify(o); let h = 0; for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0; return String(h >>> 0); };
  let dry = null;                                                                     // during a dry run: { recs, ops } — nothing is written or sent
  const rec = (kind, id) => (dry && dry.recs.has(kind + ':' + id) ? dry.recs.get(kind + ':' + id) : db.prepare('SELECT * FROM zoho_sync WHERE kind=? AND local_id=?').get(kind, id));
  const mark = (kind, id, zohoId, type, status, error, hash) => dry ? void dry.recs.set(kind + ':' + id, { kind, local_id: id, zoho_id: zohoId == null ? (rec(kind, id) || {}).zoho_id : String(zohoId), zoho_type: type, status, error, hash }) : db.prepare(`INSERT INTO zoho_sync(kind,local_id,zoho_id,zoho_type,status,error,hash,synced_at) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(kind,local_id) DO UPDATE SET zoho_id=COALESCE(excluded.zoho_id,zoho_id), zoho_type=COALESCE(excluded.zoho_type,zoho_type), status=excluded.status, error=excluded.error, hash=COALESCE(excluded.hash,hash), synced_at=excluded.synced_at`)
    .run(kind, id, zohoId == null ? null : String(zohoId), type ?? null, status, error ?? null, hash ?? null, now());
  const gone = e => e.status === 404 || e.code === 1002 || /does not exist/i.test(e.message);

  // ---------- our accounts / projects → Zoho accounts / projects or reporting-tag options ----------
  const LEDGER = { 1100: 'Accounts receivable (default: Zoho Accounts Receivable)', 5200: 'Site labour salaries (projects)', 6200: 'Head-office salaries', 2200: 'Salaries payable', 2250: 'Employee deductions payable', 1300: 'Employee advances', 5260: 'End-of-service benefits (expense)', 2300: 'End-of-service provision', 1150: 'Retention receivable' };
  const mapOf = (kind, key) => (db.prepare('SELECT zoho_id FROM zoho_map WHERE kind=? AND local_key=?').get(kind, String(key)) || {}).zoho_id || null;
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
    const bills = e.bills.filter(b => inRange(b.date));
    const payments = e.payments.filter(p => inRange(p.date) && !(p.method === 'cheque' && p.cheque_status === 'bounced'));
    return { e, invoices, bills, payments };
  }
  const invoiceDoc = (i, e) => ({
    type: i.kind === 'credit_note' ? 'creditnote' : 'invoice', number: i.number, date: i.date, due: i.due_date || '', client_id: i.client_id, place: PLACE[i.emirate] || 'DU', project: i.project_name || '',
    original: i.original_id ? (e.invoices.find(o => o.id === i.original_id) || {}).number || '' : '',
    notes: [i.project_name && `Project: ${i.project_name}`, i.retention > 0 && `Retention ${i.retention_pct}% = ${i.retention.toFixed(2)} AED (held by client)`, i.notes].filter(Boolean).join('\n'),
    lines: (i.items || []).map(x => ({ name: String(x.description || '-'), quantity: +x.qty || 0, rate: +x.rate || 0, tax: x.vat === 'zero' || x.vat === 'exempt' ? x.vat : (+i.vat_pct || 0) > 0 ? 'std' : 'zero' })),
    voided: !!i.voided, total: Math.abs(i.total),
  });
  const billDoc = (b, e) => {
    const pay = e.payments.find(p => p.kind === 'out' && p.bill_id === b.id);
    return { type: b.party_id ? 'bill' : 'expense', number: b.reference || `TRG-B${b.id}`, date: b.date, party_id: b.party_id, place: PLACE[(e.projects[b.project_id] || {}).emirate] || 'DU',
      project: b.project_name || '', category: b.category || '', description: b.description || CAT[b.category] || 'Expense', amount: round(b.amount), vat: round(b.vat_amount), total: b.total,
      notes: [b.project_name && `Project: ${b.project_name}`, b.category && `Category: ${CAT[b.category] || b.category}`].filter(Boolean).join('\n'),
      cash: pay ? ['cash', 'petty'].includes(pay.method) : true };
  };
  const payDoc = (p, e) => {
    const inv = p.invoice_id ? e.invoices.find(i => i.id === p.invoice_id) : null, bill = p.bill_id ? e.bills.find(b => b.id === p.bill_id) : null;
    return { inbound: p.kind === 'in', amount: round(p.amount), date: p.method === 'cheque' && p.cheque_date ? p.cheque_date : p.date, mode: MODE[p.method] || 'banktransfer', inv, bill,
      memo: [p.reference, inv && inv.number, bill && (bill.reference || bill.description), p.is_retention ? 'retention release' : '', p.method === 'cheque' && p.cheque_date ? `cheque ${p.cheque_date}` : ''].filter(Boolean).join(' · ') || `TRG-PAY${p.id}`,
      party_id: inv ? inv.client_id : bill ? bill.party_id : null, cash: ['cash', 'petty'].includes(p.method) };
  };

  // ---------- push ----------
  const EXPENSE_TYPES = ['cost_of_goods_sold', 'expense', 'other_expense'];
  async function lookups(cl) {
    const taxes = (await cl.get('/settings/taxes')).taxes || [];
    const banks = ((await cl.get('/bankaccounts')).bankaccounts || []).filter(a => a.is_active !== false && a.status !== 'inactive');
    const coa = ((await cl.get('/chartofaccounts', { filter_by: 'AccountType.Active' })).chartofaccounts || []);
    const tax = (pct, re) => taxes.find(t => +t.tax_percentage === pct && t.tax_type !== 'tax_group' && (!re || re.test(t.tax_name || '')));
    const expense = coa.filter(a => EXPENSE_TYPES.includes(a.account_type));
    return { std: tax(5), zero: tax(0, /zero/i), exempt: tax(0, /exempt/i), bank: banks.find(a => a.account_type === 'bank'), cash: banks.find(a => a.account_type === 'cash'), ar: coa.find(a => a.account_type === 'accounts_receivable'), retention: coa.find(a => /retention/i.test(a.account_name || '') && /asset/.test(a.account_type || '')),
      expense, assets: coa.filter(a => a.account_type === 'fixed_asset'), cogs: expense.find(a => a.account_type === 'cost_of_goods_sold') || expense[0] };
  }
  const taxOf = (lk, k) => (k === 'std' ? lk.std : k === 'zero' ? lk.zero : k === 'exempt' ? lk.exempt : null);
  // expense account for a bill category: an account whose name contains the category (e.g. "Materials"), else Cost of Goods Sold
  const accountFor = (lk, category) => {
    const m = mapOf('account', 'cat:' + category); if (m) return { account_id: m };
    if (category === 'asset' && lk.assets[0]) return lk.assets[0];
    const label = (CAT[category] || '').toLowerCase();
    return (label && lk.expense.find(a => String(a.account_name || '').toLowerCase().includes(label))) || lk.cogs;
  };
  async function test() {
    const c = cfg(), cl = client(c);
    const orgs = (await cl.get('/organizations')).organizations || [], org = orgs.find(o => String(o.organization_id) === String(c.org));
    if (!org) throw new Error('The chosen organisation is not in this Zoho account any more — connect again');
    const lk = await lookups(cl), missing = [];
    if (!lk.std) missing.push('5% VAT tax'); if (!lk.bank && !lk.cash) missing.push('bank or cash account'); if (!lk.cogs) missing.push('expense account');
    return { ok: true, org: org.name, currency: org.currency_code, lookups: { tax: lk.std && lk.std.tax_name, zero: lk.zero && lk.zero.tax_name, exempt: lk.exempt && lk.exempt.tax_name,
      bank: lk.bank && lk.bank.account_name, cash: lk.cash && lk.cash.account_name, expense: lk.cogs && lk.cogs.account_name }, missing };
  }

  async function contactId(cl, partyId, run) {
    const p = run.e.parties[partyId]; if (!p) throw new Error('contact not found');
    const vals = { contact_name: p.name, company_name: p.name, contact_type: p.type === 'client' ? 'customer' : 'vendor', tax_treatment: p.trn ? 'vat_registered' : 'vat_not_registered',
      ...(p.trn ? { tax_reg_no: p.trn } : {}), billing_address: { address: p.address || '' }, notes: [`Trigon ERP TRG-P${p.id}`, p.notes].filter(Boolean).join('\n') };
    const person = p.email || p.phone ? { first_name: p.name.slice(0, 100), email: p.email || '', phone: p.phone || '', is_primary_contact: true } : null;
    const h = hashOf([vals, person]), r = rec('contact', p.id);
    if (r && r.status === 'ok' && r.zoho_id) {
      if (r.hash === h) return r.zoho_id;
      try {
        const cp = (((await cl.get('/contacts/' + r.zoho_id)).contact || {}).contact_persons || [])[0];        // update the existing person instead of adding another
        await cl.put('/contacts/' + r.zoho_id, { ...vals, ...(person ? { contact_persons: [{ ...(cp ? { contact_person_id: cp.contact_person_id } : {}), ...person }] } : {}) });
        mark('contact', p.id, r.zoho_id, 'contact', 'ok', null, h); run.updated++; return r.zoho_id;
      } catch (e) { if (!gone(e)) throw e; }                                          // deleted in Zoho → create it again below
    }
    const found = ((await cl.get('/contacts', { contact_name: p.name })).contacts || []).find(x => x.contact_name === p.name);
    const id = found ? found.contact_id : (await cl.post('/contacts', { ...vals, contact_persons: person ? [person] : [] })).contact.contact_id;
    if (found) await cl.put('/contacts/' + id, vals);
    mark('contact', p.id, id, 'contact', 'ok', null, h); run.sent++; return id;
  }

  const DOC = {
    invoice: { path: '/invoices', key: 'invoice', id: 'invoice_id', num: 'invoice_number', post: 'sent' },
    creditnote: { path: '/creditnotes', key: 'creditnote', id: 'creditnote_id', num: 'creditnote_number', post: 'open' },
    bill: { path: '/bills', key: 'bill', id: 'bill_id', num: 'bill_number', post: 'open' },
    expense: { path: '/expenses', key: 'expense', id: 'expense_id' },
  };
  const LOCKED = ['paid', 'partially_paid', 'closed'];                                  // money has been applied in Zoho → never overwrite
  const lineItems = (lines, lk, pid) => lines.map(l => { const t = taxOf(lk, l.tax); return { name: l.name.slice(0, 100), description: l.name.length > 100 ? l.name : '', quantity: l.quantity, rate: l.rate, ...(t ? { tax_id: t.tax_id } : {}), ...projectRef(pid) }; });

  async function pushDoc(cl, kind, localId, type, vals, { voided, find, label }, run) {
    const t = DOC[type], h = hashOf(vals), r = rec(kind, localId), q = t.num ? { ignore_auto_number_generation: 'true' } : undefined;
    if (voided) {                                                                     // cancelled here → void there (if it was sent)
      if (!r || !r.zoho_id) { mark(kind, localId, null, type, 'skipped', 'void — not sent', h); run.skipped++; return; }
      if (r.status === 'cancelled') return;
      await cl.post(`${t.path}/${r.zoho_id}/status/void`); mark(kind, localId, r.zoho_id, type, 'cancelled', null, h); run.updated++; return;
    }
    if (r && r.zoho_id && ['ok', 'changed'].includes(r.status)) {
      if (r.zoho_type !== type) { if (r.status !== 'changed') { mark(kind, localId, r.zoho_id, null, 'changed', `${label} changed between bill and expense after it was sent — fix it in Zoho`, null); run.failed++; } return; }
      if (r.hash === h) return;
      let cur = null; try { cur = (await cl.get(`${t.path}/${r.zoho_id}`))[t.key]; } catch (e) { if (!gone(e)) throw e; }
      if (cur && !LOCKED.includes(cur.status)) { await cl.put(`${t.path}/${r.zoho_id}`, vals, q); mark(kind, localId, r.zoho_id, type, 'ok', null, h); run.updated++; return; }
      if (cur) { if (r.status !== 'changed') { mark(kind, localId, r.zoho_id, type, 'changed', 'edited here after it was paid in Zoho — correct it in Zoho or issue a credit note', null); run.failed++; } return; }
      // deleted in Zoho → send it again
    }
    let id = null;
    if (find) { const hit = ((await cl.get(t.path, find))[t.key + 's'] || []).find(x => x[t.num] === vals[t.num]); if (hit) id = hit[t.id]; }
    if (!id) {
      id = (await cl.post(t.path, vals, q))[t.key][t.id];
      if (t.post && cfg().post === '1') await cl.post(`${t.path}/${id}/status/${t.post}`);
    }
    mark(kind, localId, id, type, 'ok', null, h); run.sent++;
  }

  async function pushPayment(cl, p, lk, run) {
    const r = rec('payment', p.id);
    if (r && ['ok', 'skipped', 'included'].includes(r.status)) return;
    if (p.method === 'cheque' && p.cheque_status === 'pending') return;               // post-dated cheque: sent once it clears
    const d = payDoc(p, run.e), skip = why => { mark('payment', p.id, null, null, 'skipped', why, null); run.skipped++; };
    if (p.method === 'offset') return skip('offset against another balance — record it in Zoho directly');
    if (d.bill && !d.bill.party_id) return void mark('payment', p.id, null, 'expense', 'included', 'paid expense — already in Zoho as an expense', null);
    if (!d.inv && !d.bill) return skip('not linked to an invoice or bill — record it in Zoho directly');
    const docRec = rec(d.inv ? 'invoice' : 'bill', (d.inv || d.bill).id);
    if (docRec && docRec.zoho_type === 'creditnote') return skip('refund of a credit note — record it in Zoho as a credit note refund');
    if (!docRec || !docRec.zoho_id || !['ok', 'changed'].includes(docRec.status)) throw new Error(`its ${d.inv ? 'invoice' : 'bill'} is not in Zoho yet`);
    const t = DOC[docRec.zoho_type], doc = (await cl.get(`${t.path}/${docRec.zoho_id}`))[t.key];
    if (doc.status === 'void') throw new Error(`its ${t.key} is void in Zoho`);
    if (doc.status === 'draft') await cl.post(`${t.path}/${docRec.zoho_id}/status/${t.post}`);   // a paid document is no longer a draft
    const apply = round(Math.min(d.amount, +doc.balance || 0)), contact = await contactId(cl, d.party_id, run);
    const mapped = !d.cash && ctx.bankCode && mapOf('account', 'acct:' + ctx.bankCode(p.bank_account_id));   // several bank accounts: each mapped to its Zoho bank
    const acct = mapped ? { account_id: mapped } : d.cash ? (lk.cash || lk.bank) : (lk.bank || lk.cash), ref = String(p.reference || '').slice(0, 100);
    let id;
    if (d.inbound) {
      const vals = { customer_id: contact, payment_mode: d.mode, amount: d.amount, date: d.date, reference_number: ref, description: d.memo, ...(acct ? { account_id: acct.account_id } : {}),
        invoices: apply > 0 ? [{ invoice_id: docRec.zoho_id, amount_applied: apply }] : [] };
      id = (await cl.post('/customerpayments', vals)).payment.payment_id;
    } else {
      const vals = { vendor_id: contact, payment_mode: d.mode, amount: d.amount, date: d.date, reference_number: ref, description: d.memo, ...(acct ? { paid_through_account_id: acct.account_id } : {}),
        bills: apply > 0 ? [{ bill_id: docRec.zoho_id, amount_applied: apply }] : [] };
      id = (await cl.post('/vendorpayments', vals)).vendorpayment.payment_id;
    }
    mark('payment', p.id, id, d.inbound ? 'customerpayment' : 'vendorpayment', 'ok', null, null); run.sent++;
  }

  // ---------- manual journals: payroll by project, salaries paid, end-of-service provision / settlement, salary advances, retention ----------
  const ym = m => +m.replace('-', ''), mEnd = m => `${m}-${String(ctx.C.daysInMonth(m)).padStart(2, '0')}`;
  const has = t => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  // a payroll row's cost by project: the attendance split when there is one, else its own project (null = head office)
  const split = r => { const al = has('payroll_alloc') ? db.prepare('SELECT project_id, amount FROM payroll_alloc WHERE payroll_id=?').all(r.id) : []; return al.length ? al : [{ project_id: r.project_id || null, amount: r.gross }]; };
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
        out.push({ kind: 'jv_eos', local_id: ym(m.month), date: mEnd(m.month), ref: `EOS-${m.month}`, notes: `End-of-service provision ${m.month}`,
          lines: [...add(byProj, 5260, 5260, 'debit', 'End-of-service provision'), { acct: 2300, dc: 'credit', amount: round(total), desc: 'End-of-service provision' }] });
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
    if (has('loans')) for (const l of db.prepare('SELECT l.*, e.name FROM loans l JOIN employees e ON e.id=l.employee_id').all()) {
      const d = l.created.slice(0, 10); if (!inR(d)) continue;
      out.push({ kind: 'jv_advance', local_id: l.id, date: d, ref: `ADV-${l.id}`, notes: `Salary advance — ${l.name} (${l.installments} instalments)`,
        lines: [{ acct: 1300, dc: 'debit', amount: l.amount, desc: 'Salary advance' }, { acct: l.method === 'cash' ? 'cash' : 'bank', dc: 'credit', amount: l.amount, desc: l.method === 'cash' ? 'Paid in cash' : 'Paid by bank' }] });
    }
    return out;
  }
  async function pushJournal(cl, j, lk, run) {
    const r0 = rec(j.kind, j.local_id);
    if (j.voided) {                                                                   // invoice cancelled here → its retention journal is removed there
      if (!r0 || !r0.zoho_id || r0.status === 'cancelled') return;
      try { await cl.del('/journals/' + r0.zoho_id); } catch (e) { if (!gone(e)) throw e; }
      mark(j.kind, j.local_id, r0.zoho_id, 'journal', 'cancelled', null, null); run.updated++; return;
    }
    if (j.invoice) { const ir = rec('invoice', j.invoice); if (!ir || ir.status !== 'ok') return; }          // retention follows its invoice: not sent / not updated while the invoice is not in step
    const lines = [];
    for (const l of j.lines.filter(l => l.amount > 0.004)) {
      const acc = l.acct === 'bank' ? (mapOf('account', 'acct:1000') || (lk.bank || {}).account_id) : l.acct === 'cash' ? (mapOf('account', 'acct:1020') || (lk.cash || lk.bank || {}).account_id)
        : l.acct === 'ar' ? (mapOf('account', 'acct:1100') || (lk.ar || {}).account_id) : l.acct === 1150 ? (mapOf('account', 'acct:1150') || (lk.retention || {}).account_id) : mapOf('account', 'acct:' + l.acct);
      if (!acc) throw new Error(`map our account ${l.acct === 'ar' ? '1100 (Accounts receivable)' : l.acct}${LEDGER[l.acct] ? ' (' + LEDGER[l.acct] + ')' : ''} to a Zoho account first`);
      lines.push({ account_id: acc, debit_or_credit: l.dc, amount: round(l.amount), description: l.desc || '', ...(l.customer ? { customer_id: await contactId(cl, l.customer, run) } : {}), ...projectRef(l.project_id) });
    }
    const vals = { journal_date: j.date, reference_number: j.ref.slice(0, 100), notes: j.notes, line_items: lines }, h = hashOf(vals), r = rec(j.kind, j.local_id);
    if (r && r.status === 'ok' && r.zoho_id) {
      if (r.hash === h) return;
      try { await cl.put('/journals/' + r.zoho_id, vals); mark(j.kind, j.local_id, r.zoho_id, 'journal', 'ok', null, h); run.updated++; return; } catch (e) { if (!gone(e)) throw e; }
    }
    const id = (await cl.post('/journals', vals)).journal.journal_id;
    if (cfg().post === '1') await cl.post(`/journals/${id}/status/publish`);
    mark(j.kind, j.local_id, id, 'journal', 'ok', null, h); run.sent++;
  }

  // dry run: real reads when connected (offline stand-ins otherwise), every write is recorded instead of sent
  function dryClient(c) {
    let real = null; try { real = client(c); } catch { /* not connected: offline */ }
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
    return { get, post: write('POST'), put: write('PUT'), offline: !real };
  }

  let running = null;
  async function sync({ trigger = 'manual', user = '', from, to, dryRun = false } = {}) {
    if (running) throw new Error('A sync is already running');
    const c = cfg(); if (!dryRun && c.enabled !== '1') throw new Error('The Zoho link is switched off');
    const run = { sent: 0, updated: 0, failed: 0, skipped: 0, errors: [] }, started = now();
    if (dryRun) dry = { recs: new Map(), ops: [] };
    let offline = false;
    running = (async () => {
      const cl = dryRun ? dryClient(c) : client(c), lk = await lookups(cl); offline = !!cl.offline;
      if (!lk.std) throw new Error('No 5% VAT tax in Zoho Books — set up UAE VAT first');
      const { e, invoices, bills, payments } = data(from || c.start || null, to || today()); run.e = e;
      const each = async (kind, id, label, fn) => { try { await fn(); } catch (err) { run.failed++; run.errors.push(`${label}: ${err.message}`); mark(kind, id, null, null, 'error', err.message.slice(0, 500), null); } };
      for (const i of invoices) await each('invoice', i.id, i.number, async () => {
        if (!i.client_id) throw new Error('invoice project has no client');
        const d = invoiceDoc(i, e), cust = await contactId(cl, i.client_id, run), credit = d.type === 'creditnote';
        const vals = { customer_id: cust, [credit ? 'creditnote_number' : 'invoice_number']: d.number, date: d.date, ...(!credit && d.due ? { due_date: d.due } : {}),
          reference_number: (credit ? d.original : d.project).slice(0, 100), place_of_supply: d.place, is_inclusive_tax: false, notes: d.notes, line_items: lineItems(d.lines, lk, i.project_id) };
        await pushDoc(cl, 'invoice', i.id, d.type, vals, { voided: d.voided, find: { [credit ? 'creditnote_number' : 'invoice_number']: d.number }, label: i.number }, run);
      });
      for (const b of bills) await each('bill', b.id, b.reference || b.description || `#${b.id}`, async () => {
        const d = billDoc(b, e), acct = accountFor(lk, d.category), tax = d.vat > 0.004 ? lk.std : null;
        if (!acct) throw new Error('no expense account in Zoho');
        if (d.type === 'expense') {
          const paid = d.cash ? (lk.cash || lk.bank) : (lk.bank || lk.cash); if (!paid) throw new Error('no bank or cash account in Zoho');
          const vals = { account_id: acct.account_id, paid_through_account_id: paid.account_id, date: d.date, amount: d.amount, ...(tax ? { tax_id: tax.tax_id } : {}), is_inclusive_tax: false,
            reference_number: d.number.slice(0, 100), description: [d.description, d.notes].filter(Boolean).join('\n'), place_of_supply: d.place };
          return pushDoc(cl, 'bill', b.id, 'expense', vals, { label: d.number }, run);
        }
        const vendor = await contactId(cl, b.party_id, run);
        const vals = { vendor_id: vendor, bill_number: d.number, date: d.date, reference_number: d.project.slice(0, 100), place_of_supply: d.place, is_inclusive_tax: false, notes: d.notes,
          line_items: [{ account_id: acct.account_id, description: d.description, quantity: 1, rate: d.amount, ...(tax ? { tax_id: tax.tax_id } : {}), ...projectRef(b.project_id) }] };
        await pushDoc(cl, 'bill', b.id, 'bill', vals, { find: { bill_number: d.number, vendor_id: vendor }, label: d.number }, run);
      });
      for (const p of payments) await each('payment', p.id, `${p.kind === 'in' ? 'receipt' : 'payment'} ${p.reference || '#' + p.id}`, () => pushPayment(cl, p, lk, run));
      for (const j of journals(from || c.start || null, to || today())) await each(j.kind, j.local_id, j.ref, () => pushJournal(cl, j, lk, run));
    })();
    let message = '';
    try { await running; } catch (err) { message = err.message; run.failed++; } finally { running = null; }
    if (!message && run.errors.length) message = run.errors.slice(0, 5).join(' | ');
    if (dryRun) { const ops = dry.ops; dry = null; return { dry_run: true, offline, would_send: run.sent, would_update: run.updated, failed: run.failed, skipped: run.skipped, errors: run.errors, ops: ops.map(({ body, ...o }) => o), payloads: ops.slice(0, 200) }; }
    db.prepare('INSERT INTO zoho_runs(started,finished,trigger,user,sent,updated,failed,skipped,message) VALUES(?,?,?,?,?,?,?,?,?)').run(started, now(), trigger, user, run.sent, run.updated, run.failed, run.skipped, message);
    setCfg('last_run', today());
    return { sent: run.sent, updated: run.updated, failed: run.failed, skipped: run.skipped, message };
  }

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
      const docs = bills.map(b => billDoc(b, e)).filter(d => d.type === kind.slice(0, -1)), tax = d => (d.vat > 0.004 ? 'std' : null);
      const out = kind === 'bills'
        ? [['Bill Number', 'Bill Date', 'Vendor Name', 'Place of Supply', 'Reference Number', 'Notes', 'Account', 'Description', 'Quantity', 'Rate', 'Tax Name', 'Tax %', 'Category']]
        : [['Expense Date', 'Expense Account', 'Paid Through', 'Amount', 'Tax Name', 'Tax %', 'Is Inclusive Tax', 'Reference#', 'Description', 'Place of Supply', 'Category']];
      for (const d of docs) out.push(kind === 'bills'
        ? [d.number, d.date, name(d.party_id), d.place, d.project, d.notes, 'Cost of Goods Sold', d.description, 1, d.amount, tax(d) ? TAX_NAME.std : '', tax(d) ? 5 : '', CAT[d.category] || d.category]
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
        if (body.hour != null && body.hour !== '' && !(+body.hour >= 0 && +body.hour <= 23)) return send(res, 400, { error: 'Hour must be 0–23' }), true;
        if (body.org != null && body.org !== '' && !orgsOf(c).some(o => o.id === String(body.org))) return send(res, 400, { error: 'Unknown organisation' }), true;
        const changed = k => body[k] != null && String(body[k]).trim() !== (c[k] || '');
        if (changed('dc') || changed('client_id')) {                                      // another account → the old sign-in is useless
          for (const k of ['refresh_token', 'api_domain', 'org', 'orgs', 'org_name']) setCfg(k, '');
          Object.keys(tokenCache).forEach(k => delete tokenCache[k]);
        }
        if (changed('org') && c.org) db.exec('DELETE FROM zoho_sync');                    // another organisation → everything is sent again
        for (const k of ['dc', 'client_id', 'org', 'start', 'hour', 'enabled', 'auto', 'post']) if (body[k] !== undefined) setCfg(k, String(body[k]).trim());
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
          if (x.zoho_id) db.prepare('INSERT INTO zoho_map(kind,local_key,zoho_id,label) VALUES(?,?,?,?) ON CONFLICT(kind,local_key) DO UPDATE SET zoho_id=excluded.zoho_id, label=excluded.label').run(x.kind, String(x.local_key), String(x.zoho_id), String(x.label || ''));
          else db.prepare('DELETE FROM zoho_map WHERE kind=? AND local_key=?').run(x.kind, String(x.local_key));
          audit(req, 'update', 'zoho_map', 0, `${x.kind} ${x.local_key} → ${x.zoho_id || '(none)'}`);
          return send(res, 200, { ok: 1 }), true;
        }
        if (m === 'GET') {
          const saved = db.prepare('SELECT * FROM zoho_map').all();
          const local = { accounts: [...Object.entries(CAT).map(([k, v]) => ({ key: 'cat:' + k, label: `Expense category — ${v}` })), ...Object.entries(LEDGER).map(([k, v]) => ({ key: 'acct:' + k, label: `${k} ${v}` })), ...(ctx.bankAccounts ? ctx.bankAccounts() : [{ ledger_code: '1000', name: 'Bank' }]).map(k => ({ key: 'acct:' + k.ledger_code, label: `${k.ledger_code} Bank — ${k.name}${k.ledger_code === '1000' ? ' (also salaries and advances)' : ''}` })), { key: 'acct:1020', label: '1020 Cash (advances paid in cash)' }],
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
      if (m === 'POST' && b === 'retry') { db.prepare("DELETE FROM zoho_sync WHERE status IN ('error','skipped')").run(); return send(res, 200, { ok: true }), true; }
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
