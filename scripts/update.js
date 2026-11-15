// The update transaction, run by Trigon-Update.bat with the release it downloaded (so this logic always comes from the new release):
//   node scripts/update.js --app <system folder> --src <extracted release> [--wait-pid <pid,pid>]
// 1. Stage the release inside the system folder (same disk, so moves are renames; each entry = the live one with the release
//    copied over it, so local-only files such as brand/stamp.png are kept) and install the exact runtime dependencies there
//    (npm ci --omit=dev --ignore-scripts), then verify them. Nothing live is touched yet: a failure here changes nothing.
// 2. Stop the ERP. Swap every program entry of the release, and node_modules, by renaming: the live entry moves into
//    app-backup-<stamp>, the staged one moves into its place. data/, .env and the backups are never touched.
// 3. Verify the live files equal the staged release, require('jose'), start the ERP and wait for /api/status.
// 4. Success: remove the staging folder, keep the backup (newest 3), and stage the new Trigon-Update.bat as Trigon-Update.bat.new;
//    scripts/update-finish.js replaces the running updater once its cmd.exe windows have closed.
//    Any failure after the stop: move the new entries out, move the previous ones back, check them byte for byte against the
//    manifest taken before the swap, start the previous version and check it answers. Exit code 1 either way.
'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), cp = require('node:child_process');

const WIN = process.platform === 'win32';
const LOCAL = n => ['data', '.env', '.git', 'node_modules'].includes(n) || /^(data-backup-|app-backup-|\.update-)/.test(n) || /^Trigon-Update\.bat(\..*)?$/i.test(n);
const sleepMs = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// sha256 of every file under the given top-level entries (symlinks by their target), keyed by relative path
function manifest(root, names) {
  const out = {};
  const walk = (abs, rel) => {
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) out[rel] = 'link:' + fs.readlinkSync(abs);
    else if (st.isDirectory()) { out[rel + '/'] = 'dir'; for (const f of fs.readdirSync(abs).sort()) walk(path.join(abs, f), rel + '/' + f); }
    else out[rel] = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  };
  for (const n of names) if (fs.existsSync(path.join(root, n)) || isLink(path.join(root, n))) walk(path.join(root, n), n);
  return out;
}
const isLink = p => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
const exists = p => fs.existsSync(p) || isLink(p);
const sameManifest = (a, b) => { const ka = Object.keys(a), kb = Object.keys(b); return ka.length === kb.length && ka.every(k => a[k] === b[k]); };
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

// move with a few retries (Windows: antivirus / indexer can hold a file for a moment)
function move(from, to) {
  for (let i = 0; ; i++) { try { fs.renameSync(from, to); return; } catch (e) { if (i >= 19 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e; sleepMs(500); } }
}
const rmrf = p => fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });

function run(cmd, args, opts = {}) {                                         // npm / node, output shown in the console
  const r = cp.spawnSync(cmd, args, { stdio: opts.quiet ? 'ignore' : 'inherit', shell: WIN && /\.cmd$/i.test(cmd), ...opts });
  return r.status === 0;
}

// the ERP of THIS folder as a Windows service: the TrigonERP scheduled task only if its working directory is this folder (so a test
// copy never stops or starts the live system), else Trigon-Start.bat. Stopping ends only the node process listening on this
// folder's port and the launcher window around it (run-server.cmd / Trigon-Start.bat restart node after 5 s if it is left running).
function windowsService(app, port) {
  const env = { ...process.env, TRIGON_APP: app, TRIGON_PORT: String(port) };
  const ps = c => cp.spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(c, 'utf16le').toString('base64')], { encoding: 'utf8', env });   // no quoting pitfalls
  const ownTask = () => ps(`$t = Get-ScheduledTask -TaskName 'TrigonERP' -ErrorAction SilentlyContinue
    if ($t -and $t.Actions[0].WorkingDirectory -and ($t.Actions[0].WorkingDirectory.TrimEnd('\\') -ieq $env:TRIGON_APP.TrimEnd('\\'))) { exit 0 } else { exit 3 }`).status === 0;
  return {
    stop() {
      if (ownTask()) ps("Stop-ScheduledTask -TaskName 'TrigonERP'");
      ps(`$ids = @(Get-NetTCPConnection -LocalPort ([int]$env:TRIGON_PORT) -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $_.OwningProcess } | Sort-Object -Unique)
        foreach ($id in $ids) {
          $p = Get-CimInstance Win32_Process -Filter "ProcessId=$id"
          if (-not $p -or $p.Name -ne 'node.exe') { continue }
          $up = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $p.ParentProcessId)
          if ($up -and $up.Name -eq 'cmd.exe' -and ($up.CommandLine -like '*run-server.cmd*' -or $up.CommandLine -like '*Trigon-Start.bat*')) { Stop-Process -Id $up.ProcessId -Force -ErrorAction SilentlyContinue }
          Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
        }`);
      sleepMs(2000);
    },
    start() {
      if (ownTask()) { if (ps("Start-ScheduledTask -TaskName 'TrigonERP'").status !== 0) throw new Error('the TrigonERP task did not start'); return; }
      const bat = path.join(app, 'Trigon-Start.bat');
      cp.spawn('cmd.exe', ['/d', '/s', '/c', `start "" /min "${bat}"`], { cwd: app, detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
    },
  };
}

async function healthy(url, tries, every) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(3000) }); if (r.status === 200) return true; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, every));
  }
  return false;
}
function portOf(app) {                                                       // PORT from .env next to server.js, else 3000
  try { const m = /^\s*PORT\s*=\s*(\d+)/m.exec(fs.readFileSync(path.join(app, '.env'), 'utf8')); if (m) return +m[1]; } catch { /* no .env */ }
  return 3000;
}

// opts: app, src, service {stop, start} (may be async), healthUrl, healthTries, healthEvery, npmArgs (extra), waitPids, fault, log, stamp
async function runUpdate(opts) {
  const log = opts.log || (m => console.log(m));
  const app = path.resolve(opts.app), src = path.resolve(opts.src), fault = opts.fault || process.env.TRIGON_UPDATE_FAULT || '';
  const d = new Date(), p2 = n => String(n).padStart(2, '0');
  const stamp = opts.stamp || `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}-${crypto.randomBytes(2).toString('hex')}`;
  const staging = path.join(app, `.update-staging-${stamp}`), backup = path.join(app, `app-backup-${stamp}`);
  const service = opts.service || windowsService(app, portOf(app)), healthUrl = opts.healthUrl || `http://127.0.0.1:${portOf(app)}/api/status`;
  const tries = opts.healthTries || 20, every = opts.healthEvery || 2000;
  const result = { ok: false, rolledBack: false, rollbackOk: null, stage: '' };
  const say = (s, m) => { result.stage = s; log(m); };

  // ---- 1. stage + dependencies (nothing live changes) ----
  if (!fs.existsSync(path.join(app, 'server.js'))) { log('UPDATE FAILED: this is not the Trigon ERP folder (no server.js) - nothing was changed.'); return result; }
  if (!fs.existsSync(path.join(src, 'server.js')) || !fs.existsSync(path.join(src, 'package-lock.json'))) { log('UPDATE FAILED: the download does not look right - nothing was changed.'); return result; }
  const names = fs.readdirSync(src).filter(n => !LOCAL(n)).sort();          // program entries of the release
  try {
    say('stage', '3/6 Installing the runtime dependencies into the new version (npm ci --omit=dev)...');
    rmrf(staging); fs.mkdirSync(staging);
    // each entry = the live one with the release copied over it (as the old robocopy /E did), so files that exist only on this PC
    // inside program folders (e.g. brand/stamp.png, which is not in git) are kept; node_modules comes only from npm ci below
    for (const n of names) {
      if (exists(path.join(app, n))) fs.cpSync(path.join(app, n), path.join(staging, n), { recursive: true, verbatimSymlinks: true });
      fs.cpSync(path.join(src, n), path.join(staging, n), { recursive: true, force: true, verbatimSymlinks: true });
    }
    const npm = WIN ? 'npm.cmd' : 'npm';
    if (fault === 'npm' || !run(npm, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', ...(opts.npmArgs || [])], { cwd: staging })) throw new Error('npm ci failed - check the connection to registry.npmjs.org');
    if (!run(npm, ['ls', '--omit=dev', '--depth=0'], { cwd: staging, quiet: true })) throw new Error('the installed dependencies do not match package-lock.json');
    if (!run(process.execPath, ['-e', "require('jose')"], { cwd: staging, quiet: true })) throw new Error('the jose package could not be loaded');
    log('    dependencies installed and verified');
  } catch (e) {
    rmrf(staging);
    log(`UPDATE FAILED: ${e.message} - nothing was changed, the system keeps running the current version.`); return result;
  }
  const swap = [...names, 'node_modules'];
  const staged = manifest(staging, swap), before = manifest(app, swap);

  // ---- 2. stop, swap by renaming ----
  const journal = [];                                                        // { name, hadOld, placed }
  let started = false;
  try {
    say('stop', '4/6 Stopping the system...'); await service.stop();
    // whatever answers after the start must be the version just put in place, so the old one has to be gone first
    if (await healthy(healthUrl, 3, Math.min(every, 1000))) throw new Error('the running system did not stop (it still answers at ' + healthUrl + ')');
    say('swap', '5/6 Replacing the program files and node_modules (previous ones kept in ' + path.basename(backup) + ')...');
    fs.mkdirSync(backup);
    let i = 0;
    for (const n of swap) {
      if (fault === 'copy' && n !== 'node_modules' && ++i > Math.ceil(names.length / 2)) throw new Error('injected failure while replacing the program files');
      if (fault === 'modules' && n === 'node_modules') throw new Error('injected failure while replacing node_modules');
      const live = path.join(app, n), j = { name: n, hadOld: exists(live), placed: false }; journal.push(j);
      if (j.hadOld) move(live, path.join(backup, n));
      move(path.join(staging, n), live); j.placed = true;
    }
    if (!sameManifest(manifest(app, swap), staged)) throw new Error('the installed files do not match the release');
    log('    application files and dependencies in place');
    if (fault === 'jose' || !run(process.execPath, ['-e', "require('jose')"], { cwd: app, quiet: true })) throw new Error('jose cannot be loaded in the system folder');

    // ---- 3. start + health ----
    say('start', '6/6 Starting the new version and checking that it answers...');
    if (fault === 'start') throw new Error('injected failure starting the system');
    await service.start(); started = true;
    if (fault === 'health' || !(await healthy(healthUrl, tries, every))) throw new Error('the new version did not answer at ' + healthUrl);
  } catch (e) {
    // ---- rollback: new entries out, previous ones back, checked byte for byte, previous version started ----
    log(`UPDATE FAILED: ${e.message}`); result.rolledBack = true;
    log('    rolling back to the previous version...');
    let restored = false;
    try {
      if (started || result.stage === 'start') await service.stop();         // also after a start that failed half-way
      for (const j of journal.reverse()) {
        const live = path.join(app, j.name);
        if (j.placed) rmrf(live);
        if (j.hadOld) move(path.join(backup, j.name), live);
      }
      if (!sameManifest(manifest(app, swap), before)) throw new Error('the restored files differ from the previous version');
      restored = true; result.filesRestored = true;
      if (!(await healthy(healthUrl, 1, 0))) await service.start();         // (it still runs if it never stopped: no second copy)
      if (!(await healthy(healthUrl, tries, every))) throw new Error('the previous version did not answer after the rollback');
      result.rollbackOk = true; rmrf(backup); rmrf(staging);
      log('ROLLBACK SUCCEEDED: the previous version is restored (checked byte for byte) and running. Your data was not touched.');
    } catch (r) {
      result.rollbackOk = false;
      log(restored
        ? `ROLLBACK FAILED: ${r.message}. The previous program files are back in place (checked byte for byte) but the system did not answer - restart the PC. Your data folder was not touched.`
        : `ROLLBACK FAILED: ${r.message}. Whatever could not be moved back is in ${backup} - copy it into ${app} (or restore ${backup} and the staging folder by hand), then start the system. Your data folder was not touched.`);
    }
    return result;
  }

  // ---- 4. success ----
  rmrf(staging);
  for (const old of fs.readdirSync(app).filter(n => /^app-backup-/.test(n)).sort().reverse().slice(3)) rmrf(path.join(app, old));   // keep the newest 3, only after a healthy start
  // the updater itself: staged now, swapped in by update-finish.js once the running cmd.exe windows have closed
  const newBat = path.join(src, 'Trigon-Update.bat');
  if (fs.existsSync(newBat)) {
    const want = sha(newBat), cur = path.join(app, 'Trigon-Update.bat');
    if (!fs.existsSync(cur) || sha(cur) !== want) {
      fs.copyFileSync(newBat, cur + '.new');
      if (sha(cur + '.new') !== want) { rmrf(cur + '.new'); log('WARNING: the new updater could not be staged; the update itself succeeded.'); }
      else {
        const args = [path.join(app, 'scripts', 'update-finish.js'), '--app', app, '--sha', want, '--wait-pid', (opts.waitPids || []).join(',')];
        if (opts.finishNow) cp.spawnSync(process.execPath, args, { stdio: 'inherit' });
        else cp.spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        log('    the updater (Trigon-Update.bat) will replace itself with the new version when this window closes');
      }
    }
  }
  result.ok = true;
  log('DONE - Trigon ERP is updated and running.');
  return result;
}

if (require.main === module) {
  const a = process.argv.slice(2), arg = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  runUpdate({ app: arg('--app'), src: arg('--src'), waitPids: String(arg('--wait-pid') || '').split(',').map(Number).filter(n => n > 0) })
    .then(r => process.exit(r.ok ? 0 : 1), e => { console.log('UPDATE FAILED: ' + e.message); process.exit(1); });
}
module.exports = { runUpdate, manifest, sameManifest };
