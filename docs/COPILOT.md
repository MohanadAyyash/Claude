# Trigon ERP Copilot

The Copilot feature is an opt-in, read-only assistant. It is disabled by default and does not change ERP accounting, payroll, VAT, invoice, approval, or Microsoft 365 business flows. Do not enable it against production data or connect a production AI service until Trigon has approved the open decisions below.

## What is implemented

- The English/Arabic UI is available only to an authenticated user who is allowed by the server.
- Intent routing and tool selection are deterministic server-side. The model cannot select tools, issue SQL, or call ERP endpoints.
- Read-only tools: project status/financial summaries; invoices (outstanding, current-month, per-project totals and status); PO/RFQ status (approval, overdue, value threshold, monthly supplier counts); quotations; subcontract status/expiry; approved subcontract certificates; project document metadata by type; and SharePoint sync status/failures.
- Every tool has explicit field projections. A central sensitive-field denylist is an additional filter, not a substitute for those projections. Attachments, document contents and filenames, SharePoint URLs, supplier contact details, employee/HR data, payroll, tax returns, and ledger data are not supplied to the model.
- Existing ERP role ACLs are checked for every tool and record. Site roles are limited to assigned projects wherever the ERP permits them to use a tool. SharePoint rows are security-trimmed by the ACL for the underlying ERP record; raw provider errors and audit details are never sent.
- ERP deep links are references only. The destination's own ERP API still enforces role and record/project scope; a Copilot result does not grant access. Authorized SharePoint links are returned only to the ERP UI after HTTPS/host validation, with query strings removed; links and ERP references are withheld from the AI provider.
- Procurement access stays within the procurement ACL; accountant access uses the existing invoice/project-summary ACL. General-ledger, payroll, HR, WPS, personal identity and bank details are not tools.
- The provider only phrases the authorized structured result. The question and result are treated as untrusted input. There is no cross-user cache.

## API and UI

`public/copilot-openapi.yaml` is the OpenAPI 3.1 description for Copilot Studio and other clients. The UI is at **Trigon Copilot** for allowlisted users. Feature routes require `COPILOT_ENABLED=1`, an active ERP identity, and `COPILOT_ALLOWED_USERS` containing the ERP user ID **or** `COPILOT_ALLOWED_ROLES` containing the role. Empty lists grant nobody feature access. Feature access never overrides a tool's normal ERP ACL. The admin-only status route is the exception: an authenticated ERP administrator may read safe configuration and operational metadata while the feature is disabled.

| Route | Behavior |
|---|---|
| `GET /api/copilot/status` | Safe limits and provider metadata; admin-only operational aggregate details, including anonymous rate-limit counts |
| `POST /api/copilot/ask` | Deterministically select one authorized read-only tool and phrase its projected results |
| `GET /api/copilot/history` | Current user's recent question/answer history |
| `DELETE /api/copilot/history` | Clear only the current user's history |
| `POST /api/copilot/feedback` | Store a helpful/not-helpful rating and optional fixed reason code for the user's own history item; no free-text feedback |
| `GET /api/copilot/audit` | Admin-only structured events; no prompts, answers, document content, or provider errors |

History is pruned after the configured retention period. History, feedback and Copilot audit rows are removed from sanitized backup copies, never from the live database.

## Identity and authorization

The regular path uses the existing ERP session. The optional Entra bearer-token path is separately disabled unless `COPILOT_ENTRA_ENABLED=1`. Its expected acquisition flow is delegated OAuth 2.0 authorization code with PKCE where supported, requesting `Copilot.Read` for the dedicated ERP API app ID URI. It verifies an RS256 signature/JWKS, issuer, expiry, tenant (`tid`), the dedicated API audience, and the scope; it maps `(tid, oid)` to exactly one active ERP-linked user. The login application's `M365_CLIENT_ID` audience and app-only tokens are rejected. Both paths resolve to an ERP user and pass through the same feature allowlist and per-tool ERP ACL checks.

## Limits and configuration

The shipped `.env.example` keeps the feature and Entra path disabled. Use only a deployment's approved secret/environment mechanism; never commit secrets.

| Variable | Default | Allowed configuration |
|---|---:|---|
| `COPILOT_ENABLED` | `0` | Set to `1` only after review |
| `COPILOT_ALLOWED_USERS` | empty | Comma/space-separated ERP numeric user IDs |
| `COPILOT_ALLOWED_ROLES` | empty | Comma/space-separated existing ERP role names |
| `COPILOT_MAX_RESULTS` | 50 | Integer 1–50 |
| `COPILOT_USER_LIMIT` | 20 | Integer 1–1000 queries per ERP user per minute |
| `COPILOT_GLOBAL_LIMIT` | 200 | Integer 1–10000 queries per server process per minute |
| `COPILOT_TIMEOUT_MS` | 30000 | Integer 1000–30000 |
| `COPILOT_HISTORY_RETENTION_DAYS` | 30 | Integer 1–3650 |
| `COPILOT_PROVIDER` | `azure-openai` | `azure-openai`, `azure-foundry`, or test-only `mock` |
| `COPILOT_AZURE_ENDPOINT` | unset | HTTPS `*.openai.azure.com` resource endpoint; local loopback HTTP only in tests |
| `COPILOT_AZURE_DEPLOYMENT` | unset | Deployment name |
| `COPILOT_AZURE_API_VERSION` | unset | Explicit date version (optional `-preview`) |
| `COPILOT_AZURE_API_KEY` | unset | Secret; never returned or logged |
| `COPILOT_FOUNDRY_ENDPOINT` | unset | HTTPS Foundry v1 resource endpoint; root URL only |
| `COPILOT_FOUNDRY_MODEL` | unset | Deployed model name that supports v1 chat completions |
| `COPILOT_FOUNDRY_API_KEY` | unset | Secret for the Foundry resource; never returned or logged |
| `COPILOT_ENTRA_ENABLED` | `0` | Optional bearer path; off by default |
| `COPILOT_ENTRA_TENANT_ID` | unset | Single approved tenant GUID |
| `COPILOT_ENTRA_API_AUDIENCE` | unset | Dedicated ERP Copilot API audience, not the login app audience |
| `COPILOT_ENTRA_ISSUER`, `COPILOT_ENTRA_JWKS_URL` | tenant defaults | Optional reviewed overrides; loopback HTTP is test-only |

Hard request limits remain 1,000 characters per question, 16 KiB per body, 50 results per tool, and a 30-second maximum provider timeout. Rate defaults are 20 queries/minute/user plus 200/server process; these values are configurable within the ranges above. Throttles are in-memory and therefore apply per server process, not as a distributed cluster-wide quota. Requests combining a supported topic with URLs, path traversal, SQL/Graph commands, or credential-like terms are rejected before routing.

## Provider and production decisions

The `azure-openai` adapter uses the explicitly configured Azure OpenAI Chat Completions API version. The `azure-foundry` adapter uses the Microsoft Foundry OpenAI v1 Chat Completions route (`/openai/v1/chat/completions`) and requires a deployed model supporting that API; it sends the documented `model` and `messages` fields only. It does not configure tools, JSON mode, file search, content filters, or other unsupported features. The v1 endpoint supports `*.openai.azure.com` and `*.services.ai.azure.com` resource hosts; see [Microsoft's v1 API documentation](https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle?view=foundry-classic). The deterministic `mock` provider is test-only and does not use the network.

Before any production use, Trigon must approve the provider/service and deployment, Azure region and data residency, whether questions and projected ERP results may leave the ERP host, provider retention/training/abuse-monitoring/logging terms, outbound network rules, allowlisted users/roles, and provider-failure handling. The implementation and local mocks do not make those decisions or contact production services. Keep both `COPILOT_ENABLED` and `COPILOT_ENTRA_ENABLED` off until approval and deployment review.

The deterministic server router is the only v1 tool-selection interface. If model-based selection is proposed later, its output must be constrained to the same fixed tool registry and re-authorized server-side; the model must never issue an arbitrary tool name, SQL, Graph request, or URL fetch.

## Deliberate first-release exclusions

No mutation/action tools, general HR approvals, supplier contact fields, raw document/attachment contents, free-text feedback, model-based tool selection, or distributed rate limiting are included. SharePoint links are limited to validated links already mapped to an ERP record; Copilot does not fetch files or make Graph calls. These remaining exclusions require a separate security/product decision and must not be inferred as supported by this API. Copilot is supported only in the Node server deployment; the standalone browser edition has no server-side provider or Entra authentication path.

## Deployment and rollout boundary

The updater downloads the configured default-branch head, so merging PR #21 updates the code used by updater-managed installations and is effectively a production deployment. Keep `COPILOT_ENABLED=0` after any update, including a merge, until Trigon separately completes staged validation and explicitly enables a reviewed ERP user ID or role. The staged process is: approve provider/region/data-handling/network decisions; validate with fake data and local mocks; stage the reviewed provider configuration with the feature disabled; verify admin status and the chosen staged ERP identity/role; then obtain explicit Trigon approval before enabling the narrow allowlist. Do not enable Copilot as part of the update itself. This PR does not change updater behavior or pin/record deployed commits. Rollback is `COPILOT_ENABLED=0` plus the normal approved application restart; no ERP or Microsoft 365 data or settings are changed.

---

# مساعد Trigon ERP

ميزة Copilot اختيارية ومخصّصة للقراءة فقط، ومعطّلة افتراضياً. لا تغيّر المحاسبة أو الرواتب أو ضريبة القيمة المضافة أو الفواتير أو الاعتمادات أو تدفّقات Microsoft 365. لا تفعّلها على بيانات الإنتاج ولا تربطها بخدمة ذكاء اصطناعي إنتاجية قبل اعتماد القرارات أدناه.

## ما تم تنفيذه

- واجهة عربية وإنجليزية لا تظهر إلا لمستخدم ERP مسجّل ومصرّح له من الخادم.
- يحدد الخادم النية والأداة بقواعد ثابتة؛ لا يختار النموذج الأدوات ولا ينفّذ SQL ولا يستدعي ERP.
- أدوات قراءة فقط: حالة المشاريع وملخصاتها المالية؛ الفواتير (المستحقة والحالية ومجاميع كل مشروع والحالة)؛ أوامر الشراء وطلبات الأسعار (الاعتماد والتأخير والقيمة وعدد أوامر المورد شهرياً)؛ عروض الأسعار؛ حالة عقود الباطن وانتهائها؛ شهادات الباطن المعتمدة؛ بيانات المستندات حسب النوع؛ وحالة مزامنة SharePoint وإخفاقاتها.
- لكل أداة إسقاط حقول صريح. قائمة الحقول الحساسة المركزية طبقة إضافية وليست بديلاً عن الإسقاطات. لا تُرسل محتويات الملفات أو المرفقات أو أسماءها أو روابط SharePoint أو بيانات اتصال الموردين أو بيانات الموظفين والموارد البشرية أو الرواتب أو الإقرارات الضريبية أو دفتر الأستاذ إلى النموذج.
- تُفحص صلاحيات ERP الحالية لكل أداة وسجل. تقتصر أدوار الموقع على مشاريعها المعيّنة حيث تسمح صلاحية ERP بالأداة. تُصفّى سجلات SharePoint بحسب صلاحية سجل ERP المرتبط؛ ولا تُرسل أخطاء المزوّد أو تفاصيل التدقيق الخام.
- روابط ERP مراجع فقط وتعيد الصفحة المقصودة فحص الصلاحيات. روابط SharePoint المعتمدة تظهر في واجهة ERP بعد التحقق من HTTPS والنطاق وحذف معاملات الرابط؛ ولا تُرسل الروابط أو مراجع ERP إلى مزوّد الذكاء الاصطناعي.
- صلاحيات المشتريات والمحاسب تتبع ACL الحالية. لا توجد أداة لدفتر الأستاذ أو الرواتب أو الموارد البشرية أو WPS أو بيانات الهوية والبنوك.
- يقتصر دور المزوّد على صياغة النتائج المنظمة المصرح بها. يُعامل السؤال والنتائج كمدخلات غير موثوقة، ولا يوجد تخزين مؤقت مشترك بين المستخدمين.

## الواجهة وواجهة API

يصف `public/copilot-openapi.yaml` واجهة OpenAPI 3.1 المتاحة لـ Copilot Studio والعملاء الآخرين. تظهر واجهة **مساعد Trigon** للمستخدمين المصرّح لهم. تتطلب مسارات الميزة `COPILOT_ENABLED=1` وهوية ERP نشطة وإدراج معرّف المستخدم الرقمي في `COPILOT_ALLOWED_USERS` **أو** دوره في `COPILOT_ALLOWED_ROLES`. القائمتان الفارغتان تمنعان الجميع من استخدام الميزة. استثناء ذلك مسار الحالة للمسؤول الموثق، إذ يعرض معلومات إعداد وتشغيل آمنة حتى أثناء التعطيل. ولا تتجاوز قائمة Copilot صلاحيات أداة ERP.

| المسار | السلوك |
|---|---|
| `GET /api/copilot/status` | حدود ومعلومات مزوّد آمنة؛ حالة تشغيلية مجمعة للمسؤول فقط |
| `POST /api/copilot/ask` | اختيار أداة قراءة فقط بشكل حتمي وصياغة نتيجتها المسموح بها |
| `GET /api/copilot/history` | سجل أسئلة وأجوبة المستخدم الحالي |
| `DELETE /api/copilot/history` | مسح سجل المستخدم الحالي فقط |
| `POST /api/copilot/feedback` | تقييم مفيد/غير مفيد ورمز سبب ثابت لسجل المستخدم نفسه، دون نص حر |
| `GET /api/copilot/audit` | أحداث منظمة للمسؤول فقط، بلا أسئلة أو إجابات أو محتوى مستندات أو أخطاء مزوّد |

يُحذف السجل بعد مدة الاحتفاظ المضبوطة. لا تُحفظ بيانات السجل أو التقييم أو تدقيق Copilot في نسخ قاعدة البيانات المنقّحة؛ ولا تُحذف من قاعدة البيانات الحية بسبب النسخ الاحتياطي.

## الهوية والصلاحيات

يستخدم المسار المعتاد جلسة ERP الحالية. ومسار رمز Entra منفصل ومعطّل ما لم يُضبط `COPILOT_ENTRA_ENABLED=1`. يتحقق من توقيع RS256 ومفاتيح JWKS والمُصدر والانتهاء والمستأجر (`tid`) والجمهور المخصّص للـ API ونطاق `Copilot.Read`؛ ثم يربط `(tid, oid)` بمستخدم ERP نشط ومربوط بحساب Microsoft واحد فقط. يُرفض جمهور تطبيق تسجيل الدخول `M365_CLIENT_ID`. يحوّل المساران الهوية إلى مستخدم ERP واحد ويطبّقان قائمة Copilot وصلاحيات ERP نفسها.

## الحدود والإعداد

يُبقي ملف `.env.example` الميزة ومسار Entra معطّلين. استخدم آلية الأسرار المعتمدة للنشر فقط، ولا تحفظ الأسرار في Git.

| المتغير | الافتراضي | الإعداد المسموح |
|---|---:|---|
| `COPILOT_ENABLED` | `0` | `1` بعد المراجعة فقط |
| `COPILOT_ALLOWED_USERS` | فارغ | معرّفات مستخدمي ERP الرقمية |
| `COPILOT_ALLOWED_ROLES` | فارغ | أسماء أدوار ERP المعروفة |
| `COPILOT_MAX_RESULTS` | 50 | عدد صحيح من 1 إلى 50 |
| `COPILOT_USER_LIMIT` | 20 | من 1 إلى 1000 استعلام لكل مستخدم بالدقيقة |
| `COPILOT_GLOBAL_LIMIT` | 200 | من 1 إلى 10000 استعلام لكل عملية خادم بالدقيقة |
| `COPILOT_TIMEOUT_MS` | 30000 | عدد صحيح من 1000 إلى 30000 |
| `COPILOT_HISTORY_RETENTION_DAYS` | 30 | عدد صحيح من 1 إلى 3650 |
| `COPILOT_PROVIDER` | `azure-openai` | `azure-openai` أو `azure-foundry` أو `mock` للاختبارات فقط |
| `COPILOT_AZURE_ENDPOINT` | غير مضبوط | نقطة Azure OpenAI من نوع `*.openai.azure.com` عبر HTTPS؛ HTTP محلي للاختبارات فقط |
| `COPILOT_AZURE_DEPLOYMENT` | غير مضبوط | اسم النشر |
| `COPILOT_AZURE_API_VERSION` | غير مضبوط | إصدار بتاريخ محدد |
| `COPILOT_AZURE_API_KEY` | غير مضبوط | سر لا يُعرض ولا يُسجّل |
| `COPILOT_FOUNDRY_ENDPOINT` | غير مضبوط | جذر نقطة مورد Foundry عبر HTTPS |
| `COPILOT_FOUNDRY_MODEL` | غير مضبوط | اسم نموذج منشور يدعم Chat Completions v1 |
| `COPILOT_FOUNDRY_API_KEY` | غير مضبوط | سر مورد Foundry لا يُعرض ولا يُسجّل |
| `COPILOT_ENTRA_ENABLED` | `0` | مسار الرمز الاختياري، معطّل افتراضياً |
| `COPILOT_ENTRA_TENANT_ID` | غير مضبوط | معرّف المستأجر المعتمد |
| `COPILOT_ENTRA_API_AUDIENCE` | غير مضبوط | جمهور API مخصّص، غير جمهور تطبيق تسجيل الدخول |

الحدود: 1000 حرف للسؤال، 16 كيلوبايت للجسم، 50 نتيجة لكل أداة ومهلة مزوّد لا تتجاوز 30 ثانية. الافتراضي 20 طلباً لكل مستخدم و200 لكل عملية خادم في الدقيقة، ويمكن ضبطهما ضمن النطاقات أعلاه. الحدود المخزنة في الذاكرة لكل عملية خادم وليست موزعة على مجموعة خوادم.

## المزوّد وقرارات الإنتاج

يستخدم محوّل `azure-openai` إصدار Chat Completions المضبوط صراحة. ويستخدم محوّل `azure-foundry` مسار Microsoft Foundry OpenAI v1 (`/openai/v1/chat/completions`) ويشترط نموذجاً منشوراً يدعم هذا المسار؛ ولا يرسل إلا الحقول الموثقة `model` و`messages`. لا يفعّل الأدوات أو وضع JSON أو البحث بالملفات أو مرشحات المحتوى أو خيارات غير مدعومة. تدعم واجهة v1 نطاقي `*.openai.azure.com` و`*.services.ai.azure.com` وفق [توثيق Microsoft](https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle?view=foundry-classic). مزوّد `mock` للاختبارات فقط ولا يستخدم الشبكة.

قبل الإنتاج، على Trigon اعتماد الخدمة والنشر، ومنطقة Azure ومكان إقامة البيانات، والسماح بإرسال الأسئلة والنتائج المصرّح بها خارج خادم ERP، وسياسات الاحتفاظ والتدريب ومراقبة إساءة الاستخدام والسجلات لدى المزوّد، وسياسة الاتصالات الصادرة، وقوائم المستخدمين والأدوار، والتعامل عند تعذّر المزوّد. لم يتصل التنفيذ والاختبارات المحلية بخدمة إنتاجية ولم يتخذا هذه القرارات. اترك `COPILOT_ENABLED` و`COPILOT_ENTRA_ENABLED` دون تفعيل حتى الاعتماد والمراجعة.

## استثناءات الإصدار الأول

لا توجد أدوات تعديل أو تنفيذ إجراءات أو قائمة اعتمادات الموارد البشرية العامة أو بيانات اتصال الموردين أو محتوى المرفقات أو تقييم حر أو اختيار أدوات بالنموذج أو تحديد معدل موزع. روابط SharePoint تقتصر على الروابط الموثقة المرتبطة بسجل ERP؛ ولا يجلب Copilot الملفات أو يستدعي Graph. تحتاج الاستثناءات إلى قرار منتج ومراجعة أمنية، ولا ينبغي اعتبارها مدعومة. يعمل Copilot في خادم Node فقط؛ ولا تحتوي النسخة المستقلة على مزوّد من جهة الخادم أو مصادقة Entra.

## النشر والتفعيل

يجلب المحدّث رأس الفرع الافتراضي؛ لذلك فإن دمج PR #21 يحدّث الكود الذي تستخدمه التثبيتات ويُعدّ عملياً نشراً للإنتاج. اترك `COPILOT_ENABLED=0` بعد أي تحديث أو دمج حتى تنتهي Trigon من التحقق المرحلي وتفعّل صراحة مستخدم ERP أو دوراً تمت مراجعته. لا يغيّر هذا PR المحدّث ولا يثبّت أو يسجل commit النشر. للتراجع، اضبط `COPILOT_ENABLED=0` ثم أعد تشغيل التطبيق بالطريقة المعتمدة؛ لا تتغير بيانات ERP أو Microsoft 365.
