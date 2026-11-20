// Minimal Zoho Books API v3 client (no dependencies).
// Sign-in uses OAuth 2.0 "Self Client": the one-time grant code from the Zoho API console is exchanged for a refresh token,
// and short-lived access tokens (1 hour) are refreshed from it on demand. The API host is the api_domain Zoho returns with the
// tokens, so requests follow the account's data centre (UAE: accounts.zoho.ae → www.zohoapis.ae).
const ACCOUNTS = { ae: 'https://accounts.zoho.ae', com: 'https://accounts.zoho.com', eu: 'https://accounts.zoho.eu', in: 'https://accounts.zoho.in', sa: 'https://accounts.zoho.sa', au: 'https://accounts.zoho.com.au' };
const SCOPE = ['contacts', 'invoices', 'creditnotes', 'bills', 'expenses', 'customerpayments', 'vendorpayments'].map(s => `ZohoBooks.${s}.ALL`).concat(['ZohoBooks.settings.READ', 'ZohoBooks.banking.READ', 'ZohoBooks.accountants.READ', 'ZohoBooks.accountants.CREATE', 'ZohoBooks.accountants.UPDATE', 'ZohoBooks.projects.READ']).join(',');   // accountants.CREATE/UPDATE: manual journals (payroll, end of service, advances)
const isLocal = u => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(u);                     // development mock only
const okAccounts = u => Object.values(ACCOUNTS).includes(u) || isLocal(u);
const okApi = u => /^https:\/\/www\.zohoapis\.[a-z]{2,3}(\.[a-z]{2})?$/.test(u) || isLocal(u);

// ---- failures described without any secret (the preflight prints them on the office PC) ----
// scrub: removes the given secret values, anything shaped like a Zoho token / client ID, and credential fields, then shortens.
function scrub(v, secrets = []) {
  let s = String(v == null ? '' : v);
  for (const x of secrets) if (x && String(x).length >= 4) s = s.split(String(x)).join('[hidden]');
  return s.replace(/\b1000\.[A-Za-z0-9._-]{8,}/g, '[hidden]').replace(/Zoho-oauthtoken\s+\S+/gi, 'Zoho-oauthtoken [hidden]')
    .replace(/\b(client_id|client_secret|refresh_token|access_token|code|token)=[^&\s"]+/gi, '$1=[hidden]').replace(/\s+/g, ' ').trim().slice(0, 300);
}
// every cause under a fetch failure (undici nests them; a connection tried on several addresses is an AggregateError)
function causes(e, out = [], depth = 0) {
  if (!e || typeof e !== 'object' || depth > 6) return out;
  out.push({ code: e.code || null, name: e.name || null, message: e.message || '', address: e.address || null, port: e.port || null });
  if (Array.isArray(e.errors)) for (const x of e.errors) causes(x, out, depth + 1);
  if (e.cause) causes(e.cause, out, depth + 1);
  return out;
}
const TLS = /^(CERT_|UNABLE_TO_|SELF_SIGNED|DEPTH_ZERO|ERR_TLS|ERR_SSL|EPROTO|ERR_OSSL|HOSTNAME_MISMATCH)/, DNS = /^(ENOTFOUND|EAI_AGAIN|EAI_FAIL|EAI_NONAME|EAI_NODATA)$/, SLOW = /^(UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|ETIMEDOUT)$/;
// → { stage: 'connect', host, kind: timeout | tls | dns | network, http_status: null, cause_code, cause_codes, cause, addresses }
function netFailure(e, host, secrets) {
  const all = causes(e).slice(1), codes = [...new Set(all.map(x => x.code).filter(Boolean))];
  const msgs = all.map(x => x.message).filter(Boolean), aborted = e && (e.name === 'AbortError' || e.name === 'TimeoutError');
  const kind = aborted ? 'timeout' : codes.some(c => TLS.test(c)) || msgs.some(m => /certificate|ssl|tls/i.test(m)) ? 'tls'
    : codes.some(c => DNS.test(c)) ? 'dns' : codes.some(c => SLOW.test(c)) ? 'timeout' : 'network';
  const deepest = all.filter(x => x.message).pop();
  // which limit ran out: the TCP + TLS connection, the wait for Zoho's first response, or this client's overall time limit
  const timeout_type = kind !== 'timeout' ? null : aborted ? 'total' : codes.some(c => /^(UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT)$/.test(c)) ? 'response' : 'connect';
  return { stage: 'connect', host, kind, timeout_type, http_status: null, cause_code: codes[0] || null, cause_codes: codes,
    cause: scrub(aborted ? 'no answer within the time limit' : deepest ? deepest.message : (e && e.message) || '', secrets),
    addresses: [...new Set(all.filter(x => x.address).map(x => x.address + (x.port ? ':' + x.port : '')))], hint: NET_HINT[kind] };
}
const NET_HINT = { timeout: 'no answer within the time limit — a firewall, proxy or antivirus may be holding the connection', dns: 'Node could not resolve the name',
  tls: 'the secure connection failed — often an antivirus or proxy that inspects HTTPS with its own certificate, which Node does not trust', network: 'the connection was refused or cut before Zoho answered' };
// the access-token endpoint answered without a token → { stage: 'oauth', kind: oauth_rejected | unexpected_response, … }
function oauthFailure(status, j, text, contentType, host, secrets) {
  const err = j && j.error ? scrub(j.error, secrets) : null, desc = j ? scrub(j.error_description || j.message || '', secrets) : '';
  const hint = !err ? (j ? 'Zoho answered without an access token' : 'the answer is not from Zoho\'s sign-in service (a proxy or filter on this network may have answered)')
    : err === 'invalid_client' ? 'Zoho rejected the Client ID / Client Secret on this data centre — check ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET, and that the API client was created on this data centre'
    : err === 'invalid_client_secret' ? 'the Client Secret does not belong to this Client ID — check ZOHO_CLIENT_SECRET'
    : err === 'invalid_code' ? 'the refresh token is invalid, revoked or from another client — generate a new grant code and connect again'
    : status === 429 || /access denied/i.test(err) || /too many/i.test(desc) ? 'Zoho is limiting access-token requests — wait 15 minutes, then try once' : '';
  return { stage: 'oauth', host, kind: err ? 'oauth_rejected' : 'unexpected_response', http_status: status, oauth_error: err, oauth_error_description: desc || null,
    content_type: contentType || null, body_is_json: !!j, hint };
}

async function http(url, opts, timeout, secrets, dispatcher) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), timeout), host = new URL(url).host;
  let r;
  try { r = await fetch(url, { ...opts, signal: ac.signal, ...(dispatcher ? { dispatcher } : {}) }); }   // dispatcher: preflight only (Node)
  catch (e) {
    const d = netFailure(e, host, secrets);
    const err = new Error(`Zoho unreachable (${host}): ${d.kind}${d.cause_code ? ' ' + d.cause_code : ''}${d.cause ? ' — ' + d.cause : ''}`);
    err.diag = d; throw err;
  }
  finally { clearTimeout(t); }
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, j, text, contentType: r.headers.get('content-type') || '' };
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
// readOnly: the dry run / preflight — any request other than GET to the Books API is refused here, before it is sent
// (renewing the access token is a POST to the accounts server, not to the organisation's books, and is still allowed)
// net (preflight only; the normal sync never sets it): { timeout, dispatcher, connectRetry, retryDelay }
//   connectRetry: a GET whose connection timed out is retried once after retryDelay (≤ 5 s); nothing else is retried
//   (no access-token renewal on 401, no retry of 401 / 403 / Zoho errors / OAuth errors).
function createClient({ accounts, client_id, client_secret, refresh_token, api_domain, org, cache = {}, timeout = 30000, readOnly = false, net = null }) {
  if (net && net.timeout) timeout = net.timeout;
  const dispatcher = net && net.dispatcher, preflight = !!(net && net.connectRetry), retryDelay = Math.min(5000, Math.max(0, net && net.retryDelay != null ? +net.retryDelay : 2000));
  if (!okAccounts(accounts)) throw new Error('Unknown Zoho accounts server');
  if (!okApi(api_domain)) throw new Error('Not connected to Zoho yet');
  if (!refresh_token) throw new Error('Not connected to Zoho yet');

  async function token(force) {
    if (!force && cache.token && cache.exp > Date.now() + 60000) return cache.token;
    const body = new URLSearchParams({ grant_type: 'refresh_token', client_id, client_secret, refresh_token });
    const secrets = [client_id, client_secret, refresh_token, cache.token];
    const { j, status, text, contentType } = await http(accounts + '/oauth/v2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }, timeout, secrets, dispatcher);
    if (!j || !j.access_token) {
      const d = oauthFailure(status, j, text, contentType, new URL(accounts).host, secrets);
      const e = new Error(`Zoho refused to renew access (${d.oauth_error || 'HTTP ' + status})${d.hint ? ' — ' + d.hint : ''}`); e.diag = d; throw e;
    }
    cache.token = j.access_token; cache.exp = Date.now() + (+j.expires_in || 3600) * 1000;
    return cache.token;
  }

  async function request(method, path, { query = {}, body } = {}) {
    if (readOnly && method !== 'GET') throw new Error(`read-only (dry run): ${method} ${path} refused — nothing is written to Zoho`);
    const qs = new URLSearchParams({ ...(path === '/organizations' ? {} : { organization_id: org }), ...query });
    const url = `${api_domain}/books/v3${path}?${qs}`;
    let renew = false, retried = false;
    for (let attempt = 0; ; attempt++) {
      const headers = { Authorization: 'Zoho-oauthtoken ' + await token(renew) };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      let res;
      try { res = await http(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, timeout, [client_id, client_secret, refresh_token, cache.token], dispatcher); }
      catch (e) {
        if (preflight && method === 'GET' && !retried && e.diag && e.diag.timeout_type === 'connect') { retried = true; await new Promise(ok => setTimeout(ok, retryDelay)); continue; }   // once, GET only
        if (e.diag) e.diag.attempts = retried ? 2 : 1;
        throw e;
      }
      const { status, j, text } = res;
      renew = false;
      if (preflight && (status === 401 || status === 403 || !(j && j.code === 0))) {             // preflight: reported, never retried
        const err = new Error(`Zoho: ${(j && j.message) || 'HTTP ' + status}`); err.status = status; err.upstream = true; err.code = j && j.code;
        err.diag = { stage: 'books', host: new URL(url).host, kind: status === 401 || status === 403 ? 'authorization_rejected' : 'zoho_error', http_status: status, zoho_code: j && j.code != null ? j.code : null,
          zoho_message: scrub((j && j.message) || '', [client_id, client_secret, refresh_token, cache.token]) || null, attempts: retried ? 2 : 1 };
        throw err;
      }
      if (status === 401 && attempt === 0) { renew = true; continue; }                     // token expired or revoked → renew once
      if (status === 429 && attempt < 3) { await new Promise(ok => setTimeout(ok, 2000 * (attempt + 1))); continue; }   // rate limit: 100 requests a minute
      if (j && j.code === 0) return j;
      const err = new Error('Zoho: ' + ((j && j.message) || `HTTP ${status} ${text.slice(0, 160)}`));
      err.status = status; err.upstream = true; err.code = j && j.code; throw err;
    }
  }
  // connectivity probe (preflight): the same client, host and path as the organisation read, but without a token or the
  // organisation ID — Zoho answers (normally 401) without reaching any organisation. Any HTTP answer = the connection works.
  async function probe() {
    const url = `${api_domain}/books/v3/organizations`, t0 = Date.now();
    for (let retried = false; ;) {
      try { const r = await http(url, { method: 'GET' }, timeout, [client_id, client_secret, refresh_token, cache.token], dispatcher);
        return { ok: true, host: new URL(url).host, path: '/books/v3/organizations', http_status: r.status, zoho_code: r.j && r.j.code != null ? r.j.code : null, attempts: retried ? 2 : 1, ms: Date.now() - t0 }; }
      catch (e) {
        if (!retried && e.diag && e.diag.timeout_type === 'connect') { retried = true; await new Promise(ok => setTimeout(ok, retryDelay)); continue; }
        if (e.diag) e.diag.attempts = retried ? 2 : 1;
        throw e;
      }
    }
  }
  return {
    probe,
    request,
    get: (path, query) => request('GET', path, { query }),
    post: (path, body, query) => request('POST', path, { body: body || {}, query }),
    put: (path, body, query) => request('PUT', path, { body, query }),
    del: (path, query) => request('DELETE', path, { query }),
  };
}
module.exports = { createClient, exchangeCode, revoke, ACCOUNTS, SCOPE, okAccounts, http, scrub, netFailure, oauthFailure };
