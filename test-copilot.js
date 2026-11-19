// Copilot API: deterministic read-only routing, explicit projections, shared ERP authorization and local mocks only.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert'), http = require('http');
const jose = require('jose');
const { DatabaseSync } = require('node:sqlite');
const { sanitizedCopy } = require('./lib/backupsafe');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-copilot-'));
process.env.ZOHO_NO_SCHEDULER = '1'; process.env.SALES_NO_SCHEDULER = '1'; process.env.BACKUP_NO_SCHEDULER = '1';
for (const k of Object.keys(process.env)) if (k.startsWith('COPILOT_')) delete process.env[k];
delete process.env.M365_CLIENT_ID;
const { server, ctx } = require('./server.js');

const TENANT = '11111111-2222-3333-4444-555555555555', OID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const LOGIN_APP = 'login-app-client-id', API_AUDIENCE = 'api://trigon-copilot-test';
let keyPair;
const mock = { calls: [], jwksCalls: 0 };
const mockServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === `/${TENANT}/discovery/v2.0/keys`) {
      mock.jwksCalls++;
      res.end(JSON.stringify({ keys: [mock.jwk] })); return;
    }
    if (req.url.startsWith('/openai/deployments/test-model/chat/completions?')) {
      mock.calls.push({ headers: req.headers, body: JSON.parse(body) });
      res.end(JSON.stringify({ choices: [{ message: { content: 'Mocked authorized answer' } }] })); return;
    }
    res.statusCode = 404; res.end('{}');
  });
});

(async () => {
  keyPair = await jose.generateKeyPair('RS256', { extractable: true });
  mock.jwk = { ...(await jose.exportJWK(keyPair.publicKey)), kid: 'local-key', use: 'sig', alg: 'RS256' };
  await new Promise(resolve => mockServer.listen(0, '127.0.0.1', resolve));
  server.listen(0, async () => {
    const origin = `http://127.0.0.1:${server.address().port}`, mockOrigin = `http://127.0.0.1:${mockServer.address().port}`;
    const cookies = {};
    const call = async (method, url, body, cookie = '', token = '', raw = false) => {
      const headers = { 'Content-Type': 'application/json' };
      if (cookie) headers.cookie = cookie;
      if (token) headers.authorization = `Bearer ${token}`;
      const response = await fetch(origin + '/api/' + url, {
        method, headers, body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
      });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookies.last = setCookie.split(';')[0];
      const text = await response.text(); let json;
      try { json = JSON.parse(text); } catch { json = text; }
      return { status: response.status, json, text };
    };
    const login = async (username, password = 'secret12') => {
      const response = await fetch(origin + '/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
      });
      assert.equal(response.status, 200, `login ${username}`);
      return response.headers.get('set-cookie').split(';')[0];
    };
    const sign = async ({ aud = API_AUDIENCE, tid = TENANT, oid = OID, scp = 'Copilot.Read', exp = Math.floor(Date.now() / 1000) + 3600, key = keyPair.privateKey } = {}) => {
      return new jose.SignJWT({ tid, oid, scp, iat: Math.floor(Date.now() / 1000), exp })
        .setProtectedHeader({ alg: 'RS256', kid: 'local-key' })
        .setIssuer(`${mockOrigin}/${TENANT}/v2.0`).setAudience(aud).sign(key);
    };
    try {
      assert.equal((await call('POST', 'copilot/ask', { question: 'projects' })).status, 404, 'disabled by default');
      assert.equal((await call('GET', 'copilot/history', undefined, '', 'not-a-token')).status, 404);
      assert.equal(mock.calls.length, 0, 'disabled Copilot never contacts a provider');
      assert.equal((await call('POST', 'setup', { username: 'admin', password: 'secret12', company: 'Test' })).status, 200);
      const admin = cookies.last, adminId = ctx.db.prepare("SELECT id FROM users WHERE username='admin'").get().id;
      await call('PUT', 'settings', { trn: '100123456700003' }, admin);
      const client = (await call('POST', 'parties', { type: 'client', name: 'Fake Client' }, admin)).json.id;
      const projectId = (await call('POST', 'projects', { name: 'Sample Build', code: 'P-TEST', location: 'Abu Dhabi', client_id: client, contract_value: 250000 }, admin)).json.id;
      const invoiceId = (await call('POST', 'invoices', { project_id: projectId, items: [{ description: 'Test work', qty: 1, rate: 1000 }] }, admin)).json.id;
      assert.ok(invoiceId);
      assert.equal((await call('POST', 'variations', { project_id: projectId, description: 'Fake approved change', amount: 5000, status: 'approved' }, admin)).status, 200);
      for (const [username, role] of [['manager1', 'manager'], ['site1', 'site_engineer'], ['viewer1', 'viewer'], ['manager2', 'manager']]) {
        assert.equal((await call('POST', 'users', { username, password: 'secret12', role }, admin)).status, 200);
      }
      const manager = await login('manager1'), site = await login('site1'), viewer = await login('viewer1'), manager2 = await login('manager2');
      ctx.db.prepare('INSERT INTO user_projects(user_id,project_id) VALUES(?,?)')
        .run(ctx.db.prepare("SELECT id FROM users WHERE username='site1'").get().id, projectId);

      process.env.COPILOT_ENABLED = '1';
      assert.equal((await call('POST', 'copilot/ask', { question: 'projects' }, admin)).status, 403, 'empty allowlists grant nobody access');
      process.env.COPILOT_ALLOWED_ROLES = 'manager,site_engineer';
      assert.equal((await call('POST', 'copilot/ask', { question: 'projects' }, site)).status, 503, 'missing provider configuration fails closed');
      process.env.COPILOT_PROVIDER = 'azure-openai';
      process.env.COPILOT_AZURE_ENDPOINT = mockOrigin;
      process.env.COPILOT_AZURE_DEPLOYMENT = 'test-model';
      process.env.COPILOT_AZURE_API_VERSION = '2024-10-21';
      process.env.COPILOT_AZURE_API_KEY = 'fake-local-api-key';

      process.env.COPILOT_ALLOWED_ROLES = '';
      process.env.COPILOT_ALLOWED_USERS = String(adminId);
      assert.equal((await call('POST', 'copilot/ask', { question: 'projects' }, admin)).status, 200, 'explicit ERP user ID can be allowlisted');
      assert.equal((await call('POST', 'copilot/ask', { question: 'projects' }, manager)).status, 403, 'user-ID allowlisting does not admit other users');
      delete process.env.COPILOT_ALLOWED_USERS;
      process.env.COPILOT_ALLOWED_ROLES = 'manager,site_engineer';
      assert.equal((await call('POST', 'copilot/ask', { question: 'projects' }, viewer)).status, 403, 'direct API/deep-link is checked independently of UI');
      assert.equal((await call('POST', 'copilot/ask', { question: 'project profit' }, site)).status, 403, 'ERP resource ACL blocks financial tool for site role');
      const settings = await call('POST', 'copilot/ask', { question: 'project status' }, site);
      assert.equal(settings.status, 200); assert.equal(settings.json.intent, 'project_status');
      assert.equal(settings.json.data[0].name, 'Sample Build');
      const beforeSameQuestion = mock.calls.length;
      assert.equal((await call('POST', 'copilot/ask', { question: 'projects' }, manager)).status, 200);
      assert.equal((await call('POST', 'copilot/ask', { question: 'projects' }, site)).status, 200);
      assert.equal(mock.calls.length, beforeSameQuestion + 2, 'identical questions from different ERP users are not cached');
      assert.equal((await call('POST', 'copilot/ask', { question: 'ملخص المشاريع' }, manager)).status, 200, 'Arabic deterministic routing');
      assert.equal((await call('POST', 'copilot/ask', { question: 'invoice summary' }, manager)).json.intent, 'invoice_summary');
      const financialAnswer = await call('POST', 'copilot/ask', { question: 'project profit' }, manager);
      assert.equal(financialAnswer.json.intent, 'project_financials');
      assert.equal(financialAnswer.json.data.find(x => x.id === projectId).contract_value, 250000);
      assert.equal(financialAnswer.json.data.find(x => x.id === projectId).revised_contract_value, 255000, 'original and revised contract values are distinct');
      assert.equal(mock.calls[0].headers['api-key'], 'fake-local-api-key');

      // A new sensitive column must remain absent even when the underlying projects row contains it.
      ctx.db.exec('ALTER TABLE projects ADD COLUMN copilot_test_secret TEXT');
      ctx.db.prepare('UPDATE projects SET copilot_test_secret=? WHERE id=?').run('never-send-this-sensitive-column', projectId);
      const projected = await call('POST', 'copilot/ask', { question: 'projects status' }, manager);
      assert.equal(projected.status, 200);
      assert.ok(!JSON.stringify(projected.json).includes('never-send-this-sensitive-column'));
      assert.ok(!JSON.stringify(mock.calls.at(-1).body).includes('copilot_test_secret'));
      assert.ok(!JSON.stringify(mock.calls.at(-1).body).includes('never-send-this-sensitive-column'));
      for (const question of ['project profit', 'invoice summary']) {
        const answer = await call('POST', 'copilot/ask', { question }, manager);
        assert.equal(answer.status, 200);
        assert.ok(!JSON.stringify(answer.json).includes('never-send-this-sensitive-column'));
        assert.ok(!JSON.stringify(mock.calls.at(-1).body).includes('never-send-this-sensitive-column'));
      }

      // The result cap is enforced by the tool, independently of whatever the provider returns.
      for (let i = 0; i < 55; i++) ctx.db.prepare('INSERT INTO projects(code,name,status) VALUES(?,?,?)').run(`P-${i}`, `Fake Project ${i}`, 'active');
      const capped = await call('POST', 'copilot/ask', { question: 'projects' }, manager);
      assert.equal(capped.json.data.length, 50);

      const managerHistory = (await call('GET', 'copilot/history', undefined, manager)).json;
      const siteHistory = (await call('GET', 'copilot/history', undefined, site)).json;
      assert.ok(managerHistory.length > 0 && siteHistory.length > 0);
      assert.ok(managerHistory.every(x => x.question !== 'project status'), 'history is isolated by ERP user');
      const backupFile = path.join(process.env.DATA_DIR, 'copilot-backup.db');
      sanitizedCopy(ctx.db, backupFile);
      const backup = new DatabaseSync(backupFile, { readOnly: true });
      assert.equal(backup.prepare('SELECT COUNT(*) n FROM copilot_history').get().n, 0, 'backups never retain Copilot history');
      backup.close();
      assert.ok((await call('GET', 'copilot/history', undefined, site)).json.length > 0, 'backup sanitization leaves live history intact');
      ctx.db.prepare('INSERT INTO copilot_history(user_id,question,answer,created_at) VALUES(?,?,?,?)').run(
        ctx.db.prepare("SELECT id FROM users WHERE username='manager1'").get().id, 'expired fake question', 'old answer', Date.now() - 31 * 864e5,
      );
      await call('GET', 'copilot/history', undefined, manager);
      assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM copilot_history WHERE question='expired fake question'").get().n, 0, 'history older than 30 days is pruned');
      assert.equal((await call('DELETE', 'copilot/history', undefined, manager)).status, 200);
      assert.equal((await call('GET', 'copilot/history', undefined, manager)).json.length, 0, 'user can clear own history');
      assert.ok((await call('GET', 'copilot/history', undefined, site)).json.length > 0, 'clear never deletes another user history');

      assert.equal((await call('POST', 'copilot/ask', { question: 'x'.repeat(1001) }, manager)).status, 400, 'question character limit');
      assert.equal((await call('POST', 'copilot/ask', JSON.stringify({ question: 'x'.repeat(17000) }), manager, '', true)).status, 413, 'request byte limit');
      assert.equal((await call('POST', 'copilot/ask', { question: 'tell me a joke' }, manager)).status, 422, 'unsupported intent does not reach provider');

      // The same mapped ERP identity and shared feature authorization apply to Entra bearer tokens.
      process.env.M365_CLIENT_ID = LOGIN_APP;
      process.env.COPILOT_ENTRA_TENANT_ID = TENANT;
      process.env.COPILOT_ENTRA_API_AUDIENCE = API_AUDIENCE;
      process.env.COPILOT_ENTRA_ISSUER = `${mockOrigin}/${TENANT}/v2.0`;
      process.env.COPILOT_ENTRA_JWKS_URL = `${mockOrigin}/${TENANT}/discovery/v2.0/keys`;
      const managerId = ctx.db.prepare("SELECT id FROM users WHERE username='manager1'").get().id;
      ctx.db.prepare(`INSERT INTO m365_connections(user_id,tenant_id,microsoft_user_id,created_at,updated_at)
        VALUES(?,?,?,?,?)`).run(managerId, TENANT, OID, new Date().toISOString(), new Date().toISOString());
      const validBearer = await sign();
      assert.equal((await call('POST', 'copilot/ask', { question: 'projects' }, '', validBearer)).status, 401, 'Entra bearer path is disabled by default');
      process.env.COPILOT_ENTRA_ENABLED = '1';
      assert.equal((await call('POST', 'copilot/ask', { question: 'projects' }, '', validBearer)).status, 200);
      assert.ok(mock.jwksCalls > 0, 'local JWKS signature verification ran');
      assert.equal((await call('POST', 'copilot/ask', { question: 'projects' }, '', await sign({ aud: LOGIN_APP }))).status, 401, 'login app audience is not accepted');
      assert.equal((await call('POST', 'copilot/ask', { question: 'projects' }, '', await sign({ aud: [API_AUDIENCE, LOGIN_APP] }))).status, 401, 'an audience array containing the login app is rejected');
      assert.equal((await call('POST', 'copilot/ask', { question: 'projects' }, '', await sign({ scp: 'User.Read' }))).status, 401, 'required API scope is enforced');
      assert.equal((await call('POST', 'copilot/ask', { question: 'projects' }, '', await sign({ tid: '99999999-2222-3333-4444-555555555555' }))).status, 401, 'tenant is enforced');
      assert.equal((await call('POST', 'copilot/ask', { question: 'projects' }, '', await sign({ exp: Math.floor(Date.now() / 1000) - 60 }))).status, 401, 'expired access token is refused');
      const attackerKey = await jose.generateKeyPair('RS256', { extractable: true });
      assert.equal((await call('POST', 'copilot/ask', { question: 'projects' }, '', await sign({ key: attackerKey.privateKey }))).status, 401, 'forged signature is refused');
      process.env.COPILOT_ALLOWED_ROLES = '';
      process.env.COPILOT_ALLOWED_USERS = '';
      assert.equal((await call('POST', 'copilot/ask', { question: 'projects' }, manager)).status, 403);
      assert.equal((await call('POST', 'copilot/ask', { question: 'projects' }, '', validBearer)).status, 403, 'session and bearer identities share the same allowlist check');

      // The per-user cap is 20/minute and is independent for each ERP user.
      process.env.COPILOT_ALLOWED_ROLES = 'manager';
      for (let i = 0; i < 20; i++) assert.equal((await call('POST', 'copilot/ask', { question: 'projects' }, manager2)).status, 200);
      assert.equal((await call('POST', 'copilot/ask', { question: 'projects' }, manager2)).status, 429);

      // Round-robin identities hit the global 200/minute cap before any one reaches its per-user cap.
      const globalCookies = [];
      for (let i = 0; i < 9; i++) {
        const username = `global${i}`;
        assert.equal((await call('POST', 'users', { username, password: 'secret12', role: 'manager' }, admin)).status, 200);
        globalCookies.push(await login(username));
      }
      const counts = Array(globalCookies.length).fill(0);
      let globalLimited = false;
      for (let round = 0; round < 20 && !globalLimited; round++) {
        for (let i = 0; i < globalCookies.length; i++) {
          const status = (await call('POST', 'copilot/ask', { question: 'projects' }, globalCookies[i])).status;
          if (status === 429) {
            assert.ok(counts[i] < 20, 'the global cap, not the per-user cap, refused this request');
            globalLimited = true; break;
          }
          assert.equal(status, 200); counts[i]++;
        }
      }
      assert.equal(globalLimited, true, 'global 200/minute cap is enforced');
      console.log('COPILOT TESTS PASSED');
    } catch (e) {
      console.error('FAIL', e); process.exitCode = 1;
    } finally {
      server.close(); mockServer.close();
      setTimeout(() => process.exit(process.exitCode || 0), 100);
    }
  });
})().catch(e => { console.error('FAIL', e); process.exitCode = 1; });
