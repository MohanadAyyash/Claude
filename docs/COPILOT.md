# Trigon ERP Copilot

The Copilot feature is an opt-in, read-only assistant. It is disabled by default and does not change ERP accounting, payroll, VAT, invoice, approval, or Microsoft 365 business flows. Do not enable it against production data or connect a production AI service until Trigon has approved the open decisions below.

## What is implemented

- The English/Arabic UI is available only to an authenticated user who is allowed by the server.
- Intent routing and tool selection are deterministic server-side. The model cannot select tools, issue SQL, or call ERP endpoints.
- Read-only tools: project status, project financial summaries, invoice summaries, procurement (PO/RFQ) status, subcontract summaries, project document metadata, spend approval queue, and SharePoint sync-failure status.
- Every tool has explicit field projections. A central sensitive-field denylist is an additional filter, not a substitute for those projections. Attachments, document contents and filenames, SharePoint URLs, supplier contact details, employee/HR data, payroll, tax returns, and ledger data are not supplied to the model.
- Existing ERP role ACLs are checked for every tool. Site roles are limited to their assigned projects wherever the ERP permits them to use a tool. Admin-only SharePoint failure details are further reduced to operational status fields; raw provider errors are never sent.
- ERP deep links are references only. The destination's own ERP API still enforces role and record/project scope; a Copilot result does not grant access.
- The provider only phrases the authorized structured result. The question and result are treated as untrusted input. There is no cross-user cache.

## API and UI

`public/copilot-openapi.yaml` is the OpenAPI 3.1 description for Copilot Studio and other clients. The UI is at **Trigon Copilot** for allowlisted users. Every API route requires `COPILOT_ENABLED=1`, an active ERP identity, and `COPILOT_ALLOWED_USERS` containing the ERP user ID **or** `COPILOT_ALLOWED_ROLES` containing the role. Empty lists grant nobody access. Feature access never overrides a tool's normal ERP ACL.

| Route | Behavior |
|---|---|
| `GET /api/copilot/status` | Supported intents, result/retention limits, and a provider-configured boolean; no secrets |
| `POST /api/copilot/ask` | Deterministically select one authorized read-only tool and phrase its projected results |
| `GET /api/copilot/history` | Current user's recent question/answer history |
| `DELETE /api/copilot/history` | Clear only the current user's history |
| `POST /api/copilot/feedback` | Store a helpful/not-helpful rating and optional fixed reason code for the user's own history item; no free-text feedback |
| `GET /api/copilot/audit` | Admin-only structured events; no prompts, answers, document content, or provider errors |

History is pruned after the configured retention period. History, feedback and Copilot audit rows are removed from sanitized backup copies, never from the live database.

## Identity and authorization

The regular path uses the existing ERP session. The optional Entra bearer-token path is separately disabled unless `COPILOT_ENTRA_ENABLED=1`. It verifies an RS256 signature/JWKS, issuer, expiry, tenant (`tid`), the dedicated API audience, and the `Copilot.Read` scope; it maps `(tid, oid)` to exactly one active ERP-linked user. The login application's `M365_CLIENT_ID` audience is rejected. Both paths resolve to an ERP user and pass through the same feature allowlist and per-tool ERP ACL checks.

## Limits and configuration

The shipped `.env.example` keeps the feature and Entra path disabled. Use only a deployment's approved secret/environment mechanism; never commit secrets.

| Variable | Default | Allowed configuration |
|---|---:|---|
| `COPILOT_ENABLED` | `0` | Set to `1` only after review |
| `COPILOT_ALLOWED_USERS` | empty | Comma/space-separated ERP numeric user IDs |
| `COPILOT_ALLOWED_ROLES` | empty | Comma/space-separated existing ERP role names |
| `COPILOT_MAX_RESULTS` | 50 | Integer 1–50 |
| `COPILOT_TIMEOUT_MS` | 30000 | Integer 1000–30000 |
| `COPILOT_HISTORY_RETENTION_DAYS` | 30 | Integer 1–3650 |
| `COPILOT_PROVIDER` | `azure-openai` | Only this adapter is implemented |
| `COPILOT_AZURE_ENDPOINT` | unset | HTTPS `*.openai.azure.com` resource endpoint; local loopback HTTP only in tests |
| `COPILOT_AZURE_DEPLOYMENT` | unset | Deployment name |
| `COPILOT_AZURE_API_VERSION` | unset | Explicit date version (optional `-preview`) |
| `COPILOT_AZURE_API_KEY` | unset | Secret; never returned or logged |
| `COPILOT_ENTRA_ENABLED` | `0` | Optional bearer path; off by default |
| `COPILOT_ENTRA_TENANT_ID` | unset | Single approved tenant GUID |
| `COPILOT_ENTRA_API_AUDIENCE` | unset | Dedicated ERP Copilot API audience, not the login app audience |
| `COPILOT_ENTRA_ISSUER`, `COPILOT_ENTRA_JWKS_URL` | tenant defaults | Optional reviewed overrides; loopback HTTP is test-only |

Hard request limits remain 1,000 characters per question, 16 KiB per body, 20 queries/minute/user, and 200 queries/minute per server process. The provider timeout cannot be raised above 30 seconds. These throttles are in-memory and therefore apply per server process, not as a distributed cluster-wide quota.

## Provider and production decisions

The implemented adapter speaks the Azure OpenAI chat-completions request shape. Azure AI Foundry is **not** implemented as a separate provider. A Foundry deployment may use this adapter only after Trigon verifies the exact endpoint, authentication, deployment, and API-version compatibility; no unsupported Foundry options are assumed.

Before any production use, Trigon must approve the provider/service and deployment, Azure region and data residency, whether questions and projected ERP results may leave the ERP host, provider retention/training/abuse-monitoring/logging terms, outbound network rules, allowlisted users/roles, and provider-failure handling. The implementation and local mocks do not make those decisions or contact production services. Keep both `COPILOT_ENABLED` and `COPILOT_ENTRA_ENABLED` off until approval and deployment review.

## Deliberate first-release exclusions

No mutation/action tools, general HR approvals, supplier contact fields, raw document/attachment access, external SharePoint links, free-text feedback, model-based tool selection, distributed rate limiting, or distinct Azure AI Foundry adapter are included. Those require a separate security/product decision and must not be inferred as supported by this API. Copilot is supported only in the Node server deployment; the standalone browser edition has no server-side provider or Entra authentication path.

---

# مساعد Trigon ERP

ميزة Copilot اختيارية ومخصّصة للقراءة فقط، ومعطّلة افتراضياً. لا تغيّر المحاسبة أو الرواتب أو ضريبة القيمة المضافة أو الفواتير أو الاعتمادات أو تدفّقات Microsoft 365. لا تفعّلها على بيانات الإنتاج ولا تربطها بخدمة ذكاء اصطناعي إنتاجية قبل اعتماد القرارات أدناه.

## ما تم تنفيذه

- واجهة عربية وإنجليزية لا تظهر إلا لمستخدم ERP مسجّل ومصرّح له من الخادم.
- يحدد الخادم النية والأداة بقواعد ثابتة؛ لا يختار النموذج الأدوات ولا ينفّذ SQL ولا يستدعي ERP.
- أدوات قراءة فقط: حالة المشاريع، ملخصاتها المالية، الفواتير، حالة المشتريات (أوامر الشراء وطلبات الأسعار)، ملخصات عقود الباطن، بيانات مستندات المشاريع، قائمة اعتمادات الصرف، وحالة إخفاقات مزامنة SharePoint.
- لكل أداة إسقاط حقول صريح. قائمة الحقول الحساسة المركزية طبقة إضافية وليست بديلاً عن الإسقاطات. لا تُرسل محتويات الملفات أو المرفقات أو أسماءها أو روابط SharePoint أو بيانات اتصال الموردين أو بيانات الموظفين والموارد البشرية أو الرواتب أو الإقرارات الضريبية أو دفتر الأستاذ إلى النموذج.
- تُفحص صلاحيات ERP الحالية لكل أداة. تقتصر أدوار الموقع على مشاريعها المعيّنة حيث تسمح صلاحية ERP بالأداة. تفاصيل إخفاقات SharePoint للمسؤول فقط وبحقول تشغيلية محدودة، ولا تُرسل أخطاء المزوّد الخام.
- الروابط داخل ERP مراجع فقط؛ وتظل واجهة ERP المقصودة تفرض صلاحيات الدور والسجل/المشروع بشكل مستقل.
- يقتصر دور المزوّد على صياغة النتائج المنظمة المصرح بها. يُعامل السؤال والنتائج كمدخلات غير موثوقة، ولا يوجد تخزين مؤقت مشترك بين المستخدمين.

## الواجهة وواجهة API

يصف `public/copilot-openapi.yaml` واجهة OpenAPI 3.1 المتاحة لـ Copilot Studio والعملاء الآخرين. تظهر واجهة **مساعد Trigon** للمستخدمين المصرّح لهم. تتطلب جميع المسارات `COPILOT_ENABLED=1` وهوية ERP نشطة وإدراج معرّف المستخدم الرقمي في `COPILOT_ALLOWED_USERS` **أو** دوره في `COPILOT_ALLOWED_ROLES`. القائمتان الفارغتان تمنعان الجميع، ولا تتجاوز قائمة Copilot صلاحيات أداة ERP.

| المسار | السلوك |
|---|---|
| `GET /api/copilot/status` | النوايا والحدود ومؤشر إعداد المزوّد بلا أسرار |
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
| `COPILOT_TIMEOUT_MS` | 30000 | عدد صحيح من 1000 إلى 30000 |
| `COPILOT_HISTORY_RETENTION_DAYS` | 30 | عدد صحيح من 1 إلى 3650 |
| `COPILOT_PROVIDER` | `azure-openai` | هذا المحوّل فقط منفّذ |
| `COPILOT_AZURE_ENDPOINT` | غير مضبوط | نقطة Azure OpenAI من نوع `*.openai.azure.com` عبر HTTPS؛ HTTP محلي للاختبارات فقط |
| `COPILOT_AZURE_DEPLOYMENT` | غير مضبوط | اسم النشر |
| `COPILOT_AZURE_API_VERSION` | غير مضبوط | إصدار بتاريخ محدد |
| `COPILOT_AZURE_API_KEY` | غير مضبوط | سر لا يُعرض ولا يُسجّل |
| `COPILOT_ENTRA_ENABLED` | `0` | مسار الرمز الاختياري، معطّل افتراضياً |
| `COPILOT_ENTRA_TENANT_ID` | غير مضبوط | معرّف المستأجر المعتمد |
| `COPILOT_ENTRA_API_AUDIENCE` | غير مضبوط | جمهور API مخصّص، غير جمهور تطبيق تسجيل الدخول |

حدود الطلب: 1000 حرف للسؤال، 16 كيلوبايت للجسم، 20 طلباً لكل مستخدم في الدقيقة و200 طلب لكل عملية خادم في الدقيقة. لا يمكن رفع مهلة المزوّد عن 30 ثانية. الحدود المخزنة في الذاكرة لكل عملية خادم وليست موزعة على مجموعة خوادم.

## المزوّد وقرارات الإنتاج

يتوافق المحوّل المنفذ مع شكل طلبات Azure OpenAI Chat Completions. لم يُنفّذ Azure AI Foundry كمزوّد مستقل. لا يستخدم نشر Foundry هذا المحوّل إلا بعد تحقق Trigon من توافق نقطة النهاية والمصادقة والنشر وإصدار API المختار؛ ولا نفترض خيارات غير مدعومة.

قبل الإنتاج، على Trigon اعتماد الخدمة والنشر، ومنطقة Azure ومكان إقامة البيانات، والسماح بإرسال الأسئلة والنتائج المصرّح بها خارج خادم ERP، وسياسات الاحتفاظ والتدريب ومراقبة إساءة الاستخدام والسجلات لدى المزوّد، وسياسة الاتصالات الصادرة، وقوائم المستخدمين والأدوار، والتعامل عند تعذّر المزوّد. لم يتصل التنفيذ والاختبارات المحلية بخدمة إنتاجية ولم يتخذا هذه القرارات. اترك `COPILOT_ENABLED` و`COPILOT_ENTRA_ENABLED` دون تفعيل حتى الاعتماد والمراجعة.

## استثناءات الإصدار الأول

لا توجد أدوات تعديل أو تنفيذ إجراءات، ولا قائمة اعتمادات الموارد البشرية العامة أو بيانات اتصال الموردين أو وصول خام للمرفقات أو روابط SharePoint الخارجية أو تقييم حر أو اختيار أدوات بالنموذج أو تحديد معدل موزع أو محوّل مستقل لـ Azure AI Foundry. تحتاج هذه الأمور إلى قرار منتج ومراجعة أمنية منفصلة ولا ينبغي اعتبارها مدعومة. يعمل Copilot في نشر خادم Node فقط؛ ولا تحتوي النسخة المستقلة في المتصفح على مسار مزوّد من جهة الخادم أو مصادقة Entra.
