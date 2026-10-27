// Central role-based access table. Enforced on the server for every API call.
// Contracting roles: site engineer (progress, site diary, crews, material requests), foreman (crew attendance, site diary),
// quantity surveyor (BOQ, variations, quotations, tenders, subcontract valuations), procurement (suppliers, RFQs, POs, stock),
// storekeeper (stock and deliveries). Site roles never see money (contract values, costs, profit).
const FIN = ['admin', 'accountant'];
const OPS = ['admin', 'accountant', 'manager'];
const READERS = ['admin', 'accountant', 'manager', 'viewer'];
const HR = ['admin', 'hr'];
const SITE = ['site_engineer', 'foreman'];
const MONEY = [...READERS, 'qs'];                                          // may see contract values, costs, margins
const ROLES = ['admin', 'accountant', 'manager', 'qs', 'site_engineer', 'foreman', 'procurement', 'storekeeper', 'hr', 'viewer', 'employee'];
const STAFF = ROLES.filter(r => r !== 'employee');

// resource: [roles that can read, roles that can write]
const ACL = {
  parties: [[...READERS, 'qs', 'procurement'], [...OPS, 'procurement']], projects: [[...READERS, 'hr', 'qs', ...SITE, 'procurement', 'storekeeper'], OPS],
  quotes: [MONEY, [...OPS, 'qs']], invoices: [MONEY, FIN], bills: [[...READERS, 'procurement'], FIN], payments: [READERS, FIN],
  boq_items: [[...MONEY, 'site_engineer'], [...OPS, 'qs', 'site_engineer']], variations: [[...MONEY, 'site_engineer'], [...OPS, 'qs']],
  site_reports: [[...READERS, 'qs', ...SITE], [...OPS, ...SITE]],
  purchase_orders: [[...READERS, 'procurement', 'storekeeper'], [...OPS, 'procurement']], rfqs: [[...READERS, 'procurement', 'site_engineer'], [...OPS, 'procurement', 'site_engineer']],
  subcontracts: [[...MONEY, 'procurement'], [...OPS, 'qs']], sub_certs: [MONEY, [...OPS, 'qs']],
  stock_items: [[...READERS, 'procurement', 'storekeeper', 'site_engineer'], [...OPS, 'procurement', 'storekeeper']], stock_moves: [[...READERS, 'procurement', 'storekeeper', 'site_engineer'], [...OPS, 'procurement', 'storekeeper']],
  fixed_assets: [[...FIN, 'manager'], FIN], petty_topups: [FIN, FIN],
  employees: [['admin', 'accountant', 'hr'], HR], payroll: [['admin', 'accountant', 'hr'], ['admin', 'accountant', 'hr']],
  leave_requests: [HR, HR], hr_requests: [HR, HR], attendance: [['admin', 'hr', 'manager', ...SITE], ['admin', 'hr', 'manager', ...SITE]], hr: [HR, HR], letters: [HR, HR],
  accounts: [FIN, FIN], journal_entries: [FIN, FIN], ledger: [FIN, FIN], bank: [FIN, FIN], financials: [FIN, FIN],
  dashboard: [READERS, []], 'project-summary': [MONEY, []], vat: [['admin', 'accountant', 'viewer'], []], 'corporate-tax': [FIN, []], compliance: [FIN, []], einvoice: [FIN, []],
  zoho: [FIN, FIN], aging: [READERS, []], statement: [READERS, FIN], tenders: [MONEY, [...OPS, 'qs']],
  audit: [['admin'], []], backup: [['admin'], []], users: [['admin', 'hr'], ['admin', 'hr']],
};

function can(role, method, a, b, c) {
  const read = method === 'GET';
  if (role === 'admin') return true;
  if (['push', 'notifications', 'approvals', 'tasks', 'notes'].includes(a)) return true;   // own devices/inbox/tasks; the modules check each record
  if (role === 'employee') return ['me', 'password', 'profile'].includes(a) || (a === 'brand' && read) || (a === 'settings' && read);
  if (a === 'password' || a === 'documents' || a === 'profile') return true;                 // documents enforce per-entity rules in their own module
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
  if (a === 'invoices' && c === 'void') return false;                                      // voiding a tax invoice: administrator only (others issue a credit note)
  if (c === 'progress-invoice' || c === 'advance-invoice' || c === 'approve') return FIN.includes(role);
  if (a === 'projects' && ['contract', 'budget', 'updates'].includes(c)) return read ? MONEY.includes(role) : OPS.includes(role);   // money views of a project
  return read ? rule[0].includes(role) : rule[1].includes(role);
}
module.exports = { can, ACL, ROLES, STAFF, FIN, OPS, READERS, HR, SITE, MONEY };
