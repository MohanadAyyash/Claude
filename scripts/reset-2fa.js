// Switch two-step sign-in off for an account from the server PC (the administrator lost the phone and nobody else can reset it):
//   node --no-warnings scripts/reset-2fa.js <username>
const path = require('node:path'), { DatabaseSync } = require('node:sqlite');
const dir = process.env.DATA_DIR || path.join(__dirname, '..', 'data'), name = process.argv[2];
if (!name) { console.error('Usage: node --no-warnings scripts/reset-2fa.js <username>'); process.exit(1); }
const db = new DatabaseSync(path.join(dir, 'erp.db')); db.exec('PRAGMA busy_timeout=5000');
const u = db.prepare('SELECT id, username FROM users WHERE username=?').get(name);
if (!u) { console.error('No such user: ' + name); process.exit(1); }
db.prepare('UPDATE users SET totp_on=0, totp_secret=NULL, totp_last=0 WHERE id=?').run(u.id);
db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
db.prepare('INSERT INTO audit_log(ts,user,action,tbl,rec,detail) VALUES(?,?,?,?,?,?)').run(new Date().toISOString(), 'server console', 'reset', '2fa', u.id, u.username);
db.close(); console.log('Two-step sign-in is off for ' + u.username + '. They can sign in with the password and switch it on again in Settings.');
