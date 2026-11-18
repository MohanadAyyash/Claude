// Automatic SharePoint sync: the reconciler + retry queue that copies every issued / approved document and every staff attachment
// to SharePoint by itself (modules/m365business.js). Local mocks of Entra (client credentials) and Graph (simple upload with
// replace / rename, upload sessions); the PDF engine is a deterministic fake. Fake identities and data only; no internet.
//   node --no-warnings test-m365-sync.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert'), http = require('http'), crypto = require('crypto');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-m365sync-'));
process.env.ZOHO_NO_SCHEDULER = '1'; process.env.SALES_NO_SCHEDULER = '1'; process.env.BACKUP_NO_SCHEDULER = '1';
for (const k of Object.keys(process.env)) if (k.startsWith('M365_') || k.startsWith('AUTH_')) delete process.env[k];
process.env.TRUST_PROXY = '1'; delete process.env.SECURE_COOKIES;
process.env.M365_SYNC_NO_WORKER = '1';          // the test drives the queue itself (ctx.m365SyncTick), except where the worker is switched on

const { server, ctx } = require('./server.js');
const { DatabaseSync } = require('node:sqlite');
const TENANT = '11111111-2222-3333-4444-555555555555', CLIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', SECRET = 'test-client-secret-NOT-REAL-sync';
const SITE = 'contoso.sharepoint.com,0f0f0f0f-1111-2222-3333-444444444444,5e5e5e5e-1111-2222-3333-444444444444', DRIVE = 'b!FakeDriveId_ForTests-123';
const KEY = crypto.randomBytes(32).toString('base64');
let pdfCalls = 0, pdfBroken = false;
ctx.pdf = async html => { pdfCalls++; if (pdfBroken) throw new Error('no browser'); return Buffer.from(`%PDF-1.4\n% fake ${crypto.createHash('sha256').update(String(html)).digest('hex')}\n%%EOF\n`); };

(async () => {
  const mock = { files: new Map(), puts: [], sessions: [], chunks: [], putMode: 'ok', sessionUrl: null, appTokens: new Set() };
  const ms = http.createServer((rq, rs) => { const chunks = []; rq.on('data', c => chunks.push(c)); rq.on('end', () => {
    const body = Buffer.concat(chunks), out = (code, j) => { rs.writeHead(code, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify(j)); };
    const u = new URL(rq.url, 'http://x'), mport = ms.address().port;
    if (u.pathname === `/${TENANT}/oauth2/v2.0/token`) {
      const f = new URLSearchParams(body.toString());
      if (f.get('client_id') !== CLIENT || f.get('client_secret') !== SECRET || f.get('grant_type') !== 'client_credentials') return out(400, { error: 'invalid_grant' });
      const t = 'mock-app-' + crypto.randomBytes(8).toString('hex'); mock.appTokens.add(t); return out(200, { token_type: 'Bearer', expires_in: 3600, access_token: t });
    }
    // the upload session address: no Authorization header may arrive here
    const up = /^\/upload\/(\d+)$/.exec(u.pathname);
    if (up && rq.method === 'PUT') {
      const s = mock.sessions[+up[1]]; if (!s) return out(404, {});
      if (rq.headers.authorization) s.sawAuth = true;
      const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(rq.headers['content-range'] || ''); if (!m || +m[1] !== s.got) return out(416, {});
      s.parts.push(body); s.got = +m[2] + 1; mock.chunks.push({ range: rq.headers['content-range'], len: body.length });
      if (s.got < +m[3]) return out(202, { nextExpectedRanges: [`${s.got}-`] });
      return out(201, store(s.filePath, Buffer.concat(s.parts), s.conflict));
    }
    if (!u.pathname.startsWith('/v1.0/')) return out(404, {});
    if (!mock.appTokens.has((rq.headers.authorization || '').replace(/^Bearer /, ''))) return out(401, {});
    const p = u.pathname.slice(5);
    const sess = /^\/drives\/([^/]+)\/root:\/(.+):\/createUploadSession$/.exec(p);
    if (sess && rq.method === 'POST') {
      if (mock.putMode === '503') return out(503, {});
      const j = JSON.parse(body.toString() || '{}'), i = mock.sessions.length;
      mock.sessions.push({ filePath: sess[2].split('/').map(decodeURIComponent), conflict: j.item && j.item['@microsoft.graph.conflictBehavior'], parts: [], got: 0 });
      return out(200, { uploadUrl: mock.sessionUrl || `http://127.0.0.1:${mport}/upload/${i}`, expirationDateTime: new Date(Date.now() + 3600e3).toISOString() });
    }
    const put = /^\/drives\/([^/]+)\/root:\/(.+):\/content$/.exec(p);
    if (put && rq.method === 'PUT') {
      if (decodeURIComponent(put[1]) !== DRIVE) return out(404, {});
      if (mock.putMode === '503') return out(503, {}); if (mock.putMode === '403') return out(403, {});
      const filePath = put[2].split('/').map(decodeURIComponent), conflict = u.searchParams.get('@microsoft.graph.conflictBehavior');
      mock.puts.push({ filePath, conflict, body });
      return out(200, store(filePath, body, conflict));
    }
    out(404, {});
  }); });
  // the fake library: replace keeps the name; rename picks "name 1.ext" when the name is taken (like SharePoint)
  function store(filePath, body, conflict) {
    let fp = [...filePath];
    if (conflict === 'rename') for (let n = 1; mock.files.has(fp.join('/')); n++) { const f = filePath.at(-1), dot = f.lastIndexOf('.'); fp = [...filePath.slice(0, -1), dot > 0 ? `${f.slice(0, dot)} ${n}${f.slice(dot)}` : `${f} ${n}`]; }
    mock.files.set(fp.join('/'), body);
    return { id: '01ITEM' + crypto.createHash('sha1').update(fp.join('/')).digest('hex').slice(0, 20).toUpperCase(), name: fp.at(-1), size: body.length, webUrl: `https://contoso.sharepoint.com/sites/trigon/${fp.map(encodeURIComponent).join('/')}` };
  }

  server.listen(0, async () => {
    await new Promise(r => ms.listen(0, r));
    const port = server.address().port, base = `http://127.0.0.1:${port}`, mport = ms.address().port;
    let ip = 0; const xff = () => `198.51.100.${(++ip % 250) + 1}`;
    const call = async (m, u, b, ck = '') => { const r = await fetch(base + '/api/' + u, { method: m, headers: { 'Content-Type': 'application/json', cookie: ck, 'X-Forwarded-For': xff() }, body: b ? JSON.stringify(b) : undefined }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j, t }; };
    const ok = (r, l) => { assert.equal(r.s, 200, `${l || ''} → ${r.s} ${String(r.t).slice(0, 300)}`); return r.j; };
    const login = async u => { const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': xff() }, body: JSON.stringify({ username: u, password: 'secret12' }) }); assert.equal(r.status, 200, u); return 'sid=' + /sid=([a-f0-9]+)/.exec(r.headers.get('set-cookie'))[1]; };
    const dbFile = path.join(process.env.DATA_DIR, 'erp.db');
    const q = (sql, ...a) => { const d = new DatabaseSync(dbFile, { readOnly: true }); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
    const exec = (sql, ...a) => { const d = new DatabaseSync(dbFile); try { return d.prepare(sql).run(...a); } finally { d.close(); } };
    const row = (e, id, t) => q('SELECT * FROM m365_documents WHERE entity=? AND entity_id=?' + (t ? ' AND doc_type=?' : ''), e, id, ...(t ? [t] : []))[0];
    const tick = () => ctx.m365SyncTick({ force: true });
    const paths = () => mock.puts.map(p => p.filePath.join('/'));
    const dataUri = (mime, buf) => `data:${mime};base64,` + buf.toString('base64');
    const minsAhead = iso => (Date.parse(iso) - Date.now()) / 60e3;

    try {
      ok(await call('POST', 'setup', { username: 'admin', password: 'secret12', company: 'Test Co' }));
      const admin = await login('admin');
      for (const [u, role] of [['proc', 'procurement'], ['acc', 'accountant'], ['site', 'site_engineer'], ['viewer', 'viewer']]) ok(await call('POST', 'users', { username: u, password: 'secret12', role }, admin));
      const cl = ok(await call('POST', 'parties', { type: 'client', name: 'Client One' }, admin)).id;
      const sup = ok(await call('POST', 'parties', { type: 'supplier', name: 'Supplier One' }, admin)).id;
      const P1 = ok(await call('POST', 'projects', { name: 'Villa', code: 'P-101', client_id: cl, status: 'active' }, admin)).id;
      const P2 = ok(await call('POST', 'projects', { name: 'Tower', code: 'P-202', client_id: cl, status: 'active' }, admin)).id;
      ok(await call('PUT', 'users/' + q("SELECT id FROM users WHERE username='site'")[0].id, { projects: [P1] }, admin));   // the site engineer works on P1 only
      ok(await call('PUT', 'settings', { po_approval_limit: 10000, trn: '100123456700003' }, admin));
      const mkPo = async (status, rate = 100) => ok(await call('POST', 'purchase_orders', { party_id: sup, project_id: P1, status, items: [{ description: 'Rebar', unit: 't', qty: 1, rate }], vat_pct: 5 }, admin)).id;
      const poSent = await mkPo('sent'), poDraft = await mkPo('draft'), poCancel = await mkPo('cancelled');
      const quote = ok(await call('POST', 'quotes', { client_id: cl, project_name: 'Villa', status: 'sent', items: [{ description: 'Works', qty: 1, rate: 1000 }] }, admin)).id;
      const qDraft = ok(await call('POST', 'quotes', { client_id: cl, project_name: 'Villa', status: 'draft', items: [{ description: 'Works', qty: 1, rate: 10 }] }, admin)).id;
      const inv = ok(await call('POST', 'invoices', { project_id: P1, items: [{ description: 'Works', qty: 1, rate: 1000 }] }, admin)).id;
      const empDoc = ok(await call('POST', 'employees', { name: 'Test Worker', person_code: '10000000000001', basic: 1000 }, admin)).id;
      ok(await call('POST', 'documents', { entity: 'employee', entity_id: empDoc, name: 'passport.pdf', category: 'Passport', data: dataUri('application/pdf', Buffer.from('%PDF private')) }, admin));
      ok(await call('POST', 'documents', { entity: 'company', entity_id: 0, name: 'trade-licence.pdf', category: 'Licence', data: dataUri('application/pdf', Buffer.from('%PDF company')) }, admin));

      // ---- off until SharePoint is configured: nothing is queued or sent ----
      assert.deepEqual(await tick(), { skipped: 'off' }); assert.equal(q('SELECT COUNT(*) n FROM m365_documents')[0].n, 0); assert.equal(mock.puts.length, 0);
      Object.assign(process.env, { M365_ENABLED: '1', M365_TENANT_ID: TENANT, M365_CLIENT_ID: CLIENT, M365_CLIENT_SECRET: SECRET, M365_ENCRYPTION_KEY: KEY, M365_REDIRECT_URI: `${base}/auth/microsoft/callback`,
        M365_LOGIN_BASE: `http://127.0.0.1:${mport}`, M365_GRAPH_BASE: `http://127.0.0.1:${mport}/v1.0`, M365_GRAPH_TIMEOUT_MS: '3000',
        M365_SHAREPOINT_ENABLED: '1', M365_SHAREPOINT_SITE_ID: SITE, M365_SHAREPOINT_DRIVE_ID: DRIVE, M365_SHAREPOINT_AUTO: '0' });
      assert.deepEqual(await tick(), { skipped: 'off' }, 'M365_SHAREPOINT_AUTO=0 switches it off');
      delete process.env.M365_SHAREPOINT_AUTO;
      console.log('✔ off when SharePoint is not configured or M365_SHAREPOINT_AUTO=0: nothing queued, nothing sent');

      // ---- issued / approved records go by themselves; drafts, cancelled and private papers never ----
      let r1 = await tick();
      const V = 'Trigon Civil Projects/P-101 - Villa', num = (t, id) => q(`SELECT number FROM ${t} WHERE id=?`, id)[0].number;
      assert.ok(paths().includes(`${V}/Purchase Orders/${num('purchase_orders', poSent)}.pdf`), 'issued PO ' + JSON.stringify(paths()));
      assert.ok(paths().includes(`${V}/Invoices/${num('invoices', inv)}.pdf`), 'tax invoice');
      assert.ok(paths().includes(`Trigon Civil Projects/General/Quotations/${num('quotes', quote).replace(/\//g, '-')}.pdf`), 'sent quotation (no project: General; "/" in the number made safe) ' + JSON.stringify(paths()));
      for (const [t, id] of [['purchase_orders', poDraft], ['purchase_orders', poCancel], ['quotes', qDraft]]) assert.equal(row(t, id), undefined, `${t} ${id} is not ready: not queued`);
      assert.ok(!paths().some(p => /passport|trade-licence/.test(p)), 'employee and company papers are never copied');
      assert.equal(q("SELECT COUNT(*) n FROM m365_documents WHERE entity='documents'")[0].n, 0, 'no queue row for private papers');
      const d1 = row('purchase_orders', poSent);
      assert.equal(d1.status, 'uploaded'); assert.equal(d1.source, 'auto'); assert.ok(d1.src_fp && d1.src_fp === d1.want_fp); assert.equal(d1.fails, 0); assert.equal(d1.next_attempt_at, null); assert.equal(d1.uploaded_by, 'sharepoint-sync');
      assert.ok(q("SELECT * FROM audit_log WHERE tbl='m365' AND action='sharepoint-upload' AND user='sharepoint-sync'").length >= 3, 'each automatic upload is audited');
      assert.equal(r1.uploaded, 3, JSON.stringify(r1));
      // nothing changed: nothing is sent again (no PDF made either)
      const n0 = mock.puts.length, pdf0 = pdfCalls; const r2 = await tick();
      assert.equal(mock.puts.length, n0); assert.equal(pdfCalls, pdf0, 'no PDF is made for documents already in sync'); assert.equal(r2.queued, 0);
      console.log('✔ issued PO, sent quotation and tax invoice saved automatically to <root>/<project>/<type>/<number>.pdf; drafts, cancelled, employee and company papers never; unchanged records not re-sent');

      // ---- the moment a document is issued / approved / changed / voided ----
      ok(await call('PUT', 'purchase_orders/' + poDraft, { ...q('SELECT * FROM purchase_orders WHERE id=?', poDraft)[0], items: [{ description: 'Rebar', unit: 't', qty: 1, rate: 100 }], status: 'sent' }, admin));
      await tick(); assert.equal(row('purchase_orders', poDraft).status, 'uploaded', 'a PO is saved when it is issued');
      const poBig = await mkPo('draft', 50000); exec("UPDATE purchase_orders SET status='sent' WHERE id=?", poBig); exec("DELETE FROM spend_approvals WHERE kind='po' AND ref_id=?", poBig);
      const req1 = ok(await call('POST', 'spend-approvals', { kind: 'po', ref_id: poBig }, await login('proc'))).id;
      await tick(); assert.equal(row('purchase_orders', poBig), undefined, 'above the approval limit and not approved: not saved');
      ok(await call('PUT', 'spend-approvals/' + req1, { status: 'approved' }, admin));
      await tick(); assert.equal(row('purchase_orders', poBig).status, 'uploaded', 'saved once approved');
      // a credit note is its own tax document: saved next to the invoices
      const cn = ok(await call('POST', `invoices/${inv}/credit-note`, { reason: 'Test credit', items: [{ description: 'Works', qty: 1, rate: 100 }] }, admin)).id;
      await tick(); assert.equal(row('invoices', cn).status, 'uploaded'); assert.ok(paths().includes(`${V}/Invoices/${num('invoices', cn)}.pdf`), 'credit note');
      // an edited record replaces its copy (same file, SharePoint keeps the versions; one mapping row)
      const invPath = `${V}/Invoices/${num('invoices', inv)}.pdf`, n1 = paths().filter(p => p === invPath).length;
      exec("UPDATE invoices SET notes='Payment by transfer' WHERE id=?", inv); await tick();
      assert.equal(paths().filter(p => p === invPath).length, n1 + 1); assert.equal(mock.puts.at(-1).conflict, 'replace');
      assert.equal(q("SELECT COUNT(*) n FROM m365_documents WHERE entity='invoices' AND entity_id=?", inv)[0].n, 1, 'one mapping row per document');
      // a void invoice: the ERP does not print it, so the copy stays as issued; nothing fails, nothing is retried
      const invV = ok(await call('POST', 'invoices', { project_id: P1, items: [{ description: 'Wrong', qty: 1, rate: 10 }] }, admin)).id; await tick(); assert.equal(row('invoices', invV).status, 'uploaded');
      const before = mock.puts.length, pdfB = pdfCalls;
      ok(await call('POST', `invoices/${invV}/void`, { reason: 'Test void' }, admin)); await tick();
      assert.equal(mock.puts.length, before); assert.equal(pdfCalls, pdfB); const dv = row('invoices', invV); assert.equal(dv.status, 'uploaded'); assert.equal(dv.next_attempt_at, null);
      assert.equal(q('SELECT voided FROM invoices WHERE id=?', invV)[0].voided, 1, 'the ERP invoice itself is as the ERP left it');
      const vp = ok(await call('GET', `m365/documents/invoices/${invV}`, undefined, admin)); assert.equal(vp.ready, false); assert.match(vp.why_not, /void/);
      console.log('✔ saved when issued / approved; above-limit POs only after approval; credit notes saved; an edited record replaces its copy (versioned); a void invoice is left as issued, no retry loop');

      // ---- payment certificates, payment applications, IPCs, subcontracts ----
      const sc = Number(exec("INSERT INTO subcontracts(project_id,party_id,description,contract_value,status) VALUES(?,?,?,?,'active')", P1, sup, 'Blockwork', 100000).lastInsertRowid);
      const cert = Number(exec("INSERT INTO sub_certs(number,subcontract_id,date,cumulative,retention_pct,status) VALUES('SPC-0001',?,?,10000,5,'draft')", sc, '2026-11-01').lastInsertRowid);
      const app = Number(exec("INSERT INTO pay_apps(project_id,seq,number,date,period_to,lines,status) VALUES(?,1,'PA-01',?,?,'[]','draft')", P1, '2026-11-01', '2026-10-31').lastInsertRowid);
      const inv2 = ok(await call('POST', 'invoices', { project_id: P1, items: [{ description: 'Progress', qty: 1, rate: 5000 }] }, admin)).id;
      exec("INSERT INTO ipcs(invoice_id,project_id,seq,lines,created) VALUES(?,?,1,'[]',?)", inv2, P1, '2026-11-02');
      await tick();
      assert.equal(row('sub_certs', cert), undefined, 'a draft certificate is not saved'); assert.equal(row('pay_apps', app), undefined, 'a draft payment application is not saved');
      assert.equal(row('subcontracts', sc).status, 'uploaded'); assert.ok(paths().some(p => p.startsWith(`${V}/Contracts/`)), 'subcontract agreement');
      assert.equal(row('ipc', inv2).status, 'uploaded', 'IPC'); assert.ok(paths().includes(`${V}/Payment Certificates/IPC-01.pdf`), JSON.stringify(paths()));
      exec("UPDATE sub_certs SET status='approved' WHERE id=?", cert); exec("UPDATE pay_apps SET status='submitted' WHERE id=?", app);
      await tick();
      assert.equal(row('sub_certs', cert).status, 'uploaded'); assert.ok(paths().includes(`${V}/Payment Certificates/SPC-0001.pdf`));
      assert.equal(row('pay_apps', app).status, 'uploaded'); assert.ok(paths().includes(`${V}/Payment Applications/PA-01.pdf`));
      // the record panel works for the new types, with the project and role checks of the ERP
      const g = ok(await call('GET', `m365/documents/sub_certs/${cert}`, undefined, admin)); assert.equal(g.status, 'uploaded'); assert.equal(g.auto, true);
      assert.equal((await call('GET', `m365/documents/ipc/${inv2}`, undefined, await login('proc'))).s, 403, 'procurement cannot see invoice certificates');
      console.log('✔ approved subcontractor certificates, submitted payment applications, IPCs and subcontract agreements saved to their folders; drafts are not');

      // ---- retry queue: Microsoft down → failed with a growing wait; nothing lost; recovers by itself ----
      mock.putMode = '503';
      const q1 = ok(await call('POST', 'quotes', { client_id: cl, project_name: 'Villa', status: 'sent', items: [{ description: 'More works', qty: 1, rate: 50 }] }, admin)).id;
      const qBefore = JSON.stringify(q('SELECT * FROM quotes WHERE id=?', q1));
      await tick(); let f = row('quotes', q1);
      assert.equal(f.status, 'failed'); assert.equal(f.fails, 1); assert.match(f.error, /unavailable/); assert.ok(minsAhead(f.next_attempt_at) > 0.5 && minsAhead(f.next_attempt_at) <= 1.01, 'first retry in about a minute');
      const tries = mock.puts.length; await tick(); assert.equal(mock.puts.length, tries, 'not tried again before its time'); assert.equal(row('quotes', q1).fails, 1);
      for (const [n, mins] of [[2, 2], [3, 4], [4, 8]]) {
        exec("UPDATE m365_documents SET next_attempt_at='2000-01-01T00:00:00.000Z' WHERE entity='quotes' AND entity_id=?", q1); await tick(); f = row('quotes', q1);
        assert.equal(f.fails, n); assert.ok(minsAhead(f.next_attempt_at) > mins - 0.5 && minsAhead(f.next_attempt_at) <= mins + 0.01, `wait after ${n} failures ≈ ${mins} min`);
      }
      exec("UPDATE m365_documents SET fails=20 WHERE entity='quotes' AND entity_id=?", q1); exec("UPDATE m365_documents SET next_attempt_at='2000-01-01T00:00:00.000Z' WHERE entity='quotes' AND entity_id=?", q1);
      await tick(); assert.ok(minsAhead(row('quotes', q1).next_attempt_at) <= 360.01 && minsAhead(row('quotes', q1).next_attempt_at) > 359, 'the wait never exceeds 6 hours');
      assert.equal(JSON.stringify(q('SELECT * FROM quotes WHERE id=?', q1)), qBefore, 'a failure never changes the ERP record');
      // dashboard alert after repeated failures (administrators / accountants)
      const dash = ok(await call('GET', 'dashboard', undefined, admin)); assert.ok(dash.alerts.some(a => a.key === 'm365_sync_failed' && a.count === 1), JSON.stringify(dash.alerts));
      // Settings overview, and "retry all failed" (administrators only)
      const sy = ok(await call('GET', 'm365/sync', undefined, admin)); assert.equal(sy.on, true); assert.equal(sy.queue.retrying, 1); assert.equal(sy.failures[0].entity, 'quotes');
      assert.equal((await call('POST', 'm365/sync/retry', {}, await login('acc'))).s, 403, 'retry all: administrators only');
      mock.putMode = 'ok';
      const rt = ok(await call('POST', 'm365/sync/retry', {}, admin)); assert.equal(rt.requeued, 1);
      await new Promise(r => setTimeout(r, 300)); await tick();
      f = row('quotes', q1); assert.equal(f.status, 'uploaded'); assert.equal(f.fails, 0); assert.equal(f.next_attempt_at, null); assert.equal(f.error, null);
      assert.ok(!ok(await call('GET', 'dashboard', undefined, admin)).alerts.some(a => a.key === 'm365_sync_failed'), 'alert gone once saved');
      assert.ok(q("SELECT 1 FROM audit_log WHERE action='sharepoint-retry-all' AND user='admin'").length);
      // the PDF engine unavailable: the same queue, no upload of an empty file
      pdfBroken = true; const q2 = ok(await call('POST', 'quotes', { client_id: cl, project_name: 'Villa', status: 'sent', items: [{ description: 'X', qty: 1, rate: 5 }] }, admin)).id;
      await tick(); assert.equal(row('quotes', q2).status, 'failed'); assert.match(row('quotes', q2).error, /PDF/); assert.ok(row('quotes', q2).next_attempt_at, 'retried later');
      pdfBroken = false; exec("UPDATE m365_documents SET next_attempt_at='2000-01-01T00:00:00.000Z' WHERE entity='quotes' AND entity_id=?", q2); await tick(); assert.equal(row('quotes', q2).status, 'uploaded');
      // a queued record that stops being ready leaves the queue (never uploaded = removed; nothing sent)
      mock.putMode = '503'; const poX = await mkPo('sent'); await tick(); assert.equal(row('purchase_orders', poX).status, 'failed');
      exec("UPDATE purchase_orders SET status='cancelled' WHERE id=?", poX); exec("UPDATE m365_documents SET next_attempt_at='2000-01-01T00:00:00.000Z' WHERE entity='purchase_orders' AND entity_id=?", poX);
      mock.putMode = 'ok'; const nX = mock.puts.length; await tick(); assert.equal(row('purchase_orders', poX), undefined); assert.equal(mock.puts.length, nX);
      console.log('✔ retry queue: Microsoft down → failed, retried after 1, 2, 4, 8… minutes (max 6 h), never early; PDF engine down → retried; dashboard alert after 3 failures; Settings overview; retry-all (admin only); recovers by itself; the ERP record never changes');

      // ---- the manual button is now "save now" and joins the same bookkeeping ----
      mock.putMode = '403'; const q3 = ok(await call('POST', 'quotes', { client_id: cl, project_name: 'Villa', status: 'sent', items: [{ description: 'Y', qty: 1, rate: 7 }] }, admin)).id;
      const man = await call('POST', `m365/documents/quotes/${q3}/upload`, {}, admin); assert.equal(man.s, 502);
      assert.equal(row('quotes', q3).fails, 1); assert.ok(row('quotes', q3).next_attempt_at, 'a failed manual upload is retried by the queue');
      mock.putMode = 'ok'; ok(await call('POST', `m365/documents/quotes/${q3}/upload`, {}, admin));
      f = row('quotes', q3); assert.equal(f.source, 'manual'); assert.ok(f.src_fp); assert.equal(f.next_attempt_at, null);
      const n3 = mock.puts.length; await tick(); assert.equal(mock.puts.length, n3, 'saved by hand = in sync: the queue does not send it again');
      // saved before automatic sync existed (no fingerprint): taken as is, not re-sent
      exec("UPDATE m365_documents SET src_fp=NULL, want_fp=NULL, source=NULL WHERE entity='quotes' AND entity_id=?", q3);
      const ad = await tick(); assert.equal(ad.adopted, 1); assert.equal(mock.puts.length, n3); assert.ok(row('quotes', q3).src_fp);
      console.log('✔ manual "save now": a failure goes to the retry queue, a success counts as in sync; copies saved before this feature are adopted without re-sending');

      // ---- staff attachments go to the folder of their type ----
      const att = async (entity, id, name, category, mime = 'application/pdf', data = Buffer.from('%PDF ' + name)) => ok(await call('POST', 'documents', { entity, entity_id: id, name, category, data: dataUri(mime, data) }, admin)).id;
      const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
      const a1 = await att('project', P1, 'A-101.pdf', 'Drawings'), a2 = await att('project', P1, 'slab.png', '', 'image/png', png), a3 = await att('project', P1, 'dn-55.pdf', 'سند تسليم');
      const a4 = await att('party', sup, 'inv-778.pdf', 'فاتورة'), a5 = await att('party', sup, 'licence.pdf', 'Licence'), a6 = await att('purchase_order', poSent, 'signed.pdf', 'Delivery note');
      const a7 = await att('project', P1, 'hse-weekly.pdf', 'HSE report'), a8 = await att('party', cl, 'loi.pdf', 'Contract'), a9 = await att('project', P1, 'misc.pdf', 'Other');
      await tick();
      const where = id => { const d = q("SELECT doc_type, file_name, status FROM m365_documents WHERE entity='documents' AND entity_id=?", id)[0]; assert.equal(d && d.status, 'uploaded', 'attachment ' + id); return d.doc_type; };
      assert.deepEqual([a1, a2, a3, a4, a5, a6, a7, a8, a9].map(where), ['Drawings', 'Site Photos', 'Delivery Notes', 'Supplier Invoices', 'Supplier Documents', 'Delivery Notes', 'HSE', 'Contracts', 'Documents']);
      for (const p of [`${V}/Drawings/A-101.pdf`, `${V}/Site Photos/slab.png`, `${V}/Delivery Notes/dn-55.pdf`, 'Trigon Civil Projects/Suppliers/Supplier One/Supplier Invoices/inv-778.pdf',
        'Trigon Civil Projects/Suppliers/Supplier One/Supplier Documents/licence.pdf', `${V}/Delivery Notes/signed.pdf`, `${V}/HSE/hse-weekly.pdf`, 'Trigon Civil Projects/Clients/Client One/Contracts/loi.pdf', `${V}/Documents/misc.pdf`])
        assert.ok(paths().includes(p), p + ' in ' + JSON.stringify(paths().slice(-12)));
      assert.ok(mock.puts.filter(p => p.filePath.at(-1) === 'A-101.pdf').every(p => p.conflict === 'rename'), 'attachments never replace another file');
      assert.ok(q('SELECT 1 FROM documents WHERE id=?', a1).length, 'the attachment stays in the ERP');
      // same name twice in the same folder: both kept (SharePoint renames the second)
      const b1 = await att('project', P1, 'photo.jpg', 'Site Photos', 'image/jpeg', Buffer.from('jpeg-one')), b2 = await att('project', P1, 'photo.jpg', 'Site Photos', 'image/jpeg', Buffer.from('jpeg-two'));
      await tick();
      assert.deepEqual([mock.files.get(`${V}/Site Photos/photo.jpg`).toString(), mock.files.get(`${V}/Site Photos/photo 1.jpg`).toString()].sort(), ['jpeg-one', 'jpeg-two'], 'both kept');
      assert.deepEqual([b1, b2].map(id => q("SELECT file_name FROM m365_documents WHERE entity='documents' AND entity_id=?", id)[0].file_name).sort(), ['photo 1.jpg', 'photo.jpg'], 'the name SharePoint gave is recorded');
      // a file above 4 MB: upload session in chunks of 320 KiB multiples, no token sent to the session address
      const big = crypto.randomBytes(5 * 1024 * 1024 + 123), aBig = await att('project', P1, 'survey.pdf', 'Drawings', 'application/pdf', big);
      await tick();
      assert.equal(where(aBig), 'Drawings'); assert.ok(mock.files.get(`${V}/Drawings/survey.pdf`).equals(big), 'the large file arrives whole');
      const s0 = mock.sessions.at(-1); assert.equal(s0.conflict, 'rename'); assert.ok(!s0.sawAuth, 'no Authorization header to the upload address');
      assert.ok(mock.chunks.slice(0, -1).every(c => c.len % (320 * 1024) === 0), 'chunks are multiples of 320 KiB'); assert.ok(mock.chunks.length >= 2);
      // an upload address outside SharePoint / Graph is refused (never called), retried later
      mock.sessionUrl = 'https://evil.example/upload/0'; const aEvil = await att('project', P1, 'survey2.pdf', 'Drawings', 'application/pdf', crypto.randomBytes(4 * 1024 * 1024 + 1));
      await tick(); const e1 = q("SELECT * FROM m365_documents WHERE entity='documents' AND entity_id=?", aEvil)[0];
      assert.equal(e1.status, 'failed'); assert.match(e1.error, /valid upload address/); assert.ok(e1.next_attempt_at); mock.sessionUrl = null;
      // re-typed attachment: copied to its new folder (the earlier copy is left, never deleted); a deleted attachment leaves the queue
      ok(await call('PUT', 'documents/' + a9, { category: 'Submittals' }, admin)); await tick(); assert.ok(paths().includes(`${V}/Submittals/misc.pdf`));
      assert.equal(q("SELECT COUNT(*) n FROM m365_documents WHERE entity='documents' AND entity_id=?", a9)[0].n, 2);
      mock.putMode = '503'; const aDel = await att('project', P1, 'gone.pdf', 'Drawings'); await tick(); assert.equal(q("SELECT status FROM m365_documents WHERE entity='documents' AND entity_id=?", aDel)[0].status, 'failed');
      ok(await call('DELETE', 'documents/' + aDel, undefined, admin)); exec("UPDATE m365_documents SET next_attempt_at='2000-01-01T00:00:00.000Z' WHERE entity='documents' AND entity_id=?", aDel);
      mock.putMode = 'ok'; await tick(); assert.equal(q("SELECT COUNT(*) n FROM m365_documents WHERE entity='documents' AND entity_id=?", aDel)[0].n, 0);
      // the attachment panel shows its target folder
      const ap = ok(await call('GET', `m365/attachments/${a3}`, undefined, admin)); assert.equal(ap.status, 'uploaded'); assert.deepEqual(ap.target, ['P-101 - Villa', 'Delivery Notes']);
      // M365_SHAREPOINT_ATTACHMENTS=0: records still go, attachments wait
      process.env.M365_SHAREPOINT_ATTACHMENTS = '0'; const aOff = await att('project', P1, 'later.pdf', 'Drawings'); const poY = await mkPo('sent'); await tick();
      assert.equal(q("SELECT COUNT(*) n FROM m365_documents WHERE entity='documents' AND entity_id=?", aOff)[0].n, 0); assert.equal(row('purchase_orders', poY).status, 'uploaded');
      delete process.env.M365_SHAREPOINT_ATTACHMENTS; await tick(); assert.equal(where(aOff), 'Drawings');
      console.log('✔ attachments go to the folder of their type (EN / AR words, images → Site Photos, supplier invoices, clients / suppliers); same names kept side by side; > 4 MB via upload session in 320 KiB chunks without the token; foreign upload address refused; re-typed → new folder; deleted → leaves the queue; can be switched off');

      // ---- the structured document type (fixed bilingual list) decides the folder; words in the category are only a fallback ----
      const typed = async (entity, id, name, doc_type, category = '', mime = 'application/pdf', ck = admin) => {
        const r = await call('POST', 'documents', { entity, entity_id: id, name, category, doc_type, data: dataUri(mime, mime === 'image/png' ? png : Buffer.from('%PDF ' + name)) }, ck); return ok(r, name).id; };
      const folderOf = id => { const d = q("SELECT doc_type, file_name, status FROM m365_documents WHERE entity='documents' AND entity_id=? ORDER BY id DESC", id)[0]; assert.equal(d && d.status, 'uploaded', 'attachment ' + id); return d.doc_type; };
      // each type → its folder, inside the attachment's own project
      const KINDS = { drawing: 'Drawings', delivery_note: 'Delivery Notes', supplier_invoice: 'Supplier Invoices', contract: 'Contracts', rfi: 'RFIs', submittal: 'Submittals', hse: 'HSE', site_photo: 'Site Photos', other: 'Documents' };
      const kindIds = {}; for (const k of Object.keys(KINDS)) kindIds[k] = await typed('project', P1, `typed-${k}.pdf`, k);
      await tick();
      for (const [k, folder] of Object.entries(KINDS)) {
        assert.equal(q('SELECT doc_type FROM documents WHERE id=?', kindIds[k])[0].doc_type, k, 'stored as chosen');
        assert.equal(folderOf(kindIds[k]), folder, k); assert.ok(paths().includes(`${V}/${folder}/typed-${k}.pdf`), `${k} → ${V}/${folder}/`);
      }
      // the chosen type always wins over the words of the category and over the file kind
      const o1 = await typed('project', P1, 'scan-01.pdf', 'drawing', 'فاتورة مورد / supplier invoice'), o2 = await typed('project', P1, 'pic.png', 'contract', '', 'image/png');
      const o3 = await typed('party', sup, 'po-copy.pdf', 'delivery_note', 'Invoice'), o4 = await typed('purchase_order', poSent, 'x.pdf', 'other', 'Delivery note');
      await tick();
      assert.deepEqual([o1, o2, o3, o4].map(folderOf), ['Drawings', 'Contracts', 'Delivery Notes', 'Documents']);
      assert.ok(paths().includes('Trigon Civil Projects/Suppliers/Supplier One/Delivery Notes/po-copy.pdf'), 'supplier attachment: supplier folder, chosen type');
      // an invalid / unknown type is stored as Other (Documents); a crafted value cannot name a folder
      const bad = {};
      for (const v of ['Payroll', 'Drawings', '../../HR/Salaries', 'drawing/../../..', ' DRAWING ', 123, '<script>']) bad[JSON.stringify(v)] = await typed('project', P1, `bad-${Object.keys(bad).length}.pdf`, v);
      await tick();
      for (const [v, id] of Object.entries(bad)) {
        const want = v === '" DRAWING "' ? ['drawing', 'Drawings'] : ['other', 'Documents'];
        assert.equal(q('SELECT doc_type FROM documents WHERE id=?', id)[0].doc_type, want[0], `stored type for ${v}`); assert.equal(folderOf(id), want[1], `folder for ${v}`);
      }
      exec("UPDATE documents SET doc_type='legacy-weird' WHERE id=?", kindIds.other); const lw = await typed('project', P1, 'lw.pdf', '', 'Drawing'); exec("UPDATE documents SET doc_type='../../x' WHERE id=?", lw);   // (its words alone would say Drawings)
      await tick(); assert.equal(folderOf(lw), 'Documents', 'an unknown value already in the database also maps to Other');
      // attachments without a structured type (all older ones) still go by the words of the category / the file kind
      assert.equal(q('SELECT doc_type FROM documents WHERE id=?', a3)[0].doc_type, null); assert.equal(folderOf(a3), 'Delivery Notes'); assert.equal(folderOf(a2), 'Site Photos'); assert.equal(folderOf(a4), 'Supplier Invoices');
      const nt = await typed('project', P1, 'nt.pdf', '', 'مخطط معماري'); await tick(); assert.equal(q('SELECT doc_type FROM documents WHERE id=?', nt)[0].doc_type, null); assert.equal(folderOf(nt), 'Drawings');
      // choosing a type later moves the next copy to that folder (the earlier copy is left, never deleted)
      ok(await call('PUT', 'documents/' + nt, { doc_type: 'hse' }, admin)); await tick(); assert.equal(folderOf(nt), 'HSE'); assert.ok(paths().includes(`${V}/HSE/nt.pdf`));
      // no way out of the attachment's own place: every copy is under the root, in its project / party folder, in a fixed type folder
      const FOLDERS = ['Drawings', 'Delivery Notes', 'Supplier Invoices', 'Contracts', 'RFIs', 'Submittals', 'HSE', 'Site Photos', 'Documents', 'Supplier Documents', 'Purchase Orders', 'Invoices', 'Payment Certificates', 'Payment Applications', 'Quotations'];
      for (const p of mock.puts.map(x => x.filePath)) {
        assert.equal(p[0], 'Trigon Civil Projects'); assert.ok(p.every(s => s && s !== '..' && s !== '.' && !/[\\/]/.test(s)), 'no traversal: ' + p.join('/'));
        assert.ok(FOLDERS.includes(p.at(-2)), 'type folder from the fixed list: ' + p.join('/'));
      }
      assert.ok(!paths().some(p => /HR|Salaries|script/.test(p)), 'no folder named by a request');
      // ERP rights and project scope are unchanged: the type does not widen them
      const siteCk = await login('site'), viewerCk = await login('viewer');
      const p2doc = await typed('project', P2, 'tower.pdf', 'drawing'); await tick(); assert.ok(paths().includes('Trigon Civil Projects/P-202 - Tower/Drawings/tower.pdf'), 'P2 attachment in P2');
      assert.equal((await call('GET', `m365/attachments/${p2doc}`, undefined, siteCk)).s, 404, 'a site engineer of P1 cannot see a P2 attachment\'s copy');
      assert.equal((await call('POST', `m365/attachments/${p2doc}/upload`, {}, siteCk)).s, 404, '…nor upload it');
      const sDoc = await typed('project', P1, 'site-photo.png', 'site_photo', '', 'image/png', siteCk); await tick(); assert.ok(paths().includes(`${V}/Site Photos/site-photo.png`), 'the site engineer\'s own upload lands in P1');
      assert.equal((await call('PUT', 'documents/' + sDoc, { doc_type: 'contract' }, viewerCk)).s, 403, 'a viewer cannot change the type');
      assert.equal((await call('POST', 'documents', { entity: 'project', entity_id: P1, name: 'v.pdf', doc_type: 'drawing', data: dataUri('application/pdf', Buffer.from('%PDF v')) }, viewerCk)).s, 403, 'a viewer cannot upload');
      assert.equal(q('SELECT doc_type FROM documents WHERE id=?', sDoc)[0].doc_type, 'site_photo');
      console.log('✔ structured type: each of the 9 types → its folder; the chosen type beats category words and file kind; unknown / crafted values → Other (Documents); untyped attachments still inferred; re-typing moves the next copy; no path escape; ACL and project scope unchanged');

      // ---- M365_SHAREPOINT_AUTO_FROM: older records are left out (the migration / manual button can still send them) ----
      exec("UPDATE quotes SET date='2020-01-01' WHERE id=?", qDraft); exec("UPDATE quotes SET status='sent' WHERE id=?", qDraft);
      process.env.M365_SHAREPOINT_AUTO_FROM = '2025-01-01'; await tick(); assert.equal(row('quotes', qDraft), undefined, 'dated before AUTO_FROM: not queued');
      delete process.env.M365_SHAREPOINT_AUTO_FROM; await tick(); assert.equal(row('quotes', qDraft).status, 'uploaded');
      console.log('✔ M365_SHAREPOINT_AUTO_FROM leaves older records out');

      // ---- TESTING-ONLY fault switch (TRIGON_M365_FAULT=sharepoint): fault ON → retry queue → fault OFF → recovery ----
      {
        const filesBefore = JSON.stringify([...mock.files].map(([k, v]) => [k, v.toString('base64')])), putsBefore = mock.puts.length;
        process.env.TRIGON_M365_FAULT = 'sharepoint';
        const poF = await mkPo('sent'), poRowF = () => JSON.stringify(q('SELECT * FROM purchase_orders WHERE id=?', poF));
        const erpBefore = poRowF();
        await tick(); let d = row('purchase_orders', poF); const docId = d.id;
        assert.equal(d.status, 'failed'); assert.equal(d.fails, 1); assert.match(d.error, /unavailable.*TEST FAULT/); assert.ok(minsAhead(d.next_attempt_at) > 0.5, 'next attempt scheduled');
        const sy1 = ok(await call('GET', 'm365/sync', undefined, admin)); assert.ok(sy1.failures.some(f => f.entity === 'purchase_orders' && f.entity_id === poF && f.next_attempt_at), 'shown as retrying in Settings');
        for (const n of [2, 3]) { exec("UPDATE m365_documents SET next_attempt_at='2000-01-01T00:00:00.000Z' WHERE id=?", docId); await tick(); d = row('purchase_orders', poF); assert.equal(d.fails, n); assert.ok(d.next_attempt_at); }
        const al = ok(await call('GET', 'dashboard', undefined, admin)).alerts;
        assert.ok(al.some(x => x.key === 'm365_sync_failed' && x.count === 1), 'warning after 3 failures ' + JSON.stringify(al)); assert.ok(al.some(x => x.key === 'm365_fault'), 'test-mode alert');
        assert.equal(mock.puts.length, putsBefore, 'nothing reached SharePoint'); assert.equal(JSON.stringify([...mock.files].map(([k, v]) => [k, v.toString('base64')])), filesBefore, 'existing SharePoint files untouched');
        assert.equal(poRowF(), erpBefore, 'the ERP record is unchanged');
        // fault OFF → Retry all failed → the same document uploads and its failure state clears
        delete process.env.TRIGON_M365_FAULT;
        assert.ok(ok(await call('POST', 'm365/sync/retry', {}, admin)).requeued >= 1);
        for (let i = 0; i < 50 && row('purchase_orders', poF).status !== 'uploaded'; i++) await new Promise(r => setTimeout(r, 100));   // run by the retry request itself
        d = row('purchase_orders', poF);
        assert.equal(d.id, docId, 'the same queued document'); assert.equal(d.status, 'uploaded'); assert.equal(d.fails, 0); assert.equal(d.error, null); assert.equal(d.next_attempt_at, null);
        assert.ok(paths().includes(`${V}/Purchase Orders/${num('purchase_orders', poF)}.pdf`)); assert.equal(poRowF(), erpBefore);
        assert.ok(!ok(await call('GET', 'dashboard', undefined, admin)).alerts.some(x => x.key === 'm365_sync_failed' || x.key === 'm365_fault'), 'warnings gone');
        // the same with "Run now" after the natural wait
        process.env.TRIGON_M365_FAULT = 'sharepoint'; const poG = await mkPo('sent'); await tick(); assert.equal(row('purchase_orders', poG).status, 'failed');
        delete process.env.TRIGON_M365_FAULT; exec("UPDATE m365_documents SET next_attempt_at='2000-01-01T00:00:00.000Z' WHERE entity='purchase_orders' AND entity_id=?", poG);
        ok(await call('POST', 'm365/sync/run', {}, admin));
        for (let i = 0; i < 50 && row('purchase_orders', poG).status !== 'uploaded'; i++) await new Promise(r => setTimeout(r, 100));
        assert.equal(row('purchase_orders', poG).status, 'uploaded'); assert.equal(row('purchase_orders', poG).fails, 0);
        // any other value is not the fault switch
        process.env.TRIGON_M365_FAULT = 'outlook'; const poH = await mkPo('sent'); await tick(); assert.equal(row('purchase_orders', poH).status, 'uploaded'); delete process.env.TRIGON_M365_FAULT;
        // startup: an obvious warning while it is set, nothing when it is not
        const { spawnSync } = require('child_process');
        const boot = extra => spawnSync(process.execPath, ['--no-warnings', '-e', "require('./server.js'); setTimeout(() => process.exit(0), 50)"], { cwd: __dirname, encoding: 'utf8', timeout: 30000,
          env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('M365_') && k !== 'TRIGON_M365_FAULT')), DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'erp-fault-')), ...extra } });
        const on = boot({ TRIGON_M365_FAULT: 'sharepoint' }), off = boot({});
        assert.match(on.stderr + on.stdout, /WARNING: TRIGON_M365_FAULT=sharepoint is set/); assert.doesNotMatch(off.stderr + off.stdout, /TRIGON_M365_FAULT/);
      }
      console.log('✔ test fault switch: uploads fail as 503 → failed / retrying, fails 1-2-3, next attempt, dashboard warning after 3; nothing sent, existing files and the ERP record untouched; fault off → Retry all failed / Run now → the same document uploads and clears; startup warning only when set');

      // ---- the background worker: a change in the ERP reaches SharePoint within seconds, with no button ----
      Object.assign(process.env, { M365_SYNC_NO_WORKER: '0', M365_SYNC_NUDGE_MS: '100' });
      const poW = await mkPo('sent'); let w;
      for (let i = 0; i < 50 && !((w = row('purchase_orders', poW)) && w.status === 'uploaded'); i++) await new Promise(r => setTimeout(r, 100));
      assert.equal(w && w.status, 'uploaded', 'the worker saved the new PO by itself'); assert.equal(w.source, 'auto');
      process.env.M365_SYNC_NO_WORKER = '1';
      console.log('✔ worker: a PO issued through the API reaches SharePoint within seconds without any button');

      // ---- the integrations status and secrets ----
      const st = ok(await call('GET', 'm365/integrations', undefined, admin)); assert.equal(st.sharepoint.auto, true); assert.ok(st.sharepoint.sync && st.sharepoint.sync.queue);
      const stU = ok(await call('GET', 'm365/integrations', undefined, await login('acc'))); assert.ok(!('sync' in stU.sharepoint), 'users do not see the queue');
      const all = JSON.stringify([q('SELECT * FROM m365_documents'), q("SELECT * FROM audit_log WHERE tbl='m365'"), st]);
      for (const s of [SECRET, KEY, ...mock.appTokens]) assert.ok(!all.includes(s), 'no secret or token in the queue, audit or status');
      console.log('✔ status: administrators see the queue, users do not; no secret or token stored');

      console.log('\nM365 SHAREPOINT AUTO-SYNC TESTS PASSED');
      server.close(); ms.close(); process.exit(0);
    } catch (e) { console.error(e); server.close(); ms.close(); process.exit(1); }
  });
})();
