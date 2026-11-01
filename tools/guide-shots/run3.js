const { add, go, vp, click, row, F, T, S, L, tx, sideL, sideR } = require('./run');
const { shot, BASE } = require('./lib');
const btn = (lang, ar, en, n, label, x = {}) => T(tx(lang, ar, en), n, label, { tags: 'button,a', ...x });
const clickBtn = async (p, lang, ar, en, scope = '#main') => { await p.locator(`${scope} button, ${scope} a.btn`).filter({ hasText: tx(lang, ar, en) }).first().click(); await p.waitForLoadState('networkidle'); await p.waitForTimeout(500); };
// ---------- HR ----------
add('40-employees', async (p, lang) => {
  await vp(p, 700); await go(p, 'employees');
  await shot(p, '40-employees', lang, [S('#add', 1, L('إضافة موظف', 'Add an employee')), S('tr.click', 2, L('اضغط على الموظف لفتح ملفه', 'Click an employee to open the record')), S('#main thead th:nth-child(6)', 3, L('مكافأة نهاية الخدمة التقديرية', 'Estimated end-of-service gratuity')), S('#main thead th:nth-child(7)', 4, L('تنبيه إذا كان الآيبان ناقصاً', 'Flag when the IBAN is missing'))]);
});
add('41-employee-new', async (p, lang) => {
  await vp(p, 1500); await go(p, 'employees'); await click(p, '#add');
  await p.fill('.modal [name=name]', 'Ravi Shankar Pillai'); await p.fill('.modal [name=designation]', 'Carpenter'); await p.fill('.modal [name=basic]', '1600'); await p.fill('.modal [name=housing]', '500');
  await shot(p, '41-employee-new', lang, [F('name', 1, L('الاسم كما في الجواز (إلزامي)', 'Name as in passport (required)')), F('person_code', 2, L('رقم بطاقة العمل 14 رقم (لـ WPS)', 'Labour card / person code, 14 digits (WPS)')), F('join_date', 3, L('تاريخ الالتحاق: أساس الإجازات ونهاية الخدمة', 'Join date: basis for leave & gratuity')),
    F('project_id', 4, L('تحميل الراتب على مشروع أو عمومي', 'Charge the salary to a project or overheads')), F('basic', 5, L('الأساسي والبدلات', 'Basic wage and allowances')), F('routing_code', 6, L('البنك، رمز التوجيه، الآيبان (لـ WPS)', 'Bank, routing code, IBAN (WPS)')), F('eid_expiry', 7, L('تواريخ الانتهاء: تصل تنبيهات قبلها', 'Expiry dates: you get alerts before them')),
    F('manager_user_id', 8, L('المدير المباشر: يعتمد الإجازات أولاً', 'Line manager: approves leave first')), F('probation_end', 9, L('نهاية التجربة (حتى 6 أشهر)', 'End of probation (max 6 months)')), S('.modal #save', 10, L('حفظ', 'Save'))]);
});
add('42-employee-extras', async (p, lang) => {
  await vp(p, 1000); await go(p, 'employees'); await row(p, 'Suresh'); await p.waitForTimeout(800);
  await p.evaluate(() => { const h = [...document.querySelectorAll('.modal h2')].find(h => /المستندات المرفقة|Attached documents/.test(h.textContent)); h.scrollIntoView({ block: 'start' }); document.querySelector('.overlay').scrollTop -= 10; });
  await shot(p, '42-employee-extras', lang, [T(tx(lang, 'المستندات المرفقة', 'Attached documents'), 1, L('ارفع الجواز والإقامة والعقد مع تاريخ الانتهاء', 'Upload passport, visa, contract with expiry'), { in: '.modal', tags: 'h2', closest: '.card' }), T(tx(lang, 'حساب بوابة الموظف', 'Employee portal account'), 2, L('حساب الموظف للبوابة من الجوال', 'Portal account for the employee’s phone'), { in: '.modal', tags: 'h2', closest: '.card' }),
    T(tx(lang, 'الانضمام والمغادرة', 'Onboarding & offboarding'), 3, L('إجراءات الانضمام والمغادرة', 'Onboarding & offboarding steps'), { in: '.modal', tags: 'h2', closest: '.card' })], { crop: 'full' });
});
add('43-onboarding', async (p, lang, ctx) => {
  await ctx.request.post(BASE + '/api/hr/onboarding/6').catch(() => {});
  await vp(p, 1000); await go(p, 'employees'); await row(p, 'Layla'); await p.waitForTimeout(900);
  await p.evaluate(() => { const h = [...document.querySelectorAll('.modal h2')].find(h => /الانضمام والمغادرة|Onboarding & offboarding/.test(h.textContent)); h.scrollIntoView({ block: 'start' }); document.querySelector('.overlay').scrollTop -= 10; });
  await p.locator('.modal [data-ck]').nth(0).check().catch(() => {}); await p.waitForTimeout(400); await p.locator('.modal [data-ck]').nth(1).check().catch(() => {}); await p.waitForTimeout(500);
  await shot(p, '43-onboarding', lang, [S('.modal [data-ck]', 1, L('علّم كل بند عند إنجازه', 'Tick each step when done'), { closest: 'label' }), T(tx(lang, 'المغادرة والتسوية النهائية', 'Leaving & final settlement'), 2, L('المغادرة والتسوية النهائية', 'Leaving & final settlement'), { in: '.modal', tags: 'h3,h2,b,summary' })], { crop: 'full' });
});
add('44-attendance', async (p, lang) => {
  await vp(p, 760); await go(p, 'attendance');
  await shot(p, '44-attendance', lang, [S('#d', 1, L('اختر التاريخ', 'Choose the date')), S('#crew', 2, L('تسجيل حضور الفريق (عمال بدون هاتف)', 'Clock in my crew (workers without phones)')), S('#main tbody tr select', 3, L('حالة اليوم لكل موظف', 'Day status per employee')), S('#main tbody tr input[type=number]', 4, L('ساعات إضافية +25% / +50%', 'Overtime +25% / +50%')), S('#main tbody tr select[data-f=project_id]', 5, L('المشروع (توزيع التكلفة)', 'Project (cost allocation)'))]);
});
add('45-crew', async (p, lang) => {
  await vp(p, 760); await go(p, 'attendance'); await click(p, '#crew'); await p.locator('.modal input[type=checkbox]').nth(0).check().catch(() => {}); await p.locator('.modal input[type=checkbox]').nth(1).check().catch(() => {});
  await shot(p, '45-crew', lang, [S('.modal select', 1, L('دخول أو خروج', 'In or Out')), S('.modal input[type=checkbox]', 2, L('علّم أسماء العمال', 'Tick the workers’ names'), { closest: 'label' }), S('.modal #save', 3, L('تسجيل (الوقت والموقع من جوالك)', 'Record (time & location from your phone)'), { sel2: '.modal .acts .btn' })]);
});
add('46-leave', async (p, lang) => {
  await vp(p, 860); await go(p, 'leave');
  await shot(p, '46-leave', lang, [S('#add', 1, L('تسجيل إجازة لموظف', 'Record leave for an employee'), { sel2: '#main .bar .btn' }), btn(lang, 'قرار', 'Decide', 2, L('موافقة أو رفض', 'Approve or reject')), T(tx(lang, 'أرصدة الإجازات', 'Leave balances'), 3, L('رصيد كل موظف: المستحق، المستخدم، المتبقي', 'Each balance: accrued, used, remaining'), { tags: 'h2' })]);
});
add('47-leave-new', async (p, lang) => {
  await vp(p, 700); await go(p, 'leave'); await click(p, '#main .bar .btn:not(.sec):not(#prt)');
  await shot(p, '47-leave-new', lang, [F('employee_id', 1, L('الموظف', 'Employee')), F('type', 2, L('نوع الإجازة', 'Leave type')), F('start_date', 3, L('من تاريخ / إلى تاريخ', 'From / to')), F('reason', 4, L('السبب', 'Reason')), S('.modal #save', 5, L('حفظ', 'Save'))]);
});
add('48-requests', async (p, lang) => {
  await vp(p, 860); await go(p, 'hrrequests');
  await shot(p, '48-requests', lang, [S('#main .bar .btn:not(#prt)', 1, L('طلب نيابةً عن موظف', 'Request on behalf of an employee')), btn(lang, 'إصدار الخطاب', 'Issue letter', 2, L('طلب خطاب: إصداره مباشرة', 'Letter request: issue it directly')), btn(lang, 'قرار', 'Decide', 3, L('باقي الطلبات: قرار', 'Other requests: decide')), S('#ladd', 4, L('سلفة جديدة: تُخصم أقساطها من الراتب', 'New advance: instalments deducted from salary'))], { crop: 'full' });
});
add('49-approvals', async (p, lang) => {
  await vp(p, 700); await go(p, 'approvals');
  await shot(p, '49-approvals', lang, [btn(lang, 'موافقة', 'Approve', 1, L('موافقة: ينتقل للمستوى التالي', 'Approve: moves to the next level')), btn(lang, 'رفض', 'Reject', 2, L('رفض مع السبب', 'Reject with a reason'))]);
});
add('50-letters', async (p, lang) => {
  await vp(p, 700); await go(p, 'letters'); await click(p, '#main .bar .btn:not(#prt)');
  await shot(p, '50-letter-new', lang, [F('employee_id', 1, L('الموظف', 'Employee')), F('type', 2, L('نوع الخطاب', 'Letter type')), F('addressed_to', 3, L('الجهة الموجّه إليها', 'Addressed to')), F('purpose', 4, L('الغرض', 'Purpose')), S('.modal #save', 5, L('إصدار وطباعة برقم مرجعي', 'Issue & print with a reference number'))]);
});
add('51-payroll', async (p, lang) => {
  await vp(p, 900); await go(p, 'dashboard'); await p.evaluate(() => sessionStorage.removeItem('pm')); await go(p, 'payroll'); if (await p.$('#gen') && !(await p.$('#main tbody input'))) { await click(p, '#gen'); }
  await shot(p, '51-payroll', lang, [S('#m', 1, L('اختر الشهر', 'Choose the month')), S('#gen', 2, L('إنشاء كشف الشهر', 'Generate the month')), S('#main tbody input[data-k=ot_normal_hours]', 3, L('عدّل الأيام والإضافي والمكافآت والخصومات', 'Adjust days, overtime, bonus, deductions')), S('#fin', 4, L('اعتماد الكشف (يُقفل)', 'Finalize payroll (locks it)'))], { crop: 'full' });
});
add('52-payroll-final', async (p, lang) => {
  await vp(p, 760); await go(p, 'dashboard'); let lm; for (let k = 1; k <= 3; k++) { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - k); const m = d.toISOString().slice(0, 7); const r = await (await p.request.get(BASE + '/api/payroll?month=' + m)).json(); if (r.length && r.every(x => x.paid_date)) { lm = m; break; } }
  await p.evaluate(m => sessionStorage.pm = m, lm); await go(p, 'payroll'); await p.reload(); await p.waitForLoadState('networkidle'); await p.waitForTimeout(600);
  await shot(p, '52-payroll-final', lang, [S('a[href*="payroll/sif"]', 1, L('تحميل ملف SIF ورفعه في بوابة البنك', 'Download the SIF file and upload it to the bank')), S('.tag.paid', 2, L('بعد التحويل: «تم تحويل الرواتب»', 'After the transfer: "Mark salaries paid"'), { sel2: '#paid' }), S('a.btn[href*="export"]', 3, L('تصدير Excel', 'Export to Excel'))]);
  await p.evaluate(() => sessionStorage.removeItem('pm'));
});
add('53-offboarding', async (p, lang) => {
  await vp(p, 1100); await go(p, 'employees'); await row(p, 'Abdul Karim'); await p.waitForTimeout(800);
  await p.evaluate(() => { const h = [...document.querySelectorAll('.modal h2,.modal h3')].find(h => /المغادرة والتسوية|Leaving & final/.test(h.textContent)); (h || document.querySelector('.modal .acts')).scrollIntoView({ block: 'start' }); document.querySelector('.overlay').scrollTop -= 10; });
  await shot(p, '53-offboarding', lang, [T(tx(lang, 'المغادرة والتسوية النهائية', 'Leaving & final settlement'), 1, L('أدخل آخر يوم والسبب وتاريخ الإشعار', 'Enter last day, reason, notice date'), { in: '.modal', tags: 'h3,h2' }), btn(lang, 'بدء المغادرة وحساب التسوية', 'Start offboarding & calculate', 2, L('يحسب الراتب والإجازات ونهاية الخدمة', 'Calculates salary, leave and gratuity'), { in: '.modal' })], { crop: 'full' });
});
add('54-hrdash', async (p, lang) => {
  await vp(p, 900); await go(p, 'hrdash');
  await shot(p, '54-hrdash', lang, [S('#main .grid', 1, L('الموظفون، الطلبات المعلّقة، في إجازة اليوم', 'Staff, pending requests, on leave today')), T(tx(lang, 'مستندات تنتهي خلال', 'Documents expiring within'), 2, L('مستندات قاربت على الانتهاء', 'Documents about to expire'), { tags: 'h2', closest: '.card' }), T(tx(lang, 'الالتزام بقانون العمل', 'Labour-law compliance'), 3, L('مخالفات قانون العمل لهذا الشهر', 'Labour-law issues this month'), { tags: 'h2' })]);
});
add('55-hr-rules', async (p, lang) => {
  await vp(p, 1000); await go(p, 'hrdash'); await p.evaluate(() => { const h = [...document.querySelectorAll('h2')].find(h => /مستويات الاعتماد|Approval chains/.test(h.textContent)); h.scrollIntoView({ block: 'start' }); scrollBy(0, -10); });
  await shot(p, '55-hr-rules', lang, [T(tx(lang, 'مستويات الاعتماد', 'Approval chains'), 1, L('من يعتمد الإجازات والطلبات وبأي حد', 'Who approves leave and requests, from which limit'), { tags: 'h2', closest: '.card' }), S('#fsave', 2, L('حفظ المستويات', 'Save the chains')), T(tx(lang, 'قواعد الحضور', 'Attendance rules'), 3, L('ساعات العمل، الراحة، رمضان، حظر الظهيرة', 'Hours, rest day, Ramadan, midday ban'), { tags: 'h2', closest: '.card' })], { crop: 'full' });
});
// ---------- employee portal on a phone ----------
add('56-portal', async (p, lang, ctx, b) => {
  const c2 = await b.newContext({ viewport: { width: 400, height: 790 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true }); await c2.addInitScript(l => { localStorage.lang = l; }, lang);
  await c2.request.post(BASE + '/api/login', { data: { username: 'suresh', password: 'Trigon2026' } });
  const q = await c2.newPage(); await q.goto(BASE + '/#portal'); await q.waitForLoadState('networkidle'); await q.waitForTimeout(900);
  await shot(q, '56-portal', lang, [S('#clk', 1, L('تسجيل الحضور / الانصراف', 'Clock in / clock out')), S('#rl', 2, L('طلب إجازة', 'Request leave')), S('#rq', 3, L('طلب آخر: شهادة، سلفة…', 'Other request: certificate, advance…')), T(tx(lang, 'رصيد الإجازة السنوية (أيام)', 'Annual leave balance (days)'), 4, L('رصيد الإجازات', 'Leave balance'), { closest: '.kpi' })], { crop: 'full' });
  await c2.close();
});
// ---------- accounting ----------
add('60-coa', async (p, lang) => { await vp(p, 700); await go(p, 'coa'); await shot(p, '60-coa', lang, [S('#add', 1, L('حساب جديد', 'New account')), S('tr.click', 2, L('اضغط لتعديل حساب', 'Click to edit an account'))]); });
add('61-journal', async (p, lang) => {
  await vp(p, 760); await go(p, 'journal'); await click(p, '#add');
  await shot(p, '61-journal', lang, [S('.modal [name=date]', 1, L('التاريخ والبيان', 'Date and memo'), { closest: '.f2' }), S('#jl', 2, L('الأسطر: الحساب، مدين، دائن', 'Lines: account, debit, credit')), T(tx(lang, 'سطر', 'Line'), 3, L('إضافة سطر', 'Add a line'), { in: '.modal', tags: 'button' }), S('.modal #save', 4, L('حفظ (يجب أن يتوازن)', 'Save (must balance)'))]);
});
add('62-financials', async (p, lang) => { await vp(p, 860); await go(p, 'financials'); await shot(p, '62-financials', lang, [S('#df', 1, L('الفترة من / إلى', 'Period from / to'), { up: 1 }), S('#go', 2, L('عرض', 'Show'), { sel2: '#dgo' }), S('#main .grid', 3, L('الإيرادات، المصروفات، صافي الربح', 'Revenue, expenses, net profit'))]); });
add('63-bank', async (p, lang) => {
  await vp(p, 860); await go(p, 'bank');
  await shot(p, '63-bank', lang, [S('#baccs', 1, L('الحسابات البنكية', 'Bank accounts')), S('#imp', 2, L('استيراد كشف البنك (CSV)', 'Import the bank statement (CSV)')), S('#am', 3, L('مطابقة تلقائية', 'Auto-match')), S('#main .grid', 4, L('الفرق يجب أن يكون صفراً', 'The difference should be zero'))]);
});
add('64-zoho', async (p, lang) => { await vp(p, 900); await go(p, 'zoho'); await shot(p, '64-zoho', lang, [T(tx(lang, 'تجربة بدون إرسال (Dry run)', 'Dry run (nothing sent)'), 1, L('معاينة بدون إرسال', 'Preview, nothing sent'), { tags: 'button' }), T(tx(lang, 'تقرير المعاملات اليومي', 'Daily transactions report'), 2, L('تقرير يومي بما فُوتر وقُبض', 'Daily report of what was invoiced/received'), { tags: 'h2' })]); });
// ---------- tax ----------
add('65-vat', async (p, lang) => { await vp(p, 860); await go(p, 'vat'); await p.locator('#main button').filter({ hasText: tx(lang, 'عرض', 'Show') }).first().click(); await p.waitForLoadState('networkidle'); await p.waitForTimeout(600); await shot(p, '65-vat', lang, [S('#main input[type=date]', 1, L('الفترة الضريبية', 'Tax period'), { up: 1 }), S('#main .grid', 2, L('المبيعات، ضريبة المخرجات والمدخلات، الصافي', 'Sales, output & input VAT, net')), T(tx(lang, 'حسب الإمارة', 'by emirate'), 3, L('الخانة 1 حسب الإمارة', 'Box 1 by emirate'), { tags: 'h2' })]); });
add('66-compliance', async (p, lang) => { await vp(p, 860); await go(p, 'compliance'); await shot(p, '66-compliance', lang, [T(tx(lang, 'تنبيهات', 'Alerts'), 1, L('كل التنبيهات: رخصة، إقامات، رواتب، شيكات', 'All alerts: licence, visas, salaries, cheques'), { tags: 'h2', closest: '.card' }), T(tx(lang, 'المواعيد الأساسية', 'Key deadlines'), 2, L('المواعيد الضريبية والرواتب', 'Tax and salary deadlines'), { tags: 'h2', closest: '.card' }), T(tx(lang, 'جاهزية الفوترة الإلكترونية', 'E-invoicing readiness'), 3, L('جاهزية الفوترة الإلكترونية: بيانات ناقصة في الفواتير', 'E-invoicing readiness: missing invoice data'), { tags: 'h2', closest: '.card' })]); });
add('67-documents', async (p, lang) => { await vp(p, 760); await go(p, 'documents'); await shot(p, '67-documents', lang, [T(tx(lang, 'مستندات الشركة (الرخصة، عقد التأسيس، التأمينات…)', 'Company documents (licence, MOA, insurance…)'), 1, L('ارفع مستندات الشركة مع تاريخ الانتهاء', 'Upload company documents with expiry'), { tags: 'h2', closest: '.card' }), T(tx(lang, 'كل المرفقات', 'All attachments'), 2, L('كل المرفقات في النظام', 'Every attachment in the system'), { tags: 'h2' })]); });
// ---------- tasks & notifications ----------
add('68-tasks', async (p, lang) => {
  await vp(p, 760); await go(p, 'tasks'); await click(p, '#tadd');
  await shot(p, '68-task-new', lang, [F('title', 1, L('عنوان المهمة', 'Task title')), F('assignee_user_id', 2, L('المسؤول (يصله تنبيه)', 'Assignee (gets notified)')), F('due_date', 3, L('تاريخ الاستحقاق', 'Due date')), F('project_id', 4, L('المشروع', 'Project')), S('.modal #save', 5, L('حفظ', 'Save'))]);
});
add('69-notifications', async (p, lang) => { await vp(p, 760); await go(p, 'notifications'); await shot(p, '69-notifications', lang, [T(tx(lang, 'تفعيل الإشعارات على هذا الجهاز', 'Turn on notifications on this device'), 1, L('تفعيل الإشعارات على الجوال', 'Turn on phone notifications'), { tags: 'button' })]); });
add('70-mobile', async (p, lang, ctx, b) => {
  const c2 = await b.newContext({ viewport: { width: 400, height: 800 }, isMobile: true, hasTouch: true }); await c2.addInitScript(l => { localStorage.lang = l; }, lang);
  await c2.request.post(BASE + '/api/login', { data: { username: 'admin', password: 'Trigon2026' } });
  const q = await c2.newPage(); await q.goto(BASE + '/#dashboard'); await q.waitForLoadState('networkidle'); await q.waitForTimeout(800);
  await shot(q, '70-mobile', lang, [S('#menu', 1, L('افتح القائمة من ☰', 'Open the menu with ☰'))], { crop: 'full' });
  await q.click('#menu'); await q.waitForTimeout(500);
  await shot(q, '71-mobile-menu', lang, [S('.side a.on', 1, L('اختر الصفحة', 'Pick a page'))], { crop: 'full' });
  await c2.close();
});
