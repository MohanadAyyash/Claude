// Phase 1B: sign in to Trigon ERP WITH Microsoft Entra ID:  node --no-warnings test-sso.js
// Local mock of Entra (token endpoint + JWKS) and Graph, id_tokens really signed (RS256) with jose; no internet, fake identities only.
// Microsoft proves the identity; the ERP signs in only an already linked, active ERP user found by (tenant, object ID), with the same
// session as the password login. Everything else fails closed, never falls back to e-mail, and leaves no session behind.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert'), http = require('http'), crypto = require('crypto'), vm = require('vm');
const jose = require('jose');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-sso-'));
process.env.ZOHO_NO_SCHEDULER = '1'; process.env.SALES_NO_SCHEDULER = '1'; process.env.BACKUP_NO_SCHEDULER = '1';
for (const k of Object.keys(process.env)) if (k.startsWith('M365_')) delete process.env[k];
process.env.TRUST_PROXY = '1';                                              // so each test flow can come from its own address (X-Forwarded-For)
delete process.env.SECURE_COOKIES;

const logged = [];
for (const m of ['log', 'error', 'warn', 'info']) { const o = console[m].bind(console); console[m] = (...a) => { logged.push(a.map(x => (x && x.stack) || String(x)).join(' ')); o(...a); }; }

const { server } = require('./server.js');
const { DatabaseSync } = require('node:sqlite');
const { sanitizedCopy } = require('./lib/backupsafe');
const TENANT = '11111111-2222-3333-4444-555555555555', OTHER_TENANT = '99999999-8888-7777-6666-555555555555';
const CLIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', SECRET = 'test-client-secret-NOT-REAL-sso-1b';
const OID_ADMIN = '0a0a0a0a-1111-2222-3333-444444444444', OID_ADMIN2 = '0b0b0b0b-1111-2222-3333-444444444444', OID_STRANGER = '0c0c0c0c-1111-2222-3333-444444444444';
const KEY = crypto.randomBytes(32).toString('base64'), CODE = 'mock-auth-code-SSO-777';
const LOGIN_SCOPES = 'openid profile email User.Read', LINK_SCOPES = 'openid profile email offline_access User.Read';

(async () => {
  const good = await jose.generateKeyPair('RS256', { extractable: true }), evil = await jose.generateKeyPair('RS256', { extractable: true });
  const publicJwk = { ...(await jose.exportJWK(good.publicKey)), kid: 'entra-key-1', use: 'sig', alg: 'RS256' };
  const mock = { tokens: [], codes: [], verifiers: [], pending: null, redirect: null, idToken: null, me: null, tokenCalls: [] };
  let issued = 0; const newToken = kind => { const t = `mock-${kind}-token-${++issued}-${crypto.randomBytes(6).toString('hex')}`; mock.tokens.push(t); return t; };
  const sign = async (claims = {}, { key = good.privateKey, kid = 'entra-key-1', alg = 'RS256', omit = [] } = {}) => {
    const t = Math.floor(Date.now() / 1000);
    const base = { iss: `${process.env.M365_LOGIN_BASE}/${TENANT}/v2.0`, aud: CLIENT, tid: TENANT, oid: mock.oid, sub: 'pairwise-sub', nonce: mock.pending.nonce, name: 'Fake User', preferred_username: 'user@example.test', iat: t, nbf: t - 5, exp: t + 3600, ...claims };
    for (const k of omit) delete base[k];
    return new jose.SignJWT(base).setProtectedHeader({ alg, kid, typ: 'JWT' }).sign(key);
  };
  const ms = http.createServer((rq, rs) => { let body = ''; rq.on('data', c => body += c); rq.on('end', async () => {
    const out = (code, j) => { rs.writeHead(code, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify(j)); };
    if (rq.url === `/${TENANT}/discovery/v2.0/keys`) return out(200, { keys: [publicJwk] });
    if (rq.url === `/${TENANT}/oauth2/v2.0/token` && rq.method === 'POST') {
      const f = new URLSearchParams(body); mock.tokenCalls.push(Object.fromEntries(f));
      const expectScope = (f.get('redirect_uri') || '').endsWith('/auth/microsoft/login/callback') ? LOGIN_SCOPES : LINK_SCOPES;
      if (f.get('client_id') !== CLIENT || f.get('client_secret') !== SECRET || f.get('scope') !== expectScope) return out(401, { error: 'invalid_client' });
      const st = mock.pending;
      if (f.get('grant_type') !== 'authorization_code' || !st || f.get('code') !== CODE || f.get('redirect_uri') !== mock.redirect) return out(400, { error: 'invalid_grant' });
      if (crypto.createHash('sha256').update(f.get('code_verifier') || '').digest('base64url') !== st.challenge || st.method !== 'S256') return out(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
      mock.verifiers.push(f.get('code_verifier'));
      const id_token = typeof mock.idToken === 'function' ? await mock.idToken() : await sign();
      return out(200, { token_type: 'Bearer', expires_in: 3600, access_token: newToken('access'), ...(expectScope === LINK_SCOPES ? { refresh_token: newToken('refresh') } : {}), id_token });
    }
    if (rq.url.startsWith('/v1.0/me')) { const tok = (rq.headers.authorization || '').replace('Bearer ', ''); return mock.tokens.includes(tok) ? out(200, mock.me || { id: mock.oid, displayName: 'Fake User', mail: 'user@example.test' }) : out(401, {}); }
    out(404, {});
  }); });

  server.listen(0, async () => {
    await new Promise(r => ms.listen(0, r));
    const port = server.address().port, base = `http://127.0.0.1:${port}`;
    let ipN = 0; const nextIp = () => `198.51.100.${(++ipN % 250) + 1}`;   // a different (documentation-range) address per flow
    const call = async (m, u, b, ck = '') => { const r = await fetch(base + '/api/' + u, { method: m, redirect: 'manual', headers: { 'Content-Type': 'application/json', cookie: ck }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie') || ''; const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j, sc, t }; };
    const ok = (r, l) => { assert.equal(r.s, 200, `${l || ''} → ${r.s} ${String(r.t).slice(0, 300)}`); return r.j; };
    const sidOf = sc => (/(?:^|[ ,])sid=([a-f0-9]*)/.exec(sc || '') || [])[1];
    const localLogin = async (u, p = 'secret12') => { const r = await call('POST', 'login', { username: u, password: p }); assert.equal(r.s, 200, 'local login ' + u + ' ' + r.t); return { cookie: 'sid=' + sidOf(r.sc), setCookie: r.sc }; };
    const nav = (u, ck = '', ip = nextIp()) => fetch(base + u, { redirect: 'manual', headers: { cookie: ck, 'X-Forwarded-For': ip } }).then(async r => ({ s: r.status, loc: r.headers.get('location') || '', setCookie: r.headers.get('set-cookie') || '', t: await r.text() }));
    const dbFile = path.join(process.env.DATA_DIR, 'erp.db');
    const q = (sql, ...a) => { const d = new DatabaseSync(dbFile, { readOnly: true }); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
    const exec = (sql, ...a) => { const d = new DatabaseSync(dbFile); try { return d.prepare(sql).run(...a); } finally { d.close(); } };
    const audits = () => q("SELECT action, user, rec, detail FROM audit_log WHERE tbl='m365' ORDER BY id");
    const secrets = () => [...mock.tokens, CODE, SECRET, KEY, ...mock.verifiers];
    const noSecret = (text, where) => { for (const s of secrets()) assert.ok(!String(text).includes(s), `${where} must not contain a secret (${s.slice(0, 12)}…)`); };

    // ---- the flows, played from the browser side; Microsoft's side is the mock ----
    const startLogin = async (ck = '', ip) => {
      const r = await nav('/auth/microsoft/login', ck, ip); assert.equal(r.s, 302, r.t);
      const a = new URL(r.loc), p = a.searchParams;
      mock.pending = { challenge: p.get('code_challenge'), method: p.get('code_challenge_method'), nonce: p.get('nonce') }; mock.redirect = p.get('redirect_uri');
      return { r, auth: a, p, state: p.get('state'), bind: (/m365_login=([^;]+)/.exec(r.setCookie) || [])[1] };
    };
    const loginCb = (qs, ck) => nav(`/auth/microsoft/login/callback?${qs}`, ck);
    // whole sign-in for Microsoft account `oid` (Graph says `me`, Microsoft signs `idToken`); `ck`: cookies this browser already has
    const ssoAs = async (oid, { idToken, me, ck = '', tamper } = {}) => {
      mock.oid = oid; mock.me = me || null; mock.idToken = idToken || null;
      const f = await startLogin(ck); if (tamper) tamper(f);
      const r = await loginCb(`code=${CODE}&state=${f.state}`, [ck, `m365_login=${f.bind}`].filter(Boolean).join('; '));
      mock.idToken = null; mock.me = null; return { ...r, flow: f, sid: sidOf(r.setCookie) };
    };
    const refused = async (label, r, re, { keepStates } = {}) => {
      assert.equal(r.s, 400, `${label}: expected a refusal, got ${r.s} ${r.t.slice(0, 200)}`); if (re) assert.match(r.t, re, label);
      assert.ok(!sidOf(r.setCookie), `${label}: no ERP session cookie`); assert.match(r.setCookie, /m365_login=;/, `${label}: binding cookie cleared`);
      if (!keepStates) assert.equal(q('SELECT COUNT(*) n FROM oauth_login_states')[0].n, 0, `${label}: the sign-in state is removed`);
      noSecret(r.t, label);
    };
    const sessions = () => q('SELECT token, user_id FROM sessions');
    const linkRow = (userId, tenant, oid) => exec('INSERT INTO m365_connections(user_id,tenant_id,microsoft_user_id,email,display_name,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', userId, tenant, oid, 'user@example.test', 'Fake', new Date().toISOString(), new Date().toISOString());

    try {
      // ---- set-up: ERP users; Microsoft 365 off at first ----
      ok(await call('POST', 'setup', { username: 'admin', password: 'secret12', company: 'Test Co' }));
      const admin = await localLogin('admin');
      assert.equal(ok(await call('GET', 'status')).m365_login, false, 'off: the login screen has no Microsoft button');
      assert.equal((await nav('/auth/microsoft/login')).s, 404, 'off: no Microsoft sign-in');
      const adminId = q("SELECT id FROM users WHERE username='admin'")[0].id;
      const admin2Id = ok(await call('POST', 'users', { username: 'admin2', password: 'secret12', role: 'admin' }, admin.cookie)).id;
      const admin3Id = ok(await call('POST', 'users', { username: 'admin3', password: 'secret12', role: 'admin' }, admin.cookie)).id;
      const accId = ok(await call('POST', 'users', { username: 'acc', password: 'secret12', role: 'accountant' }, admin.cookie)).id;
      Object.assign(process.env, { M365_ENABLED: '1', M365_TENANT_ID: TENANT, M365_CLIENT_ID: CLIENT, M365_CLIENT_SECRET: SECRET, M365_ENCRYPTION_KEY: KEY,
        M365_REDIRECT_URI: `${base}/auth/microsoft/callback`, M365_LOGIN_BASE: `http://127.0.0.1:${ms.address().port}`, M365_GRAPH_BASE: `http://127.0.0.1:${ms.address().port}/v1.0` });

      // the administrator links their Microsoft account with the Phase 1 flow (signed in, explicit)
      {
        mock.oid = OID_ADMIN;
        const r = await nav('/auth/microsoft', admin.cookie); assert.equal(r.s, 302); const p = new URL(r.loc).searchParams;
        mock.pending = { challenge: p.get('code_challenge'), method: p.get('code_challenge_method'), nonce: p.get('nonce') }; mock.redirect = p.get('redirect_uri');
        const c = await nav(`/auth/microsoft/callback?code=${CODE}&state=${p.get('state')}`, `m365_flow=${(/m365_flow=([^;]+)/.exec(r.setCookie) || [])[1]}`);
        assert.equal(c.s, 302, c.t); assert.equal(q('SELECT user_id, tenant_id, microsoft_user_id FROM m365_connections')[0].microsoft_user_id, OID_ADMIN);
      }

      // ---- 1. a signed-out browser can start the Microsoft sign-in ----
      assert.equal(ok(await call('GET', 'status')).m365_login, true, 'the login screen shows the Microsoft button');
      const f1 = await startLogin('');
      assert.equal(f1.auth.origin + f1.auth.pathname, `${process.env.M365_LOGIN_BASE}/${TENANT}/oauth2/v2.0/authorize`, 'tenant-specific endpoint');
      assert.equal(f1.p.get('redirect_uri'), `${base}/auth/microsoft/login/callback`, 'its own redirect URI, separate from the link flow');
      assert.equal(f1.p.get('scope'), LOGIN_SCOPES, 'minimal scopes: no offline_access, nothing beyond User.Read');
      assert.equal(f1.p.get('code_challenge_method'), 'S256'); assert.match(f1.p.get('code_challenge'), /^[\w-]{43}$/); assert.match(f1.state, /^[\w-]{43}$/); assert.ok(f1.p.get('nonce'));
      assert.match(f1.r.setCookie, /m365_login=[\w-]{43}; HttpOnly; SameSite=Lax; Path=\/auth\/microsoft\/login; Max-Age=600/, 'binding cookie, its own name and path');
      assert.doesNotMatch(f1.r.setCookie, /m365_flow=|sid=/, 'does not touch the link flow or the ERP session');
      const st1 = q('SELECT * FROM oauth_login_states'); assert.equal(st1.length, 1); assert.ok(!JSON.stringify(st1).includes(f1.state), 'state stored as a hash only');
      assert.equal(q('SELECT COUNT(*) n FROM oauth_states')[0].n, 0, 'not mixed with the link states');
      exec('DELETE FROM oauth_login_states');
      console.log('✔ 1: signed out, the Microsoft sign-in starts (tenant endpoint, own redirect URI, S256 PKCE, state + nonce, minimal scopes, own binding cookie)');

      // ---- 2–3. the linked, active administrator signs in; the session is the ERP's own ----
      const auditsBefore = audits().length;
      const s1 = await ssoAs(OID_ADMIN);
      assert.equal(s1.s, 302, s1.t); assert.equal(s1.loc, '/', 'to the dashboard, no code or token in the address');
      assert.ok(s1.sid && s1.sid.length === 48, 'a new ERP session');
      const localCookieShape = admin.setCookie.replace(/sid=[a-f0-9]+/, 'sid=X'), ssoCookie = s1.setCookie.split(/,\s*(?=\w+=)/).find(x => x.startsWith('sid='));
      assert.equal(ssoCookie.replace(/sid=[a-f0-9]+/, 'sid=X'), localCookieShape.replace('Max-Age=2592000', 'Max-Age=43200'), 'same cookie protections as the password login; lifetime 12 hours by default (AUTH_MICROSOFT_SESSION_HOURS)');
      const me1 = ok(await call('GET', 'status', undefined, `sid=${s1.sid}`)).user;
      assert.equal(me1.id, adminId); assert.equal(me1.role, 'admin'); assert.equal(me1.username, 'admin');
      assert.deepEqual(sessions().find(x => x.token === s1.sid), { token: s1.sid, user_id: adminId });
      const a1 = audits().slice(auditsBefore); assert.ok(a1.some(x => x.action === 'login' && x.user === 'admin' && x.detail.includes(OID_ADMIN)), JSON.stringify(a1));
      console.log('✔ 2–3: the linked active administrator signs in with Microsoft; the ERP session belongs to that ERP user and role; audited');

      // ---- 4. a Microsoft account that is not linked ----
      await refused('unlinked', await ssoAs(OID_STRANGER), /not linked to a Trigon ERP user/);
      assert.ok(audits().some(x => x.action === 'login-rejected' && x.detail.includes(`${OID_STRANGER} is not linked`)));
      console.log('✔ 4: an unlinked Microsoft account is refused (audited)');

      // ---- 5. same e-mail / UPN / name as the linked admin, different object ID ----
      await refused('same e-mail, other oid', await ssoAs(OID_STRANGER, { idToken: () => sign({ preferred_username: 'user@example.test', email: 'user@example.test', name: 'Fake User' }), me: { id: OID_STRANGER, mail: 'user@example.test', userPrincipalName: 'user@example.test', displayName: 'Fake User' } }), /not linked/);
      console.log('✔ 5: the same e-mail with another object ID is refused (no e-mail matching)');

      // ---- 6. the same object ID in another tenant ----
      await refused('token from another tenant', await ssoAs(OID_ADMIN, { idToken: () => sign({ iss: `${process.env.M365_LOGIN_BASE}/${OTHER_TENANT}/v2.0`, tid: OTHER_TENANT }) }));
      await refused('right issuer, other tid', await ssoAs(OID_ADMIN, { idToken: () => sign({ tid: OTHER_TENANT }) }), /another organisation/);
      exec('DELETE FROM m365_connections WHERE user_id=?', adminId); linkRow(adminId, OTHER_TENANT, OID_ADMIN);   // a link recorded for the other tenant
      await refused('linked in another tenant only', await ssoAs(OID_ADMIN), /not linked/);
      exec('DELETE FROM m365_connections WHERE user_id=?', adminId); linkRow(adminId, TENANT, OID_ADMIN);
      console.log('✔ 6: the same object ID from / linked in another tenant is refused');

      // ---- 7. a disabled ERP user ----
      linkRow(admin2Id, TENANT, OID_ADMIN2);
      assert.equal((await ssoAs(OID_ADMIN2)).s, 302, 'admin2 can sign in while active');
      exec('UPDATE users SET disabled=1 WHERE id=?', admin2Id);
      await refused('disabled', await ssoAs(OID_ADMIN2), /disabled/);
      assert.ok(audits().some(x => x.action === 'login-rejected' && x.user === 'admin2' && /disabled/.test(x.detail)));
      exec('UPDATE users SET disabled=0 WHERE id=?', admin2Id);
      assert.equal(q('SELECT COUNT(*) n FROM m365_connections WHERE user_id=?', admin2Id)[0].n, 0, 'and the link of a disabled user is removed (Phase 1 rule)');
      await refused('re-enabled, link gone', await ssoAs(OID_ADMIN2), /not linked/);
      console.log('✔ 7: a disabled ERP user is refused (audited as disabled); its link is removed');

      // ---- 8. a deleted ERP user ----
      linkRow(admin3Id, TENANT, OID_ADMIN2);
      ok(await call('DELETE', 'users/' + admin3Id, undefined, admin.cookie));
      await refused('deleted user', await ssoAs(OID_ADMIN2), /not linked/);
      { const d = new DatabaseSync(dbFile); d.exec('PRAGMA foreign_keys=OFF'); d.prepare('INSERT INTO m365_connections(user_id,tenant_id,microsoft_user_id,created_at,updated_at) VALUES(9999,?,?,?,?)').run(TENANT, OID_ADMIN2, 'x', 'x'); d.close(); }
      await refused('link left behind for a missing user', await ssoAs(OID_ADMIN2), /not linked/);
      assert.ok(audits().some(x => x.action === 'login-rejected' && /no longer exists/.test(x.detail)));
      exec('DELETE FROM m365_connections WHERE user_id=9999');
      console.log('✔ 8: a deleted ERP user is refused (also when a stale link row is left behind)');

      // ---- 9. after Disconnect, no sign-in ----
      linkRow(admin2Id, TENANT, OID_ADMIN2);
      const a2local = await localLogin('admin2');
      ok(await call('POST', 'm365/disconnect', {}, a2local.cookie));
      await refused('disconnected', await ssoAs(OID_ADMIN2), /not linked/);
      console.log('✔ 9: a disconnected Microsoft account can no longer sign in');

      // ---- 10. the state is single use ----
      {
        mock.oid = OID_ADMIN; const f = await startLogin(''); const ck = `m365_login=${f.bind}`;
        const first = await loginCb(`code=${CODE}&state=${f.state}`, ck); assert.equal(first.s, 302);
        await refused('replayed callback', await loginCb(`code=${CODE}&state=${f.state}`, ck), /not known in this browser, has expired or was already used/);
        const g = await startLogin(''); const other = await startLogin('');
        await refused('state from another browser', await loginCb(`code=${CODE}&state=${g.state}`, `m365_login=${other.bind}`), /not known/, { keepStates: true });
        await refused('no binding cookie', await loginCb(`code=${CODE}&state=${other.state}`, ''), /not known in this browser/, { keepStates: true });
        assert.equal(q('SELECT COUNT(*) n FROM oauth_login_states')[0].n, 2, 'a mismatched browser consumes nothing');
        exec('DELETE FROM oauth_login_states');
      }
      console.log('✔ 10: the sign-in state is single use and bound to the browser that started it');

      // ---- 11. expired state ----
      {
        mock.oid = OID_ADMIN; const f = await startLogin('');
        exec('UPDATE oauth_login_states SET expires_at=?', new Date(Date.now() - 1000).toISOString());
        await refused('expired', await loginCb(`code=${CODE}&state=${f.state}`, `m365_login=${f.bind}`), /expired/);
        assert.equal(mock.tokenCalls.filter(t => t.code_verifier && !mock.verifiers.includes(t.code_verifier)).length, 0);
      }
      console.log('✔ 11: an expired sign-in state is refused before Microsoft is asked');

      // ---- 12. PKCE ----
      await refused('PKCE mismatch', await ssoAs(OID_ADMIN, { tamper: () => { mock.pending.challenge = crypto.createHash('sha256').update('another-verifier').digest('base64url'); } }), /Microsoft refused the request \(invalid_grant\)/);
      { const last = mock.tokenCalls[mock.tokenCalls.length - 1]; assert.match(last.code_verifier, /^[\w-]{64}$/); assert.equal(last.redirect_uri, `${base}/auth/microsoft/login/callback`); assert.equal(last.scope, LOGIN_SCOPES); }
      console.log('✔ 12: a code that does not match the PKCE verifier is refused (verifier always sent, S256)');

      // ---- 13. id_token checks ----
      const bad = [
        ['forged signature, published kid', () => sign({}, { key: evil.privateKey })],
        ['unknown kid', () => sign({}, { key: evil.privateKey, kid: 'attacker' })],
        ['wrong issuer', () => sign({ iss: 'https://login.example.test/x/v2.0' })],
        ['wrong audience', () => sign({ aud: 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee' })],
        ['wrong nonce', () => sign({ nonce: 'not-the-nonce' })],
        ['nonce of the link flow for the same state', async () => sign({ nonce: crypto.createHmac('sha256', Buffer.from(KEY, 'base64')).update('nonce:' + mock.lastState).digest('base64url') })],
        ['expired', () => sign({ exp: Math.floor(Date.now() / 1000) - 3600, iat: Math.floor(Date.now() / 1000) - 7200, nbf: Math.floor(Date.now() / 1000) - 7200 })],
        ['HS256', () => new jose.SignJWT({ iss: `${process.env.M365_LOGIN_BASE}/${TENANT}/v2.0`, aud: CLIENT, tid: TENANT, oid: OID_ADMIN, sub: 's', nonce: mock.pending.nonce, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 }).setProtectedHeader({ alg: 'HS256', kid: 'entra-key-1' }).sign(new TextEncoder().encode('x'.repeat(32)))],
        ['no oid', () => sign({}, { omit: ['oid'] })],
        ['no nonce', () => sign({}, { omit: ['nonce'] })],
      ];
      for (const [label, tok] of bad) {
        const r = await ssoAs(OID_ADMIN, { idToken: async () => tok(), tamper: f => { mock.lastState = f.state; } });
        await refused(label, r);
      }
      await refused('Graph names another account', await ssoAs(OID_ADMIN, { me: { id: OID_STRANGER, mail: 'user@example.test' } }), /changed during sign-in/);
      await refused('Microsoft error', await (async () => { const f = await startLogin(''); return loginCb(`error=access_denied&state=${f.state}`, `m365_login=${f.bind}`); })(), /did not complete/);
      console.log('✔ 13: forged / wrong-issuer / wrong-audience / wrong-tenant / wrong-nonce (incl. the link flow\'s nonce) / expired / HS256 / incomplete id_tokens are refused');

      // the flows stay apart: a link state never works on the sign-in callback, and the other way round
      {
        mock.oid = OID_ADMIN;
        const r = await nav('/auth/microsoft', admin.cookie); const p = new URL(r.loc).searchParams, lb = (/m365_flow=([^;]+)/.exec(r.setCookie) || [])[1];
        await refused('link state on the sign-in callback', await loginCb(`code=${CODE}&state=${p.get('state')}`, `m365_login=${lb}`), /not known/);
        exec('DELETE FROM oauth_states');
        const f = await startLogin('');
        const c = await nav(`/auth/microsoft/callback?code=${CODE}&state=${f.state}`, `m365_flow=${f.bind}; ${admin.cookie}`);
        assert.equal(c.s, 400, 'sign-in state on the link callback'); assert.ok(!sidOf(c.setCookie)); exec('DELETE FROM oauth_login_states');
      }
      console.log('✔ the sign-in and the link flows do not accept each other\'s state');

      // ---- 14. the password login is unchanged ----
      const l2 = await localLogin('admin'); assert.equal(ok(await call('GET', 'status', undefined, l2.cookie)).user.username, 'admin');
      assert.equal((await call('POST', 'login', { username: 'admin', password: 'wrong-pass' })).s, 401);
      console.log('✔ 14: username / password sign-in still works (and still refuses a wrong password)');

      // ---- 15. the ERP's ACL applies to a Microsoft session exactly as to a password session ----
      {
        const viaMs = (await ssoAs(OID_ADMIN)).sid, viaPw = (await localLogin('admin')).cookie;
        const probes = [['GET', 'users'], ['GET', 'settings'], ['GET', 'm365/status'], ['GET', 'projects'], ['GET', 'audit'], ['POST', 'users', { username: 'x1', password: 'short', role: 'viewer' }]];
        for (const [m, u, b] of probes) { const a = await call(m, u, b, `sid=${viaMs}`), p = await call(m, u, b, viaPw); assert.equal(a.s, p.s, `${m} ${u}: same answer`); }
        // the role is read from the ERP at every request: demote admin2 after a Microsoft sign-in → it gets the new role's rights at once
        linkRow(admin2Id, TENANT, OID_ADMIN2); const s2 = await ssoAs(OID_ADMIN2); assert.equal(s2.s, 302);
        assert.equal((await call('GET', 'users', undefined, `sid=${s2.sid}`)).s, 200);
        ok(await call('PUT', 'users/' + admin2Id, { role: 'viewer' }, admin.cookie));
        assert.equal(ok(await call('GET', 'status', undefined, `sid=${s2.sid}`)).user.role, 'viewer'); assert.equal((await call('GET', 'users', undefined, `sid=${s2.sid}`)).s, 403, 'viewer rights now');
        // Phase 1C: the link survives a role change; the next Microsoft sign-in is simply a viewer
        const s2b = await ssoAs(OID_ADMIN2); assert.equal(s2b.s, 302, s2b.t);
        assert.equal(ok(await call('GET', 'status', undefined, `sid=${s2b.sid}`)).user.role, 'viewer'); assert.equal((await call('GET', 'users', undefined, `sid=${s2b.sid}`)).s, 403);
        ok(await call('PUT', 'users/' + admin2Id, { role: 'admin' }, admin.cookie));
      }
      console.log('✔ 15: ACL answers are identical for a Microsoft and a password session; role changes apply at once');

      // ---- 16. no session fixation ----
      {
        const attacker = await localLogin('acc');                             // a session the attacker planted in the victim's browser
        const s = await ssoAs(OID_ADMIN, { ck: attacker.cookie });
        assert.equal(s.s, 302); assert.ok(s.sid && 'sid=' + s.sid !== attacker.cookie, 'a new token');
        assert.ok(!sessions().some(x => 'sid=' + x.token === attacker.cookie), 'the presented session is ended');
        assert.equal(ok(await call('GET', 'status', undefined, `sid=${s.sid}`)).user.username, 'admin');
        const made = 'sid=' + 'ab'.repeat(24); const s3 = await ssoAs(OID_ADMIN, { ck: made });
        assert.notEqual('sid=' + s3.sid, made, 'a made-up token is never adopted');
      }
      console.log('✔ 16: Microsoft sign-in always issues a fresh session and ends one the browser presented');

      // ---- 17. nothing secret anywhere ----
      {
        const everything = [JSON.stringify(q('SELECT * FROM audit_log')), JSON.stringify(q('SELECT * FROM error_log')), logged.join('\n'), JSON.stringify(q('SELECT * FROM sessions')), JSON.stringify(q('SELECT * FROM settings'))];
        everything.forEach((t, i) => noSecret(t, ['audit log', 'error log', 'console', 'sessions', 'settings'][i]));
        assert.equal(q('SELECT COUNT(*) n FROM oauth_login_states')[0].n, 0, 'no sign-in state left');
        assert.equal(q('SELECT COUNT(*) n FROM m365_connections WHERE user_id=? AND access_token_encrypted IS NOT NULL', adminId)[0].n, 0, 'the sign-in stores no Microsoft token (only the link does)');
        const raw = fs.readFileSync(dbFile); for (const s of mock.tokens.filter(t => t.includes('access'))) if (raw.includes(Buffer.from(s))) assert.fail('a token in the database file');
        // a backup never carries sign-in states
        const st = await startLogin(''); void st; assert.equal(q('SELECT COUNT(*) n FROM oauth_login_states')[0].n, 1);
        const d = new DatabaseSync(dbFile), dest = path.join(process.env.DATA_DIR, 'b.db'); sanitizedCopy(d, dest); d.close();
        const b = new DatabaseSync(dest, { readOnly: true }); assert.equal(b.prepare('SELECT COUNT(*) n FROM oauth_login_states').get().n, 0, 'backup without sign-in states'); b.close();
        exec('DELETE FROM oauth_login_states');
      }
      console.log('✔ 17: no code, token, secret, key or verifier in responses, audit log, error log, console, sessions or backups');

      // ---- 18. the service worker never answers the sign-in or its callback itself ----
      {
        const on = {}, origin = 'https://erp.example.test';
        const sw = { self: { addEventListener: (t, f) => { on[t] = f; }, registration: { scope: origin + '/' }, clients: {} }, location: { origin }, URL, Response, Promise,
          caches: { match: async () => new Response('<cached app page>'), open: async () => ({ match: async () => null, put() {} }), keys: async () => [] }, fetch: async () => new Response('network') };
        vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'public', 'sw.js'), 'utf8'), sw);
        const taken = (p, mode = 'navigate') => { let r = false; on.fetch({ request: { method: 'GET', mode, url: origin + p }, respondWith() { r = true; } }); return r; };
        for (const p of ['/auth/microsoft/login', '/auth/microsoft/login/callback?code=x&state=y', '/auth/microsoft/login/callback?error=access_denied', '/auth/microsoft', '/auth/microsoft/callback?code=x&state=y'])
          for (const mode of ['navigate', 'no-cors', 'same-origin']) assert.equal(taken(p, mode), false, `the service worker leaves ${p} (${mode}) to the server`);
        assert.equal(taken('/'), true, 'control: the app shell still comes from the cache');
      }
      console.log('✔ 18: the service worker does not intercept /auth/microsoft/login or /auth/microsoft/login/callback');

      // ---- abuse: anyone can start a sign-in, so starts are limited per address ----
      { let last; for (let i = 0; i < 21; i++) last = await nav('/auth/microsoft/login', '', '203.0.113.9'); assert.equal(last.s, 429, 'the 21st start from one address in 10 minutes'); exec('DELETE FROM oauth_login_states'); }
      { const r = await fetch(base + '/auth/microsoft/login', { method: 'POST', redirect: 'manual', headers: { 'X-Forwarded-For': nextIp() } }); assert.equal(r.status, 405); }
      { process.env.M365_ENABLED = '0'; assert.equal(ok(await call('GET', 'status')).m365_login, false); assert.equal((await nav('/auth/microsoft/login')).s, 404); process.env.M365_ENABLED = '1'; }
      console.log('✔ sign-in starts are rate-limited per address; GET only; switched off with M365_ENABLED');

      console.log('\nSSO TESTS PASSED');
    } catch (err) { console.error('FAIL', err); process.exitCode = 1; }
    finally { server.close(); ms.close(); setTimeout(() => process.exit(process.exitCode || 0), 100); }
  });
})();
