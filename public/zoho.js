// Zoho Books link page: Self Client sign-in, daily transactions report, sync log, Zoho-ready CSV import files.
const ZOHO_ST = { pending: ['بانتظار الإرسال', 'Pending', ''], ok: ['أُرسل', 'Sent', 'paid'], error: ['خطأ', 'Error', 'overdue'], changed: ['عُدّل بعد الدفع', 'Edited after payment', 'overdue'], skipped: ['لم يُرسل', 'Not sent', ''], cancelled: ['أُلغي في Zoho', 'Voided in Zoho', ''], included: ['ضمن المصروف', 'Part of the expense', 'paid'] };
const ZOHO_TYPE = { invoice: ['فاتورة ضريبية', 'Tax invoice'], credit_note: ['إشعار دائن', 'Credit note'], bill: ['فاتورة مورد', 'Vendor bill'], expense: ['مصروف', 'Expense'], receipt: ['مقبوض', 'Receipt'], payment: ['مدفوع', 'Payment'] };
const ZOHO_DC = { ae: ['الإمارات (zoho.ae)', 'UAE (zoho.ae)'], sa: ['السعودية (zoho.sa)', 'Saudi Arabia (zoho.sa)'], com: ['الولايات المتحدة (zoho.com)', 'US (zoho.com)'], eu: ['أوروبا (zoho.eu)', 'Europe (zoho.eu)'], in: ['الهند (zoho.in)', 'India (zoho.in)'], au: ['أستراليا (zoho.com.au)', 'Australia (zoho.com.au)'] };
const zohoTag = s => { const l = ZOHO_ST[s] || [s, s, '']; return `<span class="tag ${l[2]}">${tr(l[0], l[1])}</span>`; };

PAGES.zoho = async () => {
  const d = await api('GET', 'zoho'), c = d.config, admin = ME.role === 'admin', live = d.server && !window.STANDALONE;
  const day = sessionStorage.zohoDay || today();
  const rep = await api('GET', 'zoho/report?date=' + day), t = rep.totals;
  const k = (l, v, cls = '') => `<div class="kpi"><div class="l">${l}</div><div class="v ${cls}">${v}</div></div>`;
  const on = c.enabled === '1', connected = c.connected === '1';
  const chk = (id, val, label) => `<label style="display:flex;gap:8px;align-items:center;margin:6px 0"><input type="checkbox" style="width:auto" id="${id}"${val ? ' checked' : ''}> ${label}</label>`;
  main(`<div class="bar"><h1>${tr('الربط مع Zoho Books', 'Zoho Books link')}</h1><span class="sp"></span>
    ${live ? `<button class="btn sec" id="dry">${tr('تجربة بدون إرسال (Dry run)', 'Dry run (nothing sent)')}</button>` : ''}${live && on && connected ? `<button class="btn" id="sync">${tr('إرسال إلى Zoho الآن', 'Send to Zoho now')}</button>` : ''}</div><div id="dry-res"></div>
  <p class="muted">${tr('يرسل النظام معاملات كل يوم إلى Zoho Books: جهات الاتصال، الفواتير الضريبية والإشعارات الدائنة بنفس أرقامها، فواتير الموردين والمصروفات، والمقبوضات والمدفوعات مربوطة بفاتورتها. كل معاملة تُرسل مرة واحدة فلا تتكرر.', 'Every day the system sends its transactions to Zoho Books: contacts, tax invoices and credit notes under our own numbers, vendor bills and expenses, and receipts and payments applied to their invoice or bill. Each record is sent once, so nothing is duplicated.')}</p>
  <div class="grid">${k(tr('الحالة', 'Status'), on && connected ? tr('مفعّل', 'On') : tr('غير مفعّل', 'Off'), on && connected ? 'ok' : 'warn')}${k(tr('أُرسل', 'Sent'), d.counts.ok || 0)}${k(tr('أخطاء / تحتاج مراجعة', 'Errors / need review'), (d.counts.error || 0) + (d.counts.changed || 0), (d.counts.error || d.counts.changed) ? 'warn' : '')}${k(tr('آخر إرسال', 'Last run'), d.runs[0] ? esc(d.runs[0].finished.slice(0, 16)) : '—')}</div>

  <div class="card"><div class="bar"><h2>${tr('تقرير المعاملات اليومي', 'Daily transactions report')}</h2><span class="sp"></span><input type="date" id="day" value="${esc(day)}" style="max-width:170px"></div>
    <div class="grid">${k(tr('المفوتر', 'Invoiced'), money(t.invoiced))}${k(tr('ضريبة المخرجات', 'Output VAT'), money(t.output_vat))}${k(tr('المصروفات والفواتير', 'Bills & expenses'), money(t.bills))}${k(tr('ضريبة المدخلات', 'Input VAT'), money(t.input_vat))}${k(tr('المقبوض', 'Received'), money(t.received))}${k(tr('المدفوع', 'Paid'), money(t.paid))}</div>
    <div class="tw"><table><thead><tr><th>${tr('النوع', 'Type')}</th><th>${tr('المرجع', 'Reference')}</th><th>${tr('الجهة', 'Party')}</th><th>${tr('المشروع', 'Project')}</th><th class="n">${tr('الصافي', 'Net')}</th><th class="n">${tr('الضريبة', 'VAT')}</th><th class="n">${tr('الإجمالي', 'Total')}</th><th>Zoho</th></tr></thead><tbody>
    ${rep.rows.map(r => `<tr${r.void ? ' style="opacity:.55"' : ''}><td>${tr(...(ZOHO_TYPE[r.type] || [r.type, r.type]))}${r.void ? ` (${tr('ملغاة', 'void')})` : ''}</td><td>${esc(r.ref || '')}</td><td>${esc(r.party || '')}</td><td>${esc(r.project || '')}</td><td class="n">${money(r.net)}</td><td class="n">${money(r.vat)}</td><td class="n">${money(r.total)}</td><td>${zohoTag(r.sync_status)}${r.sync_error ? `<div class="muted" style="font-size:12px">${esc(r.sync_error)}</div>` : ''}</td></tr>`).join('') || `<tr><td colspan="8" class="muted">${tr('لا توجد معاملات بهذا التاريخ', 'No transactions on this date')}</td></tr>`}
    </tbody></table></div></div>

  ${live ? `<div class="card"><h2>${tr('إعداد الاتصال', 'Connection')}</h2>
    ${admin ? `<ol class="muted" style="line-height:1.9">
      <li>${tr('افتح', 'Open')} <a href="${esc(d.console)}" target="_blank" rel="noopener" dir="ltr">${esc(d.console.replace('https://', ''))}</a> ${tr('وسجّل الدخول بحساب Zoho Books، ثم Add Client ← Self Client ← Create. انسخ Client ID و Client Secret هنا واضغط حفظ.', 'and sign in with the Zoho Books account, then Add Client → Self Client → Create. Copy the Client ID and Client Secret here and press Save.')}</li>
      <li>${tr('في نفس الصفحة: تبويب Generate Code. الصق الصلاحيات التالية في Scope، واختر المدة 10 minutes، واكتب أي وصف، ثم Create واختر مؤسسة Zoho Books.', 'On the same page: Generate Code tab. Paste the scope below, choose 10 minutes, type any description, then Create and pick the Zoho Books organisation.')}</li>
      <li>${tr('انسخ الكود الناتج والصقه في «كود الربط» واضغط ربط. الكود يُستخدم مرة واحدة.', 'Copy the generated code into “Grant code” and press Connect. The code works once.')}</li></ol>
    <div class="f"><label>Scope</label><input id="z-scope" dir="ltr" readonly value="${esc(d.scope)}" onclick="this.select()"></div>
    <div class="f2"><div class="f"><label>${tr('مركز بيانات Zoho', 'Zoho data centre')}</label><select id="z-dc">${d.centres.map(v => `<option value="${v}"${c.dc === v ? ' selected' : ''}>${tr(...(ZOHO_DC[v] || [v, v]))}</option>`).join('')}</select></div>
    <div class="f"><label>Client ID</label><input id="z-id" dir="ltr" value="${esc(c.client_id || '')}"${/client_id/.test(c.env || '') ? ' disabled' : ''}></div>
    <div class="f"><label>Client Secret</label><input id="z-secret" type="password" dir="ltr" autocomplete="new-password"${/client_secret/.test(c.env || '') ? ' disabled' : ''} placeholder="${/client_secret/.test(c.env || '') ? tr('من ملف .env', 'from the .env file') : c.secret_set ? tr('محفوظ — اتركه فارغاً للإبقاء عليه', 'saved — leave empty to keep it') : ''}"></div></div>
    ${c.env ? `<p class="ok">✔ ${tr('مفاتيح Zoho مقروءة من ملف .env على الخادم — لا تُعدّل من هنا ولا تظهر في المتصفح', 'Zoho keys are read from the .env file on the server — they cannot be changed here and never reach the browser')} (${esc(c.env)})</p>` : `<p class="muted">${tr('الأفضل: ضع ZOHO_CLIENT_ID و ZOHO_CLIENT_SECRET في ملف .env بجانب server.js ثم أعد تشغيل النظام.', 'Preferred: put ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET in the .env file next to server.js and restart the system.')}</p>`}
    <div class="bar"><button class="btn sec" id="z-save-client">${tr('حفظ', 'Save')}</button></div>
    <div class="f2" style="margin-top:12px"><div class="f"><label>${tr('كود الربط (Grant code)', 'Grant code')}</label><input id="z-code" dir="ltr" autocomplete="off" placeholder="1000.xxxx…"></div>
    <div class="f" style="align-self:end"><button class="btn" id="z-connect">${connected ? tr('إعادة الربط', 'Reconnect') : tr('ربط', 'Connect')}</button></div></div>
    ${connected ? `<p class="ok">✔ ${tr('مرتبط', 'Connected')}${c.org_name ? ` — ${esc(c.org_name)}` : ''} <button class="btn sec sm" id="z-disc">${tr('فصل الربط', 'Disconnect')}</button></p>
      ${c.orgs.length > 1 || !c.org ? `<div class="f"><label>${tr('مؤسسة Zoho Books', 'Zoho Books organisation')}</label><select id="z-org"><option value="">—</option>${c.orgs.map(o => `<option value="${esc(o.id)}"${o.id === c.org ? ' selected' : ''}>${esc(o.name)} (${esc(o.id)})</option>`).join('')}</select></div>` : ''}` : ''}
    <div class="f2" style="margin-top:12px"><div class="f"><label>${tr('إرسال المعاملات المؤرخة من', 'Send transactions dated from')}</label><input id="z-start" type="date" value="${esc(c.start || today())}"></div>
    <div class="f"><label>${tr('الإرسال التلقائي اليومي الساعة', 'Automatic daily send at hour')}</label><input id="z-hour" type="number" min="0" max="23" value="${esc(c.hour || '23')}"></div></div>
    ${chk('z-en', on, tr('تفعيل الربط', 'Enable the link'))}${chk('z-auto', c.auto === '1', tr('إرسال تلقائي كل يوم', 'Send automatically every day'))}
    ${chk('z-post', c.post === '1', tr('اعتماد الفواتير (Sent) وفواتير الموردين (Open) في Zoho مباشرة — بدون ذلك تصل كمسودات يراجعها المحاسب', 'Mark invoices as Sent and bills as Open in Zoho right away — otherwise they arrive as drafts for the accountant to review'))}
    <div class="bar" style="margin-top:12px"><button class="btn" id="z-save">${tr('حفظ', 'Save')}</button>${connected ? `<button class="btn sec" id="z-test">${tr('اختبار الاتصال', 'Test connection')}</button>` : ''}</div><div id="z-res"></div>`
    : `<p class="muted">${connected ? `${tr('مرتبط', 'Connected')} — ${esc(c.org_name || '')}` : tr('لم يُضبط بعد — يضبطه مدير النظام', 'Not set up yet — an administrator sets it up')}</p>`}</div>`
  : `<div class="card"><p>${tr('الإرسال المباشر إلى Zoho يعمل من نسخة الخادم فقط. في هذه النسخة استخدم ملفات الاستيراد أدناه.', 'Sending straight to Zoho works on the server edition only. In this edition use the import files below.')}</p></div>`}

  <div class="card"><h2>${tr('ملفات جاهزة للاستيراد في Zoho Books (بدون API)', 'Zoho Books import files (no API needed)')}</h2>
    <p class="muted">${tr('في Zoho Books افتح القائمة المطلوبة ← ⋯ ← Import، وارفع الملف وطابق الأعمدة. ابدأ بالعملاء والموردين، ثم الفواتير، ثم الدفعات.', 'In Zoho Books open the list → ⋯ → Import, upload the file and match the columns. Start with customers and vendors, then invoices and bills, then payments.')}</p>
    <div class="f2"><div class="f"><label>${tr('من', 'From')}</label><input type="date" id="x-from" value="${esc(day)}"></div><div class="f"><label>${tr('إلى', 'To')}</label><input type="date" id="x-to" value="${esc(day)}"></div></div>
    <div class="bar" style="flex-wrap:wrap">${[['customers', 'العملاء', 'Customers'], ['vendors', 'الموردون', 'Vendors'], ['invoices', 'الفواتير', 'Invoices'], ['creditnotes', 'الإشعارات الدائنة', 'Credit notes'], ['bills', 'فواتير الموردين', 'Bills'], ['expenses', 'المصروفات', 'Expenses'], ['customer_payments', 'المقبوضات', 'Customer payments'], ['vendor_payments', 'المدفوعات', 'Vendor payments']].map(([kd, ar, en]) => `<a class="btn sec" data-x="${kd}" href="#">${tr(ar, en)} (CSV)</a>`).join('')}</div></div>

  ${live ? `<div class="card"><div class="bar"><h2>${tr('سجل الإرسال', 'Send history')}</h2><span class="sp"></span>${(d.counts.error || d.counts.skipped) ? `<button class="btn sec sm" id="retry">${tr('إعادة المحاولة للأخطاء', 'Retry failed')}</button>` : ''}</div>
    <div class="tw"><table><thead><tr><th>${tr('الوقت', 'Time')}</th><th>${tr('بواسطة', 'By')}</th><th class="n">${tr('أُرسل', 'Sent')}</th><th class="n">${tr('حُدّث', 'Updated')}</th><th class="n">${tr('فشل', 'Failed')}</th><th>${tr('ملاحظة', 'Note')}</th></tr></thead><tbody>
    ${d.runs.map(r => `<tr><td>${esc(r.finished.slice(0, 16))}</td><td>${esc(r.user || tr('تلقائي', 'automatic'))}</td><td class="n">${r.sent}</td><td class="n">${r.updated}</td><td class="n">${r.failed}</td><td class="muted">${esc(r.message || '')}</td></tr>`).join('') || `<tr><td colspan="6" class="muted">${tr('لم يتم أي إرسال بعد', 'Nothing sent yet')}</td></tr>`}
    </tbody></table></div></div>` : ''}`);

  $('#day').onchange = e => { sessionStorage.zohoDay = e.target.value; render(); };
  const xHref = kd => `/api/zoho/export?kind=${kd}${['customers', 'vendors'].includes(kd) ? '' : `&from=${$('#x-from').value}&to=${$('#x-to').value}`}`;
  document.querySelectorAll('[data-x]').forEach(a => { a.href = xHref(a.dataset.x); a.onmousedown = a.onfocus = () => { a.href = xHref(a.dataset.x); }; });
  if ($('#sync')) $('#sync').onclick = guard(async () => {
    $('#sync').disabled = true; toast(tr('جارٍ الإرسال…', 'Sending…'));
    try { const r = await api('POST', 'zoho/sync', {}); toast(`${tr('أُرسل', 'Sent')} ${r.sent} · ${tr('حُدّث', 'updated')} ${r.updated} · ${tr('فشل', 'failed')} ${r.failed}`); } finally { render(); }
  });
  if ($('#dry')) $('#dry').onclick = guard(async () => {
    const box = $('#dry-res'); box.innerHTML = `<div class="card"><p class="muted">${tr('جارٍ التجربة…', 'Running…')}</p></div>`;
    const r = await api('POST', 'zoho/dry-run', {});
    const OPN = { '/contacts': ['جهة اتصال', 'Contact'], '/invoices': ['فاتورة', 'Invoice'], '/creditnotes': ['إشعار دائن', 'Credit note'], '/bills': ['فاتورة مورد', 'Bill'], '/expenses': ['مصروف', 'Expense'], '/customerpayments': ['مقبوض', 'Receipt'], '/vendorpayments': ['مدفوع', 'Payment'], '/journals': ['قيد يومية', 'Journal'] };
    box.innerHTML = `<div class="card"><h2>${tr('نتيجة التجربة — لم يُرسل شيء', 'Dry run — nothing was sent')}</h2>
      <p class="muted">${r.offline ? tr('غير مرتبط بـZoho: استُخدمت قيم تجريبية بدل الحسابات والضرائب.', 'Not connected to Zoho: stand-ins were used for accounts and taxes.') : tr('قُرئت البيانات من Zoho فعلاً، ولم يُكتب فيه شيء.', 'Data was read from Zoho; nothing was written.')}
      ${tr('سيُنشأ', 'Would create')} ${r.would_send} · ${tr('سيُحدّث', 'update')} ${r.would_update} · ${tr('أخطاء', 'errors')} ${r.failed}</p>
      ${r.errors.length ? `<ul class="err">${r.errors.map(e => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}
      <div class="tw"><table><thead><tr><th>${tr('العملية', 'Operation')}</th><th>${tr('النوع', 'Type')}</th><th>${tr('المرجع', 'Reference')}</th><th class="n">${tr('المبلغ', 'Amount')}</th></tr></thead><tbody>
      ${r.ops.map(o => { const base = o.path.replace(/\/(:id|DRY-\d+).*$/, ''); return `<tr><td>${o.method === 'POST' && !/status/.test(o.path) ? tr('إنشاء', 'Create') : o.method === 'PUT' ? tr('تحديث', 'Update') : tr('تغيير حالة', 'Status')}</td><td>${tr(...(OPN[base] || [base, base]))}</td><td>${esc(String(o.what || ''))}</td><td class="n">${o.amount === '' ? '' : money(o.amount)}</td></tr>`; }).join('') || `<tr><td colspan="4" class="muted">${tr('لا شيء للإرسال', 'Nothing to send')}</td></tr>`}</tbody></table></div></div>`;
  });
  if ($('#retry')) $('#retry').onclick = guard(async () => { await api('POST', 'zoho/retry'); toast(tr('ستُعاد محاولة الأخطاء في الإرسال القادم', 'Failed records will be retried on the next send')); render(); });
  if (live && connected) zohoMapping(admin);
  if (!$('#z-save')) return;
  const clientBody = () => ({ dc: $('#z-dc').value, client_id: $('#z-id').value.trim(), client_secret: $('#z-secret').value.trim() || undefined });
  $('#z-save-client').onclick = guard(async () => { await api('PUT', 'zoho/config', clientBody()); toast(tr('تم الحفظ', 'Saved')); render(); });
  $('#z-connect').onclick = guard(async () => {
    await api('PUT', 'zoho/config', clientBody());
    const r = await api('POST', 'zoho/connect', { code: $('#z-code').value });
    toast(r.org ? `${tr('تم الربط مع', 'Connected to')} ${r.org_name}` : tr('تم الربط — اختر المؤسسة', 'Connected — choose the organisation')); render();
  });
  if ($('#z-disc')) $('#z-disc').onclick = guard(async () => { if (!confirm(tr('فصل الربط مع Zoho؟ سيتوقف الإرسال حتى تربط من جديد.', 'Disconnect from Zoho? Sending stops until you connect again.'))) return; await api('POST', 'zoho/disconnect'); render(); });
  $('#z-save').onclick = guard(async () => {
    await api('PUT', 'zoho/config', { start: $('#z-start').value, hour: $('#z-hour').value, enabled: $('#z-en').checked ? '1' : '0', auto: $('#z-auto').checked ? '1' : '0', post: $('#z-post').checked ? '1' : '0', ...($('#z-org') ? { org: $('#z-org').value } : {}) });
    toast(tr('تم الحفظ', 'Saved')); render();
  });
  if ($('#z-test')) $('#z-test').onclick = guard(async () => {
    $('#z-res').innerHTML = `<p class="muted">${tr('جارٍ الاتصال…', 'Connecting…')}</p>`;
    try {
      const r = await api('POST', 'zoho/test'), L = r.lookups;
      $('#z-res').innerHTML = `<p class="ok">✔ ${tr('تم الاتصال بـ', 'Connected to')} ${esc(r.org)} (${esc(r.currency || '')})</p><ul class="muted">
        <li>${tr('الضريبة', 'VAT')}: ${esc(L.tax || '—')}${L.zero ? ' · ' + esc(L.zero) : ''}${L.exempt ? ' · ' + esc(L.exempt) : ''}</li>
        <li>${tr('البنك / النقدية', 'Bank / cash')}: ${esc([L.bank, L.cash].filter(Boolean).join(' · ') || '—')}</li><li>${tr('حساب المصروفات الافتراضي', 'Default expense account')}: ${esc(L.expense || '—')}</li></ul>
        ${r.missing.length ? `<p class="err">${tr('ناقص في Zoho Books', 'Missing in Zoho Books')}: ${esc(r.missing.join(', '))} — ${tr('فعّل ضريبة القيمة المضافة للإمارات وأضف حساب البنك في Zoho Books', 'enable UAE VAT and add the bank account in Zoho Books')}</p>` : ''}`;
    } catch (e) { $('#z-res').innerHTML = `<p class="err">✘ ${esc(e.message)}</p>`; }
  });
};

// our accounts → Zoho accounts; our projects → a Zoho reporting-tag option or a Zoho project
async function zohoMapping(admin) {
  const d = await api('GET', 'zoho/mapping'), card = document.createElement('div'); card.className = 'card';
  const saved = (kind, key) => (d.saved.find(x => x.kind === kind && x.local_key === String(key)) || {}).zoho_id || '';
  if (!d.zoho) { card.innerHTML = `<h2>${tr('ربط الحسابات والمشاريع', 'Account & project mapping')}</h2><p class="err">${esc(d.error || '')}</p>`; $('#main').append(card); return; }
  const accOpts = v => `<option value="">${tr('— تلقائي / غير مربوط —', '— automatic / not mapped —')}</option>${d.zoho.accounts.map(a => `<option value="${esc(a.id)}"${a.id === v ? ' selected' : ''}>${esc(a.name)} (${esc(a.type)})</option>`).join('')}`;
  const projOpts = v => `<option value="">—</option>${d.zoho.tags.map(t => `<optgroup label="${esc(tr('وسم', 'Tag'))}: ${esc(t.name)}">${t.options.map(o => { const k = `tag:${t.id}:${o.id}`; return `<option value="${k}"${k === v ? ' selected' : ''}>${esc(t.name)} = ${esc(o.name)}</option>`; }).join('')}</optgroup>`).join('')}
    ${d.zoho.projects.length ? `<optgroup label="${tr('مشاريع Zoho', 'Zoho projects')}">${d.zoho.projects.map(p => { const k = 'project:' + p.id; return `<option value="${k}"${k === v ? ' selected' : ''}>${esc(p.name)}</option>`; }).join('')}</optgroup>` : ''}`;
  card.innerHTML = `<h2>${tr('ربط الحسابات والمشاريع', 'Account & project mapping')}</h2>
    <p class="muted">${tr('قيود الرواتب ونهاية الخدمة والسلف تحتاج ربط كل حساب من حساباتنا بحساب في Zoho. فئات المصروفات بدون ربط تذهب لحساب اسمه يطابق الفئة أو Cost of Goods Sold.', 'Payroll, end-of-service and advance journals need each of our accounts mapped to a Zoho account. Unmapped expense categories go to an account whose name matches, or Cost of Goods Sold.')}</p>
    <div class="f2"><div><h3>${tr('الحسابات', 'Accounts')}</h3><table>${d.local.accounts.map(a => `<tr><td>${esc(a.label)}</td><td><select data-acc="${esc(a.key)}">${accOpts(saved('account', a.key))}</select></td></tr>`).join('')}</table></div>
    <div><h3>${tr('المشاريع', 'Projects')}</h3><p class="muted" style="font-size:12px">${tr('اختر خيار وسم التقارير (Reporting tag) أو مشروع Zoho لكل مشروع. يُضاف على بنود الفواتير وفواتير الموردين والقيود.', 'Pick a reporting-tag option or a Zoho project for each project. It is added to invoice, bill and journal lines.')}</p>
      <table>${d.local.projects.map(p => `<tr><td>${esc(p.code || '')} ${esc(p.name)}</td><td><select data-proj="${p.id}">${projOpts(saved('project', p.id))}</select></td></tr>`).join('')}</table></div></div>`;
  $('#main').append(card);
  if (!admin) return card.querySelectorAll('select').forEach(x => (x.disabled = true));
  const put = (kind, key, el) => guard(async () => { await api('PUT', 'zoho/mapping', { kind, local_key: key, zoho_id: el.value, label: el.selectedOptions[0]?.textContent || '' }); toast(tr('تم الحفظ', 'Saved')); });
  card.querySelectorAll('[data-acc]').forEach(x => x.onchange = put('account', x.dataset.acc, x));
  card.querySelectorAll('[data-proj]').forEach(x => x.onchange = put('project', x.dataset.proj, x));
}
