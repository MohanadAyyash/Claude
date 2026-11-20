// In-process mock of Zoho accounts (OAuth Self Client) + Zoho Books API v3, used by test-zoho.js. Development only.
const http = require('http');
function mockZoho() {
  const CLIENT_ID = '1000.TESTCLIENT', CLIENT_SECRET = 'test-secret-xyz', ORG = '900000001';
  let codes = new Set(['1000.code.one']), refresh = new Set(), access = new Set(), seq = 4600000000000, n = 0;
  const id = () => String(++seq);                                                    // Zoho ids are long numeric strings
  const T = { contacts: [], invoices: [], creditnotes: [], bills: [], expenses: [], customerpayments: [], vendorpayments: [], journals: [],
    reporting_tags: [{ tag_id: '7001', tag_name: 'Project', options: [{ option_id: '7101', option_name: 'Villa 12' }, { option_id: '7102', option_name: 'Roads' }] }],
    projects: [{ project_id: '8001', project_name: 'Villa 12 (Zoho project)' }],
    taxes: [{ tax_id: '1001', tax_name: 'Standard Rate', tax_percentage: 5, tax_type: 'tax' }, { tax_id: '1002', tax_name: 'Zero Rate', tax_percentage: 0, tax_type: 'tax' }, { tax_id: '1003', tax_name: 'Exempt', tax_percentage: 0, tax_type: 'tax' }],
    bankaccounts: [{ account_id: '2001', account_name: 'Emirates NBD', account_type: 'bank', is_active: true }, { account_id: '2002', account_name: 'Petty Cash', account_type: 'cash', is_active: true }],
    chartofaccounts: [{ account_id: '3001', account_name: 'Cost of Goods Sold', account_type: 'cost_of_goods_sold' }, { account_id: '3002', account_name: 'Materials', account_type: 'expense' },
      { account_id: '3003', account_name: 'Travel Expense', account_type: 'expense' }, { account_id: '3004', account_name: 'Sales', account_type: 'income' },
      { account_id: '3101', account_name: 'Salaries and Employee Wages', account_type: 'expense' }, { account_id: '3102', account_name: 'Salaries Payable', account_type: 'other_current_liability' },
      { account_id: '3103', account_name: 'Employee Advance', account_type: 'other_current_asset' }, { account_id: '3104', account_name: 'Deductions Payable', account_type: 'other_current_liability' },
      { account_id: '3105', account_name: 'End of Service Expense', account_type: 'expense' }, { account_id: '3106', account_name: 'Provision for End of Service', account_type: 'other_liability' },
      { account_id: '3201', account_name: 'Accounts Receivable', account_type: 'accounts_receivable' }, { account_id: '3202', account_name: 'Retention Receivable', account_type: 'other_current_asset' }] };
  const calls = [], api = { domain: '' };
  const KEY = { journals: ['journal', 'journal_id'], invoices: ['invoice', 'invoice_id', 'invoice_number'], creditnotes: ['creditnote', 'creditnote_id', 'creditnote_number'], bills: ['bill', 'bill_id', 'bill_number'], expenses: ['expense', 'expense_id'], contacts: ['contact', 'contact_id'], customerpayments: ['payment', 'payment_id'], vendorpayments: ['vendorpayment', 'payment_id'] };
  const total = d => Math.round((d.line_items || []).reduce((s, l) => { const t = T.taxes.find(x => x.tax_id === l.tax_id); return s + l.quantity * l.rate * (1 + (t ? t.tax_percentage : 0) / 100); }, 0) * 100) / 100;
  const err = (status, code, message) => Object.assign(new Error(message), { status, code });
  const state = { down: false, failPost: 0, lostPost: 0, failPath: '', tamperJournal: 0, tamperAccount: '' };   // tamper*: Zoho stores something else than it was sent                                                     // outage: every Books request answers 503
  // the ledger postings of what is in the mock (as Zoho would post them): drafts and void documents post nothing
  const acctOf = type => (T.chartofaccounts.find(a => a.account_type === type) || {}).account_id || type.toUpperCase();
  function postings() {
    const out = [], add = (account_id, date, dr, cr, transaction_type, transaction_id, reference_number) => { const r = x => Math.round(x * 100) / 100; if (dr > 0.004 || cr > 0.004) out.push({ account_id, transaction_date: date, debit_amount: r(dr), credit_amount: r(cr), debit_or_credit: dr > 0.004 ? 'debit' : 'credit', transaction_type, transaction_id, reference_number }); };
    const pct = l => (T.taxes.find(x => x.tax_id === l.tax_id) || { tax_percentage: 0 }).tax_percentage, posted = d => !['draft', 'void'].includes(d.status);
    const SALES = (T.chartofaccounts.find(a => a.account_type === 'income') || {}).account_id, IN = acctOf('input_tax'), OUT = acctOf('output_tax'), AR = acctOf('accounts_receivable'), AP = acctOf('accounts_payable');
    for (const [list, type, sign] of [[T.invoices, 'invoice', 1], [T.creditnotes, 'creditnote', -1]]) for (const i of list.filter(posted)) for (const l of i.line_items) {
      const net = l.quantity * l.rate, v = net * pct(l) / 100, id = i.invoice_id || i.creditnote_id;
      add(AR, i.date, sign > 0 ? net + v : 0, sign > 0 ? 0 : net + v, type, id, i.invoice_number || i.creditnote_number); add(l.account_id || SALES, i.date, sign > 0 ? 0 : net, sign > 0 ? net : 0, type, id); add(OUT, i.date, sign > 0 ? 0 : v, sign > 0 ? v : 0, type, id);
    }
    for (const b of T.bills.filter(posted)) for (const l of b.line_items) { const net = l.quantity * l.rate, v = net * pct(l) / 100; add(l.account_id, b.date, net, 0, 'bill', b.bill_id, b.bill_number); add(IN, b.date, v, 0, 'bill', b.bill_id); add(AP, b.date, 0, net + v, 'bill', b.bill_id); }
    for (const x of T.expenses) { const v = x.amount * pct(x) / 100; add(x.account_id, x.date, x.amount, 0, 'expense', x.expense_id, x.reference_number); add(IN, x.date, v, 0, 'expense', x.expense_id); add(x.paid_through_account_id, x.date, 0, x.amount + v, 'expense', x.expense_id); }
    for (const x of T.customerpayments) { add(x.account_id, x.date, x.amount, 0, 'customer_payment', x.payment_id, x.reference_number); add(AR, x.date, 0, x.amount, 'customer_payment', x.payment_id); }
    for (const x of T.vendorpayments) { add(AP, x.date, x.amount, 0, 'vendor_payment', x.payment_id, x.reference_number); add(x.paid_through_account_id, x.date, 0, x.amount, 'vendor_payment', x.payment_id); }
    for (const o of T.opening || []) add(o.account_id, o.date, o.debit || 0, o.credit || 0, 'opening_balance', 'OB-' + o.account_id);   // opening balances entered in Zoho
    for (const j of T.journals.filter(j => j.status === 'published')) for (const l of j.line_items) add(l.account_id, j.journal_date, l.debit_or_credit === 'debit' ? l.amount : 0, l.debit_or_credit === 'credit' ? l.amount : 0, 'journal', j.journal_id, j.reference_number);
    return out;
  }

  function books(method, path, q, body) {
    const p = path.split('/').filter(Boolean);                                       // e.g. ['invoices', '46…', 'status', 'sent']
    calls.push(`${method} /${p.map(x => (/^\d{6,}$/.test(x) ? ':id' : x)).join('/')}`);
    if (p[0] === 'organizations') return { organizations: [{ organization_id: ORG, name: 'Trigon Civil Road Contracting', currency_code: 'AED' }] };
    if (q.get('organization_id') !== ORG) throw err(400, 6041, 'Invalid value passed for organization_id');
    if (p[0] === 'settings' && p[1] === 'taxes') return { taxes: T.taxes };
    if (p[0] === 'bankaccounts' || (p[0] === 'chartofaccounts' && p.length === 1 && method === 'GET'))
      return { [p[0]]: q.get('filter_by') === 'AccountType.Active' ? T[p[0]].filter(a => a.is_active !== false) : T[p[0]] };
    if (p[0] === 'chartofaccounts' && p[1] === 'accounttransactions' && method === 'GET') {   // "list of transactions for an account" — only posted documents
      const from = q.get('date_start') || '0000', to = q.get('date_end') || '9999', per = +q.get('per_page') || 200, page = +q.get('page') || 1;
      const rows = postings().filter(x => x.account_id === q.get('account_id') && x.transaction_date >= from && x.transaction_date <= to);
      return { transactions: rows.slice((page - 1) * per, page * per), page_context: { page, per_page: per, has_more_page: rows.length > page * per } };
    }
    if (p[0] === 'chartofaccounts' && p.length === 2 && method === 'GET') {
      const a = T.chartofaccounts.concat(T.bankaccounts).find(x => x.account_id === p[1]); if (!a) throw err(404, 1002, 'Account does not exist.');
      return { ...a };                                                                // "get an account": the fields at the top level
    }
    if (p[0] === 'chartofaccounts' && p.length === 1 && method === 'POST') {           // create an account: unique name and code; a sub-account has its parent's type
      const all = T.chartofaccounts.concat(T.bankaccounts);
      if (!body.account_name || !body.account_type) throw err(400, 2, 'account_name and account_type are required');
      if (all.some(a => String(a.account_name).toLowerCase() === String(body.account_name).toLowerCase())) throw err(400, 11002, 'An account with this name already exists.');
      if (body.account_code && all.some(a => a.account_code === body.account_code)) throw err(400, 11003, 'An account with this code already exists.');
      if (body.parent_account_id) { const par = all.find(a => a.account_id === body.parent_account_id); if (!par) throw err(400, 11004, 'Invalid parent account'); if (par.account_type !== body.account_type) throw err(400, 11005, 'A sub-account must have the type of its parent'); body.parent_account_name = par.account_name; }
      const a = { account_id: id(), is_active: true, ...body }; if (state.tamperAccount) { a.account_type = state.tamperAccount; state.tamperAccount = ''; }
      T.chartofaccounts.push(a); return { chart_of_account: a };
    }
    if (p[0] === 'chartofaccounts') throw err(405, 5, 'not supported by the mock');
    if (p[0] === 'reportingtags' && p.length === 1) return { reporting_tags: T.reporting_tags.map(({ options, ...t }) => t) };
    if (p[0] === 'reportingtags' && p[2] === 'options') return { results: (T.reporting_tags.find(t => t.tag_id === p[1]) || { options: [] }).options.map(o => ({ ...o, depth: 0 })) };
    if (p[0] === 'projects' && method === 'GET') return { projects: T.projects };
    if (p[0] === 'journals' && (method === 'POST' || method === 'PUT') && p.length <= 2) {          // a journal must balance and use known accounts
      const ls = body.line_items || [], dr = ls.filter(l => l.debit_or_credit === 'debit').reduce((s, l) => s + l.amount, 0), cr = ls.filter(l => l.debit_or_credit === 'credit').reduce((s, l) => s + l.amount, 0);
      if (!body.journal_date) throw err(400, 2, 'journal_date required');
      if (Math.abs(dr - cr) > 0.005) throw err(400, 4, `Debits (${dr}) and credits (${cr}) do not match`);
      if (ls.some(l => !T.chartofaccounts.concat(T.bankaccounts).some(a => a.account_id === l.account_id))) throw err(400, 4, 'Invalid account');
    }
    const tb = T[p[0]], [one, idf, numf] = KEY[p[0]] || [];
    if (!tb) throw err(404, 5, 'Invalid URL Passed');
    if ((p[0] === 'customerpayments' || p[0] === 'vendorpayments') && method !== 'GET') {
      const inbound = p[0] === 'customerpayments', docs = inbound ? T.invoices : T.bills;
      if (method === 'DELETE' && p.length === 2) {                                      // deleting a payment gives the balance back to its documents
        const row = tb.find(r => r.payment_id === p[1]); if (!row) throw err(404, 1002, 'Payment does not exist.');
        for (const l of (inbound ? row.invoices : row.bills) || []) { const d = docs.find(x => x[inbound ? 'invoice_id' : 'bill_id'] === l[inbound ? 'invoice_id' : 'bill_id']); if (d) { d.balance = Math.round((d.balance + l.amount_applied) * 100) / 100; d.status = d.balance >= d.total - 0.004 ? 'sent' : 'partially_paid'; } }
        tb.splice(tb.indexOf(row), 1); return { message: 'deleted' };
      }
      const links = (inbound ? body.invoices : body.bills) || [];
      if (!body[inbound ? 'customer_id' : 'vendor_id'] || !(body.amount > 0)) throw err(400, 4, 'Invalid payment');
      for (const l of links) {
        const d = docs.find(x => x[inbound ? 'invoice_id' : 'bill_id'] === l[inbound ? 'invoice_id' : 'bill_id']);
        if (!d) throw err(404, 1002, 'Document does not exist.');
        if (d.status === 'draft') throw err(400, 1035, 'Payments cannot be recorded for draft documents');
        if (l.amount_applied > d.balance + 0.001) throw err(400, 1036, 'Amount applied exceeds the balance');
        d.balance = Math.round((d.balance - l.amount_applied) * 100) / 100; d.status = d.balance <= 0.004 ? 'paid' : 'partially_paid';
      }
      const row = { payment_id: id(), ...body }; tb.push(row); return { [inbound ? 'payment' : 'vendorpayment']: row };
    }
    if (method === 'GET' && p.length === 1) {
      let rows = tb;
      for (const [k, v] of q) if (k !== 'organization_id') rows = rows.filter(r => String(r[k]) === v);
      return { [p[0]]: rows };
    }
    const row = p[1] && tb.find(r => r[idf] === p[1]);
    if (p[1] && !row) throw err(404, 1002, `${one} does not exist.`);
    if (method === 'GET') return { [one]: row };
    if (method === 'DELETE' && p.length === 2) { tb.splice(tb.indexOf(row), 1); return { message: 'deleted' }; }
    if (method === 'POST' && p.length === 1) {
      if (numf && body[numf] && q.get('ignore_auto_number_generation') !== 'true') throw err(400, 4097, 'Auto number generation is enabled; pass ignore_auto_number_generation');
      if (numf && tb.some(r => r[numf] === body[numf] && (p[0] !== 'bills' || r.vendor_id === body.vendor_id))) throw err(400, 1001, `${numf} already exists`);
      if (p[0] === 'invoices' || p[0] === 'creditnotes') { if (!body.customer_id) throw err(400, 2, 'customer_id required'); if (!body.place_of_supply) throw err(400, 2, 'place_of_supply required'); }
      if (p[0] === 'bills' && (!body.vendor_id || body.line_items.some(l => !l.account_id))) throw err(400, 2, 'vendor and account required');
      if (p[0] === 'expenses' && (!body.account_id || !body.paid_through_account_id)) throw err(400, 2, 'account required');
      if (p[0] === 'contacts' && tb.some(r => r.contact_name === body.contact_name)) throw err(400, 3062, 'Contact name already exists');
      const r = { [idf]: id(), ...body, status: p[0] === 'contacts' ? 'active' : p[0] === 'expenses' ? 'nonbillable' : 'draft' };
      if (p[0] === 'journals') { if (state.tamperJournal > 0) { state.tamperJournal--; r.line_items = r.line_items.map(l => ({ ...l, amount: Math.round((l.amount + 1) * 100) / 100 })); } tb.push(r); return { journal: r }; }
      if (p[0] === 'contacts') r.contact_persons = (body.contact_persons || []).map(cp => ({ contact_person_id: id(), ...cp }));
      if (one !== 'contact' && one !== 'expense') r.total = r.balance = total(r);
      tb.push(r); return { [one]: r };
    }
    if (method === 'PUT' && p.length === 2) {
      if (['paid', 'partially_paid', 'void', 'closed'].includes(row.status) && one !== 'contact') throw err(400, 1040, 'Paid or void documents cannot be edited');
      const v = { ...body };
      if (one === 'contact' && v.contact_persons) {
        for (const cp of v.contact_persons) { const old = row.contact_persons.find(x => x.contact_person_id === cp.contact_person_id); if (old) Object.assign(old, cp); else row.contact_persons.push({ contact_person_id: id(), ...cp }); }
        delete v.contact_persons;
      }
      Object.assign(row, v); if (one !== 'contact' && one !== 'expense') row.total = row.balance = total(row);
      return { [one]: row };
    }
    if (method === 'POST' && p[2] === 'status') {
      if (p[3] === 'void') { if (['paid', 'partially_paid'].includes(row.status)) throw err(400, 1041, 'Paid documents cannot be voided'); row.status = 'void'; }
      else row.status = p[3] === 'publish' ? 'published' : p[3];
      return { message: 'status changed' };
    }
    throw err(404, 5, 'Invalid URL Passed');
  }

  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => (b += c)); req.on('end', () => {
      const out = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      const u = new URL(req.url, 'http://x');
      if (u.pathname === '/oauth/v2/token') {
        const f = new URLSearchParams(b);
        if (f.get('client_id') !== CLIENT_ID || f.get('client_secret') !== CLIENT_SECRET) return out(200, { error: 'invalid_client' });
        const at = 'at-' + ++n;
        if (f.get('grant_type') === 'authorization_code') {
          if (!codes.delete(f.get('code'))) return out(200, { error: 'invalid_code' });                 // one-time code
          const rt = 'rt-' + n; refresh.add(rt); access.add(at);
          return out(200, { access_token: at, refresh_token: rt, api_domain: api.domain, token_type: 'Bearer', expires_in: 3600 });
        }
        if (f.get('grant_type') === 'refresh_token' && refresh.has(f.get('refresh_token'))) { access.add(at); return out(200, { access_token: at, api_domain: api.domain, token_type: 'Bearer', expires_in: 3600 }); }
        return out(200, { error: 'invalid_code' });
      }
      if (u.pathname === '/oauth/v2/token/revoke') { refresh.delete(u.searchParams.get('token')); return out(200, { status: 'success' }); }
      const m = /^\/books\/v3(\/.*)$/.exec(u.pathname);
      if (m && state.down) { calls.push(`${req.method} (down) ${m[1]}`); return out(503, { code: 503, message: 'Service temporarily unavailable' }); }
      // one request fails: failPost — refused before anything is done; lostPost — done, but the answer is lost (as on a timeout)
      const failing = m && req.method === 'POST' && (!state.failPath || m[1].startsWith(state.failPath));
      if (failing && state.failPost > 0) { state.failPost--; calls.push(`POST (failed) ${m[1]}`); return out(503, { code: 503, message: 'Service temporarily unavailable' }); }
      if (failing && state.lostPost > 0) { state.lostPost--; try { books(req.method, m[1], u.searchParams, b ? JSON.parse(b) : {}); } catch { /* the caller never learns */ } calls.push(`POST (answer lost) ${m[1]}`); return out(503, { code: 503, message: 'Gateway timeout' }); }
      if (!m) return out(404, { code: 5, message: 'Invalid URL Passed' });
      const tok = /^Zoho-oauthtoken (.+)$/.exec(req.headers.authorization || '');
      if (!tok || !access.has(tok[1])) return out(401, { code: 57, message: 'You are not authorized to perform this operation' });
      try { out(200, { code: 0, message: 'success', ...books(req.method, m[1], u.searchParams, b ? JSON.parse(b) : {}) }); }
      catch (e) { out(e.status || 500, { code: e.code || 1, message: e.message }); }
    });
  });
  srv.on('listening', () => { api.domain = `http://127.0.0.1:${srv.address().port}`; });
  return { srv, T, calls, CLIENT_ID, CLIENT_SECRET, ORG, state, postings,
    newCode: () => { const c = '1000.code.' + ++n; codes.add(c); return c; },
    expireAccessTokens: () => access.clear(),
    get accountsUrl() { return api.domain; } };
}
module.exports = mockZoho;
