const { chromium, BASE, shot } = require('./lib');
(async () => {
  const b = await chromium.launch();
  for (const lang of ['ar', 'en']) {
    const c = await b.newContext({ viewport: { width: 1366, height: 820 } }); await c.addInitScript(l => localStorage.lang = l, lang);
    const p = await c.newPage(); await p.goto(BASE); await p.waitForSelector('form.login'); await p.waitForTimeout(800);
    await p.fill('[name=username]', 'admin'); await p.fill('[name=password]', '••••••••'); await p.fill('[name=company]', 'Trigon Civil Contracting');
    await shot(p, '01-setup', lang, [{ sel: '[name=username]', n: 1, label: ['اسم مستخدم المدير', 'Administrator username'], side: lang === 'ar' ? 'l' : 'r' }, { sel: '[name=password]', n: 2, label: ['كلمة مرور قوية (6+ أحرف)', 'Strong password (6+ chars)'], side: lang === 'ar' ? 'l' : 'r' }, { sel: '[name=company]', n: 3, label: ['اسم الشركة', 'Company name'], side: lang === 'ar' ? 'l' : 'r' }, { sel: 'form.login button.btn', n: 4, label: ['إنشاء الحساب', 'Create account'], side: lang === 'ar' ? 'l' : 'r' }, { sel: '#lg', n: 5, label: ['تبديل اللغة', 'Switch language'], side: 'b' }], { crop: 'form.login' });
    await c.close();
  }
  await b.close();
})();
