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
      { account_id: '3105', account_name: 'End of Service Expense', account_type: 'expense' }, { account_id: '3106', account_name: 'Provision for End of Service', account_type: 'other_liability' }] };
  const calls = [], api = { domain: '' };
  const KEY = { journals: ['journal', 'journal_id'], invoices: ['invoice', 'invoice_id', 'invoice_number'], creditnotes: ['creditnote', 'creditnote_id', 'creditnote_number'], bills: ['bill', 'bill_id', 'bill_number'], expenses: ['expense', 'expense_id'], contacts: ['contact', 'contact_id'] };
  const total = d => Math.round((d.line_items || []).reduce((s, l) => { const t = T.taxes.find(x => x.tax_id === l.tax_id); return s + l.quantity * l.rate * (1 + (t ? t.tax_percentage : 0) / 100); }, 0) * 100) / 100;
  const err = (status, code, message) => Object.assign(new Error(message), { status, code });

  function books(method, path, q, body) {
    const p = path.split('/').filter(Boolean);                                       // e.g. ['invoices', '46…', 'status', 'sent']
    calls.push(`${method} /${p.map(x => (/^\d{6,}$/.test(x) ? ':id' : x)).join('/')}`);
    if (p[0] === 'organizations') return { organizations: [{ organization_id: ORG, name: 'Trigon Civil Road Contracting', currency_code: 'AED' }] };
    if (q.get('organization_id') !== ORG) throw err(400, 6041, 'Invalid value passed for organization_id');
    if (p[0] === 'settings' && p[1] === 'taxes') return { taxes: T.taxes };
    if (p[0] === 'bankaccounts' || p[0] === 'chartofaccounts') return { [p[0]]: T[p[0]] };
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
    if (p[0] === 'customerpayments' || p[0] === 'vendorpayments') {
      const inbound = p[0] === 'customerpayments', docs = inbound ? T.invoices : T.bills, links = (inbound ? body.invoices : body.bills) || [];
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
    if (method === 'POST' && p.length === 1) {
      if (numf && body[numf] && q.get('ignore_auto_number_generation') !== 'true') throw err(400, 4097, 'Auto number generation is enabled; pass ignore_auto_number_generation');
      if (numf && tb.some(r => r[numf] === body[numf] && (p[0] !== 'bills' || r.vendor_id === body.vendor_id))) throw err(400, 1001, `${numf} already exists`);
      if (p[0] === 'invoices' || p[0] === 'creditnotes') { if (!body.customer_id) throw err(400, 2, 'customer_id required'); if (!body.place_of_supply) throw err(400, 2, 'place_of_supply required'); }
      if (p[0] === 'bills' && (!body.vendor_id || body.line_items.some(l => !l.account_id))) throw err(400, 2, 'vendor and account required');
      if (p[0] === 'expenses' && (!body.account_id || !body.paid_through_account_id)) throw err(400, 2, 'account required');
      if (p[0] === 'contacts' && tb.some(r => r.contact_name === body.contact_name)) throw err(400, 3062, 'Contact name already exists');
      const r = { [idf]: id(), ...body, status: p[0] === 'contacts' ? 'active' : p[0] === 'expenses' ? 'nonbillable' : 'draft' };
      if (p[0] === 'journals') { tb.push(r); return { journal: r }; }
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
      else row.status = p[3];
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
      if (!m) return out(404, { code: 5, message: 'Invalid URL Passed' });
      const tok = /^Zoho-oauthtoken (.+)$/.exec(req.headers.authorization || '');
      if (!tok || !access.has(tok[1])) return out(401, { code: 57, message: 'You are not authorized to perform this operation' });
      try { out(200, { code: 0, message: 'success', ...books(req.method, m[1], u.searchParams, b ? JSON.parse(b) : {}) }); }
      catch (e) { out(e.status || 500, { code: e.code || 1, message: e.message }); }
    });
  });
  srv.on('listening', () => { api.domain = `http://127.0.0.1:${srv.address().port}`; });
  return { srv, T, calls, CLIENT_ID, CLIENT_SECRET, ORG,
    newCode: () => { const c = '1000.code.' + ++n; codes.add(c); return c; },
    expireAccessTokens: () => access.clear(),
    get accountsUrl() { return api.domain; } };
}
module.exports = mockZoho;
