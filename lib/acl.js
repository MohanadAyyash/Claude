// Central role-based access table. Enforced on the server for every API call.
const FIN = ['admin', 'accountant'];
const OPS = ['admin', 'accountant', 'manager'];
const READERS = ['admin', 'accountant', 'manager', 'viewer'];
const HR = ['admin', 'hr'];
const ROLES = ['admin', 'accountant', 'manager', 'hr', 'viewer', 'employee'];

// resource: [roles that can read, roles that can write]
const ACL = {
  parties: [READERS, OPS], projects: [[...READERS, 'hr'], OPS], quotes: [READERS, OPS], invoices: [READERS, FIN], bills: [READERS, FIN], payments: [READERS, FIN],
  boq_items: [READERS, OPS], variations: [READERS, OPS], site_reports: [READERS, OPS],
  purchase_orders: [READERS, OPS], rfqs: [READERS, OPS], subcontracts: [READERS, OPS], sub_certs: [READERS, OPS],
  stock_items: [READERS, OPS], stock_moves: [READERS, OPS], fixed_assets: [[...FIN, 'manager'], FIN], petty_topups: [FIN, FIN],
  employees: [['admin', 'accountant', 'hr'], HR], payroll: [['admin', 'accountant', 'hr'], ['admin', 'accountant', 'hr']],
  leave_requests: [HR, HR], hr_requests: [HR, HR], attendance: [['admin', 'hr', 'manager'], ['admin', 'hr', 'manager']], hr: [HR, HR], letters: [HR, HR],
  accounts: [FIN, FIN], journal_entries: [FIN, FIN], ledger: [FIN, FIN], bank: [FIN, FIN], financials: [FIN, FIN],
  dashboard: [READERS, []], 'project-summary': [READERS, []], vat: [['admin', 'accountant', 'viewer'], []], 'corporate-tax': [FIN, []], compliance: [FIN, []], einvoice: [FIN, []],
  audit: [['admin'], []], backup: [['admin'], []], users: [['admin', 'hr'], ['admin', 'hr']],
};

function can(role, method, a, b, c) {
  const read = method === 'GET';
  if (role === 'admin') return true;
  if (role === 'employee') return ['me', 'password'].includes(a) || (a === 'brand' && read) || (a === 'settings' && read);
  if (a === 'password' || a === 'documents') return true;                 // documents enforce per-entity rules in their own module
  if (a === 'brand') return read;
  if (a === 'settings') return read && b !== 'test-email';
  if (a === 'me') return false;                                           // self-service endpoints are for linked employee accounts only
  // printable documents and exports follow the read rule of the underlying resource
  if (a === 'doc' || a === 'export') {
    const target = a === 'doc' ? b : b;
    const rule = ACL[target] || ACL[{ trial_balance: 'ledger', journal: 'ledger', financials: 'ledger', assets: 'fixed_assets', stock: 'stock_items', payslips: 'payroll' }[target]];
    if (target === 'letter') return HR.includes(role);
    return !!rule && rule[0].includes(role);
  }
  const rule = ACL[a];
  if (!rule) return false;
  if (c === 'progress-invoice' || c === 'approve') return FIN.includes(role);
  return read ? rule[0].includes(role) : rule[1].includes(role);
}
module.exports = { can, ACL, ROLES, FIN, OPS, READERS, HR };
