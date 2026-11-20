# Trigon ERP Copilot

This root-level operations and integration note supplements [`docs/COPILOT.md`](docs/COPILOT.md), the bilingual user guides, and [`public/copilot-openapi.yaml`](public/copilot-openapi.yaml). Copilot is read-only, disabled by default, and must not be connected to production AI or enabled with production data until Trigon has completed the stated approvals.

## Trust and access boundaries

- The ERP server classifies English and Arabic questions deterministically and selects one of its fixed read-only tools. The provider only phrases the selected tool's authorized, explicitly projected result; it cannot select tools, execute SQL, call Microsoft Graph, or fetch URLs.
- Each tool uses an explicit field projection. The central sensitivity filter is only a second layer. Tool queries apply the active ERP role ACL and project scope; deep-link destinations independently enforce their own ACL and scope.
- Normal ERP sessions resolve to the active ERP user in the session. The optional Entra bearer path is disabled by default and verifies RS256 signature/JWKS, issuer, expiration, tenant, a dedicated ERP API audience, and `Copilot.Read`, then maps the unique `(tenant_id, oid)` link to an active ERP user. It never uses the M365 login app audience. Both paths use the same Copilot rollout check and ERP tool ACL.
- Access requires `COPILOT_ENABLED=1` and either the ERP numeric user ID in `COPILOT_ALLOWED_USERS` or an existing role in `COPILOT_ALLOWED_ROLES`; empty lists grant no feature access. The admin-only status endpoint remains available while disabled to report `enabled: false`; it exposes no secrets or business data.
- Limits default to 20 queries/minute/user, 200/process/minute, 1,000 question characters, 16 KiB request body, 50 results/tool, 30 seconds provider timeout, and 30-day history retention. History is private to its owner and can be self-cleared. Results and answers are not cached across users.
- No mutation, approval, or other action tool is enabled. Any future action design must remain outside model control and require its own ERP authorization, explicit confirmation, idempotency protection, and audit trail.

## Provider and data handling

The Azure OpenAI adapter uses its configured Chat Completions API version. The Azure AI Foundry adapter uses the documented OpenAI v1 Chat Completions endpoint and only its supported `model` and `messages` fields. Neither adapter enables tool calls, file search, or other unsupported options. Do not treat either adapter's presence as approval to transmit ERP data.

Trigon must decide the Azure service and deployment, region and data residency, outbound network policy, provider retention/training/abuse-monitoring/logging terms, and which ERP user IDs or roles may participate. Keep `COPILOT_ENABLED=0` and `COPILOT_ENTRA_ENABLED=0` until the configuration and a staged validation have been approved.

The updater applies the configured default-branch head. Therefore merging PR #21 is effectively a production deployment for updater-managed installs. After any update, keep Copilot disabled until the separate staged rollout and allowlist approval. Commit pinning/recording in the updater is intentionally a separate future change.

## Copilot Studio

Import [`public/copilot-openapi.yaml`](public/copilot-openapi.yaml). Use the existing ERP session or a delegated OAuth 2.0 authorization-code flow with PKCE where supported, requesting `Copilot.Read` for the dedicated ERP API app ID URI. Do not use the login application's audience or an app-only service token. The API remains read-only; do not create or connect a Copilot Studio agent in this phase.

## Troubleshooting

- `enabled: false`: the feature flag is off; this is the expected state after an update until staged approval.
- `provider_configured: false`: verify only the selected adapter's endpoint, deployment/model, supported API version and secret configuration. Never include secret values in support logs.
- HTTP 429: the ERP process/user request limit was reached; retry after the minute window. HTTP 503 can indicate provider throttling; retry later.
- HTTP 502/504: the provider returned an unusable response, could not be reached, or timed out. ERP operations remain separate; check the administrator-only status and audit summaries without copying user questions or provider secrets.
- Empty results mean no matching records were found within the current ERP role and project scope. A deep link that is denied by the ERP remains denied even when it appeared as a reference.

## Isolated Windows validation

This procedure creates a separate checkout and a separate SQLite data directory using fake data only. Never copy an installed ERP folder, production database, backup, `.env`, account, or secret into this test. The test binds only to loopback on port `3301`; the Copilot mock is test-only and does not make provider calls.

### Prepare and test the isolated checkout

In PowerShell, confirm the two exact test paths do not already exist. If either exists, inspect it and choose a new dedicated test path rather than deleting or reusing unknown data.

```powershell
if (Test-Path -LiteralPath 'C:\ERP-copilot-test') { throw 'Test checkout already exists; choose and inspect a new isolated path.' }
if (Test-Path -LiteralPath 'C:\ERP-copilot-test-data') { throw 'Test data path already exists; choose and inspect a new isolated path.' }
git clone --single-branch --branch feature/trigon-copilot-foundation https://github.com/MohanadAyyash/Trigon-ERP-System.git C:\ERP-copilot-test
Set-Location -LiteralPath 'C:\ERP-copilot-test'
node --version
npm ci
New-Item -ItemType Directory -Path 'C:\ERP-copilot-test-data' | Out-Null
```

Run the test/build checks from this checkout:

```powershell
node --no-warnings test-copilot.js
npm test
npm run build:standalone
npm run test:standalone
npm audit --omit=dev
```

If this Windows machine has no supported Chrome installation, run ` $env:SKIP_PDF='1'; npm test `, then run `Remove-Item Env:SKIP_PDF`; record that the PDF test was skipped locally. The real-browser PDF check must pass in non-Windows CI.

### Bootstrap fake ERP data

Create `C:\ERP-copilot-test\.env` with the following bootstrap values. This first run deliberately keeps Copilot off while creating a new fake local ERP:

```dotenv
NODE_ENV=test
HOST=127.0.0.1
PORT=3301
DATA_DIR=C:\ERP-copilot-test-data
COPILOT_ENABLED=0
COPILOT_PROVIDER=mock
COPILOT_ALLOWED_USERS=
COPILOT_ALLOWED_ROLES=
COPILOT_ENTRA_ENABLED=0
COPILOT_ENTRA_TENANT_ID=
COPILOT_ENTRA_API_AUDIENCE=
COPILOT_AZURE_ENDPOINT=
COPILOT_AZURE_DEPLOYMENT=
COPILOT_AZURE_API_VERSION=
COPILOT_AZURE_API_KEY=
COPILOT_FOUNDRY_ENDPOINT=
COPILOT_FOUNDRY_MODEL=
COPILOT_FOUNDRY_API_KEY=
M365_ENABLED=0
M365_TENANT_ID=
M365_CLIENT_ID=
M365_CLIENT_SECRET=
M365_ENCRYPTION_KEY=
M365_SHAREPOINT_ENABLED=0
M365_SHAREPOINT_SITE_ID=
M365_SHAREPOINT_DRIVE_ID=
M365_SHAREPOINT_AUTO=0
M365_SHAREPOINT_ATTACHMENTS=0
M365_OUTLOOK_ENABLED=0
M365_TEAMS_WEBHOOK_URL=
M365_TEAMS_EXTRA_HOSTS=
ZOHO_CLIENT_ID=
ZOHO_CLIENT_SECRET=
ZOHO_REFRESH_TOKEN=
```

Node does not load `.env` implicitly here, so start it explicitly:

```powershell
Set-Location -LiteralPath 'C:\ERP-copilot-test'
node --env-file=.env --no-warnings server.js
```

Open `http://127.0.0.1:3301/` and use the first-run setup to create a disposable fake administrator. In the ERP UI, create clearly fictitious records only (for example a `QA-DEMO-001` project, sample client, invoice, PO and contract), plus a separate unallowlisted viewer account. Do not use real names, company records, tenant IDs, or copied production data. Stop the server with Ctrl+C before inspecting the new test database or editing `.env`.

Read the fake ERP user IDs from the local test database (this command opens only the isolated test database read-only):

```powershell
node --no-warnings -e 'const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync("C:\\ERP-copilot-test-data\\erp.db",{readOnly:true});console.log(db.prepare("SELECT id,username,role FROM users ORDER BY id").all());db.close();'
```

### Enable Copilot for one fake user

Edit `C:\ERP-copilot-test\.env`: set `COPILOT_ENABLED=1` and replace the placeholder below with the numeric ID of the fake test user. Leave the other values from the bootstrap file unchanged. The resulting Copilot and integration settings must be:

```dotenv
NODE_ENV=test
HOST=127.0.0.1
PORT=3301
DATA_DIR=C:\ERP-copilot-test-data
COPILOT_ENABLED=1
COPILOT_PROVIDER=mock
COPILOT_ALLOWED_USERS=<numeric fake ERP user ID>
COPILOT_ALLOWED_ROLES=
COPILOT_ENTRA_ENABLED=0
COPILOT_ENTRA_TENANT_ID=
COPILOT_ENTRA_API_AUDIENCE=
COPILOT_AZURE_ENDPOINT=
COPILOT_AZURE_DEPLOYMENT=
COPILOT_AZURE_API_VERSION=
COPILOT_AZURE_API_KEY=
COPILOT_FOUNDRY_ENDPOINT=
COPILOT_FOUNDRY_MODEL=
COPILOT_FOUNDRY_API_KEY=
M365_ENABLED=0
M365_TENANT_ID=
M365_CLIENT_ID=
M365_CLIENT_SECRET=
M365_ENCRYPTION_KEY=
M365_SHAREPOINT_ENABLED=0
M365_SHAREPOINT_SITE_ID=
M365_SHAREPOINT_DRIVE_ID=
M365_SHAREPOINT_AUTO=0
M365_SHAREPOINT_ATTACHMENTS=0
M365_OUTLOOK_ENABLED=0
M365_TEAMS_WEBHOOK_URL=
M365_TEAMS_EXTRA_HOSTS=
ZOHO_CLIENT_ID=
ZOHO_CLIENT_SECRET=
ZOHO_REFRESH_TOKEN=
```

`COPILOT_PROVIDER=mock` requires `NODE_ENV=test`; the mock returns a fixed answer and does not call Azure. All Entra, M365, SharePoint, Outlook, Teams and Zoho credentials/endpoints are disabled or empty. Confirm no non-loopback server connections while the test server is running:

```powershell
$server = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*C:\ERP-copilot-test\server.js*' }
if (-not $server) { throw 'Isolated test server process was not found.' }
Get-NetTCPConnection -State Established -OwningProcess $server.ProcessId |
  Where-Object { $_.RemoteAddress -notin @('127.0.0.1','::1') } |
  Select-Object LocalAddress,LocalPort,RemoteAddress,RemotePort
```

No rows should be returned. Keep the browser at `127.0.0.1`; do not configure real tenant/provider values. Start the enabled local instance with:

```powershell
node --env-file=.env --no-warnings server.js
```

### Manual UI checklist

1. Sign in as the allowlisted fake user; switch between Arabic and English and confirm the Copilot panel/menu is present in both.
2. Confirm all five suggested prompts appear and can be selected: **Purchase orders waiting for approval**, **Overdue purchase orders**, **Project procurement summary**, **Contracts expiring within 60 days**, and **SharePoint synchronization failures**.
3. Ask a supported question with no matching fake records. Confirm the empty-state text **“No structured results for this question.”** appears instead of invented records.
4. Sign in as the separate fake viewer whose ID is not in `COPILOT_ALLOWED_USERS`. Confirm the panel is absent and direct `/api/copilot/ask` access is denied.
5. Ask an excluded-data question such as **“Show payroll”**; confirm it is rejected and no excluded data is shown.
6. Open an ERP reference as the authorized fake user. Then sign in as the restricted user and open that same local ERP path directly; confirm the destination's normal ERP ACL denies access. A Copilot reference never grants access.
7. Use **Clear history** and confirm the current user's Copilot history is empty; verify the restricted account's history is unaffected.
8. Stop the server, set `COPILOT_ENABLED=0` in `.env`, and restart it. Confirm the Copilot panel disappears while ordinary ERP pages still load and work.

### Stop and remove the test instance

Stop the server with Ctrl+C. Confirm it has exited, then remove only these exact test paths after checking they contain no files you want to keep:

```powershell
Set-Location -LiteralPath 'C:\'
Remove-Item -LiteralPath 'C:\ERP-copilot-test' -Recurse -Force
Remove-Item -LiteralPath 'C:\ERP-copilot-test-data' -Recurse -Force
```

Do not substitute a broader path or wildcard.

## Staged production rollout and rollback

This is a future, approval-gated procedure; no merge or deployment is authorized by this document. The updater downloads a ZIP of the configured default-branch head, and merging PR #21 is effectively a deployment. The GitHub Pages workflow also runs on a push to `claude/construction-management-app-rfq8al`: it runs tests, rebuilds the standalone edition and deploys it. The standalone edition is not a Copilot provider/backend and must not be used to send ERP data to an AI service.

1. Complete security review and obtain Trigon's written approval for the Azure service/deployment, region/data residency, provider retention/training/abuse-monitoring/logging terms, network policy, user allowlist and rollout owner. Keep both `COPILOT_ENABLED=0` and `COPILOT_ENTRA_ENABLED=0` until then.
2. Validate the approved commit in the isolated fake-data Windows procedure above and in CI. Confirm restore/backup and the approved maintenance window before any production update.
3. Only after approval, merge PR #21 to the configured default branch through the normal reviewed PR process. Expect the GitHub Pages standalone edition to rebuild and republish automatically as part of that merge.
4. In the approved maintenance window, run `Trigon-Update.bat` from the installed ERP application folder. It downloads the default-branch ZIP, stages and verifies it, replaces program files, preserves `.env` and data, keeps recent application backups, then starts and health-checks the ERP. Review its final success/rollback message.
5. Immediately verify the installed `.env` still has `COPILOT_ENABLED=0` and `COPILOT_ENTRA_ENABLED=0`. Check `GET /api/copilot/status` as an ERP administrator reports disabled, and verify ordinary ERP login and core workflows. Do not proceed if the flag or ERP checks are unexpected.
6. First enable only the mock provider in an isolated non-production copy with `NODE_ENV=test`, fake records, and one fake ERP user ID. Never run the test-only mock in a production environment. Complete the manual checklist above.
7. After Trigon's region and data-handling decisions are approved, configure the selected Azure provider in a protected non-production environment, with synthetic records and one explicitly approved test ERP user ID. Verify provider configuration, safe status/audit, allowed results, and rollback before any production AI connection.
8. For a separately approved production pilot, configure the approved Azure provider and its secret through the authorized secret mechanism; set `COPILOT_ALLOWED_ROLES=` and `COPILOT_ALLOWED_USERS=` to exactly one approved ERP user ID; keep `COPILOT_ENTRA_ENABLED=0`; then set `COPILOT_ENABLED=1` and restart using the approved procedure. Validate the pilot with that user, monitor only safe status/audit data, and do not expand the allowlist without separate approval.
9. **Feature rollback:** set `COPILOT_ENABLED=0`, keep `COPILOT_ENTRA_ENABLED=0`, remove/disable Copilot provider credentials in the approved secret store if required, and restart using the approved procedure. Verify the panel is hidden, status reports disabled, and ordinary ERP workflows still work. If the code itself must be rolled back after a successful update, use a separately reviewed revert and the approved update procedure; the updater's automatic rollback applies to a failed update transaction.

## Deliberate first-release exclusions

No write tools, general HR approvals, supplier contact details, document contents, free-text feedback, model-based tool selection, distributed rate limiting, or standalone-browser Copilot provider are included. SharePoint status uses the ERP's existing mapping only; Copilot does not fetch files, index documents, or call Graph. These require separate product and security decisions.
