// Copilot API: deterministic read-only routing, explicit projections, shared ERP authorization and local mocks only.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert'), http = require('http');
const jose = require('jose');
const { DatabaseSync } = require('node:sqlite');
const { sanitizedCopy } = require('./lib/backupsafe');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-copilot-'));
process.env.ZOHO_NO_SCHEDULER = '1'; process.env.SALES_NO_SCHEDULER = '1'; process.env.BACKUP_NO_SCHEDULER = '1';
process.env.NODE_ENV = 'test';
for (const k of Object.keys(process.env)) if (k.startsWith('COPILOT_')) delete process.env[k];
delete process.env.M365_CLIENT_ID;
const { server, ctx } = require('./server.js');

const TENANT = '11111111-2222-3333-4444-555555555555', OID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const LOGIN_APP = 'login-app-client-id', API_AUDIENCE = 'api://trigon-copilot-test';
let keyPair;
const mock = { calls: [], jwksCalls: 0, redirectCalls: 0 };
const mockServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === `/${TENANT}/discovery/v2.0/keys`) {
      mock.jwksCalls++;
      res.end(JSON.stringify({ keys: [mock.jwk] })); return;
    }
    if (req.url === '/capture') {
      mock.redirectCalls++;
      res.end('{}'); return;
    }
    if (req.url.startsWith('/openai/deployments/test-model/chat/completions?')) {
      mock.calls.push({ headers: req.headers, body: JSON.parse(body) });
      if (mock.redirectProvider) { res.statusCode = 302; res.setHeader('Location', '/capture'); res.end(); return; }
      if (mock.failProvider) { res.statusCode = 503; res.end('fake private provider error'); return; }
      if (mock.delayProvider) {
        setTimeout(() => { if (!res.destroyed) res.end(JSON.stringify({ choices: [{ message: { content: 'Delayed mock answer' } }] })); }, mock.delayProvider);
        return;
      }
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
      return { status: response.status, json, text, headers: response.headers };
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
      assert.equal((await call('GET', 'copilot/status')).status, 404, 'status stays hidden while the feature is disabled');
      assert.equal(mock.calls.length, 0, 'disabled Copilot never contacts a provider');
      assert.equal((await call('POST', 'setup', { username: 'admin', password: 'secret12', company: 'Test' })).status, 200);
      const admin = cookies.last, adminId = ctx.db.prepare("SELECT id FROM users WHERE username='admin'").get().id;
      await call('PUT', 'settings', { trn: '100123456700003' }, admin);
      const client = (await call('POST', 'parties', { type: 'client', name: 'Fake Client' }, admin)).json.id;
      const projectId = (await call('POST', 'projects', { name: 'Sample Build', code: 'P-TEST', location: 'Abu Dhabi', client_id: client, contract_value: 250000 }, admin)).json.id;
      const privateProjectId = (await call('POST', 'projects', { name: 'Unassigned Build', code: 'P-PRIVATE', client_id: client, contract_value: 500000 }, admin)).json.id;
      const invoiceId = (await call('POST', 'invoices', { project_id: projectId, items: [{ description: 'Test work', qty: 1, rate: 1000 }] }, admin)).json.id;
      assert.ok(invoiceId);
      assert.equal((await call('POST', 'variations', { project_id: projectId, description: 'Fake approved change', amount: 5000, status: 'approved' }, admin)).status, 200);
      const poId = Number(ctx.db.prepare(`INSERT INTO purchase_orders(number,date,party_id,project_id,status,items,vat_pct,notes)
        VALUES('PO-FAKE-001','2026-01-02',?,?,?,'[{"description":"fake material","qty":1,"rate":100}]',5,'never expose PO note')`)
        .run(client, projectId, 'sent').lastInsertRowid);
      const rfqId = Number(ctx.db.prepare("INSERT INTO rfqs(number,date,project_id,status) VALUES('RFQ-ASSIGNED','2026-01-02',?,'open')")
        .run(projectId).lastInsertRowid);
      for (let i = 0; i < 51; i++) ctx.db.prepare("INSERT INTO rfqs(number,date,status) VALUES(?,'2026-01-03','open')").run(`RFQ-UNASSIGNED-${i}`);
      const subcontractId = Number(ctx.db.prepare(`INSERT INTO subcontracts(project_id,party_id,description,contract_value,status,agreement_no,start_date,completion_date)
        VALUES(?,?,? ,50000,'active','SC-FAKE-001','2026-01-01','2026-12-31')`)
        .run(projectId, client, 'Fake subcontract package').lastInsertRowid);
      ctx.db.prepare(`INSERT INTO spend_approvals(kind,ref_id,amount,status,requested_by,requested_by_id,requested_at,note)
        VALUES('po',?,125,'pending','fake-requester',?, '2026-01-03','never expose approval note')`).run(poId, adminId);
      ctx.db.prepare(`INSERT INTO documents(entity,entity_id,category,name,mime,size,data,expiry_date,uploaded_by,created,doc_type)
        VALUES('project',?,'secret category','private-filename.pdf','application/pdf',8,?,'2026-12-31','fake-uploader','2026-01-04','other')`)
        .run(projectId, Buffer.from('fake document bytes'));
      ctx.db.prepare(`INSERT INTO documents(entity,entity_id,category,name,mime,size,data,expiry_date,uploaded_by,created,doc_type)
        VALUES('project',?,'private category','unassigned-private.pdf','application/pdf',8,?,'2026-12-31','fake-uploader','2026-01-04','contract')`)
        .run(privateProjectId, Buffer.from('private document bytes'));
      ctx.db.prepare(`INSERT INTO m365_documents(entity,entity_id,doc_type,status,error,fails,updated_at)
        VALUES('purchase_orders',?,'Purchase Orders','failed','never expose provider error',3,'2026-01-05')`).run(poId);
      for (const [username, role] of [['manager1', 'manager'], ['manager3', 'manager'], ['site1', 'site_engineer'], ['viewer1', 'viewer'], ['manager2', 'manager']]) {
        assert.equal((await call('POST', 'users', { username, password: 'secret12', role }, admin)).status, 200);
      }
      const manager = await login('manager1'), manager3 = await login('manager3'), site = await login('site1'), viewer = await login('viewer1'), manager2 = await login('manager2');
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
      assert.deepEqual(settings.json.data.map(x => x.id), [projectId], 'site project list is restricted to assigned project scope');
      assert.equal((await call('GET', `projects/${privateProjectId}`, undefined, site)).status, 403, 'direct project deep-links independently enforce site assignment');
      const siteDocuments = await call('POST', 'copilot/ask', { question: 'project documents' }, site);
      assert.equal(siteDocuments.status, 200);
      assert.deepEqual(siteDocuments.json.data.map(x => x.entity_id), [projectId], 'site document results are restricted to assigned projects');
      const siteRfqs = await call('POST', 'copilot/ask', { question: 'RFQs' }, site);
      assert.equal(siteRfqs.status, 200);
      assert.deepEqual(siteRfqs.json.data.map(x => x.id), [rfqId], 'site RFQ results are scoped before applying the result cap');
      const beforeSameQuestion = mock.calls.length;
      assert.equal((await call('POST', 'copilot/ask', { question: 'projects' }, manager)).status, 200);
      assert.equal((await call('POST', 'copilot/ask', { question: 'projects' }, site)).status, 200);
      assert.equal(mock.calls.length, beforeSameQuestion + 2, 'identical questions from different ERP users are not cached');
      assert.equal((await call('POST', 'copilot/ask', { question: 'ملخص المشاريع' }, manager)).status, 200, 'Arabic deterministic routing');
      assert.equal((await call('POST', 'copilot/ask', { question: 'invoice summary' }, manager)).json.intent, 'invoice_summary');
      const financialAnswer = await call('POST', 'copilot/ask', { question: 'project profit' }, manager3);
      assert.equal(financialAnswer.json.intent, 'project_financials');
      assert.equal(financialAnswer.json.data.find(x => x.id === projectId).contract_value, 250000);
      assert.equal(financialAnswer.json.data.find(x => x.id === projectId).revised_contract_value, 255000, 'original and revised contract values are distinct');
      assert.equal(mock.calls[0].headers['api-key'], 'fake-local-api-key');

      process.env.COPILOT_ALLOWED_ROLES = 'manager,site_engineer,admin';
      const status = await call('GET', 'copilot/status', undefined, manager3);
      assert.equal(status.status, 200);
      assert.equal(status.json.max_results, 50);
      assert.ok(status.json.intents.includes('procurement_status') && status.json.intents.includes('sync_failures'));
      process.env.NODE_ENV = 'production';
      assert.equal((await call('GET', 'copilot/status', undefined, manager3)).json.provider_configured, false, 'loopback HTTP provider is rejected outside tests');
      process.env.NODE_ENV = 'test';
      assert.equal((await call('GET', 'copilot/status', undefined, manager3)).json.provider_configured, true, 'local provider mock is accepted in tests');
      process.env.COPILOT_AZURE_ENDPOINT = 'https://example.com';
      assert.equal((await call('GET', 'copilot/status', undefined, manager3)).json.provider_configured, false, 'non-Azure provider hosts are rejected');
      process.env.COPILOT_AZURE_ENDPOINT = 'https://resource.openai.azure.com:8443';
      assert.equal((await call('GET', 'copilot/status', undefined, manager3)).json.provider_configured, false, 'nonstandard Azure endpoint ports are rejected');
      process.env.COPILOT_AZURE_ENDPOINT = mockOrigin;
      assert.equal(status.headers.get('cache-control'), 'no-store', 'Copilot responses are never cached');
      for (const [question, intent] of [
        ['purchase orders', 'procurement_status'], ['contracts', 'contract_summary'], ['project documents', 'project_documents'],
        ['pending approvals', 'approval_queue'],
      ]) {
        const answer = await call('POST', 'copilot/ask', { question }, manager3);
        assert.equal(answer.status, 200, question);
        assert.equal(answer.json.intent, intent);
      }
      const procurement = await call('POST', 'copilot/ask', { question: 'purchase orders' }, manager3);
      assert.ok(procurement.json.data.some(x => x.id === poId && x.kind === 'purchase_order' && x.total > 0));
      assert.ok(!JSON.stringify(procurement.json).includes('never expose PO note'));
      const contracts = await call('POST', 'copilot/ask', { question: 'contracts' }, manager3);
      assert.ok(contracts.json.data.some(x => x.id === subcontractId && x.contract_value === 50000));
      const documents = await call('POST', 'copilot/ask', { question: 'project documents' }, manager3);
      assert.ok(documents.json.data.some(x => x.entity_id === projectId && x.doc_type === 'other'));
      assert.ok(!JSON.stringify(documents.json).includes('private-filename.pdf'));
      assert.ok(!JSON.stringify(mock.calls.at(-1).body).includes('fake document bytes'));
      const approvals = await call('POST', 'copilot/ask', { question: 'pending approvals' }, manager3);
      assert.ok(approvals.json.data.some(x => x.ref_id === poId && x.amount === 125));
      assert.ok(!JSON.stringify(approvals.json).includes('never expose approval note'));
      assert.equal((await call('POST', 'copilot/ask', { question: 'SharePoint sync failures' }, manager3)).status, 403, 'sync-failure details require administrator ACL');
      const syncFailures = await call('POST', 'copilot/ask', { question: 'SharePoint sync failures' }, admin);
      assert.equal(syncFailures.status, 200);
      assert.ok(syncFailures.json.data.some(x => x.entity_id === poId && x.fails === 3));
      assert.ok(!JSON.stringify(syncFailures.json).includes('never expose provider error'));
      for (const [question, intent] of [
        ['أوامر الشراء', 'procurement_status'], ['عقود المقاولين', 'contract_summary'],
        ['مستندات المشاريع', 'project_documents'], ['طلبات الاعتماد', 'approval_queue'],
        ['فشل المزامنة', 'sync_failures'],
      ]) {
        const answer = await call('POST', 'copilot/ask', { question }, admin);
        assert.equal(answer.status, 200, question);
        assert.equal(answer.json.intent, intent, `Arabic routing for ${intent}`);
      }
      assert.equal((await call('GET', `invoices/${invoiceId}`, undefined, site)).status, 403, 'ERP deep-link API ACL applies independently of Copilot');
      assert.equal((await call('GET', 'copilot/audit', undefined, manager3)).status, 403, 'Copilot audit is administrator-only');
      const audit = await call('GET', 'copilot/audit', undefined, admin);
      assert.equal(audit.status, 200);
      assert.ok(audit.json.some(x => x.event === 'ask' && x.outcome === 'completed'));
      assert.ok(!JSON.stringify(audit.json).includes('question'));

      process.env.COPILOT_MAX_RESULTS = '2';
      assert.equal((await call('GET', 'copilot/status', undefined, manager3)).json.max_results, 2, 'configured result limit is reported');
      delete process.env.COPILOT_MAX_RESULTS;

      // A new sensitive column must remain absent even when the underlying projects row contains it.
      ctx.db.exec('ALTER TABLE projects ADD COLUMN copilot_test_secret TEXT');
      ctx.db.prepare('UPDATE projects SET copilot_test_secret=? WHERE id=?').run('never-send-this-sensitive-column', projectId);
      const projected = await call('POST', 'copilot/ask', { question: 'projects status' }, manager3);
      assert.equal(projected.status, 200);
      assert.ok(!JSON.stringify(projected.json).includes('never-send-this-sensitive-column'));
      assert.ok(!JSON.stringify(mock.calls.at(-1).body).includes('copilot_test_secret'));
      assert.ok(!JSON.stringify(mock.calls.at(-1).body).includes('never-send-this-sensitive-column'));
      for (const question of ['project profit', 'invoice summary']) {
        const answer = await call('POST', 'copilot/ask', { question }, manager3);
        assert.equal(answer.status, 200);
        assert.ok(!JSON.stringify(answer.json).includes('never-send-this-sensitive-column'));
        assert.ok(!JSON.stringify(mock.calls.at(-1).body).includes('never-send-this-sensitive-column'));
      }

      // The result cap is enforced by the tool, independently of whatever the provider returns.
      for (let i = 0; i < 55; i++) ctx.db.prepare('INSERT INTO projects(code,name,status) VALUES(?,?,?)').run(`P-${i}`, `Fake Project ${i}`, 'active');
      process.env.COPILOT_MAX_RESULTS = '2';
      assert.equal((await call('POST', 'copilot/ask', { question: 'projects' }, manager3)).json.data.length, 2, 'configured result limit is enforced');
      delete process.env.COPILOT_MAX_RESULTS;
      const capped = await call('POST', 'copilot/ask', { question: 'projects' }, manager3);
      assert.equal(capped.json.data.length, 50);

      const managerHistory = (await call('GET', 'copilot/history', undefined, manager3)).json;
      const siteHistory = (await call('GET', 'copilot/history', undefined, site)).json;
      assert.ok(managerHistory.length > 0 && siteHistory.length > 0);
      assert.ok(managerHistory.every(x => x.question !== 'project status'), 'history is isolated by ERP user');
      assert.equal((await call('POST', 'copilot/feedback', { history_id: financialAnswer.json.id, rating: 'helpful' }, manager3)).status, 200);
      assert.equal((await call('POST', 'copilot/feedback', { history_id: financialAnswer.json.id, rating: 'helpful' }, site)).status, 404, 'feedback cannot target another user history');
      const backupFile = path.join(process.env.DATA_DIR, 'copilot-backup.db');
      sanitizedCopy(ctx.db, backupFile);
      const backup = new DatabaseSync(backupFile, { readOnly: true });
      assert.equal(backup.prepare('SELECT COUNT(*) n FROM copilot_history').get().n, 0, 'backups never retain Copilot history');
      assert.equal(backup.prepare('SELECT COUNT(*) n FROM copilot_feedback').get().n, 0, 'backups never retain Copilot feedback');
      assert.equal(backup.prepare('SELECT COUNT(*) n FROM copilot_audit').get().n, 0, 'backups never retain Copilot audit events');
      backup.close();
      assert.ok((await call('GET', 'copilot/history', undefined, site)).json.length > 0, 'backup sanitization leaves live history intact');
      ctx.db.prepare('INSERT INTO copilot_history(user_id,question,answer,created_at) VALUES(?,?,?,?)').run(
        ctx.db.prepare("SELECT id FROM users WHERE username='manager3'").get().id, 'expired fake question', 'old answer', Date.now() - 31 * 864e5,
      );
      await call('GET', 'copilot/history', undefined, manager3);
      assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM copilot_history WHERE question='expired fake question'").get().n, 0, 'history older than 30 days is pruned');
      process.env.COPILOT_HISTORY_RETENTION_DAYS = '2';
      ctx.db.prepare('INSERT INTO copilot_history(user_id,question,answer,created_at) VALUES(?,?,?,?)').run(
        ctx.db.prepare("SELECT id FROM users WHERE username='manager3'").get().id, 'expired configurable question', 'old answer', Date.now() - 3 * 864e5,
      );
      await call('GET', 'copilot/history', undefined, manager3);
      assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM copilot_history WHERE question='expired configurable question'").get().n, 0, 'configured history retention is honored');
      delete process.env.COPILOT_HISTORY_RETENTION_DAYS;
      assert.equal((await call('DELETE', 'copilot/history', undefined, manager3)).status, 200);
      assert.equal((await call('GET', 'copilot/history', undefined, manager3)).json.length, 0, 'user can clear own history');
      assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM copilot_feedback WHERE user_id=(SELECT id FROM users WHERE username='manager3')").get().n, 0,
        'clearing history also clears feedback linked to it');
      assert.ok((await call('GET', 'copilot/history', undefined, site)).json.length > 0, 'clear never deletes another user history');

      assert.equal((await call('POST', 'copilot/ask', { question: 'x'.repeat(1001) }, manager3)).status, 400, 'question character limit');
      assert.equal((await call('POST', 'copilot/ask', JSON.stringify({ question: 'x'.repeat(17000) }), manager3, '', true)).status, 413, 'request byte limit');
      assert.equal((await call('POST', 'copilot/ask', { question: 'tell me a joke' }, manager3)).status, 422, 'unsupported intent does not reach provider');
      mock.failProvider = true;
      const providerFailure = await call('POST', 'copilot/ask', { question: 'project status' }, manager3);
      mock.failProvider = false;
      assert.equal(providerFailure.status, 502);
      assert.ok(!providerFailure.text.includes('fake private provider error'), 'provider error bodies are never returned');
      mock.redirectProvider = true;
      const redirectError = await call('POST', 'copilot/ask', { question: 'project status' }, admin);
      mock.redirectProvider = false;
      assert.equal(redirectError.status, 502, 'provider redirects are refused');
      assert.equal(mock.redirectCalls, 0, 'provider API keys are never forwarded through redirects');
      assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM copilot_history WHERE user_id=(SELECT id FROM users WHERE username='manager3') AND question='project status'").get().n, 0,
        'failed provider requests are not saved as completed history');
      process.env.COPILOT_TIMEOUT_MS = '1000'; mock.delayProvider = 1500;
      const providerTimeout = await call('POST', 'copilot/ask', { question: 'project status' }, manager3);
      mock.delayProvider = 0; delete process.env.COPILOT_TIMEOUT_MS;
      assert.equal(providerTimeout.status, 504, 'configurable provider timeout is enforced');

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
      process.env.NODE_ENV = 'production';
      assert.equal((await call('POST', 'copilot/ask', { question: 'projects' }, '', validBearer)).status, 503, 'loopback JWKS is rejected outside tests');
      process.env.NODE_ENV = 'test';
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
