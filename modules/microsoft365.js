// Microsoft 365 (Entra ID) — Phase 1: link an ERP administrator to their Microsoft account with OAuth 2.0 Authorization Code + PKCE.
// The ERP login stays the only way in; this only links an already signed-in administrator. Off unless M365_ENABLED=1, and fails
// closed when enabled but incomplete. Secrets come from the environment only (never the database, the code, the browser or logs).
// The id_token is verified with `jose` against the tenant's published Entra signing keys (JWKS): RS256 only, issuer, audience,
// tenant, nonce, exp / nbf / iat. Tokens and the PKCE verifier are encrypted at rest with M365_ENCRYPTION_KEY (AES-256-GCM); the
// OAuth state is stored as a hash, single use, 10 minutes, and removed once the callback has finished. One Microsoft identity
// (tenant + object ID) can be linked to one ERP user only. Delegated permissions only: openid profile email offline_access User.Read.
// Additive: two new tables (m365_connections, oauth_states) and one unique index.
const crypto = require('node:crypto');

const SCOPES = 'openid profile email offline_access User.Read';
const STATE_TTL = 10 * 60e3, HTTP_TIMEOUT = 10e3, PROVIDER = 'microsoft', CLOCK_SKEW = 60;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const B64U = /^[A-Za-z0-9_-]+$/;
const loadJose = () => { try { return require('jose'); } catch { return null; } };   // npm dependency: when it is missing the link stays closed

module.exports = ctx => {
  const { db, send, audit, readBody } = ctx;
  // user_id references users with ON DELETE CASCADE (foreign_keys=ON in server.js); prune() also covers rows made without it
  db.exec(`CREATE TABLE IF NOT EXISTS m365_connections (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE, tenant_id TEXT NOT NULL, microsoft_user_id TEXT NOT NULL, email TEXT, display_name TEXT,
    access_token_encrypted TEXT, refresh_token_encrypted TEXT, expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS oauth_states (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, provider TEXT NOT NULL, state_hash TEXT NOT NULL UNIQUE, verifier_encrypted TEXT NOT NULL,
    expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL);`);
  // one Microsoft identity → one ERP user. If old rows already break the rule the index cannot be built: the link stays closed.
  let identityIndex = true;
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS m365_connections_identity ON m365_connections(tenant_id, microsoft_user_id)'); }
  catch { identityIndex = false; }

  // ---------- configuration (read on every call; a change is audited) ----------
  const keyOf = v => { const s = String(v || '').trim(); const b = /^[0-9a-f]{64}$/i.test(s) ? Buffer.from(s, 'hex') : /^[A-Za-z0-9+/=_-]+$/.test(s) ? Buffer.from(s, 'base64') : Buffer.alloc(0); return b.length === 32 ? b : null; };
  function cfg() {
    const e = process.env, c = {
      enabled: e.M365_ENABLED === '1', tenant: (e.M365_TENANT_ID || '').trim().toLowerCase(), clientId: (e.M365_CLIENT_ID || '').trim().toLowerCase(), secret: e.M365_CLIENT_SECRET || '',
      redirect: (e.M365_REDIRECT_URI || '').trim(), siteId: (e.M365_SHAREPOINT_SITE_ID || '').trim(), driveId: (e.M365_SHAREPOINT_DRIVE_ID || '').trim(), key: keyOf(e.M365_ENCRYPTION_KEY),
      loginBase: (e.M365_LOGIN_BASE || 'https://login.microsoftonline.com').replace(/\/+$/, ''), graphBase: (e.M365_GRAPH_BASE || 'https://graph.microsoft.com/v1.0').replace(/\/+$/, '') };
    const missing = [];
    if (!GUID.test(c.tenant)) missing.push('M365_TENANT_ID');                 // tenant-specific endpoints only (no common / organizations)
    if (!GUID.test(c.clientId)) missing.push('M365_CLIENT_ID');
    if (!c.secret) missing.push('M365_CLIENT_SECRET');
    let ru = null; try { ru = new URL(c.redirect); } catch { /* invalid */ }
    if (!ru || ru.pathname !== '/auth/microsoft/callback' || ru.search || ru.hash || ru.username || !(ru.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(ru.hostname))) missing.push('M365_REDIRECT_URI');
    if (!c.key) missing.push('M365_ENCRYPTION_KEY');
    if (!loadJose()) missing.push('jose (run: npm install --omit=dev)');
    if (!identityIndex) missing.push('m365_connections: one Microsoft account is linked to several users');
    return { ...c, redirectUrl: ru, issuer: `${c.loginBase}/${c.tenant}/v2.0`, jwksUri: `${c.loginBase}/${c.tenant}/discovery/v2.0/keys`, missing, configured: missing.length === 0 };
  }
  const now = () => new Date().toISOString();
  const sysReq = { headers: {} };                                            // audit entries written by the system itself
  const fail = (status, msg) => Object.assign(new Error(msg), { status });  // has a status → never logged with a stack, message is user-safe
  const auditAs = (username, action, rec, detail) => db.prepare('INSERT INTO audit_log(ts,user,action,tbl,rec,detail) VALUES(?,?,?,?,?,?)').run(now(), username || '', action, 'm365', rec, String(detail || '').slice(0, 300));
  function noteConfig(c) {                                                   // fingerprint of identifiers + HMAC of the secret (keyed by the encryption key), never the secret
    const fp = crypto.createHash('sha256').update(JSON.stringify([c.enabled, c.tenant, c.clientId, c.redirect, c.siteId, c.driveId, !!c.key,
      c.key && c.secret ? crypto.createHmac('sha256', c.key).update(c.secret).digest('hex') : !!c.secret])).digest('hex');
    const old = db.prepare("SELECT value FROM settings WHERE key='m365_config_fp'").get()?.value;
    if (old === fp) return;
    db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run('m365_config_fp', fp);
    if (old !== undefined || c.enabled) audit(sysReq, 'config-change', 'm365', 0, `enabled=${c.enabled} configured=${c.configured}${c.missing.length ? ' missing=' + c.missing.join(',') : ''}`);
  }
  // links and sign-ins only for active administrators: users deleted, disabled or no longer administrator lose them
  function prune() {
    const gone = db.prepare("SELECT c.user_id, u.username FROM m365_connections c LEFT JOIN users u ON u.id=c.user_id WHERE u.id IS NULL OR COALESCE(u.disabled,0)=1 OR u.role!='admin'").all();
    for (const g of gone) { db.prepare('DELETE FROM m365_connections WHERE user_id=?').run(g.user_id); auditAs('system', 'disconnect', g.user_id, `link removed from Trigon ERP: ${g.username || 'user'} is no longer an active administrator`); }
    db.prepare("DELETE FROM oauth_states WHERE expires_at < ? OR used_at IS NOT NULL OR user_id NOT IN (SELECT id FROM users WHERE COALESCE(disabled,0)=0 AND role='admin')").run(now());
  }
  prune();

  // ---------- encryption at rest: AES-256-GCM, "v1.<iv>.<tag>.<ciphertext>" (base64url) ----------
  const b64u = b => Buffer.from(b).toString('base64url');
  function seal(key, text) {
    if (text == null) return null;
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv), ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
    return ['v1', b64u(iv), b64u(c.getAuthTag()), b64u(ct)].join('.');
  }
  function open(key, box) {                                                  // strict format; any problem → one generic error, nothing about the value
    const bad = () => fail(500, 'Stored Microsoft 365 data could not be read — disconnect and connect again');
    if (typeof box !== 'string') throw bad();
    const parts = box.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1' || !parts.slice(1).every(p => p && B64U.test(p))) throw bad();
    const iv = Buffer.from(parts[1], 'base64url'), tag = Buffer.from(parts[2], 'base64url'), ct = Buffer.from(parts[3], 'base64url');
    if (iv.length !== 12 || tag.length !== 16 || !ct.length) throw bad();
    try { const d = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 }); d.setAuthTag(tag); return Buffer.concat([d.update(ct), d.final()]).toString('utf8'); }
    catch { throw bad(); }
  }
  const sha = s => crypto.createHash('sha256').update(s).digest('hex');
  const stateHash = (state, binding) => sha(`${state}:${binding}`);      // the state only matches in the browser that started the flow
  const nonceOf = (key, state) => crypto.createHmac('sha256', key).update('nonce:' + state).digest('base64url');

  // ---------- Microsoft endpoints (server to server, with a timeout; bodies are never logged) ----------
  async function tokenCall(c, params) {
    let r;
    try {
      r = await fetch(`${c.loginBase}/${encodeURIComponent(c.tenant)}/oauth2/v2.0/token`, { method: 'POST', signal: AbortSignal.timeout(HTTP_TIMEOUT),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ client_id: c.clientId, client_secret: c.secret, scope: SCOPES, ...params }) });
    } catch (e) { throw fail(502, e.name === 'TimeoutError' ? 'Microsoft did not answer in time' : 'Microsoft could not be reached'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw fail(502, `Microsoft refused the request (${String(j.error || r.status).replace(/[^\w.-]/g, '').slice(0, 60)})`);   // the error code only
    return j;
  }
  async function graphMe(c, accessToken) {
    let r;
    try { r = await fetch(`${c.graphBase}/me?$select=id,displayName,mail,userPrincipalName`, { signal: AbortSignal.timeout(HTTP_TIMEOUT), headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } }); }
    catch (e) { throw fail(502, e.name === 'TimeoutError' ? 'Microsoft Graph did not answer in time' : 'Microsoft Graph could not be reached'); }
    if (!r.ok) throw fail(502, `Microsoft Graph refused the request (${r.status})`);
    return r.json().catch(() => { throw fail(502, 'Microsoft Graph sent an unreadable answer'); });
  }

  // ---------- id_token: signature (tenant JWKS, by kid, RS256 only) and claims — with jose ----------
  const jwksSets = new Map();                                                // one jose remote key set per tenant JWKS URL (jose caches and refreshes the keys)
  const jwksFor = (jose, c) => {
    if (!jwksSets.has(c.jwksUri)) jwksSets.set(c.jwksUri, jose.createRemoteJWKSet(new URL(c.jwksUri), { timeoutDuration: HTTP_TIMEOUT, cooldownDuration: 30e3, cacheMaxAge: 10 * 60e3 }));
    return jwksSets.get(c.jwksUri);
  };
  async function verifyIdToken(c, idToken, state) {
    const jose = loadJose(); if (!jose) throw fail(503, 'Microsoft 365 sign-in checks are not installed on this server');
    if (typeof idToken !== 'string' || idToken.length > 20000 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(idToken)) throw fail(400, 'Microsoft sent an incomplete sign-in answer');
    let header; try { header = jose.decodeProtectedHeader(idToken); } catch { throw fail(400, 'Microsoft sent an unreadable sign-in answer'); }
    if (header.alg !== 'RS256') throw fail(400, 'The sign-in answer uses a signing method that is not accepted');
    if (typeof header.kid !== 'string' || !header.kid) throw fail(400, 'The sign-in answer does not name its signing key');
    let payload;
    try {
      ({ payload } = await jose.jwtVerify(idToken, jwksFor(jose, c), { algorithms: ['RS256'], issuer: c.issuer, audience: c.clientId, clockTolerance: CLOCK_SKEW,
        requiredClaims: ['iss', 'aud', 'exp', 'iat', 'tid', 'oid', 'nonce', 'sub'] }));
    } catch (e) {
      const code = String(e && e.code || '');
      if (/^ERR_JWKS_(TIMEOUT|INVALID)$|^ERR_JOSE_GENERIC$/.test(code) || (!code.startsWith('ERR_J') && !(e instanceof jose.errors.JOSEError))) throw fail(502, 'Microsoft sign-in keys could not be checked — try again later');
      if (code === 'ERR_JWKS_NO_MATCHING_KEY') throw fail(400, 'The sign-in answer is signed with a key Microsoft does not publish');
      if (code === 'ERR_JWT_EXPIRED') throw fail(400, 'The sign-in answer has expired');
      throw fail(400, 'The sign-in answer could not be verified');
    }
    if (String(payload.tid).toLowerCase() !== c.tenant) throw fail(400, 'The Microsoft account belongs to another organisation');
    if (typeof payload.nonce !== 'string' || !crypto.timingSafeEqual(Buffer.from(sha(payload.nonce)), Buffer.from(sha(nonceOf(c.key, state))))) throw fail(400, 'The sign-in answer does not belong to this request');
    if (!GUID.test(String(payload.oid))) throw fail(400, 'The sign-in answer does not identify the Microsoft account');
    return payload;
  }

  // ---------- access token for a linked user (refreshed when needed, rotation stored; a refresh failure is audited) ----------
  ctx.m365Token = async userId => {
    const c = cfg(); if (!c.enabled || !c.configured) throw fail(503, 'Microsoft 365 is not enabled');
    prune();
    const row = db.prepare('SELECT * FROM m365_connections WHERE user_id=?').get(userId); if (!row) throw fail(404, 'This account is not linked to Microsoft 365');
    try {
      if (row.expires_at && Date.parse(row.expires_at) > Date.now() + 120e3) return open(c.key, row.access_token_encrypted);
      const t = await tokenCall(c, { grant_type: 'refresh_token', refresh_token: open(c.key, row.refresh_token_encrypted) });
      db.prepare('UPDATE m365_connections SET access_token_encrypted=?, refresh_token_encrypted=COALESCE(?,refresh_token_encrypted), expires_at=?, updated_at=? WHERE id=?')
        .run(seal(c.key, t.access_token), t.refresh_token ? seal(c.key, t.refresh_token) : null, new Date(Date.now() + (+t.expires_in || 3600) * 1000).toISOString(), now(), row.id);
      return t.access_token;
    } catch (e) {
      audit(sysReq, 'refresh-failed', 'm365', userId, String(e.message).slice(0, 200));
      throw fail(502, 'The Microsoft 365 link has to be renewed — remove it and connect again');
    }
  };

  const html = (res, code, title, msg, extra = {}) => {
    res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", ...extra });
    const e = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(title)}</title><body style="font:15px system-ui,sans-serif;max-width:520px;margin:12vh auto;padding:0 16px;color:#1F3A5F"><h2>${e(title)}</h2><p>${e(msg)}</p><p><a href="/#settings">← Trigon ERP</a></p></body>`);
  };
  // forwarded headers are trusted only behind the reverse proxy (TRUST_PROXY=1), for the scheme as well as the host
  const proxied = () => process.env.TRUST_PROXY === '1';
  const lastHop = v => String(v || '').split(',').pop().trim();
  const reqHost = req => (proxied() && req.headers['x-forwarded-host'] ? lastHop(req.headers['x-forwarded-host']) : String(req.headers.host || '')).toLowerCase();
  const secureCookie = (req, c) => c.redirectUrl.protocol === 'https:' || process.env.SECURE_COOKIES === '1' || (proxied() && lastHop(req.headers['x-forwarded-proto']) === 'https');
  const BIND = 'm365_flow';
  const bindCookie = (req, c, v, age) => `${BIND}=${v}; HttpOnly; SameSite=Lax; Path=/auth/microsoft; Max-Age=${age}${secureCookie(req, c) ? '; Secure' : ''}`;   // Lax: it must come back on Microsoft's top-level redirect
  const readBind = req => (/(?:^|;\s*)m365_flow=([A-Za-z0-9_-]{43})(?:;|$)/.exec(req.headers.cookie || '') || [])[1] || '';
  const isActiveAdmin = id => !!db.prepare("SELECT 1 FROM users WHERE id=? AND COALESCE(disabled,0)=0 AND role='admin'").get(id);

  // ---------- /auth/microsoft and /auth/microsoft/callback (browser navigations, outside /api) ----------
  ctx.m365Auth = async (req, res, url) => {
    if (url.pathname !== '/auth/microsoft' && url.pathname !== '/auth/microsoft/callback') return false;
    if (req.method !== 'GET') return html(res, 405, 'Not allowed', 'Use the Connect button in Settings.'), true;
    const c = cfg(); noteConfig(c);
    if (!c.enabled) return html(res, 404, 'Microsoft 365 is off', 'The Microsoft 365 link is not enabled on this server.'), true;
    if (!c.configured) return html(res, 503, 'Microsoft 365 is not configured', 'The server settings for Microsoft 365 are incomplete. Ask the administrator to check the server.'), true;
    if (reqHost(req) !== c.redirectUrl.host.toLowerCase()) return html(res, 400, 'Wrong address', 'Open the system at its registered address and try again.'), true;   // exactly the registered host
    prune();

    if (url.pathname === '/auth/microsoft') {
      const me = ctx.sessionUser(req);
      if (!me) return html(res, 401, 'Sign in first', 'Sign in to Trigon ERP as an administrator, then use Connect in Settings.'), true;
      if (me.role !== 'admin') return html(res, 403, 'Administrators only', 'Only an administrator can link Microsoft 365 in this phase.'), true;
      const state = b64u(crypto.randomBytes(32)), verifier = b64u(crypto.randomBytes(48)), binding = b64u(crypto.randomBytes(32));
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
      db.prepare('INSERT INTO oauth_states(user_id,provider,state_hash,verifier_encrypted,expires_at,created_at) VALUES(?,?,?,?,?,?)')
        .run(me.id, PROVIDER, stateHash(state, binding), seal(c.key, verifier), new Date(Date.now() + STATE_TTL).toISOString(), now());
      const q = new URLSearchParams({ client_id: c.clientId, response_type: 'code', redirect_uri: c.redirect, response_mode: 'query', scope: SCOPES,
        state, nonce: nonceOf(c.key, state), code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account' });
      res.writeHead(302, { Location: `${c.loginBase}/${encodeURIComponent(c.tenant)}/oauth2/v2.0/authorize?${q}`, 'Set-Cookie': bindCookie(req, c, binding, STATE_TTL / 1000), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      return res.end(), true;
    }

    // ---- callback: every outcome is terminal for the state (it is marked used first, then deleted) ----
    const state = url.searchParams.get('state') || '', code = url.searchParams.get('code') || '', binding = readBind(req);
    const reject = msg => (html(res, 400, 'Microsoft 365 was not connected', msg, { 'Set-Cookie': bindCookie(req, c, '', 0) }), true);
    if (!state || state.length > 100 || !B64U.test(state)) return reject('The sign-in request is missing its check value. Start again from Settings.');
    if (!binding) return reject('This sign-in request is not known in this browser. Start again from Settings.');
    const row = db.prepare('SELECT * FROM oauth_states WHERE state_hash=? AND provider=?').get(stateHash(state, binding), PROVIDER);
    if (!row) return reject('This sign-in request is not known in this browser, has expired or was already used. Start again from Settings.');
    const used = db.prepare('UPDATE oauth_states SET used_at=? WHERE id=? AND used_at IS NULL').run(now(), row.id);   // single use, even if the rest fails
    if (!used.changes) return reject('This sign-in request was already used. Start again from Settings.');
    const finish = () => db.prepare('DELETE FROM oauth_states WHERE id=?').run(row.id);
    try {
      if (Date.parse(row.expires_at) < Date.now()) return reject('This sign-in request has expired (10 minutes). Start again from Settings.');
      const user = db.prepare('SELECT id, username, role FROM users WHERE id=? AND COALESCE(disabled,0)=0').get(row.user_id);
      if (!user || user.role !== 'admin') return reject('Only an active administrator can link Microsoft 365.');
      if (url.searchParams.get('error')) { auditAs(user.username, 'connect-failed', user.id, `Microsoft returned ${String(url.searchParams.get('error')).replace(/[^\w.-]/g, '').slice(0, 60)}`); return reject('Microsoft did not allow the link. Start again from Settings.'); }
      if (!code || code.length > 4000) return reject('Microsoft did not send an authorisation code.');
      let verifier; try { verifier = open(c.key, row.verifier_encrypted); } catch { return reject('This sign-in request could not be read. Start again from Settings.'); }
      try {
        const t = await tokenCall(c, { grant_type: 'authorization_code', code, redirect_uri: c.redirect, code_verifier: verifier });
        const claims = await verifyIdToken(c, t.id_token, state);
        const me = await graphMe(c, t.access_token);
        // the stable identity is tenant + object ID: both the verified id_token and Graph must name the same account
        const oid = String(claims.oid).toLowerCase(), gid = String(me && me.id || '').toLowerCase();
        if (!GUID.test(gid)) throw fail(400, 'Microsoft Graph did not identify the account');
        if (gid !== oid) throw fail(400, 'The Microsoft account changed during sign-in');
        if (!isActiveAdmin(user.id)) throw fail(400, 'Only an active administrator can link Microsoft 365.');
        const taken = db.prepare('SELECT user_id FROM m365_connections WHERE tenant_id=? AND microsoft_user_id=? AND user_id!=?').get(c.tenant, oid, user.id);
        if (taken) throw fail(409, 'This Microsoft account is already linked to another user of the system.');
        const email = me.mail || me.userPrincipalName || claims.preferred_username || null, ts = now(), exp = new Date(Date.now() + (+t.expires_in || 3600) * 1000).toISOString();
        try {
          db.prepare(`INSERT INTO m365_connections(user_id,tenant_id,microsoft_user_id,email,display_name,access_token_encrypted,refresh_token_encrypted,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(user_id) DO UPDATE SET tenant_id=excluded.tenant_id, microsoft_user_id=excluded.microsoft_user_id, email=excluded.email, display_name=excluded.display_name,
            access_token_encrypted=excluded.access_token_encrypted, refresh_token_encrypted=excluded.refresh_token_encrypted, expires_at=excluded.expires_at, updated_at=excluded.updated_at`)
            .run(user.id, c.tenant, oid, email, me.displayName || claims.name || null, seal(c.key, t.access_token), t.refresh_token ? seal(c.key, t.refresh_token) : null, exp, ts, ts);
        } catch { throw fail(409, 'This Microsoft account is already linked to another user of the system.'); }   // unique (tenant, object ID); no DB detail shown
        auditAs(user.username, 'connect', user.id, `linked to Microsoft account ${oid}${email ? ' (' + String(email).slice(0, 120) + ')' : ''}`);
        res.writeHead(302, { Location: '/#settings', 'Set-Cookie': bindCookie(req, c, '', 0), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
        return res.end(), true;
      } catch (e) {
        auditAs(user.username, 'connect-failed', user.id, String(e.message).slice(0, 200));
        return reject(e.status ? e.message : 'Microsoft 365 could not be linked right now. Try again later.');   // fail() messages are written to be shown; anything else stays generic
      }
    } finally { finish(); }
  };

  return {
    async handle(req, res, url, [a, b], me) {
      if (a !== 'm365') return false;
      if (me.role !== 'admin') return send(res, 403, { error: 'your role does not allow this action' }), true;    // also enforced in lib/acl.js
      const c = cfg(); noteConfig(c); prune();
      if (b === 'status' && req.method === 'GET') {
        const link = db.prepare('SELECT email, display_name, tenant_id, expires_at, updated_at FROM m365_connections WHERE user_id=?').get(me.id);
        return send(res, 200, { enabled: c.enabled, configured: c.enabled && c.configured, missing: c.enabled ? c.missing : [],
          tenant_id: c.tenant || null, client_id: c.clientId || null, redirect_uri: c.redirect || null, sharepoint_site_id: c.siteId || null, sharepoint_drive_id: c.driveId || null,
          client_secret_set: !!c.secret, encryption_key_set: !!c.key, scopes: SCOPES.split(' '),
          connection: link ? { email: link.email, display_name: link.display_name, tenant_id: link.tenant_id, linked_at: link.updated_at } : null }), true;
      }
      if (b === 'disconnect' && req.method === 'POST') {
        // removes the link and its tokens from Trigon ERP only; Microsoft consent / sessions are not revoked by this (Phase 1 has no permission for that)
        await readBody(req).catch(() => ({}));
        const r = db.prepare('DELETE FROM m365_connections WHERE user_id=?').run(me.id);
        db.prepare('DELETE FROM oauth_states WHERE user_id=?').run(me.id);
        audit(req, 'disconnect', 'm365', me.id, r.changes ? 'link and tokens removed from Trigon ERP (Microsoft consent not revoked)' : 'nothing linked');
        return send(res, 200, { ok: 1, removed: r.changes, revoked_at_microsoft: false }), true;
      }
      if (b === 'check' && req.method === 'POST') {                          // is the link still working? (refreshes the token when it has expired)
        if (!c.enabled || !c.configured) return send(res, 503, { error: 'Microsoft 365 is not enabled or not configured' }), true;
        const who = await graphMe(c, await ctx.m365Token(me.id));
        return send(res, 200, { ok: 1, email: who.mail || who.userPrincipalName || null, display_name: who.displayName || null }), true;
      }
      return send(res, 404, { error: 'not found' }), true;
    },
  };
};
