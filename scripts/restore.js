// Restore the database from a backup. STOP THE SERVER FIRST (Trigon-Restore.bat does it for you).
//   node --no-warnings scripts/restore.js                 list the backups
//   node --no-warnings scripts/restore.js erp-2026-11-10.db   restore that one (a file name in data/backups, or a full path)
// The current database is kept next to it as erp-before-restore-<time>.db, so a restore can itself be undone.
const fs = require('node:fs'), path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const dir = process.env.DATA_DIR || path.join(__dirname, '..', 'data'), bk = path.join(dir, 'backups'), live = path.join(dir, 'erp.db');
const files = fs.existsSync(bk) ? fs.readdirSync(bk).filter(f => /^erp-.*\.db$/.test(f)).sort().reverse() : [];
const arg = process.argv[2];
if (!arg) { console.log(files.length ? 'Backups (newest first):\n  ' + files.join('\n  ') : 'No backups found in ' + bk); process.exit(0); }
const src = fs.existsSync(arg) ? arg : path.join(bk, arg);
if (!fs.existsSync(src)) { console.error('Backup not found: ' + src); process.exit(1); }
try {                                                                       // the backup must be a healthy ERP database before it replaces anything
  const d = new DatabaseSync(src, { readOnly: true });
  const okay = d.prepare('PRAGMA integrity_check').get().integrity_check === 'ok' && d.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('users','invoices','settings')").get().n === 3;
  const info = { users: d.prepare('SELECT COUNT(*) n FROM users').get().n, invoices: d.prepare('SELECT COUNT(*) n FROM invoices').get().n };
  d.close(); if (!okay) throw new Error('integrity check failed or not an ERP database');
  console.log(`Backup is healthy: ${info.users} users, ${info.invoices} invoices.`);
} catch (e) { console.error('This backup cannot be used: ' + e.message); process.exit(1); }
try { const t = new DatabaseSync(live); t.exec('BEGIN IMMEDIATE'); t.exec('ROLLBACK'); t.exec('PRAGMA wal_checkpoint(TRUNCATE)'); t.close(); }
catch (e) { if (fs.existsSync(live)) { console.error('The database is in use — stop the ERP server first. (' + e.message + ')'); process.exit(1); } }
const keep = path.join(dir, `erp-before-restore-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)}.db`);
if (fs.existsSync(live)) fs.copyFileSync(live, keep);
fs.copyFileSync(src, live); for (const x of ['-wal', '-shm']) fs.rmSync(live + x, { force: true });
console.log('Restored ' + path.basename(src) + (fs.existsSync(keep) ? '\nThe previous database was kept as ' + keep : '') + '\nStart the ERP server again.');
