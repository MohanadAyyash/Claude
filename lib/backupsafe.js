// Every database copy that leaves the live file (download, automatic daily backup, scripts/backup.js) goes through here, so it
// cannot skip the sanitising step: Microsoft 365 tokens and pending / used OAuth sign-ins, plus Copilot content and audit rows, are removed
// from the COPY (never from the live database), the copy is VACUUMed so nothing is left in free pages, checked with PRAGMA
// integrity_check, and only then moved to its final name. On any failure the temporary copy is deleted and the previous backup is untouched.
const fs = require('node:fs');

const SENSITIVE = [                                                          // [table, statement] applied to the copy when the table exists
  ['m365_connections', 'UPDATE m365_connections SET access_token_encrypted=NULL, refresh_token_encrypted=NULL, expires_at=NULL'],
  ['oauth_states', 'DELETE FROM oauth_states'],
  ['oauth_login_states', 'DELETE FROM oauth_login_states'],                // Microsoft sign-ins in progress (Phase 1B)
  ['copilot_feedback', 'DELETE FROM copilot_feedback'],
  ['copilot_audit', 'DELETE FROM copilot_audit'],
  ['copilot_history', 'DELETE FROM copilot_history'],
  ['copilot_conversations', 'DELETE FROM copilot_conversations'],
  ['copilot_memory', 'DELETE FROM copilot_memory'],
  ['copilot_preferences', 'DELETE FROM copilot_preferences'],
];
const restrict = f => { try { fs.chmodSync(f, 0o600); } catch { /* not supported on this file system (Windows): the folder's own permissions apply */ } };
const rmQuiet = f => { for (const x of [f, f + '-journal', f + '-wal', f + '-shm']) { try { fs.rmSync(x, { force: true }); } catch { /* already gone */ } } };

// sanitise a database file in place and prove it: tokens gone, no OAuth states, integrity ok
function sanitizeFile(file) {
  const { DatabaseSync } = require('node:sqlite'), b = new DatabaseSync(file);
  try {
    const has = t => !!b.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
    for (const [t, sql] of SENSITIVE) if (has(t)) b.exec(sql);
    b.exec('VACUUM');
    const ic = b.prepare('PRAGMA integrity_check').all().map(r => Object.values(r)[0]);
    if (ic.length !== 1 || ic[0] !== 'ok') throw new Error('backup integrity check failed');
    if (has('m365_connections') && b.prepare('SELECT COUNT(*) n FROM m365_connections WHERE access_token_encrypted IS NOT NULL OR refresh_token_encrypted IS NOT NULL').get().n) throw new Error('backup still holds Microsoft 365 tokens');
    if (has('oauth_states') && b.prepare('SELECT COUNT(*) n FROM oauth_states').get().n) throw new Error('backup still holds OAuth sign-in states');
    if (has('oauth_login_states') && b.prepare('SELECT COUNT(*) n FROM oauth_login_states').get().n) throw new Error('backup still holds Microsoft sign-in states');
    if (has('copilot_history') && b.prepare('SELECT COUNT(*) n FROM copilot_history').get().n) throw new Error('backup still holds Copilot chat history');
    if (has('copilot_conversations') && b.prepare('SELECT COUNT(*) n FROM copilot_conversations').get().n) throw new Error('backup still holds Copilot conversation metadata');
    if (has('copilot_memory') && b.prepare('SELECT COUNT(*) n FROM copilot_memory').get().n) throw new Error('backup still holds Copilot memory');
    if (has('copilot_preferences') && b.prepare('SELECT COUNT(*) n FROM copilot_preferences').get().n) throw new Error('backup still holds Copilot personalization preferences');
    if (has('copilot_feedback') && b.prepare('SELECT COUNT(*) n FROM copilot_feedback').get().n) throw new Error('backup still holds Copilot feedback');
    if (has('copilot_audit') && b.prepare('SELECT COUNT(*) n FROM copilot_audit').get().n) throw new Error('backup still holds Copilot audit events');
  } finally { b.close(); }
}

// write a sanitised, verified copy of the live database to `dest` (atomic: `dest` is replaced only when everything succeeded)
// opts.afterCopy: test hook, called on the raw temporary copy before it is sanitised
function sanitizedCopy(db, dest, opts = {}) {
  const tmp = `${dest}.partial-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  rmQuiet(tmp);
  try {
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    restrict(tmp);
    if (opts.afterCopy) opts.afterCopy(tmp);
    sanitizeFile(tmp);
    restrict(tmp);
    fs.renameSync(tmp, dest);                                                // replaces a previous backup of the same name only now
    restrict(dest);
    return dest;
  } catch (e) { rmQuiet(tmp); throw Object.assign(new Error('The backup could not be prepared safely: ' + e.message), { status: 500 }); }
}

module.exports = { sanitizedCopy, sanitizeFile, SENSITIVE };
