// Microsoft 365 business integration: SharePoint documents, Outlook mail, Teams notifications (on top of the Phase 1 link / sign-in).
// The ERP stays the system of record (numbers, totals, VAT, approvals, ACL); Microsoft 365 receives copies and messages.
//
//  SharePoint  application permission Sites.Selected, granted to this app on the ONE Trigon site only (no Sites.ReadWrite.All).
//              Files go to  <root>/<project code>/<document type>/<file>  (folders created by the upload). The ERP keeps the mapping
//              (m365_documents): site / drive / item IDs, link, SHA-256, who uploaded, status. Uploading again replaces the same
//              file (SharePoint keeps the versions); an unchanged file is not sent again. A failure never changes the ERP record.
//  Outlook     delegated Mail.Send of the signed-in user's own linked account (POST /me/sendMail): the sender is always that user,
//              never a From chosen in the request. Attachment = the ERP's own PDF of that record. Repeat sends need a confirmation.
//  Teams       a channel webhook (Teams "Workflows" / incoming webhook) on Microsoft's hosts: no Graph permission at all. Cards carry
//              the number, project, supplier, the action needed and a link back to the ERP; amounts only if the administrator
//              allowed them for that destination (M365_TEAMS_INCLUDE_AMOUNTS=1). Approvals stay in the ERP (notify + deep link).
// Every Graph call goes through lib/m365graph.js (fixed URLs from validated IDs, timeouts, safe retries, safe errors).
// Nothing secret is ever returned, logged or audited (tokens, codes, client secret, encryption key, the webhook URL's signature).
'use strict';
const crypto = require('node:crypto');
const G = require('../lib/m365graph');
const STANDALONE = typeof process === 'undefined' || process.platform === 'browser';

const DOC_TYPES = ['Purchase Orders', 'RFQs', 'Quotations', 'Contracts', 'Invoices', 'Delivery Notes', 'RFIs', 'Submittals', 'Drawings', 'HSE', 'Site Photos', 'Supplier Documents', 'Documents'];
const MAX_UPLOAD = 4 * 1024 * 1024, MAX_ATTACH = 3 * 1024 * 1024;               // simple upload / sendMail attachment limits
const ISSUED_PO = ['sent', 'received', 'closed'];

module.exports = ctx => {
  const { db, send, bad, audit, readBody } = ctx;
  const { can } = require('../lib/acl');
  db.exec(`CREATE TABLE IF NOT EXISTS m365_documents (
    id INTEGER PRIMARY KEY, entity TEXT NOT NULL, entity_id INTEGER NOT NULL, doc_type TEXT NOT NULL, file_name TEXT, site_id TEXT, drive_id TEXT, item_id TEXT,
    web_url TEXT, sha256 TEXT, size INTEGER, status TEXT NOT NULL DEFAULT 'pending', error TEXT, attempts INTEGER DEFAULT 0, uploaded_at TEXT, uploaded_by TEXT, updated_at TEXT,
    UNIQUE(entity, entity_id, doc_type));
  CREATE TABLE IF NOT EXISTS m365_mail_log (id INTEGER PRIMARY KEY, entity TEXT, entity_id INTEGER, recipients TEXT, subject TEXT, status TEXT, error TEXT, sent_by TEXT, sent_at TEXT, attachment TEXT);
  CREATE TABLE IF NOT EXISTS m365_teams_log (id INTEGER PRIMARY KEY, event TEXT, entity TEXT, entity_id INTEGER, ok INTEGER, error TEXT, at TEXT);`);
  const now = () => new Date().toISOString();
  const env = () => (typeof process !== 'undefined' && process.env) || {};
  const sysAudit = (user, action, rec, detail) => db.prepare('INSERT INTO audit_log(ts,user,action,tbl,rec,detail) VALUES(?,?,?,?,?,?)').run(now(), user || '', action, 'm365', rec || 0, String(detail).slice(0, 500));
  const fail = (status, msg, code) => Object.assign(new Error(msg), { status, code });

  // ---------- configuration (from .env, like the rest of Microsoft 365; read on every call) ----------
  function bizCfg() {
    const e = env(), base = ctx.m365Config ? ctx.m365Config() : { configured: false };
    const sp = { enabled: e.M365_SHAREPOINT_ENABLED === '1', siteId: String(e.M365_SHAREPOINT_SITE_ID || '').trim(), driveId: String(e.M365_SHAREPOINT_DRIVE_ID || '').trim(),
      root: G.safeName(e.M365_SHAREPOINT_ROOT || 'Trigon Civil Projects', { max: 80, fallback: 'Trigon Civil Projects' }), missing: [] };
    if (sp.enabled) {
      if (!G.validSiteId(sp.siteId)) sp.missing.push('M365_SHAREPOINT_SITE_ID');
      if (!G.validDriveId(sp.driveId)) sp.missing.push('M365_SHAREPOINT_DRIVE_ID');
      if (!base.enabled || !base.configured) sp.missing.push('Microsoft 365 (M365_*)');
    }
    const extra = String(e.M365_TEAMS_EXTRA_HOSTS || '').split(',').map(x => x.trim()).filter(Boolean), url = String(e.M365_TEAMS_WEBHOOK_URL || '').trim();
    const teams = { enabled: !!url, urlOk: !!url && G.teamsUrlOk(url, extra), host: (() => { try { return new URL(url).hostname; } catch { return null; } })(), includeAmounts: e.M365_TEAMS_INCLUDE_AMOUNTS === '1', url };
    const outlook = { enabled: e.M365_OUTLOOK_ENABLED === '1' && !!base.enabled && !!base.configured };
    const erpBase = base.redirectUrl ? base.redirectUrl.origin : null;   // deep links use the registered address, never the request's Host
    return { base, sp: { ...sp, configured: sp.enabled && !sp.missing.length }, teams, outlook, erpBase };
  }
  // configuration changes are audited (names / hosts / flags only: never the webhook URL, which carries a signature)
  function noteBizConfig(c) {
    const fp = crypto.createHash('sha256').update(JSON.stringify([c.sp.enabled, c.sp.siteId, c.sp.driveId, c.sp.root, c.teams.enabled, c.teams.host, c.teams.includeAmounts, c.outlook.enabled,
      c.teams.url ? crypto.createHash('sha256').update(c.teams.url).digest('hex') : null])).digest('hex');
    const old = db.prepare("SELECT value FROM settings WHERE key='m365_biz_config_fp'").get()?.value;
    if (old === fp) return;
    db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run('m365_biz_config_fp', fp);
    if (old !== undefined || c.sp.enabled || c.teams.enabled || c.outlook.enabled)
      sysAudit('system', 'config-change', 0, `sharepoint=${c.sp.enabled ? (c.sp.configured ? 'on' : 'incomplete: ' + c.sp.missing.join(',')) : 'off'} root="${c.sp.root}" outlook=${c.outlook.enabled ? 'on' : 'off'} teams=${c.teams.enabled ? (c.teams.urlOk ? c.teams.host : 'invalid destination') : 'off'} amounts=${c.teams.includeAmounts ? 'shown' : 'hidden'}`);
  }

  // ---------- health (last success / failure per feature; no secrets) ----------
  const health = () => { try { return JSON.parse(db.prepare("SELECT value FROM settings WHERE key='m365_health'").get()?.value || '{}'); } catch { return {}; } };
  const mark = (feature, ok, err) => { const h = health(); h[feature] = { ...(h[feature] || {}), ...(ok ? { ok_at: now() } : { fail_at: now(), error: String(err || '').slice(0, 160) }) }; db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run('m365_health', JSON.stringify(h)); };

  // ---------- application token (client credentials; for SharePoint with Sites.Selected). Kept in memory only, never stored or logged ----------
  let appTok = null;
  async function appToken(c) {
    if (appTok && appTok.exp > Date.now() + 120e3 && appTok.key === c.base.tenant + c.base.clientId) return appTok.token;
    const r = await G.call(`${c.base.loginBase}/${encodeURIComponent(c.base.tenant)}/oauth2/v2.0/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: c.base.clientId, client_secret: c.base.secret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }).toString(), idempotent: true });
    if (!r || typeof r.access_token !== 'string') throw G.gerr('consent_required', 'Microsoft 365 did not issue an application token (check the app secret and consent)');
    appTok = { token: r.access_token, exp: Date.now() + (+r.expires_in || 3600) * 1000, key: c.base.tenant + c.base.clientId };
    return appTok.token;
  }
  // one Graph call as the application; a 401 drops the cached token (next call fetches a new one)
  async function appGraph(c, method, path, opts = {}) {
    const tok = await appToken(c);
    try { return await G.call(c.base.graphBase + path, { method, ...opts, headers: { Authorization: `Bearer ${tok}`, ...(opts.headers || {}) } }); }
    catch (e) { if (e.code === 'consent_required') appTok = null; throw e; }
  }
  // one Graph call as the signed-in user (delegated, the Phase 1 link: refreshed and rotated there)
  async function userGraph(c, userId, method, path, opts = {}) {
    const tok = await ctx.m365Token(userId);
    return G.call(c.base.graphBase + path, { method, ...opts, headers: { Authorization: `Bearer ${tok}`, ...(opts.headers || {}) } });
  }

  // ---------- ERP records that can go to SharePoint / Outlook: who may, and when ----------
  const projectOf = id => id ? db.prepare('SELECT id, code, name FROM projects WHERE id=?').get(id) : null;
  const projectFolder = id => { const p = projectOf(id); return p ? (p.code ? `${p.code}${p.name ? ' - ' + p.name : ''}` : p.name || `Project ${p.id}`) : 'General'; };
  const KINDS = {
    purchase_orders: { docType: 'Purchase Orders', acl: 'purchase_orders', table: 'purchase_orders', render: 'purchase_orders', label: 'Purchase Order',
      ready: r => {
        if (r.status === 'cancelled') return 'This purchase order is cancelled';
        if (!ISSUED_PO.includes(r.status)) return 'Only an issued purchase order (status sent / received / closed) is stored in SharePoint — a draft is not';
        const st = ctx.poSpendState ? ctx.poSpendState(r.id) : 'none';
        if (st && !['none', 'approved'].includes(st)) return 'This purchase order is above the approval limit and is not approved yet';
        return null;
      }, mailReady: r => {
        if (r.status === 'cancelled') return 'This purchase order is cancelled';
        const st = ctx.poSpendState ? ctx.poSpendState(r.id) : 'none';
        return st && !['none', 'approved'].includes(st) ? 'This purchase order is above the approval limit and is not approved yet' : null;
      } },
    quotes: { docType: 'Quotations', acl: 'quotes', table: 'quotes', render: 'quotes', label: 'Quotation', ready: r => r.status === 'draft' ? 'A draft quotation is not stored in SharePoint — send it first' : null, mailReady: () => null },
    invoices: { docType: 'Invoices', acl: 'invoices', table: 'invoices', render: 'invoices', label: 'Tax Invoice', ready: () => null, mailReady: r => r.voided ? 'This invoice is void' : null },
    subcontracts: { docType: 'Contracts', acl: 'sc-agreement', table: 'subcontracts', render: 'sc_agreement', label: 'Subcontract Agreement', number: r => r.agreement_no || `SC-${r.id}`, ready: () => null, mailReady: () => null },
    rfqs: { docType: 'RFQs', acl: 'rfqs', table: 'rfqs', render: null, label: 'Request for Quotation', ready: () => 'RFQs have no printed form to store', mailReady: r => r.status === 'open' ? null : 'This RFQ is closed' },
  };
  const scopeOk = (me, projectId) => { const sc = ctx.siteScope ? ctx.siteScope(me) : null; return !sc || projectId == null || sc.projects.has(+projectId); };
  // the record, after the ERP's own role and project checks (write = upload / send). 404 for a record the user may not see.
  function record(me, entity, id, write) {
    const k = KINDS[entity]; if (!k) throw fail(404, 'not found');
    if (!can(me.role, write ? 'PUT' : 'GET', k.acl)) throw fail(403, 'your role does not allow this action');
    const r = /^\d+$/.test(String(id)) ? db.prepare(`SELECT * FROM ${k.table} WHERE id=?`).get(+id) : null;
    if (!r || !scopeOk(me, r.project_id)) throw fail(404, 'not found');
    return { k, r, number: (k.number ? k.number(r) : r.number) || `${entity}-${r.id}` };
  }

  // ---------- SharePoint ----------
  const docRow = (entity, id, type) => db.prepare('SELECT * FROM m365_documents WHERE entity=? AND entity_id=? AND doc_type=?').get(entity, id, type);
  const docView = d => d ? { status: d.status, file_name: d.file_name, web_url: d.web_url, uploaded_at: d.uploaded_at, uploaded_by: d.uploaded_by, error: d.status === 'failed' ? d.error : null, attempts: d.attempts, doc_type: d.doc_type } : null;
  // put one file into SharePoint and record it. Same record + type = same file (replaced, versioned); unchanged content is not re-sent.
  async function spUpload(c, { entity, entityId, docType, folders, fileName, content, mime, by }) {
    if (!c.sp.configured) throw fail(503, c.sp.enabled ? `SharePoint is not configured (${c.sp.missing.join(', ')})` : 'SharePoint is not switched on', 'not_configured');
    if (!DOC_TYPES.includes(docType)) throw fail(400, 'Invalid document type');
    if (!Buffer.isBuffer(content) || !content.length) throw fail(400, 'The file is empty', 'invalid_file');
    if (content.length > MAX_UPLOAD) throw fail(413, `The file is larger than ${MAX_UPLOAD / 1048576} MB (SharePoint upload limit of this integration)`, 'too_large');
    const name = G.safeName(fileName, { max: 120 }), path = G.safePath([c.sp.root, ...folders]), sha = crypto.createHash('sha256').update(content).digest('hex');
    let d = docRow(entity, entityId, docType);
    if (d && d.status === 'uploaded' && d.sha256 === sha && d.file_name === name) return { ...docView(d), unchanged: true };
    if (!d) { db.prepare("INSERT OR IGNORE INTO m365_documents(entity,entity_id,doc_type,status,updated_at) VALUES(?,?,?,'pending',?)").run(entity, entityId, docType, now()); d = docRow(entity, entityId, docType); }
    // one upload at a time per document (a stuck one is taken over after 2 minutes)
    const took = db.prepare("UPDATE m365_documents SET status='uploading', attempts=attempts+1, updated_at=? WHERE id=? AND (status!='uploading' OR updated_at<?)").run(now(), d.id, new Date(Date.now() - 120e3).toISOString());
    if (!took.changes) throw fail(409, 'This document is being uploaded right now — try again in a minute', 'busy');
    try {
      const item = await appGraph(c, 'PUT', `/drives/${G.seg(c.sp.driveId, G.validDriveId)}/root:/${G.encPath([...path, name])}:/content?@microsoft.graph.conflictBehavior=replace`,
        { body: content, headers: { 'Content-Type': mime || 'application/octet-stream' }, idempotent: true, timeout: 60e3 });
      if (!item || !G.validItemId(String(item.id || ''))) throw G.gerr('bad_response', 'SharePoint did not confirm the upload');
      const url = G.safeWebUrl(item.webUrl);
      db.prepare("UPDATE m365_documents SET status='uploaded', error=NULL, file_name=?, site_id=?, drive_id=?, item_id=?, web_url=?, sha256=?, size=?, uploaded_at=?, uploaded_by=?, updated_at=? WHERE id=?")
        .run(name, c.sp.siteId, c.sp.driveId, item.id, url, sha, content.length, now(), by, now(), d.id);
      sysAudit(by, 'sharepoint-upload', entityId, `${entity} #${entityId} ${docType}/${name} → SharePoint (${G.encPath(path)})`); mark('sharepoint', true);
      return docView(docRow(entity, entityId, docType));
    } catch (e) {
      const msg = e.graph || e.code ? e.message : 'SharePoint upload failed';
      db.prepare("UPDATE m365_documents SET status='failed', error=?, updated_at=? WHERE id=?").run(String(msg).slice(0, 200), now(), d.id);
      sysAudit(by, 'sharepoint-upload-failed', entityId, `${entity} #${entityId} ${docType}/${name}: ${msg}`); mark('sharepoint', false, msg);
      throw fail(e.status && e.status < 500 && !e.graph ? e.status : 502, msg, e.code);
    }
  }
  // the ERP's own PDF of a record (the same as Print → PDF)
  async function recordPdf(entity, id, me) {
    const k = KINDS[entity]; if (!k.render) throw fail(400, 'This record has no printed form', 'invalid_file');
    let pdf; try { pdf = await ctx.pdf(ctx.renderPage(k.render, id, me).html); } catch { throw fail(503, 'The PDF of this record could not be made on this server (PDF engine not available)', 'pdf_unavailable'); }
    if (!Buffer.isBuffer(pdf) || !pdf.length) throw fail(503, 'The PDF of this record could not be made', 'pdf_unavailable');
    return pdf;
  }
  async function uploadRecord(me, entity, id) {
    const c = bizCfg(); noteBizConfig(c);
    const { k, r, number } = record(me, entity, id, true);
    const why = k.ready(r); if (why) throw fail(409, why, 'not_ready');
    const pdf = await recordPdf(entity, r.id, me);
    return spUpload(c, { entity, entityId: r.id, docType: k.docType, folders: [projectFolder(r.project_id), k.docType], fileName: `${number}.pdf`, content: pdf, mime: 'application/pdf', by: me.username });
  }
  // attachments (documents table): supplier papers, delivery notes, drawings… copied, never moved; the source stays in the ERP
  const ATT = { party: r => ['Suppliers', db.prepare('SELECT name FROM parties WHERE id=?').get(r.entity_id)?.name || `Party ${r.entity_id}`, 'Supplier Documents'],
    project: r => [projectFolder(r.entity_id), DOC_TYPES.includes(r.category) ? r.category : 'Documents'],
    purchase_order: r => [projectFolder(db.prepare('SELECT project_id FROM purchase_orders WHERE id=?').get(r.entity_id)?.project_id), DOC_TYPES.includes(r.category) ? r.category : 'Purchase Orders'],
    subcontract: r => [projectFolder(db.prepare('SELECT project_id FROM subcontracts WHERE id=?').get(r.entity_id)?.project_id), 'Contracts'] };
  const attTarget = r => { const parts = ATT[r.entity](r); return { folders: parts, docType: parts[parts.length - 1] }; };   // the last folder is the document type
  function attachment(me, docId, write) {
    const r = /^\d+$/.test(String(docId)) ? db.prepare('SELECT * FROM documents WHERE id=?').get(+docId) : null;
    if (!r || !ATT[r.entity]) throw fail(404, 'not found');
    if (!(ctx.docAllowed ? ctx.docAllowed(me.role, r.entity, write) : me.role === 'admin')) throw fail(403, 'your role does not allow this action');
    if (r.entity === 'project' && !scopeOk(me, r.entity_id)) throw fail(404, 'not found');
    return r;
  }
  async function uploadAttachment(me, docId, by = me.username) {
    const c = bizCfg(); noteBizConfig(c);
    const r = attachment(me, docId, true), t = attTarget(r);
    return spUpload(c, { entity: 'documents', entityId: r.id, docType: t.docType, folders: t.folders, fileName: r.name, content: Buffer.from(r.data || []), mime: r.mime, by });
  }

  // ---------- Outlook (delegated Mail.Send: the user's own mailbox) ----------
  const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i;
  const list = v => [...new Set(String(v || '').split(/[,;\s]+/).map(x => x.trim().toLowerCase()).filter(Boolean))];
  async function sendMail(me, entity, id, body) {
    const c = bizCfg(); noteBizConfig(c);
    if (!c.outlook.enabled) throw fail(503, 'Sending through Outlook is not switched on', 'not_configured');
    const { k, r, number } = record(me, entity, id, true);
    const why = k.mailReady(r); if (why) throw fail(409, why, 'not_ready');
    if (!db.prepare('SELECT 1 FROM m365_connections WHERE user_id=?').get(me.id)) throw fail(409, 'Link your Microsoft 365 account first (Settings → Microsoft 365 account)', 'unlinked');
    if (!(ctx.m365Granted ? ctx.m365Granted(me.id) : []).includes('Mail.Send')) throw fail(409, 'Your Microsoft link does not include sending mail yet — Disconnect and Connect again in Settings to allow it', 'consent_required');
    if (body.from !== undefined || body.sender !== undefined) throw fail(400, 'The sender is always your own Microsoft account', 'bad_sender');
    const to = list(body.to), cc = list(body.cc);
    if (!to.length || to.length > 5 || cc.length > 5 || ![...to, ...cc].every(x => EMAIL.test(x))) throw fail(400, 'Enter 1–5 valid e-mail addresses (and at most 5 in copy)');
    const msg = String(body.message || '').slice(0, 4000), key = [...to].sort().join(',');
    const last = db.prepare("SELECT sent_at FROM m365_mail_log WHERE entity=? AND entity_id=? AND recipients=? AND status='sent' AND sent_at>? ORDER BY id DESC LIMIT 1").get(entity, r.id, key, new Date(Date.now() - 7 * 864e5).toISOString());
    if (last && body.confirm_resend !== true) throw Object.assign(fail(409, `This ${k.label.toLowerCase()} was already sent to these recipients on ${last.sent_at.slice(0, 16).replace('T', ' ')} — confirm to send it again`, 'already_sent'), { extra: { already_sent_at: last.sent_at, need_confirm: true } });
    // the attachment: this record's own PDF (or, if it cannot be made, its SharePoint link) — never a file named in the request
    let attachments = [], linkLine = '', attach = 'none';
    if (k.render && body.attach !== false) {
      try { const pdf = await recordPdf(entity, r.id, me); if (pdf.length <= MAX_ATTACH) { attachments = [{ '@odata.type': '#microsoft.graph.fileAttachment', name: G.safeName(`${number}.pdf`), contentType: 'application/pdf', contentBytes: pdf.toString('base64') }]; attach = 'pdf'; } }
      catch { /* no PDF engine: fall back to the SharePoint copy below */ }
      if (!attachments.length) { const d = docRow(entity, r.id, k.docType); if (d && d.status === 'uploaded' && d.web_url) { linkLine = d.web_url; attach = 'sharepoint-link'; } else throw fail(503, 'The PDF could not be made and there is no SharePoint copy to link to — try again later', 'pdf_unavailable'); }
    }
    const S = ctx.getSettings(), esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
    const subject = `${k.label} ${number} — ${S.company_name || 'Trigon'}`.slice(0, 200);
    const html = `<div style="font-family:Arial,sans-serif;font-size:13px">${msg ? `<p>${esc(msg).replace(/\n/g, '<br>')}</p>` : ''}<p>Please find ${esc(k.label.toLowerCase())} <b>${esc(number)}</b> from ${esc(S.company_name || '')}.</p>${linkLine ? `<p><a href="${esc(linkLine)}">${esc(number)} (SharePoint)</a></p>` : ''}</div>`;
    const logRow = (status, error) => db.prepare('INSERT INTO m365_mail_log(entity,entity_id,recipients,subject,status,error,sent_by,sent_at,attachment) VALUES(?,?,?,?,?,?,?,?,?)').run(entity, r.id, key, subject, status, error, me.username, now(), attach);
    try {
      await userGraph(c, me.id, 'POST', '/me/sendMail', { json: { message: { subject, body: { contentType: 'HTML', content: html }, toRecipients: to.map(a => ({ emailAddress: { address: a } })),
        ccRecipients: cc.map(a => ({ emailAddress: { address: a } })), attachments } , saveToSentItems: true }, expect: 'none', idempotent: false });
    } catch (e) {
      const m = e.graph || e.status ? e.message : 'Outlook could not send the message';
      logRow('failed', String(m).slice(0, 200)); sysAudit(me.username, 'outlook-send-failed', r.id, `${entity} ${number} to ${key}: ${m}`); mark('outlook', false, m);
      throw fail(e.graph ? 502 : e.status || 502, m, e.code);
    }
    logRow('sent', null); sysAudit(me.username, 'outlook-send', r.id, `${entity} ${number} to ${key}${cc.length ? ' cc ' + cc.join(',') : ''} (${attach})`); mark('outlook', true);
    return { ok: 1, sent_at: now(), attachment: attach };
  }

  // ---------- Teams (channel webhook; no Graph permission) ----------
  const money = n => (Math.round((+n || 0) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  async function teamsPost(c, event, { title, facts, amount, link, entity, entityId }) {
    const log = (ok, err) => db.prepare('INSERT INTO m365_teams_log(event,entity,entity_id,ok,error,at) VALUES(?,?,?,?,?,?)').run(event, entity || null, entityId || null, ok ? 1 : 0, err || null, now());
    if (!c.teams.enabled) return { skipped: 'off' };
    if (!c.teams.urlOk) { log(false, 'invalid destination'); mark('teams', false, 'invalid destination'); throw fail(503, 'The Teams destination is not a valid Microsoft webhook address', 'bad_destination'); }
    const rows = [...facts]; if (amount != null && c.teams.includeAmounts) rows.push({ title: 'Amount', value: `${ctx.getSettings().currency || 'AED'} ${money(amount)}` });
    const card = { type: 'AdaptiveCard', $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', version: '1.4',
      body: [{ type: 'TextBlock', text: String(title).slice(0, 200), weight: 'Bolder', size: 'Medium', wrap: true }, { type: 'FactSet', facts: rows.map(f => ({ title: String(f.title).slice(0, 60), value: String(f.value == null ? '' : f.value).slice(0, 300) })) }],
      actions: link ? [{ type: 'Action.OpenUrl', title: 'Open in Trigon ERP', url: link }] : [] };
    try {
      await G.call(c.teams.url, { method: 'POST', json: { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: card }] }, expect: 'text', idempotent: false, timeout: 10e3 });
      log(true); mark('teams', true); return { ok: 1 };
    } catch (e) { const m = e.graph ? e.message : 'Teams did not accept the message'; log(false, m); mark('teams', false, m); throw fail(502, m, e.code); }
  }
  const poFacts = po => { const v = ctx.poView ? ctx.poView(po) : po; return { v, facts: [{ title: 'Purchase order', value: v.number }, { title: 'Project', value: v.project_name || '—' }, { title: 'Supplier', value: v.supplier_name || '—' }] }; };
  const link = (c, route) => c.erpBase ? `${c.erpBase}/#${route}` : null;
  // fire-and-forget from the ERP's own hooks: a Teams problem never blocks or changes the ERP action
  const later = fn => setImmediate(() => { Promise.resolve().then(fn).catch(() => { /* logged in m365_teams_log */ }); });
  ctx.hooks.onSpendRequest = r => { if (r.kind !== 'po') return; later(async () => {
    const c = bizCfg(); const po = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(r.ref_id); if (!po) return; const { facts } = poFacts(po);
    await teamsPost(c, 'po_approval_requested', { title: `Approval needed: purchase order ${po.number}`, facts: [...facts, { title: 'Requested by', value: r.requested_by }, { title: 'Action', value: 'Administrator approval in Trigon ERP → Spend approvals' }], amount: r.amount, link: link(c, 'spend'), entity: 'purchase_orders', entityId: po.id }); }); };
  ctx.hooks.onSpendDecision = r => { if (r.kind !== 'po' || r.status !== 'approved') return; later(async () => {
    const c = bizCfg(); const po = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(r.ref_id); if (!po) return; const { facts } = poFacts(po);
    await teamsPost(c, 'po_approved', { title: `Purchase order ${po.number} approved`, facts: [...facts, { title: 'Approved by', value: r.decided_by }, { title: 'Action', value: 'Issue / send the order to the supplier' }], amount: r.amount, link: link(c, `po/${po.id}`), entity: 'purchase_orders', entityId: po.id }); }); };
  async function overdue(me) {
    const c = bizCfg(), today = new Date().toISOString().slice(0, 10);
    const rows = db.prepare("SELECT * FROM purchase_orders WHERE status='sent' AND delivery_date IS NOT NULL AND delivery_date!='' AND delivery_date<? ORDER BY delivery_date LIMIT 25").all(today);
    if (!rows.length) return { ok: 1, count: 0 };
    const facts = rows.map(po => { const v = poFacts(po).v; return { title: v.number, value: `${v.supplier_name || '—'} · ${v.project_name || '—'} · due ${po.delivery_date}` }; });
    await teamsPost(c, 'po_overdue', { title: `${rows.length} purchase order(s) past the delivery date`, facts: [...facts, { title: 'Action', value: 'Follow up with the suppliers / receive the goods in Trigon ERP' }], link: link(c, 'po'), entity: 'purchase_orders' });
    sysAudit(me.username, 'teams-overdue', 0, `${rows.length} overdue purchase orders sent to Teams`);
    return { ok: 1, count: rows.length };
  }

  // ---------- status for the Settings screen ----------
  function status(me) {
    const c = bizCfg(); noteBizConfig(c);
    const linked = db.prepare('SELECT 1 FROM m365_connections WHERE user_id=?').get(me.id), granted = linked && ctx.m365Granted ? ctx.m365Granted(me.id) : [];
    const mine = { linked: !!linked, can_send_mail: c.outlook.enabled && !!linked && granted.includes('Mail.Send'), needs_reconnect_for_mail: c.outlook.enabled && !!linked && !granted.includes('Mail.Send') };
    const pub = { sharepoint: { enabled: c.sp.enabled, configured: c.sp.configured }, outlook: { enabled: c.outlook.enabled }, teams: { enabled: c.teams.enabled }, me: mine };
    if (me.role !== 'admin') return pub;
    const h = health(), names = (() => { try { return JSON.parse(db.prepare("SELECT value FROM settings WHERE key='m365_sp_names'").get()?.value || '{}'); } catch { return {}; } })();
    const counts = db.prepare("SELECT status, COUNT(*) n FROM m365_documents GROUP BY status").all().reduce((o, x) => (o[x.status] = x.n, o), {});
    return { ...pub, sharepoint: { ...pub.sharepoint, missing: c.sp.missing, root: c.sp.root, site_name: names.site || null, library_name: names.drive || null, documents: counts, health: h.sharepoint || null },
      outlook: { ...pub.outlook, permission: 'Mail.Send (delegated)', health: h.outlook || null },
      teams: { ...pub.teams, destination_ok: c.teams.urlOk, destination_host: c.teams.urlOk ? c.teams.host : null, amounts_shown: c.teams.includeAmounts, health: h.teams || null } };
  }

  // ---------- migration of existing attachments (dry run by default; never deletes; resumable through m365_documents) ----------
  ctx.m365Migrate = async ({ execute = false, limit = 200, by = 'migration' } = {}) => {
    const c = bizCfg(), report = { started: now(), execute, planned: 0, uploaded: 0, unchanged: 0, skipped: [], failed: [] };
    const rows = db.prepare(`SELECT id, entity, entity_id, name, size, mime, category FROM documents WHERE entity IN (${Object.keys(ATT).map(() => '?').join(',')}) ORDER BY id LIMIT ?`).all(...Object.keys(ATT), Math.max(1, Math.min(5000, +limit || 200)));
    const admin = { role: 'admin', username: by, id: 0 };
    for (const r of rows) {
      if (r.size > MAX_UPLOAD) { report.skipped.push({ id: r.id, name: r.name, reason: 'larger than the upload limit' }); continue; }
      const d = db.prepare("SELECT status, sha256 FROM m365_documents WHERE entity='documents' AND entity_id=? AND status='uploaded'").get(r.id);
      const data = db.prepare('SELECT data FROM documents WHERE id=?').get(r.id).data, sha = crypto.createHash('sha256').update(Buffer.from(data || [])).digest('hex');
      if (d && d.sha256 === sha) { report.unchanged++; continue; }
      report.planned++;
      if (!execute) continue;
      try { const x = await uploadAttachment(admin, r.id, by); x.unchanged ? report.unchanged++ : report.uploaded++; } catch (e) { report.failed.push({ id: r.id, name: r.name, error: e.message }); }
    }
    report.finished = now(); report.ready = c.sp.configured;
    return report;
  };

  // ---------- rate limits for sending / testing ----------
  const hits = new Map(), limited = (k, max, ms) => { const t = (hits.get(k) || []).filter(x => Date.now() - x < ms); if (hits.size > 5000) hits.clear(); if (t.length >= max) { hits.set(k, t); return true; } t.push(Date.now()); hits.set(k, t); return false; };
  const out = (res, e) => send(res, e.status || 500, { error: e.message, ...(e.code ? { code: e.code } : {}), ...(e.extra || {}) });

  return {
    async handle(req, res, url, [a, b, c, d, e2], me) {
      if (a !== 'm365' || !['integrations', 'documents', 'attachments', 'mail', 'sharepoint', 'teams', 'outlook', 'migrate'].includes(b)) return false;
      if (STANDALONE) return send(res, 404, { error: 'Microsoft 365 is not available in the standalone edition' }), true;
      const m = req.method;
      try {
        if (b === 'integrations' && m === 'GET') return send(res, 200, status(me)), true;
        // SharePoint copy of an ERP record: status / upload (retry = upload again)
        if (b === 'documents' && c && d) {
          if (m === 'GET' && !e2) { const { r, k } = record(me, c, d, false); return send(res, 200, { ...(docView(docRow(c, r.id, k.docType)) || { status: 'not_uploaded' }), can_upload: can(me.role, 'PUT', k.acl), ready: !k.ready(r), why_not: k.ready(r) }), true; }
          if (m === 'POST' && e2 === 'upload') { if (limited('up:' + me.id, 30, 600e3)) throw fail(429, 'Too many uploads — wait a few minutes'); await readBody(req).catch(() => ({})); return send(res, 200, await uploadRecord(me, c, d)), true; }
        }
        if (b === 'attachments' && c && /^\d+$/.test(c)) {
          if (m === 'GET') { const r = attachment(me, c, false); return send(res, 200, docView(docRow('documents', r.id, attTarget(r).docType)) || { status: 'not_uploaded' }), true; }
          if (m === 'POST' && d === 'upload') { if (limited('up:' + me.id, 30, 600e3)) throw fail(429, 'Too many uploads — wait a few minutes'); await readBody(req).catch(() => ({})); return send(res, 200, await uploadAttachment(me, c)), true; }
        }
        if (b === 'mail' && c && d && m === 'POST') {
          if (limited('mail:' + me.id, 20, 3600e3)) throw fail(429, 'Too many messages in the last hour — wait a while');
          const body = await readBody(req); return send(res, 200, await sendMail(me, c, d, body || {})), true;
        }
        if (b === 'mail' && c && d && m === 'GET') {               // what was sent for this record (who / when / to whom)
          const { r } = record(me, c, d, false);
          return send(res, 200, db.prepare('SELECT recipients, subject, status, error, sent_by, sent_at, attachment FROM m365_mail_log WHERE entity=? AND entity_id=? ORDER BY id DESC LIMIT 20').all(c, r.id)), true;
        }
        if (b === 'outlook' && c === 'test' && m === 'POST') {     // safe: reads the user's own profile, sends nothing
          if (limited('test:' + me.id, 10, 600e3)) throw fail(429, 'Too many tests — wait a few minutes');
          const cfg = bizCfg(); if (!cfg.outlook.enabled) throw fail(503, 'Sending through Outlook is not switched on');
          const granted = ctx.m365Granted(me.id); const who = await userGraph(cfg, me.id, 'GET', '/me?$select=mail,userPrincipalName');
          return send(res, 200, { ok: 1, mailbox: who.mail || who.userPrincipalName || null, can_send: granted.includes('Mail.Send') }), true;
        }
        if (me.role !== 'admin') return send(res, 403, { error: 'your role does not allow this action' }), true;   // below: administrators only
        if (b === 'sharepoint' && c === 'test' && m === 'POST') {
          if (limited('test:' + me.id, 10, 600e3)) throw fail(429, 'Too many tests — wait a few minutes');
          const cfg = bizCfg(); noteBizConfig(cfg); if (!cfg.sp.configured) throw fail(503, cfg.sp.enabled ? `SharePoint is not configured (${cfg.sp.missing.join(', ')})` : 'SharePoint is not switched on');
          try {
            const site = await appGraph(cfg, 'GET', `/sites/${G.seg(cfg.sp.siteId, G.validSiteId)}?$select=id,displayName,webUrl`), drive = await appGraph(cfg, 'GET', `/drives/${G.seg(cfg.sp.driveId, G.validDriveId)}?$select=id,name,driveType`);
            const names = { site: String(site.displayName || '').slice(0, 120), drive: String(drive.name || '').slice(0, 120) };
            db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run('m365_sp_names', JSON.stringify(names)); mark('sharepoint', true);
            audit(req, 'sharepoint-test', 'm365', 0, `site "${names.site}", library "${names.drive}"`);
            return send(res, 200, { ok: 1, site_name: names.site, library_name: names.drive }), true;
          } catch (x) { mark('sharepoint', false, x.message); throw fail(502, x.graph ? x.message : 'SharePoint could not be reached', x.code); }
        }
        if (b === 'teams' && c === 'test' && m === 'POST') {
          if (limited('test:' + me.id, 10, 600e3)) throw fail(429, 'Too many tests — wait a few minutes');
          const cfg = bizCfg(); noteBizConfig(cfg); if (!cfg.teams.enabled) throw fail(503, 'Teams notifications are not switched on');
          const r = await teamsPost(cfg, 'test', { title: 'Trigon ERP: test notification', facts: [{ title: 'Sent by', value: me.username }, { title: 'Purpose', value: 'Checking the Teams channel connection' }], link: link(cfg, 'settings') });
          audit(req, 'teams-test', 'm365', 0, 'test notification sent'); return send(res, 200, r), true;
        }
        if (b === 'teams' && c === 'overdue' && m === 'POST') { if (limited('ov:' + me.id, 5, 3600e3)) throw fail(429, 'Too many — wait a while'); return send(res, 200, await overdue(me)), true; }
        if (b === 'migrate' && m === 'POST') {                     // dry run unless {execute:true}; never deletes anything
          if (limited('mig:' + me.id, 5, 3600e3)) throw fail(429, 'Too many — wait a while');
          const x = await readBody(req); const rep = await ctx.m365Migrate({ execute: x.execute === true, limit: x.limit, by: me.username });
          audit(req, 'sharepoint-migrate', 'm365', 0, `${rep.execute ? 'executed' : 'dry run'}: planned ${rep.planned}, uploaded ${rep.uploaded}, unchanged ${rep.unchanged}, skipped ${rep.skipped.length}, failed ${rep.failed.length}`);
          return send(res, 200, rep), true;
        }
        return send(res, 404, { error: 'not found' }), true;
      } catch (e) { return out(res, e), true; }
    },
  };
};
