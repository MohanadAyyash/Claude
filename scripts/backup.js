// Consistent online backup of the SQLite database (safe while the server is running). Keeps the last KEEP_DAYS (default 30) days.
//   node scripts/backup.js            (inside the container: docker compose exec -T app node scripts/backup.js)
const fs = require('node:fs'), path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const dir = process.env.DATA_DIR || path.join(__dirname, '..', 'data'), out = path.join(dir, 'backups'), keep = +process.env.KEEP_DAYS || 30;
fs.mkdirSync(out, { recursive: true });
const file = path.join(out, `erp-${new Date().toISOString().slice(0, 10)}.db`);
fs.rmSync(file, { force: true });
const db = new DatabaseSync(path.join(dir, 'erp.db')); db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`); db.close();
for (const f of fs.readdirSync(out)) { const p = path.join(out, f); if (/^erp-.*\.db$/.test(f) && Date.now() - fs.statSync(p).mtimeMs > keep * 864e5) fs.rmSync(p); }
console.log('backup written:', file, Math.round(fs.statSync(file).size / 1024) + ' KB');
