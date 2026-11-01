const { add, go, vp, click, clickText, row, F, T, S, L, tx, sideL, sideR } = require('./run');
const { shot } = require('./lib');
// ---------- projects ----------
add('16-projects', async (p, lang) => {
  await vp(p, 700); await go(p, 'projects');
  await shot(p, '16-projects', lang, [S('#add', 1, L('إضافة مشروع', 'Add a project'), { side: 'b' }), S('tr.click', 2, L('اضغط على المشروع لفتح صفحته', 'Click a project to open its page'), { side: 'b' }), S('a.btn[href*="export"]', 3, L('تصدير Excel', 'Export to Excel'), { side: 'b', dist: 90 })]);
});
add('17-project-new', async (p, lang) => {
  await vp(p, 1250); await go(p, 'projects'); await click(p, '#add');
  await p.fill('.modal [name=code]', 'P-2026-03'); await p.fill('.modal [name=name]', 'Villa G+2 — Al Barsha'); await p.selectOption('.modal [name=client_id]', { index: 1 }); await p.fill('.modal [name=contract_value]', '2400000'); await p.fill('.modal [name=retention_pct]', '10');
  await shot(p, '17-project-new', lang, [F('name', 1, L('الرمز والاسم (الاسم إلزامي)', 'Code and name (name required)'), { side: sideL(lang) }), F('client_id', 2, L('العميل', 'Client'), { side: sideR(lang) }), F('emirate', 3, L('الإمارة: لإقرار الضريبة', 'Emirate: for the VAT return'), { side: sideR(lang) }),
    F('contract_value', 4, L('قيمة العقد ونسبة المحتجزات', 'Contract value and retention %'), { side: sideR(lang) }), F('advance_pct', 5, L('الدفعة المقدمة واستردادها', 'Advance payment and its recovery'), { side: sideR(lang) }), F('handover_date', 6, L('التسليم وفترة الصيانة (إفراج المحتجزات)', 'Handover & defects period (retention release)'), { side: sideR(lang) }),
    F('site_lat', 7, L('موقع المشروع لحضور الجوال', 'Site location for phone attendance'), { side: sideR(lang) }), S('.modal #save', 8, L('حفظ', 'Save'), { side: 't' })]);
});
add('18-project-page', async (p, lang) => {
  await vp(p, 900); await go(p, 'projects/1');
  await shot(p, '18-project-page', lang, [S('#main .grid', 1, L('أرقام المشروع: العقد، المفوتر، المحصّل، التكلفة، الربح', 'Project figures: contract, invoiced, collected, cost, profit'), { side: 'b' }), S('button[onclick^="editProject"]', 2, L('تعديل بيانات المشروع', 'Edit project details'), { side: 'b', dist: 120 }),
    S('button[onclick^="progressInvoice"]', 3, L('فاتورة إنجاز من جدول الكميات', 'Progress invoice from the BOQ'), { side: 'b', dist: 60 }), S('button[onclick^="newBillFor"]', 4, L('تسجيل مصروف على المشروع', 'Record an expense on the project'), { side: 'b', dist: 180 })]);
});
add('19-project-boq', async (p, lang) => {
  await vp(p, 900); await go(p, 'projects/1'); await p.evaluate(() => { document.querySelector('button[onclick^="boqModal"]').scrollIntoView({ block: 'start' }); scrollBy(0, -60); });
  await shot(p, '19-project-boq', lang, [S('button[onclick^="boqModal"]', 1, L('إضافة بند للجدول', 'Add a BOQ item'), { side: sideR(lang) }), S('tr.click[onclick^="boqModal"]', 2, L('اضغط على البند لتحديث نسبة الإنجاز', 'Click an item to update its completion %'), { side: 'b', nth: 2 }),
    S('#main tfoot', 3, L('القيمة، التكلفة المقدّرة، والإنجاز الكلي', 'Total value, budget cost and overall progress'), { side: 'b', dist: 70 }), S('button[onclick^="varModal"]', 4, L('أمر تغيير جديد', 'New variation order'), { side: sideR(lang) })]);
});
add('20-boq-item', async (p, lang) => {
  await vp(p, 760); await go(p, 'projects/1'); await p.locator('tr.click[onclick^="boqModal"]').nth(3).click(); await p.waitForTimeout(600);
  await shot(p, '20-boq-item', lang, [F('description', 1, L('وصف البند', 'Item description'), { side: 't' }), F('qty', 2, L('الكمية وسعر البيع', 'Quantity and sell rate'), { side: sideR(lang) }), F('cost_rate', 3, L('التكلفة المقدّرة (للميزانية)', 'Budget cost (for the budget)'), { side: sideL(lang) }), F('done_pct', 4, L('نسبة الإنجاز: تُحدَّث مع تقدم العمل', 'Completion %: update it as work progresses'), { side: sideR(lang) }), S('.modal #save', 5, L('حفظ', 'Save'), { side: 'b' })]);
});
add('21-variation', async (p, lang) => {
  await vp(p, 700); await go(p, 'projects/1'); await click(p, 'button[onclick^="varModal"]');
  await p.fill('.modal [name=number]', 'VO-03'); await p.fill('.modal [name=description]', 'Additional car-park shade'); await p.fill('.modal [name=amount]', '42000');
  await shot(p, '21-variation', lang, [F('number', 1, L('رقم أمر التغيير', 'Variation number'), { side: 't' }), F('amount', 2, L('المبلغ بدون ضريبة (سالب للتخفيض)', 'Amount ex VAT (negative = omission)'), { side: sideR(lang) }), F('status', 3, L('المعتمد فقط يُضاف لقيمة العقد', 'Only Approved is added to the contract'), { side: sideL(lang) }), S('.modal #save', 4, L('حفظ', 'Save'), { side: 'b' })]);
});
add('22-budget', async (p, lang) => {
  await vp(p, 900); await go(p, 'projects/1'); await p.evaluate(() => { document.querySelector('#bsave').closest('.card').scrollIntoView({ block: 'start' }); });
  await shot(p, '22-budget', lang, [S('#bsave', 1, L('حفظ الميزانية', 'Save the budget'), { side: 't' }), S('[data-bud]', 2, L('أدخل الميزانية لكل بند تكلفة', 'Enter the budget per cost category'), { side: sideL(lang) }), S('#bsave', 3, L('التكلفة المتوقعة والهامش المتوقع', 'Forecast cost and forecast margin'), { closest: '.card', rect: [0, 0, undefined, 120], side: 'b', dist: 400 })]);
});
add('23-weekly-advance', async (p, lang) => {
  await vp(p, 900); await go(p, 'projects/1'); await p.evaluate(() => { const b = document.querySelector('#advinv') || [...document.querySelectorAll('h2')].find(h => /المقدمة|Advance/.test(h.textContent)); b.closest('.card').scrollIntoView({ block: 'start' }); scrollBy(0, -10); });
  await shot(p, '23-advance-retention', lang, [T(tx(lang, 'الدفعة المقدمة والمحتجزات', 'Advance payment & retention'), 1, L('المقدمة: المفوتر، المسترد، المتبقي', 'Advance: invoiced, recovered, remaining'), { tags: 'h2', closest: '.card', side: 'b', rect: [0, 0, undefined, 60] }), T(tx(lang, 'الإيراد لكل عامل في اليوم', 'Revenue per worker-day'), 2, L('إنتاجية العمال مقابل الهدف', 'Worker productivity against target'), { tags: 'h2,h3', side: 'b' }), S('#mdt', 3, L('تعديل الهدف', 'Edit target'), { side: 'b' })]);
});
add('24-project-notes', async (p, lang) => {
  await vp(p, 900); await go(p, 'projects/1'); await p.evaluate(() => { const h = [...document.querySelectorAll('h2')].find(h => /التقارير الأسبوعية|Weekly updates/.test(h.textContent)); h.scrollIntoView({ block: 'start' }); scrollBy(0, -20); });
  await shot(p, '24-weekly-notes', lang, [S('#uadd', 1, L('تقرير أسبوعي جديد', 'New weekly update')), T(tx(lang, 'الملاحظات والمتابعة', 'Notes & follow-up'), 2, L('اكتب ملاحظة واذكر زميلك بـ @', 'Write a note, mention a colleague with @'), { tags: 'h2', side: 'b' }), T(tx(lang, 'المستندات المرفقة', 'Attached documents'), 3, L('ارفع العقد والمخططات والتصاريح', 'Upload contract, drawings, permits'), { tags: 'h2', side: 'b' })]);
});
// ---------- invoices ----------
add('25-invoices', async (p, lang) => {
  await vp(p, 700); await go(p, 'invoices');
  await shot(p, '25-invoices', lang, [S('#add', 1, L('فاتورة يدوية جديدة', 'New manual invoice'), { side: 'b' }), S('#main thead th:nth-child(6)', 2, L('الرصيد المتبقي (مع المحتجزات)', 'Balance due (incl. retention)'), { side: 'b' }), S('#main thead th:nth-child(7)', 3, L('الحالة: مدفوع / جزئي / متأخر', 'Status: paid / partial / overdue'), { side: 'b', dist: 110 })]);
});
add('26-invoice-progress', async (p, lang) => {
  await vp(p, 1000); await go(p, 'invoices'); await row(p, 'EHF Warehouse');
  await shot(p, '26-invoice', lang, [F('project_id', 1, L('المشروع', 'Project'), { side: 't' }), F('retention_pct', 2, L('نسبة المحتجزات', 'Retention %'), { side: 't' }), S('#tot', 3, L('الإجمالي، الضريبة، المحتجزات', 'Total, VAT, retention'), { side: sideR(lang) }), S('.modal #ipc', 4, L('شهادة الدفع (المستخلص)', 'Interim payment certificate'), { side: 'b' }), S('.modal #pay', 5, L('تسجيل دفعة من العميل', 'Record a client payment'), { side: 'b', dist: 110 }), S('.modal #cn', 6, L('إشعار دائن', 'Credit note'), { side: 't' }), S('.modal #void', 7, L('إلغاء (للمدير فقط، مع السبب)', 'Void (admin only, with reason)'), { side: 't', dist: 100 })]);
});
add('27-payment', async (p, lang) => {
  await vp(p, 800); await go(p, 'invoices'); await row(p, 'EHF Warehouse'); await click(p, '.modal #pay'); await p.selectOption('.modal [name=method]', 'cheque'); await p.waitForTimeout(200);
  await shot(p, '27-payment', lang, [S('.modal [name=kind]', 1, L('مقبوضات من عميل / دفعة لمورد', 'Receipt from client / payment to supplier'), { closest: '.f', side: 't' }), S('.modal [name=ref]', 2, L('الفاتورة المرتبطة', 'The linked invoice'), { closest: '.f', side: 't' }), F('amount', 3, L('المبلغ', 'Amount'), { side: sideR(lang) }), S('.modal [name=method]', 4, L('طريقة الدفع', 'Method'), { closest: '.f', side: sideL(lang) }),
    S('.modal [name=cheque_status]', 5, L('للشيك: التاريخ والحالة', 'Cheque: date and status'), { closest: '.f', side: sideL(lang) }), S('.modal [name=is_retention]', 6, L('علّم إذا كانت دفعة محتجزات', 'Tick for a retention release'), { closest: '.f', side: 'b' }), S('.modal #save', 7, L('حفظ', 'Save'), { side: 'b' })]);
});
add('28-ageing', async (p, lang) => {
  await vp(p, 760); await go(p, 'aging');
  await shot(p, '28-ageing', lang, [S('#asof', 1, L('حتى تاريخ', 'As of date'), { side: 'b', sel2: '#main input[type=date]' }), S('#main thead', 2, L('الأرصدة حسب أيام التأخير', 'Balances by days overdue'), { side: 'b' }), S('tr.click', 3, L('اضغط على العميل لكشف الحساب', 'Click a customer for the statement'), { side: 'b', dist: 110 })]);
});
add('29-statement', async (p, lang) => {
  await vp(p, 860); await go(p, 'aging'); await p.locator('tr.click').first().click(); await p.waitForLoadState('networkidle'); await p.waitForTimeout(700);
  await shot(p, '29-statement', lang, [S('.modal input[type=date]', 1, L('اختر الفترة', 'Choose the period'), { side: 'b', sel2: '#main input[type=date]' }), T(tx(lang, 'طباعة', 'Print'), 2, L('طباعة الكشف', 'Print the statement'), { tags: 'button,a', side: 'b' }), T(tx(lang, 'البريد', 'Email'), 3, L('إرساله للعميل مع PDF', 'Email it with a PDF'), { tags: 'button,a', side: 'b', dist: 100 })]);
});
add('30-sitediary', async (p, lang) => {
  await vp(p, 800); await go(p, 'sitediary'); await click(p, '#add');
  await shot(p, '30-sitediary', lang, [F('project_id', 1, L('المشروع والتاريخ', 'Project and date'), { side: 't' }), F('labour_count', 2, L('الطقس وعدد العمال', 'Weather and manpower'), { side: sideR(lang) }), F('work_done', 3, L('الأعمال المنجزة اليوم', 'Work done today'), { side: sideL(lang) }), F('issues', 4, L('العوائق والتأخير', 'Issues / delays'), { side: sideL(lang) }), S('.modal #save', 5, L('حفظ', 'Save'), { side: 'b' })]);
});
// ---------- procurement ----------
add('31-rfq', async (p, lang) => {
  await vp(p, 900); await go(p, 'rfq'); await row(p, 'Porcelain');
  await shot(p, '31-rfq', lang, [S('#mx tbody tr', 1, L('البنود والكميات المطلوبة', 'Items and quantities required'), { side: 't', closest: 'tbody' }), S('#mx thead select', 2, L('عمود لكل مورد: اكتب أسعاره', 'One column per supplier: type their rates'), { side: 't' }), T(tx(lang, 'مورد', 'Supplier'), 3, L('إضافة مورد للمقارنة', 'Add a supplier to compare'), { in: '.modal', tags: 'button', side: 'b' }),
    T(tx(lang, 'ترسية + أمر شراء', 'Award + PO'), 4, L('الأقل سعراً مُبرز — ترسية تنشئ أمر الشراء', 'Lowest is highlighted — Award creates the PO'), { in: '.modal', tags: 'button', side: 'b' })]);
});
add('32-po', async (p, lang) => {
  await vp(p, 900); await go(p, 'po'); await p.locator('tr.click').first().click(); await p.waitForTimeout(600);
  await shot(p, '32-po', lang, [S('.modal [name=party_id]', 1, L('المورد والمشروع', 'Supplier and project'), { closest: '.f', side: 't' }), S('.modal .items', 2, L('البنود والأسعار', 'Items and rates'), { side: sideL(lang), sel2: '.modal table' }), S('.modal #print', 3, L('طباعة', 'Print'), { side: 'b' }), S('.modal #mail', 4, L('إرسال للمورد', 'Email supplier'), { side: 'b', dist: 100 }), S('.modal #rcv', 5, L('عند الاستلام: إنشاء فاتورة المورد', 'On delivery: create the supplier bill'), { side: 'b', dist: 50 })]);
});
add('33-bill', async (p, lang) => {
  await vp(p, 960); await go(p, 'bills'); await click(p, '#add');
  await p.selectOption('.modal [name=party_id]', { index: 3 }); await p.selectOption('.modal [name=category]', 'equipment'); await p.fill('.modal [name=description]', 'Crane hire — October'); await p.fill('.modal [name=amount]', '24000'); await p.fill('.modal [name=vat_amount]', '1200');
  await p.check('#spl'); const sp = p.locator('[data-split]'); await sp.nth(0).locator('select').selectOption({ index: 0 }); await sp.nth(0).locator('input').fill('60'); await sp.nth(1).locator('select').selectOption({ index: 1 }); await sp.nth(1).locator('input').fill('40'); await sp.nth(1).locator('input').press('Tab');
  await shot(p, '33-bill', lang, [F('party_id', 1, L('المورد', 'Supplier'), { side: 't' }), F('category', 2, L('البند (مواد، معدات، أصل ثابت…)', 'Category (materials, equipment, fixed asset…)'), { side: sideL(lang) }), F('amount', 3, L('المبلغ بدون ضريبة + الضريبة', 'Amount ex VAT + VAT'), { side: sideR(lang) }), F('reference', 4, L('رقم فاتورة المورد', 'Supplier invoice no.'), { side: sideL(lang) }),
    S('#spl', 5, L('توزيع على عدة مشاريع', 'Split across several projects'), { closest: 'label', side: sideL(lang) }), S('#splitbox', 6, L('نسبة لكل مشروع (المجموع 100%)', '% per project (must total 100%)'), { side: sideR(lang) }), S('.modal #save', 7, L('حفظ', 'Save'), { side: 'b' })]);
});
add('34-subcontract', async (p, lang) => {
  await vp(p, 860); await go(p, 'subcontracts'); await p.locator('tr.click').first().click(); await p.waitForTimeout(700);
  await shot(p, '34-subcontract', lang, [T(tx(lang, 'شهادة دفع', 'New certificate'), 1, L('شهادة دفع جديدة', 'New payment certificate'), { tags: 'button', side: 'b' }), S('.modal table', 2, L('الشهادات: التراكمي، هذه الفترة، المحتجزات، المستحق', 'Certificates: cumulative, this period, retention, payable'), { side: 'b' })]);
});
add('35-subcert', async (p, lang) => {
  await vp(p, 860); await go(p, 'subcontracts'); await p.locator('tr.click').first().click(); await p.waitForTimeout(600);
  await p.locator('.modal tbody tr').first().click().catch(() => {}); await p.waitForTimeout(600);
  await shot(p, '35-subcert', lang, [S('.modal [name=cumulative]', 1, L('الأعمال المنجزة حتى تاريخه (تراكمي)', 'Work done to date (cumulative)'), { closest: '.f', side: 't' }), S('.modal [name=advance_recovery]', 2, L('استرداد الدفعة المقدمة', 'Advance recovery'), { closest: '.f' }), S('.modal [name=deductions]', 3, L('الخصومات والتحميلات', 'Deductions / back-charges'), { closest: '.f' }), S('#ap', 4, L('الاعتماد يقفل الشهادة ويسجل التكلفة', 'Approval locks it and books the cost'))]);
});
add('36-stock', async (p, lang) => {
  await vp(p, 800); await go(p, 'stock');
  await shot(p, '36-stock', lang, [S('#add', 1, L('صنف جديد', 'New item'), { side: 'b' }), S('#mv', 2, L('حركة مخزون: استلام / صرف / تسوية', 'Stock movement: receive / issue / adjust'), { side: 'b', dist: 100, sel2: '#main .bar button.btn.sec' }), S('#main table', 3, L('الكمية، متوسط التكلفة، القيمة، تنبيه النقص', 'Qty, average cost, value, low-stock flag'), { side: 'b', rect: [0, 0, undefined, 200] })]);
});
add('37-assets-petty', async (p, lang) => {
  await vp(p, 700); await go(p, 'petty');
  await shot(p, '37-petty', lang, [T(tx(lang, 'تغذية العهدة', 'Top up'), 1, L('تغذية العهدة', 'Top up the float'), { tags: 'button', side: 'b' }), T(tx(lang, 'مصروف نقدي', 'Cash expense'), 2, L('مصروف نقدي على مشروع', 'Cash expense on a project'), { tags: 'button', side: 'b', dist: 100 }), T(tx(lang, 'رصيد العهدة', 'Petty cash balance'), 3, L('الرصيد المتبقي', 'Remaining balance'), { closest: '.kpi', side: 'b' })]);
  await go(p, 'assets');
  await shot(p, '38-assets', lang, [S('#add', 1, L('إضافة أصل', 'Add an asset'), { side: 'b' }), S('#main thead th:last-child', 2, L('الإهلاك المجمع والقيمة الدفترية', 'Accumulated depreciation & book value'), { side: 'b' })]);
});
try { require('./run3'); } catch (e) { if (!/Cannot find module '.\/run3'/.test(e.message)) throw e; }
