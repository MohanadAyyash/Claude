// Cash-flow forecast and the bank guarantee register.
PAGES.cashflow = async () => {
  const n = +sessionStorage.cfMonths || 3, d = await api('GET', 'cashflow?months=' + n);
  const kpi = (l, v, cls = '') => `<div class="kpi"><div class="l">${l}</div><div class="v ${cls}">${money(v)}</div></div>`;
  const KIND = { invoice: tr('فاتورة عميل', 'Customer invoice'), retention: tr('محتجزات', 'Retention'), cheque: tr('شيك مؤجل', 'Post-dated cheque'), bill: tr('فاتورة مورد / مصروف', 'Supplier bill'), payroll: tr('رواتب', 'Salaries'), payroll_est: tr('رواتب (تقدير)', 'Salaries (estimate)') };
  const mName = m => new Date(m + '-01T00:00:00').toLocaleDateString(lang === 'ar' ? 'ar-AE-u-nu-latn' : 'en-GB', { month: 'long', year: 'numeric' });
  const rowsOf = m => d.items.filter(i => i.date.slice(0, 7) === m);
  main(`<div class="bar"><h1>${tr('توقع التدفق النقدي', 'Cash-flow forecast')}</h1><span class="sp"></span>
    <select id="cfm" style="width:auto">${[1, 2, 3, 6].map(k => `<option value="${k}" ${k === n ? 'selected' : ''}>${k} ${tr('أشهر قادمة', 'months ahead')}</option>`).join('')}</select></div>
  <p class="muted">${tr('المتوقع تحصيله ودفعه حسب تواريخ الاستحقاق: فواتير العملاء المفتوحة، المحتجزات، الشيكات المؤجلة، فواتير الموردين (بعد', 'What is expected in and out by due date: open customer invoices, retention, post-dated cheques, supplier bills (after')} ${d.ap_terms_days} ${tr('يوماً من تاريخها)، والرواتب. المتأخر يُحسب مستحقاً الآن.', 'days from their date) and salaries. Anything late counts as due now.')}
    <b>${tr('غير مشمول: دفعات ضريبة القيمة المضافة، والأعمال التي لم تُفوتر بعد، وأوامر الشراء التي لم تصل فواتيرها.', 'Not included: VAT payments, work not invoiced yet, and purchase orders not billed yet.')}</b></p>
  <div class="grid">${kpi(tr('الرصيد النقدي الآن', 'Cash now'), d.opening, d.opening < 0 ? 'neg' : '')}${kpi(tr('متوقع تحصيله', 'Expected in'), d.totals.in, 'pos')}${kpi(tr('متوقع دفعه', 'Expected out'), d.totals.out, 'neg')}${kpi(tr('أدنى رصيد متوقع', 'Lowest expected balance'), d.lowest.balance, d.lowest.balance < 0 ? 'neg' : '')}</div>
  ${d.lowest.balance < 0 ? `<p class="neg">⛔ ${tr('عجز نقدي متوقع في', 'Cash shortfall expected in')} <b>${esc(mName(d.lowest.month || d.as_of.slice(0, 7)))}</b>: ${money(-d.lowest.balance)} — ${tr('سرّع التحصيل أو أجّل دفعات', 'speed up collection or reschedule payments')}.</p>` : ''}
  ${d.totals.late_in > 0 ? `<p class="muted">⚠ ${tr('من المتوقع تحصيله مبالغ متأخرة أصلاً', 'Of the expected receipts, already overdue')}: <b>${money(d.totals.late_in)}</b> — ${tr('التوقع يفترض تحصيلها الآن', 'the forecast assumes they are collected now')}.</p>` : ''}
  <div class="tw"><table><thead><tr><th>${tr('الشهر', 'Month')}</th><th class="n">${tr('تحصيلات', 'In')}</th><th class="n">${tr('مدفوعات', 'Out')}</th><th class="n">${tr('الصافي', 'Net')}</th><th class="n">${tr('الرصيد آخر الشهر', 'Balance at month end')}</th></tr></thead><tbody>
  ${d.buckets.map((b, i) => `<tr class="click" data-m="${b.month}"><td>${esc(mName(b.month))}${i === 0 ? ` <span class="muted">(${tr('الباقي منه', 'rest of it')})</span>` : ''}</td><td class="n pos">${money(b.in)}</td><td class="n neg">${money(b.out)}</td><td class="n ${b.net < 0 ? 'neg' : ''}">${money(b.net)}</td><td class="n ${b.closing < 0 ? 'neg' : ''}"><b>${money(b.closing)}</b></td></tr>`).join('')}
  </tbody></table></div>
  <div id="cfd"></div>`);
  const detail = m => {
    const rows = rowsOf(m);
    $('#cfd').innerHTML = `<div class="card" style="margin-top:16px"><h2>${esc(mName(m))}</h2><div class="tw"><table><thead><tr><th>${tr('التاريخ', 'Date')}</th><th>${tr('النوع', 'Type')}</th><th>${tr('البيان', 'Details')}</th><th class="n">${tr('تحصيل', 'In')}</th><th class="n">${tr('دفع', 'Out')}</th></tr></thead><tbody>
      ${rows.map(i => `<tr><td>${esc(i.date)}${i.late ? `<div class="neg">${tr('متأخر منذ', 'due since')} ${esc(i.original_date)}</div>` : ''}</td><td>${KIND[i.kind] || esc(i.kind)}</td><td>${esc(i.label)}${i.project_name ? `<div class="muted">${esc(i.project_name)}</div>` : ''}</td><td class="n pos">${i.dir === 'in' ? money(i.amount) : ''}</td><td class="n neg">${i.dir === 'out' ? money(i.amount) : ''}</td></tr>`).join('') || `<tr><td colspan="5" class="muted">${tr('لا توجد حركات متوقعة', 'Nothing expected')}</td></tr>`}
    </tbody></table></div></div>`;
  };
  document.querySelectorAll('tr[data-m]').forEach(r => r.onclick = () => detail(r.dataset.m));
  detail(d.buckets[0].month);
  $('#cfm').onchange = e => { sessionStorage.cfMonths = e.target.value; render(); };
};

const GTYPE = { performance: ['حسن تنفيذ', 'Performance bond'], advance: ['دفعة مقدمة', 'Advance payment guarantee'], tender: ['ابتدائي / مناقصة', 'Tender (bid) bond'], retention: ['محتجزات', 'Retention bond'], other: ['أخرى', 'Other'] };
const GSTAT = { active: ['سارية', 'Active'], released: ['مُفرج عنها', 'Released'], claimed: ['مُسيَّلة', 'Claimed'] };
PAGES.guarantees = async () => {
  const projects = await api('GET', 'projects').catch(() => []), can = ['admin', 'accountant', 'manager'].includes(ME.role);
  const rows = await api('GET', 'bank_guarantees'), act = rows.filter(g => g.status === 'active'), sum = (l, k) => l.reduce((s, g) => s + (+g[k] || 0), 0);
  const kpi = (l, v, cls = '') => `<div class="kpi"><div class="l">${l}</div><div class="v ${cls}">${typeof v === 'number' ? money(v) : v}</div></div>`;
  const when = g => g.status !== 'active' || g.days == null ? '' : g.expired ? `<div class="neg">${tr('انتهت منذ', 'expired')} ${-g.days} ${tr('يوم', 'd')}</div>` : g.soon ? `<div class="neg">${tr('تنتهي بعد', 'expires in')} ${g.days} ${tr('يوم', 'd')}</div>` : '';
  await crud({ title: tr('الضمانات البنكية', 'Bank guarantees'), table: 'bank_guarantees', load: async () => rows, noAdd: !can,
    intro: `<p class="muted">${tr('ضمانات حسن التنفيذ والدفعة المقدمة والمناقصات الصادرة من البنك لصالح العملاء. بعد انتهاء الالتزام اطلب خطاب الإفراج وغيّر الحالة إلى «مُفرج عنها»: الضمان الساري يستمر في حجز الهامش النقدي وعمولة البنك.', 'Performance, advance-payment and tender bonds issued by your bank in favour of clients. When the obligation ends, get the release letter and set the status to Released: an active guarantee keeps the cash margin blocked and the bank commission running.')}</p>
      <div class="grid">${kpi(tr('ضمانات سارية', 'Active guarantees'), String(act.length))}${kpi(tr('إجمالي قيمتها', 'Their total value'), sum(act, 'amount'))}${kpi(tr('هامش نقدي محجوز', 'Cash margin blocked'), sum(act, 'margin'))}${kpi(tr('تنتهي خلال ٣٠ يوماً / منتهية', 'Expiring in 30 days / expired'), String(act.filter(g => g.soon || g.expired).length), act.some(g => g.soon || g.expired) ? 'neg' : '')}</div>`,
    fields: async () => [
      { k: 'type', ar: 'النوع', en: 'Type', type: 'select', options: Object.entries(GTYPE).map(([k, v]) => [k, tr(...v)]) },
      { k: 'project_id', ar: 'المشروع', en: 'Project', type: 'select', options: refOpts(projects, p => p.name) },
      { k: 'beneficiary', ar: 'المستفيد (العميل)', en: 'Beneficiary (client)' }, { k: 'bank', ar: 'البنك المُصدر', en: 'Issuing bank' },
      { k: 'number', ar: 'رقم الضمان', en: 'Guarantee no.', req: 1 }, { k: 'amount', ar: 'قيمة الضمان', en: 'Amount', type: 'number', req: 1 },
      { k: 'margin', ar: 'الهامش النقدي المحجوز', en: 'Cash margin blocked', type: 'number', def: 0 },
      { k: 'issue_date', ar: 'تاريخ الإصدار', en: 'Issue date', type: 'date' }, { k: 'expiry_date', ar: 'تاريخ الانتهاء', en: 'Expiry date', type: 'date', req: 1 },
      { k: 'status', ar: 'الحالة', en: 'Status', type: 'select', options: Object.entries(GSTAT).map(([k, v]) => [k, tr(...v)]), def: 'active' },
      { k: 'notes', ar: 'ملاحظات', en: 'Notes', type: 'textarea', full: 1 }],
    cols: [{ ar: 'رقم الضمان', en: 'No.', k: 'number' }, { ar: 'النوع', en: 'Type', f: g => tr(...(GTYPE[g.type] || ['', ''])) }, { ar: 'المشروع', en: 'Project', f: g => esc(g.project_name || '') },
      { ar: 'المستفيد', en: 'Beneficiary', k: 'beneficiary' }, { ar: 'البنك', en: 'Bank', k: 'bank' }, { ar: 'القيمة', en: 'Amount', n: 1, f: g => money(g.amount) }, { ar: 'الهامش', en: 'Margin', n: 1, f: g => money(g.margin) },
      { ar: 'الانتهاء', en: 'Expiry', f: g => esc(g.expiry_date || '') + when(g) }, { ar: 'الحالة', en: 'Status', f: g => tr(...(GSTAT[g.status] || ['', ''])) }] });
};
