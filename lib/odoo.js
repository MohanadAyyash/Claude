// Minimal Odoo external-API client (no dependencies).
//   'jsonrpc' : /jsonrpc + execute_kw (Odoo 8 … 19; deprecated from 19, scheduled for removal in 20)
//   'json2'   : /json/2/<model>/<method> with a bearer API key (Odoo 19+)
//   'auto'    : asks the server for its version and picks json2 from Odoo 20, jsonrpc before that
// Authentication always uses an API key (Odoo: avatar → My Profile / Preferences → Account Security → New API Key), never the login password.
function createClient({ url, db, login, key, api = 'auto', timeout = 30000 }) {
  const base = String(url || '').replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]+/.test(base)) throw new Error('Odoo URL must start with https://');
  let uid = null, mode = api, version = null;

  async function post(path, body, headers = {}) {
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), timeout);
    let r;
    try { r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ac.signal }); }
    catch (e) { throw new Error(`Odoo unreachable (${base}): ${e.name === 'AbortError' ? 'timeout' : e.message}`); }
    finally { clearTimeout(t); }
    const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch { /* not json */ }
    if (!r.ok) throw new Error(`Odoo HTTP ${r.status}: ${(j && (j.message || j.error?.message || j.name)) || text.slice(0, 200)}`);
    return j;
  }
  async function rpc(service, method, args) {
    const j = await post('/jsonrpc', { jsonrpc: '2.0', method: 'call', id: Date.now(), params: { service, method, args } });
    if (j && j.error) throw new Error('Odoo: ' + (j.error.data?.message || j.error.message || 'error'));
    return j ? j.result : null;
  }
  async function info() {
    if (!version) { const v = await rpc('common', 'version', []); version = v || {}; }
    const major = (version.server_version_info || [])[0] || parseInt(version.server_version, 10) || 0;
    if (mode === 'auto') mode = major >= 20 ? 'json2' : 'jsonrpc';
    return { version: version.server_version || String(major), major, api: mode };
  }
  async function auth() {
    await info();
    if (mode === 'json2') return null;
    if (uid == null) {
      uid = await rpc('common', 'authenticate', [db, login, key, {}]);
      if (!uid) throw new Error('Odoo rejected the login or API key (check database name, login e-mail and API key)');
    }
    return uid;
  }
  // positional args of execute_kw → named args of JSON-2
  const NAMED = { search_read: ['domain'], search: ['domain'], create: ['vals_list'], write: ['ids', 'vals'], read: ['ids', 'fields'], unlink: ['ids'] };
  async function call(model, method, args = [], kwargs = {}) {
    await auth();
    if (mode === 'json2') {
      const names = NAMED[method] || ['ids'], body = { ...kwargs };
      args.forEach((a, i) => { body[names[i] || 'arg' + i] = a; });
      if (method === 'create' && body.vals_list && !Array.isArray(body.vals_list)) body.vals_list = [body.vals_list];
      const res = await post(`/json/2/${model}/${method}`, body, { Authorization: 'bearer ' + key, 'X-Odoo-Database': db });
      return method === 'create' && Array.isArray(res) && !Array.isArray(args[0]) ? res[0] : res;
    }
    return rpc('object', 'execute_kw', [db, uid, key, model, method, args, kwargs]);
  }
  return {
    info, auth, call,
    searchRead: (model, domain, fields, limit = 0) => call(model, 'search_read', [domain], { fields, ...(limit ? { limit } : {}) }),
    create: (model, vals) => call(model, 'create', [vals]),
    write: (model, ids, vals) => call(model, 'write', [ids, vals]),
    action: (model, ids, method) => call(model, method, [ids]),
    get mode() { return mode; },
  };
}
module.exports = { createClient };
