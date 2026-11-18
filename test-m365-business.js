// Microsoft 365 business integration: Graph foundation, SharePoint documents, the purchase-order workflow, Outlook, Teams, ACL.
//   node --no-warnings test-m365-business.js
// Local mocks of Entra (token endpoint incl. client credentials, JWKS), Graph (/me, /me/sendMail, /sites, /drives, file upload) and a Teams
// webhook; RS256-signed id_tokens; the PDF engine is replaced by a deterministic fake. Fake identities and data only; no internet.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert'), http = require('http'), crypto = require('crypto');
const jose = require('jose');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-m365biz-'));
process.env.ZOHO_NO_SCHEDULER = '1'; process.env.SALES_NO_SCHEDULER = '1'; process.env.BACKUP_NO_SCHEDULER = '1';
for (const k of Object.keys(process.env)) if (k.startsWith('M365_') || k.startsWith('AUTH_')) delete process.env[k];
process.env.TRUST_PROXY = '1'; delete process.env.SECURE_COOKIES;
process.env.M365_SYNC_NO_WORKER = '1';          // the automatic SharePoint queue is tested in test-m365-sync.js; here only the manual paths run

const logged = [];
for (const m of ['log', 'error', 'warn', 'info']) { const o = console[m].bind(console); console[m] = (...a) => { logged.push(a.map(x => (x && x.stack) || String(x)).join(' ')); o(...a); }; }

const { server, ctx } = require('./server.js');
const { DatabaseSync } = require('node:sqlite');
const { sanitizedCopy } = require('./lib/backupsafe');
const G = require('./lib/m365graph');
const TENANT = '11111111-2222-3333-4444-555555555555', CLIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', SECRET = 'test-client-secret-NOT-REAL-biz';
const SITE = 'contoso.sharepoint.com,0f0f0f0f-1111-2222-3333-444444444444,5e5e5e5e-1111-2222-3333-444444444444', DRIVE = 'b!FakeDriveId_ForTests-123';
const OID = { proc: '0c0c0c0c-0000-4000-8000-000000000001', acc: '0c0c0c0c-0000-4000-8000-000000000002', admin: '0c0c0c0c-0000-4000-8000-000000000003', site: '0c0c0c0c-0000-4000-8000-000000000004' };
const KEY = crypto.randomBytes(32).toString('base64'), CODE = 'mock-auth-code-BIZ', TEAMS_SIG = 'SIGNATURE-SECRET-not-real-91';
const BASE_LINK = 'openid profile email offline_access User.Read';

// the PDF engine (Chrome) is not needed: a deterministic fake of the same HTML
ctx.pdf = async html => Buffer.from(`%PDF-1.4\n% fake ${crypto.createHash('sha256').update(String(html)).digest('hex')}\n%%EOF\n`);

(async () => {
  const good = await jose.generateKeyPair('RS256', { extractable: true });
  const publicJwk = { ...(await jose.exportJWK(good.publicKey)), kid: 'k1', use: 'sig', alg: 'RS256' };
  const mock = { tokens: new Map(), appTokens: [], refreshCalls: [], puts: [], mails: [], teams: [], pending: null, redirect: null, oid: null, grant: BASE_LINK,
    revoked: false, putMode: 'ok', putFailTimes: 0, mailFail: false, teamsFail: false, siteMode: 'ok', slowMs: 0, clientCredCalls: 0 };
  let n = 0; const tok = (kind, owner, scopes) => { const t = `mock-${kind}-${++n}-${crypto.randomBytes(6).toString('hex')}`; mock.tokens.set(t, { kind, owner, scopes }); return t; };
  const sign = async () => { const t = Math.floor(Date.now() / 1000); return new jose.SignJWT({ iss: `${process.env.M365_LOGIN_BASE}/${TENANT}/v2.0`, aud: CLIENT, tid: TENANT, oid: mock.oid, sub: 's', nonce: mock.pending.nonce, iat: t, nbf: t - 5, exp: t + 3600 }).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).sign(good.privateKey); };
  const bearer = rq => mock.tokens.get((rq.headers.authorization || '').replace(/^Bearer /, ''));
  const ms = http.createServer((rq, rs) => { const chunks = []; rq.on('data', c => chunks.push(c)); rq.on('end', async () => {
    const body = Buffer.concat(chunks), out = (code, j, raw) => { rs.writeHead(code, { 'Content-Type': 'application/json' }); rs.end(raw !== undefined ? raw : JSON.stringify(j)); };
    const u = new URL(rq.url, 'http://x');
    if (u.pathname === `/${TENANT}/discovery/v2.0/keys`) return out(200, { keys: [publicJwk] });
    if (u.pathname === `/${TENANT}/oauth2/v2.0/token`) {
      const f = new URLSearchParams(body.toString());
      if (f.get('client_id') !== CLIENT || f.get('client_secret') !== SECRET) return out(401, { error: 'invalid_client' });
      if (f.get('grant_type') === 'client_credentials') { mock.clientCredCalls++; if (f.get('scope') !== 'https://graph.microsoft.com/.default') return out(400, { error: 'invalid_scope' }); const t = tok('app', 'app', ['Sites.Selected']); mock.appTokens.push(t); return out(200, { token_type: 'Bearer', expires_in: 3600, access_token: t }); }
      if (f.get('grant_type') === 'authorization_code') {
        const st = mock.pending; if (!st || f.get('code') !== CODE || crypto.createHash('sha256').update(f.get('code_verifier') || '').digest('base64url') !== st.challenge) return out(400, { error: 'invalid_grant' });
        const scopes = f.get('scope').split(' ').filter(s => !['openid', 'profile', 'email', 'offline_access'].includes(s));
        return out(200, { token_type: 'Bearer', expires_in: 3600, scope: f.get('scope').split(' ').map(s => /^[A-Z]/.test(s) ? 'https://graph.microsoft.com/' + s : s).join(' '), access_token: tok('access', mock.oid, scopes), refresh_token: tok('refresh', mock.oid, scopes), id_token: await sign() });
      }
      if (f.get('grant_type') === 'refresh_token') {
        mock.refreshCalls.push(f.get('scope')); const r = mock.tokens.get(f.get('refresh_token'));
        if (mock.revoked || !r || r.kind !== 'refresh') return out(400, { error: 'invalid_grant' });
        return out(200, { token_type: 'Bearer', expires_in: 3600, access_token: tok('access', r.owner, r.scopes) });
      }
      return out(400, { error: 'unsupported_grant_type' });
    }
    if (u.pathname.startsWith('/v1.0/')) {
      const who = bearer(rq), p = u.pathname.slice(5);
      if (mock.slowMs) await new Promise(r => setTimeout(r, mock.slowMs));
      if (p === '/me' && rq.method === 'GET') return who && who.kind === 'access' ? out(200, { id: who.owner, mail: `user-${who.owner.slice(-2)}@example.test`, displayName: 'Fake User' }) : out(401, {});
      if (p === '/me/sendMail' && rq.method === 'POST') {
        if (!who || who.kind !== 'access') return out(401, {}); if (!who.scopes.includes('Mail.Send')) return out(403, {});
        if (mock.mailFail) return out(500, {}); mock.mails.push({ owner: who.owner, body: JSON.parse(body.toString()) }); rs.writeHead(202); return rs.end();
      }
      if (!who || who.kind !== 'app') return out(401, {});
      if (p === `/sites/${encodeURIComponent(SITE)}` && rq.method === 'GET') return mock.siteMode === 'forbidden' ? out(403, {}) : out(200, { id: SITE, displayName: 'Trigon Projects (test)', webUrl: 'https://contoso.sharepoint.com/sites/trigon' });
      if (p === `/drives/${encodeURIComponent(DRIVE)}` && rq.method === 'GET') return out(200, { id: DRIVE, name: 'ERP Documents', driveType: 'documentLibrary' });
      const put = /^\/drives\/([^/]+)\/root:\/(.+):\/content$/.exec(p);
      if (put && rq.method === 'PUT') {
        if (decodeURIComponent(put[1]) !== DRIVE) return out(404, {});
        const filePath = put[2].split('/').map(decodeURIComponent);
        if (mock.putFailTimes > 0) { mock.putFailTimes--; return out(503, {}); }
        if (mock.putMode === '403') return out(403, {}); if (mock.putMode === '404') return out(404, {}); if (mock.putMode === '503') return out(503, {});
        if (mock.putMode === 'garbage') return out(200, null, '<html>not json'); if (mock.putMode === 'noid') return out(200, { name: 'x' });
        mock.puts.push({ filePath, conflict: u.searchParams.get('@microsoft.graph.conflictBehavior'), body, type: rq.headers['content-type'] });
        const id = '01ITEM' + crypto.createHash('sha1').update(filePath.join('/')).digest('hex').slice(0, 20).toUpperCase();
        return out(200, { id, name: filePath[filePath.length - 1], size: body.length, webUrl: mock.webUrl || `https://contoso.sharepoint.com/sites/trigon/ERP%20Documents/${filePath.map(encodeURIComponent).join('/')}` });
      }
      return out(404, {});
    }
    if (u.pathname === '/teams/hook' && rq.method === 'POST') {
      if (u.searchParams.get('sig') !== TEAMS_SIG) return out(401, {});
      if (mock.teamsFail) return out(500, {}); mock.teams.push(JSON.parse(body.toString())); rs.writeHead(202); return rs.end();
    }
    out(404, {});
  }); });

  server.listen(0, async () => {
    await new Promise(r => ms.listen(0, r));
    const port = server.address().port, base = `http://127.0.0.1:${port}`, mport = ms.address().port;
    let ip = 0; const xff = () => `198.51.100.${(++ip % 250) + 1}`;
    const call = async (m, u, b, ck = '') => { const r = await fetch(base + '/api/' + u, { method: m, headers: { 'Content-Type': 'application/json', cookie: ck, 'X-Forwarded-For': xff() }, body: b ? JSON.stringify(b) : undefined }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j, t, sc: r.headers.get('set-cookie') || '', ct: r.headers.get('content-type') || '' }; };
    const ok = (r, l) => { assert.equal(r.s, 200, `${l || ''} → ${r.s} ${String(r.t).slice(0, 300)}`); return r.j; };
    const login = async u => { const r = await call('POST', 'login', { username: u, password: 'secret12' }); assert.equal(r.s, 200, u); return 'sid=' + /sid=([a-f0-9]+)/.exec(r.sc)[1]; };
    const nav = (u, ck = '') => fetch(base + u, { redirect: 'manual', headers: { cookie: ck, 'X-Forwarded-For': xff() } }).then(async r => ({ s: r.status, loc: r.headers.get('location') || '', setCookie: r.headers.get('set-cookie') || '', t: await r.text() }));
    const dbFile = path.join(process.env.DATA_DIR, 'erp.db');
    const q = (sql, ...a) => { const d = new DatabaseSync(dbFile, { readOnly: true }); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
    const exec = (sql, ...a) => { const d = new DatabaseSync(dbFile); try { return d.prepare(sql).run(...a); } finally { d.close(); } };
    const link = async (ck, oid) => {
      const r = await nav('/auth/microsoft', ck); assert.equal(r.s, 302, r.t); const p = new URL(r.loc).searchParams;
      mock.pending = { challenge: p.get('code_challenge'), nonce: p.get('nonce') }; mock.redirect = p.get('redirect_uri'); mock.oid = oid;
      const c = await nav(`/auth/microsoft/callback?code=${CODE}&state=${p.get('state')}`, `m365_flow=${(/m365_flow=([^;]+)/.exec(r.setCookie) || [])[1]}`); assert.equal(c.s, 302, c.t);
      return p.get('scope');
    };
    const poRow = id => q('SELECT * FROM purchase_orders WHERE id=?', id)[0];
    const docs = () => q('SELECT * FROM m365_documents ORDER BY id');
    const upload = (entity, id, ck) => call('POST', `m365/documents/${entity}/${id}/upload`, {}, ck);
    const secrets = () => [...mock.tokens.keys(), CODE, SECRET, KEY, TEAMS_SIG];
    const noSecret = (text, where) => { for (const s of secrets()) assert.ok(!String(text).includes(s), `${where} must not contain a secret (${s.slice(0, 14)}…)`); };
    const audits = () => q("SELECT action, user, detail FROM audit_log WHERE tbl='m365' ORDER BY id");
    const within = (p, ms, what) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`${what}: no answer within ${ms} ms (timeout handling broken?)`)), ms))]);

    try {
      // ---- set-up: users, project, supplier, purchase orders, quotation, invoice; Microsoft 365 configured against the mocks ----
      ok(await call('POST', 'setup', { username: 'admin', password: 'secret12', company: 'Test Co' }));
      const admin = await login('admin');
      for (const [u, role] of [['proc', 'procurement'], ['acc', 'accountant'], ['site', 'site_engineer'], ['viewer', 'viewer'], ['store', 'storekeeper']]) ok(await call('POST', 'users', { username: u, password: 'secret12', role }, admin));
      const cl = ok(await call('POST', 'parties', { type: 'client', name: 'Client' }, admin)).id;
      const sup = ok(await call('POST', 'parties', { type: 'supplier', name: '../../Evil: Supplier*', email: 'supplier@example.test' }, admin)).id;
      const P1 = ok(await call('POST', 'projects', { name: 'Villa', code: 'P-101', client_id: cl, status: 'active' }, admin)).id;
      const P2 = ok(await call('POST', 'projects', { name: 'Tower', code: '../../etc/P-202', client_id: cl, status: 'active' }, admin)).id;
      ok(await call('PUT', 'users/' + q("SELECT id FROM users WHERE username='site'")[0].id, { projects: [P1] }, admin));
      ok(await call('PUT', 'settings', { po_approval_limit: 10000, trn: '100123456700003' }, admin));
      const mkPo = async (project, status, rate = 100) => ok(await call('POST', 'purchase_orders', { party_id: sup, project_id: project, status, items: [{ description: 'Rebar', unit: 't', qty: 1, rate }], vat_pct: 5 }, admin)).id;
      const poDraft = await mkPo(P1, 'draft'), poSent = await mkPo(P1, 'sent'), poOther = await mkPo(P2, 'sent'), poBig = await mkPo(P1, 'draft', 50000), poCancel = await mkPo(P1, 'cancelled');
      const quote = ok(await call('POST', 'quotes', { client_id: cl, project_name: 'Villa', status: 'sent', items: [{ description: 'Works', qty: 1, rate: 1000 }] }, admin)).id;
      const qDraft = ok(await call('POST', 'quotes', { client_id: cl, project_name: 'Villa', status: 'draft', items: [{ description: 'Works', qty: 1, rate: 10 }] }, admin)).id;
      const inv = ok(await call('POST', 'invoices', { project_id: P1, items: [{ description: 'Works', qty: 1, rate: 1000 }] }, admin)).id;
      Object.assign(process.env, { M365_ENABLED: '1', M365_TENANT_ID: TENANT, M365_CLIENT_ID: CLIENT, M365_CLIENT_SECRET: SECRET, M365_ENCRYPTION_KEY: KEY, M365_REDIRECT_URI: `${base}/auth/microsoft/callback`,
        M365_LOGIN_BASE: `http://127.0.0.1:${mport}`, M365_GRAPH_BASE: `http://127.0.0.1:${mport}/v1.0`, M365_GRAPH_TIMEOUT_MS: '3000' });
      // acc links BEFORE Outlook is switched on (no Mail.Send); then Outlook on, proc and admin link (with Mail.Send)
      const ck = { proc: await login('proc'), acc: await login('acc'), site: await login('site'), viewer: await login('viewer'), store: await login('store') };
      assert.equal(await link(ck.acc, OID.acc), BASE_LINK, 'Outlook off: the link asks no Mail.Send');
      process.env.M365_OUTLOOK_ENABLED = '1';
      assert.equal(await link(ck.proc, OID.proc), BASE_LINK + ' Mail.Send', 'Outlook on: the link asks Mail.Send (incremental consent)');
      await link(admin, OID.admin);
      assert.deepEqual(q("SELECT u.username, c.scopes FROM m365_connections c JOIN users u ON u.id=c.user_id ORDER BY u.username").map(r => [r.username, r.scopes]),
        [['acc', 'openid profile email offline_access User.Read'], ['admin', 'openid profile email offline_access User.Read Mail.Send'], ['proc', 'openid profile email offline_access User.Read Mail.Send']], 'granted scopes stored (names only) ' + JSON.stringify(q('SELECT user_id, scopes FROM m365_connections')));
      Object.assign(process.env, { M365_SHAREPOINT_ENABLED: '1', M365_SHAREPOINT_SITE_ID: SITE, M365_SHAREPOINT_DRIVE_ID: DRIVE,
        M365_TEAMS_WEBHOOK_URL: `http://127.0.0.1:${mport}/teams/hook?sig=${TEAMS_SIG}`, M365_TEAMS_EXTRA_HOSTS: '127.0.0.1' });
      console.log('✔ set-up: link asks Mail.Send only when Outlook is on; granted scopes recorded per link');

      // ================= Graph foundation =================
      { // helpers: IDs, names, links, webhook hosts
        assert.equal(G.validSiteId(SITE), true); assert.equal(G.validSiteId('../x'), false); assert.equal(G.validDriveId(DRIVE), true); assert.equal(G.validDriveId('a/b'), false); assert.equal(G.validDriveId('..%2f'), false);
        assert.throws(() => G.seg('../../me/sendMail', G.validDriveId), /Invalid Microsoft 365 identifier/);
        for (const [i, o] of [['../../etc/passwd', 'etc-passwd'], ['a/b\\c:d*e?f"g<h>i|j#k%l', 'a-b-c-d-e-f-g-h-i-j-k-l'], ['..', 'document'], ['  .hidden  ', 'hidden'], ['CON', '_CON'], ['report.pdf', 'report.pdf'], ['x'.repeat(300) + '.pdf', 'x'.repeat(116) + '.pdf']])
          assert.equal(G.safeName(i), o, `safeName(${i.slice(0, 20)})`);
        assert.deepEqual(G.safePath(['Trigon Civil Projects', '../../etc/P-202', '..']), ['Trigon Civil Projects', 'etc-P-202', '_']);
        assert.equal(G.safeWebUrl('https://contoso.sharepoint.com/a'), 'https://contoso.sharepoint.com/a'); for (const bad of ['http://contoso.sharepoint.com/a', 'https://evil.example/a', 'https://contoso.sharepoint.com.evil.example/', 'javascript:alert(1)', 'https://u:p@contoso.sharepoint.com/']) assert.equal(G.safeWebUrl(bad), null, bad);
        for (const good of ['https://prod-01.westeurope.logic.azure.com/workflows/x', 'https://contoso.webhook.office.com/webhookb2/x', 'https://abc.environment.api.powerplatform.com/x']) assert.equal(G.teamsUrlOk(good), true, good);
        for (const bad of ['http://prod-01.westeurope.logic.azure.com/x', 'https://evil.example/x', 'https://logic.azure.com.evil.example/x', 'https://u:p@x.webhook.office.com/x', 'https://x.webhook.office.com:8443/x', 'http://127.0.0.1/x', 'file:///etc/passwd']) assert.equal(G.teamsUrlOk(bad), false, bad);
        assert.equal(G.teamsUrlOk('http://127.0.0.1:9/x', ['127.0.0.1']), true, 'a local mock only when named explicitly');
      }
      // token refresh (expired access token) with exactly the granted scopes; revoked refresh token fails closed
      exec("UPDATE m365_connections SET expires_at='2000-01-01T00:00:00.000Z' WHERE user_id=(SELECT id FROM users WHERE username='proc')");
      const t1 = await call('POST', 'm365/outlook/test', {}, ck.proc); assert.equal(t1.s, 200, t1.t); assert.equal(t1.j.can_send, true);
      assert.equal(mock.refreshCalls.at(-1), 'openid profile email offline_access User.Read Mail.Send', 'refresh asks exactly the granted scopes');
      exec("UPDATE m365_connections SET expires_at='2000-01-01T00:00:00.000Z' WHERE user_id=(SELECT id FROM users WHERE username='acc')");
      ok(await call('POST', 'm365/check', {}, ck.acc)); assert.equal(mock.refreshCalls.at(-1), BASE_LINK, 'a link made without Mail.Send keeps refreshing without it');
      mock.revoked = true; exec("UPDATE m365_connections SET expires_at='2000-01-01T00:00:00.000Z' WHERE user_id=(SELECT id FROM users WHERE username='proc')");
      const rv = await call('POST', 'm365/outlook/test', {}, ck.proc); assert.equal(rv.s, 502); assert.match(rv.j.error, /renewed/); noSecret(rv.t, 'revoked answer');
      mock.revoked = false; exec("UPDATE m365_connections SET expires_at='2000-01-01T00:00:00.000Z' WHERE user_id=(SELECT id FROM users WHERE username='proc')");
      ok(await call('POST', 'm365/outlook/test', {}, ck.proc));
      console.log('✔ Graph: expired token refreshed with the granted scopes; revoked token fails closed (safe message)');

      // ================= SharePoint =================
      let st = ok(await call('GET', 'm365/integrations', undefined, admin));
      assert.equal(st.sharepoint.configured, true); assert.equal(st.outlook.enabled, true); assert.equal(st.teams.destination_ok, true); assert.equal(st.teams.amounts_shown, false);
      noSecret(JSON.stringify(st), 'integrations (admin)'); assert.ok(!JSON.stringify(st).includes(TEAMS_SIG) && !JSON.stringify(st).includes('/teams/hook'), 'the webhook URL is never shown');
      const stUser = ok(await call('GET', 'm365/integrations', undefined, ck.viewer)); assert.deepEqual(Object.keys(stUser).sort(), ['me', 'outlook', 'sharepoint', 'teams']); assert.ok(!('missing' in stUser.sharepoint) && !('destination_host' in stUser.teams), 'users see no configuration');
      const tst = ok(await call('POST', 'm365/sharepoint/test', {}, admin)); assert.deepEqual([tst.site_name, tst.library_name], ['Trigon Projects (test)', 'ERP Documents']);
      assert.equal((await call('POST', 'm365/sharepoint/test', {}, ck.proc)).s, 403, 'SharePoint test: administrators only');
      // purchase orders: draft / cancelled / above the limit and not approved are refused; nothing goes to SharePoint
      for (const [id, re] of [[poDraft, /draft is not/], [poCancel, /cancelled/]]) { const r = await upload('purchase_orders', id, ck.proc); assert.equal(r.s, 409, r.t); assert.match(r.j.error, re); }
      ok(await call('PUT', 'purchase_orders/' + poBig, { ...poRow(poBig), items: JSON.parse(poRow(poBig).items), status: 'draft' }, admin));
      exec("UPDATE purchase_orders SET status='sent' WHERE id=?", poBig);                                   // issued without the approval (e.g. older data)
      { const r = await upload('purchase_orders', poBig, ck.proc); assert.equal(r.s, 409); assert.match(r.j.error, /above the approval limit/); }
      assert.equal(mock.puts.length, 0, 'nothing uploaded so far');
      // the issued PO: the ERP's own PDF, to <root>/<project>/Purchase Orders/<number>.pdf, as the application, replace (versioned)
      const before = JSON.stringify(poRow(poSent));
      const u1 = ok(await upload('purchase_orders', poSent, ck.proc), 'upload issued PO');
      const put1 = mock.puts.at(-1), number = poRow(poSent).number;
      assert.deepEqual(put1.filePath, ['Trigon Civil Projects', 'P-101 - Villa', 'Purchase Orders', `${number}.pdf`]); assert.equal(put1.conflict, 'replace'); assert.equal(put1.type, 'application/pdf');
      const expectPdf = await ctx.pdf(ctx.renderPage('purchase_orders', poSent, { role: 'admin', username: 'x', id: 0 }).html);
      assert.ok(put1.body.equals(expectPdf), 'the uploaded file is the ERP\'s own PDF of the order');
      assert.equal(u1.status, 'uploaded'); assert.match(u1.web_url, /^https:\/\/contoso\.sharepoint\.com\//); assert.equal(u1.uploaded_by, 'proc');
      const d1 = docs()[0]; assert.equal(d1.entity, 'purchase_orders'); assert.equal(d1.site_id, SITE); assert.equal(d1.drive_id, DRIVE); assert.match(d1.item_id, /^01ITEM/); assert.equal(d1.sha256, crypto.createHash('sha256').update(expectPdf).digest('hex'));
      assert.equal(JSON.stringify(poRow(poSent)), before, 'the PO itself is unchanged (number, totals, status)');
      assert.ok(audits().some(a => a.action === 'sharepoint-upload' && a.user === 'proc' && a.detail.includes(number)));
      // idempotency: unchanged content is not sent again; a change is uploaded to the same file (new version)
      const again = ok(await upload('purchase_orders', poSent, ck.proc)); assert.equal(again.unchanged, true); assert.equal(mock.puts.length, 1, 'unchanged: no second upload');
      exec("UPDATE purchase_orders SET notes='Updated delivery note' WHERE id=?", poSent); ok(await upload('purchase_orders', poSent, ck.proc));
      assert.equal(mock.puts.length, 2); assert.deepEqual(mock.puts[1].filePath, put1.filePath, 'same file (SharePoint keeps the versions)'); assert.equal(docs().filter(d => d.entity === 'purchase_orders' && d.entity_id === poSent).length, 1, 'one mapping row');
      // concurrent upload refused
      exec("UPDATE m365_documents SET status='uploading', updated_at=? WHERE entity='purchase_orders' AND entity_id=?", new Date().toISOString(), poSent);
      { const r = await upload('purchase_orders', poSent, ck.proc); assert.equal(r.s, 409); assert.match(r.j.error, /being uploaded/); }
      exec("UPDATE m365_documents SET status='uploaded' WHERE entity='purchase_orders' AND entity_id=?", poSent);
      // the PO page's existing PDF still works and is the same file
      { const r = await fetch(`${base}/api/doc/purchase_orders/${poSent}/pdf`, { headers: { cookie: admin } }); assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /pdf/); }
      console.log('✔ SharePoint / PO: draft, cancelled and unapproved-above-limit refused; issued PO uploaded as the ERP PDF to <root>/<project>/Purchase Orders/; mapping saved; PO unchanged; unchanged content not re-sent; updates go to the same file; concurrent upload refused; the PDF route still works');

      // failures: the ERP record stays as it was; status "failed" with a safe reason; Retry works
      const poF = await mkPo(P1, 'sent'), beforeF = JSON.stringify(poRow(poF));
      for (const [mode, re] of [['503', /unavailable/], ['403', /permission/], ['404', /Not found/], ['garbage', /unreadable/], ['noid', /did not confirm/]]) {
        mock.putMode = mode; const r = await upload('purchase_orders', poF, ck.proc);
        assert.equal(r.s, 502, `${mode}: ${r.t}`); assert.match(r.j.error, re, mode); noSecret(r.t, mode);
        const d = docs().find(x => x.entity_id === poF && x.entity === 'purchase_orders'); assert.equal(d.status, 'failed'); assert.match(d.error, re);
        assert.equal(JSON.stringify(poRow(poF)), beforeF, `${mode}: the PO is unchanged`);
      }
      mock.putMode = 'ok'; mock.putFailTimes = 2;                                          // two 503s, then fine: retried automatically (idempotent PUT)
      const rr = ok(await upload('purchase_orders', poF, ck.proc), 'Retry'); assert.equal(rr.status, 'uploaded'); assert.ok(docs().find(x => x.entity_id === poF).attempts >= 6);
      assert.ok(audits().some(a => a.action === 'sharepoint-upload-failed'));
      // timeout: Graph slower than M365_GRAPH_TIMEOUT_MS → a clear failure, not a hang
      process.env.M365_GRAPH_TIMEOUT_MS = '250'; mock.slowMs = 1500; const poT = await mkPo(P1, 'sent');
      { const r = await within(upload('purchase_orders', poT, ck.proc), 9000, 'upload'); assert.equal(r.s, 502); assert.match(r.j.error, /did not answer in time/); }
      mock.slowMs = 0; process.env.M365_GRAPH_TIMEOUT_MS = '3000';
      // bad destination: invalid IDs are never sent to Graph
      process.env.M365_SHAREPOINT_DRIVE_ID = '../../me/sendMail';
      { const r = await upload('purchase_orders', poT, ck.proc); assert.equal(r.s, 503); assert.match(r.j.error, /M365_SHAREPOINT_DRIVE_ID/); }
      process.env.M365_SHAREPOINT_DRIVE_ID = DRIVE;
      // invalid file: empty or too large
      const realPdf = ctx.pdf; ctx.pdf = async () => Buffer.alloc(0);
      { const r = await upload('purchase_orders', poT, ck.proc); assert.equal(r.s, 503); assert.match(r.j.error, /PDF/); }
      ctx.pdf = async () => Buffer.alloc(60 * 1024 * 1024 + 1, 65);      // above 4 MB an upload session is used (test-m365-sync.js); above 60 MB nothing is sent
      { const before = mock.puts.length, r = await upload('purchase_orders', poT, ck.proc); assert.equal(r.s, 413); assert.match(r.j.error, /larger than 60 MB/); assert.equal(mock.puts.length, before); }
      ctx.pdf = realPdf;
      console.log('✔ SharePoint failures (503 / 403 / 404 / unreadable / no item id / timeout / bad library ID / empty / too large) leave the PO unchanged, record "failed" with a safe reason; retry succeeds');

      // other records and attachments; path traversal in names
      ok(await upload('quotes', quote, admin)); { const r = await upload('quotes', qDraft, admin); assert.equal(r.status === undefined && r.s, 409); }
      ok(await upload('invoices', inv, ck.acc)); assert.deepEqual(mock.puts.at(-1).filePath.slice(1, 3), ['P-101 - Villa', 'Invoices']);
      ok(await upload('purchase_orders', poOther, admin)); assert.deepEqual(mock.puts.at(-1).filePath.slice(0, 3), ['Trigon Civil Projects', 'etc-P-202 - Tower', 'Purchase Orders'], 'a project code with ../ becomes a plain folder name');
      const att = ok(await call('POST', 'documents', { entity: 'party', entity_id: sup, name: '..\\..\\..\\Windows\\evil.pdf', category: 'Licence', data: 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4 licence').toString('base64') }, admin)).id;
      ok(await call('POST', `m365/attachments/${att}/upload`, {}, admin));
      const ap = mock.puts.at(-1).filePath; assert.deepEqual(ap.slice(0, 4), ['Trigon Civil Projects', 'Suppliers', 'Evil- Supplier-', 'Supplier Documents']); assert.match(ap[4], /Windows.evil\.pdf$/); assert.ok(!ap[4].startsWith('.'), 'no leading dots');
      for (const p of mock.puts) for (const s of p.filePath) { assert.ok(!['.', '..'].includes(s) && !/[\\/]/.test(s), `no traversal in "${s}"`); }
      assert.equal(q('SELECT COUNT(*) n FROM documents WHERE id=?', att)[0].n, 1, 'the ERP attachment stays');
      console.log('✔ quotations (not drafts), invoices, attachments uploaded; names with ../, \\, : , * sanitised; the attachment stays in the ERP');

      // ACL: the integration never gives more than the ERP role / project scope
      for (const [who, entity, id, code] of [['viewer', 'purchase_orders', poSent, 403], ['store', 'purchase_orders', poSent, 403], ['site', 'purchase_orders', poSent, 403], ['proc', 'invoices', inv, 403], ['viewer', 'invoices', inv, 403], ['site', 'quotes', quote, 403]]) {
        const r = await upload(entity, id, ck[who]); assert.equal(r.s, code, `${who} upload ${entity}: ${r.t}`);
      }
      assert.equal((await call('GET', `m365/documents/purchase_orders/${poOther}`, undefined, ck.site)).s, 403, 'site engineer: no PO rights at all');
      { exec("INSERT INTO user_projects VALUES((SELECT id FROM users WHERE username='store'),?)", P1); }
      assert.equal((await call('GET', `m365/documents/purchase_orders/${poSent}`, undefined, ck.store)).s, 200, 'storekeeper may see the PO status');
      assert.equal((await call('POST', `m365/attachments/${att}/upload`, {}, ck.viewer)).s, 403, 'attachments: the documents rule');
      // project scope: a site engineer may copy attachments of the assigned project only
      const mkAtt = async (pid, nm) => ok(await call('POST', 'documents', { entity: 'project', entity_id: pid, name: nm, category: 'Site Photos', data: 'data:application/pdf;base64,' + Buffer.from('%PDF ' + nm).toString('base64') }, admin)).id;
      const attMine = await mkAtt(P1, 'site photo 1.pdf'), attOther = await mkAtt(P2, 'other project.pdf');
      ok(await call('POST', `m365/attachments/${attMine}/upload`, {}, ck.site), 'site engineer: own project');
      { const r = await call('POST', `m365/attachments/${attOther}/upload`, {}, ck.site); assert.equal(r.s, 404, 'site engineer: another project is not even visible'); }
      { const r = await call('GET', `m365/attachments/${attOther}`, undefined, ck.site); assert.equal(r.s, 404); }
      for (const p of ['m365/teams/test', 'm365/teams/overdue', 'm365/migrate', 'm365/sharepoint/test']) assert.equal((await call('POST', p, {}, ck.proc)).s, 403, `${p}: admin only`);
      assert.equal((await call('POST', 'm365/documents/users/1/upload', {}, admin)).s, 404, 'only the supported record types');
      assert.equal((await call('POST', 'm365/documents/purchase_orders/1;DROP/upload', {}, admin)).s, 404);
      console.log('✔ ACL: viewer / storekeeper / site engineer / procurement cannot upload what they cannot edit; admin-only tools; unknown record types refused');

      // ================= Outlook =================
      const send1 = await call('POST', `m365/mail/purchase_orders/${poSent}`, { to: 'supplier@example.test', message: 'Please confirm.' }, ck.proc);
      assert.equal(send1.s, 200, send1.t); assert.equal(send1.j.attachment, 'pdf');
      const mail = mock.mails.at(-1); assert.equal(mail.owner, OID.proc, 'sent as the signed-in user (their own delegated token)');
      assert.deepEqual(mail.body.message.toRecipients, [{ emailAddress: { address: 'supplier@example.test' } }]); assert.ok(!('from' in mail.body.message) && !('sender' in mail.body.message), 'no From / Sender');
      assert.equal(mail.body.message.attachments.length, 1); assert.equal(mail.body.message.attachments[0].name, `${number}.pdf`);
      assert.ok(Buffer.from(mail.body.message.attachments[0].contentBytes, 'base64').equals(await ctx.pdf(ctx.renderPage('purchase_orders', poSent, { role: 'admin', username: 'x', id: 0 }).html)), 'the attachment is this record\'s PDF');
      assert.ok(audits().some(a => a.action === 'outlook-send' && a.user === 'proc'));
      // repeat send needs a confirmation
      const rep = await call('POST', `m365/mail/purchase_orders/${poSent}`, { to: 'supplier@example.test' }, ck.proc); assert.equal(rep.s, 409); assert.equal(rep.j.code, 'already_sent'); assert.equal(rep.j.need_confirm, true);
      assert.equal(mock.mails.length, 1, 'not sent twice');
      ok(await call('POST', `m365/mail/purchase_orders/${poSent}`, { to: 'supplier@example.test', confirm_resend: true }, ck.proc)); assert.equal(mock.mails.length, 2);
      // the sender can never be chosen; attachments cannot be injected
      for (const b of [{ to: 'a@example.test', from: 'ceo@example.test' }, { to: 'a@example.test', sender: 'ceo@example.test' }]) { const r = await call('POST', `m365/mail/purchase_orders/${poSent}`, b, ck.proc); assert.equal(r.s, 400); assert.match(r.j.error, /always your own/); }
      ok(await call('POST', `m365/mail/purchase_orders/${poSent}`, { to: 'other@example.test', attachments: [{ name: 'evil.exe', contentBytes: 'TVqQ' }], attach: true, url: 'http://169.254.169.254/' }, ck.proc));
      assert.deepEqual(mock.mails.at(-1).body.message.attachments.map(a => a.name), [`${number}.pdf`], 'only the record\'s own PDF');
      // recipients validated
      for (const to of ['', 'not-an-email', 'a@b.c,d@e.f,g@h.i,j@k.l,m@n.o,p@q.r', 'x@example.test\nBcc: y@example.test']) { const r = await call('POST', `m365/mail/purchase_orders/${poSent}`, { to }, ck.proc); assert.equal(r.s, 400, `to=${JSON.stringify(to)}`); }
      // who may send: ERP rights, a link with Mail.Send, a record they may see
      { const r = await call('POST', `m365/mail/purchase_orders/${poSent}`, { to: 'a@example.test' }, ck.acc); assert.equal(r.s, 409); assert.equal(r.j.code, 'consent_required', 'linked without Mail.Send → reconnect'); }
      { const r = await call('POST', `m365/mail/purchase_orders/${poSent}`, { to: 'a@example.test' }, ck.viewer); assert.equal(r.s, 403); }
      { const r = await call('POST', `m365/mail/invoices/${inv}`, { to: 'a@example.test' }, ck.proc); assert.equal(r.s, 403, 'procurement cannot send invoices'); }
      { const r = await call('POST', `m365/mail/purchase_orders/${poBig}`, { to: 'a@example.test' }, ck.proc); assert.equal(r.s, 409); assert.match(r.j.error, /approval limit/); }
      { const r = await call('POST', `m365/mail/purchase_orders/${poCancel}`, { to: 'a@example.test' }, ck.proc); assert.equal(r.s, 409); }
      exec("DELETE FROM m365_connections WHERE user_id=(SELECT id FROM users WHERE username='proc')");
      { const r = await call('POST', `m365/mail/purchase_orders/${poSent}`, { to: 'b@example.test' }, ck.proc); assert.equal(r.s, 409); assert.equal(r.j.code, 'unlinked'); }
      await link(ck.proc, OID.proc);
      // Graph send failure: logged, the PO unchanged
      mock.mailFail = true; const bS = JSON.stringify(poRow(poSent));
      { const r = await call('POST', `m365/mail/purchase_orders/${poSent}`, { to: 'c@example.test' }, ck.proc); assert.equal(r.s, 502); noSecret(r.t, 'send failure'); }
      mock.mailFail = false; assert.equal(JSON.stringify(poRow(poSent)), bS);
      assert.equal(q("SELECT status FROM m365_mail_log WHERE recipients='c@example.test'")[0].status, 'failed'); assert.ok(audits().some(a => a.action === 'outlook-send-failed'));
      // RFQ and quotation; Outlook switched off
      const rfq = ok(await call('POST', 'rfqs', { project_id: P1, description: 'Steel', items: [{ description: 'Rebar', unit: 't', qty: 5 }] }, admin)).id;
      ok(await call('POST', `m365/mail/rfqs/${rfq}`, { to: 'supplier@example.test' }, ck.proc)); assert.equal(mock.mails.at(-1).body.message.attachments.length, 0, 'RFQ: no printed form, text only');
      ok(await call('POST', `m365/mail/quotes/${quote}`, { to: 'client@example.test' }, admin));
      process.env.M365_OUTLOOK_ENABLED = '0'; { const r = await call('POST', `m365/mail/purchase_orders/${poSent}`, { to: 'z@example.test' }, ck.proc); assert.equal(r.s, 503); } process.env.M365_OUTLOOK_ENABLED = '1';
      const mlog = ok(await call('GET', `m365/mail/purchase_orders/${poSent}`, undefined, ck.proc)); assert.ok(mlog.length >= 3 && mlog.every(x => !('error' in x) || x.error === null || typeof x.error === 'string'));
      console.log('✔ Outlook: sent from the user\'s own mailbox with the record\'s PDF; repeat needs confirmation; no From / Sender / injected attachments; recipients validated; ERP rights, Mail.Send consent, link and approval state enforced; Graph failure logged, PO unchanged; RFQ / quotation; switch off');

      // ================= Teams =================
      mock.teams.length = 0;
      exec("UPDATE purchase_orders SET status='draft' WHERE id=?", poBig); exec("DELETE FROM spend_approvals WHERE kind='po' AND ref_id=?", poBig);   // (an administrator saving it would count as approving it)
      const req1 = ok(await call('POST', 'spend-approvals', { kind: 'po', ref_id: poBig }, ck.proc)).id;
      await new Promise(r => setTimeout(r, 300));
      const card1 = mock.teams.at(-1).attachments[0].content, facts1 = Object.fromEntries(card1.body[1].facts.map(f => [f.title, f.value]));
      assert.match(card1.body[0].text, /Approval needed: purchase order/); assert.equal(facts1['Purchase order'], poRow(poBig).number); assert.equal(facts1.Project, 'Villa'); assert.equal(facts1.Supplier, '../../Evil: Supplier*');
      assert.ok(!('Amount' in facts1), 'no amount: not allowed for this destination'); assert.ok(!JSON.stringify(card1).includes('50,000') && !JSON.stringify(card1).includes('52,500'));
      assert.equal(card1.actions[0].url, `${base}/#spend`, 'the deep link uses the registered ERP address');
      ok(await call('PUT', 'spend-approvals/' + req1, { status: 'approved' }, admin)); await new Promise(r => setTimeout(r, 300));
      const card2 = mock.teams.at(-1).attachments[0].content; assert.match(card2.body[0].text, /approved/); assert.equal(card2.actions[0].url, `${base}/#po/${poBig}`);
      // amounts only when allowed for the destination
      process.env.M365_TEAMS_INCLUDE_AMOUNTS = '1'; ok(await call('POST', 'm365/teams/test', {}, admin));
      exec("UPDATE purchase_orders SET status='draft' WHERE id=?", poBig); exec("DELETE FROM spend_approvals WHERE kind='po' AND ref_id=?", poBig); const req2 = ok(await call('POST', 'spend-approvals', { kind: 'po', ref_id: poBig }, ck.proc)).id; await new Promise(r => setTimeout(r, 300));
      assert.ok(mock.teams.at(-1).attachments[0].content.body[1].facts.some(f => f.title === 'Amount' && /52,500\.00/.test(f.value)), 'amount shown when allowed');
      process.env.M365_TEAMS_INCLUDE_AMOUNTS = '0'; void req2;
      // overdue POs
      exec("UPDATE purchase_orders SET delivery_date='2000-01-01' WHERE id=?", poSent); const ov = ok(await call('POST', 'm365/teams/overdue', {}, admin)); assert.ok(ov.count >= 1);
      assert.match(mock.teams.at(-1).attachments[0].content.body[0].text, /past the delivery date/);
      // invalid destinations are never called
      const nT = mock.teams.length;
      for (const bad of ['https://evil.example/hook', `http://127.0.0.1:${mport}/teams/hook?sig=${TEAMS_SIG}#x`, 'https://x.webhook.office.com.evil.example/hook']) {
        process.env.M365_TEAMS_WEBHOOK_URL = bad; const r = await call('POST', 'm365/teams/test', {}, admin); assert.equal(r.s, 503, bad); assert.equal(r.j.code, 'bad_destination');
      }
      process.env.M365_TEAMS_EXTRA_HOSTS = ''; process.env.M365_TEAMS_WEBHOOK_URL = `http://127.0.0.1:${mport}/teams/hook?sig=${TEAMS_SIG}`;
      { const r = await call('POST', 'm365/teams/test', {}, admin); assert.equal(r.s, 503, 'a local address is not a Microsoft webhook unless named explicitly'); }
      process.env.M365_TEAMS_EXTRA_HOSTS = '127.0.0.1'; assert.equal(mock.teams.length, nT, 'nothing posted to invalid destinations');
      // a Teams failure never blocks the ERP action
      mock.teamsFail = true; exec("UPDATE purchase_orders SET status='draft' WHERE id=?", poBig); exec("DELETE FROM spend_approvals WHERE kind='po' AND ref_id=?", poBig);
      ok(await call('POST', 'spend-approvals', { kind: 'po', ref_id: poBig }, ck.proc), 'the approval request succeeds although Teams fails'); await new Promise(r => setTimeout(r, 300));
      assert.ok(q("SELECT ok FROM m365_teams_log ORDER BY id DESC LIMIT 1")[0].ok === 0, 'the failure is logged'); mock.teamsFail = false;
      { const r = await call('POST', 'm365/teams/test', {}, ck.proc); assert.equal(r.s, 403, 'test: administrators only'); }
      console.log('✔ Teams: approval needed / approved / overdue cards with number, project, supplier, action and an ERP link; no amounts unless allowed; invalid / look-alike / local destinations never called; a Teams failure never blocks the ERP; admin-only tests');

      // ================= migration (dry run never uploads; execute resumes and never deletes) =================
      const att2 = ok(await call('POST', 'documents', { entity: 'project', entity_id: P1, name: 'drawing A-101.pdf', category: 'Drawings', data: 'data:application/pdf;base64,' + Buffer.from('%PDF drawing').toString('base64') }, admin)).id;
      const nP = mock.puts.length, dry = ok(await call('POST', 'm365/migrate', { execute: false }, admin)); assert.equal(dry.execute, false); assert.ok(dry.planned >= 1); assert.equal(mock.puts.length, nP, 'dry run uploads nothing');
      const run1 = ok(await call('POST', 'm365/migrate', { execute: true }, admin)); assert.equal(run1.failed.length, 0); assert.ok(run1.uploaded >= 1);
      assert.deepEqual(mock.puts.at(-1).filePath, ['Trigon Civil Projects', 'P-101 - Villa', 'Drawings', 'drawing A-101.pdf']);
      const run2 = ok(await call('POST', 'm365/migrate', { execute: true }, admin)); assert.equal(run2.uploaded, 0, 'resume: nothing twice'); assert.ok(run2.unchanged >= 2);
      assert.equal(q('SELECT COUNT(*) n FROM documents WHERE id IN (?,?)', att, att2)[0].n, 2, 'sources never deleted');
      console.log('✔ migration: dry run uploads nothing; execute uploads, resumes without duplicates, never deletes the ERP files');

      // ================= no secrets anywhere =================
      {
        const everything = [JSON.stringify(q('SELECT * FROM audit_log')), JSON.stringify(q('SELECT * FROM error_log')), logged.join('\n'), JSON.stringify(q('SELECT * FROM m365_documents')), JSON.stringify(q('SELECT * FROM m365_mail_log')),
          JSON.stringify(q('SELECT * FROM m365_teams_log')), JSON.stringify(q("SELECT * FROM settings WHERE key LIKE 'm365%'")), JSON.stringify(ok(await call('GET', 'm365/integrations', undefined, admin)))];
        everything.forEach((t, i) => noSecret(t, ['audit', 'error log', 'console', 'documents', 'mail log', 'teams log', 'settings', 'integrations'][i]));
        for (const t of everything) assert.ok(!t.includes('/teams/hook'), 'webhook URL not stored / shown');
        const bfile = path.join(process.env.DATA_DIR, 'b.db'); { const d = new DatabaseSync(dbFile); sanitizedCopy(d, bfile); d.close(); }
        const raw = fs.readFileSync(bfile).toString('latin1'); for (const s of secrets()) assert.ok(!raw.includes(s), 'backup: no secret');
      }
      console.log('✔ no token, code, client secret, key or webhook URL in responses, logs, audit, mapping / log tables, settings or backups');

      console.log('\nM365 BUSINESS TESTS PASSED');
    } catch (err) { console.error('FAIL', err); process.exitCode = 1; }
    finally { server.close(); ms.close(); setTimeout(() => process.exit(process.exitCode || 0), 100); }
  });
})();
