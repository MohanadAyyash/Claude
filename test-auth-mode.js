// Microsoft-first authentication: AUTH_MODE (hybrid / microsoft-first), the break-glass administrator at /auth/emergency, and the
// whole Microsoft sign-in matrix in microsoft-first:  node --no-warnings test-auth-mode.js
// Local mock of Entra (token endpoint + JWKS) and Graph; id_tokens really signed (RS256) with jose; fake identities only, no internet.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert'), http = require('http'), crypto = require('crypto'), vm = require('vm');
const jose = require('jose');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-authmode-'));
process.env.ZOHO_NO_SCHEDULER = '1'; process.env.SALES_NO_SCHEDULER = '1'; process.env.BACKUP_NO_SCHEDULER = '1';
for (const k of Object.keys(process.env)) if (k.startsWith('M365_') || k.startsWith('AUTH_')) delete process.env[k];
process.env.TRUST_PROXY = '1'; delete process.env.SECURE_COOKIES;

const logged = [];
for (const m of ['log', 'error', 'warn', 'info']) { const o = console[m].bind(console); console[m] = (...a) => { logged.push(a.map(x => (x && x.stack) || String(x)).join(' ')); o(...a); }; }

const { server } = require('./server.js');
const { DatabaseSync } = require('node:sqlite');
const { sanitizedCopy } = require('./lib/backupsafe');
const TOTP = require('./lib/totp');
const TENANT = '11111111-2222-3333-4444-555555555555', OTHER_TENANT = '99999999-8888-7777-6666-555555555555';
const CLIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', SECRET = 'test-client-secret-NOT-REAL-msfirst';
const OID = { proc: '0b0b0b0b-0000-4000-8000-000000000001', site: '0b0b0b0b-0000-4000-8000-000000000002', acc: '0b0b0b0b-0000-4000-8000-000000000003', gone: '0b0b0b0b-0000-4000-8000-000000000004', admin: '0b0b0b0b-0000-4000-8000-000000000005', stranger: '0b0b0b0b-0000-4000-8000-0000000000ff' };
const KEY = crypto.randomBytes(32).toString('base64'), CODE = 'mock-auth-code-MSFIRST';
const PW = 'secret12', BG_PW = 'Break-Glass-Test-Pass-77';
const LOGIN_SCOPES = 'openid profile email User.Read', LINK_SCOPES = 'openid profile email offline_access User.Read';
const mailOf = oid => `user-${oid.slice(-2)}@example.test`;

(async () => {
  const good = await jose.generateKeyPair('RS256', { extractable: true }), evil = await jose.generateKeyPair('RS256', { extractable: true });
  const publicJwk = { ...(await jose.exportJWK(good.publicKey)), kid: 'entra-key-1', use: 'sig', alg: 'RS256' };
  const mock = { tokens: [], verifiers: [], pending: null, redirect: null, idToken: null, me: null, oid: null };
  let issued = 0; const newToken = kind => { const t = `mock-${kind}-token-${++issued}-${crypto.randomBytes(6).toString('hex')}`; mock.tokens.push(t); return t; };
  const sign = async (claims = {}, key = good.privateKey, kid = 'entra-key-1') => {
    const t = Math.floor(Date.now() / 1000);
    return new jose.SignJWT({ iss: `${process.env.M365_LOGIN_BASE}/${TENANT}/v2.0`, aud: CLIENT, tid: TENANT, oid: mock.oid, sub: 'pairwise', nonce: mock.pending.nonce, name: 'Fake User',
      preferred_username: mailOf(mock.oid), iat: t, nbf: t - 5, exp: t + 3600, ...claims }).setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' }).sign(key);
  };
  const ms = http.createServer((rq, rs) => { let body = ''; rq.on('data', c => body += c); rq.on('end', async () => {
    const out = (code, j) => { rs.writeHead(code, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify(j)); };
    if (rq.url === `/${TENANT}/discovery/v2.0/keys`) return out(200, { keys: [publicJwk] });
    if (rq.url === `/${TENANT}/oauth2/v2.0/token` && rq.method === 'POST') {
      const f = new URLSearchParams(body), login = (f.get('redirect_uri') || '').endsWith('/auth/microsoft/login/callback');
      if (f.get('client_id') !== CLIENT || f.get('client_secret') !== SECRET || f.get('scope') !== (login ? LOGIN_SCOPES : LINK_SCOPES)) return out(401, { error: 'invalid_client' });
      const st = mock.pending;
      if (f.get('grant_type') !== 'authorization_code' || !st || f.get('code') !== CODE || f.get('redirect_uri') !== mock.redirect) return out(400, { error: 'invalid_grant' });
      if (crypto.createHash('sha256').update(f.get('code_verifier') || '').digest('base64url') !== st.challenge) return out(400, { error: 'invalid_grant' });
      mock.verifiers.push(f.get('code_verifier'));
      return out(200, { token_type: 'Bearer', expires_in: 3600, access_token: newToken('access'), ...(login ? {} : { refresh_token: newToken('refresh') }), id_token: typeof mock.idToken === 'function' ? await mock.idToken() : await sign() });
    }
    if (rq.url.startsWith('/v1.0/me')) { const tok = (rq.headers.authorization || '').replace('Bearer ', ''); return mock.tokens.includes(tok) ? out(200, mock.me || { id: mock.oid, displayName: 'Fake User', mail: mailOf(mock.oid) }) : out(401, {}); }
    out(404, {});
  }); });

  server.listen(0, async () => {
    await new Promise(r => ms.listen(0, r));
    const port = server.address().port, base = `http://127.0.0.1:${port}`;
    let ipN = 0; const nextIp = () => `198.51.100.${(++ipN % 250) + 1}`;
    const call = async (m, u, b, ck = '') => { const r = await fetch(base + '/api/' + u, { method: m, redirect: 'manual', headers: { 'Content-Type': 'application/json', cookie: ck, 'X-Forwarded-For': nextIp() }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie') || ''; const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j, sc, t }; };
    const ok = (r, l) => { assert.equal(r.s, 200, `${l || ''} → ${r.s} ${String(r.t).slice(0, 300)}`); return r.j; };
    const sidOf = sc => (/(?:^|[ ,])sid=([a-f0-9]*)/.exec(sc || '') || [])[1];
    const pw = async (u, p = PW, extra = {}) => { const r = await call('POST', 'login', { username: u, password: p, ...extra }); assert.equal(r.s, 200, 'password login ' + u + ' ' + r.t); return 'sid=' + sidOf(r.sc); };
    const nav = (u, ck = '') => fetch(base + u, { redirect: 'manual', headers: { cookie: ck, 'X-Forwarded-For': nextIp() } }).then(async r => ({ s: r.status, loc: r.headers.get('location') || '', setCookie: r.headers.get('set-cookie') || '', t: await r.text() }));
    const dbFile = path.join(process.env.DATA_DIR, 'erp.db');
    const q = (sql, ...a) => { const d = new DatabaseSync(dbFile, { readOnly: true }); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
    const exec = (sql, ...a) => { const d = new DatabaseSync(dbFile); try { return d.prepare(sql).run(...a); } finally { d.close(); } };
    const audits = tbl => q('SELECT action, user, rec, detail FROM audit_log WHERE tbl=? ORDER BY id', tbl);
    const id = u => q('SELECT id FROM users WHERE username=?', u)[0].id;
    const mode = async () => ok(await call('GET', 'status')).auth_mode;
    const play = (r, oid, { me, idToken } = {}) => { const p = new URL(r.loc).searchParams; mock.pending = { challenge: p.get('code_challenge'), nonce: p.get('nonce') }; mock.redirect = p.get('redirect_uri'); mock.oid = oid; mock.me = me || null; mock.idToken = idToken || null; return p.get('state'); };
    const link = async (ck, oid) => { const r = await nav('/auth/microsoft', ck); if (r.s !== 302) return r; const state = play(r, oid), bind = (/m365_flow=([^;]+)/.exec(r.setCookie) || [])[1]; const c = await nav(`/auth/microsoft/callback?code=${CODE}&state=${state}`, `m365_flow=${bind}`); mock.idToken = null; mock.me = null; return c; };
    const sso = async (oid, opts = {}) => {
      const r = await nav('/auth/microsoft/login', opts.ck || ''); assert.equal(r.s, 302, r.t);
      const state = play(r, oid, opts), bind = (/m365_login=([^;]+)/.exec(r.setCookie) || [])[1];
      if (opts.tamper) opts.tamper();
      const c = await nav(`/auth/microsoft/login/callback?code=${CODE}&state=${state}`, [opts.ck, `m365_login=${bind}`].filter(Boolean).join('; ')); mock.idToken = null; mock.me = null;
      return { ...c, sid: sidOf(c.setCookie), state, bind };
    };
    const refused = (label, r, re) => { assert.equal(r.s, 400, `${label}: expected a refusal, got ${r.s} ${r.t.slice(0, 200)}`); if (re) assert.match(r.t, re, label); assert.ok(!sidOf(r.setCookie), `${label}: no session`); };
    // the break-glass page: a form post from this site (Origin), username + password + ERP code
    const emergency = (form, { origin = base, ck = '', ip = nextIp() } = {}) => fetch(base + '/auth/emergency', { method: 'POST', redirect: 'manual', body: new URLSearchParams(form).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie: ck, 'X-Forwarded-For': ip, ...(origin ? { Origin: origin } : {}) } }).then(async r => ({ s: r.status, loc: r.headers.get('location') || '', setCookie: r.headers.get('set-cookie') || '', t: await r.text() }));
    let bgSecret = null; const bgCode = () => { exec('UPDATE users SET totp_last=0 WHERE username=?', 'breakglass'); return TOTP.codeAt(bgSecret, TOTP.stepNow()); };

    try {
      // ---- set-up (hybrid): users, a project, Microsoft 365 configured, links made with password sessions (onboarding) ----
      ok(await call('POST', 'setup', { username: 'admin', password: PW, company: 'Test Co' }));
      const admin = await pw('admin');
      for (const [u, role, p] of [['breakglass', 'admin', BG_PW], ['proc', 'procurement', PW], ['site', 'site_engineer', PW], ['acc', 'accountant', PW], ['gone', 'viewer', PW]]) ok(await call('POST', 'users', { username: u, password: p, role }, admin));
      const cl = ok(await call('POST', 'parties', { type: 'client', name: 'Client' }, admin)).id;
      const P1 = ok(await call('POST', 'projects', { name: 'Assigned', client_id: cl, status: 'active' }, admin)).id; ok(await call('POST', 'projects', { name: 'Other', client_id: cl, status: 'active' }, admin));
      ok(await call('PUT', 'users/' + id('site'), { projects: [P1] }, admin));
      Object.assign(process.env, { M365_ENABLED: '1', M365_TENANT_ID: TENANT, M365_CLIENT_ID: CLIENT, M365_CLIENT_SECRET: SECRET, M365_ENCRYPTION_KEY: KEY,
        M365_REDIRECT_URI: `${base}/auth/microsoft/callback`, M365_LOGIN_BASE: `http://127.0.0.1:${ms.address().port}`, M365_GRAPH_BASE: `http://127.0.0.1:${ms.address().port}/v1.0` });
      for (const u of ['proc', 'site', 'acc', 'gone', 'admin']) assert.equal((await link(u === 'admin' ? admin : await pw(u), OID[u])).s, 302, 'link ' + u);

      // ---- 26. hybrid (default) keeps today's sign-in ----
      assert.equal(await mode(), 'hybrid'); assert.equal(ok(await call('GET', 'status')).m365_login, true);
      await pw('proc'); assert.equal((await sso(OID.proc)).s, 302, 'and Microsoft');
      console.log('✔ 26: hybrid (default): password and Microsoft sign-in both work as before');

      // ---- 25. microsoft-first cannot take effect without a valid break-glass administrator with the ERP code ----
      process.env.AUTH_MODE = 'microsoft-first';
      assert.equal(await mode(), 'hybrid', 'no AUTH_EMERGENCY_ADMINS → stays hybrid');
      let st = ok(await call('GET', 'm365/status', undefined, admin)).auth; assert.equal(st.requested, 'microsoft-first'); assert.match(st.reason, /no valid emergency administrator/);
      process.env.AUTH_EMERGENCY_ADMINS = 'breakglass';
      st = ok(await call('GET', 'm365/status', undefined, admin)).auth; assert.equal(st.mode, 'hybrid'); assert.deepEqual(st.emergency_admins[0].problems, ['two-step sign-in (ERP code) is off']);
      process.env.AUTH_EMERGENCY_ADMINS = 'proc';
      assert.ok(ok(await call('GET', 'm365/status', undefined, admin)).auth.emergency_admins[0].problems.includes('not an administrator'), 'a non-admin is never a valid emergency account');
      process.env.AUTH_EMERGENCY_ADMINS = 'admin';
      assert.ok(ok(await call('GET', 'm365/status', undefined, admin)).auth.emergency_admins[0].problems.some(p => /linked to Microsoft/.test(p)), 'a Microsoft-linked admin is not independent');
      process.env.AUTH_EMERGENCY_ADMINS = 'breakglass';
      process.env.AUTH_MODE = 'hybrid';                                       // (turn the code on while still hybrid: the switch happens at the next request after it)
      const bgPw = await pw('breakglass', BG_PW); const setup = ok(await call('POST', '2fa/setup', {}, bgPw)); bgSecret = setup.secret;
      ok(await call('POST', '2fa/enable', { code: TOTP.codeAt(bgSecret, TOTP.stepNow()) }, bgPw));
      process.env.AUTH_MODE = 'microsoft-first';
      process.env.M365_ENABLED = '0'; assert.equal(await mode(), 'hybrid', 'Microsoft 365 off → stays hybrid'); process.env.M365_ENABLED = '1';
      process.env.AUTH_MODE = 'microsoft-frist'; assert.equal(await mode(), 'hybrid', 'a typo is not a mode'); process.env.AUTH_MODE = 'microsoft-first';
      const passwordSessionsBefore = q("SELECT COUNT(*) n FROM sessions WHERE method='password'")[0].n; assert.ok(passwordSessionsBefore > 0);
      assert.equal(await mode(), 'microsoft-first', 'valid break-glass with the ERP code → microsoft-first');
      console.log('✔ 25: microsoft-first takes effect only with Microsoft configured and a valid emergency admin (admin, active, ERP code on, not linked)');

      // ---- 27. mode changes audited ----
      const am = audits('auth').filter(a => a.action === 'auth-mode');
      assert.ok(am.some(a => /effective hybrid \(requested microsoft-first\) - no valid emergency administrator/.test(a.detail)), JSON.stringify(am));
      assert.ok(am.some(a => /effective microsoft-first \(requested microsoft-first\).*\[was hybrid\]/.test(a.detail)));
      assert.ok(am.some(a => /password session\(s\) ended by the switch to microsoft-first/.test(a.detail)));
      assert.equal(q("SELECT COUNT(*) n FROM sessions WHERE method='password' OR method IS NULL")[0].n, 0, 'entering microsoft-first ends every password session');
      console.log('✔ 27: every change of the effective mode is audited; entering microsoft-first ends the password sessions');

      // ---- 20. the password form is off for everyone in microsoft-first ----
      for (const [u, p] of [['proc', PW], ['admin', PW], ['breakglass', BG_PW], ['nobody', 'x'], ['admin', 'wrong-password']]) {
        const r = await call('POST', 'login', { username: u, password: p }); assert.equal(r.s, 403, `${u}: password sign-in refused`); assert.equal(r.j.auth_mode, 'microsoft-first'); assert.ok(!sidOf(r.sc));
      }
      assert.equal(ok(await call('GET', 'status', undefined, admin)).user, null, 'the old password session no longer counts');
      const appJs = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8'), screen = appJs.slice(appJs.indexOf('const msFirstScreen'), appJs.indexOf('const loginScreen'));
      assert.ok(/id="mslogin" href="\/auth\/microsoft\/login"/.test(screen) && /href="\/auth\/emergency"/.test(screen), 'the microsoft-first screen: the Microsoft button and the emergency link');
      assert.ok(!/type="password"|name="password"|name="username"/.test(screen), 'and no username / password form');
      assert.match(appJs, /const loginScreen = st => st && st\.auth_mode === 'microsoft-first' \? msFirstScreen\(\)/);
      console.log('✔ 20: microsoft-first: no password form for anyone (API 403 before the password is checked; login screen without it)');

      // ---- 1–19 in microsoft-first ----
      const s1 = await sso(OID.proc); assert.equal(s1.s, 302); assert.equal(s1.loc, '/', '1: clean URL');
      const me1 = ok(await call('GET', 'status', undefined, `sid=${s1.sid}`)).user; assert.equal(me1.id, id('proc')); assert.equal(me1.role, 'procurement', '9: procurement stays procurement');
      assert.equal(q('SELECT method FROM sessions WHERE token=?', s1.sid)[0].method, 'microsoft');
      for (const [m, u, b] of [['GET', 'users'], ['GET', 'audit'], ['PUT', 'settings', { company_name: 'X' }], ['GET', 'backup']]) assert.equal((await call(m, u, b, `sid=${s1.sid}`)).s, 403, `9: ${m} ${u}`);
      assert.equal((await call('GET', 'purchase_orders', undefined, `sid=${s1.sid}`)).s, 200);
      refused('2 unlinked', await sso(OID.stranger), /not linked/);
      refused('3 same e-mail, other oid', await sso(OID.stranger, { idToken: () => sign({ preferred_username: mailOf(OID.proc), email: mailOf(OID.proc) }), me: { id: OID.stranger, mail: mailOf(OID.proc), userPrincipalName: mailOf(OID.proc) } }), /not linked/);
      refused('4 same oid, other tenant', await sso(OID.proc, { idToken: () => sign({ iss: `${process.env.M365_LOGIN_BASE}/${OTHER_TENANT}/v2.0`, tid: OTHER_TENANT }) }));
      refused('4 same oid, other tid', await sso(OID.proc, { idToken: () => sign({ tid: OTHER_TENANT }) }), /another organisation/);
      exec('UPDATE users SET disabled=1 WHERE id=?', id('acc')); refused('5 disabled', await sso(OID.acc), /disabled/); exec('UPDATE users SET disabled=0 WHERE id=?', id('acc'));
      refused('5 re-enabled: the link went with the disable', await sso(OID.acc), /not linked/);
      const sGone = await sso(OID.gone); assert.equal(sGone.s, 302); exec('DELETE FROM users WHERE id=?', id('gone')); refused('6 deleted', await sso(OID.gone), /not linked/);
      assert.equal(ok(await call('POST', 'm365/disconnect', {}, `sid=${s1.sid}`)).removed, 1);
      refused('7 disconnected', await sso(OID.proc), /not linked/);
      assert.equal((await link(`sid=${s1.sid}`, OID.proc)).s, 302, '8: reconnect from the Microsoft session'); assert.equal((await sso(OID.proc)).s, 302, '8: SSO restored');
      const sSite = await sso(OID.site); assert.deepEqual(ok(await call('GET', 'projects', undefined, `sid=${sSite.sid}`)).map(p => p.id), [P1], '10: site user keeps the project scope');
      const sGa = await sso(OID.proc, { idToken: () => sign({ roles: ['Global Administrator', 'Admin'], groups: ['admins'], wids: ['62e90394-69f5-4237-9190-012177145e10'], jobTitle: 'Administrator' }), me: { id: OID.proc, mail: mailOf(OID.proc), jobTitle: 'Administrator' } });
      assert.equal(ok(await call('GET', 'status', undefined, `sid=${sGa.sid}`)).user.role, 'procurement', '11: Microsoft admin claims do not make an ERP admin'); assert.equal((await call('GET', 'users', undefined, `sid=${sGa.sid}`)).s, 403);
      { const planted = 'sid=' + (await sso(OID.site)).sid; const s = await sso(OID.proc, { ck: planted }); assert.notEqual('sid=' + s.sid, planted, '12'); assert.equal(q('SELECT COUNT(*) n FROM sessions WHERE token=?', planted.slice(4))[0].n, 0, '12: the planted session is ended'); }
      { const s = await sso(OID.proc); refused('13 replay', await nav(`/auth/microsoft/login/callback?code=${CODE}&state=${s.state}`, `m365_login=${s.bind}`), /not known|already used/); }
      refused('14 expired', await sso(OID.proc, { tamper: () => exec('UPDATE oauth_login_states SET expires_at=?', new Date(Date.now() - 1000).toISOString()) }), /expired/);
      refused('15 PKCE mismatch', await sso(OID.proc, { tamper: () => { mock.pending.challenge = crypto.createHash('sha256').update('other').digest('base64url'); } }), /invalid_grant/);
      refused('16 nonce mismatch', await sso(OID.proc, { idToken: () => sign({ nonce: 'not-the-nonce' }) }), /does not belong to this request/);
      refused('17 invalid issuer', await sso(OID.proc, { idToken: () => sign({ iss: 'https://login.example.test/x/v2.0' }) }));
      refused('18 invalid audience', await sso(OID.proc, { idToken: () => sign({ aud: 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee' }) }));
      refused('19 invalid signature', await sso(OID.proc, { idToken: () => sign({}, evil.privateKey) }));
      console.log('✔ 1–19: in microsoft-first: linked users sign in (clean URL, Microsoft session); unlinked / same e-mail / other tenant / disabled / deleted / disconnected refused; reconnect works; roles, project scope and ACL are the ERP\'s (Global Admin claims ignored); no fixation; state single use + expiry; PKCE, nonce, issuer, audience, signature checked');

      // ---- 21–24. emergency administrator ----
      assert.equal((await nav('/auth/emergency')).s, 200, 'the page');
      const g = await nav('/auth/emergency'); assert.match(g.t, /Emergency administrator sign-in/); assert.match(g.t, /دخول المسؤول للطوارئ/); assert.ok(!sidOf(g.setCookie));
      const e1 = await emergency({ username: 'breakglass', password: BG_PW, code: bgCode() });
      assert.equal(e1.s, 303, e1.t); assert.equal(e1.loc, '/'); const eSid = sidOf(e1.setCookie); assert.ok(eSid);
      assert.match(e1.setCookie, /sid=[a-f0-9]{48}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=3600(;|,|$)/, '1-hour cookie (default) with the ERP session protections');
      const eMe = ok(await call('GET', 'status', undefined, `sid=${eSid}`)).user; assert.equal(eMe.username, 'breakglass'); assert.equal(eMe.role, 'admin');
      assert.equal(q('SELECT method FROM sessions WHERE token=?', eSid)[0].method, 'emergency');
      ok(await call('GET', 'users', undefined, `sid=${eSid}`), 'administrator rights');
      exec('UPDATE sessions SET created=? WHERE token=?', Date.now() - 59 * 60e3, eSid); assert.equal(ok(await call('GET', 'status', undefined, `sid=${eSid}`)).user.username, 'breakglass', 'still valid at 59 minutes');
      exec('UPDATE sessions SET created=? WHERE token=?', Date.now() - 61 * 60e3, eSid); assert.equal(ok(await call('GET', 'status', undefined, `sid=${eSid}`)).user, null, 'an emergency session ends after 60 minutes (default)');
      console.log('✔ 21: emergency administrator: password + valid ERP code → admin session (method emergency, 60 minutes by default), works in microsoft-first without Microsoft');

      // ---- session lifetimes: configured, clamped, never extended ----
      {
        const emSignIn = async (ck = '') => { const r = await emergency({ username: 'breakglass', password: BG_PW, code: bgCode() }, { ck }); assert.equal(r.s, 303, r.t); return { sid: sidOf(r.setCookie), setCookie: r.setCookie }; };
        const age = (sid, ms) => exec('UPDATE sessions SET created=? WHERE token=?', Date.now() - ms, sid);
        const who = async sid => (ok(await call('GET', 'status', undefined, `sid=${sid}`)).user || {}).username || null;
        // the configured emergency duration is the one applied (cookie and server)
        process.env.AUTH_EMERGENCY_SESSION_MINUTES = '30';
        let e = await emSignIn(); assert.match(e.setCookie, /Max-Age=1800(;|,|$)/, 'cookie: 30 minutes');
        age(e.sid, 29 * 60e3); assert.equal(await who(e.sid), 'breakglass', '29 minutes: valid'); age(e.sid, 31 * 60e3); assert.equal(await who(e.sid), null, '31 minutes: expired');
        // invalid or extreme values: never longer than 4 hours, and anything that is not a positive number means the 1-hour default
        const minutes = async v => { if (v === undefined) delete process.env.AUTH_EMERGENCY_SESSION_MINUTES; else process.env.AUTH_EMERGENCY_SESSION_MINUTES = v; return ok(await call('GET', 'm365/status', undefined, 'sid=' + (await sso(OID.admin)).sid)).auth.sessions.emergency_minutes; };
        for (const [v, want] of [[undefined, 60], ['', 60], ['abc', 60], ['0', 60], ['-30', 60], ['NaN', 60], ['Infinity', 60], ['1e9', 240], ['100000', 240], ['241', 240], ['240', 240], ['1', 5], ['90', 90]])
          assert.equal(await minutes(v), want, `AUTH_EMERGENCY_SESSION_MINUTES=${v} → ${want}`);
        process.env.AUTH_EMERGENCY_SESSION_MINUTES = '100000'; e = await emSignIn(); assert.match(e.setCookie, /Max-Age=14400(;|,|$)/, 'an extreme value is clamped to 4 hours');
        age(e.sid, 4 * 3600e3 + 60e3); assert.equal(await who(e.sid), null, 'and expires after 4 hours');
        delete process.env.AUTH_EMERGENCY_SESSION_MINUTES;
        // Microsoft sessions: 12 hours by default, configurable, at most 30 days
        const ms1 = await sso(OID.proc); assert.match(ms1.setCookie, /sid=[a-f0-9]{48}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=43200/);
        age(ms1.sid, 11 * 3600e3); assert.equal(await who(ms1.sid), 'proc'); age(ms1.sid, 13 * 3600e3); assert.equal(await who(ms1.sid), null, 'a Microsoft session ends after 12 hours (default)');
        process.env.AUTH_MICROSOFT_SESSION_HOURS = '99999'; assert.match((await sso(OID.proc)).setCookie, /Max-Age=2592000(;|,|$)/, 'clamped to 30 days (the ERP\'s own limit)');
        process.env.AUTH_MICROSOFT_SESSION_HOURS = 'abc'; assert.match((await sso(OID.proc)).setCookie, /Max-Age=43200(;|,|$)/, 'invalid → 12 hours');
        delete process.env.AUTH_MICROSOFT_SESSION_HOURS;
        // nothing extends an emergency session: using it, signing in again with a password or Microsoft in the same browser
        e = await emSignIn(); age(e.sid, 50 * 60e3); const created = q('SELECT created FROM sessions WHERE token=?', e.sid)[0].created;
        for (let i = 0; i < 3; i++) { ok(await call('GET', 'users', undefined, `sid=${e.sid}`)); ok(await call('GET', 'status', undefined, `sid=${e.sid}`)); }
        assert.equal(q('SELECT created FROM sessions WHERE token=?', e.sid)[0].created, created, 'use does not move the expiry (no sliding)');
        const viaMs = await sso(OID.admin, { ck: `sid=${e.sid}` });
        assert.equal(q('SELECT COUNT(*) n FROM sessions WHERE token=?', e.sid)[0].n, 0, 'a Microsoft sign-in in that browser ends the emergency session (not extended)');
        assert.equal(q('SELECT method FROM sessions WHERE token=?', viaMs.sid)[0].method, 'microsoft', 'and the new session is a Microsoft one, with its own lifetime');
        process.env.AUTH_MODE = 'hybrid';
        const e2 = await emSignIn(); age(e2.sid, 50 * 60e3); const c2 = q('SELECT created FROM sessions WHERE token=?', e2.sid)[0].created;
        const pwr = await call('POST', 'login', { username: 'admin', password: PW }, `sid=${e2.sid}`); assert.equal(pwr.s, 200);
        assert.notEqual(sidOf(pwr.sc), e2.sid, 'the password sign-in gets its own session');
        assert.equal(q('SELECT method FROM sessions WHERE token=?', sidOf(pwr.sc))[0].method, 'password');
        assert.equal(q('SELECT created FROM sessions WHERE token=?', e2.sid)[0].created, c2, 'the emergency session keeps its own creation time');
        age(e2.sid, 61 * 60e3); assert.equal(await who(e2.sid), null, '…and still ends at 60 minutes');
        process.env.AUTH_MODE = 'microsoft-first'; assert.equal(await mode(), 'microsoft-first');
        assert.equal(q("SELECT COUNT(*) n FROM sessions WHERE method='password'")[0].n, 0, 'switching to microsoft-first again ended that password session');
        // a password session that appears while microsoft-first is on (e.g. made by older code) is not accepted
        exec("INSERT INTO sessions(token,user_id,created,method) VALUES(?,?,?,'password')", 'ab'.repeat(24), id('admin'), Date.now());
        exec("INSERT INTO sessions(token,user_id,created,method) VALUES(?,?,?,NULL)", 'cd'.repeat(24), id('admin'), Date.now());
        assert.equal(await who('ab'.repeat(24)), null, 'password session refused in microsoft-first'); assert.equal(await who('cd'.repeat(24)), null, 'legacy (no method) session refused too');
        exec("DELETE FROM sessions WHERE token IN (?,?)", 'ab'.repeat(24), 'cd'.repeat(24));
      }
      console.log('✔ session lifetimes: emergency = AUTH_EMERGENCY_SESSION_MINUTES (default 60, 5–240; invalid → 60, extreme → 240), Microsoft = AUTH_MICROSOFT_SESSION_HOURS (default 12, ≤ 30 days); never extended by use or by another sign-in; switching mode ends / refuses incompatible sessions');

      // ---- the emergency form's origin check (Windows test: Edge posted "Origin: null" because the page said Referrer-Policy: no-referrer) ----
      {
        const raw = (headers, form) => new Promise((ok_, no) => { const body = new URLSearchParams(form).toString();
          const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/auth/emergency', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), ...headers } },
            rs => { let t = ''; rs.on('data', c => t += c); rs.on('end', () => ok_({ s: rs.statusCode, setCookie: [].concat(rs.headers['set-cookie'] || []).join(', '), t })); }); r.on('error', no); r.end(body); });
        const form = () => ({ username: 'breakglass', password: BG_PW, code: bgCode() });
        const lastAudit = () => q("SELECT detail FROM audit_log WHERE tbl='auth' ORDER BY id DESC LIMIT 1")[0].detail;
        const page = await nav('/auth/emergency'); assert.equal((await fetch(base + '/auth/emergency')).headers.get('referrer-policy'), 'same-origin', 'the page lets the browser send its real Origin (not "null")');
        void page;
        process.env.TRUST_PROXY = '0';                                        // as on the isolated Windows copy: no proxy, forwarded headers not trusted
        let r = await raw({ Host: `localhost:${port}`, Origin: `http://localhost:${port}` }, form());
        assert.equal(r.s, 303, 'served as localhost, posted from localhost ' + r.t.slice(0, 200)); assert.ok(sidOf(r.setCookie));
        r = await raw({ Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}` }, form());
        assert.equal(r.s, 303, 'served as 127.0.0.1, posted from 127.0.0.1');
        const refusedOrigin = async (label, headers, re) => { const x = await raw(headers, form()); assert.equal(x.s, 403, `${label}: ${x.s}`); assert.ok(!sidOf(x.setCookie), label);
          assert.match(x.t, /Sign-in failed\. Check the username, password and code, or wait 15 minutes\./, `${label}: the generic message`); assert.doesNotMatch(x.t, /Origin|expected/, `${label}: no detail shown`);
          assert.match(lastAudit(), re, `${label}: the audit says why`); };
        await refusedOrigin('localhost page, 127.0.0.1 origin (no loopback equivalence)', { Host: `localhost:${port}`, Origin: `http://127.0.0.1:${port}` }, new RegExp(`Origin http://127\\.0\\.0\\.1:${port}, expected http://localhost:${port}`));
        await refusedOrigin('127.0.0.1 page, localhost origin', { Host: `127.0.0.1:${port}`, Origin: `http://localhost:${port}` }, /expected http:\/\/127\.0\.0\.1:/);
        await refusedOrigin('other port', { Host: `localhost:${port}`, Origin: `http://localhost:${port + 1}` }, /not posted from this site/);
        await refusedOrigin('attacker origin', { Host: `localhost:${port}`, Origin: 'https://evil.example' }, /Origin https:\/\/evil\.example, expected/);
        await refusedOrigin('look-alike origin', { Host: `localhost:${port}`, Origin: `http://localhost:${port}.evil.example` }, /not posted from this site/);
        await refusedOrigin('Origin: null', { Host: `localhost:${port}`, Origin: 'null' }, /Origin null, expected http:\/\/localhost:/);
        await refusedOrigin('no Origin, no Referer', { Host: `localhost:${port}` }, /Origin \(none\)/);
        await refusedOrigin('https origin to an http server', { Host: `localhost:${port}`, Origin: `https://localhost:${port}` }, /not posted from this site/);
        await refusedOrigin('forwarded host spoofed while TRUST_PROXY is off', { Host: `127.0.0.1:${port}`, 'X-Forwarded-Host': 'erp.trigon.ae', 'X-Forwarded-Proto': 'https', Origin: 'https://erp.trigon.ae' }, /expected http:\/\/127\.0\.0\.1:/);
        // production behind the trusted proxy (Cloudflare tunnel): https://erp.trigon.ae
        process.env.TRUST_PROXY = '1';
        const prod = { Host: `127.0.0.1:${port}`, 'X-Forwarded-Host': 'erp.trigon.ae', 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': nextIp() };
        r = await raw({ ...prod, Origin: 'https://erp.trigon.ae' }, form()); assert.equal(r.s, 303, 'production origin behind the trusted proxy ' + r.t.slice(0, 160));
        await refusedOrigin('production host, http origin', { ...prod, Origin: 'http://erp.trigon.ae' }, /expected https:\/\/erp\.trigon\.ae/);
        await refusedOrigin('production host, other origin', { ...prod, Origin: 'https://erp.trigon.ae.evil.example' }, /expected https:\/\/erp\.trigon\.ae/);
        await refusedOrigin('production host, null origin', { ...prod, Origin: 'null' }, /Origin null, expected https:\/\/erp\.trigon\.ae/);
        // a real browser posting the page's own form (skipped where no browser is installed, e.g. CI)
        let browser = null; try { browser = await require(process.env.PLAYWRIGHT_PATH || 'playwright').chromium.launch({ executablePath: process.env.CHROME_PATH || undefined }); } catch { browser = null; }
        if (browser) {
          process.env.TRUST_PROXY = '0';
          try {
            const pg = await browser.newPage(); await pg.goto(`http://localhost:${port}/auth/emergency`);
            await pg.fill('[name=username]', 'breakglass'); await pg.fill('[name=password]', BG_PW); await pg.fill('[name=code]', bgCode());
            await Promise.all([pg.waitForURL(u => !u.pathname.startsWith('/auth/emergency'), { timeout: 15000 }), pg.click('button')]);
            const ck = (await pg.context().cookies()).find(c => c.name === 'sid'); assert.ok(ck, 'browser: signed in');
            assert.equal(q('SELECT method FROM sessions WHERE token=?', ck.value)[0].method, 'emergency');
            console.log('  ✔ browser (Chromium): the emergency form posted from http://localhost signs in');
          } finally { await browser.close(); process.env.TRUST_PROXY = '1'; }
        } else console.log('  (browser check skipped: no Chromium here)');
        process.env.TRUST_PROXY = '1';
      }
      console.log('✔ emergency origin check: localhost→localhost and 127.0.0.1→127.0.0.1 accepted; mismatched, other-port, attacker, look-alike, null / missing, wrong-scheme and spoofed-forwarded origins refused (generic message, detailed audit); https://erp.trigon.ae accepted only behind the trusted proxy');
      const bad = async (label, form, opts, status = 401) => { const r = await emergency(form, opts); assert.equal(r.s, status, `${label}: ${r.s} ${r.t.slice(0, 120)}`); assert.ok(!sidOf(r.setCookie), `${label}: no session`); return r; };
      await bad('22 no code', { username: 'breakglass', password: BG_PW });
      await bad('22 wrong code', { username: 'breakglass', password: BG_PW, code: '000000' });
      await bad('wrong password', { username: 'breakglass', password: 'nope', code: bgCode() });
      process.env.AUTH_EMERGENCY_ADMINS = 'breakglass,proc';
      await bad('23 non-admin listed', { username: 'proc', password: PW, code: '123456' });
      await bad('23 admin not listed', { username: 'admin', password: PW, code: '123456' });
      process.env.AUTH_EMERGENCY_ADMINS = 'breakglass';
      exec('UPDATE users SET disabled=1 WHERE username=?', 'breakglass'); await bad('24 disabled admin', { username: 'breakglass', password: BG_PW, code: bgCode() }); exec('UPDATE users SET disabled=0 WHERE username=?', 'breakglass');
      exec('UPDATE users SET totp_on=0 WHERE username=?', 'breakglass'); await bad('22 ERP code switched off', { username: 'breakglass', password: BG_PW, code: bgCode() }); exec('UPDATE users SET totp_on=1 WHERE username=?', 'breakglass');
      await bad('posted from another site', { username: 'breakglass', password: BG_PW, code: bgCode() }, { origin: 'https://evil.example' }, 403);
      await bad('no Origin', { username: 'breakglass', password: BG_PW, code: bgCode() }, { origin: null }, 403);
      // per account: breakglass has had 5 failed attempts above → locked for 15 minutes, from any address, even with the right password + code
      await bad('6th attempt on the account', { username: 'breakglass', password: BG_PW, code: bgCode() }, { ip: '203.0.113.77' }, 429);
      // per address: 5 attempts on any names, then the 6th from that address is refused
      { const ip = '203.0.113.50'; for (let i = 0; i < 5; i++) await bad('rate ' + i, { username: 'someone' + i, password: 'nope', code: '000000' }, { ip });
        await bad('6th attempt from one address', { username: 'someone9', password: 'nope', code: '000000' }, { ip }, 429); }
      { const r = await fetch(base + '/auth/emergency', { method: 'PUT', headers: { Origin: base, 'X-Forwarded-For': nextIp() } }); assert.equal(r.status, 405); }
      console.log('✔ 22–24: emergency sign-in refused without / with a wrong ERP code, ERP code off, wrong password, non-admin, admin not named, disabled admin, other site / no Origin; 5 attempts per 15 min per address and account');

      // ---- 28. emergency attempts audited, without secrets ----
      const em = audits('auth').filter(a => a.action.startsWith('emergency-login'));
      assert.ok(em.some(a => a.action === 'emergency-login' && a.user === 'breakglass'));
      for (const re of [/wrong or reused code/, /wrong password/, /not an administrator/, /not an emergency administrator account/, /account disabled/, /two-step sign-in \(ERP code\) is not on/, /not posted from this site/, /too many attempts/])
        assert.ok(em.some(a => a.action === 'emergency-login-failed' && re.test(a.detail)), 'audited: ' + re);
      for (const s of [BG_PW, PW, bgSecret]) assert.ok(!JSON.stringify(em).includes(s), 'no password or code secret in the audit');
      console.log('✔ 28: every emergency attempt is audited (success and each kind of refusal), never with the password or the code');

      // ---- back to hybrid: the password form works again (password sessions that were ended stay ended) ----
      process.env.AUTH_MODE = 'hybrid'; assert.equal(await mode(), 'hybrid');
      assert.equal(ok(await call('GET', 'status', undefined, admin)).user, null, 'the sessions ended by microsoft-first are gone');
      await pw('proc'); process.env.AUTH_MODE = 'microsoft-first'; assert.equal(await mode(), 'microsoft-first');
      console.log('✔ switching back to hybrid restores the password form; ended password sessions stay ended');

      // ---- 29. service worker ----
      {
        const on = {}, origin = 'https://erp.example.test';
        const sw = { self: { addEventListener: (t, f) => { on[t] = f; }, registration: { scope: origin + '/' }, clients: {} }, location: { origin }, URL, Response, Promise,
          caches: { match: async () => new Response('<cached app page>'), open: async () => ({ match: async () => null, put() {} }), keys: async () => [] }, fetch: async () => new Response('network') };
        vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'public', 'sw.js'), 'utf8'), sw);
        const taken = (p, mode, method = 'GET') => { let r = false; on.fetch({ request: { method, mode, url: origin + p }, respondWith() { r = true; } }); return r; };
        for (const p of ['/auth/microsoft', '/auth/microsoft/callback?code=x&state=y', '/auth/microsoft/login', '/auth/microsoft/login/callback?code=x&state=y', '/auth/emergency'])
          for (const m of ['navigate', 'no-cors', 'same-origin']) assert.equal(taken(p, m), false, `${p} (${m})`);
        assert.equal(taken('/', 'navigate'), true, 'control');
      }
      console.log('✔ 29: the service worker never intercepts /auth/microsoft…, /auth/microsoft/login… or /auth/emergency');

      // ---- 30. no secrets ----
      {
        const secrets = [...mock.tokens, CODE, SECRET, KEY, ...mock.verifiers, BG_PW, bgSecret];
        const everything = [JSON.stringify(q('SELECT * FROM audit_log')), JSON.stringify(q('SELECT * FROM error_log')), logged.join('\n'), JSON.stringify(q('SELECT token, user_id, method FROM sessions')),
          JSON.stringify(ok(await call('GET', 'm365/status', undefined, 'sid=' + (await sso(OID.admin)).sid))), JSON.stringify(ok(await call('GET', 'status')))];
        everything.forEach((t, i) => { for (const s of secrets) assert.ok(!t.includes(s), `${['audit log', 'error log', 'console', 'sessions', 'admin status', 'status'][i]} has no secret (${String(s).slice(0, 10)}…)`); });
        const bfile = path.join(process.env.DATA_DIR, 'b.db'); { const d = new DatabaseSync(dbFile); sanitizedCopy(d, bfile); d.close(); }
        const raw = fs.readFileSync(bfile).toString('latin1'); for (const s of [...mock.tokens, CODE, SECRET, KEY, ...mock.verifiers]) assert.ok(!raw.includes(s), 'backup has no token / secret');
        const b = new DatabaseSync(bfile, { readOnly: true }); assert.equal(b.prepare('SELECT COUNT(*) n FROM m365_connections WHERE access_token_encrypted IS NOT NULL OR refresh_token_encrypted IS NOT NULL').get().n, 0); b.close();
        const adminSt = ok(await call('GET', 'm365/status', undefined, 'sid=' + (await sso(OID.admin)).sid));
        assert.equal(adminSt.auth.mode, 'microsoft-first'); assert.ok(adminSt.server_started_at); assert.deepEqual(adminSt.auth.emergency_admins, [{ username: 'breakglass', ok: true, problems: [] }]);
        const userSt = ok(await call('GET', 'm365/status', undefined, 'sid=' + (await sso(OID.proc)).sid)); assert.ok(!('auth' in userSt) && !('tenant_id' in userSt), 'a user sees no server configuration');
      }
      console.log('✔ 30: no code, token, secret, key, verifier, password or TOTP secret in responses, logs, audit, sessions or backups; admin status shows mode / emergency accounts / start time, users see none of it');

      console.log('\nAUTH MODE TESTS PASSED');
    } catch (err) { console.error('FAIL', err); process.exitCode = 1; }
    finally { server.close(); ms.close(); setTimeout(() => process.exit(process.exitCode || 0), 100); }
  });
})();
