#!/usr/bin/env node
// Zoho preflight against the real Zoho Books organisation — READ ONLY — from an ISOLATED COPY of Trigon's data.
//
//   node --no-warnings scripts/zoho-preflight.js --data "D:\Trigon-preflight\data" [--from 2026-11-01] [--to 2026-12-31] [--out <folder>] [--yes]
//
// Guarantees, enforced here around every network request (not only by the Zoho client):
//   - Zoho Books API: GET only. Any POST / PUT / PATCH / DELETE is refused before it is sent.
//   - The only other request allowed is the OAuth access-token request (POST accounts.zoho.<dc>/oauth/v2/token with
//     grant_type=refresh_token): Zoho's sign-in server issues a one-hour access token from the stored refresh token. It is not
//     sent to Zoho Books and changes nothing in the organisation. It is logged and counted separately.
//   - Every other request (Microsoft 365, GitHub, e-mail, anything) is refused and logged.
// Every request is logged (time, method, host, path, decision — never a token or a body) and the log is saved with the report.
// Trigon's own copy is checked too: the Zoho send log, mappings, settings and runs must be byte-for-byte unchanged.
// Exit code: 0 READY · 1 READY WITH MISSING MAPPINGS · 2 BLOCKED · 3 could not run.
'use strict';
const fs = require('fs'), path = require('path'), readline = require('readline'), crypto = require('crypto');

// ---------- the request guard: every request is logged and decided before it is sent ----------
const requests = [];
const isMock = h => !!process.env.ZOHO_ACCOUNTS_URL && /^(localhost|127\.0\.0\.1)$/.test(h);   // automated tests only
function decide(url, opts) {
  const u = new URL(String(url)), method = String((opts && opts.method) || 'GET').toUpperCase(), host = u.hostname;
  const books = (/^www\.zohoapis\.[a-z.]+$/.test(host) || isMock(host)) && /^\/books\//.test(u.pathname);
  const token = (/^accounts\.zoho\.[a-z.]+$/.test(host) || isMock(host)) && u.pathname === '/oauth/v2/token' && method === 'POST' && /(^|&)grant_type=refresh_token(&|$)/.test(String((opts && opts.body) || ''));
  const decision = books && method === 'GET' ? 'read' : token ? 'access token' : 'BLOCKED';
  requests.push({ time: new Date().toISOString(), method, host, path: u.pathname, decision });
  return decision;
}
// ---------- the .env file of the isolated copy: encoding, line endings and which keys Node will actually read (never values) ----------
const ZKEYS = ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN', 'ZOHO_DC'];
function inspectEnv(buf) {
  if (!buf) return { exists: false, encoding: null, line_endings: null, keys: [], problems: [], blocking: [] };
  const b = Buffer.from(buf), problems = [], blocking = [];
  const enc = b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF ? 'utf-8 with BOM' : b[0] === 0xFF && b[1] === 0xFE ? 'utf-16le' : b[0] === 0xFE && b[1] === 0xFF ? 'utf-16be'
    : b.includes(0) ? 'utf-16 (no BOM)' : 'utf-8';
  if (/utf-16/.test(enc)) {
    blocking.push(`.env is saved as ${enc.toUpperCase()} (PowerShell Out-File, ">" or -Encoding Unicode): Node cannot read any setting from it — save it as UTF-8 without BOM`);
    return { exists: true, encoding: enc, line_endings: null, keys: [], problems: blocking.slice(), blocking };
  }
  const text = b.toString('utf8'), crlf = (text.match(/\r\n/g) || []).length, lf = (text.match(/\n/g) || []).length - crlf, cr = (text.match(/\r(?!\n)/g) || []).length;
  const endings = cr ? 'CR only / mixed' : crlf && lf ? 'mixed CRLF and LF' : crlf ? 'CRLF' : lf ? 'LF' : 'single line';
  if (cr) problems.push('some lines end with CR only — Node may join them with the next line');
  const keys = [], seen = {};
  text.replace(/^\uFEFF/, '').split(/\r?\n|\r/).forEach((line, i) => {
    const t = line.trim(); if (!t || t.startsWith('#')) return;
    const m = /^(?:export\s+)?([^=\s]+)\s*=\s*(.*)$/.exec(t);
    if (!m) { problems.push(`line ${i + 1} has no "=" — ignored by Node`); return; }
    const k = m[1], v = m[2];
    seen[k] = (seen[k] || 0) + 1; if (seen[k] === 2) problems.push(`${k} appears more than once`);
    if (!keys.includes(k)) keys.push(k);
    if (ZKEYS.includes(k) && !v.replace(/^(["'`])(.*)\1$/, '$2').trim()) problems.push(`${k} is empty`);
    if (/^["'`]/.test(v) && !new RegExp(`^${v[0]}.*${v[0]}(\\s+#.*)?$`).test(v)) problems.push(`the value of ${k} starts with a quote that is not closed on the same line`);
  });
  if (enc === 'utf-8 with BOM') {
    const first = keys[0], msg = `.env starts with a byte-order mark (BOM, PowerShell -Encoding UTF8): Node reads the first setting${first ? ' (' + first + ')' : ''} under a wrong name, so it is ignored — save it as UTF-8 without BOM`;
    problems.push(msg); if (ZKEYS.includes(first) || first === 'DATA_DIR') blocking.push(msg);
    if (first) keys[0] = first + ' (unreadable: BOM)';
  }
  for (const p of problems) if (/ZOHO_/.test(p)) blocking.push(p);
  return { exists: true, encoding: enc, line_endings: endings, keys: keys.filter(k => /^(ZOHO_|DATA_DIR$|PORT$|HOST$)/.test(k)), other_keys: keys.filter(k => !/^(ZOHO_|DATA_DIR$|PORT$|HOST$)/.test(k)).length, problems: [...new Set(problems)], blocking: [...new Set(blocking)] };
}
// network settings that change how Node connects (names only — a proxy URL can carry a password)
const NETVARS = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_USE_ENV_PROXY', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_OPTIONS'];
const netEnv = env => Object.fromEntries(NETVARS.map(k => [k, env[k] != null || env[k.toLowerCase()] != null ? 'set' : 'not set']));
module.exports = { decide, requests, inspectEnv, netEnv };                            // (tests)
if (require.main !== module) return;

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) : d; };
const die = (m, code = 3) => { console.error('\n✖ ' + m + '\n'); process.exit(code); };
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// ---------- 1. the isolated copy ----------
const data = arg('data');
if (!data || data === true) die('Give the folder of the ISOLATED COPY of the data:  --data "D:\\Trigon-preflight\\data"');
const dataDir = path.resolve(String(data));
if (/^[a-z]:\\erp\\data\\?$/i.test(dataDir) || dataDir === path.resolve(__dirname, '..', 'data') && /^[a-z]:\\erp\\/i.test(dataDir)) die(`${dataDir} looks like the live data folder. Copy the data to a separate folder and point --data at the copy.`);
if (!fs.existsSync(path.join(dataDir, 'erp.db'))) die(`No erp.db in ${dataDir}. Copy a backup there and name it erp.db.`);
const envFile = path.join(__dirname, '..', '.env');
const preEnv = Object.fromEntries(ZKEYS.map(k => [k, !!process.env[k]]));               // set in Windows before .env is read (they win over .env)
const envInfo = inspectEnv(fs.existsSync(envFile) ? fs.readFileSync(envFile) : null);
if (fs.existsSync(envFile)) { const m = fs.readFileSync(envFile, 'utf8').match(/^\s*DATA_DIR\s*=\s*(.+)\s*$/m); if (m && path.resolve(m[1].replace(/^["']|["']$/g, '')) !== dataDir) die(`.env sets DATA_DIR=${m[1]}; this run must use only the copy. Remove DATA_DIR from the .env of this isolated program folder.`); }
const from = arg('from'), to = arg('to');
if ((from && !DATE.test(from)) || (to && !DATE.test(to))) die('--from / --to must be YYYY-MM-DD');
const outDir = path.resolve(String(arg('out', path.join(path.dirname(dataDir), `zoho-preflight-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)}`))));

// ---------- 2. install the guard before any Trigon code is loaded ----------
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const decision = decide(url, opts), entry = requests[requests.length - 1];
  if (decision === 'BLOCKED') { entry.outcome = 'not sent'; throw new Error(`read-only preflight: ${String((opts && opts.method) || 'GET').toUpperCase()} ${new URL(String(url)).host}${new URL(String(url)).pathname} refused — not sent`); }
  try { const r = await realFetch(url, opts); entry.outcome = 'HTTP ' + r.status; return r; }
  catch (e) { entry.outcome = 'failed ' + ((e.cause && (e.cause.code || e.cause.name)) || e.name || ''); throw e; }
};

// ---------- 3. load Trigon on the copy, with every scheduler off ----------
Object.assign(process.env, { DATA_DIR: dataDir, ZOHO_NO_SCHEDULER: '1', SALES_NO_SCHEDULER: '1', BACKUP_NO_SCHEDULER: '1', M365_SYNC_INTERVAL_SECONDS: '3600' });
const ask = q => arg('yes') ? (console.log(q + ' YES (--yes)'), Promise.resolve(true)) : new Promise(res => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question(q + ' Type YES to continue: ', a => { rl.close(); res(a.trim() === 'YES'); }); });
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

(async () => {
  const { ctx } = require('../server.js');
  if (process.env.DATA_DIR !== dataDir) die('DATA_DIR changed while loading — stopped before reading anything from Zoho.');
  const snap = () => crypto.createHash('sha256').update(['zoho_sync', 'zoho_map', 'zoho_config', 'zoho_runs'].map(t => JSON.stringify(ctx.db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all())).join('|')).digest('hex');
  const before = snap();

  // ---------- 4. confirm the connection before anything is read ----------
  const conn = ctx.zohoConnection();
  console.log('\nZoho connection (from the copy — nothing sent yet)');
  console.log(`  Connected:        ${conn.connected ? 'yes' : 'NO'}`);
  console.log(`  Organisation ID:  ${conn.organization_id || '(none)'}`);
  console.log(`  Data centre:      ${conn.data_centre}${conn.uae ? ' (UAE)' : ''}`);
  console.log(`  Sign-in server:   ${conn.accounts_url}`);
  console.log(`  API base URL:     ${conn.api_base_url || '(none)'}`);
  console.log(`  Expected for ${conn.data_centre}: ${conn.expected_api_base_url}`);
  console.log(`  Check:            ${conn.data_centre_ok === false ? '✖ ' : ''}${conn.note}`);
  console.log(`  Data copy:        ${dataDir}`);
  const cr = conn.credentials, from_ = (src, key) => src === '.env' && preEnv[key] ? 'set (Windows environment — overrides .env)' : src === 'missing' ? 'MISSING' : `set (${src})`;
  const credentials = { ZOHO_CLIENT_ID: from_(cr.client_id, 'ZOHO_CLIENT_ID'), ZOHO_CLIENT_SECRET: from_(cr.client_secret, 'ZOHO_CLIENT_SECRET'), 'Zoho refresh credential': from_(cr.refresh_token, 'ZOHO_REFRESH_TOKEN'), ZOHO_DC: `${cr.dc} (${cr.dc_source === '.env' && preEnv.ZOHO_DC ? 'Windows environment' : cr.dc_source})`, organization_id: cr.organization_id, api_domain: cr.api_domain };
  const network = { node: process.version, platform: `${process.platform} ${process.arch}`, ...netEnv(process.env) };
  console.log('\nCredentials (values are never shown)');
  for (const [k, v] of Object.entries(credentials)) console.log(`  ${(k + ':').padEnd(26)}${v}`);
  console.log(`\n.env of this program folder: ${envInfo.exists ? `${envInfo.encoding}, ${envInfo.line_endings} line endings; settings read: ${envInfo.keys.join(', ') || '(none)'}${envInfo.other_keys ? ` + ${envInfo.other_keys} other` : ''}` : 'none (settings from the Windows environment / the database only)'}`);
  for (const p of envInfo.problems) console.log(`  ${envInfo.blocking.includes(p) ? '✖' : '!'} ${p}`);
  console.log(`Network: Node ${network.node} on ${network.platform}; ${NETVARS.map(k => `${k} ${network[k]}`).join(', ')}`);
  const signIn = { credentials, env_file: envInfo, network };
  if (envInfo.blocking.length) die('The .env of this program folder is not read correctly (above) — nothing was sent. Re-create it as UTF-8 without BOM (see ZOHO-PREFLIGHT.md) and run again.', 3);
  console.log('\nNext: one access-token request to the sign-in server, then GET /organizations (read only).');
  if (!conn.connected) die('Not connected to Zoho in this copy — nothing to check.', 2);
  if (!(await ask('Read the organisation name from Zoho?'))) die('Stopped by the user — nothing was sent.', 3);
  let org = null, failure = null;
  try { org = await ctx.zohoOrganization(); } catch (e) { failure = e; console.error('  ✖ ' + e.message); }
  if (failure) {
    const d = failure.diag || { stage: 'other', kind: 'error', cause: String(failure.message).slice(0, 300) };
    const tokenStep = d.stage === 'oauth' || (requests.length > 0 && requests[requests.length - 1].decision === 'access token');   // the request that failed was the token request
    signIn.result = { step: tokenStep ? 'access-token request' : 'GET /organizations', ...d };
    console.log(`\n  ${tokenStep ? 'Access-token request' : 'Zoho Books read'} FAILED — diagnosis (no secret is shown)`);
    const line = (k, v) => v != null && v !== '' && !(Array.isArray(v) && !v.length) && console.log(`    ${(k + ':').padEnd(22)}${Array.isArray(v) ? v.join(', ') : v}`);
    line('stage', d.stage === 'connect' ? 'connection (no HTTP answer)' : d.stage === 'oauth' ? 'Zoho sign-in answered' : d.stage);
    line('host', d.host); line('kind', d.kind); line('HTTP status', d.http_status == null ? '— (no answer)' : d.http_status);
    line('cause code', d.cause_code); line('all cause codes', (d.cause_codes || []).length > 1 ? d.cause_codes : null); line('cause', d.cause); line('addresses tried', d.addresses);
    line('OAuth error', d.oauth_error); line('error description', d.oauth_error_description); line('content type', d.stage === 'oauth' ? d.content_type : null); line('what it means', d.hint);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'signin-diagnostics.json'), JSON.stringify({ generated: new Date().toISOString(), connection: { ...conn, credentials: undefined }, ...signIn, requests }, null, 2));
    fs.writeFileSync(path.join(outDir, 'request-log.csv'), 'time,method,host,path,decision,outcome\n' + requests.map(x => [x.time, x.method, x.host, x.path, x.decision, x.outcome || ''].join(',')).join('\n') + '\n');
    const modifying = requests.filter(x => x.decision !== 'BLOCKED' && x.method !== 'GET' && x.decision !== 'access token').length;
    console.log(`\nProof: ${requests.filter(x => x.decision === 'read').length} Zoho Books read(s), ${requests.filter(x => x.decision === 'access token').length} access-token request(s), ${modifying} modifying call(s) sent, ${requests.filter(x => x.decision === 'BLOCKED').length} refused by the guard; Trigon copy unchanged: ${snap() === before ? 'yes' : 'NO'}`);
    console.log(`Saved: ${path.join(outDir, 'signin-diagnostics.json')}\n\nVERDICT: BLOCKED — the sign-in did not succeed; nothing else was read.\n`);
    process.exit(2);
  }
  signIn.result = { step: 'access-token request', kind: 'ok' };
  console.log(`\n  Organisation name: ${org ? org.name : '✖ NOT FOUND'}${org ? `  (ID ${org.id}, ${org.currency}${org.country ? ', ' + org.country : ''})` : ''}`);
  if (!org) console.log('  The organisation ID of the copy is not among the organisations this connection can read.');
  if (!(await ask(`\nRun the read-only preflight for "${org ? org.name : conn.organization_id}"?`))) die('Stopped by the user — only the organisation was read.', 3);

  // ---------- 5. the preflight ----------
  let r; try { r = await ctx.zohoPreflight(from || undefined, to || undefined); } catch (e) { die('The preflight could not run: ' + e.message); }
  const pf = r.preflight, after = snap();
  const books = requests.filter(x => x.decision === 'read' || (x.decision === 'BLOCKED' && /zohoapis|localhost|127\.0\.0\.1/.test(x.host)));
  const proof = {
    requests: requests.length, books_reads: requests.filter(x => x.decision === 'read').length, access_token_requests: requests.filter(x => x.decision === 'access token').length,
    modifying_calls_sent: requests.filter(x => x.decision !== 'BLOCKED' && x.method !== 'GET' && x.decision !== 'access token').length,
    blocked_attempts: requests.filter(x => x.decision === 'BLOCKED'), by_method: requests.reduce((o, x) => (o[x.method] = (o[x.method] || 0) + 1, o), {}),
    books_methods: [...new Set(books.map(x => x.method))], local_copy_unchanged: before === after,
  };
  let verdict = pf.verdict; const blockers = [...pf.blockers];
  if (!org) blockers.unshift('The organisation was not found with this connection');
  if (proof.modifying_calls_sent) blockers.unshift(`${proof.modifying_calls_sent} modifying call(s) were sent`);
  if (proof.blocked_attempts.length) blockers.unshift(`${proof.blocked_attempts.length} request(s) were attempted and refused by the read-only guard (see the request log)`);
  if (!proof.local_copy_unchanged) blockers.unshift("Trigon's Zoho send log / mappings / settings changed during the run");
  if (blockers.length) verdict = 'BLOCKED';

  // ---------- 6. the report ----------
  fs.mkdirSync(outDir, { recursive: true });
  const report = { generated: new Date().toISOString(), data_copy: dataDir, organization: org, sign_in: signIn, ...pf, verdict, blockers, proof, errors: r.errors, ops: r.ops };
  fs.writeFileSync(path.join(outDir, 'preflight-report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(outDir, 'request-log.csv'), 'time,method,host,path,decision,outcome\n' + requests.map(x => [x.time, x.method, x.host, x.path, x.decision, x.outcome || ''].join(',')).join('\n') + '\n');
  const zcell = z => z ? `${esc(z.name)}<br><small>${esc(z.id)} · ${esc(z.type)}${z.code ? ' · code ' + esc(z.code) : ''}${z.parent ? ' · under ' + esc(z.parent) : ''}</small>` : '—';
  const row = a => `<tr class="${a.status}"><td>${esc(a.code)}</td><td>${esc(a.label || a.proposed)}</td><td>${esc(a.needed || '')}</td><td>${esc(a.expected)}</td><td><b>${esc(a.status.replace('_', ' '))}</b></td><td>${zcell(a.zoho)}</td><td>${esc(a.note || '')}${a.candidates && a.candidates.length ? `<br><small>accounts of the right type: ${a.candidates.map(c => esc(`${c.name} (${c.id}${c.code ? ', ' + c.code : ''})`)).join('; ')}</small>` : ''}</td></tr>`;
  const tbl = (head, rows) => `<table><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr>${rows.join('')}</table>`;
  const html = `<!doctype html><meta charset="utf-8"><title>Zoho preflight — ${esc(org ? org.name : conn.organization_id)}</title>
<style>body{font:14px Arial,sans-serif;margin:24px;color:#222}table{border-collapse:collapse;margin:8px 0 20px;width:100%}th,td{border:1px solid #bbb;padding:4px 6px;text-align:left;vertical-align:top}th{background:#eee}
.v{font-size:22px;font-weight:bold;padding:10px;border:2px solid}.READY{color:#060}.BLOCKED{color:#a00}.MISSING{color:#a60}.type_mismatch td,.not_found td{background:#fdd}.missing td,.ambiguous td{background:#ffe9c4}.mapped td,.automatic td{background:#eef9ee}small{color:#555}</style>
<h1>Zoho preflight (read only)</h1><p>${esc(report.generated)} · data copy ${esc(dataDir)} · period ${esc(pf.period.from || '…')} → ${esc(pf.period.to)}</p>
<div class="v ${verdict === 'READY' ? 'READY' : verdict === 'BLOCKED' ? 'BLOCKED' : 'MISSING'}">Verdict: ${esc(verdict)}</div>
${blockers.length ? `<h2>Blocking</h2><ul>${blockers.map(b => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}
${pf.to_configure.length ? `<h2>To configure in Zoho before the new sync (#24) can be enabled</h2><ol>${pf.to_configure.map(b => `<li>${esc(b)}</li>`).join('')}</ol>` : ''}
<h2>Connection</h2>${tbl(['Item', 'Value'], [['Connected', conn.connected ? 'yes' : 'no'], ['Organisation', org ? `${org.name} (ID ${org.id}, ${org.currency})` : 'NOT FOUND'], ['Organisation ID in Trigon', conn.organization_id], ['Data centre', conn.data_centre + (conn.uae ? ' (UAE)' : '')], ...Object.entries(credentials), ['.env', envInfo.exists ? `${envInfo.encoding}, ${envInfo.line_endings}` : 'none'], ['Node', network.node], ['Sign-in server', conn.accounts_url], ['API base URL', conn.api_base_url], ['Expected API base URL', conn.expected_api_base_url], ['Data-centre check', conn.note]].map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`))}
<h2>Proof: zero modifying calls</h2>${tbl(['Item', 'Value'], [['Requests in total', proof.requests], ['Zoho Books API reads (GET)', proof.books_reads], ['Methods sent to the Zoho Books API', proof.books_methods.join(', ') || '—'], ['Access-token requests (sign-in server, not Books)', proof.access_token_requests], ['Modifying calls sent (POST / PUT / PATCH / DELETE to Books)', proof.modifying_calls_sent], ['Requests refused by the guard', proof.blocked_attempts.length], ["Trigon copy: send log, mappings, settings and runs unchanged", proof.local_copy_unchanged ? 'yes' : 'NO']].map(([k, v]) => `<tr><td>${esc(k)}</td><td><b>${esc(v)}</b></td></tr>`))}<p>Every request is in <code>request-log.csv</code>.</p>
<h2>Summary of what a send would do</h2>${tbl(['Would create', 'Would update', 'Would delete', 'Already synced (unchanged)', 'Possible duplicates', 'Conflicts', 'Skipped', 'Errors'], [`<tr>${Object.values(pf.summary).map(v => `<td>${v}</td>`).join('')}</tr>`])}
<h2>Already synced (Trigon's send log)</h2>${tbl(['Group', 'Status / count'], Object.entries(pf.already_synced).map(([g, s]) => `<tr><td>${esc(g)}</td><td>${esc(Object.entries(s).map(([k, v]) => `${k}: ${v}`).join(' · '))}</td></tr>`))}
<h2>Accounts required by the proposed synchronisation</h2><p>Matched by our mapping and validated by Zoho account type — never by a similar name. "Automatic" only when Zoho has exactly one account of the required type.</p>
${tbl(['Trigon', 'Account', 'Needed by', 'Expected Zoho type', 'Status', 'Zoho account', 'Note'], pf.required_accounts.map(row))}
<h2>Partner accounts (proposed hierarchy — not created)</h2>${pf.partner_accounts.length ? pf.partner_accounts.map(p => `<h3>${esc(p.partner)}</h3>${tbl(['Trigon', 'Proposed Zoho account', 'Parent', 'Expected type', 'Status', 'Zoho account', 'Note'], p.accounts.map(a => `<tr class="${a.status}"><td>${esc(a.code)}</td><td>${esc(a.proposed)}</td><td>${esc(a.parent)}</td><td>${esc(a.expected)}</td><td><b>${esc(a.status.replace('_', ' '))}</b></td><td>${zcell(a.zoho)}</td><td>${esc(a.note || '')}</td></tr>`))}`).join('')
    + `<pre>${['Partner Capital', 'Partner Loans', 'Partner Current Accounts'].map((parent, i) => parent + '\n' + pf.partner_accounts.map(p => `└── ${p.partner} ${['Capital', 'Loan', 'Current'][i]}`).join('\n')).map(esc).join('\n\n')}</pre>` : '<p>No partners recorded in Trigon.</p>'}
<h2>Saved Trigon → Zoho mappings</h2>${tbl(['Kind', 'Trigon', 'Zoho'], pf.mappings.map(m => `<tr><td>${esc(m.kind)}</td><td>${esc(m.local_key)}</td><td>${esc(m.label || m.zoho_id)} <small>${esc(m.zoho_id)}</small></td></tr>`))}
<h2>Conflicts and possible duplicates</h2>${pf.conflicts.length ? tbl(['Type', 'Document', 'Action', 'Why'], pf.conflicts.map(i => `<tr><td>${esc(i.kind)}</td><td>${esc(i.ref)}</td><td>${esc(i.action)}</td><td>${esc(i.why)}</td></tr>`)) : '<p>None.</p>'}
<h2>Plan per type</h2>${tbl(['Type', 'Actions'], Object.entries(pf.plan).map(([k, a]) => `<tr><td>${esc(k)}</td><td>${esc(Object.entries(a).map(([x, n]) => `${x}: ${n}`).join(' · '))}</td></tr>`))}
${(r.errors || []).length ? `<h2>Errors while reading</h2><ul>${r.errors.map(e => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}
<h2>Every record (${pf.items.length})</h2>${tbl(['Type', 'Document', 'Action', 'Why'], pf.items.map(i => `<tr><td>${esc(i.kind)}</td><td>${esc(i.ref)}</td><td>${esc(i.action)}</td><td>${esc(i.why)}</td></tr>`))}`;
  fs.writeFileSync(path.join(outDir, 'preflight-report.html'), html);

  console.log(`\nProof: ${proof.books_reads} Zoho Books read(s) (GET), ${proof.access_token_requests} access-token request(s), ${proof.modifying_calls_sent} modifying call(s) sent, ${proof.blocked_attempts.length} refused by the guard; Trigon copy unchanged: ${proof.local_copy_unchanged ? 'yes' : 'NO'}`);
  console.log(`Would create ${pf.summary.would_create} · update ${pf.summary.would_update} · delete ${pf.summary.would_delete} · already synced ${pf.summary.unchanged_already_synced} · possible duplicates ${pf.summary.possible_duplicates} · conflicts ${pf.summary.conflicts}`);
  console.log(`Required accounts: ${pf.required_accounts.filter(a => ['mapped', 'automatic'].includes(a.status)).length} ok, ${pf.required_accounts.filter(a => ['missing', 'ambiguous'].includes(a.status)).length} to map, ${pf.required_accounts.filter(a => ['type_mismatch', 'not_found'].includes(a.status)).length} wrong`);
  console.log(`\nVERDICT: ${verdict}`);
  for (const b of blockers) console.log('  ✖ ' + b);
  for (const t of pf.to_configure) console.log('  • ' + t);
  console.log(`\nReport: ${path.join(outDir, 'preflight-report.html')}\n`);
  process.exit(verdict === 'READY' ? 0 : verdict === 'BLOCKED' ? 2 : 1);
})().catch(e => die(e.stack || e.message));
