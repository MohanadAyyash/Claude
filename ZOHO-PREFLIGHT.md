# Zoho preflight on the real organisation — from an isolated Windows copy

Read only. Nothing is created, changed or deleted in Zoho Books, and the live Trigon (`C:\ERP`) is not touched.

## What the script guarantees
`scripts/zoho-preflight.js` decides every network request before it is sent, and logs it (time, method, host, path, decision; never a token or a body):

| Request | Decision |
|---|---|
| `GET` to the Zoho Books API (`www.zohoapis.<dc>/books/…`) | allowed (read) |
| `POST accounts.zoho.<dc>/oauth/v2/token` with `grant_type=refresh_token` | allowed and counted separately: Zoho's sign-in server issues a one-hour access token from the stored refresh token. It is not sent to Zoho Books and changes nothing in the organisation; without it, Zoho answers no request. |
| `POST`, `PUT`, `PATCH`, `DELETE` to Zoho Books | **refused — not sent** |
| new connection (`authorization_code`), token revoke | **refused — not sent** |
| anything else (Microsoft 365, GitHub, e-mail…) | **refused — not sent** |

It also checks that Trigon's copy (Zoho send log, mappings, settings, runs) is byte-for-byte unchanged after the run. The proof is in the report and in `request-log.csv`.

## Steps (Windows, Command Prompt)
1. Create a folder **outside** `C:\ERP`, e.g. `D:\Trigon-preflight`.
2. Program: download PR #23's branch (`feature/zoho-preflight`) as a ZIP from GitHub and extract it to `D:\Trigon-preflight\app`. Then:
   ```
   cd /d D:\Trigon-preflight\app
   npm ci --omit=dev
   ```
3. Keys: copy `C:\ERP\.env` without its `DATA_DIR=` line, **as UTF-8 without BOM**. In PowerShell (one line):
   ```
   [IO.File]::WriteAllLines('D:\Trigon-preflight\app\.env', (Get-Content 'C:\ERP\.env' | Where-Object { $_ -notmatch '^\s*DATA_DIR\s*=' }))
   ```
   Do not use `Set-Content -Encoding UTF8`, `Out-File` or `>` in Windows PowerShell 5.1: the first adds a byte-order mark (Node then ignores the first setting), the other two write UTF-16 (Node reads nothing). The script checks this and stops before sending anything.
4. Data copy (consistent, taken while Trigon runs):
   ```
   cd /d C:\ERP
   node --no-warnings scripts\backup.js
   mkdir D:\Trigon-preflight\data
   copy C:\ERP\data\backups\erp-YYYY-MM-DD.db D:\Trigon-preflight\data\erp.db
   ```
   (`YYYY-MM-DD` = today's file.)
5. Run:
   ```
   cd /d D:\Trigon-preflight\app
   node --no-warnings scripts\zoho-preflight.js --data "D:\Trigon-preflight\data"
   ```
   Optional: `--from 2026-11-01 --to 2026-11-30` (default: the Zoho start date in Trigon → today).
   Time limit: `set ZOHO_PREFLIGHT_TIMEOUT_MS=60000` before the command (default 30000, allowed 10000–120000). It is the connect limit (DNS + TCP + TLS; Node's own default is 10 s) and the first-response limit of each request; the whole request may take twice that. A GET whose connection times out is retried once, 2 s later. Nothing else is retried: not 401 / 403, not Zoho errors, not OAuth errors (and the access token is not renewed during the preflight).
6. The script first shows, **without sending anything**: connected, organisation ID, data centre, sign-in server, API base URL, the API base URL expected for that data centre, and the result of the check. Then, never with values: `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, the refresh credential (set / MISSING, and whether from `.env`, the Windows environment or Trigon's database), `ZOHO_DC`, `organization_id`; the `.env` encoding, line endings and the settings Node actually read; the Node version and whether proxy / certificate variables are set. Type `YES` to continue.
   If the access-token request fails, the script stops there (verdict BLOCKED, exit 2) and shows the cause: stage (no connection / Zoho answered), host, kind (`timeout`, `tls`, `dns`, `network`, `oauth_rejected`, `unexpected_response`), HTTP status, Node's cause code, the addresses tried, Zoho's OAuth error and description, and what it usually means. It is also saved in `signin-diagnostics.json` with `request-log.csv`. No client ID, secret, token, Authorization header or request body is ever printed or saved.
7. After `YES`: a DNS lookup of the Books host, then a **connectivity probe** — `GET /books/v3/organizations` on the Books host with no token and no organisation ID (Zoho answers 401 without reaching any organisation; any HTTP answer proves DNS + TCP + TLS + HTTP work). Then the access token and `GET /organizations`. Each request shows its target (method, host, path, `organization_id` set / not sent, Authorization token hidden / none) and its timing (new or reused connection, DNS + TCP + TLS, first response, total). A failure is classified: TCP / TLS connect timeout, API request timeout, OAuth rejection, authorization rejection (401 / 403), Zoho error, or organization rejection (the ID is not in this connection's list).
   It then shows the organisation **name**. Type `YES` to run the preflight.
8. Report: `D:\Trigon-preflight\zoho-preflight-<date-time>\preflight-report.html` (with `preflight-report.json` and `request-log.csv`).
   Exit code: `0` READY · `1` READY WITH MISSING MAPPINGS · `2` BLOCKED · `3` could not run.
9. When finished, delete `D:\Trigon-preflight` (it holds a copy of the keys and of the data).

## The report
- **Verdict:** READY / READY WITH MISSING MAPPINGS / BLOCKED. Then what blocks, and the exact list of what to configure in Zoho before the new sync (#24) can ever be enabled.
- **Connection** and **proof of zero modifying calls**.
- **What a send would do:** create / update / delete / already synced (unchanged) / possible duplicates / conflicts / skipped.
- **Already synced** (invoices, bills, payments, payroll, journals) from Trigon's send log; saved mappings.
- **Accounts the proposed synchronisation needs** (this one, the missing transactions #24 and the ledger alignment #25): every Trigon code with the expected Zoho type, the mapped Zoho account (ID, name, type, code, parent), and its status:

  | Status | Meaning |
  |---|---|
  | mapped | the type fits |
  | automatic | Zoho has exactly one account of that type |
  | ambiguous | several of that type — map one |
  | missing | — |
  | **type mismatch** | blocks |
  | **not found** | blocks |

  Matching is by mapping and type, never by a similar name; accounts of the right type are listed as candidates only.
- **Partner accounts:** the proposed hierarchy per partner (Partner Capital → `<partner> Capital`, Partner Loans → `<partner> Loan`, Partner Current Accounts → `<partner> Current`). Not created.

Send the developer the verdict, the "to configure" list and the proof lines. Do not send the keys, the database or the full report if it holds personal data.
