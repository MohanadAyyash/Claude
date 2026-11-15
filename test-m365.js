// Microsoft 365 Phase 1: off by default, admin only, fails closed, OAuth 2.0 Authorization Code + PKCE against a LOCAL mock of
// Entra ID / Graph (no internet), single-use hashed state, encrypted tokens, nothing secret in responses, logs or backups:
// node --no-warnings test-m365.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert'), http = require('http'), crypto = require('crypto');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-m365-'));
process.env.ZOHO_NO_SCHEDULER = '1'; process.env.SALES_NO_SCHEDULER = '1'; process.env.BACKUP_NO_SCHEDULER = '1';
for (const k of Object.keys(process.env)) if (k.startsWith('M365_')) delete process.env[k];       // case 1: nothing configured

// everything written to the console is captured, to prove no token, code, secret or verifier is ever logged
const logged = [];
for (const m of ['log', 'error', 'warn', 'info']) { const o = console[m].bind(console); console[m] = (...a) => { logged.push(a.map(x => (x && x.stack) || String(x)).join(' ')); o(...a); }; }

const { server } = require('./server.js');
const { DatabaseSync } = require('node:sqlite');
const TENANT = '11111111-2222-3333-4444-555555555555', CLIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', SECRET = 'test-client-secret-NOT-REAL-9f8e7d';
const KEY = crypto.randomBytes(32).toString('base64');
const ACCESS = 'mock-access-token-AT-111', REFRESH = 'mock-refresh-token-RT-222', ACCESS2 = 'mock-access-token-AT-333', CODE = 'mock-auth-code-CODE-444';

// ---- local mock of login.microsoftonline.com and graph.microsoft.com ----
const mock = { tokenCalls: [], meCalls: 0, refreshFails: false, lastVerifier: null, tid: TENANT };
const jwt = p => ['e30', Buffer.from(JSON.stringify(p)).toString('base64url'), 'sig'].join('.');
const ms = http.createServer((rq, rs) => { let body = ''; rq.on('data', c => body += c); rq.on('end', () => {
  const out = (code, j) => { rs.writeHead(code, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify(j)); };
  if (rq.url === `/${TENANT}/oauth2/v2.0/token` && rq.method === 'POST') {
    const f = new URLSearchParams(body); mock.tokenCalls.push(Object.fromEntries(f));
    if (f.get('client_id') !== CLIENT || f.get('client_secret') !== SECRET || f.get('scope') !== 'openid profile email offline_access User.Read') return out(401, { error: 'invalid_client' });
    if (f.get('grant_type') === 'authorization_code') {
      const st = mock.pending; if (!st || f.get('code') !== CODE || f.get('redirect_uri') !== mock.redirect) return out(400, { error: 'invalid_grant', error_description: 'bad code ' + f.get('code') });
      const challenge = crypto.createHash('sha256').update(f.get('code_verifier') || '').digest('base64url');
      if (challenge !== st.challenge || st.method !== 'S256') return out(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
      mock.lastVerifier = f.get('code_verifier');
      return out(200, { token_type: 'Bearer', expires_in: 3600, access_token: ACCESS, refresh_token: REFRESH, id_token: jwt({ aud: CLIENT, tid: mock.tid, oid: 'ms-user-oid-1', nonce: st.nonce, name: 'Test Admin', preferred_username: 'admin@example.test', exp: Math.floor(Date.now() / 1000) + 3600 }) });
    }
    if (f.get('grant_type') === 'refresh_token') {
      if (mock.refreshFails || f.get('refresh_token') !== REFRESH) return out(400, { error: 'invalid_grant', error_description: 'refresh token ' + f.get('refresh_token') + ' revoked' });
      return out(200, { token_type: 'Bearer', expires_in: 3600, access_token: ACCESS2 });
    }
    return out(400, { error: 'unsupported_grant_type' });
  }
  if (rq.url.startsWith('/v1.0/me')) { mock.meCalls++; return [ACCESS, ACCESS2].includes((rq.headers.authorization || '').replace('Bearer ', '')) ? out(200, { id: 'ms-user-oid-1', displayName: 'Test Admin', mail: 'admin@example.test' }) : out(401, { error: { code: 'InvalidAuthenticationToken' } }); }
  out(404, { error: 'not_found' });
}); });

server.listen(0, async () => {
  await new Promise(r => ms.listen(0, r));
  const port = server.address().port, base = `http://127.0.0.1:${port}`; let cookie = '';
  const call = async (m, u, b, extra = {}) => { const r = await fetch(base + '/api/' + u, { method: m, redirect: 'manual', headers: { 'Content-Type': 'application/json', cookie, ...extra }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); if (sc && /sid=/.test(sc)) cookie = sc.split(';')[0]; const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j, t }; };
  const nav = (u, ck = cookie) => fetch(base + u, { redirect: 'manual', headers: { cookie: ck } }).then(async r => ({ s: r.status, loc: r.headers.get('location') || '', setCookie: r.headers.get('set-cookie') || '', t: await r.text() }));
  const ok = (r, l) => { assert.equal(r.s, 200, `${l || ''} → ${r.s} ${JSON.stringify(r.j).slice(0, 300)}`); return r.j; };
  const db = () => new DatabaseSync(path.join(process.env.DATA_DIR, 'erp.db'), { readOnly: true });
  const q = (sql, ...a) => { const d = db(); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
  const secrets = () => [ACCESS, REFRESH, ACCESS2, CODE, SECRET, KEY, mock.lastVerifier].filter(Boolean);
  const noSecret = (text, where) => { for (const s of secrets()) assert.ok(!String(text).includes(s), `${where} must not contain a secret (${s.slice(0, 12)}…)`); };
  // start the flow as the signed-in admin and play the Microsoft side: returns the callback URL the browser would be sent to
  const start = async (ck = cookie) => {
    const r = await nav('/auth/microsoft', ck); assert.equal(r.s, 302, r.t); const a = new URL(r.loc), p = a.searchParams;
    mock.pending = { challenge: p.get('code_challenge'), method: p.get('code_challenge_method'), nonce: p.get('nonce') }; mock.redirect = p.get('redirect_uri');
    return { auth: a, state: p.get('state'), bind: (/m365_flow=([^;]+)/.exec(r.setCookie) || [])[1], setCookie: r.setCookie };
  };
  try {
    // ---- 1. starts normally with no M365 variables; 2. unauthenticated; 4. disabled → enabled:false, no secrets
    assert.equal((await call('GET', 'status')).s, 200, 'server answers');
    assert.equal((await call('GET', 'm365/status')).s, 401, 'unauthenticated');
    ok(await call('POST', 'setup', { username: 'admin', password: 'secret12', company: 'Test Co' }));
    let st = ok(await call('GET', 'm365/status')); assert.equal(st.enabled, false); assert.equal(st.configured, false); assert.equal(st.client_secret_set, false);
    assert.equal((await nav('/auth/microsoft')).s, 404, 'flow is off');
    // ---- 3. non-admin roles are refused
    const adminCookie = cookie;
    for (const role of ['accountant', 'manager', 'hr', 'viewer']) ok(await call('POST', 'users', { username: 'u_' + role, password: 'secret12', role }));
    for (const role of ['accountant', 'manager', 'hr', 'viewer']) {
      cookie = ''; ok(await call('POST', 'login', { username: 'u_' + role, password: 'secret12' }));
      assert.equal((await call('GET', 'm365/status')).s, 403, role + ' status'); assert.equal((await call('POST', 'm365/disconnect', {})).s, 403, role + ' disconnect');
    }
    const acctCookie = cookie; cookie = adminCookie;
    console.log('✔ 1–4: starts with no M365 settings; status is admin only (401 / 403); off by default with enabled:false');

    // ---- 5. enabled but incomplete → fails closed, still no secrets
    Object.assign(process.env, { M365_ENABLED: '1', M365_TENANT_ID: TENANT, M365_CLIENT_SECRET: SECRET, M365_REDIRECT_URI: `${base}/auth/microsoft/callback` });
    st = ok(await call('GET', 'm365/status')); assert.equal(st.enabled, true); assert.equal(st.configured, false);
    assert.deepEqual(st.missing.sort(), ['M365_CLIENT_ID', 'M365_ENCRYPTION_KEY']); noSecret(JSON.stringify(st), 'status');
    assert.equal((await nav('/auth/microsoft')).s, 503, 'incomplete configuration refuses to start');
    process.env.M365_CLIENT_ID = CLIENT; process.env.M365_ENCRYPTION_KEY = 'too-short';
    assert.equal((await nav('/auth/microsoft')).s, 503, 'a bad encryption key also fails closed');
    process.env.M365_REDIRECT_URI = 'http://erp.example.test/auth/microsoft/callback'; process.env.M365_ENCRYPTION_KEY = KEY;
    assert.deepEqual(ok(await call('GET', 'm365/status')).missing, ['M365_REDIRECT_URI'], 'a plain-http public redirect is refused');
    process.env.M365_REDIRECT_URI = `${base}/auth/microsoft/callback`;
    Object.assign(process.env, { M365_LOGIN_BASE: `http://127.0.0.1:${ms.address().port}`, M365_GRAPH_BASE: `http://127.0.0.1:${ms.address().port}/v1.0` });
    st = ok(await call('GET', 'm365/status')); assert.equal(st.configured, true); assert.equal(st.client_secret_set, true); assert.equal(st.encryption_key_set, true);
    assert.equal(st.client_id, CLIENT); noSecret(JSON.stringify(st), 'status'); assert.ok(!('client_secret' in st) && !('encryption_key' in st));
    assert.deepEqual(st.scopes, ['openid', 'profile', 'email', 'offline_access', 'User.Read'], 'least privilege only');
    assert.ok(q("SELECT * FROM audit_log WHERE tbl='m365' AND action='config-change'").length >= 2, 'configuration changes are audited');
    console.log('✔ 5: enabled but incomplete fails closed (missing names only, never values); configuration changes audited');

    // ---- 6. authorization start: state + PKCE (S256), hashed state, encrypted verifier, 10-minute expiry, binding cookie
    assert.equal((await nav('/auth/microsoft', '')).s, 401, 'not signed in'); assert.equal((await nav('/auth/microsoft', acctCookie)).s, 403, 'not an administrator');
    const before = Date.now(), f1 = await start();
    assert.equal(f1.auth.origin + f1.auth.pathname, `${process.env.M365_LOGIN_BASE}/${TENANT}/oauth2/v2.0/authorize`);
    const p = f1.auth.searchParams; assert.equal(p.get('response_type'), 'code'); assert.equal(p.get('client_id'), CLIENT); assert.equal(p.get('code_challenge_method'), 'S256');
    assert.match(p.get('code_challenge'), /^[\w-]{43}$/); assert.match(f1.state, /^[\w-]{43}$/); assert.equal(p.get('redirect_uri'), process.env.M365_REDIRECT_URI);
    assert.equal(p.get('scope'), 'openid profile email offline_access User.Read'); assert.ok(!p.get('client_secret')); assert.ok(p.get('nonce'));
    assert.match(f1.setCookie, /m365_flow=[\w-]{43}; HttpOnly; SameSite=Lax; Path=\/auth\/microsoft; Max-Age=600/);
    let rows = q('SELECT * FROM oauth_states'); assert.equal(rows.length, 1); const row = rows[0];
    assert.notEqual(row.state_hash, f1.state); assert.ok(!JSON.stringify(rows).includes(f1.state), 'the raw state is not stored');
    assert.match(row.verifier_encrypted, /^v1\./); assert.equal(row.used_at, null); assert.equal(row.provider, 'microsoft');
    const ttl = Date.parse(row.expires_at) - before; assert.ok(ttl > 9.9 * 60e3 && ttl <= 10 * 60e3 + 2000, 'expires in 10 minutes: ' + ttl);
    console.log('✔ 6: start creates state + PKCE (S256), stores only a hash of the state and an encrypted verifier, 10-minute expiry');

    // ---- 7. callback rejects missing / mismatched / wrong-browser / expired / reused state
    const cb = (qs, bind = f1.bind) => nav(`/auth/microsoft/callback?${qs}`, bind ? `m365_flow=${bind}` : '');      // the ERP cookie is SameSite=Strict: not sent on the callback
    assert.equal((await cb(`code=${CODE}`)).s, 400, 'missing state');
    assert.equal((await cb(`code=${CODE}&state=${'x'.repeat(43)}`)).s, 400, 'mismatched state');
    assert.equal((await cb(`code=${CODE}&state=${f1.state}`, 'y'.repeat(43))).s, 400, 'right state from another browser');
    assert.equal((await cb(`code=${CODE}&state=${f1.state}`, '')).s, 400, 'right state without the binding cookie');
    const f2 = await start(), d = new DatabaseSync(path.join(process.env.DATA_DIR, 'erp.db'));
    d.prepare("UPDATE oauth_states SET expires_at='2000-01-01T00:00:00.000Z' WHERE state_hash=(SELECT state_hash FROM oauth_states ORDER BY id DESC LIMIT 1)").run(); d.close();
    const ex = await cb(`code=${CODE}&state=${f2.state}`, f2.bind); assert.equal(ex.s, 400); assert.match(ex.t, /expired/);
    assert.equal(mock.tokenCalls.length, 0, 'no rejected callback reached Microsoft');
    // ---- the real one: code exchanged server-to-server with the verifier; then single use
    const f3 = await start(), good = await cb(`code=${CODE}&state=${f3.state}`, f3.bind);
    assert.equal(good.s, 302, good.t); assert.equal(good.loc, '/#settings'); assert.match(good.setCookie, /m365_flow=; .*Max-Age=0/);
    assert.equal(mock.tokenCalls.length, 1); assert.equal(mock.tokenCalls[0].grant_type, 'authorization_code'); assert.equal(mock.tokenCalls[0].redirect_uri, process.env.M365_REDIRECT_URI);
    const again = await cb(`code=${CODE}&state=${f3.state}`, f3.bind); assert.equal(again.s, 400); assert.match(again.t, /already used/); assert.equal(mock.tokenCalls.length, 1, 'reuse never reaches Microsoft');
    // wrong organisation in the id_token is refused
    mock.tid = '99999999-2222-3333-4444-555555555555'; const f4 = await start(), other = await cb(`code=${CODE}&state=${f4.state}`, f4.bind); mock.tid = TENANT;
    assert.equal(other.s, 400); assert.match(other.t, /another organisation/);
    // the callback must arrive at the registered host
    const f5 = await start(), wrongHost = await new Promise((ok_, no) => http.get({ host: '127.0.0.1', port, path: `/auth/microsoft/callback?code=${CODE}&state=${f5.state}`, headers: { cookie: `m365_flow=${f5.bind}`, host: 'evil.example' } }, r => { r.resume(); ok_(r.statusCode); }).on('error', no));
    assert.equal(wrongHost, 400, 'Host header must match the registered redirect URI');
    console.log('✔ 7: callback refuses missing, mismatched, other-browser, expired and reused state, another tenant and another host; PKCE checked by the mock');

    // ---- the link: tokens encrypted at rest, status shows identity only
    const link = q('SELECT * FROM m365_connections'); assert.equal(link.length, 1); assert.equal(link[0].tenant_id, TENANT); assert.equal(link[0].microsoft_user_id, 'ms-user-oid-1'); assert.equal(link[0].email, 'admin@example.test');
    assert.match(link[0].access_token_encrypted, /^v1\./); assert.match(link[0].refresh_token_encrypted, /^v1\./);
    const dbBytes = fs.readFileSync(path.join(process.env.DATA_DIR, 'erp.db')).toString('latin1') + (fs.existsSync(path.join(process.env.DATA_DIR, 'erp.db-wal')) ? fs.readFileSync(path.join(process.env.DATA_DIR, 'erp.db-wal')).toString('latin1') : '');
    noSecret(dbBytes, 'the database file');
    st = ok(await call('GET', 'm365/status')); assert.equal(st.connection.email, 'admin@example.test'); noSecret(JSON.stringify(st), 'status');
    assert.ok(q("SELECT * FROM audit_log WHERE tbl='m365' AND action='connect'").length === 1);
    // refresh when expired; a refresh failure is audited
    const d2 = new DatabaseSync(path.join(process.env.DATA_DIR, 'erp.db')); d2.prepare("UPDATE m365_connections SET expires_at='2000-01-01T00:00:00.000Z'").run(); d2.close();
    assert.equal(ok(await call('POST', 'm365/check', {})).email, 'admin@example.test'); assert.equal(mock.tokenCalls.at(-1).grant_type, 'refresh_token');
    const d3 = new DatabaseSync(path.join(process.env.DATA_DIR, 'erp.db')); d3.prepare("UPDATE m365_connections SET expires_at='2000-01-01T00:00:00.000Z'").run(); d3.close(); mock.refreshFails = true;
    const rf = await call('POST', 'm365/check', {}); assert.equal(rf.s, 502); noSecret(rf.t, 'refresh error'); mock.refreshFails = false;
    assert.equal(q("SELECT * FROM audit_log WHERE tbl='m365' AND action='refresh-failed'").length, 1);
    console.log('✔ link stored with tokens encrypted (no token in the database file); refresh works, a refresh failure is audited');

    // ---- backups never carry the tokens
    const bk = await fetch(base + '/api/backup', { headers: { cookie } }), file = path.join(process.env.DATA_DIR, 'dl.db'); fs.writeFileSync(file, Buffer.from(await bk.arrayBuffer()));
    const b = new DatabaseSync(file, { readOnly: true }), br = b.prepare('SELECT * FROM m365_connections').all(), bs = b.prepare('SELECT COUNT(*) n FROM oauth_states').get().n; b.close();
    assert.equal(br.length, 1); assert.equal(br[0].access_token_encrypted, null); assert.equal(br[0].refresh_token_encrypted, null); assert.equal(bs, 0);
    noSecret(fs.readFileSync(file).toString('latin1'), 'the backup'); assert.ok(!fs.readFileSync(file).toString('latin1').includes('v1.'), 'not even the encrypted tokens');
    const run = ok(await call('POST', 'backup/run', {})), auto = path.join(process.env.DATA_DIR, 'backups', run.latest.name);
    const a2 = new DatabaseSync(auto, { readOnly: true }), ar = a2.prepare('SELECT access_token_encrypted a, refresh_token_encrypted r FROM m365_connections').get(); a2.close(); assert.equal(ar.a, null); assert.equal(ar.r, null);
    console.log('✔ downloaded and automatic backups contain no Microsoft tokens or pending sign-ins');

    // ---- 9. disconnect: administrator only, audited
    cookie = acctCookie; assert.equal((await call('POST', 'm365/disconnect', {})).s, 403); cookie = adminCookie;
    assert.equal(ok(await call('POST', 'm365/disconnect', {})).removed, 1); assert.equal(q('SELECT * FROM m365_connections').length, 0);
    assert.equal(q("SELECT * FROM audit_log WHERE tbl='m365' AND action='disconnect' AND user='admin'").length, 1);
    assert.equal(ok(await call('GET', 'm365/status')).connection, null);
    console.log('✔ 9: disconnect is administrator only, removes the link and its tokens, and is audited');

    // ---- 8. nothing secret in any response body we produced, the audit log, the error log or the console
    noSecret(JSON.stringify(q('SELECT * FROM audit_log')), 'the audit log'); noSecret(JSON.stringify(q('SELECT * FROM error_log')), 'the error log');
    noSecret(logged.join('\n'), 'the console'); noSecret(good.t + again.t + ex.t + other.t, 'callback pages');
    console.log('✔ 8: no token, code, secret, key or PKCE verifier in responses, audit log, error log or console output');

    // ---- 10. the ERP login is unchanged (password sign-in, no Microsoft step)
    cookie = ''; ok(await call('POST', 'login', { username: 'admin', password: 'secret12' })); ok(await call('GET', 'dashboard'));
    console.log('M365 TESTS PASSED');
  } catch (err) { console.error('FAIL', err); process.exitCode = 1; }
  finally { server.close(); ms.close(); setTimeout(() => process.exit(process.exitCode || 0), 100); }
});
