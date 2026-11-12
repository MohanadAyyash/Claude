# المراقبة والصيانة — Operations & monitoring

هذه الطبقة الأولى من الصيانة المستمرة: تراقب النظام 24/7 بدون أي ذكاء اصطناعي وبدون تكلفة، وتجهّز تقارير يقرأها لاحقاً وكيل الصيانة.

## ١) فحص الصحة — `/api/health`
- يرد على `GET /api/health` بدون تسجيل دخول: `{"ok":true,"db":"ok","uptime_s":…,"time":…}` بكود 200، أو كود **503** إذا قاعدة البيانات لا ترد.
- لا يكشف أي بيانات (لا أسماء ولا أرقام ولا إعدادات).
- **اربطه بخدمة مراقبة مجانية** (UptimeRobot أو Better Stack أو Cloudflare Health Checks):
  - الرابط: `https://erp.trigon.ae/api/health`
  - كل دقيقة إلى ٥ دقائق، وتنبيه بالإيميل أو الواتساب أو SMS إذا الرد ليس 200.
- في Docker (`deploy/docker-compose.yml`) أُضيف `healthcheck`، فيظهر `healthy/unhealthy` في `docker ps`.

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

Windows (جهاز المكتب) — Task Scheduler، أو من PowerShell كمسؤول:

```powershell
schtasks /Create /SC DAILY /ST 03:00 /TN "TrigonDailyCheck" /TR "cmd /c cd /d C:\erp && node --no-warnings scripts\daily-check.js >> data\daily-check.log 2>&1"
```

## ٤) CI — اختبارات على كل تعديل
`.github/workflows/ci.yml` يشغّل `npm test` وبناء النسخة المستقلة على كل Pull Request وكل push.
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
2. **ركّب تطبيق Claude على المستودع:** https://github.com/apps/claude ثم Install، واختر المستودع `Claude`.
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
     GITHUB_REPORT_REPO=MohanadAyyash/Claude
     ```
     وبعدها `docker compose up -d` عشان يقرأها.
6. **جرّب:** افتح issue عنوانه `@claude شغّل npm test وقلّي النتيجة`. لازم يرد خلال دقايق. وجرّب المراجعة الأسبوعية من Actions ← Claude weekly review ← Run workflow.

### التكلفة
- تشغيلة إصلاح وحدة تكلّف تقريباً من سنتات إلى دولار أو دولارين، حسب حجم المشكلة.
- مع المراجعة الأسبوعية والأعطال القليلة، المتوقع بضعة دولارات بالشهر.
- الحد الشهري في Anthropic Console هو صمام الأمان.
