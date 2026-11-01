// New screens: main-contractor work (proforma → PC → tax invoice), purchase order, subcontractor PC and agreement, document settings,
// plus pictures of the printed documents.
const { add, go, vp, click, row, F, T, S, L, tx } = require('./run');
const { shot, BASE } = require('./lib');
const path = require('path'), fs = require('fs'), { execFileSync } = require('child_process');
const OUT = path.join(__dirname, '..', '..', 'public', 'guide', 'img');
const wait = ms => new Promise(r => setTimeout(r, ms));

add('72-project-contract', async (p, lang) => {
  await vp(p, 1300); await go(p, 'projects/4'); await click(p, 'button[onclick^="editProject"]');
  await p.evaluate(() => { document.querySelector('.modal [name=main_contract]').scrollIntoView({ block: 'start' }); document.querySelector('.overlay').scrollTop -= 10; });
  await shot(p, '72-project-contract', lang, [F('main_contract', 1, L('العقد الرئيسي (عند العمل كمقاول باطن)', 'Main contract (when working as a subcontractor)')), F('client_contract_ref', 2, L('رقم العقد / أمر الشراء من العميل — يُطبع على الفواتير', 'Contract / PO no. from the client — printed on invoices')),
    F('payment_terms_days', 3, L('مدة الدفع بالأيام — تاريخ الاستحقاق', 'Payment terms in days — due date')), F('vat_basis', 4, L('أساس الضريبة في الـ PC', 'VAT basis on PCs'))], { crop: 'full' });
});
add('73-claims-card', async (p, lang) => {
  await vp(p, 900); await go(p, 'projects/4'); await p.evaluate(() => { document.querySelector('#claims').scrollIntoView({ block: 'start' }); scrollBy(0, -10); });
  await shot(p, '73-claims-card', lang, [S('#cnew', 1, L('بروفورما جديدة من جدول الكميات', 'New proforma from the BOQ')), S('#cpc', 2, L('تسجيل PC مستلم', 'Record a PC received')),
    S('#claims thead th:nth-child(3)', 3, L('صافي المطلوب في البروفورما', 'Net claimed in the proforma')), S('#claims thead th:nth-child(6)', 4, L('صافي المعتمد والفرق', 'Net certified and the difference')), S('#claims thead th:last-child', 5, L('الفاتورة الضريبية', 'The tax invoice'))], { crop: '#claims' });
});
add('74-proforma', async (p, lang) => {
  await vp(p, 1150); await go(p, 'projects/4'); await p.waitForSelector('#claims [data-app]'); await p.locator('#claims [data-app]').last().click(); await p.waitForSelector('.modal [data-cq]'); await wait(400);
  await shot(p, '74-proforma', lang, [F('period_to', 1, L('للأعمال حتى تاريخ', 'For works up to')), F('materials', 2, L('المواد بالموقع (تراكمي)', 'Materials on site (cumulative)')),
    S('.modal [data-cq]', 3, L('الكمية التراكمية لكل بند', 'Cumulative quantity per item'), { closest: 'td' }), S('.modal table.claimsum', 4, L('الملخص: A − B = الصافي', 'Summary: A − B = net')),
    S('#aprint', 5, L('طباعة البروفورما', 'Print the proforma')), S('#asub', 6, L('تعليم كمُقدَّم', 'Mark as submitted'), { sel2: '#apc' }), S('#apc', 7, L('تسجيل الـ PC المستلم', 'Record the PC received'))]);
});
add('75-pc-new', async (p, lang) => {
  await vp(p, 1900); await go(p, 'projects/4'); await p.waitForSelector('#claims [data-app]'); await p.locator('#claims [data-app]').last().click(); await p.waitForSelector('#apc'); await wait(300);
  await click(p, '#apc'); await p.waitForSelector('.modal [name=work_cum]'); await p.fill('.modal [name=number]', '7'); await p.fill('.modal [name=issue_date]', '2026-03-05');
  const first = p.locator('.modal [data-ck]').first(); await first.fill(String(+(await first.inputValue()) - 100)); await p.click('#usel');
  const w = +(await p.inputValue('.modal [name=work_cum]')); await p.fill('.modal [name=retention_cum]', String(Math.round(w * 10) / 100)); await p.fill('.modal [name=contra_cum]', '27400'); await wait(300);
  await shot(p, '75-pc', lang, [F('number', 1, L('رقم الـ PC وتاريخه', 'PC no. and date')), F('app_id', 2, L('البروفورما المرتبطة', 'The linked proforma')), F('work_cum', 3, L('الأرقام التراكمية كما في الـ PC', 'Cumulative figures as on the PC')),
    F('prev_payments', 4, L('الدفعات السابقة (تلقائياً)', 'Previous payments (automatic)')), S('.modal [data-ck]', 5, L('الكمية المعتمدة لكل بند', 'Certified quantity per item'), { closest: 'td' }), S('#usel', 6, L('استخدم مجموع البنود', 'Use the item total')),
    S('#pcsum', 7, L('الصافي والضريبة كما ستُفوتر', 'Net and VAT as they will be invoiced')), S('#psave', 8, L('حفظ ثم «إصدار الفاتورة الضريبية»', 'Save, then “Issue the tax invoice”'))]);
});
add('76-pc-invoice', async (p, lang) => {
  await vp(p, 1000); await go(p, 'invoices'); await row(p, 'Kerbstone');
  await shot(p, '76-pc-invoice', lang, [F('client_ref', 1, L('مرجع العميل: رقم الـ PC', 'Client reference: the PC no.')), S('.modal #items', 2, L('بنود من الـ PC: الأعمال، الخصومات', 'Lines from the PC: work, contra charges')),
    S('#tot', 3, L('الضريبة على الصافي بعد المحتجزات — المستحق = الـ PC', 'VAT on the net after retention — due now = the PC'))]);
});
add('77-po', async (p, lang) => {
  await vp(p, 1300); await go(p, 'po'); await p.waitForSelector('tr.click'); await wait(400); await row(p, 'PO-');
  await shot(p, '77-po', lang, [F('party_id', 1, L('المورد والمشروع', 'Supplier and project')), F('payment_terms', 2, L('شروط الدفع', 'Terms of payment')), F('deliver_to', 3, L('مكان التسليم ومسؤول الاستلام', 'Deliver to and site contact')),
    F('valid_from', 4, L('مدة الاتفاقية', 'Agreement period')), F('pr_ref', 5, L('رقم PR وعرض سعر المورد', 'PR no. and supplier quotation')), S('.modal #items [data-k=code]', 6, L('كود الصنف', 'Item code')), S('.modal #items [data-k=disc]', 7, L('خصم % لكل بند', 'Discount % per line')),
    S('#tot', 8, L('مجموع الخصم والإجماليات', 'Discount and totals'))]);
});
add('78-subcontract-form', async (p, lang) => {
  await vp(p, 1300); await go(p, 'subcontracts'); await p.waitForSelector('tr.click'); await wait(800); await p.locator('tr.click').first().click(); await wait(800); await click(p, '#es');
  await shot(p, '78-subcontract-form', lang, [F('agreement_no', 1, L('رقم الاتفاقية وتاريخها', 'Agreement no. and date')), F('start_date', 2, L('تاريخ البدء والإنجاز والتمديد', 'Start, completion and extension dates')),
    F('variations', 3, L('أوامر التغيير المعتمدة', 'Approved variations')), F('vat_basis', 4, L('أساس الضريبة في الشهادات', 'VAT basis on certificates')), F('contra_uplift', 5, L('نسبة الإضافة على الخصومات', 'Contra charge uplift %'))], { crop: 'full' });
});
add('79-subcert', async (p, lang) => {
  await vp(p, 1300); await go(p, 'subcontracts'); await p.waitForSelector('tr.click'); await wait(800); await p.locator('tr.click').first().click(); await wait(800);
  await p.locator('.modal [data-c]').first().click(); await p.waitForSelector('.modal [name=period_to]'); await wait(400);
  await shot(p, '79-subcert', lang, [F('period_to', 1, L('للأعمال حتى تاريخ', 'For works up to')), F('cumulative', 2, L('الأعمال والمواد حتى تاريخه (تراكمي)', 'Work and materials to date (cumulative)')), S('#ccost', 3, L('تكلفة الخصم + النسبة = الخصم', 'Contra cost + uplift = contra charge'), { closest: '.f' }),
    F('release', 4, L('الإفراج عن محتجزات', 'Release of retention')), F('app_ref', 5, L('مرجع طلب الدفعة من المقاول', 'The subcontractor’s payment application')), F('cost_codes', 6, L('توزيع الأكواد', 'Cost codes')), S('#pv', 7, L('ملخص الشهادة', 'Certificate summary')), S('.modal #pr', 8, L('طباعة بشكل الـ PC', 'Print in the PC layout'))]);
});
add('80-sc-agreement', async (p, lang) => {
  await vp(p, 1500); await go(p, 'subcontracts'); await p.waitForSelector('tr.click'); await wait(800); await p.locator('tr.click').first().click(); await wait(800); await click(p, '#agr'); await p.waitForSelector('#scb'); await wait(400);
  await shot(p, '80-sc-agreement', lang, [F('payment_days', 1, L('أيام الدفع وفترة الصيانة', 'Payment days and defects period')), F('sub_licence', 2, L('رخصة مقاول الباطن', 'Sub-contractor licence')), S('#scb', 3, L('ملحق 1: جدول الكميات', 'Appendix 1: BOQ')),
    S('#usev', 4, L('المجموع = قيمة العقد', 'Total = contract value'), { closest: 'label' }), F('particular', 5, L('ملحق 2: الشروط الخاصة', 'Appendix 2: particular conditions')), S('#scm', 6, L('ملحق 3: مصفوفة المسؤوليات', 'Appendix 3: responsibility matrix'), { rect: [0, 0, undefined, 160] }),
    S('#scpr', 7, L('طباعة / PDF', 'Print / PDF'))], { crop: 'full' });
});
add('81-settings-docs', async (p, lang) => {
  await vp(p, 1100); await go(p, 'settings'); await p.evaluate(() => { document.querySelector('#sf [name=legal_name]').scrollIntoView({ block: 'start' }); scrollBy(0, -60); });
  await shot(p, '81-settings-legal', lang, [S('#sf [name=legal_name]', 1, L('الاسم القانوني كما في الرخصة', 'Legal name as on the licence'), { closest: '.f' }), S('#sf [name=sub_cert_signatories]', 2, L('خانات توقيع شهادات الباطن', 'Signature boxes on subcontractor PCs'), { closest: '.f' }),
    S('#sf [name=sc_signatory]', 3, L('الموقّع على عقود الباطن', 'Signs sub-contract agreements'), { closest: '.f' })], { crop: 'full' });
  await p.evaluate(() => { document.querySelector('#sf [name=sc_template]').scrollIntoView({ block: 'start' }); scrollBy(0, -60); });
  await shot(p, '82-settings-texts', lang, [S('#sf [name=sc_template]', 1, L('نص اتفاقية الباطن القياسي', 'Standard sub-contract wording'), { closest: '.f' }), S('#sf [name=po_notes]', 2, L('ملاحظات ثابتة على أوامر الشراء', 'Standard notes on purchase orders'), { closest: '.f' }),
    S('#sf [name=po_conditions]', 3, L('الشروط العامة للشراء (صفحة ثانية)', 'General conditions of purchase (page 2)'), { closest: '.f' })], { crop: 'full' });
});
// printed documents: PDF page → JPEG, the same picture in both guides (the documents are in English)
add('90-prints', async (p, lang, ctx) => {
  if (lang !== 'ar') return;
  const j = async u => (await ctx.request.get(BASE + '/api/' + u)).json();
  const apps = await j('claims?project_id=4'), inv = (await j('invoices')).filter(i => i.pc_id).sort((a, b) => b.id - a.id)[0];
  const subs = await j('subcontracts'), cert = (await j('sub_certs')).filter(c => c.subcontract_id === subs[subs.length - 1].id).sort((a, b) => b.id - a.id)[0], po = (await j('purchase_orders')).sort((a, b) => b.id - a.id)[0];
  const docs = [['p1-proforma', 'pay_app/' + apps.apps[apps.apps.length - 1].id, 1], ['p2-tax-invoice', 'invoices/' + inv.id, 1], ['p3-sub-pc', 'sub_certs/' + cert.id, 1], ['p4-purchase-order', 'purchase_orders/' + po.id, 1], ['p5-sc-agreement', 'sc_agreement/' + subs[subs.length - 1].id, 2]];
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'prints-'));
  for (const [name, u, pg] of docs) {
    const d = await ctx.newPage(); await d.goto(BASE + '/api/doc/' + u); await wait(500);
    const pdf = path.join(tmp, name + '.pdf'); await d.pdf({ path: pdf, format: 'A4', printBackground: true, preferCSSPageSize: true }); await d.close();
    execFileSync('pdftoppm', ['-r', '90', '-jpeg', '-jpegopt', 'quality=85', '-f', String(pg), '-l', String(pg), '-singlefile', pdf, path.join(tmp, name)]);
    for (const l of ['ar', 'en']) fs.copyFileSync(path.join(tmp, name + '.jpg'), path.join(OUT, l, name + '.jpg'));
    console.log('  print', name);
  }
});
