# Notes for AI agents working on this repository

Trigon ERP: a construction-company ERP (UAE) in production use. Projects, sales, procurement, payroll/WPS, accounting, VAT.
Arabic and English UI. Treat it like financial software: a silent wrong number is worse than a crash.

## Layout
- `server.js`: HTTP server, core tables, generic CRUD (`TABLES` whitelist), auth. No framework, no runtime dependencies.
- `modules/*.js`: features. Each exports `ctx => ({ tables?, handle(req, res, url, parts, me) })` and is listed in `MODULES` in `server.js`.
- `lib/acl.js`: role permissions, enforced on the server. `lib/compliance.js`: UAE rules (VAT, payroll, EOS, validators).
- `modules/accounting.js`: the general ledger is *derived* from documents and manual journals. It is never stored.
- `modules/health.js`: `/api/health`, error log, daily integrity checks. `lib/opsreport.js`: daily-check report → GitHub issue.
- `modules/microsoft365.js` (Entra link / sign-in), `modules/authmode.js` (AUTH_MODE, /auth/emergency), `modules/m365business.js` (SharePoint, Outlook, Teams) and `lib/m365graph.js` (the only Graph HTTP layer). See `M365.md`.
- `public/`: browser UI (plain JS). `standalone/`: the same server bundled for the browser (sql.js) for GitHub Pages.
- Database: built-in `node:sqlite` (Node ≥ 22.5). Schema changes go through `CREATE TABLE IF NOT EXISTS` and `addCol` (idempotent, additive only).

## Commands
- `npm test`: all tests (set `SKIP_PDF=1` when no Chrome is available). Every `test-*.js` starts the real server on a temp `DATA_DIR`.
- `node --no-warnings test-<name>.js`: one suite.
- `npm run build:standalone`: must keep building. Server code also runs in the browser, so don't add Node-only APIs to module top level.

## Rules
1. **Never touch production data.** You only see code. Do not ask for database files, backups or exports. When a problem is in the data (not the code), explain in the issue what an administrator should check in the app.
2. **Every fix comes with a test** that fails before the fix and passes after it, in the matching `test-*.js` (or a new one added to `npm test` in `package.json`). `npm test` must pass before you finish.
3. **Do not merge, force-push, or push to the default branch.** Propose changes on a branch / pull request. A person reviews and merges.
4. **Money, tax and payroll changes need a person's sign-off.** Changes to VAT, payroll, end-of-service, ledger postings, invoice numbering or rounding: say so at the top of the PR description, and explain the rule you applied with its source (law / FTA guide) if you know it. Do not "fix" a legal rule from memory. If unsure, ask in the issue.
5. **Never delete or renumber tax invoices**, and never weaken the void/credit-note flow, the audit log, payroll locking or role checks.
6. **No personal data or secrets** in commits, tests, issues or PR text: no real names, IBANs, Emirates IDs, salaries, tokens. The repository may be public. Use obviously fake test data.
7. **Keep changes small and focused** on the issue. No drive-by refactors, no reformatting of untouched code.
   **Runtime dependencies:** do not add one unless it is necessary, security-reviewed, version-pinned (exact version), committed through
   `package-lock.json`, installed by the supported deployment / update path (`npm ci --omit=dev` in `scripts/update.js`, run by `Trigon-Update.bat`; see `UPDATE.md`), and covered by
   regression tests. Prefer the Node standard library otherwise. Approved runtime dependencies:
   - `jose` (pinned in `package.json` / `package-lock.json`): a standards-based JOSE / JWT / JWKS implementation, used only to verify
     Microsoft Entra id_tokens (`modules/microsoft365.js`), so the project does not carry its own cryptographic protocol code. Tested with
     signed RS256 tokens against a local JWKS mock (`test-m365.js`). Not bundled in the standalone (browser) edition, which has no
     Microsoft 365 link.
8. User-visible text: keep both languages in step where the screen has both. The user guide is `docs/USER-GUIDE-AR.md` / `-EN.md`.
