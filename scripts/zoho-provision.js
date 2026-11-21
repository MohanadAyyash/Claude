#!/usr/bin/env node
// ONE controlled, non-VAT account-provisioning run against the real Zoho Books organisation — from an ISOLATED COPY of Trigon's data.
//
//   node --no-warnings scripts/zoho-provision.js --data "D:\Trigon-preflight\data" --org <organisation id>
//        --petty-cash-id <Zoho id> --retained-earnings-id <Zoho id> [--partner-subaccounts] [--out <folder>] [--yes]
//
// What it may do, and nothing else (enforced around every network request, before it is sent):
//   - Zoho Books API: GET; and POST /chartofaccounts — only while provisioning, at most once per account in the authorised plan.
//   - The OAuth access-token request (grant_type=refresh_token). Every other request is refused and logged.
// The authorisation is fixed below (AUTH). The plan read from Zoho must match it exactly (names, codes, types, parent, the Petty Cash
// and Retained Earnings ids, the 1020 → 1010 legacy repair) — otherwise it stops before the first change.
// Order: read-only preflight + plan → checks → confirmation → provisioning (stops at the first failure) → read back every account →
// 1010 / 1020 / 1030 distinct → read-only preflight again (READY_NON_VAT, zeros) → read-only Trial Balance reconciliation → report.
// Never: a VAT account or tax, 6150, a transaction, document, journal or payment; continuous sync is not switched on.
// Exit code: 0 provisioned and verified · 2 refused before any change · 3 could not run · 4 STOPPED after a failure (see the report).
'use strict';
const fs = require('fs'), path = require('path'), readline = require('readline'), crypto = require('crypto');
const { inspectEnv, preflightTimeout } = require('./zoho-preflight.js');

// ---------- the authorisation (accounting decision of 2026-11-20): exactly these, nothing else ----------
const AUTH = {
  create: [
    ['1020', 'Cash on Hand', 'cash'], ['1030', 'Employee Cash Custody', 'cash'], ['1050', 'Cheques in Hand / PDC Received', 'other_current_asset'],
    ['1600', 'Fixed Assets', 'fixed_asset'], ['1690', 'Accumulated Depreciation', 'fixed_asset', '1600'], ['2050', 'Cheques Issued / PDC Payable', 'other_current_liability'],
    ['2260', 'Employee Expense Claims Payable', 'other_current_liability'], ['2400', 'Advances from Customers', 'other_current_liability'],
    ['3900', 'Opening Balance Equity', 'equity'], ['6100', 'Depreciation', 'expense'],
    ['3000', 'Partner Capital', 'equity'], ['2500', 'Partner Loans', 'long_term_liability'], ['3110', 'Partner Current Accounts', 'equity'],
  ],
  repair: 'repair:1020>1010',                                // CREATE Cash on Hand → REMOVE_MAPPING_ONLY 1020 → ADOPT 1010 Petty Cash → MAP 1020
  never: ['1010', '3100', '1200', '2100', '6150'],           // never created
  notAdopted: ['acct:1200', 'acct:2100', 'tax:5', 'acct:6150'],   // VAT_PENDING / ACCOUNTING_CHANGE_PENDING: never adopted in this run
  partnerParents: ['3000', '2500', '3110'],
};

// ---------- the request guard ----------
const requests = [], guard = { phase: 'read', budget: 0, creates: 0 };
const isMock = h => !!process.env.ZOHO_ACCOUNTS_URL && /^(localhost|127\.0\.0\.1)$/.test(h);   // automated tests only
function decide(url, opts) {
  const u = new URL(String(url)), method = String((opts && opts.method) || 'GET').toUpperCase(), host = u.hostname;
  const booksHost = /^www\.zohoapis\.[a-z.]+$/.test(host) || isMock(host), books = booksHost && /^\/books\//.test(u.pathname);
  const token = (/^accounts\.zoho\.[a-z.]+$/.test(host) || isMock(host)) && u.pathname === '/oauth/v2/token' && method === 'POST' && /(^|&)grant_type=refresh_token(&|$)/.test(String((opts && opts.body) || ''));
  const create = books && method === 'POST' && /^\/books\/v3\/chartofaccounts$/.test(u.pathname) && guard.phase === 'provision' && guard.creates < guard.budget;
  const decision = books && method === 'GET' ? 'read' : create ? 'create account' : token ? 'access token' : 'BLOCKED';
  if (create) guard.creates++;
  const entry = { time: new Date().toISOString(), phase: guard.phase, method, host, path: u.pathname, decision };
  if (create) try { const b = JSON.parse(String(opts.body || '{}')); entry.account = { code: b.account_code || '', name: b.account_name || '', type: b.account_type || '', parent_id: b.parent_account_id || '' }; } catch { entry.account = { unreadable: true }; }
  requests.push(entry);
  return decision;
}
module.exports = { decide, guard, requests, AUTH };                                      // (tests)
if (require.main !== module) return;

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) : d; };
const die = (m, code = 3) => { console.error('\n✖ ' + m + '\n'); process.exit(code); };
const ID = /^\d{1,25}$/;

// ---------- 1. the isolated copy and the arguments ----------
const data = arg('data');
if (!data || data === true) die('Give the folder of the ISOLATED COPY of the data:  --data "D:\\Trigon-preflight\\data"');
const dataDir = path.resolve(String(data));
if (/^[a-z]:\\erp\\data\\?$/i.test(dataDir) || dataDir === path.resolve(__dirname, '..', 'data') && /^[a-z]:\\erp\\/i.test(dataDir)) die(`${dataDir} looks like the live data folder. Copy the data to a separate folder and point --data at the copy.`);
if (!fs.existsSync(path.join(dataDir, 'erp.db'))) die(`No erp.db in ${dataDir}. Copy a backup there and name it erp.db.`);
const ORG = String(arg('org', '')), PETTY = String(arg('petty-cash-id', '')), RE = String(arg('retained-earnings-id', '')), SUBS = !!arg('partner-subaccounts');
if (!ID.test(ORG) || !ID.test(PETTY) || !ID.test(RE)) die('Give --org <organisation id> --petty-cash-id <Zoho id of Petty Cash> --retained-earnings-id <Zoho id of Retained Earnings> (digits only).');
if (PETTY === RE) die('--petty-cash-id and --retained-earnings-id must be different accounts.');
const envFile = path.join(__dirname, '..', '.env'), envInfo = inspectEnv(fs.existsSync(envFile) ? fs.readFileSync(envFile) : null);
if (fs.existsSync(envFile)) { const m = fs.readFileSync(envFile, 'utf8').match(/^\s*DATA_DIR\s*=\s*(.+)\s*$/m); if (m && path.resolve(m[1].replace(/^["']|["']$/g, '')) !== dataDir) die(`.env sets DATA_DIR=${m[1]}; this run must use only the copy. Remove DATA_DIR from the .env of this isolated program folder.`); }
if (envInfo.blocking.length) die('The .env of this program folder is not read correctly — nothing was sent:\n  ' + envInfo.blocking.join('\n  '));
const outDir = path.resolve(String(arg('out', path.join(path.dirname(dataDir), `zoho-provision-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)}`))));

// ---------- 2. the guard, before any Trigon code is loaded ----------
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const decision = decide(url, opts), entry = requests[requests.length - 1], u = new URL(String(url));
  if (decision === 'BLOCKED') { entry.outcome = 'not sent'; throw new Error(`provisioning run: ${entry.method} ${u.host}${u.pathname} refused (phase ${guard.phase}) — not sent`); }
  if (u.protocol === 'data:') return realFetch(url, opts);
  try { const r = await realFetch(url, opts); entry.outcome = 'HTTP ' + r.status;
    if (decision === 'create account') try { const j = await r.clone().json(); const a = j.chart_of_account || {}; entry.zoho_id = a.account_id ? String(a.account_id) : ''; entry.zoho_code = j.code; } catch { /* (the response is read again by the client) */ }
    return r; }
  catch (e) { entry.outcome = 'failed ' + ((e.cause && (e.cause.code || e.cause.name)) || e.name || ''); throw e; }
};

// ---------- 3. Trigon on the copy, every scheduler off ----------
Object.assign(process.env, { DATA_DIR: dataDir, ZOHO_NO_SCHEDULER: '1', SALES_NO_SCHEDULER: '1', BACKUP_NO_SCHEDULER: '1', M365_SYNC_INTERVAL_SECONDS: '3600' });
const ask = q => arg('yes') ? (console.log(q + ' YES (--yes)'), Promise.resolve(true)) : new Promise(res => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question(q + ' Type YES to continue: ', a => { rl.close(); res(a.trim() === 'YES'); }); });
const report = { generated: new Date().toISOString(), data_copy: dataDir, organization_id: ORG, authorization: AUTH, partner_subaccounts_authorised: SUBS, steps: [] };
const step = (name, ok, detail) => { report.steps.push({ name, ok, ...(detail ? { detail } : {}) }); console.log(`  ${ok ? '✔' : '✖'} ${name}${detail && typeof detail === 'string' ? ' — ' + detail : ''}`); return ok; };
function save(verdict) {
  report.verdict = verdict;
  report.modifying_calls = requests.filter(x => x.decision === 'create account').map(x => ({ time: x.time, method: x.method, path: x.path, ...x.account, outcome: x.outcome, zoho_id: x.zoho_id || '' }));
  report.blocked_attempts = requests.filter(x => x.decision === 'BLOCKED');
  report.requests = { total: requests.length, reads: requests.filter(x => x.decision === 'read').length, access_tokens: requests.filter(x => x.decision === 'access token').length, account_creations: report.modifying_calls.length, blocked: report.blocked_attempts.length };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'provision-report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(outDir, 'request-log.csv'), 'time,phase,method,host,path,decision,outcome,account_code,account_type,zoho_id\n'
    + requests.map(x => [x.time, x.phase, x.method, x.host, x.path, x.decision, x.outcome || '', x.account ? x.account.code : '', x.account ? x.account.type : '', x.zoho_id || ''].join(',')).join('\n') + '\n');
  console.log(`\nModifying calls sent to Zoho: ${report.modifying_calls.length} (all POST /chartofaccounts) · reads ${report.requests.reads} · access tokens ${report.requests.access_tokens} · refused by the guard ${report.requests.blocked}`);
  for (const m of report.modifying_calls) console.log(`  ${m.time}  POST /chartofaccounts  ${String(m.code).padEnd(10)} ${String(m.name).padEnd(42)} ${String(m.type).padEnd(24)} ${m.parent_id ? 'parent ' + m.parent_id + '  ' : ''}${m.outcome} → ${m.zoho_id || '(no id)'}`);
  console.log(`Saved: ${path.join(outDir, 'provision-report.json')}\n\nVERDICT: ${verdict}\n`);
}
const stopNow = (why, code = 4) => { console.log(`\nSTOPPED: ${why}`); report.stopped = why; save(code === 2 ? 'REFUSED — nothing was changed in Zoho' : 'STOPPED — see the report; do not run again before the cause is understood'); process.exit(code); };

(async () => {
  const { ctx } = require('../server.js');
  if (process.env.DATA_DIR !== dataDir) die('DATA_DIR changed while loading — stopped before reading anything from Zoho.');
  const A = ctx.zohoAcct, X = ctx.zohoX, db = ctx.db, c0 = X.cfg();
  if (!A || !X) die('This program folder has no account provisioning (wrong branch?).');
  const T = preflightTimeout(process.env.ZOHO_PREFLIGHT_TIMEOUT_MS); let dispatcher = null;
  try { await realFetch('data:,'); const G = globalThis[Symbol.for('undici.globalDispatcher.1')]; if (G && typeof G.constructor === 'function') dispatcher = new G.constructor({ connect: { timeout: T }, headersTimeout: T, bodyTimeout: T }); } catch { dispatcher = null; }
  ctx.zohoNet = { timeout: 2 * T, dispatcher, connectRetry: true, retryDelay: 2000 };
  const hash = sql => crypto.createHash('sha256').update(JSON.stringify(db.prepare(sql).all())).digest('hex');
  const SENT = 'SELECT * FROM zoho_sync ORDER BY rowid', mapRow = k => db.prepare("SELECT * FROM zoho_map WHERE kind='account' AND local_key=?").get(k);
  const sentBefore = hash(SENT), runsBefore = hash('SELECT * FROM zoho_runs ORDER BY rowid');
  const auditBefore = db.prepare("SELECT id, ts, user, action, detail FROM audit_log WHERE tbl='zoho_map' ORDER BY id").all();

  // ---------- 4. connection, organisation, switches ----------
  const conn = ctx.zohoConnection();
  console.log(`\nZoho connection (from the copy): organisation ${conn.organization_id || '(none)'}, data centre ${conn.data_centre}; data copy ${dataDir}`);
  if (!conn.connected) die('Not connected to Zoho in this copy.', 2);
  if (String(conn.organization_id) !== ORG) die(`The copy is connected to organisation ${conn.organization_id}, not ${ORG} — nothing was sent.`, 2);
  if (c0.continuous === '1') die('Continuous sync is ON in this copy — switch it off first. This run never sends transactions.', 2);
  let org; try { org = await ctx.zohoOrganization(); } catch (e) { die('Could not read the organisation: ' + String(e.message).slice(0, 300), 3); }
  if (!org || String(org.id) !== ORG) die(`Organisation ${ORG} not found with this connection.`, 2);
  report.organization = org; console.log(`Organisation: ${org.name} (ID ${org.id}, ${org.currency})`);

  // ---------- 5. read only: the preflight and the plan, checked against the authorisation ----------
  console.log('\n1. Read-only preflight and provisioning plan');
  let g0; try { g0 = await A.preflightAndGate('provision script', 'before the controlled provisioning run'); } catch (e) { die('The preflight could not run: ' + String(e.message).slice(0, 300)); }
  const p = g0.plan, e0 = g0.gate.expected_after_provisioning, zero = o => o && Object.values(o).every(v => v === 0);
  report.before = { gate: g0.gate.state, expected_after_provisioning: e0, counts: p.counts, vat: p.vat_state, deferred: p.deferred, token: p.token };
  const bad = [];
  if (p.error || p.state === 'Error') bad.push('the plan could not be read: ' + (p.error || ''));
  if (!e0 || e0.state !== 'READY_NON_VAT' || !zero(e0.targets_non_vat)) bad.push(`expected after provisioning is ${e0 && e0.state} ${JSON.stringify(e0 && e0.targets_non_vat)} — must be READY_NON_VAT with every non-VAT target 0`);
  if (g0.gate.vat !== 'VAT_PENDING') bad.push(`VAT is ${g0.gate.vat}, expected VAT_PENDING`);
  if (!(p.deferred || []).some(d => d.code === '6150')) bad.push('6150 is not deferred (ACCOUNTING_CHANGE_PENDING)');
  // creations: exactly the authorised accounts (the partner sub-accounts only with --partner-subaccounts)
  const auth = Object.fromEntries(AUTH.create.map(([code, name, type, parent]) => [code, { name, type, parent }]));
  const main = p.mutations.filter(m => !/:p\d+$/.test(m.key)), subs = p.mutations.filter(m => /:p\d+$/.test(m.key));
  const codes = main.map(m => m.body.account_code).sort(), want = Object.keys(auth).sort();
  if (JSON.stringify(codes) !== JSON.stringify(want)) bad.push(`the accounts to create are [${codes.join(', ')}], authorised [${want.join(', ')}]`);
  for (const m of main) { const a = auth[m.body.account_code]; if (!a) continue;
    if (m.body.account_name !== a.name || m.body.account_type !== a.type) bad.push(`${m.body.account_code}: payload "${m.body.account_name}" ${m.body.account_type}, authorised "${a.name}" ${a.type}`);
    if (a.parent ? !m.body.parent_account_id || m.parent_name !== auth[a.parent].name : m.body.parent_account_id) bad.push(`${m.body.account_code}: parent ${m.parent_name || '(none)'}, authorised ${a.parent ? auth[a.parent].name : '(none)'}`); }
  if (subs.length && !SUBS) bad.push(`the plan also creates ${subs.length} partner sub-account(s), not in this authorisation: ${subs.map(m => `${m.body.account_code} "${m.body.account_name}"`).join('; ')} — run again with --partner-subaccounts only if they are authorised`);
  for (const m of subs) { const par = m.key.split(':')[1]; if (!AUTH.partnerParents.includes(par) || m.body.account_type !== auth[par].type || m.parent_name !== auth[par].name) bad.push(`partner sub-account ${m.body.account_code}: not under ${par} ${auth[par] ? auth[par].name : ''} with its type`); }
  for (const m of p.mutations) if (AUTH.never.includes(String(m.body.account_code)) || /^(1200|2100|6150)\b/.test(m.body.account_code)) bad.push(`${m.body.account_code} must never be created`);
  const m1020 = main.find(m => m.body.account_code === '1020'); if (!m1020 || m1020.repair !== AUTH.repair) bad.push('1020 Cash on Hand is not created by the legacy repair');
  // the repair: CREATE Cash on Hand → REMOVE 1020 → Petty Cash → ADOPT 1010 → Petty Cash → MAP 1020 → the new account
  const r10 = p.rows.find(r => r.key === 'acct:1010'), rp = r10 && r10.repair;
  if (!rp || rp.state !== 'PROPOSED') bad.push(`the legacy repair is ${rp ? rp.state : 'not proposed'}`);
  else { const ops = rp.operations.map(o => [o.op, o.trigon_key, o.zoho_id]);
    if (JSON.stringify(ops) !== JSON.stringify([['CREATE_APPROVED', 'acct:1020', null], ['REMOVE_MAPPING_ONLY', 'acct:1020', PETTY], ['ADOPT_EXISTING', 'acct:1010', PETTY], ['MAP', 'acct:1020', '(newly created)']])) bad.push('the repair operations differ from the authorisation: ' + JSON.stringify(ops));
    if (JSON.stringify(rp.operations[0].payload) !== JSON.stringify({ account_name: 'Cash on Hand', account_code: '1020', account_type: 'cash' })) bad.push('the Cash on Hand payload differs'); }
  const others = p.confirmable.filter(c => c.key !== AUTH.repair); if (others.length) bad.push(`other confirmations are proposed (${others.map(c => c.key).join(', ')}) — not in this authorisation`);
  // adoptions (Trigon side only): 3100 → the system Retained Earnings; the rest only by exact code or as Zoho's AR / AP system accounts; never VAT / 6150
  const a3100 = p.adopts.find(a => a.key === 'acct:3100');
  if (!a3100 || a3100.zoho_id !== RE || a3100.how !== 'SYSTEM_ACCOUNT_ADOPT') bad.push(`3100 is not adopted as the system Retained Earnings ${RE}: ${JSON.stringify(a3100 || null)}`);
  const rowOf = k => [...p.rows, ...p.vat].find(r => r.key === k);
  for (const a of p.adopts) { const r = rowOf(a.key);
    if (AUTH.notAdopted.includes(a.key)) bad.push(`${a.key} must not be adopted in this run`);
    else if (!(r && (r.state === 'BY_CODE' || (r.state === 'SYSTEM_ACCOUNT' && ['3100', '1100', '2000'].includes(r.code))))) bad.push(`${a.key} would be adopted as ${r ? r.state : '?'} — only by exact code or as a system account`);
    if (String(a.zoho_id) === PETTY) bad.push(`${a.key} would be adopted onto Petty Cash`); }
  const open = [...p.rows, ...p.vat].filter(r => !r.deferred && ['ACCOUNT_CONFLICT', 'AMBIGUOUS'].includes(r.classification)); if (open.length) bad.push(`conflicts: ${open.map(r => r.code).join(', ')}`);
  report.plan = { creations: p.mutations.map(m => ({ key: m.key, ...m.body, parent_name: m.parent_name || '', repair: m.repair || '' })), adoptions: p.adopts, repair: rp ? rp.operations : null, follows: p.rows.filter(r => r.action === 'follow').map(r => ({ key: r.key, follows: r.follows })) };
  // Petty Cash and Retained Earnings as they are now (read only)
  const one = async id => { const g = await X.client(X.cfg(), true).get('/chartofaccounts/' + id); return (g && g.chart_of_account) || g; };
  const shape = a => a && { id: String(a.account_id), name: a.account_name || '', code: a.account_code || '', type: a.account_type || '', active: a.is_active !== false, system: !!a.is_system_account, parent_id: a.parent_account_id ? String(a.parent_account_id) : '' };
  let pettyBefore = null, reAcct = null; try { pettyBefore = shape(await one(PETTY)); reAcct = shape(await one(RE)); } catch (e) { bad.push('could not read Petty Cash / Retained Earnings: ' + String(e.message).slice(0, 200)); }
  if (pettyBefore && !(pettyBefore.type === 'cash' && pettyBefore.active && /^petty cash$/i.test(pettyBefore.name))) bad.push(`${PETTY} is not an active cash account named Petty Cash: ${JSON.stringify(pettyBefore)}`);
  if (reAcct && !(reAcct.type === 'equity' && reAcct.system && reAcct.active && /^retained earnings$/i.test(reAcct.name))) bad.push(`${RE} is not the system Retained Earnings account: ${JSON.stringify(reAcct)}`);
  report.petty_cash_before = pettyBefore; report.retained_earnings = reAcct;
  if (bad.length) { for (const b of bad) step('plan matches the authorisation', false, b); stopNow(`${bad.length} difference(s) between the plan and the authorisation — nothing was changed`, 2); }
  step('plan matches the authorisation', true, `${p.mutations.length} account(s) to create, ${p.adopts.length} adoption(s), legacy repair ${AUTH.repair}; expected after provisioning READY_NON_VAT with zeros; VAT_PENDING; 6150 deferred`);
  console.log('\n  Will create in Zoho (POST /chartofaccounts, in this order):');
  const order = [m1020, ...p.mutations.filter(m => m !== m1020)];
  for (const m of order) console.log(`    ${m.body.account_code.padEnd(10)} ${m.body.account_name.padEnd(42)} ${m.body.account_type.padEnd(24)}${m.parent_name ? ' under ' + m.parent_name : ''}${m.repair ? '  (legacy repair)' : ''}`);
  console.log(`  Trigon-side only: 1020 → Petty Cash mapping removed; 1010 → Petty Cash ${PETTY}; 1020 → the new Cash on Hand; 3100 → Retained Earnings ${RE}; ${p.adopts.length - 1} other account(s) adopted by exact code`);
  console.log('  Not touched: VAT (1200, 2100, Standard 5%), 6150, Petty Cash itself, any transaction; continuous sync stays OFF.');
  if (!(await ask(`\nCreate these ${p.mutations.length} account(s) in "${org.name}" now?`))) stopNow('stopped by the user before the first change', 2);

  // ---------- 6. provisioning: the first failure stops the run ----------
  console.log('\n2. Provisioning');
  guard.phase = 'provision'; guard.budget = p.mutations.length;
  let res; try { res = await A.apply(p, { user: 'administrator (controlled provisioning run)', trigger: 'provision script', confirmed: [AUTH.repair], stopOnFail: true }); }
  catch (e) { guard.phase = 'verify'; stopNow('provisioning stopped: ' + String(e.message).slice(0, 300)); }
  guard.phase = 'verify';
  report.result = res;
  if (res.failed.length) { for (const f of res.failed) step(`${f.key} ${f.name || ''}`, false, f.error); stopNow(res.stopped || 'a creation failed'); }
  if (!(res.repaired || []).length) stopNow('the legacy repair was not applied');
  step('provisioning', true, `${res.created.length} created, ${res.adopted.length} adopted, legacy repair applied`);

  // ---------- 7. read back every created / adopted account (read only) ----------
  console.log('\n3. Read back');
  const zid = k => { const m = mapRow(k); return m && m.zoho_id ? String(m.zoho_id) : ''; }, checks = [];
  const expectAcct = (key, exp) => checks.push({ key, ...exp });
  for (const m of p.mutations) { const code = m.body.account_code, key = m.key, a = auth[code], par = key.match(/^acct:(\d+):p\d+$/);
    expectAcct(key, { name: m.body.account_name, code, type: m.body.account_type, parent: par ? zid('acct:' + par[1]) : a && a.parent ? zid('acct:' + a.parent) : '', created: true }); }
  expectAcct('acct:1010', { id: PETTY, ...pettyBefore, unchanged: true });
  expectAcct('acct:3100', { id: RE, ...reAcct, unchanged: true });
  const verified = [];
  for (const x of checks) {
    const id = zid(x.key); let a = null; try { a = shape(await one(id)); } catch (e) { stopNow(`could not read back ${x.key} (${id}): ${String(e.message).slice(0, 200)}`); }
    const m = mapRow(x.key), diff = [];
    if (!id || !a || a.id !== id) diff.push(`mapping ${id} / Zoho ${a && a.id}`);
    if (x.id && id !== x.id) diff.push(`id ${id}, expected ${x.id}`);
    for (const k of ['name', 'code', 'type']) if (a && String(a[k]) !== String(x[k])) diff.push(`${k} "${a[k]}", expected "${x[k]}"`);
    if (a && String(a.parent_id || '') !== String(x.parent || x.parent_id || '')) diff.push(`parent ${a.parent_id || '(none)'}, expected ${x.parent || x.parent_id || '(none)'}`);
    if (a && !a.active) diff.push('inactive');
    if (x.unchanged && a && JSON.stringify(a) !== JSON.stringify({ id: x.id, name: x.name, code: x.code, type: x.type, active: x.active, system: x.system, parent_id: x.parent_id })) diff.push('changed since before the run');
    if (!m || !m.verified_at) diff.push('mapping not verified');
    verified.push({ key: x.key, zoho_id: id, name: a && a.name, code: a && a.code, type: a && a.type, parent_id: a && a.parent_id, active: a && a.active, how: x.created ? 'CREATED' : x.key === 'acct:3100' ? 'ADOPTED (system Retained Earnings)' : 'ADOPTED (existing Petty Cash, unchanged)', ok: !diff.length, diff });
    if (!step(`${x.key} → ${id} "${a && a.name}" ${a && a.type}${a && a.parent_id ? ' under ' + a.parent_id : ''}`, !diff.length, diff.join('; '))) { report.verified = verified; stopNow(`read-back of ${x.key} failed`); }
  }
  report.verified = verified;
  const d3 = ['1010', '1020', '1030'].map(c => zid('acct:' + c));
  if (!step('1010 / 1020 / 1030 on three distinct Zoho accounts', d3.every(Boolean) && new Set(d3).size === 3, d3.join(' / '))) stopNow('1010, 1020 and 1030 are not three distinct Zoho accounts');
  if (!step('1020 is the new Cash on Hand', zid('acct:1020') === (res.created.find(c => c.code === '1020') || {}).zoho_id)) stopNow('1020 is not mapped to the new Cash on Hand');
  const coa = (await X.client(X.cfg(), true).get('/chartofaccounts', { filter_by: 'AccountType.All' })).chartofaccounts || [];
  const banks = (await X.client(X.cfg(), true).get('/bankaccounts')).bankaccounts || [], all = [...coa, ...banks.filter(b => !coa.some(a => String(a.account_id) === String(b.account_id)))];
  const dup = p.mutations.map(m => m.body.account_code).filter(code => all.filter(a => String(a.account_code || '') === code).length !== 1);
  const pettyN = all.filter(a => /^petty cash$/i.test(String(a.account_name || '').trim())).length;
  if (!step('each created code exists exactly once in Zoho; one Petty Cash', !dup.length && pettyN === 1, dup.length ? 'duplicates / missing: ' + dup.join(', ') : `Petty Cash accounts: ${pettyN}`)) stopNow('duplicate or missing accounts in Zoho');
  const auditAfter = db.prepare("SELECT id, ts, user, action, detail FROM audit_log WHERE tbl='zoho_map' ORDER BY id").all();
  const kept = auditBefore.every(b => auditAfter.some(a => a.id === b.id && a.detail === b.detail && a.ts === b.ts)), repairAudit = auditAfter.filter(a => a.action === 'legacy_mapping_repair' && !auditBefore.some(b => b.id === a.id));
  if (!step('historical mapping audit kept; one legacy_mapping_repair audit record added', kept && repairAudit.length === 1, `${auditBefore.length} earlier record(s) kept`)) stopNow('the mapping audit trail is not as expected');
  report.audit = { earlier_records_kept: auditBefore.map(a => ({ id: a.id, ts: a.ts, action: a.action })), repair_record: repairAudit[0] || null };

  // ---------- 8. the read-only preflight again ----------
  console.log('\n4. Read-only preflight after provisioning');
  const g1 = await A.preflightAndGate('provision script', 'after the controlled provisioning run'), G = g1.gate;
  report.after = { gate: G.state, targets_non_vat: G.targets_non_vat, vat: G.vat, deferred: (g1.plan.deferred || []).map(d => d.code + ' ACCOUNTING_CHANGE_PENDING'), counts: g1.plan.counts, mutations_left: g1.plan.mutations.length, reasons: G.reasons };
  step(`Gate = ${G.state}`, G.state === 'READY_NON_VAT');
  for (const [k, v] of Object.entries(G.targets_non_vat)) step(`non-VAT ${k.replace(/_/g, ' ')} = ${v}`, v === 0);
  step(`VAT = ${G.vat}`, G.vat === 'VAT_PENDING');
  step(`6150 = ${(g1.plan.deferred || []).some(d => d.code === '6150') ? 'ACCOUNTING_CHANGE_PENDING' : 'NOT DEFERRED'}`, (g1.plan.deferred || []).some(d => d.code === '6150'));
  step(`nothing left to create (${g1.plan.mutations.length})`, g1.plan.mutations.length === 0);
  if (report.steps.slice(-8).some(s => !s.ok)) stopNow('the preflight after provisioning is not READY_NON_VAT with zeros');

  // ---------- 9. the Trial Balance reconciliation (read only) ----------
  console.log('\n5. Trial Balance reconciliation (read only)');
  let rc; try { rc = await A.reconcile({ user: 'provision script', trigger: 'provision script', basis: 'balance' }); }
  catch (e) { rc = { status: 'FAILED', error: String(e.message).slice(0, 300) }; }
  report.reconciliation = rc && { id: rc.id, status: rc.status, cutoff: rc.cutoff, summary: rc.summary, tb: rc.tb, statements: rc.statements, error: rc.error };
  step(`reconciliation ran: ${rc.status}`, !!rc && rc.status !== 'FAILED', rc.summary ? `TB rows ${rc.summary.tb.rows}: match ${rc.summary.tb.match}, difference ${rc.summary.tb.difference}, Zoho-only ${rc.summary.tb.zoho_only}, missing mapping ${rc.summary.tb.missing_mapping} (differences are expected: no transaction has been sent yet)` : rc.error);

  // ---------- 10. proof: only accounts were created ----------
  console.log('\n6. Proof');
  const creates = requests.filter(x => x.decision === 'create account');
  step(`modifying calls: ${creates.length} — all POST /chartofaccounts during provisioning`, creates.length === p.mutations.length && creates.every(x => x.method === 'POST' && /\/chartofaccounts$/.test(x.path) && x.phase === 'provision'));
  step('no request refused by the guard', !requests.some(x => x.decision === 'BLOCKED'));
  step('no transaction, document, journal or payment sent (Trigon send log unchanged; no sync run)', hash(SENT) === sentBefore && hash('SELECT * FROM zoho_runs ORDER BY rowid') === runsBefore);
  step('continuous sync still OFF', X.cfg().continuous !== '1');
  const allOk = report.steps.every(s => s.ok);
  report.zoho_ids = verified.map(v => ({ trigon: v.key, zoho_id: v.zoho_id, name: v.name, code: v.code, type: v.type, how: v.how }));
  console.log('\nZoho IDs created / adopted:'); for (const v of report.zoho_ids) console.log(`  ${v.trigon.padEnd(14)} ${v.zoho_id.padEnd(22)} ${String(v.code || '').padEnd(10)} ${String(v.name).padEnd(42)} ${v.how}`);
  console.log(`  acct:1020 (repair) ${zid('acct:1020')} — the new Cash on Hand`);
  save(allOk ? 'PROVISIONED AND VERIFIED — READY_NON_VAT. Continuous sync is OFF. Stop here.' : 'STOPPED — see the report');
  process.exit(allOk ? 0 : 4);
})().catch(e => { console.error('\n✖ ' + String(e && e.stack || e).slice(0, 800)); try { save('STOPPED — unexpected error'); } catch { /* */ } process.exit(4); });
