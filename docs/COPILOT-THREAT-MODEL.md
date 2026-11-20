# Trigon Copilot threat model

## Scope and trust boundaries

Copilot is a read-only feature in the existing ERP server. It accepts an ERP session or an optional, disabled-by-default delegated Entra access token, resolves one active ERP user, applies the feature allowlist and current ERP ACL/project scope, runs one deterministic server-side tool, then optionally sends only projected facts to the configured answer provider. The browser renders user messages, assistant text, record fields, and links. Conversation, memory, preferences, audit, and feedback records are stored in the ERP database.

The standalone browser edition has no provider or Copilot API. No write, approval, Graph, SQL, file-fetch, or arbitrary tool-selection capability is in scope. Production provider and residency choices are not approved by this implementation.

## Assets and security objectives

- ERP financial and project records: reveal only fields and records authorized by the current role and project scope.
- User identity and sessions: map each request to one active ERP user; never trust identity or role supplied in a request body.
- Conversations, memory, preferences, and feedback: private to their owner; exportable and deletable by that owner; removed from sanitized backups.
- Provider credentials and endpoint configuration: never return, log, or include in prompts.
- Reference links: usable only as navigation; destination ACLs remain authoritative. SharePoint URLs are validated and stripped of query/fragment data before UI delivery.
- Availability and ERP integrity: bounded request size, question length, result count, request rate, and provider timeout; no Copilot write path.

## Threats and mitigations

| Threat | Mitigations |
|---|---|
| Prompt injection or a request to reveal excluded data | Deterministic bilingual routing and exclusion checks run before tools; the provider receives only projected structured data, treats it and the question as untrusted, and cannot select tools or execute code. Memory cannot alter policy. |
| A new sensitive database column leaks through a tool | Every tool has a specific field projection; the shared sensitivity policy is only a secondary defense. Regression coverage adds a sensitive test column and asserts it never reaches the UI/provider. |
| Cross-role, cross-project, or stale follow-up disclosure | Every follow-up reloads the active ERP user and authorization fingerprint, clears prior context on role/project-scope changes, re-parses only bounded intent/filter/ID context, and re-runs the selected tool's ERP ACL and project scope. Direct ERP links independently enforce ACLs. |
| Cross-user conversation or memory access | SQL reads/writes are scoped to the authenticated user ID; admin APIs do not expose another user's content. Conversations and history are ownership-checked; memory/prefs are private. Tests exercise cross-user and administrator attempts. |
| Memory expands scope or overrides safety rules | Memory is untrusted, capped at 50 items and 300 characters/item, rejects sensitive/policy-override content, is never sent verbatim to the provider, and only influences an accessible project/filter or presentation language after current authorization. Lost project access causes the preference/note to be ignored and purged. |
| XSS through question text, assistant output, record names, or preferences | The UI escapes all content before HTML insertion; only validated internal hash routes and HTTPS SharePoint hosts can become links. Rendering tests exercise malicious messages and record titles. |
| Entra token confusion or token replay | The optional path is off by default; it requires RS256/JWKS, issuer, expiry, tenant, a dedicated API audience and `Copilot.Read`, rejects the login app audience and app-only tokens, and maps `(tid, oid)` to exactly one active ERP user. Both identities share the same authorization path. |
| Provider/network failure or denial of service | Configured provider allowlist/HTTPS validation, request-size/length/result/rate caps, a 30-second timeout, friendly errors, and no outbound calls for greetings/unsupported/excluded requests. The mock provider is test-only. |
| Sensitive operational traces or backup retention | Audit records safe event/outcome/count/duration fields only, never prompts or provider errors. Sanitized backups omit conversations, history, feedback, memory, preferences, and Copilot audit. Disabling an ERP user deletes their Copilot data. |

## Privacy and retention

Conversation retention defaults to 90 days and is configurable with `COPILOT_HISTORY_RETENTION_DAYS`; users may delete one conversation or all history and export their data. Explicit notes are limited to 50 per user and 300 characters each. Learned preferences are deterministic aggregates (language, intent/entity/project/filter counts), not activity timelines. Users can inspect them in **My memory**, disable personalization, or reset learned aggregates. A bilingual first-use notice explains collection and controls.

Memory and preferences never grant ERP access. No productivity or performance scoring, behavioral evaluation, mood/protected-trait inference, or HR/payroll use is allowed. Sanitized backups exclude these private records. The current implementation does not add a separate storage-encryption mechanism beyond the ERP database's existing protections.

## Residual risks and decisions

- Before any production provider connection, Trigon must approve the Azure service/model, region and data residency, outbound network route, what projected ERP data may leave the ERP host, provider retention/training/abuse-monitoring/logging terms, and failure handling.
- Rate limiting is in-memory and per server process, not distributed across a multi-process deployment.
- The model can produce a misleading explanation despite bounded evidence; the UI separates generated explanation from ERP facts, and the ERP remains authoritative.
- Users with access to their own account can save arbitrary non-sensitive notes; these notes remain untrusted and do not become instructions or authorization.
- Merging PR #21 updates the updater's default-branch payload and republishes the standalone edition. Keep `COPILOT_ENABLED=0` after update until a separate reviewed staged rollout. No production access, provider connection, merge, or deployment is part of this change.
