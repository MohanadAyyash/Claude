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

Run these commands only from the isolated development worktree with fake/local test fixtures. Do not copy production data or secrets into the worktree and do not run the application against the production installation.

```powershell
node --version
git status --short
node --no-warnings test-copilot.js
npm test
npm run build:standalone
npm run test:standalone
npm audit --omit=dev
```

`npm test` runs the real-server suites against temporary test data directories. If the machine has no supported Chrome installation, run the suite with `$env:SKIP_PDF='1'; npm test` in PowerShell, then remove the variable with `Remove-Item Env:SKIP_PDF`; record that the PDF-specific test was skipped. The browser/PDF suite must also pass in the non-Windows CI environment before release.

## Deliberate first-release exclusions

No write tools, general HR approvals, supplier contact details, document contents, free-text feedback, model-based tool selection, distributed rate limiting, or standalone-browser Copilot provider are included. SharePoint status uses the ERP's existing mapping only; Copilot does not fetch files, index documents, or call Graph. These require separate product and security decisions.
