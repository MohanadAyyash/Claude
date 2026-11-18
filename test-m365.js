// Microsoft 365 Phase 1 (+1C: every user links their own account): off by default, fails closed, OAuth 2.0 Authorization Code + PKCE against a LOCAL mock of
// Entra ID (token endpoint + JWKS) and Graph — no internet. id_tokens are really signed (RS256) and verified with jose; every forged,
// expired or mismatched answer is refused without touching m365_connections. Also: one Microsoft identity per ERP user, hashed
// single-use state, encrypted tokens and their rotation, and backups that never carry credentials: node --no-warnings test-m365.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert'), http = require('http'), crypto = require('crypto'), { execFileSync } = require('child_process');
const jose = require('jose');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-m365-'));
process.env.ZOHO_NO_SCHEDULER = '1'; process.env.SALES_NO_SCHEDULER = '1'; process.env.BACKUP_NO_SCHEDULER = '1';
for (const k of Object.keys(process.env)) if (k.startsWith('M365_')) delete process.env[k];       // case 1: nothing configured
delete process.env.TRUST_PROXY;

// everything written to the console is captured, to prove no token, code, secret or verifier is ever logged
const logged = [];
for (const m of ['log', 'error', 'warn', 'info']) { const o = console[m].bind(console); console[m] = (...a) => { logged.push(a.map(x => (x && x.stack) || String(x)).join(' ')); o(...a); }; }

const { server } = require('./server.js');
const { DatabaseSync } = require('node:sqlite');
const { sanitizedCopy } = require('./lib/backupsafe');
const TENANT = '11111111-2222-3333-4444-555555555555', CLIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', SECRET = 'test-client-secret-NOT-REAL-9f8e7d';
const OID = '0a0a0a0a-1111-2222-3333-444444444444', OID2 = '0b0b0b0b-1111-2222-3333-444444444444';
const KEY = crypto.randomBytes(32).toString('base64');
const CODE = 'mock-auth-code-CODE-444';

(async () => {
  // ---- signing keys: the published one, and an attacker's one with its own kid ----
  const good = await jose.generateKeyPair('RS256', { extractable: true }), evil = await jose.generateKeyPair('RS256', { extractable: true });
  const publicJwk = { ...(await jose.exportJWK(good.publicKey)), kid: 'entra-key-1', use: 'sig', alg: 'RS256' };

  // ---- local mock of login.microsoftonline.com and graph.microsoft.com ----
  const mock = { tokenCalls: [], jwksCalls: 0, jwks: 'ok', refreshFails: false, rotate: 0, tokens: [], me: { id: OID, displayName: 'Test Admin', mail: 'admin@example.test' }, idToken: null };
  let issued = 0; const newToken = kind => { const t = `mock-${kind}-token-${++issued}-${crypto.randomBytes(6).toString('hex')}`; mock.tokens.push(t); return t; };
  const sign = async (claims = {}, { key = good.privateKey, kid = 'entra-key-1', alg = 'RS256', omit = [] } = {}) => {
    const base = { iss: `${process.env.M365_LOGIN_BASE}/${TENANT}/v2.0`, aud: CLIENT, tid: TENANT, oid: OID, sub: 'pairwise-sub-1', nonce: mock.pending.nonce, name: 'Test Admin', preferred_username: 'admin@example.test',
      iat: Math.floor(Date.now() / 1000), nbf: Math.floor(Date.now() / 1000) - 5, exp: Math.floor(Date.now() / 1000) + 3600, ...claims };
    for (const k of omit) delete base[k];
    return new jose.SignJWT(base).setProtectedHeader({ alg, kid, typ: 'JWT' }).sign(key);
  };
  const ms = http.createServer((rq, rs) => { let body = ''; rq.on('data', c => body += c); rq.on('end', async () => {
    const out = (code, j) => { rs.writeHead(code, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify(j)); };
    if (rq.url === `/${TENANT}/discovery/v2.0/keys`) {
      mock.jwksCalls++;
      if (mock.jwks === 'down') return out(503, { error: 'unavailable' });
      if (mock.jwks === 'drop') return rs.destroy();                            // connection cut: a network failure
      return out(200, { keys: [publicJwk] });
    }
    if (rq.url === `/${TENANT}/oauth2/v2.0/token` && rq.method === 'POST') {
      const f = new URLSearchParams(body); mock.tokenCalls.push(Object.fromEntries(f));
      if (f.get('client_id') !== CLIENT || f.get('client_secret') !== SECRET || f.get('scope') !== 'openid profile email offline_access User.Read') return out(401, { error: 'invalid_client' });
      if (f.get('grant_type') === 'authorization_code') {
        const st = mock.pending; if (!st || f.get('code') !== CODE || f.get('redirect_uri') !== mock.redirect) return out(400, { error: 'invalid_grant', error_description: 'bad code ' + f.get('code') });
        if (crypto.createHash('sha256').update(f.get('code_verifier') || '').digest('base64url') !== st.challenge || st.method !== 'S256') return out(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
        mock.verifiers = [...(mock.verifiers || []), f.get('code_verifier')];
        const id_token = typeof mock.idToken === 'function' ? await mock.idToken() : await sign();
        return out(200, { token_type: 'Bearer', expires_in: 3600, access_token: newToken('access'), refresh_token: newToken('refresh'), id_token });
      }
      if (f.get('grant_type') === 'refresh_token') {
        if (mock.refreshFails || !mock.tokens.includes(f.get('refresh_token'))) return out(400, { error: 'invalid_grant', error_description: 'refresh token ' + f.get('refresh_token') + ' revoked' });
        mock.lastRefreshUsed = f.get('refresh_token');
        return out(200, { token_type: 'Bearer', expires_in: 3600, access_token: newToken('access'), ...(mock.rotate ? { refresh_token: newToken('refresh') } : {}) });
      }
      return out(400, { error: 'unsupported_grant_type' });
    }
    if (rq.url.startsWith('/v1.0/me')) { const tok = (rq.headers.authorization || '').replace('Bearer ', ''); return mock.tokens.includes(tok) ? out(200, mock.me) : out(401, { error: { code: 'InvalidAuthenticationToken' } }); }
    out(404, { error: 'not_found' });
  }); });

  server.listen(0, async () => {
    await new Promise(r => ms.listen(0, r));
    const port = server.address().port, base = `http://127.0.0.1:${port}`; let cookie = '';
    const call = async (m, u, b, ck = cookie) => { const r = await fetch(base + '/api/' + u, { method: m, redirect: 'manual', headers: { 'Content-Type': 'application/json', cookie: ck }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); if (sc && /sid=[a-f0-9]/.test(sc) && ck === cookie) cookie = sc.split(';')[0]; const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j, t }; };
    const login = async (u, p = 'secret12') => { const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) }); assert.equal(r.status, 200, 'login ' + u); return r.headers.get('set-cookie').split(';')[0]; };
    const nav = (u, ck = cookie) => fetch(base + u, { redirect: 'manual', headers: { cookie: ck } }).then(async r => ({ s: r.status, loc: r.headers.get('location') || '', setCookie: r.headers.get('set-cookie') || '', t: await r.text() }));
    const ok = (r, l) => { assert.equal(r.s, 200, `${l || ''} → ${r.s} ${JSON.stringify(r.j).slice(0, 300)}`); return r.j; };
    const dbFile = path.join(process.env.DATA_DIR, 'erp.db');
    const q = (sql, ...a) => { const d = new DatabaseSync(dbFile, { readOnly: true }); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
    const exec = (sql, ...a) => { const d = new DatabaseSync(dbFile); try { return d.prepare(sql).run(...a); } finally { d.close(); } };
    const links = () => q('SELECT * FROM m365_connections ORDER BY id');
    const secrets = () => [...mock.tokens, CODE, SECRET, KEY, ...(mock.verifiers || [])];
    const noSecret = (text, where) => { for (const s of secrets()) assert.ok(!String(text).includes(s), `${where} must not contain a secret (${s.slice(0, 14)}…)`); };
    const unseal = box => { const [, iv, tag, ct] = box.split('.'); const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(KEY, 'base64'), Buffer.from(iv, 'base64url')); d.setAuthTag(Buffer.from(tag, 'base64url')); return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString(); };
    // start the flow as a signed-in admin and play the Microsoft side
    const start = async (ck = cookie) => {
      const r = await nav('/auth/microsoft', ck); assert.equal(r.s, 302, r.t); const a = new URL(r.loc), p = a.searchParams;
      mock.pending = { challenge: p.get('code_challenge'), method: p.get('code_challenge_method'), nonce: p.get('nonce') }; mock.redirect = p.get('redirect_uri');
      return { auth: a, state: p.get('state'), bind: (/m365_flow=([^;]+)/.exec(r.setCookie) || [])[1], setCookie: r.setCookie };
    };
    const cb = (qs, bind) => nav(`/auth/microsoft/callback?${qs}`, bind ? `m365_flow=${bind}` : '');      // the ERP cookie is SameSite=Strict: not sent on the callback
    const attempt = async (idToken, ck = cookie) => { mock.idToken = idToken; const f = await start(ck); const r = await cb(`code=${CODE}&state=${f.state}`, f.bind); mock.idToken = null; return r; };
    const refused = async (label, idToken, re, ck) => {
      const n = links().length, rows = JSON.stringify(links()), r = await attempt(idToken, ck);
      assert.equal(r.s, 400, `${label}: expected a refusal, got ${r.s} ${r.t.slice(0, 200)}`); if (re) assert.match(r.t, re, label);
      assert.equal(links().length, n, `${label}: no link created`); assert.equal(JSON.stringify(links()), rows, `${label}: no link changed`);
      assert.equal(q('SELECT COUNT(*) n FROM oauth_states')[0].n, 0, `${label}: the state is removed after the callback`);
      noSecret(r.t, label);
    };
    try {
      // ---- 1–4. starts with no M365 settings; status admin only; off by default
      assert.equal((await call('GET', 'status')).s, 200, 'server answers');
      for (const [m, u] of [['GET', 'm365/status'], ['POST', 'm365/disconnect'], ['POST', 'm365/check']]) assert.equal((await call(m, u, m === 'POST' ? {} : undefined, '')).s, 401, `unauthenticated ${u}`);
      ok(await call('POST', 'setup', { username: 'admin', password: 'secret12', company: 'Test Co' }));
      let st = ok(await call('GET', 'm365/status')); assert.equal(st.enabled, false); assert.equal(st.configured, false); assert.equal(st.client_secret_set, false);
      assert.equal((await nav('/auth/microsoft')).s, 404, 'flow is off');
      const adminCookie = cookie, roles = ['accountant', 'manager', 'qs', 'site_engineer', 'foreman', 'procurement', 'storekeeper', 'hr', 'viewer'], roleCookies = {};
      for (const role of roles) ok(await call('POST', 'users', { username: 'u_' + role, password: 'secret12', role }));
      ok(await call('POST', 'users', { username: 'admin2', password: 'secret12', role: 'admin' }));
      for (const role of roles) {
        roleCookies[role] = await login('u_' + role);
        // Phase 1C: every role manages its OWN link; it never sees the server's Microsoft settings
        const own = ok(await call('GET', 'm365/status', undefined, roleCookies[role]), `${role} status`);
        assert.deepEqual(Object.keys(own).sort(), ['available', 'configured', 'connection', 'enabled'], `${role}: own link state only (no tenant / client ID / settings)`);
        assert.equal(ok(await call('POST', 'm365/disconnect', {}, roleCookies[role])).removed, 0, `${role}: nothing of its own to remove`);
        assert.equal((await call('POST', 'm365/check', {}, roleCookies[role])).s, 503, `${role}: check while off`);
      }
      const admin2 = await login('admin2');
      console.log('✔ 1–4: starts with no M365 settings; every M365 API: 401 unauthenticated; non-admin roles see only their own link state; off by default');

      // ---- 5. enabled but incomplete → fails closed
      Object.assign(process.env, { M365_ENABLED: '1', M365_TENANT_ID: TENANT, M365_CLIENT_SECRET: SECRET, M365_REDIRECT_URI: `${base}/auth/microsoft/callback` });
      st = ok(await call('GET', 'm365/status')); assert.equal(st.enabled, true); assert.equal(st.configured, false);
      assert.deepEqual(st.missing.sort(), ['M365_CLIENT_ID', 'M365_ENCRYPTION_KEY']); noSecret(JSON.stringify(st), 'status');
      assert.equal((await nav('/auth/microsoft')).s, 503, 'incomplete configuration refuses to start');
      process.env.M365_CLIENT_ID = CLIENT; process.env.M365_ENCRYPTION_KEY = 'too-short';
      assert.equal((await nav('/auth/microsoft')).s, 503, 'a bad encryption key also fails closed');
      process.env.M365_TENANT_ID = 'common'; process.env.M365_ENCRYPTION_KEY = KEY;
      assert.deepEqual(ok(await call('GET', 'm365/status')).missing, ['M365_TENANT_ID'], 'common / organizations are refused: tenant-specific only');
      process.env.M365_TENANT_ID = TENANT; process.env.M365_REDIRECT_URI = 'http://erp.example.test/auth/microsoft/callback';
      assert.deepEqual(ok(await call('GET', 'm365/status')).missing, ['M365_REDIRECT_URI'], 'a plain-http public redirect is refused');
      process.env.M365_REDIRECT_URI = `${base}/auth/microsoft/callback`;
      Object.assign(process.env, { M365_LOGIN_BASE: `http://127.0.0.1:${ms.address().port}`, M365_GRAPH_BASE: `http://127.0.0.1:${ms.address().port}/v1.0` });
      st = ok(await call('GET', 'm365/status')); assert.equal(st.configured, true, JSON.stringify(st.missing)); assert.equal(st.client_secret_set, true); assert.equal(st.encryption_key_set, true);
      noSecret(JSON.stringify(st), 'status'); assert.ok(!('client_secret' in st) && !('encryption_key' in st));
      assert.deepEqual(st.scopes, ['openid', 'profile', 'email', 'offline_access', 'User.Read'], 'least privilege only');
      assert.ok(q("SELECT * FROM audit_log WHERE tbl='m365' AND action='config-change'").length >= 2, 'configuration changes are audited');
      console.log('✔ 5: enabled but incomplete / common tenant / http redirect fail closed (names only, never values); configuration changes audited');

      // ---- 6. authorization start
      assert.equal((await nav('/auth/microsoft', '')).s, 401, 'not signed in'); { const ra = await nav('/auth/microsoft', roleCookies.accountant); assert.equal(ra.s, 302, 'any active user may link their own account (Phase 1C)'); assert.equal(q('SELECT user_id FROM oauth_states')[0].user_id, q("SELECT id FROM users WHERE username='u_accountant'")[0].id, 'for that user'); exec('DELETE FROM oauth_states'); }
      const before = Date.now(), f1 = await start(), p = f1.auth.searchParams;
      assert.equal(f1.auth.origin + f1.auth.pathname, `${process.env.M365_LOGIN_BASE}/${TENANT}/oauth2/v2.0/authorize`, 'tenant-specific endpoint');
      assert.equal(p.get('response_type'), 'code'); assert.equal(p.get('client_id'), CLIENT); assert.equal(p.get('code_challenge_method'), 'S256');
      assert.match(p.get('code_challenge'), /^[\w-]{43}$/); assert.match(f1.state, /^[\w-]{43}$/); assert.equal(p.get('redirect_uri'), process.env.M365_REDIRECT_URI);
      assert.equal(p.get('scope'), 'openid profile email offline_access User.Read'); assert.ok(!p.get('client_secret')); assert.ok(p.get('nonce'));
      assert.match(f1.setCookie, /^m365_flow=[\w-]{43}; HttpOnly; SameSite=Lax; Path=\/auth\/microsoft; Max-Age=600$/, 'binding cookie, not Secure on a local http redirect');
      let rows = q('SELECT * FROM oauth_states'); assert.equal(rows.length, 1); const row = rows[0];
      assert.ok(!JSON.stringify(rows).includes(f1.state), 'the raw state is not stored'); assert.match(row.verifier_encrypted, /^v1\.[\w-]{16}\.[\w-]{22}\.[\w-]+$/); assert.equal(row.used_at, null);
      const ttl = Date.parse(row.expires_at) - before; assert.ok(ttl > 9.9 * 60e3 && ttl <= 10 * 60e3 + 2000, 'expires in 10 minutes: ' + ttl);
      console.log('✔ 6: start creates state + PKCE (S256), stores only a hash of the state and an encrypted verifier, 10-minute expiry, Lax binding cookie');

      // ---- 7. OAuth state / callback parameters (nothing reaches Microsoft, nothing is linked)
      assert.equal((await cb(`code=${CODE}`, f1.bind)).s, 400, 'missing state');
      assert.equal((await cb(`code=${CODE}&state=${'x'.repeat(43)}`, f1.bind)).s, 400, 'mismatched state');
      assert.equal((await cb(`code=${CODE}&state=${f1.state}`, 'y'.repeat(43))).s, 400, 'wrong browser-binding cookie');
      assert.equal((await cb(`code=${CODE}&state=${f1.state}`, '')).s, 400, 'no binding cookie');
      let r = await cb(`state=${f1.state}`, f1.bind); assert.equal(r.s, 400); assert.match(r.t, /authorisation code/, 'missing code');
      assert.equal((await cb(`code=${CODE}&state=${f1.state}`, f1.bind)).s, 400, 'a state is used up even when its callback failed (no replay)');
      const fe = await start(); r = await cb(`error=access_denied&error_description=user+said+no&state=${fe.state}`, fe.bind); assert.equal(r.s, 400); assert.match(r.t, /did not allow/);
      const fx = await start(); exec("UPDATE oauth_states SET expires_at='2000-01-01T00:00:00.000Z' WHERE used_at IS NULL"); r = await cb(`code=${CODE}&state=${fx.state}`, fx.bind); assert.equal(r.s, 400); assert.match(r.t, /expired/);
      const fd = await start(admin2); exec('UPDATE users SET disabled=1 WHERE username=?', 'admin2');
      r = await cb(`code=${CODE}&state=${fd.state}`, fd.bind); assert.equal(r.s, 400, 'disabled before the callback'); assert.match(r.t, /active Trigon ERP user|not known/, 'its pending sign-in is dropped');
      exec('UPDATE users SET disabled=0 WHERE username=?', 'admin2');
      const f5 = await start(), wrongHost = await new Promise((ok_, no) => http.get({ host: '127.0.0.1', port, path: `/auth/microsoft/callback?code=${CODE}&state=${f5.state}`, headers: { cookie: `m365_flow=${f5.bind}`, host: 'evil.example' } }, rr => { rr.resume(); ok_(rr.statusCode); }).on('error', no));
      assert.equal(wrongHost, 400, 'Host header must match the registered redirect URI'); exec('DELETE FROM oauth_states');
      assert.equal(mock.tokenCalls.length, 0, 'no rejected callback reached Microsoft'); assert.equal(links().length, 0);
      console.log('✔ 7: missing / mismatched / wrong-browser / expired / reused state, missing code, authorization error, user disabled mid-flow, wrong host — all refused, nothing linked');

      // ---- id_token verification (signed with jose; every bad one refused, m365_connections untouched)
      mock.jwks = 'down'; await refused('JWKS unavailable', null, /keys could not be checked/);
      mock.jwks = 'drop'; await refused('JWKS network failure', null, /keys could not be checked/); mock.jwks = 'ok';
      const tampered = async () => { const t = await sign(), [h, , s] = t.split('.'); return [h, Buffer.from(JSON.stringify({ ...jose.decodeJwt(t), oid: OID2 })).toString('base64url'), s].join('.'); };
      await refused('tampered payload', tampered, /could not be verified/);
      await refused('forged signature (attacker key, published kid)', () => sign({}, { key: evil.privateKey }), /could not be verified/);
      await refused('unknown kid', () => sign({}, { key: evil.privateKey, kid: 'attacker-key' }), /key Microsoft does not publish/);
      await refused('wrong issuer', () => sign({ iss: `https://login.microsoftonline.com/${TENANT}/v2.0` }));
      await refused('wrong issuer (other tenant)', () => sign({ iss: `${process.env.M365_LOGIN_BASE}/99999999-2222-3333-4444-555555555555/v2.0` }));
      await refused('wrong audience', () => sign({ aud: '99999999-bbbb-cccc-dddd-eeeeeeeeeeee' }));
      await refused('wrong tenant claim', () => sign({ tid: '99999999-2222-3333-4444-555555555555' }), /another organisation/);
      await refused('wrong nonce', () => sign({ nonce: 'not-the-nonce' }), /does not belong to this request/);
      await refused('expired', () => sign({ exp: Math.floor(Date.now() / 1000) - 600, iat: Math.floor(Date.now() / 1000) - 4000 }), /expired/);
      await refused('not yet valid (nbf)', () => sign({ nbf: Math.floor(Date.now() / 1000) + 600 }));
      await refused('unsupported algorithm PS256', () => sign({}, { alg: 'PS256' }), /not accepted/);
      await refused('unsupported algorithm HS256', async () => new jose.SignJWT({ aud: CLIENT }).setProtectedHeader({ alg: 'HS256', kid: 'entra-key-1' }).sign(crypto.randomBytes(32)), /not accepted/);
      await refused('alg none', async () => [Buffer.from('{"alg":"none","kid":"entra-key-1"}').toString('base64url'), Buffer.from(JSON.stringify({ aud: CLIENT, tid: TENANT })).toString('base64url'), ''].join('.'));
      await refused('no kid', async () => new jose.SignJWT({ aud: CLIENT }).setProtectedHeader({ alg: 'RS256' }).sign(good.privateKey), /signing key/);
      await refused('missing oid', () => sign({}, { omit: ['oid'] }));
      await refused('missing exp', () => sign({}, { omit: ['exp'] }));
      await refused('missing nonce', () => sign({}, { omit: ['nonce'] }));
      await refused('malformed JWT', async () => 'abc.def');
      await refused('no id_token', async () => undefined, /incomplete/);
      mock.me = { displayName: 'No Id', mail: 'x@example.test' }; await refused('Graph /me without id', null, /did not identify/);
      mock.me = { id: OID2, displayName: 'Other', mail: 'other@example.test' }; await refused('oid ≠ Graph id', null, /changed during sign-in/);
      mock.me = { id: OID, displayName: 'Test Admin', mail: 'admin@example.test' };
      assert.ok(mock.jwksCalls >= 1, 'keys come from the tenant JWKS'); assert.equal(q("SELECT COUNT(*) n FROM audit_log WHERE tbl='m365' AND action='connect-failed'")[0].n >= 20, true);
      console.log('✔ id_token: JWKS down / cut, tampered, forged, unknown kid, wrong issuer / audience / tenant / nonce, expired, nbf, PS256 / HS256 / none, no kid, missing oid / exp / nonce, malformed, Graph id missing or different — all refused, no link');

      // ---- the valid signed answer links the account
      r = await attempt(null); assert.equal(r.s, 302, r.t); assert.equal(r.loc, '/#settings'); assert.match(r.setCookie, /m365_flow=; .*Max-Age=0/);
      let L = links(); assert.equal(L.length, 1); assert.equal(L[0].tenant_id, TENANT); assert.equal(L[0].microsoft_user_id, OID); assert.equal(L[0].email, 'admin@example.test');
      assert.match(L[0].access_token_encrypted, /^v1\./); assert.match(L[0].refresh_token_encrypted, /^v1\./); assert.equal(q('SELECT COUNT(*) n FROM oauth_states')[0].n, 0, 'state removed after success');
      const dbBytes = fs.readFileSync(dbFile).toString('latin1') + (fs.existsSync(dbFile + '-wal') ? fs.readFileSync(dbFile + '-wal').toString('latin1') : ''); noSecret(dbBytes, 'the database file');
      st = ok(await call('GET', 'm365/status')); assert.equal(st.connection.email, 'admin@example.test'); noSecret(JSON.stringify(st), 'status');
      // same user reconnects, the email changed: same identity, same row, updated
      mock.me = { id: OID, displayName: 'Test Admin', mail: 'renamed@example.test' }; r = await attempt(null); assert.equal(r.s, 302, r.t);
      L = links(); assert.equal(L.length, 1, 'no new identity for a new email'); assert.equal(L[0].email, 'renamed@example.test'); assert.equal(L[0].microsoft_user_id, OID);
      // the same Microsoft account cannot be linked to a second ERP user
      r = await attempt(null, admin2); assert.equal(r.s, 400); assert.match(r.t, /already linked to another user/); assert.ok(!/UNIQUE|constraint|SQLITE/i.test(r.t), 'no DB detail');
      L = links(); assert.equal(L.length, 1); assert.equal(L[0].user_id, q("SELECT id FROM users WHERE username='admin'")[0].id);
      assert.throws(() => exec("INSERT INTO m365_connections(user_id,tenant_id,microsoft_user_id,created_at,updated_at) VALUES((SELECT id FROM users WHERE username='admin2'),?,?,'x','x')", TENANT, OID), /UNIQUE/, 'unique (tenant, object ID) in the database');
      console.log('✔ valid signed answer links; reconnect updates the same row (email change = same identity); one Microsoft identity cannot link a second ERP user (DB unique index too)');

      // ---- tokens: refresh, rotation, failure
      const adminId = q("SELECT id FROM users WHERE username='admin'")[0].id, rt0 = unseal(links()[0].refresh_token_encrypted);
      exec("UPDATE m365_connections SET expires_at='2000-01-01T00:00:00.000Z'"); mock.rotate = 1;
      assert.equal(ok(await call('POST', 'm365/check', {})).email, 'renamed@example.test'); assert.equal(mock.lastRefreshUsed, rt0, 'the stored refresh token was used');
      const rt1 = unseal(links()[0].refresh_token_encrypted); assert.notEqual(rt1, rt0, 'the rotated refresh token is stored'); assert.ok(mock.tokens.includes(rt1));
      assert.ok(Date.parse(links()[0].expires_at) > Date.now() + 3000e3, 'new expiry stored');
      exec("UPDATE m365_connections SET expires_at='2000-01-01T00:00:00.000Z'"); mock.rotate = 0;
      ok(await call('POST', 'm365/check', {})); assert.equal(unseal(links()[0].refresh_token_encrypted), rt1, 'kept when Microsoft does not rotate it');
      exec("UPDATE m365_connections SET expires_at='2000-01-01T00:00:00.000Z'"); mock.refreshFails = true;
      const rf = await call('POST', 'm365/check', {}); assert.equal(rf.s, 502); noSecret(rf.t, 'refresh error'); mock.refreshFails = false;
      const rfa = q("SELECT * FROM audit_log WHERE tbl='m365' AND action='refresh-failed'"); assert.equal(rfa.length, 1); noSecret(JSON.stringify(rfa), 'refresh audit');
      exec("UPDATE m365_connections SET access_token_encrypted='v1.AAAA.BBBB.CCCC', expires_at='2999-01-01T00:00:00.000Z'");
      const bad = await call('POST', 'm365/check', {}); assert.equal(bad.s, 502, 'a malformed stored value fails closed'); assert.ok(!/AAAA|BBBB|decipher|auth/i.test(bad.t), 'no crypto detail');
      exec("UPDATE m365_connections SET access_token_encrypted=?, expires_at='2000-01-01T00:00:00.000Z'", links()[0].refresh_token_encrypted.replace(/.$/, c => c === 'A' ? 'B' : 'A'));
      ok(await call('POST', 'm365/check', {}), 'an expired access token is simply refreshed');
      console.log('✔ refresh works, a rotated refresh token is stored (kept when not rotated); refresh failure and malformed stored values fail closed, audited without credentials');

      // ---- backups never carry credentials and stay restorable
      mock.idToken = null; const pending = await start();                     // a pending sign-in exists while backing up
      const dl = await fetch(base + '/api/backup', { headers: { cookie } }), file = path.join(process.env.DATA_DIR, 'dl.db'); fs.writeFileSync(file, Buffer.from(await dl.arrayBuffer()));
      const b = new DatabaseSync(file, { readOnly: true }), br = b.prepare('SELECT * FROM m365_connections').all(), bs = b.prepare('SELECT COUNT(*) n FROM oauth_states').get().n, ic = b.prepare('PRAGMA integrity_check').get(); b.close();
      assert.equal(br.length, 1); assert.equal(br[0].access_token_encrypted, null); assert.equal(br[0].refresh_token_encrypted, null); assert.equal(br[0].expires_at, null); assert.equal(bs, 0, 'no oauth state / PKCE verifier');
      assert.equal(Object.values(ic)[0], 'ok', 'integrity_check ok'); assert.equal(q('SELECT COUNT(*) n FROM oauth_states')[0].n, 1, 'the live database keeps the pending sign-in');
      const raw = fs.readFileSync(file).toString('latin1'); noSecret(raw, 'the backup'); assert.ok(!/v1\.[\w-]{16}\.[\w-]{22}\./.test(raw), 'not even encrypted tokens / verifier');
      assert.ok(!fs.readdirSync(process.env.DATA_DIR).some(n => /^backup-download-|\.partial-/.test(n)), 'no temporary backup left in the data folder');
      const run = ok(await call('POST', 'backup/run', {})), auto = path.join(process.env.DATA_DIR, 'backups', run.latest.name);
      const a2 = new DatabaseSync(auto, { readOnly: true }), ar = a2.prepare('SELECT access_token_encrypted a, refresh_token_encrypted r FROM m365_connections').get(), as2 = a2.prepare('SELECT COUNT(*) n FROM oauth_states').get().n; a2.close();
      assert.equal(ar.a, null); assert.equal(ar.r, null); assert.equal(as2, 0);
      if (process.platform !== 'win32') assert.equal(fs.statSync(auto).mode & 0o777, 0o600, 'backup file is 0600');
      // the sanitised backup restores
      const sand = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-m365-restore-')); fs.mkdirSync(path.join(sand, 'backups')); fs.copyFileSync(auto, path.join(sand, 'backups', run.latest.name));
      assert.match(execFileSync(process.execPath, ['--no-warnings', 'scripts/restore.js', run.latest.name], { env: { ...process.env, DATA_DIR: sand }, encoding: 'utf8' }), /Restored/);
      const rs = new DatabaseSync(path.join(sand, 'erp.db'), { readOnly: true }); assert.equal(rs.prepare('SELECT COUNT(*) n FROM users').get().n, 11); rs.close();
      // the scheduled-task script too
      execFileSync(process.execPath, ['--no-warnings', 'scripts/backup.js'], { env: { ...process.env, DATA_DIR: sand }, encoding: 'utf8' });
      // a sanitising failure publishes nothing and leaves no temporary copy; a previous good backup is kept
      const live = new DatabaseSync(dbFile), outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-m365-fail-')), dest = path.join(outDir, 'erp-x.db');
      fs.writeFileSync(dest, 'previous good backup');
      assert.throws(() => sanitizedCopy(live, dest, { afterCopy: tmp => { assert.ok(fs.existsSync(tmp)); throw new Error('disk full'); } }), /could not be prepared safely/);
      assert.equal(fs.readFileSync(dest, 'utf8'), 'previous good backup', 'previous backup untouched'); assert.deepEqual(fs.readdirSync(outDir), ['erp-x.db'], 'temporary copy removed');
      assert.throws(() => sanitizedCopy(live, path.join(outDir, 'erp-y.db'), { afterCopy: tmp => fs.writeFileSync(tmp, 'not a database at all') }));
      assert.deepEqual(fs.readdirSync(outDir), ['erp-x.db'], 'a corrupt copy is never published');
      live.close();
      console.log('✔ backups (download, automatic, script): no tokens, no state / verifier, integrity ok, 0600, restorable; a failure publishes nothing and keeps the previous backup');

      // ---- 9. disconnect: administrator only, local only, audited
      assert.equal(ok(await call('POST', 'm365/disconnect', {}, roleCookies.hr)).removed, 0, 'another user\'s disconnect removes only its own (nothing)'); assert.equal(links().length, 1, 'the admin\'s link is untouched');
      const dc = ok(await call('POST', 'm365/disconnect', {})); assert.equal(dc.removed, 1); assert.equal(dc.revoked_at_microsoft, false, 'does not claim a revocation at Microsoft');
      assert.equal(links().length, 0); assert.equal(q('SELECT COUNT(*) n FROM oauth_states')[0].n, 0);
      assert.match(q("SELECT detail FROM audit_log WHERE tbl='m365' AND action='disconnect' AND user='admin'")[0].detail, /Trigon ERP \(Microsoft consent not revoked\)/);
      // deleting / disabling a linked user removes the link (cascade + prune); a role change keeps it (Phase 1C)
      r = await attempt(null); assert.equal(r.s, 302); r = await attempt(null, admin2); assert.equal(r.s, 400, 'still one identity per user');
      const a2id = q("SELECT id FROM users WHERE username='admin2'")[0].id;
      mock.me = { id: OID2, displayName: 'Admin Two', mail: 'two@example.test' }; r = await attempt(() => sign({ oid: OID2 }), admin2); assert.equal(r.s, 302, r.t); mock.me = { id: OID, displayName: 'Test Admin', mail: 'admin@example.test' };
      assert.equal(links().length, 2);
      ok(await call('PUT', 'users/' + a2id, { role: 'accountant' })); ok(await call('GET', 'm365/status'));
      assert.equal(links().length, 2, 'role change: link kept (the user just has the new role\'s rights)');
      exec('UPDATE users SET disabled=1 WHERE id=?', a2id); ok(await call('GET', 'm365/status'));
      assert.equal(links().length, 1, 'disabled user: link removed'); assert.ok(q("SELECT * FROM audit_log WHERE tbl='m365' AND action='disconnect' AND user='system'").length === 1, 'and audited');
      exec('UPDATE users SET disabled=0 WHERE id=?', a2id); ok(await call('PUT', 'users/' + a2id, { role: 'admin' })); const admin2b = await login('admin2');
      mock.me = { id: OID2, displayName: 'Admin Two', mail: 'two@example.test' }; r = await attempt(() => sign({ oid: OID2 }), admin2b); assert.equal(r.s, 302, r.t); mock.me = { id: OID, displayName: 'Test Admin', mail: 'admin@example.test' };
      assert.equal(links().length, 2);
      ok(await call('DELETE', 'users/' + a2id)); assert.equal(links().length, 1, 'deleted user: link removed (ON DELETE CASCADE)');
      console.log('✔ 9: disconnect removes only the caller\'s own link, locally (revoked_at_microsoft:false), audited; disabled or deleted users lose their link, a role change keeps it');

      // ---- 8. nothing secret anywhere
      noSecret(JSON.stringify(q('SELECT * FROM audit_log')), 'the audit log'); noSecret(JSON.stringify(q('SELECT * FROM error_log')), 'the error log'); noSecret(logged.join('\n'), 'the console');
      console.log('✔ 8: no token, code, secret, key or PKCE verifier in responses, audit log, error log, console, database file or backups');

      // ---- 10. the ERP login is unchanged
      const c2 = await login('u_hr'); ok(await call('GET', 'notifications', undefined, c2)); const c3 = await login('admin'); ok(await call('GET', 'dashboard', undefined, c3));   // password login unchanged
      // ---- without the jose package the ERP still starts and the link stays closed (the update script does not copy node_modules)
      const child = `const M=require('module'),o=M._resolveFilename;M._resolveFilename=function(r,...a){if(r==='jose')throw Object.assign(new Error('not installed'),{code:'MODULE_NOT_FOUND'});return o.call(this,r,...a)};
        const {server}=require('./server.js');server.listen(0,async()=>{const b='http://127.0.0.1:'+server.address().port;let c='';
        const f=async(m,u,x)=>{const r=await fetch(b+u,{method:m,redirect:'manual',headers:{'Content-Type':'application/json',cookie:c},body:x?JSON.stringify(x):undefined});const k=r.headers.get('set-cookie');if(k&&/sid=/.test(k))c=k.split(';')[0];return r};
        await f('POST','/api/setup',{username:'admin',password:'secret12'});const st=await (await f('GET','/api/m365/status')).json();const a=await f('GET','/auth/microsoft');
        console.log(JSON.stringify({missing:st.missing,configured:st.configured,start:a.status}));server.close();process.exit(0)});`;
      const outJ = JSON.parse(execFileSync(process.execPath, ['--no-warnings', '-e', child], { cwd: __dirname, env: { ...process.env, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'erp-m365-nojose-')) }, encoding: 'utf8' }).trim().split('\n').pop());
      assert.equal(outJ.configured, false); assert.ok(outJ.missing.some(m => /^jose/.test(m)), JSON.stringify(outJ)); assert.equal(outJ.start, 503);
      console.log('✔ without the jose package: the ERP starts, status says jose is missing, the link refuses to start (fail closed)');
      // ---- the service worker never answers the sign-in or its callback itself (Windows test: the cached app page was shown for
      //      /auth/microsoft → blank page; it worked with "Bypass for network")
      {
        const vm = require('vm'), on = {}, origin = 'https://erp.example.test';
        const sw = { self: { addEventListener: (t, f) => { on[t] = f; }, registration: { scope: origin + '/' }, clients: {} }, location: { origin }, URL, Response, Promise,
          caches: { match: async () => new Response('<cached app page>'), open: async () => ({ match: async () => null, put() {} }), keys: async () => [] }, fetch: async () => new Response('network') };
        vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'public', 'sw.js'), 'utf8'), sw);
        const taken = (p, mode = 'navigate') => { let r = false; on.fetch({ request: { method: 'GET', mode, url: origin + p }, respondWith() { r = true; } }); return r; };
        for (const p of ['/auth/microsoft', '/auth/microsoft/callback?code=x&state=y', '/auth/microsoft/callback?error=access_denied']) {
          assert.equal(taken(p), false, 'the service worker leaves ' + p + ' to the server'); assert.equal(taken(p, 'no-cors'), false, p);
        }
        assert.equal(taken('/'), true, 'control: other page loads still open the cached app'); assert.equal(taken('/app.js', 'no-cors'), true, 'control: cached files');
      }
      console.log('✔ the service worker does not intercept /auth/microsoft or /auth/microsoft/callback');
      console.log('M365 TESTS PASSED');
    } catch (err) { console.error('FAIL', err); process.exitCode = 1; }
    finally { server.close(); ms.close(); setTimeout(() => process.exit(process.exitCode || 0), 100); }
  });
})();
