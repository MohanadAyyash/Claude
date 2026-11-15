// Replaces Trigon-Update.bat with the new version staged by scripts/update.js (Trigon-Update.bat.new), once the cmd.exe
// windows running the old one have closed (cmd reads a batch file while it runs it, so it must not change underneath them).
//   node scripts/update-finish.js --app <system folder> --sha <sha256 of the new updater> [--wait-pid <pid,pid>]
// The result goes to update-history.log in the system folder. No .new file is left behind: on any failure it is removed and the
// installed updater stays as it was (the next update stages it again).
'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

async function finish({ app, want, waitPids = [], maxWaitMs = 4 * 3600e3, poll = 500 }) {
  const cur = path.join(app, 'Trigon-Update.bat'), next = cur + '.new';
  const note = m => { try { fs.appendFileSync(path.join(app, 'update-history.log'), `${new Date().toISOString()} updater: ${m}\n`); } catch { /* best effort */ } };
  const t0 = Date.now();
  while (waitPids.some(alive)) {
    if (Date.now() - t0 > maxWaitMs) { fs.rmSync(next, { force: true }); note('gave up waiting for the update window to close; the updater was not replaced (the next update will do it)'); return false; }
    await sleep(poll);
  }
  try {
    if (!fs.existsSync(next)) { if (fs.existsSync(cur) && sha(cur) === want) return true; throw new Error('the staged updater is missing'); }
    if (sha(next) !== want) throw new Error('the staged updater does not match the release');
    for (let i = 0; ; i++) {                                                  // antivirus / indexer may hold the file for a moment
      try { fs.renameSync(next, cur); break; } catch (e) { if (i >= 20) throw e; await sleep(500); }
    }
    if (sha(cur) !== want) throw new Error('the installed updater does not match the release');
    note('Trigon-Update.bat replaced with the new version (sha256 ' + want + ')');
    return true;
  } catch (e) {
    fs.rmSync(next, { force: true });
    note('the updater was not replaced: ' + e.message + ' (the previous Trigon-Update.bat is unchanged; the next update will try again)');
    return false;
  }
}

if (require.main === module) {
  const a = process.argv.slice(2), arg = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  finish({ app: path.resolve(arg('--app')), want: arg('--sha'), waitPids: String(arg('--wait-pid') || '').split(',').map(Number).filter(n => n > 0) })
    .then(ok => process.exit(ok ? 0 : 1));
}
module.exports = { finish };
