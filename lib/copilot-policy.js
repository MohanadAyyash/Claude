const SENSITIVE_FIELDS = new Set([
  'password', 'passwordhash', 'salt', 'hash', 'token', 'accesstoken', 'refreshtoken', 'idtoken',
  'secret', 'clientsecret', 'apikey', 'authorization', 'authorizationcode', 'privatekey', 'encryptionkey',
  'cookie', 'sessioncookie', 'sessiontoken', 'setuptoken', 'totp', 'totpsecret', 'webhook', 'webhookurl',
  'teamswebhookurl', 'connectionstring', 'iban', 'bankaccount', 'bankaccountnumber', 'accountnumber',
  'accountno', 'routingcode', 'routingnumber', 'swift', 'emiratesid', 'nationalid', 'passportno',
  'passport', 'nationality', 'dateofbirth', 'address', 'homeaddress', 'personaladdress', 'phone',
  'mobile', 'homephone', 'personalphone', 'email', 'medical', 'medicalinfo', 'medicalrecord',
  'basic', 'housing', 'otherallowance', 'salary', 'bankname', 'notes', 'decisionnote',
  'filename', 'weburl', 'sharepointurl', 'error', 'data', 'auditdetail', 'securitydetail',
]);
const SENSITIVE_TOKENS = new Set([
  'password', 'passwd', 'hash', 'salt', 'token', 'secret', 'key', 'authorization', 'cookie', 'totp',
  'webhook', 'iban', 'bank', 'account', 'routing', 'swift', 'emiratesid', 'nationalid', 'passport',
  'nationality', 'salary', 'payroll', 'wps', 'allowance', 'address', 'medical', 'phone', 'mobile',
  'email', 'note', 'notes', 'filename', 'weburl', 'sharepoint', 'error', 'data', 'audit', 'security',
  'detail', 'details',
]);

function isSensitive(field) {
  const words = field.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return SENSITIVE_FIELDS.has(words.join('')) || words.some(word => SENSITIVE_TOKENS.has(word));
}

function sanitize(value, depth = 0) {
  if (depth > 8) return null;
  if (Array.isArray(value)) return value.map(item => sanitize(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([field]) => !isSensitive(field))
    .map(([field, item]) => [field, sanitize(item, depth + 1)]));
}

function project(row, fields) {
  if (!row || typeof row !== 'object' || !Array.isArray(fields)) return {};
  return Object.fromEntries(fields
    .filter(field => typeof field === 'string' && !isSensitive(field))
    .filter(field => Object.hasOwn(row, field))
    .map(field => [field, sanitize(row[field])]));
}

module.exports = { project };
