// Contractor ERP — frontend (vanilla JS, Arabic/English)
let lang = localStorage.lang || 'ar';
let S = {};            // company settings
let ME = {};           // current user {username, role}
let route = location.hash.slice(1) || 'dashboard';
const tr = (ar, en) => (lang === 'ar' ? ar : en);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => (+n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const $ = (s, r = document) => r.querySelector(s);
const today = () => new Date().toISOString().slice(0, 10);
const cur = () => S.currency || 'AED';

async function api(method, url, body) {
  const r = await fetch('/api/' + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && url !== 'login') { boot(); throw new Error('unauthorized'); }
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
const toast = m => { const d = document.createElement('div'); d.className = 'toast'; d.textContent = m; document.body.appendChild(d); setTimeout(() => d.remove(), 2600); };
const guard = fn => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message); } };
const fmtIssues = e => e.message;

// ---- vocab ----------------------------------------------------------------
const STATUS = { approved: ['معتمد', 'Approved'], pending_v: ['قيد الاعتماد', 'Pending'],
  active: ['نشط', 'Active'], completed: ['منتهي', 'Completed'], hold: ['متوقف', 'On hold'], cancelled: ['ملغي', 'Cancelled'],
  draft: ['مسودة', 'Draft'], sent: ['مُرسل', 'Sent'], accepted: ['مقبول', 'Accepted'], rejected: ['مرفوض', 'Rejected'],
  paid: ['مدفوع', 'Paid'], unpaid: ['غير مدفوع', 'Unpaid'], partial: ['جزئي', 'Partial'], overdue: ['متأخر', 'Overdue'], credit: ['إشعار دائن', 'Credit note'], void: ['ملغاة', 'Void'], final: ['معتمد', 'Final'], pending: ['قيد التحصيل', 'Pending'], cleared: ['تم صرفه', 'Cleared'], bounced: ['مرتجع', 'Bounced'], left: ['ترك العمل', 'Left'], retention: ['محتجز', 'Retention held'],
};
const tag = s => `<span class="tag ${s}">${esc(STATUS[s] ? tr(...STATUS[s]) : s)}</span>`;
const CATS = { asset: ['شراء أصل ثابت (يُهلك)', 'Fixed asset purchase (depreciated)'], materials: ['مواد', 'Materials'], labour: ['عمالة', 'Labour'], subcontract: ['مقاولو باطن', 'Subcontractor'], equipment: ['معدات', 'Equipment'], transport: ['نقل', 'Transport'], permits: ['رسوم وتراخيص', 'Permits & fees'], overhead: ['مصاريف عامة', 'Overheads'], other: ['أخرى', 'Other'] };
const PTYPE = { client: ['عميل', 'Client'], supplier: ['مورد', 'Supplier'], subcontractor: ['مقاول باطن', 'Subcontractor'] };
const EMIRATES = { abu_dhabi: ['أبوظبي', 'Abu Dhabi'], dubai: ['دبي', 'Dubai'], sharjah: ['الشارقة', 'Sharjah'], ajman: ['عجمان', 'Ajman'], uaq: ['أم القيوين', 'Umm Al Quwain'], rak: ['رأس الخيمة', 'Ras Al Khaimah'], fujairah: ['الفجيرة', 'Fujairah'] };
const VATC = { std: ['خاضع 5%', 'Standard 5%'], zero: ['صفري', 'Zero-rated'], exempt: ['معفى', 'Exempt'] };
const ROLE = { admin: ['مدير النظام', 'Admin'], accountant: ['محاسب', 'Accountant'], manager: ['مدير مشاريع', 'Project manager'], hr: ['موارد بشرية', 'HR'], viewer: ['عرض فقط', 'Viewer'], employee: ['موظف (بوابة الموظف)', 'Employee (portal)'] };
const METHODS = { bank: ['تحويل بنكي', 'Bank transfer'], cheque: ['شيك', 'Cheque'], cash: ['نقد', 'Cash'], card: ['بطاقة', 'Card'] };
const opts = (map, sel) => Object.entries(map).map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${esc(tr(...v))}</option>`).join('');

// ---- boot / auth ------------------------------------------------------------
async function boot() {
  const st = await (await fetch('/api/status')).json();
  document.documentElement.lang = lang; document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  if (st.setup) return setupScreen();
  if (!st.user) return loginScreen();
  ME = st.user; document.body.dataset.role = ME.role; route = location.hash.slice(1) || landing();
  if (!allowedNav().some(n => n[0] === route.split('/')[0])) route = landing();
  S = await api('GET', 'settings');
  document.title = S.company_name || tr('نظام إدارة المقاولات', 'Contractor ERP');
  shell();
}
function authBox(title, extra, btn, onsubmit) {
  $('#app').innerHTML = `<form class="login"><h2>${title}</h2>
    <div class="f"><label>${tr('اسم المستخدم', 'Username')}</label><input name="username" required autofocus></div>
    <div class="f"><label>${tr('كلمة المرور', 'Password')}</label><input name="password" type="password" required minlength="6"></div>${extra}
    <div class="err" id="err"></div><button class="btn" style="width:100%">${btn}</button>
    <p style="text-align:center"><a href="#" id="lg" class="muted">${lang === 'ar' ? 'English' : 'عربي'}</a></p></form>`;
  $('#lg').onclick = e => { e.preventDefault(); lang = lang === 'ar' ? 'en' : 'ar'; localStorage.lang = lang; boot(); };
  $('form').onsubmit = async e => {
    e.preventDefault();
    try { await onsubmit(Object.fromEntries(new FormData(e.target))); boot(); } catch (x) { $('#err').textContent = x.message; }
  };
}
const loginScreen = () => authBox(tr('تسجيل الدخول', 'Sign in'), '', tr('دخول', 'Sign in'), d => api('POST', 'login', d));
const setupScreen = () => authBox(tr('إعداد النظام لأول مرة', 'First-time setup'),
  `<div class="f"><label>${tr('اسم الشركة', 'Company name')}</label><input name="company"></div>`, tr('إنشاء الحساب', 'Create account'), d => api('POST', 'setup', d));

// ---- shell ------------------------------------------------------------------
const FINR = ['admin', 'accountant'], READR = ['admin', 'accountant', 'manager', 'viewer'], HRR = ['admin', 'hr'], EMPR = ['admin', 'accountant', 'hr'];
const NAV = [   // [route, ar, en, roles]; '#' rows are group headings
  ['dashboard', 'لوحة التحكم', 'Dashboard', READR], ['portal', 'بوابتي', 'My portal', ['employee']],
  ['#', 'المشاريع والمبيعات', 'Projects & sales'], ['projects', 'المشاريع', 'Projects', READR], ['quotes', 'عروض الأسعار', 'Quotations', READR], ['invoices', 'فواتير العملاء', 'Sales invoices', READR], ['sitediary', 'يومية الموقع', 'Site diary', READR],
  ['#', 'المشتريات والمخزون', 'Procurement & stock'], ['rfq', 'طلبات الأسعار (RFQ)', 'RFQs', READR], ['po', 'أوامر الشراء', 'Purchase orders', READR], ['subcontracts', 'مقاولو الباطن وشهادات الدفع', 'Subcontracts & certificates', READR],
  ['bills', 'المصروفات والمشتريات', 'Expenses & purchases', READR], ['payments', 'المدفوعات والمقبوضات', 'Payments', READR], ['parties', 'العملاء والموردون', 'Clients & suppliers', READR],
  ['stock', 'المخزون', 'Stock', READR], ['assets', 'الأصول والمعدات', 'Assets & equipment', [...FINR, 'manager']], ['petty', 'العهدة النقدية', 'Petty cash', FINR],
  ['#', 'المحاسبة', 'Accounting'], ['financials', 'القوائم المالية', 'Financial statements', FINR], ['ledger', 'دفتر الأستاذ', 'General ledger', FINR], ['journal', 'قيود اليومية', 'Journal entries', FINR], ['coa', 'دليل الحسابات', 'Chart of accounts', FINR], ['bank', 'مطابقة البنك', 'Bank reconciliation', FINR],
  ['#', 'الموارد البشرية', 'Human resources'], ['hrdash', 'لوحة الموارد البشرية', 'HR dashboard', HRR], ['employees', 'الموظفون', 'Employees', EMPR], ['attendance', 'الحضور والإضافي', 'Attendance & overtime', [...HRR, 'manager']],
  ['leave', 'الإجازات', 'Leave', HRR], ['hrrequests', 'طلبات الموظفين', 'Employee requests', HRR], ['letters', 'الخطابات الرسمية', 'Official letters', HRR], ['payroll', 'الرواتب ونظام حماية الأجور', 'Payroll & WPS', EMPR],
  ['#', 'الضرائب والامتثال', 'Tax & compliance'], ['vat', 'ضريبة القيمة المضافة', 'VAT report', ['admin', 'accountant', 'viewer']], ['ctax', 'ضريبة الشركات', 'Corporate tax', FINR], ['compliance', 'الامتثال والتدقيق', 'Compliance & audit', FINR], ['documents', 'المستندات', 'Documents', [...READR, 'hr']],
  ['settings', 'الإعدادات', 'Settings', ['admin', 'accountant', 'manager', 'hr', 'viewer', 'employee']],
];
const allowedNav = () => NAV.filter(n => n[0] !== '#' && (n[3] || []).includes(ME.role));
const landing = () => (ME.role === 'employee' ? 'portal' : ME.role === 'hr' ? 'hrdash' : 'dashboard');
function shell() {
  const ok = allowedNav(), okSet = new Set(ok.map(n => n[0]));
  let links = '', pending = '';
  for (const n of NAV) {
    if (n[0] === '#') { pending = `<div class="grp">${tr(n[1], n[2])}</div>`; continue; }
    if (!okSet.has(n[0])) continue;
    links += pending + `<a data-r="${n[0]}" class="${route.split('/')[0] === n[0] ? 'on' : ''}">${tr(n[1], n[2])}</a>`; pending = '';
  }
  $('#app').innerHTML = `<div class="shell"><nav class="side"><div class="brand">${esc(lang === 'ar' && S.company_name_ar ? S.company_name_ar : (S.company_name || tr('نظام المقاولات', 'Contractor ERP')))}<div style="font-size:11px;font-weight:400;color:#9fb3c6">${esc(ME.username)} · ${esc(ROLE[ME.role] ? tr(...ROLE[ME.role]) : ME.role)}</div></div>
    ${links}
    <div class="foot"><button class="btn" id="lang">${lang === 'ar' ? 'English' : 'عربي'}</button><button class="btn" id="out">${tr('خروج', 'Logout')}</button></div></nav>
    <main class="main" id="main"></main></div>`;
  document.querySelectorAll('.side a').forEach(a => a.onclick = () => go(a.dataset.r));
  $('#lang').onclick = () => { lang = lang === 'ar' ? 'en' : 'ar'; localStorage.lang = lang; boot(); };
  $('#out').onclick = async () => { await api('POST', 'logout'); boot(); };
  render();
}
const go = r => { location.hash = r; };
window.onhashchange = () => { route = location.hash.slice(1) || landing(); if ($('#main')) shell(); };
const PAGES = {};
const render = async () => {
  const [p, id] = route.split('/'); $('#main').innerHTML = '';
  try {
    await (PAGES[p] || PAGES[landing()])(id);
    if (ME.role !== 'employee' && $('#main').children.length) { let bar = $('#main .bar'); if (!bar) { const h = $('#main h1'); bar = document.createElement('div'); bar.className = 'bar'; if (h) { h.replaceWith(bar); bar.append(h); bar.insertAdjacentHTML('beforeend', '<span class="sp"></span>'); } else $('#main').prepend(bar); } bar.insertAdjacentHTML('beforeend', `<button class="btn sec sm noprint" id="prt">🖨 ${tr('طباعة بالترويسة', 'Print on letterhead')}</button>`); $('#prt').onclick = printReport; }
  }
  catch (e) {
    if (e.message === 'unauthorized') return;
    const stale = /not found/i.test(e.message);
    $('#main').innerHTML = `<div class="card"><h2 class="neg">${tr('تعذّر تحميل الصفحة', 'This page could not be loaded')}</h2><p>${esc(e.message)}</p>
      ${stale ? `<p>${tr('غالباً الخادم يعمل بنسخة قديمة. أغلق نافذة PowerShell (Ctrl+C) ثم شغّل npm.cmd start من جديد، وبعدها حدّث الصفحة (Ctrl+F5).', 'The server is probably running an old version. Stop it in PowerShell (Ctrl+C), start it again with npm.cmd start, then hard-refresh the page (Ctrl+F5).')}</p>` : ''}</div>`;
  }
};
const main = html => { $('#main').innerHTML = html; };

// ---- printing any page on the company letterhead ------------------------------------
const xl = (name, qs = '') => `<a class="btn sec sm noprint" href="/api/export/${name}${qs}" target="_blank">Excel</a>`;
function printReport() {
  const el = $('#main').cloneNode(true);
  el.querySelectorAll('input,select,textarea').forEach(i => i.replaceWith(document.createTextNode(i.tagName === 'SELECT' ? (i.selectedOptions[0]?.text || '') : i.value)));
  el.querySelectorAll('.noprint,button,a.btn,.sp').forEach(x => x.remove());
  const names = `<h1 style="margin:0;font-size:17px">${esc(S.company_name || '')}</h1>${S.company_name_ar ? `<div style="font-size:15px;font-weight:700" dir="rtl">${esc(S.company_name_ar)}</div>` : ''}<div style="font-size:11px">${[S.address, S.phone, S.email, S.website].filter(Boolean).map(esc).join(' · ')}</div>${S.trn ? `<div style="font-size:11px">TRN: ${esc(S.trn)}</div>` : ''}`;
  $('#print-area').innerHTML = `<div class="doc rep"><div class="hd"><div><img src="/api/brand/logo" style="max-height:64px;max-width:180px" onerror="this.remove()"></div><div style="text-align:end">${names}</div></div>${el.innerHTML}
    <div class="sig"><div></div><div style="border:0;position:relative;min-height:80px"><img src="/api/brand/stamp" style="max-height:80px" onerror="this.remove()"><img src="/api/brand/signature" style="max-height:50px;position:absolute;inset-inline-start:40px;top:20px" onerror="this.remove()"></div></div>
    <div style="font-size:10px;color:#555;margin-top:8px">${tr('طُبع بتاريخ', 'Printed on')} ${today()} — ${esc(ME.username)}</div></div>`;
  setTimeout(() => window.print(), 450);                                  // let the logo load first
}

// ---- modal & form helpers ---------------------------------------------------
function modal(html, wide) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="overlay"><div class="modal ${wide ? 'wide' : ''}">${html}</div></div>`;
  root.firstChild.onmousedown = e => { if (e.target === root.firstChild) closeModal(); };
  return root.firstChild;
}
const closeModal = () => { $('#modal-root').innerHTML = ''; };
const val = (el, k) => { const x = el.querySelector(`[name="${k}"]`); return x ? x.value : undefined; };
function field(f, v) {
  if (f.type === 'hidden') return `<input type="hidden" name="${f.k}" value="${esc(v ?? '')}">`;
  const lbl = `<label>${tr(f.ar, f.en)}${f.req ? ' *' : ''}</label>`;
  let inp;
  if (f.type === 'select') inp = `<select name="${f.k}">${f.options.map(([k, l]) => `<option value="${esc(k)}" ${String(k) === String(v ?? '') ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  else if (f.type === 'textarea') inp = `<textarea name="${f.k}">${esc(v ?? '')}</textarea>`;
  else inp = `<input name="${f.k}" type="${f.type || 'text'}" ${f.type === 'number' ? 'step="any"' : ''} value="${esc(v ?? '')}" ${f.req ? 'required' : ''}>`;
  return `<div class="f ${f.full ? 'full' : ''}">${lbl}${inp}</div>`;
}
const refOpts = (rows, label, blank = true) => [...(blank ? [['', '—']] : []), ...rows.map(r => [r.id, label(r)])];
const confirmDel = () => confirm(tr('هل أنت متأكد من الحذف؟', 'Delete this record?'));

// Generic CRUD list + modal
async function crud({ title, table, fields, cols, load, intro, extra, onModal, noAdd }) {
  const data = load ? await load() : await api('GET', table);
  const refresh = () => render();
  main(`<div class="bar"><h1>${title}</h1><span class="sp"></span>${extra || ''}${noAdd ? '' : `<button class="btn" id="add">+ ${tr('إضافة', 'Add')}</button>`}</div>${intro || ''}
    <div class="tw"><table><thead><tr>${cols.map(c => `<th class="${c.n ? 'n' : ''}">${tr(c.ar, c.en)}</th>`).join('')}</tr></thead>
    <tbody>${data.map(r => `<tr class="click" data-id="${r.id}">${cols.map(c => `<td class="${c.n ? 'n' : ''}">${c.f ? c.f(r) : esc(r[c.k] ?? '')}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${cols.length}" class="muted">${tr('لا توجد بيانات', 'No records yet')}</td></tr>`}</tbody></table></div>`);
  const edit = async row => {
    const fs = await fields(row);
    const m = modal(`<h2>${row ? tr('تعديل', 'Edit') : tr('إضافة', 'Add')} — ${title}</h2><div class="f2">${fs.map(f => field(f, row?.[f.k] ?? f.def)).join('')}</div>
      <div class="acts"><button class="btn" id="save">${tr('حفظ', 'Save')}</button><button class="btn sec" id="cancel">${tr('إلغاء', 'Cancel')}</button><span class="sp"></span>${row ? `<button class="btn bad" id="del">${tr('حذف', 'Delete')}</button>` : ''}</div>`);
    $('#cancel', m).onclick = closeModal; if (onModal) onModal(m, row);
    $('#save', m).onclick = guard(async () => {
      const body = {}; fs.forEach(f => body[f.k] = val(m, f.k));
      for (const f of fs) if (f.req && !body[f.k]) throw new Error(tr('أكمل الحقول المطلوبة', 'Fill the required fields'));
      row ? await api('PUT', `${table}/${row.id}`, body) : await api('POST', table, body);
      closeModal(); refresh();
    });
    if (row) $('#del', m).onclick = guard(async () => { if (confirmDel()) { await api('DELETE', `${table}/${row.id}`); closeModal(); refresh(); } });
  };
  if ($('#add')) $('#add').onclick = guard(() => edit(null));
  document.querySelectorAll('tr.click').forEach(tr_ => tr_.onclick = guard(() => (extra_row ? extra_row(+tr_.dataset.id) : edit(data.find(d => d.id === +tr_.dataset.id)))));
  let extra_row = null;
  return { data, edit, setRow: f => (extra_row = f) };
}

// ---- pages ------------------------------------------------------------------
PAGES.dashboard = async () => {
  const d = await api('GET', 'dashboard');
  const mx = Math.max(1, ...d.months.flatMap(m => [m.in, m.out]));
  const kpi = (l, v, cls = '') => `<div class="kpi"><div class="l">${l}</div><div class="v ${cls}">${typeof v === 'number' ? money(v) : v}</div></div>`;
  main(`<h1>${tr('لوحة التحكم', 'Dashboard')}</h1>
  <div class="grid">${kpi(tr('مشاريع نشطة', 'Active projects'), d.active_projects)}${kpi(tr('إجمالي قيمة العقود', 'Total contract value'), d.contract_value)}
   ${kpi(tr('إجمالي الفواتير (بدون ضريبة)', 'Invoiced (ex VAT)'), d.invoiced)}${kpi(tr('إجمالي المصروفات (بدون ضريبة)', 'Expenses (ex VAT)'), d.expenses)}
   ${kpi(tr('الربح التشغيلي', 'Operating profit'), d.invoiced - d.expenses, d.invoiced - d.expenses >= 0 ? 'ok' : 'bad')}
   ${kpi(tr('الرصيد النقدي', 'Cash balance'), d.cash, d.cash >= 0 ? 'ok' : 'bad')}
   ${kpi(tr('مستحقات على العملاء', 'Receivables'), d.receivable, 'warn')}${kpi(tr('محتجزات لدى العملاء', 'Retention held by clients'), d.retention_held)}
   ${kpi(tr('مستحقات للموردين', 'Payables'), d.payable, 'bad')}</div>
  <div class="card"><h2>${tr('التدفق النقدي — آخر ٦ أشهر', 'Cash flow — last 6 months')} <span class="muted" style="font-weight:400">(<span class="pos">■</span> ${tr('مقبوضات', 'In')} <span class="neg">■</span> ${tr('مدفوعات', 'Out')})</span></h2>
   <div class="bars">${d.months.map(m => `<div class="m"><div class="pair"><div class="b in" style="height:${m.in / mx * 100}%" title="${money(m.in)}"></div><div class="b out" style="height:${m.out / mx * 100}%" title="${money(m.out)}"></div></div>${m.month}</div>`).join('')}</div></div>
  ${d.alerts.length ? `<div class="card"><h2>${tr('تنبيهات الامتثال', 'Compliance alerts')} <a href="#compliance" style="font-size:12px">${tr('عرض الكل', 'view all')}</a></h2>${alertList(d.alerts.slice(0, 5))}</div>` : ''}
  ${d.overdue.length ? `<div class="card"><h2 class="neg">${tr('فواتير متأخرة', 'Overdue invoices')}</h2><div class="tw"><table><tbody>${d.overdue.map(i => `<tr class="click" onclick="go('invoices')"><td>${esc(i.number)}</td><td>${esc(i.client_name || '')}</td><td>${esc(i.due_date)}</td><td class="n neg">${money(i.balance)}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
  <h2>${tr('ربحية المشاريع', 'Project profitability')}</h2>${projTable(d.projects)}`);
};
const projTable = rows => `<div class="tw"><table><thead><tr><th>${tr('المشروع', 'Project')}</th><th class="n">${tr('قيمة العقد', 'Contract')}</th><th class="n">${tr('المفوتر', 'Invoiced')}</th><th class="n">${tr('التكلفة', 'Cost')}</th><th class="n">${tr('الربح', 'Profit')}</th><th class="n">%</th><th class="n">${tr('مستحق التحصيل', 'Receivable')}</th></tr></thead><tbody>
  ${rows.map(p => `<tr class="click" onclick="go('projects/${p.id}')"><td>${esc(p.code || '')} ${esc(p.name)}</td><td class="n">${money(p.contract_value)}</td><td class="n">${money(p.invoiced)}</td><td class="n">${money(p.cost)}</td><td class="n ${p.profit >= 0 ? 'pos' : 'neg'}">${money(p.profit)}</td><td class="n">${p.margin}%</td><td class="n">${money(p.receivable)}</td></tr>`).join('') || `<tr><td colspan="7" class="muted">${tr('لا توجد مشاريع', 'No projects yet')}</td></tr>`}</tbody></table></div>`;

const partyFields = async () => [
  { k: 'type', ar: 'النوع', en: 'Type', type: 'select', options: Object.entries(PTYPE).map(([k, v]) => [k, tr(...v)]) },
  { k: 'name', ar: 'الاسم', en: 'Name', req: 1 }, { k: 'trn', ar: 'الرقم الضريبي (TRN)', en: 'Tax registration no. (TRN)' },
  { k: 'phone', ar: 'الهاتف', en: 'Phone' }, { k: 'email', ar: 'البريد', en: 'Email', type: 'email' }, { k: 'address', ar: 'العنوان (مطلوب في الفاتورة الضريبية)', en: 'Address (required on tax invoices)' },
  { k: 'bank_name', ar: 'اسم البنك', en: 'Bank name' }, { k: 'iban', ar: 'رقم الآيبان IBAN', en: 'IBAN' },
  { k: 'notes', ar: 'ملاحظات', en: 'Notes', type: 'textarea', full: 1 }];
PAGES.parties = () => crud({ title: tr('العملاء والموردون', 'Clients & suppliers'), table: 'parties', fields: partyFields, extra: xl('parties'), onModal: (m, row) => row && window.docsPanel && docsPanel(m, 'party', row.id, ['admin', 'accountant', 'manager'].includes(ME.role)),
  cols: [{ ar: 'الاسم', en: 'Name', k: 'name' }, { ar: 'النوع', en: 'Type', f: r => tr(...PTYPE[r.type] || ['', '']) }, { ar: 'TRN', en: 'TRN', k: 'trn' }, { ar: 'الهاتف', en: 'Phone', k: 'phone' }, { ar: 'البريد', en: 'Email', k: 'email' }] });

const partyOpts = async types => refOpts((await api('GET', 'parties')).filter(p => !types || types.includes(p.type)), p => p.name);

PAGES.projects = async id => {
  if (id) return projectDetail(+id);
  const rows = await api('GET', 'project-summary');
  const c = await crud({ title: tr('المشاريع', 'Projects'), table: 'projects', load: async () => rows, extra: xl('projects'),
    fields: async () => [
      { k: 'code', ar: 'رمز المشروع', en: 'Code', def: '' }, { k: 'name', ar: 'اسم المشروع', en: 'Project name', req: 1 },
      { k: 'client_id', ar: 'العميل', en: 'Client', type: 'select', options: await partyOpts(['client']) }, { k: 'location', ar: 'الموقع', en: 'Location' },
      { k: 'emirate', ar: 'الإمارة (لإقرار الضريبة)', en: 'Emirate (for VAT return)', type: 'select', options: Object.entries(EMIRATES).map(([k, v]) => [k, tr(...v)]) },
      { k: 'contract_value', ar: 'قيمة العقد (بدون ضريبة)', en: 'Contract value (ex VAT)', type: 'number', def: 0 }, { k: 'retention_pct', ar: 'نسبة المحتجزات % (للفواتير)', en: 'Retention % (on invoices)', type: 'number', def: 0 },
      { k: 'status', ar: 'الحالة', en: 'Status', type: 'select', options: ['active', 'completed', 'hold', 'cancelled'].map(k => [k, tr(...STATUS[k])]) },
      { k: 'start_date', ar: 'تاريخ البدء', en: 'Start date', type: 'date' }, { k: 'end_date', ar: 'تاريخ الانتهاء', en: 'End date', type: 'date' },
      { k: 'notes', ar: 'ملاحظات', en: 'Notes', type: 'textarea', full: 1 }],
    cols: [{ ar: 'الرمز', en: 'Code', k: 'code' }, { ar: 'المشروع', en: 'Project', k: 'name' }, { ar: 'الحالة', en: 'Status', f: r => tag(r.status) },
      { ar: 'قيمة العقد', en: 'Contract', n: 1, f: r => money(r.contract_value) }, { ar: 'المفوتر', en: 'Invoiced', n: 1, f: r => money(r.invoiced) },
      { ar: 'التكلفة', en: 'Cost', n: 1, f: r => money(r.cost) }, { ar: 'الربح', en: 'Profit', n: 1, f: r => `<span class="${r.profit >= 0 ? 'pos' : 'neg'}">${money(r.profit)}</span>` }] });
  c.setRow(id => go('projects/' + id));
};
async function projectDetail(id) {
  const [rows, inv, bills, boq, vars] = await Promise.all([api('GET', 'project-summary'), api('GET', 'invoices'), api('GET', 'bills'), api('GET', 'boq_items?project_id=' + id), api('GET', 'variations?project_id=' + id)]);
  const p = rows.find(r => r.id === id); if (!p) return go('projects');
  const mine = inv.filter(i => i.project_id === id), bl = bills.filter(b => b.project_id === id);
  const kpi = (l, v, c = '') => `<div class="kpi"><div class="l">${l}</div><div class="v ${c}">${money(v)}</div></div>`;
  main(`<div class="bar"><button class="btn sec" onclick="go('projects')">←</button><h1 style="margin:0">${esc(p.code || '')} ${esc(p.name)} ${tag(p.status)}</h1><span class="sp"></span>
    <button class="btn sec" onclick="progressInvoice(${id})">${tr('فاتورة إنجاز من الجدول', 'Progress invoice from BOQ')}</button><button class="btn sec" onclick="newInvoiceFor(${id})">+ ${tr('فاتورة', 'Invoice')}</button><button class="btn sec" onclick="newBillFor(${id})">+ ${tr('مصروف', 'Expense')}</button></div>
    <div class="grid">${kpi(tr('قيمة العقد', 'Contract value'), p.contract_value)}${kpi(tr('أوامر التغيير المعتمدة', 'Approved variations'), p.variations)}${kpi(tr('القيمة المعدّلة', 'Revised value'), p.revised_value)}${kpi(tr('المفوتر', 'Invoiced'), p.invoiced)}${kpi(tr('نسبة الفوترة', 'Billed %'), p.billed_pct).replace(money(p.billed_pct), p.billed_pct + '%')}
    ${kpi(tr('المحصّل', 'Collected'), p.collected, 'ok')}${kpi(tr('مستحق التحصيل', 'Receivable'), p.receivable, 'warn')}${kpi(tr('التكلفة', 'Cost'), p.cost)}
    ${kpi(tr('الربح', 'Profit'), p.profit, p.profit >= 0 ? 'ok' : 'bad')}${kpi(tr('هامش الربح', 'Margin'), p.margin).replace(money(p.margin), p.margin + '%')}</div>
    <div class="bar" style="margin-top:6px"><h2 style="margin:0">${tr('جدول الكميات (BOQ) ونسبة الإنجاز', 'Bill of quantities (BOQ) & progress')}</h2><span class="sp"></span><button class="btn sm" onclick="boqModal(${id})">+ ${tr('بند', 'Item')}</button></div>
    <div class="tw"><table><thead><tr><th>${tr('الوصف', 'Description')}</th><th>${tr('الوحدة', 'Unit')}</th><th class="n">${tr('الكمية', 'Qty')}</th><th class="n">${tr('السعر', 'Rate')}</th><th class="n">${tr('القيمة', 'Value')}</th><th class="n">${tr('تكلفة مقدّرة', 'Budget cost')}</th><th class="n">${tr('إنجاز %', 'Done %')}</th><th class="n">${tr('مفوتر %', 'Billed %')}</th></tr></thead><tbody>
    ${boq.map(i => `<tr class="click" onclick="boqModal(${id},${i.id})"><td>${esc(i.section ? i.section + ' — ' : '')}${esc(i.description)}</td><td>${esc(i.unit)}</td><td class="n">${money(i.qty)}</td><td class="n">${money(i.rate)}</td><td class="n">${money(i.qty * i.rate)}</td><td class="n">${money(i.qty * i.cost_rate)}</td><td class="n">${i.done_pct}%</td><td class="n">${i.billed_pct}%</td></tr>`).join('') || `<tr><td colspan="8" class="muted">${tr('لا توجد بنود — تُنسخ تلقائياً من عرض السعر عند التحويل لمشروع', 'No items — copied automatically from the quote when converted to a project')}</td></tr>`}</tbody>
    <tfoot><tr><td colspan="4"><b>${tr('الإجمالي', 'Total')}</b></td><td class="n"><b>${money(p.boq_value)}</b></td><td class="n"><b>${money(p.boq_budget_cost)}</b></td><td class="n"><b>${p.boq_progress}%</b></td><td></td></tr></tfoot></table></div>
    <p class="muted">${tr('الميزانية مقابل الفعلي', 'Budget vs actual')}: ${tr('التكلفة المقدّرة', 'budget cost')} ${money(p.boq_budget_cost)} — ${tr('التكلفة الفعلية', 'actual cost')} ${money(p.cost)} — <b class="${p.cost <= p.boq_budget_cost ? 'pos' : 'neg'}">${money(p.boq_budget_cost - p.cost)}</b></p>
    <div class="bar" style="margin-top:6px"><h2 style="margin:0">${tr('أوامر التغيير (Variations)', 'Variation orders')}</h2><span class="sp"></span><button class="btn sm" onclick="varModal(${id})">+ ${tr('أمر تغيير', 'Variation')}</button></div>
    <div class="tw"><table><tbody>${vars.map(v => `<tr class="click" onclick="varModal(${id},${v.id})"><td>${esc(v.number || '')}</td><td>${esc(v.date || '')}</td><td>${esc(v.description || '')}</td><td class="n">${money(v.amount)}</td><td>${tag(v.status)}</td></tr>`).join('') || `<tr><td class="muted">—</td></tr>`}</tbody></table></div>
    <div class="card" style="margin-top:16px"><h2>${tr('التكلفة حسب البند', 'Cost by category')}</h2><div class="tw"><table><tbody>${Object.entries(p.cost_by_category).map(([k, v]) => `<tr><td>${tr(...(CATS[k] || (k === 'payroll' ? ['رواتب', 'Payroll'] : [k, k])))}</td><td class="n">${money(v)}</td></tr>`).join('') || `<tr><td class="muted">—</td></tr>`}</tbody></table></div></div>
    <h2>${tr('الفواتير', 'Invoices')}</h2><div class="tw"><table><tbody>${mine.map(i => `<tr class="click" onclick="openInvoice(${i.id})"><td>${esc(i.number)}</td><td>${esc(i.date)}</td><td class="n">${money(i.total)}</td><td class="n">${money(i.balance)}</td><td>${tag(i.status)}</td></tr>`).join('') || `<tr><td class="muted">—</td></tr>`}</tbody></table></div>
    <div class="card" id="pdocs" style="margin-top:16px"></div>
    <h2 style="margin-top:16px">${tr('المصروفات', 'Expenses')}</h2><div class="tw"><table><tbody>${bl.map(b => `<tr class="click" onclick="openBill(${b.id})"><td>${esc(b.date)}</td><td>${esc(b.party_name || '')}</td><td>${esc(b.description || '')}</td><td>${tr(...(CATS[b.category] || [b.category, b.category]))}</td><td class="n">${money(b.amount)}</td></tr>`).join('') || `<tr><td class="muted">—</td></tr>`}</tbody></table></div>`);
  if (window.docsPanel) docsPanel($('#pdocs'), 'project', id, ['admin', 'accountant', 'manager'].includes(ME.role));
}

// ---- documents (quotes & invoices) ------------------------------------------
function itemsEditor(items) {
  const row = (i = {}) => `<tr><td><input data-k="description" value="${esc(i.description || '')}"></td><td style="width:70px"><input data-k="unit" value="${esc(i.unit || '')}"></td>
    <td style="width:90px"><input data-k="qty" type="number" step="any" value="${i.qty ?? 1}"></td><td style="width:110px"><input data-k="rate" type="number" step="any" value="${i.rate ?? 0}"></td>
    <td style="width:105px"><select data-k="vat">${Object.entries(VATC).map(([k, v]) => `<option value="${k}" ${(i.vat || 'std') === k ? 'selected' : ''}>${tr(...v)}</option>`).join('')}</select></td><td class="n" style="width:110px" data-amt></td><td style="width:30px"><button type="button" class="x">×</button></td></tr>`;
  return { html: `<div class="tw items"><table><thead><tr><th>${tr('الوصف', 'Description')}</th><th>${tr('الوحدة', 'Unit')}</th><th>${tr('الكمية', 'Qty')}</th><th>${tr('السعر', 'Rate')}</th><th>${tr('الضريبة', 'VAT')}</th><th class="n">${tr('المبلغ', 'Amount')}</th><th></th></tr></thead><tbody id="items">${(items.length ? items : [{}]).map(row).join('')}</tbody></table></div>
    <button type="button" class="btn sec sm" id="addrow" style="margin-top:6px">+ ${tr('بند', 'Line')}</button>`, row };
}
function bindDoc(m, rowFn, vatEl, retEl) {
  const calc = () => {
    let sub = 0; m.querySelectorAll('#items tr').forEach(tr_ => {
      const a = (+$('[data-k=qty]', tr_).value || 0) * (+$('[data-k=rate]', tr_).value || 0); sub += a; $('[data-amt]', tr_).textContent = money(a);
    });
    let std = 0; m.querySelectorAll('#items tr').forEach(tr_ => { if ($('[data-k=vat]', tr_).value === 'std') std += (+$('[data-k=qty]', tr_).value || 0) * (+$('[data-k=rate]', tr_).value || 0); });
    const vat = std * (+val(m, 'vat_pct') || 0) / 100, ret = retEl ? sub * (+val(m, 'retention_pct') || 0) / 100 : 0;
    $('#tot', m).innerHTML = `<div><span>${tr('الإجمالي قبل الضريبة', 'Subtotal')}</span><span>${money(sub)}</span></div><div><span>${tr('ضريبة القيمة المضافة', 'VAT')}</span><span>${money(vat)}</span></div>
      <div class="t"><span>${tr('الإجمالي', 'Total')}</span><span>${money(sub + vat)}</span></div>${retEl ? `<div class="muted"><span>${tr('محتجزات', 'Retention')}</span><span>${money(ret)}</span></div>` : ''}`;
  };
  m.addEventListener('input', calc);
  m.addEventListener('click', e => { if (e.target.classList.contains('x')) { e.target.closest('tr').remove(); calc(); } });
  $('#addrow', m).onclick = () => { $('#items', m).insertAdjacentHTML('beforeend', rowFn()); calc(); };
  calc();
}
const readItems = m => [...m.querySelectorAll('#items tr')].map(r => ({ description: $('[data-k=description]', r).value, unit: $('[data-k=unit]', r).value, qty: +$('[data-k=qty]', r).value || 0, rate: +$('[data-k=rate]', r).value || 0, vat: $('[data-k=vat]', r).value })).filter(i => i.description || i.rate);

async function docModal(kind, row, preset = {}) {
  const isQ = kind === 'quotes', e = itemsEditor(row?.items || []);
  const parties = await api('GET', 'parties'), projects = isQ ? [] : await api('GET', 'projects');
  const r = row || { date: today(), vat_pct: S.vat_pct || 5, retention_pct: 0, validity_days: 30, status: 'draft', terms: S.terms, ...preset };
  const head = isQ ? [
    { k: 'number', ar: 'رقم العرض', en: 'Quote no.', def: '' }, { k: 'date', ar: 'التاريخ', en: 'Date', type: 'date' },
    { k: 'client_id', ar: 'العميل', en: 'Client', type: 'select', options: refOpts(parties.filter(p => p.type === 'client'), p => p.name) },
    { k: 'project_name', ar: 'اسم المشروع', en: 'Project name' }, { k: 'validity_days', ar: 'صلاحية العرض (يوم)', en: 'Validity (days)', type: 'number' },
    { k: 'status', ar: 'الحالة', en: 'Status', type: 'select', options: ['draft', 'sent', 'accepted', 'rejected'].map(k => [k, tr(...STATUS[k])]) }, { k: 'vat_pct', ar: 'نسبة الضريبة %', en: 'VAT %', type: 'number' }
  ] : [
    { k: 'number', ar: 'رقم الفاتورة', en: 'Invoice no.' }, { k: 'date', ar: 'التاريخ', en: 'Date', type: 'date' },
    { k: 'project_id', ar: 'المشروع', en: 'Project', type: 'select', options: refOpts(projects, p => `${p.code || ''} ${p.name}`, false) },
    { k: 'due_date', ar: 'تاريخ الاستحقاق', en: 'Due date', type: 'date' }, { k: 'vat_pct', ar: 'نسبة الضريبة %', en: 'VAT %', type: 'number' }, { k: 'retention_pct', ar: 'نسبة المحتجزات %', en: 'Retention %', type: 'number' }];
  const isCN = r.kind === 'credit_note', dead = !!r.voided, W = {
    customer_trn_missing: tr('العميل بدون رقم ضريبي (TRN) — مطلوب في الفاتورة الضريبية للشركات', 'Client has no TRN — required on tax invoices to VAT-registered businesses'),
    customer_address_missing: tr('عنوان العميل غير مسجّل — مطلوب في الفاتورة الضريبية', 'Client address missing — required on tax invoices') };
  const m = modal(`<h2>${isQ ? tr('عرض سعر', 'Quotation') : isCN ? tr('إشعار دائن', 'Credit note') : tr('فاتورة ضريبية', 'Tax invoice')} ${esc(r.number || '')} ${dead ? tag('void') : ''}</h2>
    ${dead ? `<p class="err">${tr('ملغاة', 'Voided')}: ${esc(r.void_reason || '')}</p>` : ''}${(r.warnings || []).map(w => `<p class="err" style="color:var(--warn)">⚠ ${W[w] || w}</p>`).join('')}<div class="f2">${head.map(f => field(f, r[f.k])).join('')}</div>
    ${e.html}<div class="totals" id="tot"></div>
    <div class="f2" style="margin-top:10px">${field({ k: 'notes', ar: 'ملاحظات', en: 'Notes', type: 'textarea' }, r.notes)}${isQ ? field({ k: 'terms', ar: 'الشروط', en: 'Terms', type: 'textarea' }, r.terms) : ''}</div>
    <div class="acts">${dead ? '' : `<button class="btn" id="save">${tr('حفظ', 'Save')}</button>`}
    ${row && !dead ? `<button class="btn sec" id="print">${tr('طباعة', 'Print')}</button><button class="btn sec" id="pdf">PDF</button>` : ''}
    ${row && !dead ? `<button class="btn sec" id="mail">${tr('إرسال بالإيميل', 'Email')}</button>` : ''}${row && !isQ && !isCN && !dead && row.balance > 0 && row.status === 'overdue' ? `<button class="btn sec" id="remind">${tr('تذكير بالسداد', 'Payment reminder')}</button>` : ''}
    ${row && !isQ && !isCN && !dead ? `<button class="btn sec" id="pay">${tr('تسجيل دفعة', 'Record payment')}</button><button class="btn sec" id="cn">${tr('إصدار إشعار دائن', 'Issue credit note')}</button>` : ''}
    ${row && isQ && !row.project_id ? `<button class="btn sec" id="conv">${tr('تحويل إلى مشروع', 'Convert to project')}</button>` : ''}
    <button class="btn sec" id="cancel">${tr('إغلاق', 'Close')}</button><span class="sp"></span>${row && isQ ? `<button class="btn bad" id="del">${tr('حذف', 'Delete')}</button>` : ''}${row && !isQ && !dead ? `<button class="btn bad" id="void">${tr('إلغاء الفاتورة', 'Void')}</button>` : ''}</div>`, true);
  if (dead) m.querySelectorAll('input,select,textarea').forEach(x => x.disabled = true);
  bindDoc(m, e.row, 1, !isQ);
  $('#cancel', m).onclick = closeModal;
  $('#save', m).onclick = guard(async () => {
    const body = { items: readItems(m) }; head.forEach(f => body[f.k] = val(m, f.k)); body.notes = val(m, 'notes'); if (isQ) body.terms = val(m, 'terms');
    if (!isQ && !body.project_id) throw new Error(tr('اختر المشروع', 'Select a project'));
    if (!row) body.number = body.number || undefined;
    row ? await api('PUT', `${kind}/${row.id}`, body) : await api('POST', kind, body);
    closeModal(); render();
  });
  if (row) {
    if ($('#print', m)) { $('#print', m).onclick = () => printDoc(kind, row); $('#pdf', m).onclick = () => pdfDoc(kind, row); }
    if (isQ) $('#del', m).onclick = guard(async () => { if (confirmDel()) { await api('DELETE', `${kind}/${row.id}`); closeModal(); render(); } });
    const sendMailTo = (reminder) => guard(async () => {
      const to = prompt(tr('أرسل إلى البريد:', 'Send to email:'), row.client_email || ''); if (!to) return;
      await api('POST', `${kind}/${row.id}/email`, { to, reminder }); toast(tr('تم الإرسال', 'Email sent'));
    });
    if ($('#mail', m)) $('#mail', m).onclick = sendMailTo(false);
    if ($('#remind', m)) $('#remind', m).onclick = sendMailTo(true);
    if ($('#void', m)) $('#void', m).onclick = guard(async () => {
      const reason = prompt(tr('سبب الإلغاء (إلزامي — لا يمكن حذف الفاتورة الضريبية):', 'Reason for voiding (required — tax invoices cannot be deleted):'));
      if (reason) { await api('POST', `invoices/${row.id}/void`, { reason }); closeModal(); render(); }
    });
    if ($('#cn', m)) $('#cn', m).onclick = guard(async () => {
      const reason = prompt(tr('سبب الإشعار الدائن:', 'Reason for credit note:'));
      if (reason === null) return;
      const r2 = await api('POST', `invoices/${row.id}/credit-note`, { reason }); closeModal(); docModal('invoices', await api('GET', 'invoices/' + r2.id));
    });
    if ($('#pay', m)) $('#pay', m).onclick = () => paymentModal({ kind: 'in', invoice_id: row.id, amount: row.balance });
    if ($('#conv', m)) $('#conv', m).onclick = guard(async () => { const r2 = await api('POST', `quotes/${row.id}/convert`); closeModal(); go('projects/' + r2.project_id); });
  }
}
window.openInvoice = guard(async id => docModal('invoices', await api('GET', 'invoices/' + id)));
window.newInvoiceFor = guard(async pid => docModal('invoices', null, { project_id: pid }));

async function docPage(kind) {
  const isQ = kind === 'quotes', rows = await api('GET', kind);
  main(`<div class="bar"><h1>${isQ ? tr('عروض الأسعار', 'Quotations') : tr('فواتير العملاء', 'Sales invoices')}</h1><span class="sp"></span>${isQ ? '' : xl('invoices')}<button class="btn" id="add">+ ${tr('جديد', 'New')}</button></div>
  <div class="tw"><table><thead><tr><th>${tr('الرقم', 'No.')}</th><th>${tr('التاريخ', 'Date')}</th><th>${tr('العميل', 'Client')}</th><th>${isQ ? tr('المشروع', 'Project') : tr('المشروع', 'Project')}</th>
   <th class="n">${tr('الإجمالي', 'Total')}</th>${isQ ? '' : `<th class="n">${tr('الرصيد', 'Balance')}</th>`}<th>${tr('الحالة', 'Status')}</th></tr></thead><tbody>
   ${rows.map(r => `<tr class="click" data-id="${r.id}"><td>${esc(r.number)}</td><td>${esc(r.date)}</td><td>${esc(r.client_name || '')}</td><td>${esc((isQ ? r.project_name : r.project_name) || '')}</td><td class="n">${money(r.total)}</td>${isQ ? '' : `<td class="n">${money(r.balance + r.retention_open)}</td>`}<td>${tag(r.status)}</td></tr>`).join('') || `<tr><td colspan="7" class="muted">${tr('لا توجد بيانات', 'No records yet')}</td></tr>`}</tbody></table></div>`);
  $('#add').onclick = guard(() => docModal(kind, null));
  document.querySelectorAll('tr.click').forEach(t => t.onclick = guard(() => docModal(kind, rows.find(r => r.id === +t.dataset.id))));
}
PAGES.quotes = () => docPage('quotes');
PAGES.invoices = () => docPage('invoices');

const printDoc = (kind, r) => window.open(`/api/doc/${kind}/${r.id}?print=1`, '_blank');
const pdfDoc = (kind, r) => window.open(`/api/doc/${kind}/${r.id}/pdf`, '_blank');

// ---- bills / payments -------------------------------------------------------
const billFields = async (pre = {}) => [
  { k: 'date', ar: 'التاريخ', en: 'Date', type: 'date', def: today() }, { k: 'party_id', ar: 'المورد', en: 'Supplier', type: 'select', options: await partyOpts(['supplier', 'subcontractor']) },
  { k: 'project_id', ar: 'المشروع', en: 'Project', type: 'select', def: pre.project_id, options: refOpts(await api('GET', 'projects'), p => `${p.code || ''} ${p.name}`) },
  { k: 'category', ar: 'البند', en: 'Category', type: 'select', options: Object.entries(CATS).map(([k, v]) => [k, tr(...v)]) },
  { k: 'description', ar: 'الوصف', en: 'Description', full: 1 }, { k: 'amount', ar: 'المبلغ (بدون ضريبة)', en: 'Amount (ex VAT)', type: 'number', def: 0 },
  { k: 'vat_amount', ar: 'ضريبة القيمة المضافة (إن وجدت)', en: 'VAT amount (if any)', type: 'number', def: 0 }, { k: 'reference', ar: 'رقم فاتورة المورد', en: 'Supplier invoice no.' }];
async function billModal(row, pre) {
  const fs = await billFields(pre || {});
  const m = modal(`<h2>${row ? tr('تعديل مصروف', 'Edit expense') : tr('مصروف / مشتريات جديدة', 'New expense / purchase')}</h2><div class="f2">${fs.map(f => field(f, row?.[f.k] ?? f.def)).join('')}</div>
    <div class="acts"><button class="btn" id="save">${tr('حفظ', 'Save')}</button>${row ? `<button class="btn sec" id="pay">${tr('تسجيل دفعة', 'Record payment')}</button>` : ''}<button class="btn sec" id="cancel">${tr('إلغاء', 'Cancel')}</button><span class="sp"></span>${row ? `<button class="btn bad" id="del">${tr('حذف', 'Delete')}</button>` : ''}</div>`);
  $('#cancel', m).onclick = closeModal;
  $('#save', m).onclick = guard(async () => {
    const b = {}; fs.forEach(f => b[f.k] = val(m, f.k));
    row ? await api('PUT', 'bills/' + row.id, b) : await api('POST', 'bills', b); closeModal(); render();
  });
  if (row) {
    $('#pay', m).onclick = () => paymentModal({ kind: 'out', bill_id: row.id, amount: row.balance });
    $('#del', m).onclick = guard(async () => { if (confirmDel()) { await api('DELETE', 'bills/' + row.id); closeModal(); render(); } });
  }
}
window.openBill = guard(async id => billModal(await api('GET', 'bills/' + id)));
window.newBillFor = pid => guard(billModal)(null, { project_id: pid });
PAGES.bills = async () => {
  const rows = await api('GET', 'bills');
  main(`<div class="bar"><h1>${tr('المصروفات والمشتريات', 'Expenses & purchases')}</h1><span class="sp"></span>${xl('bills')}<button class="btn" id="add">+ ${tr('جديد', 'New')}</button></div>
  <div class="tw"><table><thead><tr><th>${tr('التاريخ', 'Date')}</th><th>${tr('المورد', 'Supplier')}</th><th>${tr('المشروع', 'Project')}</th><th>${tr('البند', 'Category')}</th><th>${tr('الوصف', 'Description')}</th><th class="n">${tr('الإجمالي', 'Total')}</th><th class="n">${tr('المتبقي', 'Balance')}</th><th>${tr('الحالة', 'Status')}</th></tr></thead><tbody>
  ${rows.map(b => `<tr class="click" data-id="${b.id}"><td>${esc(b.date)}</td><td>${esc(b.party_name || '')}</td><td>${esc(b.project_name || tr('مصاريف عامة', 'Overhead'))}</td><td>${tr(...(CATS[b.category] || [b.category, b.category]))}</td><td>${esc(b.description || '')}</td><td class="n">${money(b.total)}</td><td class="n">${money(b.balance)}</td><td>${tag(b.status)}</td></tr>`).join('') || `<tr><td colspan="8" class="muted">${tr('لا توجد بيانات', 'No records yet')}</td></tr>`}</tbody></table></div>`);
  $('#add').onclick = guard(() => billModal(null));
  document.querySelectorAll('tr.click').forEach(t => t.onclick = guard(() => billModal(rows.find(r => r.id === +t.dataset.id))));
};

async function paymentModal(pre = {}) {
  const [invs, bills] = await Promise.all([api('GET', 'invoices'), api('GET', 'bills')]);
  const kind = pre.kind || 'in';
  const m = modal(`<h2>${tr('تسجيل دفعة', 'Record payment')}</h2><div class="f2">
    <div class="f"><label>${tr('النوع', 'Type')}</label><select name="kind"><option value="in" ${kind === 'in' ? 'selected' : ''}>${tr('مقبوضات من عميل', 'Receipt from client')}</option><option value="out" ${kind === 'out' ? 'selected' : ''}>${tr('دفعة لمورد', 'Payment to supplier')}</option></select></div>
    <div class="f"><label>${tr('مرتبطة بـ', 'Against')}</label><select name="ref"></select></div>
    ${field({ k: 'date', ar: 'التاريخ', en: 'Date', type: 'date' }, today())}${field({ k: 'amount', ar: 'المبلغ', en: 'Amount', type: 'number', req: 1 }, pre.amount || '')}
    <div class="f"><label>${tr('طريقة الدفع', 'Method')}</label><select name="method">${opts(METHODS)}</select></div>
    <div class="f ck"><label>${tr('تاريخ استحقاق الشيك', 'Cheque date')}</label><input type="date" name="cheque_date"></div><div class="f ck"><label>${tr('حالة الشيك', 'Cheque status')}</label><select name="cheque_status"><option value="pending">${tr(...STATUS.pending)}</option><option value="cleared">${tr(...STATUS.cleared)}</option><option value="bounced">${tr(...STATUS.bounced)}</option></select></div>${field({ k: 'reference', ar: 'المرجع / رقم الشيك', en: 'Reference / cheque no.' }, '')}
    <div class="f full" id="retbox"><label><input type="checkbox" name="is_retention" style="width:auto"> ${tr('هذه دفعة تحرير محتجزات', 'This is a retention release')}</label></div></div>
    <div class="acts"><button class="btn" id="save">${tr('حفظ', 'Save')}</button><button class="btn sec" id="cancel">${tr('إلغاء', 'Cancel')}</button></div>`);
  const fill = () => {
    const k = val(m, 'kind'), sel = $('[name=ref]', m);
    const list = k === 'in' ? invs.filter(i => i.balance > 0.005 || i.retention_open > 0.005) : bills.filter(b => b.balance > 0.005);
    sel.innerHTML = list.map(x => `<option value="${x.id}" ${(pre.invoice_id === x.id || pre.bill_id === x.id) ? 'selected' : ''}>${k === 'in' ? `${esc(x.number)} — ${esc(x.client_name || '')} — ${money(x.balance)}` : `${esc(x.date)} — ${esc(x.party_name || '')} ${esc(x.description || '')} — ${money(x.balance)}`}</option>`).join('');
    $('#retbox', m).style.display = k === 'in' ? '' : 'none';
  };
  $('[name=kind]', m).onchange = fill; fill();
  const ck = () => m.querySelectorAll('.ck').forEach(x => x.style.display = val(m, 'method') === 'cheque' ? '' : 'none'); $('[name=method]', m).onchange = ck; ck();
  $('#cancel', m).onclick = closeModal;
  $('#save', m).onclick = guard(async () => {
    const k = val(m, 'kind'), ref = +val(m, 'ref');
    if (!ref) throw new Error(tr('اختر الفاتورة', 'Select a document'));
    if (!(+val(m, 'amount') > 0)) throw new Error(tr('أدخل المبلغ', 'Enter an amount'));
    await api('POST', 'payments', { kind: k, date: val(m, 'date'), amount: val(m, 'amount'), method: val(m, 'method'), reference: val(m, 'reference'),
      invoice_id: k === 'in' ? ref : null, bill_id: k === 'out' ? ref : null, is_retention: k === 'in' && $('[name=is_retention]', m).checked ? 1 : 0,
      ...(val(m, 'method') === 'cheque' ? { cheque_date: val(m, 'cheque_date'), cheque_status: val(m, 'cheque_status') } : { cheque_status: 'cleared' }) });
    closeModal(); render();
  });
}
PAGES.payments = async () => {
  const rows = await api('GET', 'payments');
  main(`<div class="bar"><h1>${tr('المدفوعات والمقبوضات', 'Payments & receipts')}</h1><span class="sp"></span>${xl('payments')}<button class="btn" id="add">+ ${tr('تسجيل دفعة', 'Record payment')}</button></div>
  <div class="tw"><table><thead><tr><th>${tr('التاريخ', 'Date')}</th><th>${tr('النوع', 'Type')}</th><th>${tr('الطرف', 'Party')}</th><th>${tr('المرجع', 'Ref')}</th><th>${tr('الطريقة', 'Method')}</th><th class="n">${tr('المبلغ', 'Amount')}</th><th>${tr('الشيك', 'Cheque')}</th><th></th></tr></thead><tbody>
  ${rows.map(p => `<tr><td>${esc(p.date)}</td><td><span class="${p.kind === 'in' ? 'pos' : 'neg'}">${p.kind === 'in' ? tr('مقبوض', 'Receipt') : tr('مدفوع', 'Payment')}${p.is_retention ? ' (' + tr('محتجزات', 'retention') + ')' : ''}</span></td><td>${esc(p.party_name || '')}</td><td>${esc(p.ref_label || '')} ${esc(p.reference || '')}</td><td>${tr(...(METHODS[p.method] || [p.method, p.method]))}</td><td class="n">${money(p.amount)}</td><td>${p.method === 'cheque' ? `<select data-ck="${p.id}" style="width:auto">${['pending', 'cleared', 'bounced'].map(k => `<option value="${k}" ${p.cheque_status === k ? 'selected' : ''}>${tr(...STATUS[k])}</option>`).join('')}</select> ${esc(p.cheque_date || '')}` : ''}</td><td><button class="btn sec sm" data-del="${p.id}">×</button></td></tr>`).join('') || `<tr><td colspan="8" class="muted">${tr('لا توجد بيانات', 'No records yet')}</td></tr>`}</tbody></table></div><p class="muted">${tr('الشيكات قيد التحصيل أو المرتجعة لا تُحتسب في الرصيد النقدي؛ الشيك المرتجع لا يسدّد الفاتورة.', 'Pending or bounced cheques are excluded from the cash balance; a bounced cheque does not settle the invoice.')}</p>`);
  document.querySelectorAll('[data-ck]').forEach(x => x.onchange = guard(async () => { await api('PUT', 'payments/' + x.dataset.ck, { cheque_status: x.value }); render(); }));
  $('#add').onclick = guard(() => paymentModal());
  document.querySelectorAll('[data-del]').forEach(b => b.onclick = guard(async () => { if (confirmDel()) { await api('DELETE', 'payments/' + b.dataset.del); render(); } }));
};

// ---- VAT --------------------------------------------------------------------
PAGES.vat = async () => {
  const now = new Date(), q = Math.floor(now.getMonth() / 3);
  const from = new Date(Date.UTC(now.getFullYear(), q * 3, 1)).toISOString().slice(0, 10), to = new Date(Date.UTC(now.getFullYear(), q * 3 + 3, 0)).toISOString().slice(0, 10);
  main(`<h1>${tr('تقرير ضريبة القيمة المضافة (نموذج إقرار VAT 201)', 'VAT report (VAT 201 working)')}</h1><div class="bar"><div><label>${tr('من', 'From')}</label><input type="date" id="f" value="${from}"></div><div><label>${tr('إلى', 'To')}</label><input type="date" id="t" value="${to}"></div><button class="btn" id="go" style="margin-top:16px">${tr('عرض', 'Show')}</button><a class="btn sec sm noprint" id="vx" target="_blank" style="margin-top:16px">Excel</a></div><div id="out"></div>
  <p class="muted">${tr('هذا التقرير أرقام عمل تساعدك في تعبئة الإقرار في بوابة الهيئة الاتحادية للضرائب (EmaraTax) وهو ليس إقراراً رسمياً. يجب مراجعته مع محاسب قانوني. الإقرار يُقدَّم خلال ٢٨ يوماً من نهاية الفترة الضريبية. المحتجزات: تأكد من توقيت توريد الضريبة عليها مع مستشارك الضريبي.', 'Working figures to help you complete the return in the FTA EmaraTax portal — not an official return; review with a qualified accountant. Returns are due within 28 days after the tax period ends. Retention: confirm the time-of-supply treatment with your tax adviser.')}</p>`);
  const run = guard(async () => {
    $('#vx').href = `/api/export/vat?from=${$('#f').value}&to=${$('#t').value}`;
    const r = await api('GET', `vat?from=${$('#f').value}&to=${$('#t').value}`);
    const k = (l, v, c = '') => `<div class="kpi"><div class="l">${l}</div><div class="v ${c}">${money(v)}</div></div>`;
    $('#out').innerHTML = `<div class="grid">${k(tr('مبيعات خاضعة للنسبة الأساسية', 'Standard-rated sales'), r.standard_sales)}${k(tr('مبيعات صفرية', 'Zero-rated sales'), r.zero_rated_sales)}${k(tr('مبيعات معفاة', 'Exempt sales'), r.exempt_sales)}${k(tr('ضريبة المخرجات', 'Output VAT'), r.output_vat)}
      ${k(tr('المشتريات (بدون ضريبة)', 'Purchases (ex VAT)'), r.purchases_total)}${k(tr('ضريبة المدخلات القابلة للاسترداد', 'Recoverable input VAT'), r.input_vat)}
      ${k(r.net_vat >= 0 ? tr('صافي الضريبة المستحقة للهيئة', 'Net VAT payable to FTA') : tr('صافي الضريبة المستردة', 'Net VAT refundable'), Math.abs(r.net_vat), r.net_vat >= 0 ? 'bad' : 'ok')}</div>
      <h2>${tr('المبيعات الخاضعة للضريبة حسب الإمارة (البند ١)', 'Standard-rated sales by emirate (Box 1)')}</h2><div class="tw"><table><thead><tr><th>${tr('الإمارة', 'Emirate')}</th><th class="n">${tr('المبلغ', 'Amount')}</th><th class="n">${tr('الضريبة', 'VAT')}</th></tr></thead><tbody>${Object.entries(r.by_emirate).map(([e, v]) => `<tr><td>${tr(...EMIRATES[e])}</td><td class="n">${money(v.amount)}</td><td class="n">${money(v.vat)}</td></tr>`).join('')}</tbody></table></div>
      ${r.warnings.length ? `<div class="card" style="margin-top:14px"><h2 class="neg">${tr('تنبيهات', 'Warnings')}</h2>${r.warnings.map(w => `<div>⚠ ${tr('ضريبة مدخلات بدون رقم ضريبي للمورد (قد لا تكون قابلة للاسترداد)', 'Input VAT without supplier TRN (may not be recoverable)')}: ${esc(w.label)}</div>`).join('')}</div>` : ''}`;
  });
  $('#go').onclick = run; run();
};

// ---- employees ----------------------------------------------------------------
PAGES.employees = async () => {
  const projects = await api('GET', 'projects');
  const rows = await api('GET', 'employees');
  const grat = {}; await Promise.all(rows.map(async e => grat[e.id] = (await api('GET', `employees/${e.id}/gratuity`)).amount));
  const c = await crud({ title: tr('الموظفون والعمال', 'Employees & labour'), table: 'employees', load: async () => rows, extra: xl('employees'), onModal: (m, row) => window.employeeExtras && employeeExtras(m, row),
    intro: `<p class="muted">${tr('أدخل بيانات كل موظف كما هي في عقد العمل وبطاقة العمل وحسابه البنكي — هذه البيانات مطلوبة لملف حماية الأجور (WPS). مكافأة نهاية الخدمة التقديرية حسب المرسوم بقانون اتحادي رقم ٣٣ لسنة ٢٠٢١.', 'Enter each employee exactly as on their contract, labour card and bank account — required for the WPS file. Estimated end-of-service gratuity per Federal Decree-Law 33/2021.')}</p>`,
    fields: async () => [
      { k: 'name', ar: 'الاسم (كما في جواز السفر)', en: 'Name (as per passport)', req: 1 }, { k: 'designation', ar: 'المهنة', en: 'Designation' },
      { k: 'person_code', ar: 'رقم بطاقة العمل / Person Code (١٤ رقم)', en: 'Labour card / Person code (14 digits)' }, { k: 'emirates_id', ar: 'رقم الهوية الإماراتية', en: 'Emirates ID' },
      { k: 'passport_no', ar: 'رقم الجواز', en: 'Passport no.' }, { k: 'nationality', ar: 'الجنسية', en: 'Nationality' },
      { k: 'join_date', ar: 'تاريخ الالتحاق', en: 'Join date', type: 'date' }, { k: 'end_date', ar: 'تاريخ انتهاء الخدمة', en: 'End of service date', type: 'date' },
      { k: 'status', ar: 'الحالة', en: 'Status', type: 'select', options: [['active', tr(...STATUS.active)], ['left', tr(...STATUS.left)]] },
      { k: 'project_id', ar: 'المشروع الافتراضي (لتحميل التكلفة)', en: 'Default project (cost allocation)', type: 'select', options: refOpts(projects, p => `${p.code || ''} ${p.name}`) },
      { k: 'basic', ar: 'الراتب الأساسي', en: 'Basic wage', type: 'number', def: 0 }, { k: 'housing', ar: 'بدل سكن', en: 'Housing allowance', type: 'number', def: 0 },
      { k: 'other_allowance', ar: 'بدلات أخرى', en: 'Other allowances', type: 'number', def: 0 }, { k: 'bank_name', ar: 'البنك / شركة الصرافة', en: 'Bank / exchange house' },
      { k: 'routing_code', ar: 'رمز التوجيه (٩ أرقام)', en: 'Routing code (9 digits)' }, { k: 'iban', ar: 'الآيبان IBAN', en: 'IBAN' },
      { k: 'eid_expiry', ar: 'انتهاء الهوية', en: 'Emirates ID expiry', type: 'date' }, { k: 'visa_expiry', ar: 'انتهاء الإقامة', en: 'Residence visa expiry', type: 'date' },
      { k: 'passport_expiry', ar: 'انتهاء الجواز', en: 'Passport expiry', type: 'date' }, { k: 'card_expiry', ar: 'انتهاء بطاقة العمل', en: 'Labour card expiry', type: 'date' },
      { k: 'phone', ar: 'الهاتف', en: 'Phone' }, { k: 'email', ar: 'البريد', en: 'Email' }, { k: 'emergency_contact', ar: 'جهة اتصال للطوارئ', en: 'Emergency contact' },
      { k: 'leave_opening', ar: 'رصيد إجازات افتتاحي (أيام)', en: 'Opening leave balance (days)', type: 'number', def: 0 },
      { k: 'notes', ar: 'ملاحظات', en: 'Notes', type: 'textarea', full: 1 }],
    cols: [{ ar: 'الاسم', en: 'Name', k: 'name' }, { ar: 'المهنة', en: 'Role', k: 'designation' }, { ar: 'الحالة', en: 'Status', f: r => tag(r.status) },
      { ar: 'الإجمالي الشهري', en: 'Monthly total', n: 1, f: r => money(r.basic + r.housing + r.other_allowance) }, { ar: 'نهاية الخدمة (تقديري)', en: 'Gratuity (est.)', n: 1, f: r => money(grat[r.id]) },
      { ar: 'IBAN', en: 'IBAN', f: r => r.iban ? esc(r.iban) : `<span class="neg">${tr('ناقص', 'missing')}</span>` }] });
};

// ---- payroll & WPS ----------------------------------------------------------------
PAGES.payroll = async () => {
  const month = sessionStorage.pm || new Date().toISOString().slice(0, 7);
  const [rows, issues] = await Promise.all([api('GET', `payroll?month=${month}`), api('GET', `payroll/check?month=${month}`)]);
  const final = rows.length && rows.every(r => r.status === 'final'), paid = final && rows.every(r => r.paid_date);
  const num = (r, k) => final ? money(r[k]) : `<input type="number" step="any" style="width:80px" data-id="${r.id}" data-k="${k}" value="${r[k]}">`;
  main(`<div class="bar"><h1>${tr('الرواتب ونظام حماية الأجور (WPS)', 'Payroll & WPS')}</h1><span class="sp"></span>${xl('payroll', '?month=' + month)}<input type="month" id="m" value="${month}" style="width:auto">
    ${final ? '' : `<button class="btn sec" id="gen">${tr('إنشاء كشف الشهر', 'Generate month')}</button>`}</div>
    <p class="muted">${tr('الراتب اليومي = الراتب الإجمالي ÷ ٣٠. الأوفرتايم: أجر الساعة (الأساسي ÷ ٣٠ ÷ ٨) + ٢٥٪ نهاراً، +٥٠٪ ليلاً (١٠م–٤ص) أو في الراحة/الإجازات الرسمية. يجب دفع الأجور عبر نظام حماية الأجور في موعدها؛ التأخير أكثر من ١٥ يوماً يُعرّض المنشأة لإيقاف التصاريح والغرامات.', 'Daily wage = total wage ÷ 30. Overtime: hourly rate (basic ÷ 30 ÷ 8) + 25% by day, +50% at night (10pm–4am) or on rest days/public holidays. Wages must be paid through WPS on time; delays beyond 15 days risk permit freezes and fines.')}</p>
    ${issues.length ? `<div class="card"><h2 class="neg">${tr('بيانات ناقصة / تنبيهات', 'Missing data / warnings')}</h2>${issues.map(i => `<div style="color:${i.warn ? 'var(--warn)' : 'var(--bad)'}">• <b>${esc(i.who)}</b>: ${esc(i.msg)}</div>`).join('')}</div>` : ''}
    <div class="tw"><table><thead><tr><th>${tr('الموظف', 'Employee')}</th><th class="n">${tr('أيام العمل', 'Days')}</th><th class="n">${tr('أيام إجازة', 'Leave days')}</th><th class="n">${tr('ساعات إضافية عادية', 'OT hrs (+25%)')}</th><th class="n">${tr('ساعات ليلية/راحة', 'OT hrs (+50%)')}</th><th class="n">${tr('مكافآت', 'Bonus')}</th><th class="n">${tr('خصومات', 'Deductions')}</th><th class="n">${tr('الثابت', 'Fixed')}</th><th class="n">${tr('الصافي', 'Net')}</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td>${esc(r.name)}</td><td class="n">${num(r, 'days_worked')}</td><td class="n">${num(r, 'leave_days')}</td><td class="n">${num(r, 'ot_normal_hours')}</td><td class="n">${num(r, 'ot_special_hours')}</td><td class="n">${num(r, 'bonus')}</td><td class="n">${num(r, 'deductions')}</td><td class="n">${money(r.fixed)}</td><td class="n"><b>${money(r.net)}</b></td></tr>`).join('') || `<tr><td colspan="9" class="muted">${tr('لا يوجد كشف لهذا الشهر — اضغط "إنشاء كشف الشهر"', 'No payroll for this month — click "Generate month"')}</td></tr>`}
    </tbody>${rows.length ? `<tfoot><tr><td colspan="8"><b>${tr('الإجمالي', 'Total')}</b></td><td class="n"><b>${money(rows.reduce((s, r) => s + r.net, 0))}</b></td></tr></tfoot>` : ''}</table></div>
    <div class="bar" style="margin-top:14px">${rows.length && !final ? `<button class="btn" id="fin">${tr('اعتماد الكشف', 'Finalize payroll')}</button>` : ''}
    ${final ? `<a class="btn" href="/api/payroll/sif?month=${month}" style="text-decoration:none">${tr('تحميل ملف SIF للبنك', 'Download WPS SIF file')}</a>` : ''}
    ${final && !paid ? `<button class="btn sec" id="paid">${tr('تم تحويل الرواتب', 'Mark salaries paid')}</button>` : ''}${paid ? `<span class="tag paid">${tr('مدفوع', 'Paid')} ${esc(rows[0].paid_date)}</span>` : ''}</div>
    <p class="muted">${tr('ملف SIF يُرفع عبر بوابة البنك أو شركة الصرافة المعتمدة لدى وزارة الموارد البشرية والتوطين. تختلف بعض تفاصيل الصيغة واسم الملف من بنك لآخر — اعرضه على البنك للتأكد قبل أول استخدام.', 'Upload the SIF file through your MOHRE-approved bank or exchange house. Small format/file-name details vary by bank — have your bank validate the first file.')}</p>`);
  $('#m').onchange = e => { sessionStorage.pm = e.target.value; render(); };
  if ($('#gen')) $('#gen').onclick = guard(async () => { const r = await api('POST', 'payroll/generate', { month }); toast(`${r.created} ${tr('سجل جديد', 'new rows')}`); render(); });
  document.querySelectorAll('input[data-id]').forEach(i => i.onchange = guard(async () => { await api('PUT', 'payroll/' + i.dataset.id, { [i.dataset.k]: i.value }); render(); }));
  if ($('#fin')) $('#fin').onclick = guard(async () => { if (confirm(tr('بعد الاعتماد لا يمكن تعديل الكشف. متابعة؟', 'Payroll cannot be edited after finalizing. Continue?'))) { await api('POST', 'payroll/finalize', { month }); render(); } });
  if ($('#paid')) $('#paid').onclick = guard(async () => { await api('POST', 'payroll/pay', { month, date: today() }); render(); });
};

// ---- corporate tax -------------------------------------------------------------------
PAGES.ctax = async () => {
  const y = sessionStorage.cy || new Date().getFullYear();
  const r = await api('GET', `corporate-tax?from=${y}-01-01&to=${y}-12-31`);
  const k = (l, v, c = '') => `<div class="kpi"><div class="l">${l}</div><div class="v ${c}">${money(v)}</div></div>`;
  main(`<div class="bar"><h1>${tr('ضريبة الشركات (تقدير)', 'Corporate tax (estimate)')}</h1><span class="sp"></span><input type="number" id="y" value="${y}" style="width:100px"></div>
  <div class="grid">${k(tr('الإيرادات (بدون ضريبة)', 'Revenue (ex VAT)'), r.revenue)}${k(tr('المصروفات (مشتريات)', 'Expenses (purchases)'), r.bills_cost)}${k(tr('تكلفة الرواتب', 'Payroll cost'), r.payroll_cost)}
   ${k(tr('الربح المحاسبي', 'Accounting profit'), r.profit, r.profit >= 0 ? 'ok' : 'bad')}${k(tr('الدخل الخاضع للضريبة (تقدير)', 'Taxable income (est.)'), r.taxable_income)}
   ${k(tr('ضريبة الشركات ٩٪ فوق ٣٧٥٬٠٠٠', 'Corporate tax 9% above AED 375,000'), r.tax, 'warn')}</div>
  ${r.sbr_possible ? `<div class="card"><b>${tr('إعفاء المنشآت الصغيرة (SBR)', 'Small Business Relief (SBR)')}</b>: ${tr('إيراداتك أقل من ٣ ملايين درهم — يمكنك اختيار الإعفاء (ضريبة = صفر) عن الفترات الضريبية المنتهية حتى ٣١ ديسمبر ٢٠٢٦ فقط، وهو اختياري ويتطلب تقديمه في الإقرار.', 'Revenue is under AED 3m — you may elect relief (tax = 0) for tax periods ending on or before 31 Dec 2026 only. It is elective and must be claimed in the return.')}</div>` : ''}
  <div class="card"><h2>${tr('ملاحظات مهمة', 'Important notes')}</h2><ul>
   <li>${tr('هذا تقدير مبسّط (أساس الاستحقاق من الفواتير والمصروفات المدخلة). لا يشمل التعديلات الضريبية: المصروفات غير القابلة للخصم (٥٠٪ ترفيه، الغرامات)، الخسائر المرحّلة، المنشآت المرتبطة، المناطق الحرة.', 'Simplified estimate (accrual basis from invoices and expenses entered). Excludes tax adjustments: non-deductible costs (50% entertainment, fines), carried-forward losses, related parties, free-zone rules.')}</li>
   <li>${tr('لا تدخل رواتب الموظفين مرتين: استخدم وحدة الرواتب، ولا تسجّلها أيضاً كمصروف "عمالة".', 'Do not count salaries twice: use the Payroll module and do not also enter them as "Labour" expenses.')}</li>
   <li>${tr('التسجيل لدى الهيئة الاتحادية للضرائب إلزامي لكل شركة (حتى لو كانت الضريبة صفراً)، والإقرار خلال ٩ أشهر من نهاية السنة المالية. الاحتفاظ بالسجلات ٧ سنوات.', 'Registration with the FTA is mandatory for every company (even if tax is nil); return due within 9 months of financial year-end. Keep records for 7 years.')}</li></ul></div>`);
  $('#y').onchange = e => { sessionStorage.cy = e.target.value; render(); };
};

// ---- compliance & audit ---------------------------------------------------------------
const ALERT = {
  company_trn: () => tr('أدخل الرقم الضريبي للشركة (TRN) في الإعدادات — مطلوب لإصدار الفواتير الضريبية', 'Enter your company TRN in Settings — required to issue tax invoices'),
  mohre_id: () => tr('أدخل رقم المنشأة لدى وزارة الموارد البشرية (١٣ رقم) في الإعدادات — مطلوب لملف WPS', 'Enter MOHRE establishment ID (13 digits) in Settings — required for WPS'),
  employer_routing: () => tr('أدخل رمز توجيه بنك الشركة (٩ أرقام) في الإعدادات', 'Enter employer bank routing code (9 digits) in Settings'),
  license_expired: a => `${tr('الرخصة التجارية منتهية', 'Trade licence expired')}: ${a.date}`, license_soon: a => `${tr('الرخصة التجارية تنتهي قريباً', 'Trade licence expires soon')}: ${a.date}`,
  doc_eid: a => `${tr('هوية إماراتية', 'Emirates ID')} — ${a.who}: ${a.date}`, doc_visa: a => `${tr('إقامة', 'Residence visa')} — ${a.who}: ${a.date}`,
  doc_file: a => `${tr('مستند منتهٍ/ينتهي', 'Document expiring')} — ${a.who}: ${a.date}`,
  doc_passport: a => `${tr('جواز سفر', 'Passport')} — ${a.who}: ${a.date}`, doc_card: a => `${tr('بطاقة عمل', 'Labour card')} — ${a.who}: ${a.date}`,
  wps_late: a => `${tr('رواتب شهر', 'Salaries for')} ${a.month} ${tr('لم تُدفع بعد ١٥ يوماً من نهاية الشهر — مخالفة محتملة لنظام حماية الأجور', 'unpaid more than 15 days after month-end — possible WPS violation')}`,
  bounced: a => `${a.count} ${tr('شيك مرتجع — تابع التحصيل', 'bounced cheque(s) — follow up')}`,
  customer_trn: a => `${tr('عملاء بدون رقم ضريبي', 'Clients missing TRN')}: ${a.who}`,
};
const alertList = al => al.map(a => `<div style="color:var(--${a.level === 'bad' ? 'bad' : 'warn'})">${a.level === 'bad' ? '⛔' : '⚠'} ${esc((ALERT[a.key] || (() => a.key))(a))}</div>`).join('');
PAGES.compliance = async () => {
  const [al, audit, ei] = await Promise.all([api('GET', 'compliance'), api('GET', 'audit').catch(() => []), api('GET', 'einvoice').catch(() => null)]);
  main(`<h1>${tr('الامتثال والتدقيق', 'Compliance & audit')}</h1>
  <div class="card"><h2>${tr('تنبيهات', 'Alerts')}</h2>${al.length ? alertList(al) : `<span class="pos">✔ ${tr('لا توجد تنبيهات', 'No alerts')}</span>`}</div>
  <div class="card"><h2>${tr('المواعيد الأساسية', 'Key deadlines')}</h2><ul>
   <li>${tr('إقرار ضريبة القيمة المضافة (VAT 201): خلال ٢٨ يوماً من نهاية الفترة (ربع سنوي غالباً) — عبر EmaraTax', 'VAT return (VAT 201): within 28 days of period end (usually quarterly) — via EmaraTax')}</li>
   <li>${tr('ضريبة الشركات: إقرار خلال ٩ أشهر من نهاية السنة المالية', 'Corporate tax return: within 9 months of financial year-end')}</li>
   <li>${tr('الرواتب: عبر WPS في موعدها المتفق عليه؛ تأخير ١٥ يوماً يستوجب مخالفة', 'Salaries: via WPS by the contractual due date; a 15-day delay triggers violations')}</li>
   <li>${tr('الاحتفاظ بالسجلات: ٥ سنوات للقيمة المضافة (١٥ سنة للعقارات)، ٧ سنوات لضريبة الشركات', 'Record retention: 5 years for VAT (15 for real estate), 7 years for corporate tax')}</li></ul></div>
  <div class="card"><h2>${tr('ما يطبّقه النظام', 'What the system enforces')}</h2><ul>
   <li>${tr('الفاتورة الضريبية: عنوان "فاتورة ضريبية"، TRN البائع والمشتري، ترقيم تسلسلي، ضريبة لكل بند، المبالغ بالدرهم. لا يمكن حذف الفواتير — فقط الإلغاء بسبب أو إشعار دائن.', 'Tax invoice: "Tax Invoice" title, supplier/customer TRN, sequential numbering, VAT per line, AED amounts. Invoices cannot be deleted — only voided with a reason or credited.')}</li>
   <li>${tr('التحقق من: TRN (١٥ رقم)، الهوية الإماراتية، رقم بطاقة العمل (١٤)، رمز التوجيه (٩)، IBAN (فحص المجموع MOD-97)، رقم المنشأة (١٣).', 'Validation of TRN (15), Emirates ID, person code (14), routing code (9), IBAN (MOD-97 checksum), establishment ID (13).')}</li>
   <li>${tr('سجل تدقيق لكل إنشاء/تعديل/حذف، واعتماد الرواتب يقفلها.', 'Audit log of every create/update/delete; finalizing payroll locks it.')}</li></ul>
   <p class="muted"><b>${tr('إخلاء مسؤولية', 'Disclaimer')}:</b> ${tr('النظام مبني ليتوافق مع الأنظمة المعمول بها وقت إعداده، لكنه ليس معتمداً رسمياً من الهيئة الاتحادية للضرائب أو وزارة الموارد البشرية أو المصرف المركزي. القوانين والنسب وصيغ ملفات البنوك تتغيّر؛ راجع محاسبك القانوني ومستشارك الضريبي وبنكك قبل تقديم أي إقرار أو رفع ملف رواتب. الفوترة الإلكترونية (E-Invoicing) الإلزامية قيد التطبيق تدريجياً في الإمارات وغير مدعومة بعد في هذا الإصدار.', 'Built to align with the rules in force when it was written, but it is not certified by the FTA, MOHRE or the Central Bank. Laws, rates and bank file formats change — confirm with your accountant, tax adviser and bank before filing a return or uploading a payroll file. UAE mandatory e-invoicing (Peppol) is being phased in and is not yet supported in this version.')}</p></div>
  ${ei ? `<div class="card"><h2>${tr('جاهزية الفوترة الإلكترونية (E-Invoicing)', 'E-invoicing readiness')}</h2><p class="muted">${tr('الفوترة الإلكترونية في الإمارات تتم عبر مزوّد خدمة معتمد (شبكة Peppol) ولا يرسل هذا النظام الفواتير إليها بعد. هذا الفحص يتأكد من اكتمال البيانات التي سيحتاجها المزوّد.', 'UAE e-invoicing is transmitted through an accredited service provider (Peppol network); this system does not transmit invoices yet. This check verifies the data a provider will need is complete.')}</p>
    <div>${ei.company_trn ? '✔' : '⛔'} ${tr('الرقم الضريبي للشركة', 'Company TRN')} · ${ei.invoices} ${tr('فاتورة', 'invoices')} · <b class="${ei.with_issues ? 'neg' : 'pos'}">${ei.with_issues}</b> ${tr('ببيانات ناقصة', 'with missing data')}</div>
    ${ei.issues.slice(0, 15).map(i => `<div class="muted">• ${esc(i.number)}: ${esc(i.missing.join(', '))}</div>`).join('')}</div>` : ''}
  <div class="card"><h2>${tr('سجل التدقيق (آخر ٣٠٠)', 'Audit log (latest 300)')}</h2><div class="tw"><table><thead><tr><th>${tr('الوقت', 'Time')}</th><th>${tr('المستخدم', 'User')}</th><th>${tr('الإجراء', 'Action')}</th><th>${tr('السجل', 'Record')}</th><th>${tr('تفاصيل', 'Detail')}</th></tr></thead><tbody>${audit.map(a => `<tr><td>${esc(a.ts.replace('T', ' ').slice(0, 19))}</td><td>${esc(a.user)}</td><td>${esc(a.action)}</td><td>${esc(a.tbl)} ${a.rec || ''}</td><td>${esc(a.detail)}</td></tr>`).join('')}</tbody></table></div></div>`);
};

// ---- settings ---------------------------------------------------------------
PAGES.settings = async () => {
  const s = await api('GET', 'settings'), admin = ME.role === 'admin';
  const F = [['company_name', 'اسم الشركة (إنجليزي)', 'Company name (English)'], ['company_name_ar', 'اسم الشركة (عربي)', 'Company name (Arabic)'], ['trn', 'الرقم الضريبي للقيمة المضافة (TRN) — ١٥ رقم', 'VAT TRN (15 digits)'], ['ct_trn', 'رقم تسجيل ضريبة الشركات', 'Corporate tax TRN'],
    ['phone', 'الهاتف', 'Phone'], ['email', 'البريد', 'Email'], ['website', 'الموقع الإلكتروني', 'Website'], ['po_box', 'ص.ب', 'P.O. Box'], ['address', 'العنوان', 'Address'],
    ['vat_pct', 'نسبة الضريبة الافتراضية %', 'Default VAT %'], ['currency', 'العملة', 'Currency'], ['license_no', 'رقم الرخصة التجارية', 'Trade licence no.'], ['license_expiry', 'انتهاء الرخصة', 'Licence expiry', 'date'],
    ['mohre_id', 'رقم المنشأة — وزارة الموارد البشرية (١٣ رقم)', 'MOHRE establishment ID (13 digits)'], ['employer_bank', 'بنك الشركة', 'Company bank'], ['employer_routing', 'رمز توجيه بنك الشركة (٩ أرقام)', 'Company bank routing code (9 digits)'], ['employer_iban', 'آيبان الشركة', 'Company IBAN'],
    ['footer_text', 'نص تذييل المستندات', 'Document footer text']];
  const E = [['smtp_host', 'خادم البريد (SMTP)', 'SMTP server'], ['smtp_port', 'المنفذ (587 أو 465)', 'Port (587 or 465)'], ['smtp_user', 'اسم مستخدم البريد', 'SMTP username'], ['smtp_pass', 'كلمة مرور البريد', 'SMTP password', 'password'], ['smtp_from', 'عنوان المرسِل (مثل accounts@شركتك.com)', 'From address (e.g. accounts@yourco.com)']];
  const users = admin ? await api('GET', 'users') : [];
  const brands = admin ? await api('GET', 'brand') : [], has = n => brands.some(b => b.name === n);
  const BR = [['logo', 'الشعار', 'Logo'], ['stamp', 'الختم', 'Company stamp'], ['signature', 'التوقيع المعتمد', 'Authorised signature']];
  main(`<h1>${tr('الإعدادات', 'Settings')}</h1>
  ${admin ? `<div class="card" id="sf"><div class="f2">${F.map(([k, a, e, t]) => field({ k, ar: a, en: e, type: t }, s[k])).join('')}
    ${field({ k: 'vat_registered', ar: 'مسجّل في ضريبة القيمة المضافة؟', en: 'VAT registered?', type: 'select', options: [['1', tr('نعم', 'Yes')], ['0', tr('لا', 'No')]] }, s.vat_registered ?? '1')}
    ${field({ k: 'bank_details', ar: 'بيانات البنك (تظهر في الفاتورة)', en: 'Bank details (shown on invoices)', type: 'textarea', full: 1 }, s.bank_details)}${field({ k: 'terms', ar: 'الشروط الافتراضية لعروض الأسعار', en: 'Default quotation terms', type: 'textarea', full: 1 }, s.terms)}</div>
    <button class="btn" id="save">${tr('حفظ', 'Save')}</button></div>
  <div class="card"><h2>${tr('هوية الشركة: الشعار والختم والتوقيع', 'Company identity: logo, stamp & signature')}</h2><p class="muted">${tr('تظهر تلقائياً في عروض الأسعار والفواتير وأوامر الشراء والخطابات والتقارير المطبوعة. استخدم صورة PNG بخلفية شفافة للختم والتوقيع (حتى ٢ ميجابايت). الختم والتوقيع يُطبعان فقط على المستندات الصادرة من النظام، فاحرص على صلاحيات المستخدمين.', 'Used automatically on quotations, invoices, purchase orders, letters and printed reports. Use a transparent PNG for the stamp and signature (up to 2 MB). The stamp and signature are applied to documents issued by the system — keep user roles tight.')}</p>
    <div class="grid">${BR.map(([k, a, e]) => `<div class="kpi"><div class="l">${tr(a, e)}</div><div style="height:90px;display:flex;align-items:center;justify-content:center;background:repeating-conic-gradient(#f1f1f1 0 25%,#fff 0 50%) 0 0/16px 16px;margin:8px 0">${has(k) ? `<img src="/api/brand/${k}?t=${Date.now()}" style="max-height:84px;max-width:100%">` : `<span class="muted">${tr('لم يُرفع', 'not uploaded')}</span>`}</div>
      <input type="file" accept="image/png,image/jpeg,image/webp" data-brand="${k}">${has(k) ? `<button class="btn sec sm" data-brand-del="${k}" style="margin-top:6px">${tr('حذف', 'Remove')}</button>` : ''}</div>`).join('')}</div></div>
  <div class="card" id="ef"><h2>${tr('إرسال البريد الإلكتروني', 'Email sending')}</h2><p class="muted">${tr('استخدم بيانات SMTP من مزوّد بريد شركتك (Microsoft 365 أو Google Workspace أو استضافة الدومين). المنفذ 587 للتشفير STARTTLS و465 للتشفير المباشر.', 'Use the SMTP details from your company mail provider (Microsoft 365, Google Workspace or your domain host). Port 587 uses STARTTLS, 465 uses implicit TLS.')}</p>
    <div class="f2">${E.map(([k, a, e, t]) => field({ k, ar: a, en: e, type: t }, k === 'smtp_pass' ? '' : s[k])).join('')}${field({ k: 'smtp_secure', ar: 'التشفير', en: 'Encryption', type: 'select', options: [['0', 'STARTTLS (587)'], ['1', 'SSL/TLS (465)']] }, s.smtp_secure ?? '0')}</div>
    ${s.smtp_pass_set ? `<p class="muted">${tr('كلمة المرور محفوظة — اتركها فارغة للإبقاء عليها.', 'Password saved — leave blank to keep it.')}</p>` : ''}
    <button class="btn" id="saveE">${tr('حفظ', 'Save')}</button> <input id="testTo" placeholder="${tr('بريد لإرسال رسالة تجريبية', 'Email for a test message')}" style="width:260px;margin-inline-start:10px"> <button class="btn sec" id="test">${tr('إرسال تجربة', 'Send test')}</button></div>
  <div class="card"><div class="bar"><h2 style="margin:0">${tr('المستخدمون والصلاحيات', 'Users & roles')}</h2><span class="sp"></span><button class="btn sm" id="addU">+ ${tr('مستخدم', 'User')}</button></div>
    <div class="tw"><table><thead><tr><th>${tr('المستخدم', 'User')}</th><th>${tr('الدور', 'Role')}</th><th></th></tr></thead><tbody>${users.map(u => `<tr><td>${esc(u.username)}${u.employee_name ? ` <span class="muted">(${esc(u.employee_name)})</span>` : ''}</td><td>${tr(...ROLE[u.role])}</td><td><button class="btn sec sm" data-pw="${u.id}">${tr('كلمة مرور', 'Reset password')}</button> <button class="btn sec sm" data-urole="${u.id}">${tr('تغيير الدور', 'Change role')}</button> ${u.username === ME.username ? '' : `<button class="btn sec sm" data-du="${u.id}">×</button>`}</td></tr>`).join('')}</tbody></table></div>
    <p class="muted">${tr('مدير النظام: كل شيء • محاسب: المالية والمحاسبة دون المستخدمين والإعدادات • مدير مشاريع: المشاريع والمشتريات والحضور دون الرواتب والضرائب • موارد بشرية: الموظفون والإجازات والطلبات والرواتب والخطابات دون الحسابات • عرض فقط: قراءة فقط • موظف: بوابته الخاصة فقط.', 'Admin: everything • Accountant: finance & accounting, no users/settings • Project manager: projects, purchasing, attendance — no payroll or tax • HR: employees, leave, requests, payroll, letters — no finance • Viewer: read-only • Employee: own portal only.')}</p></div>` : ''}
    <div class="card"><h2>${tr('تغيير كلمة المرور', 'Change password')}</h2><div class="f"><input type="password" id="np" minlength="6" placeholder="${tr('كلمة مرور جديدة', 'New password')}"></div><button class="btn sec" id="cp">${tr('تغيير', 'Change')}</button></div>
    ${admin ? `<div class="card"><h2>${tr('نسخة احتياطية', 'Backup')}</h2><p class="muted">${tr('حمّل نسخة من قاعدة البيانات (تشمل المستندات المرفقة والشعار) واحتفظ بها بشكل دوري. السجلات المالية يجب حفظها ٥–٧ سنوات، وتحتوي النسخة على كلمة مرور البريد فاحفظها في مكان آمن.', 'Download a copy of the database (it includes attached documents and your logo) and keep it safe regularly. Financial records must be kept 5–7 years; the copy contains the SMTP password — store it securely.')}</p><a class="btn sec" href="/api/backup" style="text-decoration:none;display:inline-block">${tr('تحميل النسخة الاحتياطية', 'Download backup')}</a></div>` : ''}`);
  $('#cp').onclick = guard(async () => { await api('POST', 'password', { password: $('#np').value }); $('#np').value = ''; toast(tr('تم التغيير', 'Password changed')); });
  if (!admin) return;
  $('#save').onclick = guard(async () => { const b = {}; [...F.map(f => f[0]), 'vat_registered', 'bank_details', 'terms'].forEach(k => b[k] = val($('#sf'), k)); S = { ...S, ...(await api('PUT', 'settings', b)) }; toast(tr('تم الحفظ', 'Saved')); });
  $('#saveE').onclick = guard(async () => { const b = {}; [...E.map(f => f[0]), 'smtp_secure'].forEach(k => b[k] = val($('#ef'), k)); await api('PUT', 'settings', b); toast(tr('تم الحفظ', 'Saved')); render(); });
  $('#test').onclick = guard(async () => { await api('POST', 'settings/test-email', { to: $('#testTo').value }); toast(tr('تم إرسال رسالة التجربة', 'Test email sent')); });
  document.querySelectorAll('[data-brand]').forEach(inp => inp.onchange = guard(async () => {
    const f = inp.files[0]; if (!f) return;
    if (f.size > 2 * 1024 * 1024) throw new Error(tr('الصورة أكبر من ٢ ميجابايت', 'Image is larger than 2 MB'));
    const data = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(f); });
    await api('PUT', 'brand/' + inp.dataset.brand, { data }); toast(tr('تم الرفع', 'Uploaded')); render();
  }));
  document.querySelectorAll('[data-brand-del]').forEach(b => b.onclick = guard(async () => { if (confirmDel()) { await api('DELETE', 'brand/' + b.dataset.brandDel); render(); } }));
  $('#addU').onclick = guard(async () => {
    const emps = await api('GET', 'employees').catch(() => []);
    const m = modal(`<h2>${tr('مستخدم جديد', 'New user')}</h2><div class="f2">${field({ k: 'username', ar: 'اسم المستخدم', en: 'Username', req: 1 }, '')}${field({ k: 'password', ar: 'كلمة المرور (٦ أحرف على الأقل)', en: 'Password (min 6)', type: 'password', req: 1 }, '')}
      ${field({ k: 'role', ar: 'الدور', en: 'Role', type: 'select', options: Object.keys(ROLE).map(k => [k, tr(...ROLE[k])]) }, 'accountant')}
      <div id="empbox" style="display:none">${field({ k: 'employee_id', ar: 'الموظف المرتبط', en: 'Linked employee', type: 'select', options: refOpts(emps, e => e.name, false) }, '')}</div></div>
      <div class="acts"><button class="btn" id="save">${tr('إنشاء', 'Create')}</button><button class="btn sec" id="cancel">${tr('إلغاء', 'Cancel')}</button></div>`);
    $('[name=role]', m).onchange = () => { $('#empbox', m).style.display = val(m, 'role') === 'employee' ? '' : 'none'; };
    $('#cancel', m).onclick = closeModal;
    $('#save', m).onclick = guard(async () => { await api('POST', 'users', { username: val(m, 'username'), password: val(m, 'password'), role: val(m, 'role'), employee_id: val(m, 'employee_id') }); closeModal(); render(); });
  });
  document.querySelectorAll('[data-pw]').forEach(b => b.onclick = guard(async () => { const p = prompt(tr('كلمة المرور الجديدة:', 'New password:')); if (p) { await api('PUT', 'users/' + b.dataset.pw, { password: p }); toast(tr('تم', 'Done')); } }));
  document.querySelectorAll('[data-urole]').forEach(b => b.onclick = guard(async () => { const r = prompt(tr('الدور:\n', 'Role:\n') + Object.keys(ROLE).join(' / ')); if (r) { await api('PUT', 'users/' + b.dataset.urole, { role: r }); render(); } }));
  document.querySelectorAll('[data-du]').forEach(b => b.onclick = guard(async () => { if (confirmDel()) { await api('DELETE', 'users/' + b.dataset.du); render(); } }));
};
