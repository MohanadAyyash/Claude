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

  ${live ? '<div id="zsync"></div>' : ''}
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
    <div class="f2" style="margin-top:12px"><div class="f"><label>${tr('إرسال المعاملات المؤرخة من', 'Send transactions dated from')}</label><input id="z-start" type="date" value="${esc(c.start || today())}"></div><div class="f"><label>${tr('الأنواع الجديدة (العهد، المطالبات، الشركاء، الأصول، الرواتب حسب التاريخ) تُرسل من', 'New types (petty cash, claims, partners, assets, salaries by date) sent from')}</label><input id="z-start2" type="date" value="${esc(c.start_v2 || '')}"${admin ? '' : ' disabled'}><small class="muted">${tr('فارغ = لا تُرسل. ما قبل هذا التاريخ لا يُرسل أبداً (لا إعادة إرسال للقديم).', 'Empty = not sent. Nothing dated before it is ever sent (history is not resent).')}</small></div>
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
      ${r.preflight ? zohoPreflight(r.preflight) : ''}
      <h3>${tr('العمليات التي كانت ستُرسل', 'Operations that would be sent')}</h3>
      <div class="tw"><table><thead><tr><th>${tr('العملية', 'Operation')}</th><th>${tr('النوع', 'Type')}</th><th>${tr('المرجع', 'Reference')}</th><th class="n">${tr('المبلغ', 'Amount')}</th></tr></thead><tbody>
      ${r.ops.map(o => { const base = o.path.replace(/\/(:id|DRY-\d+).*$/, ''); return `<tr><td>${o.method === 'DELETE' ? tr('حذف', 'Delete') : o.method === 'POST' && !/status/.test(o.path) ? tr('إنشاء', 'Create') : o.method === 'PUT' ? tr('تحديث', 'Update') : tr('تغيير حالة', 'Status')}</td><td>${tr(...(OPN[base] || [base, base]))}</td><td>${esc(String(o.what || ''))}</td><td class="n">${o.amount === '' ? '' : money(o.amount)}</td></tr>`; }).join('') || `<tr><td colspan="4" class="muted">${tr('لا شيء للإرسال', 'Nothing to send')}</td></tr>`}</tbody></table></div></div>`;
  });
  if ($('#retry')) $('#retry').onclick = guard(async () => { await api('POST', 'zoho/retry'); toast(tr('ستُعاد محاولة الأخطاء في الإرسال القادم', 'Failed records will be retried on the next send')); render(); });
  if (live) zohoSync(admin);
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
    await api('PUT', 'zoho/config', { start: $('#z-start').value, start_v2: $('#z-start2') ? $('#z-start2').value : undefined, hour: $('#z-hour').value, enabled: $('#z-en').checked ? '1' : '0', auto: $('#z-auto').checked ? '1' : '0', post: $('#z-post').checked ? '1' : '0', ...($('#z-org') ? { org: $('#z-org').value } : {}) });
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

// the preflight report of a dry run (read-only): organisation, what is already linked / synced, the plan per kind, conflicts and
// possible duplicates, and how every Trigon account the sync uses resolves in Zoho
function zohoPreflight(pf) {
  const KIND = { contact: ['جهات الاتصال', 'Contacts'], invoice: ['الفواتير والإشعارات الدائنة', 'Invoices & credit notes'], bill: ['فواتير الموردين والمصروفات', 'Bills & expenses'], payment: ['المقبوضات والمدفوعات', 'Receipts & payments'],
    jv_payroll: ['قيود الرواتب', 'Payroll journals'], jv_paypaid: ['قيود صرف الرواتب', 'Salaries paid journals'], jv_eos: ['قيود مخصص نهاية الخدمة', 'End-of-service provision journals'], jv_eos_set: ['قيود تسوية نهاية الخدمة', 'End-of-service settlement journals'],
    jv_retention: ['قيود المحتجزات', 'Retention journals'], jv_paypaid_d: ['قيود صرف الرواتب حسب التاريخ', 'Salaries paid (by date)'], jv_petty: ['قيود العهد وصندوق المكتب', 'Petty cash & custody journals'], jv_reimb: ['قيود تعويض المطالبات', 'Claim reimbursement journals'],
    jv_partner: ['قيود الشركاء', 'Partner journals'], jv_palloc: ['قيود توزيع الأرباح', 'Profit allocation journals'], jv_dep: ['قيود الإهلاك', 'Depreciation journals'], jv_asset: ['قيود الأصول', 'Asset journals'], jv_ret_release: ['قيود الإفراج عن المحتجزات', 'Retention release journals'], jv_advance: ['قيود السلف', 'Salary advance journals'] };
  const ACT = { create: ['إنشاء', 'Create'], update: ['تحديث', 'Update'], unchanged: ['موجود ولم يتغير', 'Already synced, unchanged'], link: ['موجود في Zoho — سيُربط', 'Exists in Zoho — would be linked'], conflict: ['تعارض', 'Conflict'], remove: ['حذف من Zoho', 'Remove from Zoho'], void: ['إلغاء في Zoho', 'Void in Zoho'], skip: ['متروك', 'Skipped'], error: ['خطأ', 'Error'] };
  const ORDER = ['create', 'update', 'unchanged', 'link', 'conflict', 'remove', 'void', 'skip', 'error'];
  const k = x => tr(...(KIND[x] || [x, x])), act = x => tr(...(ACT[x] || [x, x]));
  const HOW = [[/^mapped/, 'مربوط في بطاقة الربط', 'Mapped'], [/^automatic \(first Zoho (bank|cash) account\)/, 'تلقائي (أول حساب بنك / نقدية في Zoho)', null], [/^automatic \(name contains/, 'تلقائي (اسم الحساب يحتوي الفئة)', null], [/^automatic/, 'تلقائي (حساب Zoho الافتراضي من هذا النوع)', null],
    [/^fallback/, 'بديل: Cost of Goods Sold', null], [/^missing/, 'غير مربوط — اربطه قبل الإرسال', null], [/^Zoho tax/, 'ضريبة في Zoho', null], [/^Zoho default/, 'الافتراضي في Zoho (حساب المبيعات للبند)', null]];
  const how = h => { const m = HOW.find(([re]) => re.test(h)); return m ? tr(m[1], m[2] || h) : h; };
  const o = pf.organization || {};
  const rows = Object.entries(pf.plan || {});
  const ST = { mapped: ['مربوط', 'Mapped'], automatic: ['تلقائي (الحساب الوحيد من نوعه)', 'Automatic (the only one of its type)'], ambiguous: ['غير محدد — أكثر من حساب من نفس النوع', 'Ambiguous — several of that type'],
    missing: ['غير مربوط', 'Not mapped'], type_mismatch: ['نوع الحساب لا يطابق', 'Type mismatch'], not_found: ['غير موجود في Zoho', 'Not found in Zoho'] };
  const st = x => tr(...(ST[x] || [x, x])), zc = z => z ? `${esc(z.name)} <small class="muted">${esc(z.id)} · ${esc(z.type)}${z.code ? ' · ' + esc(z.code) : ''}${z.parent ? ' · ' + esc(z.parent) : ''}</small>` : '—';
  const verdictBox = pf.verdict ? `<div class="card" style="border:2px solid ${pf.verdict === 'READY' ? '#2a7' : pf.verdict === 'BLOCKED' ? '#c33' : '#d90'}"><b>${tr('النتيجة', 'Verdict')}: ${esc(pf.verdict)}</b>
    ${pf.blockers.length ? `<p class="err">${tr('يمنع الإرسال', 'Blocking')}:</p><ul>${pf.blockers.map(b => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}
    ${pf.to_configure.length ? `<p>${tr('يجب إعداده في Zoho قبل تفعيل الأنواع الجديدة', 'To configure in Zoho before the new types can be enabled')}:</p><ol>${pf.to_configure.map(b => `<li>${esc(b)}</li>`).join('')}</ol>` : ''}</div>
    <h3>${tr('الحسابات المطلوبة للمزامنة المقترحة (تُطابق بالنوع وبالربط، لا بالاسم)', 'Accounts the proposed sync needs (matched by type and mapping, never by name)')}</h3>
    <div class="tw"><table><thead><tr><th>${tr('الحساب', 'Account')}</th><th>${tr('الاسم', 'Name')}</th><th>${tr('مطلوب لـ', 'Needed by')}</th><th>${tr('النوع المتوقع', 'Expected type')}</th><th>${tr('الحالة', 'Status')}</th><th>${tr('حساب Zoho', 'Zoho account')}</th><th>${tr('ملاحظة', 'Note')}</th></tr></thead><tbody>
      ${pf.required_accounts.map(a => `<tr${['type_mismatch', 'not_found'].includes(a.status) ? ' class="err"' : ''}><td>${esc(a.code)}</td><td>${esc(a.label)}</td><td>${esc(a.needed)}</td><td>${esc(a.expected)}</td><td><b>${st(a.status)}</b></td><td>${zc(a.zoho)}</td><td class="muted">${esc(a.note || '')}</td></tr>`).join('')}</tbody></table></div>
    ${pf.partner_accounts.length ? `<h3>${tr('حسابات الشركاء (الهيكل المقترح — لم يُنشأ)', 'Partner accounts (proposed hierarchy — not created)')}</h3><div class="tw"><table><thead><tr><th>${tr('الشريك', 'Partner')}</th><th>${tr('الحساب', 'Account')}</th><th>${tr('الحساب المقترح', 'Proposed account')}</th><th>${tr('تحت', 'Under')}</th><th>${tr('النوع', 'Type')}</th><th>${tr('الحالة', 'Status')}</th><th>${tr('حساب Zoho', 'Zoho account')}</th></tr></thead><tbody>
      ${pf.partner_accounts.flatMap(p => p.accounts.map(a => `<tr><td>${esc(p.partner)}</td><td>${esc(a.code)}</td><td>${esc(a.proposed)}</td><td>${esc(a.parent)}</td><td>${esc(a.expected)}</td><td><b>${st(a.status)}</b></td><td>${zc(a.zoho)}</td></tr>`)).join('')}</tbody></table></div>` : ''}` : '';
  return `<h3>${tr('فحص ما قبل الإرسال (قراءة فقط)', 'Preflight (read-only)')}</h3>${verdictBox}
    <p>${tr('المؤسسة', 'Organisation')}: <b>${esc(o.name || '—')}</b> (${esc(o.id || '—')})${o.currency ? ' · ' + esc(o.currency) : ''}${o.error ? ` <span class="err">${esc(o.error)}</span>` : ''}
      · ${tr('مركز البيانات', 'Data centre')}: <b>${esc(pf.data_centre || '')}</b>${pf.api_host ? ' · ' + esc(pf.api_host) : ''}
      · ${tr('الفترة', 'Period')}: ${esc(pf.period.from || '…')} → ${esc(pf.period.to || '')}</p>
    <p class="muted">${tr('لم يُكتب أي شيء في Zoho ولا في سجل الإرسال: أي طلب غير القراءة يُرفض قبل إرساله.', 'Nothing was written to Zoho or to the send log: any request other than a read is refused before it is sent.')}</p>
    <div class="tw"><table><thead><tr><th>${tr('النوع', 'Type')}</th>${ORDER.map(a => `<th class="n">${act(a)}</th>`).join('')}</tr></thead><tbody>
      ${rows.map(([kind, c]) => `<tr><td>${k(kind)}</td>${ORDER.map(a => `<td class="n">${c[a] || ''}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${ORDER.length + 1}" class="muted">—</td></tr>`}</tbody></table></div>
    ${pf.conflicts.length ? `<h3 class="err">${tr('تعارضات وتكرارات محتملة', 'Conflicts and possible duplicates')} (${pf.conflicts.length})</h3>
      <ul>${pf.conflicts.map(i => `<li><b>${esc(i.ref)}</b> — ${act(i.action)}: ${esc(i.why)}</li>`).join('')}</ul>` : `<p>${tr('لا تعارضات ولا تكرارات محتملة.', 'No conflicts or possible duplicates.')}</p>`}
    ${pf.missing_accounts.length ? `<h3 class="err">${tr('حسابات غير مربوطة', 'Accounts not mapped')} (${pf.missing_accounts.length})</h3>
      <p>${pf.missing_accounts.map(a => `<b>${esc(a.code)}</b> ${esc(a.label)}`).join(' · ')}</p>` : ''}
    <h3>${tr('حسابات تريجون المستخدمة في الإرسال وما يقابلها في Zoho', 'Trigon accounts used by the sync and their Zoho account')}</h3>
    <div class="tw"><table><thead><tr><th>${tr('الحساب', 'Account')}</th><th>${tr('الاسم', 'Name')}</th><th>${tr('حساب Zoho', 'Zoho account')}</th><th>${tr('كيف', 'How')}</th></tr></thead><tbody>
      ${pf.accounts.map(a => `<tr${a.how.startsWith('missing') ? ' class="err"' : ''}><td>${esc(a.code)}</td><td>${esc(a.label)}</td><td>${esc(a.zoho_name || '')}</td><td>${esc(how(a.how))}</td></tr>`).join('')}</tbody></table></div>
    <details><summary>${tr('ما أُرسل سابقاً (سجل الإرسال)', 'Already sent (send log)')}</summary><div class="tw"><table><tbody>
      ${pf.synced.map(x => `<tr><td>${k(x.kind)}</td><td>${esc(x.status)}</td><td class="n">${x.n}</td></tr>`).join('') || `<tr><td class="muted">${tr('لا شيء بعد', 'Nothing yet')}</td></tr>`}</tbody></table></div></details>
    <details><summary>${tr('الربط المحفوظ', 'Saved mappings')} (${pf.mappings.length})</summary><div class="tw"><table><tbody>
      ${pf.mappings.map(m => `<tr><td>${esc(m.kind)}</td><td>${esc(m.local_key)}</td><td>${esc(m.label || m.zoho_id)}</td></tr>`).join('')}</tbody></table></div></details>
    <details><summary>${tr('كل السجلات', 'Every record')} (${pf.items.length})</summary><div class="tw"><table><tbody>
      ${pf.items.map(i => `<tr><td>${k(i.kind)}</td><td>${esc(i.ref)}</td><td>${act(i.action)}</td><td class="muted">${esc(i.why)}</td></tr>`).join('')}</tbody></table></div></details>`;
}


// ---------- Zoho accounting sync: account provisioning, the READY gate, continuous sending, reconciliation ----------
const ZS_ACT = { ok: ['جاهز', 'Ready'], adopt: ['يُعتمد حساب Zoho الموجود', 'Adopt the existing Zoho account'], create: ['يُنشأ في Zoho', 'Create in Zoho'], conflict: ['تعارض — يحتاج قراراً', 'Conflict — needs a decision'],
  blocked: ['متوقف (الحساب الأب فيه تعارض)', 'Blocked (its parent has a conflict)'], missing: ['يُربط مرة واحدة يدوياً', 'Map it once by hand'], vat_required: ['يلزم إعداد الضريبة في Zoho', 'VAT configuration required in Zoho'] };
const ZS_ST = { MATCH: ['مطابق', 'Match'], DIFFERENCE: ['فرق', 'Difference'], PENDING_SYNC: ['بانتظار الإرسال', 'Pending sync'], RETRYING: ['إعادة محاولة', 'Retrying'], MISSING_MAPPING: ['ربط ناقص', 'Missing mapping'],
  ZOHO_ONLY: ['في Zoho فقط', 'Zoho only'], TRIGON_ONLY: ['في تريجون فقط', 'Trigon only'], AMOUNT_MISMATCH: ['اختلاف المبلغ', 'Amount mismatch'], ACCOUNT_MISMATCH: ['اختلاف الحساب', 'Account mismatch'], DATE_MISMATCH: ['اختلاف التاريخ', 'Date mismatch'], BLOCKED: ['متوقف', 'Blocked'] };
const zsAct = a => tr(...(ZS_ACT[a] || [a, a])), zsSt = x => { const l = ZS_ST[x] || [x, x]; return `<span class="tag ${x === 'MATCH' ? 'paid' : ['DIFFERENCE', 'AMOUNT_MISMATCH', 'ACCOUNT_MISMATCH', 'DATE_MISMATCH', 'BLOCKED', 'TRIGON_ONLY'].includes(x) ? 'overdue' : ''}">${tr(l[0], l[1])}</span>`; };
async function zohoSync(admin) {
  const box = $('#zsync'); if (!box) return;
  let d; try { d = await api('GET', 'zoho-sync'); } catch (e) { box.innerHTML = `<div class="card"><p class="err">${esc(e.message)}</p></div>`; return; }
  const k = (l, v, cls = '') => `<div class="kpi"><div class="l">${l}</div><div class="v ${cls}" style="font-size:16px">${v}</div></div>`, q = d.queue, g = d.gate_info || {};
  const recon = d.last_reconciliation;
  box.innerHTML = `<div class="card"><div class="bar"><h2>${tr('مزامنة المحاسبة مع Zoho', 'Zoho Accounting Sync')}</h2><span class="sp"></span>
      ${admin ? `<label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="zs-cont" style="width:auto"${d.continuous ? ' checked' : ''}> ${tr('مزامنة مستمرة', 'Continuous sync')}</label>` : ''}</div>
    <p class="muted">${tr('تريجون هو مصدر الحقيقة لهيكل الحسابات والقيود اليومية، وZoho هو النظام المحاسبي الرسمي الخارجي. لا يُرسل أي قيد قبل أن يصل الفحص (قراءة فقط) إلى READY: لا ربط ناقص، لا نوع حساب خاطئ، لا تعارض.', 'Trigon is the source of truth for the accounting structure and the daily books; Zoho is the official external books. Nothing is sent before the read-only preflight reaches READY: no missing mapping, no wrong account type, no conflict.')}</p>
    <div class="grid">${k(tr('الاتصال', 'Connection'), d.connection.connected ? tr('مرتبط', 'Connected') : tr('غير مرتبط', 'Not connected'), d.connection.connected ? 'ok' : 'warn')}
      ${k(tr('المؤسسة', 'Organization'), esc(d.connection.organization || '—'))}${k(tr('مركز البيانات', 'Data center'), esc(d.connection.data_centre || '—'))}
      ${k(tr('الحسابات', 'Account provisioning'), esc(d.account_provisioning), d.account_provisioning === 'Ready' ? 'ok' : 'warn')}
      ${k(tr('بوابة الإرسال', 'Gate'), d.gate, d.gate === 'READY' ? 'ok' : 'warn')}
      ${k(tr('طابور الإرسال', 'Transaction queue'), `${q.retrying + q.error} ${tr('بانتظار إعادة المحاولة', 'waiting to retry')} · ${q.blocked} ${tr('متوقف', 'blocked')}${q.unsent_changes ? ' · ' + tr('تغييرات لم تُرسل', 'unsent changes') : ''}`, q.blocked ? 'warn' : '')}
      ${k(tr('آخر مزامنة ناجحة', 'Last successful sync'), esc(d.last_successful_sync || '—'))}
      ${k(tr('آخر مطابقة', 'Last reconciliation'), recon ? `${esc(recon.finished || '')} · ${zsSt(recon.status === 'MATCH' ? 'MATCH' : 'DIFFERENCE')}` : '—')}
      ${k(tr('ميزان المراجعة', 'Trial balance'), d.trial_balance === 'Match' ? tr('مطابق', 'Match') : d.trial_balance === 'Difference' ? tr('فرق', 'Difference') : tr('لم تُجرَ مطابقة', 'Not reconciled yet'), d.trial_balance === 'Match' ? 'ok' : d.trial_balance === 'Difference' ? 'warn' : '')}</div>
    ${q.backoff_until ? `<p class="err">${tr('Zoho غير متاح — المحاولة التالية بعد', 'Zoho unreachable — next attempt after')} ${esc(q.backoff_until.slice(0, 16).replace('T', ' '))}: ${esc(q.last_error)}</p>` : ''}
    ${!g.ready && (g.reasons || []).length ? `<details><summary>${tr('لماذا البوابة غير جاهزة', 'Why the gate is not ready')} (${g.reasons.length})</summary><ul>${g.reasons.map(x => `<li>${esc(x)}</li>`).join('')}</ul></details>` : ''}
    <div class="bar" style="flex-wrap:wrap;margin-top:10px">
      <button class="btn sec" id="zs-pf">${tr('تشغيل الفحص (قراءة فقط)', 'Run read-only preflight')}</button>
      <button class="btn sec" id="zs-pv">${tr('معاينة الحسابات الناقصة', 'Preview missing accounts')}</button>
      ${admin ? `<button class="btn" id="zs-prov" disabled>${tr('إنشاء الحسابات المعتمدة', 'Provision approved accounts')}</button><button class="btn sec" id="zs-retry">${tr('إعادة محاولة الإرسال المتعثر', 'Retry failed sync')}</button>` : ''}
      <button class="btn sec" id="zs-rec">${tr('تشغيل المطابقة', 'Run reconciliation')}</button>
      <button class="btn sec" id="zs-diff"${recon ? '' : ' disabled'}>${tr('عرض الفروقات', 'View differences')}</button></div>
    <div id="zs-out"></div></div>`;
  const out = $('#zs-out'); let preview = null;
  const busy = t => { out.innerHTML = `<p class="muted">${t}</p>`; };
  const planHtml = p => `<h3>${tr('الحسابات — المعاينة (لم يُرسل شيء)', 'Accounts — preview (nothing was sent)')}: ${esc(p.state)}</h3>
    <p class="muted">${tr('يُطابق بالرمز والنوع فقط، لا بالاسم. لا يُعاد تسمية أي حساب في Zoho ولا يُغيَّر نوعه ولا يُحذف ولا يُدمج.', 'Matched by code and type only, never by name. No Zoho account is renamed, re-typed, deleted or merged.')}</p>
    <div class="tw"><table><thead><tr><th>${tr('الرمز', 'Code')}</th><th>${tr('الاسم في Zoho', 'Name in Zoho')}</th><th>${tr('النوع', 'Type')}</th><th>${tr('الإجراء', 'Action')}</th><th>${tr('حساب Zoho', 'Zoho account')}</th><th>${tr('ملاحظة / الحل المقترح', 'Note / recommended resolution')}</th></tr></thead><tbody>
    ${p.rows.map(r => `<tr${['conflict', 'blocked'].includes(r.action) ? ' class="err"' : ''}><td>${esc(r.code)}</td><td>${esc(r.name)}${r.partner ? ` <small class="muted">${esc(r.partner)}</small>` : ''}</td><td>${esc(r.type || (r.types || []).join(' / '))}</td>
      <td><b>${zsAct(r.action)}</b>${r.reason ? `<br><small>${esc(r.reason)}</small>` : ''}</td><td>${r.zoho ? `${esc(r.zoho.name)} <small class="muted">${esc(r.zoho.id)} · ${esc(r.zoho.type)}${r.zoho.code ? ' · ' + esc(r.zoho.code) : ''}</small>` : '—'}</td><td>${esc(r.resolution || r.note || '')}</td></tr>`).join('')}</tbody></table></div>
    <h3>${tr('ضريبة القيمة المضافة (من إعداد الضرائب في Zoho — لا تُنشأ أبداً)', 'VAT (from Zoho\'s tax configuration — never created)')}</h3>
    <ul>${p.vat.map(v => `<li><b>${esc(v.code)}</b> ${esc(v.label)}: ${zsAct(v.action)}${v.zoho ? ` → ${esc(v.zoho.name)} (${esc(v.zoho.type)})` : ''}${v.reason ? ` — <span class="err">${esc(v.reason)}</span>` : ''}</li>`).join('')}</ul>
    <h3>${tr('التغييرات المقترحة بالضبط', 'Exact proposed changes')} (${p.mutations.length})</h3>
    ${p.mutations.length ? `<pre dir="ltr" style="white-space:pre-wrap;font-size:12px">${p.mutations.map(m => `${m.method} ${m.path} ${esc(JSON.stringify(m.body))}`).join('\n')}</pre>` : `<p>${tr('لا شيء يُنشأ.', 'Nothing to create.')}</p>`}
    ${p.adopts.length ? `<p>${tr('يُعتمد ويُحفظ رقمه فقط (بدون تغيير في Zoho)', 'Adopted, only its id is saved (no change in Zoho)')}: ${p.adopts.map(a => `<b>${esc(a.key.slice(5))}</b> → ${esc(a.zoho_id)} (${esc(a.how)})`).join(' · ')}</p>` : ''}`;
  const gateHtml = gt => `<div class="card" style="border:2px solid ${gt.ready ? '#2a7' : '#d90'}"><b>${tr('البوابة', 'Gate')}: ${gt.ready ? 'READY' : 'NOT READY'}</b> · ${tr('الفحص', 'Preflight')}: ${esc(gt.verdict)}
    · ${tr('ربط ناقص', 'missing mappings')} ${gt.missing_mappings} · ${tr('نوع خاطئ', 'wrong types')} ${gt.wrong_types} · ${tr('تعارضات', 'blocking conflicts')} ${gt.blocking_conflicts}
    ${gt.reasons.length ? `<ul>${gt.reasons.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</div>`;
  const reconHtml = r => `<h3>${tr('المطابقة', 'Reconciliation')} — ${esc(r.basis === 'movement' ? tr('حركة الفترة', 'period movement') : tr('الأرصدة', 'balances'))} ${tr('حتى', 'to')} ${esc(r.cutoff)}: ${zsSt(r.status === 'MATCH' ? 'MATCH' : 'DIFFERENCE')}</h3>
    <p>${Object.entries((r.summary || {}).items || {}).map(([st, n]) => `${zsSt(st)} ${n}`).join(' · ')}</p>
    <h3>${tr('القوائم المالية', 'Financial statements')}</h3><div class="tw"><table><thead><tr><th></th><th class="n">${tr('تريجون', 'Trigon')}</th><th class="n">Zoho</th><th class="n">${tr('الفرق', 'Difference')}</th><th>${tr('الحالة', 'Status')}</th></tr></thead><tbody>
    ${(r.statements || []).map(x => `<tr><td>${esc(x.name)}</td><td class="n">${money(x.trigon)}</td><td class="n">${money(x.zoho)}</td><td class="n">${money(x.difference)}</td><td>${zsSt(x.status)}</td></tr>`).join('')}</tbody></table></div>
    <h3>${tr('ميزان المراجعة: تريجون ↔ Zoho', 'Trial balance: Trigon ↔ Zoho')}</h3><div class="tw"><table><thead><tr><th>${tr('حساب تريجون', 'Trigon account')}</th><th>${tr('حساب Zoho', 'Zoho account')}</th><th class="n">${tr('تريجون', 'Trigon')}</th><th class="n">Zoho</th><th class="n">${tr('منها في Zoho فقط', 'of which Zoho only')}</th><th class="n">${tr('الفرق', 'Difference')}</th><th>${tr('الحالة', 'Status')}</th></tr></thead><tbody>
    ${(r.tb || []).filter(x => x.status !== 'MATCH' || x.trigon || x.zoho).map(x => `<tr${x.status !== 'MATCH' ? ' class="err"' : ''}><td>${esc(x.codes.join(' + '))}${x.partners.length ? ` <small>(${tr('شريك', 'partner')} ${esc(x.partners.join(', '))})</small>` : ''}</td><td>${esc(x.zoho_name || '—')}</td><td class="n">${money(x.trigon)}</td><td class="n">${money(x.zoho)}</td><td class="n">${x.zoho_only ? money(x.zoho_only) : ''}</td><td class="n">${money(x.difference)}</td><td>${zsSt(x.status)}</td></tr>`).join('')}</tbody></table></div>
    ${(r.items || []).filter(x => x.status !== 'MATCH').length ? `<h3>${tr('سجلات بحاجة لمراجعة', 'Records to review')}</h3><div class="tw"><table><tbody>${r.items.filter(x => x.status !== 'MATCH').map(x => `<tr><td>${esc(x.kind)}</td><td>${esc(x.ref || '#' + x.local_id)}</td><td>${zsSt(x.status)}</td><td class="muted">${esc(x.note)}</td></tr>`).join('')}</tbody></table></div>` : ''}
    ${(r.zoho_only || []).length ? `<h3>${tr('قيود في Zoho فقط (ليست من تريجون — لا تُستورد)', 'Entries in Zoho only (not from Trigon — never imported)')}</h3><div class="tw"><table><tbody>${r.zoho_only.slice(0, 300).map(x => `<tr><td>${esc(x.date || '')}</td><td>${esc(x.type || '')}</td><td>${esc(x.ref || x.id)}</td><td class="n">${money(x.amount)}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
  $('#zs-pf').onclick = guard(async () => { busy(tr('جارٍ الفحص (قراءة فقط)…', 'Running the read-only preflight…')); const r = await api('POST', 'zoho-sync/preflight'); out.innerHTML = gateHtml(r.gate) + (r.plan && r.plan.rows ? planHtml(r.plan) : ''); });
  $('#zs-pv').onclick = guard(async () => { busy(tr('جارٍ القراءة من Zoho…', 'Reading Zoho…')); preview = await api('GET', 'zoho-sync/preview'); out.innerHTML = planHtml(preview); if ($('#zs-prov')) $('#zs-prov').disabled = !(preview.mutations.length || preview.adopts.length); });
  if ($('#zs-prov')) $('#zs-prov').onclick = guard(async () => {
    if (!preview) return;
    const n = preview.mutations.length, a = preview.adopts.length;
    if (!confirm(tr(`سيُنشأ ${n} حساباً في Zoho ويُعتمد ${a} حساباً موجوداً، كما في المعاينة بالضبط. لن يُعاد تسمية أو تغيير أو حذف أي حساب. متابعة؟`, `This creates ${n} account(s) in Zoho and adopts ${a} existing account(s), exactly as in the preview. No account is renamed, changed or deleted. Continue?`))) return;
    busy(tr('جارٍ الإنشاء ثم الفحص مرة ثانية…', 'Creating, then running the preflight again…'));
    const r = await api('POST', 'zoho-sync/provision', { confirm: true, token: preview.token });
    out.innerHTML = `<p>${tr('أُنشئ', 'Created')} ${r.result.created.length} · ${tr('اعتُمد', 'adopted')} ${r.result.adopted.length} · ${tr('تعارضات متروكة', 'conflicts left')} ${r.result.conflicts.length} · ${tr('فشل', 'failed')} ${r.result.failed.length}</p>
      ${r.result.failed.length ? `<ul class="err">${r.result.failed.map(f => `<li>${esc(f.name)}: ${esc(f.error)}</li>`).join('')}</ul>` : ''}${gateHtml(r.gate)}${r.plan && r.plan.rows ? planHtml(r.plan) : ''}`;
    preview = null; $('#zs-prov').disabled = true;
  });
  if ($('#zs-retry')) $('#zs-retry').onclick = guard(async () => { const r = await api('POST', 'zoho-sync/retry'); toast(`${r.released} ${tr('سجل سيُعاد إرساله في الدقيقة القادمة', 'record(s) will be retried within a minute')}`); zohoSync(admin); });
  $('#zs-rec').onclick = guard(async () => { busy(tr('جارٍ المطابقة (قراءة فقط) — قد تستغرق دقائق…', 'Reconciling (read only) — this can take a few minutes…')); out.innerHTML = reconHtml(await api('POST', 'zoho-sync/reconcile', {})); });
  $('#zs-diff').onclick = guard(async () => { out.innerHTML = reconHtml(await api('GET', 'zoho-sync/recon')); });
  if ($('#zs-cont')) $('#zs-cont').onchange = guard(async e => { await api('PUT', 'zoho-sync/settings', { continuous: e.target.checked ? '1' : '0' }); toast(tr('تم الحفظ', 'Saved')); });
}
