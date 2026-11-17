// The update transaction (scripts/update.js, run by Trigon-Update.bat) and the updater's self-replacement (scripts/update-finish.js):
// node --no-warnings test-updater.js
// Each case starts from a copy of an "old" installation (old program files, an older Trigon-Update.bat, old node_modules, a real
// database made by the old version, a local-only brand/stamp.png and .env) and a "new" release made from this working tree. The ERP
// really runs (node server.js on a free local port) through an injected service controller instead of the Windows scheduled task.
// Dependencies are installed with the real `npm ci --omit=dev`, offline from the npm cache (no internet in tests).
// Proven for failures during npm ci, the program-file swap, the node_modules swap, require('jose'), startup and the health check:
// the program files and node_modules are back byte for byte, the previous version answers again, the database is unchanged and
// the result is a failure (exit code 1). And for a successful update: the new version runs with jose 5.10.0, local files are kept,
// and the old updater is replaced by the release's one only after the window running it has closed, with nothing left behind.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert'), crypto = require('crypto'), cp = require('child_process'), net = require('net');
const { DatabaseSync } = require('node:sqlite');
const { runUpdate, manifest, sameManifest } = require('./scripts/update.js');
const { finish } = require('./scripts/update-finish.js');

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-update-'));
const SKIP = n => ['node_modules', '.git', 'data', 'dist', '.env'].includes(n) || /^(data-backup-|app-backup-|\.update-)/.test(n);
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const OLD_UPDATER = '@echo off\r\nrem Trigon ERP - one-click update (OLDER VERSION FIXTURE)\r\nrem robocopy $src $app /E /XD data node_modules .git /XF Trigon-Update.bat\r\nrem https://github.com/MohanadAyyash/Claude/archive/refs/heads/claude/construction-management-app-rfq8al.zip\r\n';
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(DATA_DIR|PORT|HOST|M365_|TRIGON_UPDATE_FAULT)/.test(k)));
Object.assign(ENV, { ZOHO_NO_SCHEDULER: '1', SALES_NO_SCHEDULER: '1', BACKUP_NO_SCHEDULER: '1' });
const quiet = () => {};

const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// a release folder made from this working tree; `label` is served at /version-fixture.txt so we can tell which version answers
function makeRelease(dir, label, edit) {
  fs.mkdirSync(dir, { recursive: true });
  for (const n of fs.readdirSync(__dirname)) if (!SKIP(n)) fs.cpSync(path.join(__dirname, n), path.join(dir, n), { recursive: true });
  fs.writeFileSync(path.join(dir, 'public', 'version-fixture.txt'), label);
  if (edit) edit(dir);
  return dir;
}
// the ERP of one installation, as the scheduled task would run it
function service(app, port) {
  let child = null;
  const s = {
    starts: 0, stops: 0,
    async start() { s.starts++; child = cp.spawn(process.execPath, ['--no-warnings', 'server.js'], { cwd: app, env: { ...ENV, PORT: String(port), HOST: '127.0.0.1' }, stdio: 'ignore' }); },
    async stop() { s.stops++; const c = child; child = null; if (c && c.exitCode === null && c.signalCode === null) { const gone = new Promise(r => c.once('exit', r)); c.kill(); await gone; } },
  };
  return s;
}
const get = async (port, p) => { try { const r = await fetch(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(3000) }); return { s: r.status, t: await r.text() }; } catch { return { s: 0, t: '' }; } };
async function waitUp(port) { for (let i = 0; i < 60; i++) { if ((await get(port, '/api/status')).s === 200) return; await sleep(250); } throw new Error('server did not start'); }
// the whole installation except the data folder (program files, node_modules, updater, .env, local files, leftovers)
const tree = app => manifest(app, fs.readdirSync(app).filter(n => n !== 'data' && n !== 'update-history.log'));
// every row of every table of the database (read with the ERP stopped)
function dataPrint(app) {
  const db = new DatabaseSync(path.join(app, 'data', 'erp.db'), { readOnly: true });
  try {
    const h = crypto.createHash('sha256');
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()) h.update(name).update(JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all().map(r => JSON.stringify(r)).sort()));
    return h.digest('hex');
  } finally { db.close(); }
}

(async () => {
  const src = makeRelease(path.join(T, 'release-new'), 'new');
  // the release whose server cannot start (a real startup failure, not an injected one)
  const broken = makeRelease(path.join(T, 'release-broken'), 'broken', d => fs.writeFileSync(path.join(d, 'server.js'), "throw new Error('broken release fixture');\n" + fs.readFileSync(path.join(d, 'server.js'), 'utf8')));

  // ---- the old installation: older program files and updater, old node_modules, real data made by the old version ----
  const golden = makeRelease(path.join(T, 'golden-old'), 'old', d => {
    fs.appendFileSync(path.join(d, 'server.js'), '\n// old version fixture\n');
    fs.writeFileSync(path.join(d, 'Trigon-Update.bat'), OLD_UPDATER);
    fs.mkdirSync(path.join(d, 'node_modules', 'old-dep'), { recursive: true });
    fs.writeFileSync(path.join(d, 'node_modules', 'old-dep', 'index.js'), 'module.exports = "old dependency fixture";\n');
    fs.writeFileSync(path.join(d, 'brand', 'stamp.png'), 'fake stamp image, local to this PC (not in git)');
    fs.writeFileSync(path.join(d, '.env'), '# local settings fixture - no secrets\nFIXTURE_SETTING=1\n');
  });
  {
    const port = await freePort(), svc = service(golden, port);
    await svc.start(); await waitUp(port);
    let cookie = '';
    const call = async (m, u, b) => { const r = await fetch(`http://127.0.0.1:${port}/api/${u}`, { method: m, headers: { 'Content-Type': 'application/json', cookie }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; assert.equal(r.status, 200, u); return r.json(); };
    await call('POST', 'setup', { username: 'admin', password: 'secret12', company: 'Test Co' });
    const cl = (await call('POST', 'parties', { type: 'client', name: 'Fixture Client' })).id;
    await call('POST', 'projects', { name: 'Fixture Project', client_id: cl, status: 'active' });
    await svc.stop();
  }
  const goldenData = dataPrint(golden);

  let n = 0;
  // one case: a fresh copy of the old installation, running, then the update
  async function scenario(label, { release = src, fault, npmArgs = ['--offline'], noModules = false, waitPids, stuck = false, check }) {
    const app = path.join(T, `app-${++n}`);
    fs.cpSync(golden, app, { recursive: true });
    if (noModules) fs.rmSync(path.join(app, 'node_modules'), { recursive: true, force: true });
    const port = await freePort(), svc = service(app, port);
    await svc.start(); await waitUp(port);
    if (stuck) { const real = svc.stop; let first = true; svc.stop = async () => { if (first) { first = false; svc.stops++; return; } return real(); }; }   // the first stop does not work
    assert.equal((await get(port, '/version-fixture.txt')).t, 'old', label + ': the old version runs before the update');
    const before = tree(app), lines = [];
    const r = await runUpdate({ app, src: release, service: svc, healthUrl: `http://127.0.0.1:${port}/api/status`, healthTries: 20, healthEvery: 250, npmArgs, fault, waitPids, log: m => lines.push(m) });
    const answer = await get(port, '/version-fixture.txt');
    await check({ app, r, before, port, svc, lines, answer });
    await svc.stop();
    assert.equal(dataPrint(app), goldenData, label + ': the database is unchanged');
    console.log('✓ ' + label);
    return app;
  }
  // what every failure after the stop must prove
  const rolledBack = label => async ({ app, r, before, answer, lines }) => {
    assert.equal(r.ok, false, label + ': reported as failed (exit code 1)');
    assert.equal(r.rolledBack, true, label + ': rolled back');
    assert.equal(r.rollbackOk, true, label + ': rollback succeeded\n' + lines.join('\n'));
    assert.ok(sameManifest(tree(app), before), label + ': program files, node_modules, updater and local files restored byte for byte, nothing left behind');
    assert.equal(fs.readFileSync(path.join(app, 'node_modules', 'old-dep', 'index.js'), 'utf8'), 'module.exports = "old dependency fixture";\n', label + ': previous node_modules restored');
    assert.ok(!fs.existsSync(path.join(app, 'node_modules', 'jose')), label + ': no new dependency left in place');
    assert.equal(sha(path.join(app, 'Trigon-Update.bat')), sha(path.join(golden, 'Trigon-Update.bat')), label + ': updater unchanged');
    assert.equal(answer.s, 200, label + ': the previous version answers again');
    assert.equal(answer.t, 'old', label + ': and it is the previous version');
    assert.ok(lines.some(l => /ROLLBACK SUCCEEDED/.test(l)), label + ': the window says the rollback succeeded');
  };

  // ---- 1. dependency install fails (no registry access): nothing changes, the system is never stopped ----
  const emptyCache = fs.mkdtempSync(path.join(T, 'empty-npm-cache-'));
  await scenario('npm ci fails (no registry access) - nothing changed, never stopped', { npmArgs: ['--offline', '--cache', emptyCache], check: ({ app, r, before, svc, answer, lines }) => {
    assert.equal(r.ok, false); assert.equal(r.rolledBack, false);
    assert.equal(svc.stops, 0, 'the running system was not stopped');
    assert.ok(sameManifest(tree(app), before), 'nothing changed, no staging folder left');
    assert.equal(answer.t, 'old');
    assert.ok(lines.some(l => /UPDATE FAILED: npm ci failed .* nothing was changed/.test(l)), lines.join('\n'));
  } });
  await scenario('injected npm failure - nothing changed, never stopped', { fault: 'npm', check: ({ app, r, before, svc }) => {
    assert.equal(r.ok, false); assert.equal(svc.stops, 0); assert.ok(sameManifest(tree(app), before));
  } });

  // ---- 2. failures after the system was stopped: real rollback ----
  await scenario('failure during the program-file swap - rolled back', { fault: 'copy', check: rolledBack('program-file swap') });
  await scenario('failure during the node_modules swap - rolled back', { fault: 'modules', check: rolledBack('node_modules swap') });
  await scenario("require('jose') fails in the system folder - rolled back", { fault: 'jose', check: rolledBack('jose verification') });
  await scenario('the system cannot be started - rolled back', { fault: 'start', check: rolledBack('start') });
  await scenario('the new version crashes at startup - rolled back', { release: broken, check: rolledBack('startup') });
  await scenario('the health check fails - rolled back', { fault: 'health', check: rolledBack('health check') });
  await scenario('the running system does not stop - nothing swapped, no second copy started', { stuck: true, check: async (c) => {
    await rolledBack('does not stop')(c);
    assert.equal(c.svc.starts, 1, 'the still-running system was not started a second time');
    assert.ok(c.lines.some(l => /did not stop/.test(l)));
  } });

  // ---- 3. successful update from an installation without node_modules, with an older updater ----
  const win = cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });   // stands in for the cmd.exe window running the updater
  const wantBat = sha(path.join(src, 'Trigon-Update.bat'));
  assert.notEqual(sha(path.join(golden, 'Trigon-Update.bat')), wantBat, 'the fixture updater is older than the release one');
  const okApp = await scenario('successful update: new version runs, jose 5.10.0, local files kept', { noModules: true, waitPids: [win.pid], check: async ({ app, r, answer, lines, before }) => {
    assert.equal(r.ok, true, lines.join('\n'));
    assert.equal(answer.t, 'new', 'the new version answers');
    assert.equal(JSON.parse(fs.readFileSync(path.join(app, 'node_modules', 'jose', 'package.json'), 'utf8')).version, '5.10.0');
    cp.execFileSync(process.execPath, ['-e', "require('jose')"], { cwd: app });
    for (const f of ['server.js', 'scripts/update.js', 'modules/microsoft365.js', 'package-lock.json', 'public/version-fixture.txt']) assert.equal(sha(path.join(app, f)), sha(path.join(src, f)), f + ' is the release version');
    assert.equal(fs.readFileSync(path.join(app, 'brand', 'stamp.png'), 'utf8'), 'fake stamp image, local to this PC (not in git)', 'local-only file kept');
    assert.equal(fs.readFileSync(path.join(app, '.env'), 'utf8'), fs.readFileSync(path.join(golden, '.env'), 'utf8'), '.env untouched');
    assert.ok(!fs.readdirSync(app).some(x => /^\.update-/.test(x)), 'no staging folder left');
    const bk = fs.readdirSync(app).filter(x => /^app-backup-/.test(x));
    assert.equal(bk.length, 1, 'the previous version is kept'); assert.equal(sha(path.join(app, bk[0], 'server.js')), before['server.js']);
    // the updater: staged, but not replaced while the window that runs it is open
    assert.equal(sha(path.join(app, 'Trigon-Update.bat')), sha(path.join(golden, 'Trigon-Update.bat')), 'not replaced while its window is open');
    assert.equal(sha(path.join(app, 'Trigon-Update.bat.new')), wantBat);
    await sleep(1500);
    assert.equal(sha(path.join(app, 'Trigon-Update.bat')), sha(path.join(golden, 'Trigon-Update.bat')), 'still waiting for the window');
    win.kill();                                                               // the window closes
    for (let i = 0; i < 40 && fs.existsSync(path.join(app, 'Trigon-Update.bat.new')); i++) await sleep(250);
    assert.equal(sha(path.join(app, 'Trigon-Update.bat')), wantBat, 'the installed updater is now the reviewed release version');
    assert.ok(!fs.readdirSync(app).some(x => /^Trigon-Update\.bat\./.test(x) || /\.(tmp|new)$/.test(x)), 'no .new / .tmp / helper files left');
    assert.match(fs.readFileSync(path.join(app, 'update-history.log'), 'utf8'), /Trigon-Update\.bat replaced with the new version \(sha256 [0-9a-f]{64}\)/);
    const bat = fs.readFileSync(path.join(app, 'Trigon-Update.bat'), 'utf8');
    assert.match(bat, /Trigon-ERP-System\/archive/, 'future runs use the new URL'); assert.match(bat, /scripts\\update\.js/, 'and the new transactional update');
    assert.doesNotMatch(bat, /\/XF Trigon-Update\.bat/);
  } });

  // ---- 4. a second run with the same release is a no-op apart from a fresh backup ----
  {
    const port = await freePort(), svc = service(okApp, port);
    await svc.start(); await waitUp(port);
    const releaseEntries = [...fs.readdirSync(src).filter(x => !SKIP(x) && !/^Trigon-Update\.bat/.test(x)), 'node_modules'];
    const before = manifest(okApp, releaseEntries), batBefore = sha(path.join(okApp, 'Trigon-Update.bat')), lines = [];
    const r = await runUpdate({ app: okApp, src, service: svc, healthUrl: `http://127.0.0.1:${port}/api/status`, healthTries: 20, healthEvery: 250, npmArgs: ['--offline'], log: m => lines.push(m) });
    assert.equal(r.ok, true, lines.join('\n'));
    assert.ok(sameManifest(manifest(okApp, releaseEntries), before), 'second run: program files and node_modules identical');
    assert.equal(sha(path.join(okApp, 'Trigon-Update.bat')), batBefore); assert.ok(!fs.existsSync(path.join(okApp, 'Trigon-Update.bat.new')), 'no updater to replace');
    assert.ok(!lines.some(l => /replace itself/.test(l)));
    assert.equal((await get(port, '/version-fixture.txt')).t, 'new');
    await svc.stop();
    assert.equal(dataPrint(okApp), goldenData);
    console.log('✓ second run with the same release: idempotent');
  }

  // ---- 5. the self-replacement refuses a staged updater that does not match, and leaves nothing behind ----
  {
    const app = path.join(T, 'finish'); fs.mkdirSync(app);
    fs.writeFileSync(path.join(app, 'Trigon-Update.bat'), OLD_UPDATER);
    fs.writeFileSync(path.join(app, 'Trigon-Update.bat.new'), 'tampered');
    assert.equal(await finish({ app, want: wantBat }), false);
    assert.equal(fs.readFileSync(path.join(app, 'Trigon-Update.bat'), 'utf8'), OLD_UPDATER, 'old updater kept');
    assert.ok(!fs.existsSync(path.join(app, 'Trigon-Update.bat.new')), '.new removed');
    assert.match(fs.readFileSync(path.join(app, 'update-history.log'), 'utf8'), /was not replaced: the staged updater does not match/);
    console.log('✓ a staged updater that does not match is refused');
  }

  // ---- 6. command line: exit code 1 when the update fails, nothing changed ----
  {
    const app = path.join(T, `app-${++n}`); fs.cpSync(golden, app, { recursive: true });
    const before = tree(app);
    const r = cp.spawnSync(process.execPath, ['--no-warnings', path.join(src, 'scripts', 'update.js'), '--app', app, '--src', src], { env: { ...ENV, TRIGON_UPDATE_FAULT: 'npm' }, encoding: 'utf8' });
    assert.equal(r.status, 1, r.stdout + r.stderr); assert.match(r.stdout, /UPDATE FAILED/);
    assert.ok(sameManifest(tree(app), before));
    const r2 = cp.spawnSync(process.execPath, ['--no-warnings', path.join(src, 'scripts', 'update.js'), '--app', T, '--src', src], { encoding: 'utf8' });
    assert.equal(r2.status, 1); assert.match(r2.stdout, /not the Trigon ERP folder/);
    console.log('✓ command line: exit code 1 on failure');
  }

  // ---- 7. the batch file: delegates to the release's update.js, passes its windows' PIDs, has no "restart whatever is there" path ----
  {
    const bat = fs.readFileSync(path.join(__dirname, 'Trigon-Update.bat'), 'latin1');
    assert.ok(/\r\n/.test(bat) && !/[^\r]\n/.test(bat), 'CRLF line endings'); assert.ok(!/[^\x00-\x7f]/.test(bat), 'ASCII only');
    assert.match(bat, /& node --no-warnings "\$src\\scripts\\update\.js" --app "\$app" --src "\$src" --wait-pid/);
    assert.match(bat, /--outer/); assert.match(bat, /TRIGON_OUTER_PID/);
    assert.doesNotMatch(bat, /Start-ScheduledTask|robocopy \$src/, 'starting and copying belong to update.js (with rollback)');
    assert.match(bat, /exit 1/);
    assert.match(bat, /\$url = 'https:\/\/github\.com\/MohanadAyyash\/Trigon-ERP-System\/archive\/refs\/heads\/' \+ \$branch \+ '\.zip'/, 'downloads only from this repository');
    assert.match(bat, /-notmatch '\^\[A-Za-z0-9\]/, 'a test branch name is validated');
    // the download (Windows retest of PR #10: "Unable to connect to the remote server" from the updater while the same
    // Invoke-WebRequest worked in an administrator PowerShell window)
    const ps = bat.split('#POWERSHELL-BELOW')[1];
    assert.doesNotMatch(ps, /SecurityProtocol\s*=\s*\[Net\.SecurityProtocolType\]::Tls12/, 'TLS 1.2 is never forced as the only protocol');
    assert.match(ps, /\$how = Get-Release \$url \$zip/, 'the release is downloaded through Get-Release');
    const fn = ps.slice(ps.indexOf('function Get-Release'), ps.indexOf('$rc = 1'));
    const order = ['Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip', "System32\\curl.exe", 'Get-Command pwsh', "throw ('The download failed with every method - nothing was changed. '"].map(x => fn.indexOf(x));
    assert.ok(order.every(i => i > 0) && order.every((i, k) => k === 0 || i > order[k - 1]), 'falls back from Invoke-WebRequest to curl.exe to PowerShell 7, then fails with every reason');
    assert.match(fn, /--fail .*--location/, 'curl follows the GitHub redirect and fails on HTTP errors');
    assert.match(fn, /DefaultNetworkCredentials/, 'the system proxy gets the signed-in credentials');
    assert.match(ps, /'UPDATE FAILED: ' \+ \(Get-Chain \$_\.Exception\)/, 'the whole error chain is shown, not only the outer message');
    assert.match(ps, /\$ProgressPreference = 'SilentlyContinue'/);
    const code = ps.replace(/"[^"\r\n]*"/g, '""').replace(/'[^'\r\n]*'/g, "''").replace(/#[^\r\n]*/g, '');   // crude: strings and comments out
    for (const [o, c] of [['{', '}'], ['(', ')']]) assert.equal(code.split(o).length, code.split(c).length, `balanced ${o}${c} in the PowerShell part`);
    console.log('✓ Trigon-Update.bat delegates to the transactional update; download has fallbacks and full error detail');
  }

  fs.rmSync(T, { recursive: true, force: true });
  console.log('\nUPDATER TESTS PASSED');
})().catch(e => { console.error(e); process.exit(1); });
