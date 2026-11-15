// Microsoft 365 (Entra ID) — Phase 1: link an ERP administrator to their Microsoft account with OAuth 2.0 Authorization Code + PKCE.
// The ERP login stays the only way in; this only links an already signed-in administrator. Off unless M365_ENABLED=1, and fails
// closed when enabled but incomplete. Secrets come from the environment only (never the database, the code, the browser or logs).
// Tokens and the PKCE verifier are encrypted at rest with M365_ENCRYPTION_KEY (AES-256-GCM); the OAuth state is stored as a hash,
// single-use and valid 10 minutes. Delegated permissions only: openid profile email offline_access User.Read.
// Additive: two new tables (m365_connections, oauth_states).
const crypto = require('node:crypto');

const SCOPES = 'openid profile email offline_access User.Read';
const STATE_TTL = 10 * 60e3, HTTP_TIMEOUT = 10e3, PROVIDER = 'microsoft';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = ctx => {
  const { db, send, audit, readBody } = ctx;
  db.exec(`CREATE TABLE IF NOT EXISTS m365_connections (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL UNIQUE, tenant_id TEXT NOT NULL, microsoft_user_id TEXT NOT NULL, email TEXT, display_name TEXT,
    access_token_encrypted TEXT, refresh_token_encrypted TEXT, expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS oauth_states (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, provider TEXT NOT NULL, state_hash TEXT NOT NULL UNIQUE, verifier_encrypted TEXT NOT NULL,
    expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL);`);

  // ---------- configuration (read on every call, so a change in .env takes effect after a restart and is audited) ----------
  const keyOf = v => { const s = String(v || '').trim(); const b = /^[0-9a-f]{64}$/i.test(s) ? Buffer.from(s, 'hex') : Buffer.from(s, 'base64'); return b.length === 32 ? b : null; };
  function cfg() {
    const e = process.env, c = {
      enabled: e.M365_ENABLED === '1', tenant: (e.M365_TENANT_ID || '').trim(), clientId: (e.M365_CLIENT_ID || '').trim(), secret: e.M365_CLIENT_SECRET || '',
      redirect: (e.M365_REDIRECT_URI || '').trim(), siteId: (e.M365_SHAREPOINT_SITE_ID || '').trim(), driveId: (e.M365_SHAREPOINT_DRIVE_ID || '').trim(), key: keyOf(e.M365_ENCRYPTION_KEY),
      loginBase: (e.M365_LOGIN_BASE || 'https://login.microsoftonline.com').replace(/\/+$/, ''), graphBase: (e.M365_GRAPH_BASE || 'https://graph.microsoft.com/v1.0').replace(/\/+$/, '') };
    const missing = [];
    if (!GUID.test(c.tenant)) missing.push('M365_TENANT_ID');
    if (!GUID.test(c.clientId)) missing.push('M365_CLIENT_ID');
    if (!c.secret) missing.push('M365_CLIENT_SECRET');
    let ru = null; try { ru = new URL(c.redirect); } catch { /* invalid */ }
    if (!ru || !/\/auth\/microsoft\/callback$/.test(ru.pathname) || ru.search || ru.hash || !(ru.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(ru.hostname))) missing.push('M365_REDIRECT_URI');
    if (!c.key) missing.push('M365_ENCRYPTION_KEY');
    return { ...c, redirectUrl: ru, missing, configured: missing.length === 0 };
  }
  const now = () => new Date().toISOString();
  const sysReq = { headers: {} };                                            // audit entries the system writes itself (no user)
  const fail = (status, msg) => Object.assign(new Error(msg), { status });  // has a status → never logged with a stack
  // configuration change: a fingerprint of the identifiers (and an HMAC of the secret, keyed by the encryption key) — never the secret itself
  function noteConfig(c) {
    const fp = crypto.createHash('sha256').update(JSON.stringify([c.enabled, c.tenant, c.clientId, c.redirect, c.siteId, c.driveId, !!c.key,
      c.key && c.secret ? crypto.createHmac('sha256', c.key).update(c.secret).digest('hex') : !!c.secret])).digest('hex');
    const old = db.prepare("SELECT value FROM settings WHERE key='m365_config_fp'").get()?.value;
    if (old === fp) return;
    db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run('m365_config_fp', fp);
    if (old !== undefined || c.enabled) audit(sysReq, 'config-change', 'm365', 0, `enabled=${c.enabled} configured=${c.configured}${c.missing.length ? ' missing=' + c.missing.join(',') : ''}`);
  }

  // ---------- encryption at rest: AES-256-GCM, "v1.<iv>.<tag>.<ciphertext>" ----------
  const b64u = b => Buffer.from(b).toString('base64url');
  function seal(key, text) {
    if (text == null) return null;
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv), ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
    return ['v1', b64u(iv), b64u(c.getAuthTag()), b64u(ct)].join('.');
  }
  function open(key, box) {
    if (!box) return null;
    const [v, iv, tag, ct] = String(box).split('.'); if (v !== 'v1') throw fail(500, 'Unreadable stored value');
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url')); d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  }
  const sha = s => crypto.createHash('sha256').update(s).digest('hex');
  const stateHash = (state, binding) => sha(`${state}:${binding}`);      // the state only matches in the browser that started the flow
  const nonceOf = (key, state) => crypto.createHmac('sha256', key).update('nonce:' + state).digest('base64url');

  // ---------- Microsoft endpoints (server to server, with a timeout; responses are never logged) ----------
  async function tokenCall(c, params) {
    let r;
    try {
      r = await fetch(`${c.loginBase}/${encodeURIComponent(c.tenant)}/oauth2/v2.0/token`, { method: 'POST', signal: AbortSignal.timeout(HTTP_TIMEOUT),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ client_id: c.clientId, client_secret: c.secret, scope: SCOPES, ...params }) });
    } catch (e) { throw fail(502, e.name === 'TimeoutError' ? 'Microsoft did not answer in time' : 'Microsoft could not be reached'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw fail(502, `Microsoft refused the request (${String(j.error || r.status).replace(/[^\w.-]/g, '').slice(0, 60)})`);   // the error code only, never the body
    return j;
  }
  async function graphMe(c, accessToken) {
    let r;
    try { r = await fetch(`${c.graphBase}/me?$select=id,displayName,mail,userPrincipalName`, { signal: AbortSignal.timeout(HTTP_TIMEOUT), headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } }); }
    catch (e) { throw fail(502, e.name === 'TimeoutError' ? 'Microsoft Graph did not answer in time' : 'Microsoft Graph could not be reached'); }
    if (!r.ok) throw fail(502, `Microsoft Graph refused the request (${r.status})`);
    return r.json();
  }
  // the id_token comes straight from the token endpoint over TLS, so its claims are checked without the signature (OpenID Connect Core 3.1.3.7)
  function idClaims(c, idToken, state) {
    let p; try { p = JSON.parse(Buffer.from(String(idToken).split('.')[1] || '', 'base64url').toString('utf8')); } catch { throw fail(502, 'Microsoft sent an unreadable sign-in answer'); }
    if (p.aud !== c.clientId) throw fail(400, 'The sign-in answer was issued for another application');
    if (String(p.tid || '').toLowerCase() !== c.tenant.toLowerCase()) throw fail(400, 'The Microsoft account belongs to another organisation');
    if (p.nonce !== nonceOf(c.key, state)) throw fail(400, 'The sign-in answer does not belong to this request');
    if (p.exp && p.exp * 1000 < Date.now() - 300e3) throw fail(400, 'The sign-in answer has expired');
    return p;
  }

  // ---------- access token for a linked user (refreshed when needed; a refresh failure is audited) ----------
  ctx.m365Token = async userId => {
    const c = cfg(); if (!c.enabled || !c.configured) throw fail(503, 'Microsoft 365 is not enabled');
    const row = db.prepare('SELECT * FROM m365_connections WHERE user_id=?').get(userId); if (!row) throw fail(404, 'This account is not linked to Microsoft 365');
    if (row.expires_at && Date.parse(row.expires_at) > Date.now() + 120e3) return open(c.key, row.access_token_encrypted);
    try {
      const t = await tokenCall(c, { grant_type: 'refresh_token', refresh_token: open(c.key, row.refresh_token_encrypted) || '' });
      db.prepare('UPDATE m365_connections SET access_token_encrypted=?, refresh_token_encrypted=COALESCE(?,refresh_token_encrypted), expires_at=?, updated_at=? WHERE id=?')
        .run(seal(c.key, t.access_token), t.refresh_token ? seal(c.key, t.refresh_token) : null, new Date(Date.now() + (+t.expires_in || 3600) * 1000).toISOString(), now(), row.id);
      return t.access_token;
    } catch (e) {
      audit(sysReq, 'refresh-failed', 'm365', userId, String(e.message).slice(0, 200));
      throw fail(502, 'The Microsoft 365 link has to be renewed — disconnect and connect again');
    }
  };
  // backups leave the server without Microsoft tokens or pending sign-ins (the link is re-made with Connect after a restore)
  ctx.scrubBackupTokens = file => {
    const { DatabaseSync } = require('node:sqlite'), b = new DatabaseSync(file);
    try {
      if (b.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='m365_connections'").get()) b.exec('UPDATE m365_connections SET access_token_encrypted=NULL, refresh_token_encrypted=NULL, expires_at=NULL');
      if (b.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='oauth_states'").get()) b.exec('DELETE FROM oauth_states');
      b.exec('VACUUM');                                                       // no copy of the removed values left in free pages
    } finally { b.close(); }
  };

  const html = (res, code, title, msg) => {
    res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
    const e = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(title)}</title><body style="font:15px system-ui,sans-serif;max-width:520px;margin:12vh auto;padding:0 16px;color:#1F3A5F"><h2>${e(title)}</h2><p>${e(msg)}</p><p><a href="/#settings">← Trigon ERP</a></p></body>`);
  };
  const isHttps = req => req.headers['x-forwarded-proto'] === 'https' || process.env.SECURE_COOKIES === '1';
  const reqHost = req => (process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-host'] ? String(req.headers['x-forwarded-host']).split(',').pop().trim() : String(req.headers.host || '')).toLowerCase();
  const BIND = 'm365_flow', bindCookie = (req, v, age) => `${BIND}=${v}; HttpOnly; SameSite=Lax; Path=/auth/microsoft; Max-Age=${age}${isHttps(req) ? '; Secure' : ''}`;
  const readBind = req => (/(?:^|;\s*)m365_flow=([A-Za-z0-9_-]{43})/.exec(req.headers.cookie || '') || [])[1] || '';

  // ---------- /auth/microsoft and /auth/microsoft/callback (outside /api: they are browser navigations) ----------
  ctx.m365Auth = async (req, res, url) => {
    if (url.pathname !== '/auth/microsoft' && url.pathname !== '/auth/microsoft/callback') return false;
    if (req.method !== 'GET') return html(res, 405, 'Not allowed', 'Use the Connect button in Settings.'), true;
    const c = cfg(); noteConfig(c);
    if (!c.enabled) return html(res, 404, 'Microsoft 365 is off', 'The Microsoft 365 link is not enabled on this server.'), true;
    if (!c.configured) return html(res, 503, 'Microsoft 365 is not configured', 'The server settings for Microsoft 365 are incomplete. Ask the administrator to check the .env file.'), true;
    // the callback must arrive at exactly the registered address
    if (reqHost(req) !== c.redirectUrl.host.toLowerCase()) return html(res, 400, 'Wrong address', 'Open the system at its registered address and try again.'), true;

    if (url.pathname === '/auth/microsoft') {
      const me = ctx.sessionUser(req);
      if (!me) return html(res, 401, 'Sign in first', 'Sign in to Trigon ERP as an administrator, then use Connect in Settings.'), true;
      if (me.role !== 'admin') return html(res, 403, 'Administrators only', 'Only an administrator can link Microsoft 365 in this phase.'), true;
      db.prepare('DELETE FROM oauth_states WHERE expires_at < ? OR used_at IS NOT NULL').run(now());
      const state = b64u(crypto.randomBytes(32)), verifier = b64u(crypto.randomBytes(48)), binding = b64u(crypto.randomBytes(32));
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
      db.prepare('INSERT INTO oauth_states(user_id,provider,state_hash,verifier_encrypted,expires_at,created_at) VALUES(?,?,?,?,?,?)')
        .run(me.id, PROVIDER, stateHash(state, binding), seal(c.key, verifier), new Date(Date.now() + STATE_TTL).toISOString(), now());
      const q = new URLSearchParams({ client_id: c.clientId, response_type: 'code', redirect_uri: c.redirect, response_mode: 'query', scope: SCOPES,
        state, nonce: nonceOf(c.key, state), code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account' });
      res.writeHead(302, { Location: `${c.loginBase}/${encodeURIComponent(c.tenant)}/oauth2/v2.0/authorize?${q}`, 'Set-Cookie': bindCookie(req, binding, STATE_TTL / 1000), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      return res.end(), true;
    }

    // ---- callback ----
    const state = url.searchParams.get('state') || '', code = url.searchParams.get('code') || '', binding = readBind(req);
    const clear = { 'Set-Cookie': bindCookie(req, '', 0) };
    const reject = msg => { res.setHeader('Set-Cookie', clear['Set-Cookie']); return html(res, 400, 'Microsoft 365 was not connected', msg), true; };
    if (!state || state.length > 100) return reject('The sign-in request is missing its check value. Start again from Settings.');
    const row = db.prepare('SELECT * FROM oauth_states WHERE state_hash=? AND provider=?').get(stateHash(state, binding), PROVIDER);
    if (!row) return reject('This sign-in request is not known in this browser. Start again from Settings.');
    if (row.used_at) return reject('This sign-in request was already used. Start again from Settings.');
    const used = db.prepare('UPDATE oauth_states SET used_at=? WHERE id=? AND used_at IS NULL').run(now(), row.id);   // single use, even if the rest fails
    if (!used.changes) return reject('This sign-in request was already used. Start again from Settings.');
    if (Date.parse(row.expires_at) < Date.now()) return reject('This sign-in request has expired (10 minutes). Start again from Settings.');
    const user = db.prepare('SELECT id, username, role FROM users WHERE id=? AND COALESCE(disabled,0)=0').get(row.user_id);
    if (!user || user.role !== 'admin') return reject('Only an administrator can link Microsoft 365.');
    if (url.searchParams.get('error')) return reject(`Microsoft did not allow the link (${String(url.searchParams.get('error')).replace(/[^\w.-]/g, '').slice(0, 60)}).`);
    if (!code || code.length > 4000) return reject('Microsoft did not send an authorisation code.');
    try {
      const t = await tokenCall(c, { grant_type: 'authorization_code', code, redirect_uri: c.redirect, code_verifier: open(c.key, row.verifier_encrypted) });
      const claims = idClaims(c, t.id_token, state), me = await graphMe(c, t.access_token);
      if (claims.oid && me.id && claims.oid !== me.id) throw fail(400, 'The Microsoft account changed during sign-in');
      const email = me.mail || me.userPrincipalName || claims.preferred_username || null, ts = now(), exp = new Date(Date.now() + (+t.expires_in || 3600) * 1000).toISOString();
      db.prepare(`INSERT INTO m365_connections(user_id,tenant_id,microsoft_user_id,email,display_name,access_token_encrypted,refresh_token_encrypted,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET tenant_id=excluded.tenant_id, microsoft_user_id=excluded.microsoft_user_id, email=excluded.email, display_name=excluded.display_name,
        access_token_encrypted=excluded.access_token_encrypted, refresh_token_encrypted=excluded.refresh_token_encrypted, expires_at=excluded.expires_at, updated_at=excluded.updated_at`)
        .run(user.id, claims.tid, me.id || claims.oid, email, me.displayName || claims.name || null, seal(c.key, t.access_token), t.refresh_token ? seal(c.key, t.refresh_token) : null, exp, ts, ts);
      db.prepare('INSERT INTO audit_log(ts,user,action,tbl,rec,detail) VALUES(?,?,?,?,?,?)').run(ts, user.username, 'connect', 'm365', user.id, `linked to ${String(email || '').slice(0, 120)}`);
      res.writeHead(302, { Location: '/#settings', ...clear, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      return res.end(), true;
    } catch (e) {
      db.prepare('INSERT INTO audit_log(ts,user,action,tbl,rec,detail) VALUES(?,?,?,?,?,?)').run(now(), user.username, 'connect-failed', 'm365', user.id, String(e.message).slice(0, 200));
      return reject(e.status && e.status < 500 ? e.message : 'Microsoft 365 could not be linked right now. Try again later.');
    }
  };

  return {
    async handle(req, res, url, [a, b], me) {
      if (a !== 'm365') return false;
      if (me.role !== 'admin') return send(res, 403, { error: 'your role does not allow this action' }), true;    // also enforced in lib/acl.js
      const c = cfg(); noteConfig(c);
      if (b === 'status' && req.method === 'GET') {
        const link = db.prepare('SELECT email, display_name, tenant_id, expires_at, updated_at FROM m365_connections WHERE user_id=?').get(me.id);
        return send(res, 200, { enabled: c.enabled, configured: c.enabled && c.configured, missing: c.enabled ? c.missing : [],
          tenant_id: c.tenant || null, client_id: c.clientId || null, redirect_uri: c.redirect || null, sharepoint_site_id: c.siteId || null, sharepoint_drive_id: c.driveId || null,
          client_secret_set: !!c.secret, encryption_key_set: !!c.key, scopes: SCOPES.split(' '),
          connection: link ? { email: link.email, display_name: link.display_name, tenant_id: link.tenant_id, linked_at: link.updated_at } : null }), true;
      }
      if (b === 'disconnect' && req.method === 'POST') {
        await readBody(req).catch(() => ({}));
        const r = db.prepare('DELETE FROM m365_connections WHERE user_id=?').run(me.id);
        db.prepare('DELETE FROM oauth_states WHERE user_id=?').run(me.id);
        audit(req, 'disconnect', 'm365', me.id, r.changes ? 'link removed' : 'nothing linked');
        return send(res, 200, { ok: 1, removed: r.changes }), true;
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
