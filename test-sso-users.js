// Phase 1C: every existing, active ERP user can link THEIR OWN Microsoft account and sign in with it; the ERP role / ACL / project
// access stay exactly the ERP's:  node --no-warnings test-sso-users.js
// Local mock of Entra (token endpoint + JWKS) and Graph; id_tokens really signed (RS256) with jose; fake identities only, no internet.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert'), http = require('http'), crypto = require('crypto'), vm = require('vm'), cp = require('child_process'), net = require('net');
const jose = require('jose');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-sso-users-'));
process.env.ZOHO_NO_SCHEDULER = '1'; process.env.SALES_NO_SCHEDULER = '1'; process.env.BACKUP_NO_SCHEDULER = '1';
for (const k of Object.keys(process.env)) if (k.startsWith('M365_')) delete process.env[k];
process.env.TRUST_PROXY = '1'; delete process.env.SECURE_COOKIES;              // each flow from its own address (X-Forwarded-For): the start limit is per address

const logged = [];
for (const m of ['log', 'error', 'warn', 'info']) { const o = console[m].bind(console); console[m] = (...a) => { logged.push(a.map(x => (x && x.stack) || String(x)).join(' ')); o(...a); }; }

const { server } = require('./server.js');
const { DatabaseSync } = require('node:sqlite');
const { sanitizedCopy } = require('./lib/backupsafe');
const TOTP = require('./lib/totp');
const TENANT = '11111111-2222-3333-4444-555555555555', OTHER_TENANT = '99999999-8888-7777-6666-555555555555';
const CLIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', SECRET = 'test-client-secret-NOT-REAL-sso-1c';
const OID = { proc: '0a0a0a0a-0000-4000-8000-000000000001', acc: '0a0a0a0a-0000-4000-8000-000000000002', site: '0a0a0a0a-0000-4000-8000-000000000003',
  acc2: '0a0a0a0a-0000-4000-8000-000000000004', gone: '0a0a0a0a-0000-4000-8000-000000000005', stranger: '0a0a0a0a-0000-4000-8000-0000000000ff' };
const KEY = crypto.randomBytes(32).toString('base64'), CODE = 'mock-auth-code-SSO-1C';
const LOGIN_SCOPES = 'openid profile email User.Read', LINK_SCOPES = 'openid profile email offline_access User.Read';
const mailOf = oid => `user-${oid.slice(-2)}@example.test`;

(async () => {
  const good = await jose.generateKeyPair('RS256', { extractable: true });
  const publicJwk = { ...(await jose.exportJWK(good.publicKey)), kid: 'entra-key-1', use: 'sig', alg: 'RS256' };
  const mock = { tokens: [], verifiers: [], pending: null, redirect: null, idToken: null, me: null, oid: null };
  let issued = 0; const newToken = kind => { const t = `mock-${kind}-token-${++issued}-${crypto.randomBytes(6).toString('hex')}`; mock.tokens.push(t); return t; };
  const sign = async (claims = {}) => {
    const t = Math.floor(Date.now() / 1000);
    return new jose.SignJWT({ iss: `${process.env.M365_LOGIN_BASE}/${TENANT}/v2.0`, aud: CLIENT, tid: TENANT, oid: mock.oid, sub: 'pairwise', nonce: mock.pending.nonce, name: 'Fake User',
      preferred_username: mailOf(mock.oid), iat: t, nbf: t - 5, exp: t + 3600, ...claims }).setProtectedHeader({ alg: 'RS256', kid: 'entra-key-1', typ: 'JWT' }).sign(good.privateKey);
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
    const port = server.address().port; let base = `http://127.0.0.1:${port}`;
    let ipN = 0; const nextIp = () => `198.51.100.${(++ipN % 250) + 1}`;
    const call = async (m, u, b, ck = '', at = base) => { const r = await fetch(at + '/api/' + u, { method: m, redirect: 'manual', headers: { 'Content-Type': 'application/json', cookie: ck }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie') || ''; const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j, sc, t }; };
    const ok = (r, l) => { assert.equal(r.s, 200, `${l || ''} → ${r.s} ${String(r.t).slice(0, 300)}`); return r.j; };
    const sidOf = sc => (/(?:^|[ ,])sid=([a-f0-9]*)/.exec(sc || '') || [])[1];
    const pw = async (u, extra = {}, at = base) => { const r = await call('POST', 'login', { username: u, password: 'secret12', ...extra }, '', at); assert.equal(r.s, 200, 'password login ' + u + ' ' + r.t); return 'sid=' + sidOf(r.sc); };
    const nav = (u, ck = '', at = base) => fetch(at + u, { redirect: 'manual', headers: { cookie: ck, 'X-Forwarded-For': nextIp() } }).then(async r => ({ s: r.status, loc: r.headers.get('location') || '', setCookie: r.headers.get('set-cookie') || '', t: await r.text() }));
    const dbFile = path.join(process.env.DATA_DIR, 'erp.db');
    const q = (sql, ...a) => { const d = new DatabaseSync(dbFile, { readOnly: true }); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
    const exec = (sql, ...a) => { const d = new DatabaseSync(dbFile); try { return d.prepare(sql).run(...a); } finally { d.close(); } };
    const links = () => q('SELECT user_id, tenant_id, microsoft_user_id, email FROM m365_connections ORDER BY user_id');
    const audits = () => q("SELECT action, user, rec, detail FROM audit_log WHERE tbl='m365' ORDER BY id");
    const secrets = () => [...mock.tokens, CODE, SECRET, KEY, ...mock.verifiers];
    const noSecret = (text, where) => { for (const s of secrets()) assert.ok(!String(text).includes(s), `${where} must not contain a secret (${s.slice(0, 12)}…)`); };
    const play = (r, oid, { me, idToken } = {}) => {
      const p = new URL(r.loc).searchParams; mock.pending = { challenge: p.get('code_challenge'), nonce: p.get('nonce') }; mock.redirect = p.get('redirect_uri');
      mock.oid = oid; mock.me = me || null; mock.idToken = idToken || null; return p.get('state');
    };
    // link: the signed-in user `ck` connects the Microsoft account `oid` (Phase 1 flow)
    const link = async (ck, oid, opts = {}, at = base) => {
      const r = await nav('/auth/microsoft' + (opts.query || ''), ck, at); if (r.s !== 302) return r;
      const state = play(r, oid, opts), bind = (/m365_flow=([^;]+)/.exec(r.setCookie) || [])[1];
      const c = await nav(`/auth/microsoft/callback?code=${CODE}&state=${state}`, `m365_flow=${opts.bind || bind}`, at); mock.idToken = null; mock.me = null; return c;
    };
    // Microsoft sign-in with account `oid` from a signed-out browser (cookies `ck`)
    const sso = async (oid, opts = {}, at = base) => {
      const r = await nav('/auth/microsoft/login', opts.ck || '', at); assert.equal(r.s, 302, r.t);
      const state = play(r, oid, opts), bind = (/m365_login=([^;]+)/.exec(r.setCookie) || [])[1];
      const c = await nav(`/auth/microsoft/login/callback?code=${CODE}&state=${state}`, [opts.ck, `m365_login=${bind}`].filter(Boolean).join('; '), at); mock.idToken = null; mock.me = null;
      return { ...c, sid: sidOf(c.setCookie), state, bind };
    };
    const refused = async (label, r, re) => {
      assert.equal(r.s, 400, `${label}: expected a refusal, got ${r.s} ${r.t.slice(0, 200)}`); if (re) assert.match(r.t, re, label);
      assert.ok(!sidOf(r.setCookie), `${label}: no ERP session`); noSecret(r.t, label);
    };
    const id = u => q('SELECT id FROM users WHERE username=?', u)[0].id;

    try {
      // ---- set-up: ERP users of several roles, a project the site engineer is limited to ----
      ok(await call('POST', 'setup', { username: 'admin', password: 'secret12', company: 'Test Co' }));
      const admin = await pw('admin');
      for (const [u, role] of [['proc', 'procurement'], ['acc', 'accountant'], ['site', 'site_engineer'], ['acc2', 'accountant'], ['gone', 'viewer']]) ok(await call('POST', 'users', { username: u, password: 'secret12', role }, admin));
      const cl = ok(await call('POST', 'parties', { type: 'client', name: 'Client' }, admin)).id;
      const P1 = ok(await call('POST', 'projects', { name: 'Assigned project', client_id: cl, status: 'active' }, admin)).id;
      ok(await call('POST', 'projects', { name: 'Other project', client_id: cl, status: 'active' }, admin));
      ok(await call('PUT', 'users/' + id('site'), { projects: [P1] }, admin));
      Object.assign(process.env, { M365_ENABLED: '1', M365_TENANT_ID: TENANT, M365_CLIENT_ID: CLIENT, M365_CLIENT_SECRET: SECRET, M365_ENCRYPTION_KEY: KEY,
        M365_REDIRECT_URI: `${base}/auth/microsoft/callback`, M365_LOGIN_BASE: `http://127.0.0.1:${ms.address().port}`, M365_GRAPH_BASE: `http://127.0.0.1:${ms.address().port}/v1.0` });
      const ck = {}; for (const u of ['proc', 'acc', 'site', 'acc2', 'gone']) ck[u] = await pw(u);

      // ---- 1. an active non-admin user links their own Microsoft account ----
      const own = ok(await call('GET', 'm365/status', undefined, ck.proc));
      assert.deepEqual(Object.keys(own).sort(), ['available', 'configured', 'connection', 'enabled']); assert.equal(own.connection, null);
      const l1 = await link(ck.proc, OID.proc); assert.equal(l1.s, 302, l1.t); assert.equal(l1.loc, '/#settings');
      assert.deepEqual(links(), [{ user_id: id('proc'), tenant_id: TENANT, microsoft_user_id: OID.proc, email: mailOf(OID.proc) }]);
      const st1 = ok(await call('GET', 'm365/status', undefined, ck.proc));
      assert.deepEqual(Object.keys(st1.connection).sort(), ['display_name', 'email', 'linked_at'], 'the user sees e-mail / name / date, never tenant or object IDs');
      assert.ok(!JSON.stringify(st1).includes(OID.proc) && !JSON.stringify(st1).includes(TENANT));
      assert.ok(audits().some(a => a.action === 'connect' && a.user === 'proc'), 'linking is audited');
      console.log('✔ 1: a procurement user links their own Microsoft account (status shows no IDs; audited)');

      // ---- 2. nobody can link an identity to ANOTHER ERP user ----
      {
        const r = await nav(`/auth/microsoft?user_id=${id('acc')}&user=acc`, ck.site);                       // asking for another user in the request
        assert.equal(r.s, 302); assert.deepEqual(q('SELECT user_id FROM oauth_states').map(x => x.user_id), [id('site')], 'the flow is always for the signed-in user');
        exec('DELETE FROM oauth_states');
        const accStart = await nav('/auth/microsoft', ck.acc); const accState = new URL(accStart.loc).searchParams.get('state');
        const siteStart = await nav('/auth/microsoft', ck.site), siteBind = (/m365_flow=([^;]+)/.exec(siteStart.setCookie) || [])[1];
        mock.pending = { challenge: new URL(accStart.loc).searchParams.get('code_challenge'), nonce: new URL(accStart.loc).searchParams.get('nonce') }; mock.redirect = new URL(accStart.loc).searchParams.get('redirect_uri'); mock.oid = OID.site;
        const x = await nav(`/auth/microsoft/callback?code=${CODE}&state=${accState}`, `m365_flow=${siteBind}`);   // acc's flow finished in site's browser
        assert.equal(x.s, 400); assert.equal(links().length, 1, 'nothing linked to acc (or site)');
        exec('DELETE FROM oauth_states');
        for (const [m, u] of [['POST', 'm365/link'], ['POST', 'm365/connect'], ['PUT', 'm365/status']]) assert.equal((await call(m, u, { user_id: id('acc'), oid: OID.stranger }, ck.proc)).s, 404, `no API to link someone else (${m} ${u})`);
        assert.equal((await call('POST', 'users/' + id('acc'), { m365: OID.stranger }, ck.proc)).s, 403);
        assert.equal(links().length, 1);
      }
      console.log('✔ 2: a link is always for the signed-in user: no request parameter, other browser\'s flow or API can link another ERP user');

      // ---- 3–7. the linked procurement user signs in with Microsoft and is exactly the procurement user ----
      const s3 = await sso(OID.proc); assert.equal(s3.s, 302, s3.t); assert.equal(s3.loc, '/');
      const me3 = ok(await call('GET', 'status', undefined, `sid=${s3.sid}`)).user;
      assert.equal(me3.id, id('proc'), '4: the existing ERP user'); assert.equal(me3.role, 'procurement', '5: role unchanged');
      const probes = [['GET', 'users'], ['GET', 'audit'], ['GET', 'm365/status'], ['GET', 'purchase_orders'], ['GET', 'parties'], ['GET', 'payroll'], ['GET', 'invoices'], ['GET', 'financials?from=2000-01-01&to=2100-01-01'],
        ['GET', 'projects'], ['PUT', 'settings', { company_name: 'Hacked' }], ['POST', 'users', { username: 'x', password: 'secret12', role: 'admin' }], ['DELETE', 'users/' + id('acc')], ['GET', 'backup']];
      const procPw = await pw('proc');
      for (const [m, u, b] of probes) { const a = await call(m, u, b, `sid=${s3.sid}`), p = await call(m, u, b, procPw); assert.equal(a.s, p.s, `6: ${m} ${u}: same answer for Microsoft and password sessions`); assert.equal(JSON.stringify(a.j), JSON.stringify(p.j), `6: ${m} ${u}: same data`); }
      for (const [m, u, b] of [['GET', 'users'], ['GET', 'audit'], ['PUT', 'settings', { company_name: 'Hacked' }], ['POST', 'users', { username: 'x', password: 'secret12', role: 'admin' }], ['GET', 'backup']])
        assert.equal((await call(m, u, b, `sid=${s3.sid}`)).s, 403, `7: no admin rights: ${m} ${u}`);
      // Microsoft-side properties (roles, groups, admin directory roles, job title) are never read for ERP rights
      const s3b = await sso(OID.proc, { idToken: () => sign({ roles: ['Admin', 'GlobalAdmin'], groups: ['admins'], wids: ['62e90394-69f5-4237-9190-012177145e10'], jobTitle: 'Administrator' }), me: { id: OID.proc, mail: mailOf(OID.proc), displayName: 'Administrator', jobTitle: 'Administrator' } });
      assert.equal(s3b.s, 302); assert.equal(ok(await call('GET', 'status', undefined, `sid=${s3b.sid}`)).user.role, 'procurement'); assert.equal((await call('GET', 'users', undefined, `sid=${s3b.sid}`)).s, 403);
      // project scope: a site engineer sees only the assigned project, through either way in
      ok(await call('GET', 'status', undefined, ck.site)); assert.equal((await link(ck.site, OID.site)).s, 302);
      const s4 = await sso(OID.site); assert.equal(s4.s, 302);
      const viaMs = ok(await call('GET', 'projects', undefined, `sid=${s4.sid}`)), viaPw = ok(await call('GET', 'projects', undefined, ck.site));
      assert.deepEqual(viaMs.map(x => x.id), [P1], 'site engineer: assigned project only'); assert.deepEqual(viaMs, viaPw, 'same project list');
      console.log('✔ 3–7: linked non-admins sign in with Microsoft as the same ERP user and role; identical ACL / data / project scope; no admin rights, whatever Microsoft says about the account');

      // ---- 8–10. identity matching: tenant + object ID only ----
      await refused('8 same e-mail, other oid', await sso(OID.stranger, { idToken: () => sign({ preferred_username: mailOf(OID.proc), email: mailOf(OID.proc) }), me: { id: OID.stranger, mail: mailOf(OID.proc), userPrincipalName: mailOf(OID.proc), displayName: 'Fake User' } }), /not linked/);
      await refused('9a same oid, token from another tenant', await sso(OID.proc, { idToken: () => sign({ iss: `${process.env.M365_LOGIN_BASE}/${OTHER_TENANT}/v2.0`, tid: OTHER_TENANT }) }));
      await refused('9b same oid, other tid', await sso(OID.proc, { idToken: () => sign({ tid: OTHER_TENANT }) }), /another organisation/);
      exec('UPDATE m365_connections SET tenant_id=? WHERE user_id=?', OTHER_TENANT, id('proc'));
      await refused('9c linked in another tenant only', await sso(OID.proc), /not linked/);
      exec('UPDATE m365_connections SET tenant_id=? WHERE user_id=?', TENANT, id('proc'));
      await refused('10 unlinked', await sso(OID.stranger), /not linked/);
      assert.ok(audits().some(a => a.action === 'login-rejected' && a.detail.includes(`${OID.stranger} is not linked`)), 'unlinked: audited');
      console.log('✔ 8–10: same e-mail + other oid, same oid + other tenant, and unlinked accounts are refused (no e-mail fallback)');

      // ---- 11–12. disabled / deleted ----
      assert.equal((await link(ck.acc, OID.acc)).s, 302); assert.equal((await sso(OID.acc)).s, 302);
      exec('UPDATE users SET disabled=1 WHERE id=?', id('acc'));
      await refused('11 disabled', await sso(OID.acc), /disabled/);
      assert.ok(audits().some(a => a.action === 'login-rejected' && a.user === 'acc' && /disabled/.test(a.detail)), 'disabled: audited');
      exec('UPDATE users SET disabled=0 WHERE id=?', id('acc'));
      const ckGone = await pw('gone'); assert.equal((await link(ckGone, OID.gone)).s, 302);
      ok(await call('DELETE', 'users/' + id('gone'), undefined, admin));
      await refused('12 deleted', await sso(OID.gone), /not linked/);
      assert.ok(!links().some(l => l.microsoft_user_id === OID.gone), 'its link is gone with it');
      console.log('✔ 11–12: a disabled or deleted linked user is refused (audited)');

      // ---- 13–14. disconnect / reconnect ----
      const tokensBefore = q('SELECT access_token_encrypted a, refresh_token_encrypted r FROM m365_connections WHERE user_id=?', id('proc'))[0];
      assert.ok(tokensBefore.a && tokensBefore.r, 'the link holds (encrypted) tokens');
      const live = await sso(OID.proc); assert.equal(live.s, 302);
      assert.equal(ok(await call('POST', 'm365/disconnect', {}, ck.proc)).removed, 1);
      assert.equal(q('SELECT COUNT(*) n FROM m365_connections WHERE user_id=?', id('proc'))[0].n, 0, 'the link and its stored tokens are deleted');
      await refused('13 disconnected', await sso(OID.proc), /not linked/);
      assert.ok(audits().some(a => a.action === 'disconnect' && a.user === 'proc'), 'disconnect audited');
      assert.equal((await call('POST', 'login', { username: 'proc', password: 'secret12' })).s, 200, 'password sign-in still works after disconnect');
      assert.equal((await link(ck.proc, OID.proc)).s, 302); const back = await sso(OID.proc); assert.equal(back.s, 302, '14: reconnect restores Microsoft sign-in');
      assert.equal(ok(await call('GET', 'status', undefined, `sid=${back.sid}`)).user.id, id('proc'));
      console.log('✔ 13–14: disconnect removes the link and its tokens and stops Microsoft sign-in at once (password still works); reconnect restores it');

      // ---- 15. one Microsoft identity, one ERP user ----
      {
        const n = links().length, r = await link(ck.acc2, OID.proc);                      // acc2 tries to take proc's Microsoft account
        assert.equal(r.s, 400); assert.match(r.t, /already linked to another user/); assert.equal(links().length, n);
        assert.ok(!links().some(l => l.user_id === id('acc2')));
        assert.throws(() => exec('INSERT INTO m365_connections(user_id,tenant_id,microsoft_user_id,created_at,updated_at) VALUES(?,?,?,?,?)', id('acc2'), TENANT, OID.proc, 'x', 'x'), /UNIQUE/, 'the database refuses it too');
        const s = await sso(OID.proc); assert.equal(ok(await call('GET', 'status', undefined, `sid=${s.sid}`)).user.username, 'proc', 'still proc');
        // one ERP user, one Microsoft identity: linking another account replaces the old one (same row), the old one no longer signs in
        assert.equal((await link(ck.acc2, OID.acc2)).s, 302); assert.equal((await link(ck.acc2, OID.stranger)).s, 302);
        assert.deepEqual(links().filter(l => l.user_id === id('acc2')).map(l => l.microsoft_user_id), [OID.stranger]);
        await refused('replaced identity', await sso(OID.acc2), /not linked/);
        assert.equal((await link(ck.acc2, OID.acc2)).s, 302);
      }
      console.log('✔ 15: one Microsoft identity can be linked to one ERP user only (and an ERP user has at most one link)');

      // ---- 16–17. password login and the ERP two-step code on the password path ----
      for (const u of ['admin', 'proc', 'acc', 'site', 'acc2']) await pw(u);
      {
        const setup = ok(await call('POST', '2fa/setup', {}, ck.acc2)); ok(await call('POST', '2fa/enable', { code: TOTP.codeAt(setup.secret, TOTP.stepNow()) }, ck.acc2));
        const noCode = await call('POST', 'login', { username: 'acc2', password: 'secret12' }); assert.equal(noCode.s, 401); assert.equal(noCode.j.need_code, true, '17: the password path still asks the ERP code');
        assert.equal((await call('POST', 'login', { username: 'acc2', password: 'secret12', code: '000000' })).s, 401, '17: a wrong code is refused');
        const withCode = await call('POST', 'login', { username: 'acc2', password: 'secret12', code: TOTP.codeAt(setup.secret, TOTP.stepNow() + 1) }); assert.equal(withCode.s, 200, '17: the right code signs in ' + withCode.t);
        const viaMs = await sso(OID.acc2); assert.equal(viaMs.s, 302, 'Microsoft path: MFA is Entra\'s (no ERP code)');
      }
      console.log('✔ 16–17: password sign-in works for every user; the ERP two-step code still applies on the password path');

      // ---- 18. session fixation ----
      {
        const planted = await pw('site');
        const s = await sso(OID.proc, { ck: planted }); assert.equal(s.s, 302);
        assert.notEqual('sid=' + s.sid, planted, 'a new token'); assert.equal(q('SELECT COUNT(*) n FROM sessions WHERE token=?', planted.slice(4))[0].n, 0, 'the planted session is ended');
        assert.equal(ok(await call('GET', 'status', undefined, `sid=${s.sid}`)).user.username, 'proc');
        const made = 'sid=' + 'cd'.repeat(24), s2 = await sso(OID.proc, { ck: made }); assert.notEqual('sid=' + s2.sid, made);
      }
      console.log('✔ 18: Microsoft sign-in always issues a fresh session and ends a presented one');

      // ---- 19. state: single use, expires (sign-in and link) ----
      {
        const s = await sso(OID.proc); assert.equal(s.s, 302);
        await refused('replayed sign-in callback', await nav(`/auth/microsoft/login/callback?code=${CODE}&state=${s.state}`, `m365_login=${s.bind}`), /not known|already used/);
        const r = await nav('/auth/microsoft/login'); const state = play(r, OID.proc), bind = (/m365_login=([^;]+)/.exec(r.setCookie) || [])[1];
        exec('UPDATE oauth_login_states SET expires_at=?', new Date(Date.now() - 1000).toISOString());
        await refused('expired sign-in state', await nav(`/auth/microsoft/login/callback?code=${CODE}&state=${state}`, `m365_login=${bind}`), /expired/);
        const lr = await nav('/auth/microsoft', ck.acc); const ls = play(lr, OID.acc), lb = (/m365_flow=([^;]+)/.exec(lr.setCookie) || [])[1];
        exec('UPDATE oauth_states SET expires_at=?', new Date(Date.now() - 1000).toISOString());
        const le = await nav(`/auth/microsoft/callback?code=${CODE}&state=${ls}`, `m365_flow=${lb}`); assert.equal(le.s, 400); assert.match(le.t, /expired|not known/);
      }
      console.log('✔ 19: OAuth states (sign-in and link) are single use and expire');

      // ---- 20–21. no secrets anywhere; backup / restore keeps the identity links, never the tokens ----
      const dump = [JSON.stringify(q('SELECT * FROM audit_log')), JSON.stringify(q('SELECT * FROM error_log')), logged.join('\n'), JSON.stringify(q('SELECT * FROM sessions')), JSON.stringify(ok(await call('GET', 'm365/status', undefined, ck.proc))), JSON.stringify(ok(await call('GET', 'users', undefined, admin)))];
      dump.forEach((t, i) => noSecret(t, ['audit log', 'error log', 'console', 'sessions', 'status', 'users list'][i]));
      assert.ok(!dump[0].includes('access_token') && !dump[0].includes('refresh_token'), 'audit details carry no token fields');
      const usersList = ok(await call('GET', 'users', undefined, admin));
      assert.equal(usersList.find(u => u.username === 'proc').m365_linked, 1, 'admin sees that a user is linked'); assert.equal(usersList.find(u => u.username === 'admin').m365_linked, 0);
      assert.ok(!JSON.stringify(usersList).includes(OID.proc), 'but no object IDs');
      const bdir = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-sso-restore-')), bfile = path.join(bdir, 'erp.db');
      { const d = new DatabaseSync(dbFile); sanitizedCopy(d, bfile); d.close(); }
      { const b = new DatabaseSync(bfile, { readOnly: true });
        const rows = b.prepare('SELECT user_id, tenant_id, microsoft_user_id, access_token_encrypted, refresh_token_encrypted FROM m365_connections').all();
        assert.ok(rows.length >= 3, 'the identity links are in the backup'); assert.ok(rows.every(r => !r.access_token_encrypted && !r.refresh_token_encrypted), 'without any token');
        assert.equal(b.prepare('SELECT COUNT(*) n FROM oauth_login_states').get().n + b.prepare('SELECT COUNT(*) n FROM oauth_states').get().n, 0, 'and without sign-in states');
        b.close(); }
      noSecret(fs.readFileSync(bfile).toString('latin1'), 'backup file');
      // restore: a server started on the restored database signs proc in with Microsoft; "Check the link" asks to reconnect (no tokens)
      const rport = await new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
      const rbase = `http://127.0.0.1:${rport}`, env = { ...process.env, DATA_DIR: bdir, PORT: String(rport), HOST: '127.0.0.1', M365_REDIRECT_URI: `${rbase}/auth/microsoft/callback` };
      const child = cp.spawn(process.execPath, ['--no-warnings', 'server.js'], { cwd: __dirname, env, stdio: 'ignore' });
      try {
        for (let i = 0; ; i++) { try { if ((await fetch(rbase + '/api/status')).ok) break; } catch { /* starting */ } if (i > 80) throw new Error('restored server did not start'); await new Promise(r => setTimeout(r, 150)); }
        const rs = await sso(OID.proc, {}, rbase); assert.equal(rs.s, 302, '21: Microsoft sign-in works on the restored database ' + rs.t);
        assert.equal(ok(await call('GET', 'status', undefined, `sid=${rs.sid}`, rbase)).user.username, 'proc');
        const chk = await call('POST', 'm365/check', {}, `sid=${rs.sid}`, rbase); assert.equal(chk.s, 502); assert.match(chk.j.error, /renewed/, 'the link\'s Graph access needs a reconnect (tokens are never in backups)');
        await refused('21: unlinked on the restored database too', await sso(OID.stranger, {}, rbase), /not linked/);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          await new Promise(resolve => {
            child.once('exit', resolve);
            child.kill();
            setTimeout(resolve, 2000);
          });
        }
      }
      fs.rmSync(bdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      console.log('✔ 20–21: no code / token / secret / key / verifier in responses, logs, audit, users list or backups; a restored backup keeps the identity links (Microsoft sign-in works) but no tokens');

      // ---- 22. service worker ----
      {
        const on = {}, origin = 'https://erp.example.test';
        const sw = { self: { addEventListener: (t, f) => { on[t] = f; }, registration: { scope: origin + '/' }, clients: {} }, location: { origin }, URL, Response, Promise,
          caches: { match: async () => new Response('<cached app page>'), open: async () => ({ match: async () => null, put() {} }), keys: async () => [] }, fetch: async () => new Response('network') };
        vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'public', 'sw.js'), 'utf8'), sw);
        const taken = (p, mode) => { let r = false; on.fetch({ request: { method: 'GET', mode, url: origin + p }, respondWith() { r = true; } }); return r; };
        for (const p of ['/auth/microsoft', '/auth/microsoft/callback?code=x&state=y', '/auth/microsoft/login', '/auth/microsoft/login/callback?code=x&state=y'])
          for (const mode of ['navigate', 'no-cors', 'same-origin']) assert.equal(taken(p, mode), false, `${p} (${mode})`);
        assert.equal(taken('/', 'navigate'), true, 'control');
      }
      console.log('✔ 22: the service worker never intercepts /auth/microsoft, /callback, /login or /login/callback');

      console.log('\nSSO ALL-USERS TESTS PASSED');
    } catch (err) { console.error('FAIL', err); process.exitCode = 1; }
    finally { server.close(); ms.close(); setTimeout(() => process.exit(process.exitCode || 0), 100); }
  });
})();
