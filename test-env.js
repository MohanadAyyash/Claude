// Server settings from .env reach the server through the production start-up path:  node --no-warnings test-env.js
// The office PC's TrigonERP task runs `cmd.exe /c C:\erp\run-server.cmd` (written by deploy/windows/setup-office-server.ps1): it sets
// SETUP_TOKEN (and TRUST_PROXY=1 behind the tunnel), then `node --no-warnings server.js >> data\server.log 2>&1` in the system folder.
// This test takes that real template, applies its `set` lines and starts server.js the same way (no M365_* in the environment), with
// .env files as Windows produces them. Production failure this covers: a .env written by Windows PowerShell 5.1 (">", ">>", Out-File)
// is UTF-16, which Node's own loader silently reads as nothing, so /api/m365/status said enabled=false, tenant_id=null, secret=false.
// Also: the launcher's SETUP_TOKEN / TRUST_PROXY are kept (a .env value never overrides them), .env.txt / unreadable .env are reported
// (log + status), and no value is ever written to the log or returned by the API. Fake values only.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert'), crypto = require('crypto'), cp = require('child_process'), net = require('net');

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-env-')), APP = path.join(T, 'erp');
const SKIP = n => ['node_modules', '.git', 'data', 'dist', '.env'].includes(n) || /^(data-backup-|app-backup-|\.update-|test-)/.test(n);
fs.mkdirSync(APP);
for (const n of fs.readdirSync(__dirname)) if (!SKIP(n)) fs.cpSync(path.join(__dirname, n), path.join(APP, n), { recursive: true });
fs.symlinkSync(path.join(__dirname, 'node_modules'), path.join(APP, 'node_modules'), 'dir');

const M365 = { M365_ENABLED: '1', M365_TENANT_ID: '11111111-2222-3333-4444-555555555555', M365_CLIENT_ID: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  M365_CLIENT_SECRET: 'fake~client.secret_NOT-REAL-7q8w', M365_REDIRECT_URI: 'https://erp.example.test/auth/microsoft/callback', M365_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64') };
const SECRETS = [M365.M365_CLIENT_SECRET, M365.M365_ENCRYPTION_KEY];
const LAUNCHER_TOKEN = 'launchertoken0123456789ab', ENVFILE_TOKEN = 'envfiletoken0123456789abc';
const lines = obj => Object.entries(obj).map(([k, v]) => `${k}=${v}`).join('\r\n') + '\r\n';

// ---- run-server.cmd exactly as the setup script writes it (tunnel mode), and the environment its `set` lines give node ----
const ps1 = fs.readFileSync(path.join(__dirname, 'deploy', 'windows', 'setup-office-server.ps1'), 'utf8');
const tmpl = /\$run = @"\r?\n([\s\S]*?)\r?\n"@/.exec(ps1)[1];
const runServer = tmpl.replace(/\$AppDir/g, APP).replace(/\$token/g, LAUNCHER_TOKEN).replace(/\$proxyLine/g, 'set TRUST_PROXY=1').replace(/\$node/g, process.execPath);
const launcherEnv = Object.fromEntries([...runServer.matchAll(/^set ([A-Z_]+)=(.*)$/gm)].map(m => [m[1], m[2].trim()]));
assert.deepEqual(Object.keys(launcherEnv).sort(), ['SETUP_TOKEN', 'TRUST_PROXY'], 'run-server.cmd sets only SETUP_TOKEN and TRUST_PROXY (no secrets in the launcher)');
assert.match(runServer, /--no-warnings server\.js >> ".*[\\/]data[\\/]server\.log" 2>&1/, 'and then starts server.js with its output in data\\server.log');
assert.match(runServer, /^cd \/d "/m, 'in the system folder');
const BASE = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(M365_|DATA_DIR|PORT|HOST|SETUP_TOKEN|TRUST_PROXY|SECURE_COOKIES)/.test(k)));
Object.assign(BASE, { ZOHO_NO_SCHEDULER: '1', SALES_NO_SCHEDULER: '1', BACKUP_NO_SCHEDULER: '1' });

const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// start the server as the task does; fresh data folder per case; → { port, stop, log() }
async function start(envFile) {
  fs.rmSync(path.join(APP, 'data'), { recursive: true, force: true }); fs.mkdirSync(path.join(APP, 'data'));
  for (const f of ['.env', '.env.txt']) fs.rmSync(path.join(APP, f), { force: true });
  if (envFile) { fs.writeFileSync(path.join(APP, envFile.name || '.env'), envFile.bytes); if (envFile.mode !== undefined) fs.chmodSync(path.join(APP, envFile.name || '.env'), envFile.mode); }
  const port = await freePort(), logFile = path.join(APP, 'data', 'server.log'), fd = fs.openSync(logFile, 'a');
  const child = cp.spawn(process.execPath, ['--no-warnings', 'server.js'], { cwd: APP, env: { ...BASE, ...launcherEnv, PORT: String(port), HOST: '127.0.0.1' }, stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  for (let i = 0; ; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/api/status`); await r.text(); if (r.ok) break; } catch { /* not yet */ } if (i > 80) throw new Error('server did not start:\n' + fs.readFileSync(logFile, 'utf8')); await sleep(150); }
  return { port, log: () => fs.readFileSync(logFile, 'utf8'), stop: async () => { if (child.exitCode === null && child.signalCode === null) { const g = new Promise(r => child.once('exit', r)); child.kill(); await g; } } };
}
// first admin (with the launcher's setup token), then the M365 status as that admin
async function status(s, extra = {}) {
  const u = p => `http://127.0.0.1:${s.port}/api/${p}`, j = { 'Content-Type': 'application/json' };
  const setup = await fetch(u('setup'), { method: 'POST', headers: j, body: JSON.stringify({ username: 'admin', password: 'secret12', company: 'Test Co', token: extra.token || LAUNCHER_TOKEN }) });
  await setup.text();                                                        // (always read the body: an unread one stalls the connection)
  if (extra.token) return { setupStatus: setup.status };
  assert.equal(setup.status, 200, 'setup with the launcher token');
  const login = await fetch(u('login'), { method: 'POST', headers: { ...j, 'X-Forwarded-Proto': 'https' }, body: JSON.stringify({ username: 'admin', password: 'secret12' }) });
  const sc = login.headers.get('set-cookie') || ''; await login.text();
  const st = await fetch(u('m365/status'), { headers: { cookie: sc.split(';')[0] } });
  const text = await st.text();
  for (const v of SECRETS) assert.ok(!text.includes(v), 'no secret in the status answer');
  return { ...JSON.parse(text), secureCookie: /;\s*Secure/i.test(sc) };
}
const noSecretsIn = (s, where) => { for (const v of SECRETS) assert.ok(!s.includes(v), 'no secret value in ' + where); };

(async () => {
  const text = lines(M365);
  const cases = [
    ['UTF-8', Buffer.from(text)],
    ['UTF-8 with BOM (Notepad "UTF-8 with BOM")', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)])],
    ['UTF-16 LE (Windows PowerShell 5.1 ">" / Out-File, Notepad "UTF-16 LE")', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])],
    ['UTF-16 BE', Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()])],
    ['UTF-8 with the M365 lines appended by PowerShell 5.1 ">>" (UTF-16)', Buffer.concat([Buffer.from('ZOHO_NO_SCHEDULER=1\r\n'), Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])],
  ];
  for (const [label, bytes] of cases) {
    const s = await start({ bytes });
    try {
      const st = await status(s);
      assert.equal(st.enabled, true, label + ': enabled'); assert.equal(st.configured, true, label + ': configured ' + JSON.stringify(st.missing));
      assert.equal(st.tenant_id, M365.M365_TENANT_ID); assert.equal(st.client_id, M365.M365_CLIENT_ID);
      assert.equal(st.client_secret_set, true); assert.equal(st.encryption_key_set, true); assert.equal(st.redirect_uri, M365.M365_REDIRECT_URI);
      assert.deepEqual(st.env_file.m365_settings_loaded.sort(), Object.keys(M365).sort()); assert.equal(st.env_file.warning, null);
      assert.equal(st.secureCookie, true, label + ': TRUST_PROXY=1 from run-server.cmd still applies');
      await s.stop();
      const log = s.log(); noSecretsIn(log, 'server.log');
      assert.match(log, /\.env: \d+ setting\(s\) loaded \(.+\): .*M365_CLIENT_SECRET/, label + ': server.log says what was loaded (names)\n' + log);
    } finally { await s.stop(); }
    console.log('✔ .env as ' + label + ': M365 settings reach the server started by run-server.cmd');
  }

  // ---- the launcher wins: SETUP_TOKEN / TRUST_PROXY in .env never override run-server.cmd ----
  {
    const s = await start({ bytes: Buffer.from(lines({ ...M365, SETUP_TOKEN: ENVFILE_TOKEN, TRUST_PROXY: '0' })) });
    try {
      assert.equal((await status(s, { token: ENVFILE_TOKEN })).setupStatus, 403, 'the .env SETUP_TOKEN is not used');
      const st = await status(s);                                              // the launcher's token works
      assert.equal(st.secureCookie, true, 'TRUST_PROXY=1 from the launcher is kept');
      await s.stop();
      assert.match(s.log(), /already set in the environment \(e\.g\. by run-server\.cmd\), kept: SETUP_TOKEN, TRUST_PROXY/);
      assert.ok(!s.log().includes(ENVFILE_TOKEN) && !s.log().includes(LAUNCHER_TOKEN), 'no token in server.log');
    } finally { await s.stop(); }
    console.log('✔ SETUP_TOKEN and TRUST_PROXY from run-server.cmd are kept; .env cannot override them');
  }

  // ---- problems are reported, never silent ----
  {
    const s = await start({ name: '.env.txt', bytes: Buffer.from(text) });
    try {
      const st = await status(s);
      assert.equal(st.enabled, false, '.env.txt is not loaded');
      assert.match(st.env_file.warning, /there is no \.env but there is \.env\.txt/); assert.ok(st.missing.some(m => /^\.env: .*\.env\.txt/.test(m)), 'shown in the M365 card');
      await s.stop(); assert.match(s.log(), /WARNING: there is no \.env but there is \.env\.txt/);
    } finally { await s.stop(); }
    console.log('✔ .env saved as .env.txt: reported in server.log and in the M365 status');
  }
  {
    const s = await start({ bytes: Buffer.concat([Buffer.from('A=1\r\n'), Buffer.from([0xff, 0xfe]), Buffer.from('M365_ENABLED=1\r\nNOTE=caf\u00e9\r\n', 'utf16le')]) });
    try {
      const st = await status(s);
      assert.equal(st.enabled, false); assert.match(st.env_file.warning, /save it again as UTF-8/);
      await s.stop(); assert.match(s.log(), /WARNING: \.env is mixed UTF-8 \/ UTF-16/);
    } finally { await s.stop(); }
    console.log('✔ a .env that cannot be read safely is reported, nothing guessed');
  }
  if (process.getuid && process.getuid() !== 0) {                             // (root can read anything: checked where tests run as a user, e.g. CI)
    const s = await start({ bytes: Buffer.from(text), mode: 0o000 });
    try {
      const st = await status(s);
      assert.equal(st.enabled, false); assert.match(st.env_file.warning, /cannot be read by the account running the ERP/);
      await s.stop(); assert.match(s.log(), /WARNING: \.env cannot be read/);
    } finally { await s.stop(); fs.chmodSync(path.join(APP, '.env'), 0o600); }
    console.log('✔ a .env the ERP account cannot read is reported');
  }

  // ---- without .env: nothing breaks, the log says so ----
  {
    const s = await start(null);
    try { const st = await status(s); assert.equal(st.enabled, false); assert.equal(st.env_file.found, false); assert.equal(st.env_file.warning, null); await s.stop(); assert.match(s.log(), /\.env: none/); }
    finally { await s.stop(); }
    console.log('✔ no .env: the ERP starts as before, the log says there is none');
  }

  fs.rmSync(T, { recursive: true, force: true });
  console.log('\nENV TESTS PASSED');
})().catch(e => { console.error(e); process.exit(1); });
