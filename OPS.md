# المراقبة والصيانة — Operations & monitoring

هذه الطبقة الأولى من الصيانة المستمرة: تراقب النظام 24/7 بدون أي ذكاء اصطناعي وبدون تكلفة، وتجهّز تقارير يقرأها لاحقاً وكيل الصيانة.

## ١) فحص الصحة — `/api/health`
- يرد على `GET /api/health` بدون تسجيل دخول: `{"ok":true,"db":"ok","uptime_s":…,"time":…}` بكود 200، أو كود **503** إذا قاعدة البيانات لا ترد.
- لا يكشف أي بيانات (لا أسماء ولا أرقام ولا إعدادات).
- **اربطه بخدمة مراقبة مجانية** (UptimeRobot أو Better Stack أو Cloudflare Health Checks):
  - الرابط: `https://erp.trigon.ae/api/health`
  - كل دقيقة إلى ٥ دقائق، وتنبيه بالإيميل أو الواتساب أو SMS إذا الرد ليس 200.
- في Docker (`deploy/docker-compose.yml`) أُضيف `healthcheck`، فيظهر `healthy/unhealthy` في `docker ps`.
- على جهاز Windows، مهمة `TrigonERP-Monitor` تفحص العنوان المحلي كل ٥ دقائق. عند انقطاع الخدمة تفتح/تحدّث بلاغ GitHub إذا كان `GITHUB_REPORT_TOKEN` مضبوطاً، وترسل تنبيهاً إلى Teams إذا كان webhook مضبوطاً؛ وعند عودة الخدمة تسجل الاستعادة في GitHub وترسل تنبيهاً إلى Teams. لا تقرأ قاعدة البيانات، ولا تكرر التنبيهات ما دامت الحالة لم تتغير، ولا تغلق البلاغ تلقائياً.
- إعداد Teams يستخدم `M365_TEAMS_WEBHOOK_URL` الموجود أصلاً في `.env`. يُرسل التنبيه حالة الخدمة والوقت فقط، بلا بيانات ERP. تفاصيل إعداد Teams في `M365.md`.
- هذه المراقبة تعمل على نفس جهاز المكتب؛ لن تستطيع التنبيه إذا كان الجهاز مطفأً أو انقطع عنه الإنترنت. لمراقبة الجهاز من خارجه، يلزم health check خارجي عبر اتصال HTTPS آمن ومحدود، من دون نشر قاعدة البيانات أو لوحة الإدارة.

## ٢) سجل الأخطاء
- كل خطأ غير متوقع (كود 500) يُحفظ في جدول `error_log`: الوقت، نوع الطلب، المسار (بدون query string)، الرسالة، والـ stack.
- لا تُحفظ محتويات الطلبات (لا رواتب ولا أسماء ولا كلمات مرور). آخر ٥٠٠٠ خطأ فقط.
- للمدير: `GET /api/ops/errors`.

## ٣) فحوصات سلامة البيانات اليومية
للمدير: `GET /api/ops/checks`، أو من سطر الأوامر:

```bash
node scripts/daily-check.js
```

داخل Docker:

```bash
docker compose exec -T app node scripts/daily-check.js
```

| الفحص | النتيجة عند المشكلة |
|---|---|
| سلامة ملف قاعدة البيانات (SQLite quick_check) | FAIL |
| ميزان المراجعة: مجموع المدين = مجموع الدائن | FAIL |
| القيود اليدوية متوازنة | FAIL |
| أرقام الفواتير والإشعارات الدائنة: لا تكرار | FAIL |
| أرقام الفواتير: لا فجوات في التسلسل | WARN |
| بنود الفواتير مقروءة | FAIL |
| الدفعات مرتبطة بفواتير/فواتير موردين موجودة | FAIL |
| الرواتب: الصافي = الإجمالي − الخصومات، ولا قيم سالبة | WARN |
| أخطاء الخادم آخر ٢٤ ساعة | WARN |

- يكتب التقرير في `DATA_DIR/ops/check-YYYY-MM-DD.json` (يحتفظ بآخر ٩٠ يوماً).
- **يخرج بكود 1 إذا فشل أي فحص**، وصفر إذا كله سليم أو تحذيرات فقط، فيقدر cron أو وكيل الصيانة يتصرف بناءً عليه.
- التقرير فيه أرقام مستندات ومعرّفات سجلات فقط، **بدون أسماء أو رواتب أو IBAN أو أرقام هويات**، فيصلح لإرساله لوكيل الذكاء الاصطناعي.
- يقرأ فقط ولا يعدّل شيئاً، وآمن أثناء عمل الخادم.

### الجدولة
Linux (VPS): `deploy/install.sh` يضيف تلقائياً النسخة الاحتياطية الساعة ٢:٣٠ والفحص الساعة ٣:٠٠. لو ركّبت قبل هذا التحديث، شغّل `install.sh` مرة ثانية أو أضف السطر يدوياً بـ `crontab -e`:

```bash
0 3 * * * cd /opt/erp/deploy && docker compose exec -T app node scripts/daily-check.js >> /var/log/erp-check.log 2>&1
```

Windows (جهاز المكتب): `deploy\windows\setup-office-server.ps1` يضيف **TrigonERP-Monitor** كل ٥ دقائق، و**TrigonERP-Check** الساعة ٣:٠٠ (مع النسخة الاحتياطية ٢:٣٠). أعد تشغيل السكربت على الجهاز لتثبيت مهمة المراقبة الجديدة.

```powershell
schtasks /Create /SC DAILY /ST 03:00 /TN "TrigonERP-Check" /RU SYSTEM /F /TR "cmd /c cd /d C:\erp && node --no-warnings scripts\daily-check.js >> data\daily-check.log 2>&1"
```

## ٤) CI — اختبارات على كل تعديل
`.github/workflows/tests.yml` يشغّل `npm test` وبناء النسخة المستقلة على كل Pull Request (الفحص اسمه **tests**).
اجعله **إلزامياً** قبل الدمج: Settings ← Branches ← Add branch protection rule ← فعّل "Require status checks to pass" واختر **tests**.
هذا هو صمام الأمان قبل أن يفتح وكيل الذكاء الاصطناعي أي PR.

## ٥) وكيل الصيانة (Claude Code)

### كيف يشتغل
```
السيرفر (كل يوم ٣:٠٠)                    GitHub
daily-check.js ── فشل؟ ──► issue بعلامة ops-report ──► الوكيل يصحى
                                                         يقرأ CLAUDE.md
                                                         يدوّر على السبب في الكود
                                                         يصلحه + يضيف اختبار
                                                         يرفع فرع + تعليق فيه رابط "Create PR"
                                     أنت ──► تراجع وتفتح PR ──► CI أخضر ──► تدمج
```

| متى يصحى الوكيل | الملف |
|---|---|
| issue بعلامة `ops-report` (من السيرفر تلقائياً أو تضيفها أنت) | `.github/workflows/claude.yml` |
| تكتب `@claude …` في issue أو تعليق أو مراجعة PR | `.github/workflows/claude.yml` |
| مراجعة أسبوعية: الأحد ٥:١٧ الصبح (بتوقيت الإمارات) | `.github/workflows/claude-weekly.yml` |

- **المراجعة الأسبوعية** تشغّل الاختبارات وتراجع تعديلات الأسبوع. إذا لقت مشاكل حقيقية تفتح **issue واحد** فيه قائمة، وما تعدّل أي كود. إذا عجبك شي من القائمة، اكتب تحتها مثلاً `@claude أصلح ١ و ٣`.
- **ما يصحى كل يوم بدون سبب.** إذا المشكلة مستمرة والـ issue لسا مفتوح، السيرفر يضيف تعليق بس (التعليق ما يشغّل الوكيل)، فالمشكلة الواحدة تكلّف تشغيلة وحدة.
- قواعد الوكيل في `CLAUDE.md`: ما يلمس البيانات، كل إصلاح معه اختبار، ما يدمج، وتعديلات الضريبة والرواتب والحسابات تحتاج موافقتك.
- **الوكيل يشوف الكود بس، ما يشوف قاعدة البيانات.** وإذا كانت المشكلة في البيانات، يكتب لك في الـ issue وش تتأكد منه في النظام.
- **الخصوصية:** الـ issue فيها أسماء الفحوصات وأعداد وأرقام مستندات ومسارات أخطاء بس. رسائل الأخطاء تنحذف منها أي نصوص بين علامات تنصيص وأي أرقام طويلة (IBAN، هوية، هاتف) وأي إيميلات. ومع هذا، **يُفضّل تحويل المستودع لخاص.**

### الإعداد (مرة وحدة)
1. **ادمج هذا الفرع في الفرع الأساسي** (`claude/construction-management-app-rfq8al`). GitHub يشغّل workflows الـ issues والجدولة من الفرع الأساسي بس.
2. **ركّب تطبيق Claude على المستودع:** https://github.com/apps/claude ثم Install، واختر المستودع `Trigon-ERP-System`.
3. **أضف مفتاح واحد** في Settings ← Secrets and variables ← Actions ← New repository secret:
   - `ANTHROPIC_API_KEY`: مفتاح من https://console.anthropic.com (الدفع حسب الاستخدام). حط له حد شهري من Billing ← Limits.
   - **أو** `CLAUDE_CODE_OAUTH_TOKEN`: إذا عندك اشتراك Claude Pro/Max، شغّل `claude setup-token` على جهازك والصق الناتج.
4. **أنشئ العلامة** `ops-report` من Issues ← Labels ← New label.
5. **وصّل السيرفر بـ GitHub:**
   - أنشئ Fine-grained token من https://github.com/settings/personal-access-tokens/new
   - Repository access: هذا المستودع بس.
   - Permissions: **Issues: Read and write** بس، ولا شي غيرها.
   - انتهاء الصلاحية: سنة، وحط تذكير تجدده.
   - حط في ملف `.env` على السيرفر (بجانب `docker-compose.yml` في `deploy/`، أو بجانب `server.js` على ويندوز):
     ```
     GITHUB_REPORT_TOKEN=github_pat_...
     GITHUB_REPORT_REPO=MohanadAyyash/Trigon-ERP-System
     ```
     وبعدها `docker compose up -d` عشان يقرأها.
6. **جرّب:** افتح issue عنوانه `@claude شغّل npm test وقلّي النتيجة`. لازم يرد خلال دقايق. وجرّب المراجعة الأسبوعية من Actions ← Claude weekly review ← Run workflow.

### التكلفة
- تشغيلة إصلاح وحدة تكلّف تقريباً من سنتات إلى دولار أو دولارين، حسب حجم المشكلة.
- مع المراجعة الأسبوعية والأعطال القليلة، المتوقع بضعة دولارات بالشهر.
- الحد الشهري في Anthropic Console هو صمام الأمان.

## Microsoft 365 (التشغيل / operations)
- كل الإعدادات في `.env` وتفاصيلها في `M365.md`: الدخول (hybrid / microsoft-first + مسؤول الطوارئ)، SharePoint، Outlook، Teams.
- بعد أي تعديل على `.env`: أعد التشغيل بطريقة «Restart that really applies .env» في `M365.md` (PID جديد + `/api/status`).
- الحالة: الإعدادات ← حساب Microsoft 365 / تكامل Microsoft 365 (آخر نجاح / آخر خطأ لكل ميزة، بدون أسرار).
- نقل المرفقات القديمة إلى SharePoint: `node --no-warnings scripts/m365-migrate.js` (تجربة فقط) ثم `--execute` بعد المراجعة؛ لا يحذف شيئاً.
- سجل التدقيق: `m365` (`sharepoint-upload`, `outlook-send`, `config-change`, `teams-*`) و `auth` (`auth-mode`, `emergency-login…`).
- إيقاف أي ميزة: صفرها في `.env` وأعد التشغيل؛ بيانات النظام لا تتأثر.

## Copilot (معطّل افتراضياً)
- لا تضبط `COPILOT_ENABLED=1` ولا تتصل بمزوّد إنتاجي حتى تعتمد Trigon مزوّد Azure والمنطقة ومكان إقامة البيانات ومعالجة/احتفاظ/تدريب المزوّد وسياسة الشبكة وقوائم المستخدمين والأدوار؛ التفاصيل في `COPILOT.md` و`docs/COPILOT.md`.
- اختبارات Copilot تستخدم مزوّداً ومفاتيح Entra وهمية على loopback فقط. لا تستخدم قاعدة إنتاج أو بيانات نسخ احتياطية أو أسرار إنتاج للاختبار.
- حالة `GET /api/copilot/status` متاحة للمسؤول الموثق حتى عند التعطيل، وتعرض `enabled=false` دون أسرار؛ بعد اعتماد التفعيل، راجعها كمستخدم مسموح. واجهة التدقيق `GET /api/copilot/audit` للمسؤول فقط ولا تحتوي السؤال أو الإجابة.
- حد الطلب الافتراضي 20 لكل مستخدم و200 لكل عملية خادم في الدقيقة؛ يمكن ضبط الحدود والنتائج والاحتفاظ ضمن النطاقات الموثقة في `docs/COPILOT.md` و`.env.example`.
- السجل والتقييم وأحداث Copilot لا تُنسخ إلى النسخ المنقّحة. مسح سجل المستخدم لا يؤثر على سجل مستخدم آخر، ولا توجد أدوات تعديل أو موافقة.
- فتح رابط داخل Copilot لا يمنح صلاحية؛ واجهة ERP المقصودة تعيد فحص الصلاحيات ونطاق المشروع مستقلاً.
- المحدّث ينشر رأس الفرع الافتراضي؛ لذلك فإن دمج PR #21 يعدّ عملياً نشراً للإنتاج للتثبيتات التي تستخدم المحدّث. يجب أن يبقى `COPILOT_ENABLED=0` بعد أي تحديث أو دمج حتى اكتمال تحقق مرحلي منفصل واعتماد قائمة المستخدمين/الأدوار. لا يغيّر هذا PR مسار التحديث ولا يثبت أو يسجل commit النشر. للتراجع: `COPILOT_ENABLED=0` ثم إعادة تشغيل التطبيق بالطريقة المعتمدة.

The updater deploys the configured default-branch head, so merging PR #21 is effectively a production deployment for updater-managed installs. Keep `COPILOT_ENABLED=0` after every update and merge until provider/region/data-handling decisions, staged validation, and explicit allowlist approval are complete. See `COPILOT.md` and `docs/COPILOT.md` for the staged process. Rollback is `COPILOT_ENABLED=0` followed by the approved application restart; this feature does not alter ERP or Microsoft 365 data.

## Isolated Windows Copilot validation (fake data only)

Use a new checkout and a new data directory. Never copy an installed ERP folder, production database, backup, `.env`, account, or secret into this test. The test binds only to loopback on port `3301`; the Copilot mock is test-only and does not make provider calls.

In PowerShell, confirm the two exact test paths do not already exist. If either exists, inspect it and choose a new dedicated test path rather than deleting or reusing unknown data.

```powershell
if (Test-Path -LiteralPath 'C:\ERP-copilot-test') { throw 'Test checkout already exists; choose and inspect a new isolated path.' }
if (Test-Path -LiteralPath 'C:\ERP-copilot-test-data') { throw 'Test data path already exists; choose and inspect a new isolated path.' }
git clone --single-branch --branch feature/trigon-copilot-foundation https://github.com/MohanadAyyash/Trigon-ERP-System.git C:\ERP-copilot-test
Set-Location -LiteralPath 'C:\ERP-copilot-test'
node --version
npm ci
New-Item -ItemType Directory -Path 'C:\ERP-copilot-test-data' | Out-Null
node --no-warnings test-copilot.js
npm test
npm run build:standalone
npm run test:standalone
npm audit --omit=dev
```

If this Windows machine has no supported Chrome installation, run `$env:SKIP_PDF='1'; npm test`, then run `Remove-Item Env:SKIP_PDF`; record that the PDF test was skipped locally. The real-browser PDF check must pass in non-Windows CI.

Create `C:\ERP-copilot-test\.env` with these bootstrap settings; Copilot is initially off while creating a new fake local ERP:

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

Node does not load `.env` implicitly here. Start the server explicitly:

```powershell
Set-Location -LiteralPath 'C:\ERP-copilot-test'
node --env-file=.env --no-warnings server.js
```

Open `http://127.0.0.1:3301/`, create a disposable fake administrator through first-run setup, then add clearly fictitious records only (for example a `QA-DEMO-001` project, sample client, invoice, PO and contract) and a separate unallowlisted viewer. Do not use real names, company records, tenant IDs, or copied production data. Stop the server with Ctrl+C before inspecting the test database or editing `.env`. Read the fake ERP IDs from the local database read-only:

```powershell
node --no-warnings -e 'const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync("C:\\ERP-copilot-test-data\\erp.db",{readOnly:true});console.log(db.prepare("SELECT id,username,role FROM users ORDER BY id").all());db.close();'
```

Edit `.env`: set `COPILOT_ENABLED=1`, and replace the placeholder with the numeric ID of exactly one fake test user. Leave all other settings unchanged:

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

`COPILOT_PROVIDER=mock` requires `NODE_ENV=test`; the mock returns a fixed answer and does not call Azure. Entra, M365, SharePoint, Outlook, Teams and Zoho credentials/endpoints are disabled or empty. Start the server with `node --env-file=.env --no-warnings server.js`. Confirm there is no non-loopback server connection:

```powershell
$server = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*C:\ERP-copilot-test\server.js*' }
if (-not $server) { throw 'Isolated test server process was not found.' }
Get-NetTCPConnection -State Established -OwningProcess $server.ProcessId |
  Where-Object { $_.RemoteAddress -notin @('127.0.0.1','::1') } |
  Select-Object LocalAddress,LocalPort,RemoteAddress,RemotePort
```

No rows should be returned. Keep the browser at `127.0.0.1`; do not configure real tenant/provider values.

Manual UI checklist:

1. Sign in as the allowlisted fake user; switch between Arabic and English and confirm the Copilot panel/menu is present in both.
2. Confirm all five suggested prompts appear and can be selected: **Purchase orders waiting for approval**, **Overdue purchase orders**, **Project procurement summary**, **Contracts expiring within 60 days**, and **SharePoint synchronization failures**.
3. Ask a supported question with no matching fake records. Confirm **“No structured results for this question.”** appears instead of invented records.
4. Sign in as the separate fake viewer whose ID is not allowlisted. Confirm the panel is absent and direct `/api/copilot/ask` access is denied.
5. Ask **“Show payroll”**; confirm the excluded-data request is rejected.
6. Open an ERP reference as the authorized fake user, then open the same local ERP path as the restricted user; confirm the destination's normal ERP ACL denies access.
7. Use **Clear history** and confirm the current user's history is empty; verify the restricted account's history is unaffected.
8. Stop the server, set `COPILOT_ENABLED=0`, restart, and confirm the Copilot panel is hidden while ordinary ERP pages still work.

After Ctrl+C and confirming the server has exited, delete only these exact test paths, after checking that no files need to be kept:

```powershell
Set-Location -LiteralPath 'C:\'
Remove-Item -LiteralPath 'C:\ERP-copilot-test' -Recurse -Force
Remove-Item -LiteralPath 'C:\ERP-copilot-test-data' -Recurse -Force
```

## Staged production rollout and rollback

This is a future approval-gated procedure, not authorization to merge or deploy. Merging PR #21 to `claude/construction-management-app-rfq8al` is effectively a deployment because the updater downloads the configured default-branch ZIP. The same push triggers `.github/workflows/pages.yml`, which tests, rebuilds and republishes the standalone edition to GitHub Pages; that edition is not a Copilot provider/backend and must not be used to send ERP data to an AI service.

1. Complete security review and obtain Trigon's written approval for the Azure service/deployment, region/data residency, provider retention/training/abuse-monitoring/logging terms, network policy, allowlist and rollout owner. Keep `COPILOT_ENABLED=0` and `COPILOT_ENTRA_ENABLED=0`.
2. Pass the isolated fake-data checks above and CI. Confirm restore/backup and the approved maintenance window before an update.
3. Only after approval, merge PR #21 through the normal reviewed PR process. Expect the GitHub Pages edition to rebuild and republish automatically.
4. During the approved window, run `Trigon-Update.bat` from the installed ERP application folder. It downloads the default-branch ZIP, stages and verifies it, replaces program files, preserves `.env` and data, keeps recent application backups, then starts and health-checks the ERP. Review its final success/rollback message.
5. Immediately verify the installed `.env` still has `COPILOT_ENABLED=0` and `COPILOT_ENTRA_ENABLED=0`; check `/api/copilot/status` reports disabled and verify ordinary ERP login/core workflows.
6. First test the mock provider in an isolated non-production copy with `NODE_ENV=test`, fake records, and one fake ERP user ID. Never run the test-only mock in production; complete the manual UI checklist above.
7. After Trigon approves region and data-handling choices, configure the selected Azure provider in non-production with synthetic records and one approved test ERP user ID. Verify configuration, safe status/audit, authorization and rollback before any production AI connection.
8. For a separately approved production pilot, configure the approved Azure provider and secret through the authorized secret mechanism; set `COPILOT_ALLOWED_ROLES=` and `COPILOT_ALLOWED_USERS=` to exactly one approved ERP user ID; keep `COPILOT_ENTRA_ENABLED=0`; then set `COPILOT_ENABLED=1` and restart using the approved procedure. Monitor safe status/audit only; expand access only with separate approval.
9. **Rollback:** set `COPILOT_ENABLED=0`, keep `COPILOT_ENTRA_ENABLED=0`, disable/remove provider credentials in the approved secret store if required, restart using the approved procedure, and verify the panel is hidden, status is disabled, and ERP workflows still work. For a code regression after a successful update, use a separately reviewed revert and approved update procedure; updater rollback is automatic only when its update transaction fails.
