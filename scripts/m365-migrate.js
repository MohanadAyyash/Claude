// Copy existing ERP attachments (Documents: supplier papers, project files, PO / subcontract attachments) to SharePoint.
//   node --no-warnings scripts/m365-migrate.js                 → DRY RUN: lists what would be uploaded, uploads nothing
//   node --no-warnings scripts/m365-migrate.js --execute       → uploads (needs M365_SHAREPOINT_* in .env and the Sites.Selected grant)
//   options: --limit 500 (default 200, max 5000)
// Never deletes or changes the ERP copy. Resumable: a file already in SharePoint with the same SHA-256 is skipped (m365_documents).
// Files above the upload limit are reported, not sent. A JSON report is written to the data folder. Run it outside working hours,
// with the ERP stopped or running (it uses the same database), after a verified backup.
'use strict';
process.env.ZOHO_NO_SCHEDULER = '1'; process.env.SALES_NO_SCHEDULER = '1'; process.env.BACKUP_NO_SCHEDULER = '1';
const fs = require('node:fs'), path = require('node:path');
const { ctx } = require('../server.js');
const args = process.argv.slice(2), execute = args.includes('--execute'), li = args.indexOf('--limit');
const limit = li >= 0 ? Math.max(1, Math.min(5000, +args[li + 1] || 200)) : 200;
(async () => {
  const report = await ctx.m365Migrate({ execute, limit, by: 'migration-script' });
  if (execute && !report.ready) { console.log('SharePoint is not configured: nothing was uploaded.'); }
  const file = path.join(ctx.DATA_DIR, `m365-migration-${report.started.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`${execute ? 'EXECUTED' : 'DRY RUN (nothing uploaded)'}: to upload ${report.planned}, uploaded ${report.uploaded}, already there ${report.unchanged}, skipped ${report.skipped.length}, failed ${report.failed.length}`);
  console.log('Report: ' + file);
  process.exit(report.failed.length ? 1 : 0);
})().catch(e => { console.error('Migration stopped: ' + e.message); process.exit(1); });
