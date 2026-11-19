# Trigon ERP Copilot Foundation

This is a disabled-by-default, read-only API foundation. It does not change ERP business logic, Microsoft 365 flows, or the standalone UI. Do not enable it against production data or connect a production AI service until Trigon has made the decisions below.

## Runtime behavior

- Every Copilot endpoint requires an active ERP identity and `COPILOT_ENABLED=1`.
- Access requires either the ERP user ID in `COPILOT_ALLOWED_USERS` or the role in `COPILOT_ALLOWED_ROLES`. Both unset or empty means nobody is allowed. This feature allowlist never overrides the existing role ACL for the data being requested.
- The server deterministically routes English and Arabic questions to one of three read-only tools: project status, project financial summaries, or invoice summaries. Other intents are rejected. There are no mutation tools.
- Each tool uses an explicit result projection. The provider receives only the chosen intent, the user's question, and that projection; it cannot choose tools, issue SQL, or call ERP endpoints.
- There is no cross-user cache. Each user's own question/answer history is retained for up to 30 days, omitted from sanitized backups, and can be cleared with `DELETE /api/copilot/history`.
- Limits: 1,000 characters per question, 16 KiB request body, 50 results per tool/history response, 20 queries per ERP user per minute, 200 queries per server process per minute, and a 30-second provider timeout.

## Endpoints

- `POST /api/copilot/ask` — JSON body `{ "question": "..." }`.
- `GET /api/copilot/history` — the signed-in user's recent history only.
- `DELETE /api/copilot/history` — clears only the signed-in user's history.

## Provider adapter

The implemented adapter targets the Azure OpenAI chat-completions endpoint with API-key authentication, a configured deployment name, and a pinned API version. No provider request is made unless Copilot is enabled, the caller is allowed, and a supported intent has produced authorized structured results. Missing or invalid provider configuration fails closed.

Azure AI Foundry is not claimed to be supported as a distinct provider. Trigon must confirm the selected Foundry deployment's endpoint shape, authentication method, and API version before it is configured; only a validated Azure OpenAI-compatible endpoint may use the current adapter. The provider only phrases the projected results; it is not an authorization or tool-routing layer.

Configure values through the deployment's secret/environment mechanism, never in source control:

```text
COPILOT_ENABLED=1
COPILOT_ALLOWED_USERS=12,34
COPILOT_ALLOWED_ROLES=manager,accountant
COPILOT_PROVIDER=azure-openai
COPILOT_AZURE_ENDPOINT=https://<approved-resource-endpoint>
COPILOT_AZURE_DEPLOYMENT=<approved-deployment>
COPILOT_AZURE_API_VERSION=<approved-api-version>
COPILOT_AZURE_API_KEY=<secret>
```

The `COPILOT_ENTRA_*` bearer-token path is separately disabled unless `COPILOT_ENTRA_ENABLED=1`. It verifies an RS256 access token's signature, expiry, issuer, tenant, dedicated `COPILOT_ENTRA_API_AUDIENCE`, and `Copilot.Read` scope. It maps `(tid, oid)` to the existing ERP-linked Microsoft identity and then applies the same ERP-user allowlist and per-tool role ACL as an ERP session. The Entra login application's client ID is not a valid API audience.

```text
COPILOT_ENTRA_ENABLED=1
COPILOT_ENTRA_TENANT_ID=<approved-tenant-guid>
COPILOT_ENTRA_API_AUDIENCE=api://<dedicated-erp-api>
```

The issuer and JWKS URL default to that tenant's Microsoft endpoints. `COPILOT_ENTRA_ISSUER` and `COPILOT_ENTRA_JWKS_URL` are optional overrides for a specifically reviewed identity provider (local tests use a loopback mock).

## Decisions required before production

Trigon must choose and approve the Azure region and data-residency requirements; whether question/result content may leave the ERP host; provider retention, abuse-monitoring, and model-training terms; the exact Azure OpenAI or Foundry service/deployment/API version and authentication; outbound network policy; provider-side logging; allowed ERP users/roles; and whether provider failure should remain a hard error. Local Copilot history retention is 30 days, but that does not decide the provider's retention or residency policy. Until those decisions are recorded and deployment configuration is reviewed, keep both `COPILOT_ENABLED` and `COPILOT_ENTRA_ENABLED` unset.

## أساس Copilot في Trigon ERP

هذه واجهة تجريبية للقراءة فقط ومعطّلة افتراضياً. لا تغيّر منطق ERP أو تدفّقات Microsoft 365 أو النسخة المستقلة. لا تفعّلها على بيانات الإنتاج ولا تربطها بخدمة ذكاء اصطناعي إنتاجية قبل اعتماد قرارات Trigon أدناه.

### السلوك

- تتطلب جميع نقاط Copilot هوية ERP نشطة و`COPILOT_ENABLED=1`.
- يلزم إدراج معرّف مستخدم ERP في `COPILOT_ALLOWED_USERS` أو دوره في `COPILOT_ALLOWED_ROLES`. القائمتان الفارغتان تمنعان الجميع. لا تتجاوز هذه القائمة صلاحيات الدور الحالية على البيانات المطلوبة.
- يوجّه الخادم الأسئلة العربية والإنجليزية بشكل حتمي إلى إحدى الأدوات الثلاث للقراءة فقط: حالة المشاريع، أو ملخصاتها المالية، أو ملخص الفواتير. تُرفض المواضيع الأخرى. لا توجد أدوات تعديل.
- لكل أداة إسقاط حقول صريح؛ لا يستلم المزوّد إلا النية المحددة والسؤال والنتائج المصرّح بها. لا يختار المزوّد الأدوات ولا ينفّذ SQL أو يستدعي ERP.
- لا يوجد تخزين مؤقت مشترك بين المستخدمين. يُحتفظ بتاريخ كل مستخدم لمدة أقصاها 30 يوماً، ولا يُضمَّن في النسخ الاحتياطية المنقّحة، ويمكنه مسحه عبر `DELETE /api/copilot/history`.
- الحدود: 1000 حرف للسؤال، 16 كيلوبايت للطلب، 50 نتيجة، 20 استعلاماً لكل مستخدم في الدقيقة، 200 استعلام لكل عملية خادم في الدقيقة، ومهلة 30 ثانية للمزوّد.

### نقاط النهاية

- `POST /api/copilot/ask` — جسم JSON بالشكل `{ "question": "..." }`.
- `GET /api/copilot/history` — سجل المستخدم الحالي فقط.
- `DELETE /api/copilot/history` — يمسح سجل المستخدم الحالي فقط.

### المزوّد والقرارات المطلوبة

المحوّل الحالي يستهدف واجهة Azure OpenAI للمحادثة باستخدام مفتاح API واسم نشر وإصدار API محددين. لا يُرسل أي طلب للمزوّد قبل تفعيل Copilot والتحقق من المستخدم والنية والنتائج. الإعداد الناقص أو غير الصحيح يرفض الطلب.

لا ندّعي دعم Azure AI Foundry كمزوّد منفصل. على Trigon التحقق من شكل نقطة النهاية والمصادقة وإصدار API للنشر المختار قبل استخدامه؛ ولا يستخدم المحوّل الحالي إلا نقطة نهاية متوافقة فعلياً مع Azure OpenAI. دور المزوّد هو صياغة النتائج المعروضة فقط.

يتطلب مسار Entra المتغيرات `COPILOT_ENTRA_ENABLED=1` و`COPILOT_ENTRA_TENANT_ID` و`COPILOT_ENTRA_API_AUDIENCE` المخصّص. يستخدم افتراضياً مصدر مفاتيح Microsoft الخاص بالمستأجر؛ ولا تضبط روابط المصدر البديلة إلا بعد مراجعتها.

قبل الإنتاج، على Trigon اعتماد منطقة Azure ومكان إقامة البيانات، والسماح بإرسال الأسئلة والنتائج خارج خادم ERP، وسياسة الاحتفاظ ومراقبة إساءة الاستخدام وتدريب النماذج، والخدمة/النشر وإصدار API والمصادقة، وسياسة الاتصالات الصادرة وسجلات المزوّد، وقوائم المستخدمين والأدوار، والتعامل مع تعذّر المزوّد. احتفاظ ERP المحلي لمدة 30 يوماً لا يحدد سياسة المزوّد. حتى اعتماد هذه القرارات ومراجعة الإعدادات، اترك `COPILOT_ENABLED` و`COPILOT_ENTRA_ENABLED` دون ضبط.
