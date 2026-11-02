const { chromium, BASE, shot } = require('./lib');
global.BASE = BASE;
const only = process.argv[2] ? process.argv[2].split(',') : null, langs = (process.argv[3] || 'ar,en').split(',');
const L = (ar, en) => [ar, en];
const F = (name, n, label, x = {}) => ({ sel: `.modal [name=${name}]`, closest: '.f', n, label, ...x });
const T = (text, n, label, x = {}) => ({ text, n, label, ...x });
const S = (sel, n, label, x = {}) => ({ sel, n, label, ...x });
const SHOTS = [];
const add = (name, fn) => SHOTS.push({ name, fn });
const go = async (p, r) => { await p.evaluate(() => { const m = document.getElementById('modal-root'); if (m) m.innerHTML = ''; }).catch(() => {}); await p.goto(BASE + '/#' + r); await p.waitForFunction(() => document.querySelector('#main') && document.querySelector('#main').children.length); await p.waitForLoadState('networkidle'); await p.waitForTimeout(300); };
const vp = (p, h, w = 1366) => p.setViewportSize({ width: w, height: h });
const click = async (p, sel) => { await p.click(sel); await p.waitForLoadState('networkidle'); await p.waitForTimeout(400); };
const clickText = async (p, text, scope = '') => { await p.locator(`${scope} button, ${scope} a`).filter({ hasText: text }).first().click(); await p.waitForLoadState('networkidle'); await p.waitForTimeout(400); };
const row = async (p, text) => { await p.locator('tr.click').filter({ hasText: text }).first().click(); await p.waitForLoadState('networkidle'); await p.waitForTimeout(450); };
const tx = (lang, ar, en) => lang === 'ar' ? ar : en;
const sideL = lang => lang === 'ar' ? 'l' : 'r', sideR = lang => lang === 'ar' ? 'r' : 'l';

// ---------- general ----------
add('02-login', async (p, lang, ctx) => {
  const pg = await ctx.newPage(); await pg.goto(BASE); await pg.waitForSelector('form.login'); await pg.waitForTimeout(600);
  await pg.fill('[name=username]', 'admin'); await pg.fill('[name=password]', 'secret12');
  await shot(pg, '02-login', lang, [S('[name=username]', 1, L('اسم المستخدم', 'Username'), { side: sideL(lang) }), S('[name=password]', 2, L('كلمة المرور', 'Password'), { side: sideL(lang) }), S('form.login button.btn', 3, L('دخول', 'Sign in'), { side: sideL(lang) }), S('#lg', 4, L('English / عربي', 'English / عربي'), { side: 'b' })], { crop: 'form.login' });
  await pg.close();
}, true);
add('03-dashboard', async (p, lang) => {
  await vp(p, 900); await go(p, 'dashboard');
  await shot(p, '03-dashboard', lang, [S('.side', 1, L('القائمة الجانبية: كل الأقسام حسب صلاحيتك', 'Side menu: every section your role allows'), { side: lang === 'ar' ? 'l' : 'r', rect: [0, 120, undefined, 300] }), S('.grid', 2, L('مؤشرات الشركة: العقود، الفواتير، النقد، المستحقات', 'Company KPIs: contracts, invoiced, cash, receivables'), { side: 'b' }),
    S('#prt', 3, L('طباعة أي صفحة بترويسة الشركة', 'Print any page on the letterhead'), { side: 'b' })], { crop: 'full' });
});
// ---------- settings ----------
add('04-settings-company', async (p, lang) => {
  await vp(p, 1150); await go(p, 'settings');
  await shot(p, '04-settings-company', lang, [S('#sf [name=company_name]', 1, L('اسم الشركة بالإنجليزي والعربي', 'Company name in English and Arabic'), { closest: '.f', side: 't' }), S('#sf [name=trn]', 2, L('الرقم الضريبي 15 رقم', 'VAT TRN, 15 digits'), { closest: '.f' }),
    S('#sf [name=doc_prefix]', 3, L('بادئة ترقيم العروض والخطابات', 'Prefix for quotation & letter numbers'), { closest: '.f' }), S('#sf [name=mohre_id]', 4, L('بيانات WPS: رقم المنشأة والبنك', 'WPS data: MOHRE ID and bank'), { closest: '.f', side: sideR(lang) }),
    S('#sf [name=vat_registered]', 5, L('غير مسجّل؟ اختر «لا»', 'Not registered? choose "No"'), { closest: '.f' }), S('#sf [name=bank_details]', 6, L('تُطبع على كل فاتورة', 'Printed on every invoice'), { closest: '.f', side: 't' }), S('#sf #save', 7, L('حفظ', 'Save'), { side: sideL(lang) })]);
});
add('05-settings-brand', async (p, lang) => {
  await vp(p, 900); await go(p, 'settings'); await p.evaluate(() => document.querySelector('#pack').scrollIntoView({ block: 'start' })); await p.evaluate(() => scrollBy(0, -80));
  await shot(p, '05-settings-brand', lang, [S('#pack', 1, L('تركيب هوية تريجون بنقرة واحدة', 'Install the Trigon brand in one click'), { side: 'b', dist: 30 }), S('[data-brand=stamp]', 2, L('ارفع الختم الرسمي (PNG شفاف)', 'Upload the official stamp (transparent PNG)'), { closest: '.kpi', side: 'b' }), S('[data-brand=signature]', 3, L('التوقيع المعتمد', 'Authorised signature'), { closest: '.kpi', side: 'b' })]);
});
add('06-settings-email', async (p, lang) => {
  await vp(p, 900); await go(p, 'settings'); await p.evaluate(() => document.querySelector('#ef').scrollIntoView({ block: 'start' })); await p.evaluate(() => scrollBy(0, -20));
  await shot(p, '06-settings-email', lang, [S('#ef [name=mail_method]', 1, L('اختر SMTP أو Microsoft 365', 'Choose SMTP or Microsoft 365'), { closest: '.f' }), S('#ef [name=smtp_from]', 2, L('عنوان المرسِل', 'From address'), { closest: '.f' }), S('#ef [name=smtp_host]', 3, L('بيانات خادم البريد', 'Mail server details'), { closest: '.f2', side: 'b' }), S('#saveE', 4, L('حفظ', 'Save'), { side: 'b' }), S('#test', 5, L('اكتب بريدك ثم أرسل تجربة', 'Type your email, then send a test'), { side: 'b' })]);
});
add('07-settings-users', async (p, lang) => {
  await vp(p, 900); await go(p, 'settings'); await p.evaluate(() => document.querySelector('#addU').closest('.card').scrollIntoView({ block: 'start' }));
  await shot(p, '07-settings-users', lang, [S('#addU', 1, L('إضافة مستخدم جديد', 'Add a new user'), { side: sideR(lang) }), S('[data-pw]', 2, L('إعادة تعيين كلمة المرور', 'Reset password'), { side: 'b' }), S('[data-urole]', 3, L('تغيير الدور', 'Change role'), { side: 'b', dist: 90 }), S('[data-uproj]', 4, L('مشاريع مهندس الموقع/الفورمان', 'Projects of a site engineer/foreman'), { side: sideR(lang) }), S('#pf', 5, L('ملفي الشخصي: يظهر في توقيع الإيميل', 'My profile: shown in the e-mail signature'), { side: 't' })]);
});
add('08-user-new', async (p, lang) => {
  await vp(p, 800); await go(p, 'settings'); await click(p, '#addU');
  await p.fill('.modal [name=username]', 'suresh'); await p.selectOption('.modal [name=role]', 'employee').catch(() => {}); await p.waitForTimeout(200);
  await shot(p, '08-user-new', lang, [F('username', 1, L('اسم المستخدم', 'Username'), { side: 't' }), F('password', 2, L('كلمة المرور (6+)', 'Password (6+)'), { side: 't' }), F('role', 3, L('الدور يحدد ما يراه المستخدم', 'The role decides what the user sees'), { side: 'b' }), F('employee_id', 4, L('اربطه بملف الموظف إن كان موظفاً', 'Link to the employee record if staff'), { side: 'b' }), S('.modal .acts .btn', 5, L('إنشاء', 'Create'), { side: sideL(lang) })]);
});
// ---------- parties ----------
add('09-parties', async (p, lang) => {
  await vp(p, 800); await go(p, 'parties'); await click(p, '#add');
  await p.selectOption('.modal [name=type]', 'client'); await p.fill('.modal [name=name]', 'Al Noor Real Estate Development'); await p.fill('.modal [name=trn]', '100555666700003'); await p.fill('.modal [name=email]', 'projects@alnoor.ae'); await p.fill('.modal [name=address]', 'Business Bay, Dubai');
  await shot(p, '09-party-new', lang, [F('type', 1, L('عميل / مورد / مقاول باطن', 'Client / supplier / subcontractor'), { side: 't' }), F('name', 2, L('الاسم (إلزامي)', 'Name (required)'), { side: 't' }), F('trn', 3, L('الرقم الضريبي: مطلوب للفاتورة الضريبية', 'TRN: needed on tax invoices'), { side: sideR(lang) }), F('address', 4, L('العنوان: مطلوب في الفاتورة', 'Address: required on invoices'), { side: sideL(lang) }), S('.modal #save', 5, L('حفظ', 'Save'), { side: 'b' })]);
});
// ---------- tenders ----------
add('10-tenders', async (p, lang) => {
  await vp(p, 860); await go(p, 'tenders');
  await shot(p, '10-tenders', lang, [S('#main .grid', 1, L('قيمة الفرص والقيمة المرجّحة ونسبة الفوز', 'Pipeline, weighted value and win rate'), { side: 'b' }), T(tx(lang, 'قيد التسعير', 'Preparing'), 2, L('كل عمود = مرحلة، والبطاقة = مناقصة', 'Each column is a stage; each card is a tender'), { tags: 'h3', up: 1, side: 'b' }), S('#add', 3, L('إضافة مناقصة / فرصة', 'Add a tender / opportunity'), { side: 'b', sel2: '#main .bar button.btn' })]);
});
add('11-tender-modal', async (p, lang, ctx) => {
  await ctx.request.post(BASE + '/api/tenders/2/quote').catch(() => {});
  await vp(p, 900); await go(p, 'tenders'); await p.locator('#main').getByText('Labour Camp Renovation').first().click(); await p.waitForTimeout(600);
  await shot(p, '11-tender-modal', lang, [F('title', 1, L('اسم المناقصة / الفرصة', 'Tender / opportunity title')), F('stage', 2, L('غيّر المرحلة مع التقدم', 'Change the stage as it progresses')), F('value', 3, L('القيمة التقديرية', 'Estimated value')), F('probability', 4, L('احتمال الفوز %', 'Win probability %')),
    S('#oq', 5, L('فتح عرض السعر المرتبط (أو إنشاء عرض سعر)', 'Open the linked quotation (or Create quotation)'), { sel2: '#nq' }), S('#win', 6, L('عند الفوز: تحويل إلى مشروع', 'When won: convert to project')), S('.modal #save', 7, L('حفظ', 'Save'))]);
});
// ---------- quotes ----------
add('12-quotes', async (p, lang) => {
  await vp(p, 700); await go(p, 'quotes');
  await shot(p, '12-quotes', lang, [S('#add', 1, L('عرض سعر جديد', 'New quotation'), { side: 'b' }), S('tr.click', 2, L('اضغط على العرض لفتحه', 'Click a quotation to open it'), { side: 'b' }), S('#main thead th:last-child', 3, L('الحالة: مسودة / مرسل / مقبول', 'Status: draft / sent / accepted'), { side: 'b', dist: 80 })]);
});
add('13-quote-new', async (p, lang) => {
  await vp(p, 1000); await go(p, 'quotes'); await click(p, '#add');
  await p.selectOption('.modal [name=client_id]', { index: 1 }); await p.fill('.modal [name=project_name]', 'Al Noor Villas — Phase 2');
  const r = p.locator('#items tr').first(); await r.locator('[data-k=description]').fill('Excavation and backfilling'); await r.locator('[data-k=unit]').fill('m3'); await r.locator('[data-k=qty]').fill('3200'); await r.locator('[data-k=rate]').fill('28');
  await p.click('#addrow'); const r2 = p.locator('#items tr').nth(1); await r2.locator('[data-k=description]').fill('Reinforced concrete footings C35'); await r2.locator('[data-k=unit]').fill('m3'); await r2.locator('[data-k=qty]').fill('640'); await r2.locator('[data-k=rate]').fill('1150'); await r2.locator('[data-k=rate]').press('Tab');
  await shot(p, '13-quote-new', lang, [F('number', 1, L('اتركه فارغاً للترقيم التلقائي', 'Leave empty for the automatic number'), { side: 't' }), F('client_id', 2, L('اختر العميل', 'Choose the client'), { side: 't' }), F('validity_days', 3, L('صلاحية العرض بالأيام', 'Validity in days'), { side: sideR(lang) }),
    S('.modal .docitems', 4, L('البنود: الوصف، الوحدة، الكمية، السعر، الضريبة', 'Lines: description, unit, qty, rate, VAT'), { side: sideL(lang) }), S('#addrow', 5, L('إضافة بند', 'Add a line'), { side: 'b' }), S('#tot', 6, L('الإجمالي والضريبة تلقائياً', 'Totals and VAT calculated automatically'), { side: 'b' }), S('.modal [name=terms]', 7, L('الشروط (من الإعدادات)', 'Terms (from Settings)'), { closest: '.f', side: 't' }), S('.modal #save', 8, L('حفظ', 'Save'), { side: 't' })]);
});
add('14-quote-actions', async (p, lang) => {
  await vp(p, 900); await go(p, 'quotes'); await row(p, 'Labour Camp');
  await shot(p, '14-quote-actions', lang, [S('.modal #print', 1, L('طباعة / PDF مع الغلاف', 'Print / PDF with cover page'), { side: 't' }), S('.modal #mail', 2, L('إرسال للعميل بالإيميل', 'Email it to the client'), { side: 't', dist: 90 }), S('.modal #conv', 3, L('عند القبول: تحويل إلى مشروع', 'When accepted: convert to project'), { side: 'b' }), S('.modal #share', 4, L('رابط قبول إلكتروني بالتوقيع', 'Online acceptance link with signature'), { side: 'b', dist: 90 }), F('status', 5, L('تحديث الحالة يدوياً', 'Update the status by hand'), { side: 'b' })]);
});
add('15-quote-link', async (p, lang) => {
  await vp(p, 700); await go(p, 'quotes'); await row(p, 'Labour Camp'); await click(p, '.modal #share');
  await shot(p, '15-quote-link', lang, [S('#lnk', 1, L('الرابط الذي يفتحه العميل', 'The link the client opens'), { side: 'b' }), S('#cp', 2, L('نسخ الرابط', 'Copy the link'), { side: 'b' }), S('#em', 3, L('إرساله بالإيميل مع العرض', 'Email it with the quotation'), { side: 'b', dist: 90 })]);
});
module.exports = { SHOTS, add, go, vp, click, clickText, row, F, T, S, L, tx, sideL, sideR };
if (require.main === module) (async () => {
  try { require('./run2'); } catch (e) { if (!/Cannot find module '.\/run2'/.test(e.message)) throw e; }
  const b = await chromium.launch();
  for (const lang of langs) {
    const ctx = await b.newContext({ viewport: { width: 1366, height: 860 } }); await ctx.addInitScript(l => { localStorage.lang = l; }, lang);
    const p = await ctx.newPage(); p.setDefaultTimeout(6000);
    for (const s of SHOTS) {
      if (only && !only.some(o => s.name.startsWith(o))) continue;
      if (s.name !== '02-login' && !ctx._in) { await ctx.request.post(BASE + '/api/login', { data: { username: 'admin', password: 'Trigon2026' } }); ctx._in = 1; }
      try { await p.keyboard.press('Escape'); await s.fn(p, lang, ctx, b); } catch (e) { console.log('FAIL', lang, s.name, e.message.split('\n')[0]); }
    }
    await ctx.close();
  }
  await b.close();
})();
