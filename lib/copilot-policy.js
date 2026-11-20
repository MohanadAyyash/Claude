const SENSITIVE_FIELDS = new Set([
  'password', 'password_hash', 'salt', 'hash', 'token', 'access_token', 'refresh_token', 'secret', 'api_key',
  'authorization', 'iban', 'emirates_id', 'passport_no', 'passport', 'nationality', 'phone', 'email',
  'basic', 'housing', 'other_allowance', 'salary', 'bank_name', 'routing_code', 'notes', 'decision_note',
  'file_name', 'web_url', 'sharepoint_url', 'error', 'data', 'totp_secret', 'session_token',
]);

function project(row, fields) {
  if (!row || typeof row !== 'object' || !Array.isArray(fields)) return {};
  return Object.fromEntries(fields
    .filter(field => typeof field === 'string' && !SENSITIVE_FIELDS.has(field.toLowerCase()))
    .filter(field => Object.hasOwn(row, field))
    .map(field => [field, row[field]]));
}

module.exports = { project };
