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

## الخطوات القادمة (غير منفّذة بعد)
- workflow لـ `claude-code-action` يعمل على الـ issues والتعليقات (يحتاج `ANTHROPIC_API_KEY` في GitHub Secrets).
- مهمة مجدولة يومية لوكيل الصيانة تقرأ تقرير الفحص وسجل الأخطاء وتفتح PR بالإصلاح.
