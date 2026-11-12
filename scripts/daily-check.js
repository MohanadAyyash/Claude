// Daily data-integrity check — safe to run while the server is running (it only reads).
//   node scripts/daily-check.js            (inside Docker: docker compose exec -T app node scripts/daily-check.js)
// Prints a short report, writes DATA_DIR/ops/check-YYYY-MM-DD.json and exits 1 when a check fails, 0 otherwise
// (warnings do not fail), so cron / Task Scheduler / an AI agent can act on it.
// The report holds document numbers and record ids only — no names, salaries, IBANs or ID numbers.
const fs = require('node:fs'), path = require('node:path');
process.env.ZOHO_NO_SCHEDULER = '1'; process.env.SALES_NO_SCHEDULER = '1';   // the server process runs these, not the check
const { ctx } = require('../server.js');                 // opens the same database; does not start the HTTP server

const report = ctx.runChecks(), dir = path.join(ctx.DATA_DIR, 'ops');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `check-${report.time.slice(0, 10)}.json`);
fs.writeFileSync(file, JSON.stringify(report, null, 2));
for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f); if (/^check-.*\.json$/.test(f) && Date.now() - fs.statSync(p).mtimeMs > 90 * 864e5) fs.rmSync(p); }

const mark = { ok: 'OK  ', warn: 'WARN', fail: 'FAIL' };
for (const r of report.results) {
  console.log(`${mark[r.status]}  ${r.title}${r.detail ? ' — ' + r.detail : ''}`);
  for (const i of (r.items || []).slice(0, 10)) console.log(`        ${i}`);
}
console.log(`\noverall: ${report.status.toUpperCase()}  (report: ${file})`);
process.exit(report.status === 'fail' ? 1 : 0);
