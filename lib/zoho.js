// Minimal Zoho Books API v3 client (no dependencies).
// Sign-in uses OAuth 2.0 "Self Client": the one-time grant code from the Zoho API console is exchanged for a refresh token,
// and short-lived access tokens (1 hour) are refreshed from it on demand. The API host is the api_domain Zoho returns with the
// tokens, so requests follow the account's data centre (UAE: accounts.zoho.ae → www.zohoapis.ae).
const ACCOUNTS = { ae: 'https://accounts.zoho.ae', com: 'https://accounts.zoho.com', eu: 'https://accounts.zoho.eu', in: 'https://accounts.zoho.in', sa: 'https://accounts.zoho.sa', au: 'https://accounts.zoho.com.au' };
const SCOPE = ['contacts', 'invoices', 'creditnotes', 'bills', 'expenses', 'customerpayments', 'vendorpayments'].map(s => `ZohoBooks.${s}.ALL`).concat(['ZohoBooks.settings.READ', 'ZohoBooks.banking.READ', 'ZohoBooks.accountants.READ']).join(',');
const isLocal = u => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(u);                     // development mock only
const okAccounts = u => Object.values(ACCOUNTS).includes(u) || isLocal(u);
const okApi = u => /^https:\/\/www\.zohoapis\.[a-z]{2,3}(\.[a-z]{2})?$/.test(u) || isLocal(u);

async function http(url, opts, timeout) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), timeout);
  let r;
  try { r = await fetch(url, { ...opts, signal: ac.signal }); }
  catch (e) { throw new Error(`Zoho unreachable (${new URL(url).host}): ${e.name === 'AbortError' ? 'timeout' : e.message}`); }
  finally { clearTimeout(t); }
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, j, text };
}

// grant code (Self Client → Generate Code) → { refresh_token, api_domain }
async function exchangeCode({ accounts, client_id, client_secret, code, timeout = 30000 }) {
  if (!okAccounts(accounts)) throw new Error('Unknown Zoho accounts server');
  const body = new URLSearchParams({ grant_type: 'authorization_code', client_id, client_secret, code });
  const { j, status, text } = await http(accounts + '/oauth/v2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }, timeout);
  if (!j || j.error || !j.refresh_token) {
    const why = (j && j.error) || `HTTP ${status} ${text.slice(0, 120)}`;
    throw new Error(why === 'invalid_code' ? 'Zoho rejected the code — it is used once and expires after a few minutes; generate a new one' : why === 'invalid_client' ? 'Zoho rejected the Client ID / Client Secret (check the data centre too)' : `Zoho sign-in failed: ${why}`);
  }
  const api = String(j.api_domain || '').replace(/\/+$/, '');
  if (!okApi(api)) throw new Error('Unexpected api_domain from Zoho: ' + api);
  return { refresh_token: j.refresh_token, api_domain: api, access_token: j.access_token, expires_in: +j.expires_in || 3600 };
}

async function revoke({ accounts, token, timeout = 15000 }) {
  if (!okAccounts(accounts) || !token) return;
  await http(accounts + '/oauth/v2/token/revoke?' + new URLSearchParams({ token }), { method: 'POST' }, timeout).catch(() => {});
}

// cache: a shared { token, exp } object so access tokens are reused across runs (Zoho limits how often they can be issued)
function createClient({ accounts, client_id, client_secret, refresh_token, api_domain, org, cache = {}, timeout = 30000 }) {
  if (!okAccounts(accounts)) throw new Error('Unknown Zoho accounts server');
  if (!okApi(api_domain)) throw new Error('Not connected to Zoho yet');
  if (!refresh_token) throw new Error('Not connected to Zoho yet');

  async function token(force) {
    if (!force && cache.token && cache.exp > Date.now() + 60000) return cache.token;
    const body = new URLSearchParams({ grant_type: 'refresh_token', client_id, client_secret, refresh_token });
    const { j, status } = await http(accounts + '/oauth/v2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }, timeout);
    if (!j || !j.access_token) throw new Error(`Zoho refused to renew access (${(j && j.error) || 'HTTP ' + status}) — connect again with a new code`);
    cache.token = j.access_token; cache.exp = Date.now() + (+j.expires_in || 3600) * 1000;
    return cache.token;
  }

  async function request(method, path, { query = {}, body } = {}) {
    const qs = new URLSearchParams({ ...(path === '/organizations' ? {} : { organization_id: org }), ...query });
    const url = `${api_domain}/books/v3${path}?${qs}`;
    let renew = false;
    for (let attempt = 0; ; attempt++) {
      const headers = { Authorization: 'Zoho-oauthtoken ' + await token(renew) };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const { status, j, text } = await http(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, timeout);
      renew = false;
      if (status === 401 && attempt === 0) { renew = true; continue; }                     // token expired or revoked → renew once
      if (status === 429 && attempt < 3) { await new Promise(ok => setTimeout(ok, 2000 * (attempt + 1))); continue; }   // rate limit: 100 requests a minute
      if (j && j.code === 0) return j;
      const err = new Error('Zoho: ' + ((j && j.message) || `HTTP ${status} ${text.slice(0, 160)}`));
      err.status = status; err.code = j && j.code; throw err;
    }
  }
  return {
    request,
    get: (path, query) => request('GET', path, { query }),
    post: (path, body, query) => request('POST', path, { body: body || {}, query }),
    put: (path, body, query) => request('PUT', path, { body, query }),
  };
}
module.exports = { createClient, exchangeCode, revoke, ACCOUNTS, SCOPE, okAccounts };
