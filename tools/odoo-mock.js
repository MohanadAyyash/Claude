// In-process mock of the Odoo external API (JSON-RPC, and JSON-2 from v19) used by test-odoo.js. Development only.
const http = require('http');
function mockOdoo(major) {
  const KEY = 'odoo-api-key-123', DB = 'trigon', LOGIN = 'admin@trigon.ae';
  const T = { 'res.partner': [], 'account.move': [], 'account.payment': [],
    'account.tax': [{ id: 1, name: '5% VAT (sales)', amount: 5, amount_type: 'percent', type_tax_use: 'sale', active: true }, { id: 2, name: '5% VAT (purchases)', amount: 5, amount_type: 'percent', type_tax_use: 'purchase', active: true }],
    'account.journal': [{ id: 1, name: 'Customer Invoices', type: 'sale', code: 'INV' }, { id: 2, name: 'Vendor Bills', type: 'purchase', code: 'BILL' }, { id: 3, name: 'Bank', type: 'bank', code: 'BNK1' }, { id: 4, name: 'Cash', type: 'cash', code: 'CSH1' }] };
  let seq = 100; const calls = [];
  const match = (r, dom) => dom.every(([f, op, v]) => op === '=' ? r[f] === v : op === 'in' ? v.includes(r[f]) : true);
  function exec(model, method, args, kw) {
    calls.push(`${model}.${method}`); const t = T[model]; if (!t) throw new Error('unknown model ' + model);
    if (method === 'search_read') { const rows = t.filter(r => match(r, args[0])); return (kw.limit ? rows.slice(0, kw.limit) : rows).map(r => Object.fromEntries((kw.fields || Object.keys(r)).map(f => [f, r[f]]))); }
    if (method === 'create') {
      const v = { ...args[0] };
      if (model === 'account.move' && !v.partner_id) throw new Error('partner required');
      if (model === 'account.payment' && major >= 18 && 'ref' in v) throw new Error("Invalid field 'ref' on model 'account.payment'");
      if (model === 'account.move') v.lines = (v.invoice_line_ids || []).map(c => c[2]), delete v.invoice_line_ids;
      const row = { id: ++seq, state: 'draft', ...v }; t.push(row); return row.id;
    }
    if (method === 'write') { for (const id of args[0]) { const r = t.find(x => x.id === id); const v = { ...args[1] }; if (v.invoice_line_ids) { r.lines = v.invoice_line_ids.filter(c => c[0] === 0).map(c => c[2]); delete v.invoice_line_ids; } Object.assign(r, v); } return true; }
    const r = t.find(x => x.id === args[0][0]);
    if (method === 'action_post') return (r.state = 'posted'), true;
    if (method === 'button_draft') return (r.state = 'draft'), true;
    if (method === 'button_cancel') return (r.state = 'cancel'), true;
    throw new Error('unknown method ' + method);
  }
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => (b += c)); req.on('end', () => {
      const out = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      const body = JSON.parse(b || '{}');
      if (req.url === '/jsonrpc') {
        const { service, method, args } = body.params;
        try {
          if (service === 'common' && method === 'version') return out(200, { result: { server_version: `${major}.0`, server_version_info: [major, 0, 0, 'final', 0, ''] } });
          if (service === 'common' && method === 'authenticate') return out(200, { result: args[0] === DB && args[1] === LOGIN && args[2] === KEY ? 2 : false });
          if (major >= 20) return out(200, { error: { message: 'JSON-RPC removed' } });
          if (args[2] !== KEY) return out(200, { error: { message: 'Access Denied' } });
          const [, , , model, m, a, kw] = args; return out(200, { result: exec(model, m, a, kw || {}) });
        } catch (e) { return out(200, { error: { message: 'Odoo Server Error', data: { message: e.message } } }); }
      }
      const m = /^\/json\/2\/([^/]+)\/([^/]+)$/.exec(req.url);
      if (m && major >= 19) {
        if (req.headers.authorization !== 'bearer ' + KEY || req.headers['x-odoo-database'] !== DB) return out(401, { message: 'Invalid apikey' });
        const named = body, method = m[2], args = method === 'search_read' ? [named.domain] : method === 'create' ? [named.vals_list[0]] : method === 'write' ? [named.ids, named.vals] : [named.ids];
        try { const r = exec(m[1], method, args, named); return out(200, method === 'create' ? [r] : r); } catch (e) { return out(422, { message: e.message }); }
      }
      out(404, { message: 'not found' });
    });
  });
  return { srv, T, calls, KEY, DB, LOGIN };
}

module.exports = mockOdoo;
