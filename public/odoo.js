// Odoo link page: connection settings, daily transactions report, sync log, Odoo-ready CSV import files.
const ODOO_ST = { pending: ['بانتظار الإرسال', 'Pending', ''], ok: ['أُرسل', 'Sent', 'paid'], error: ['خطأ', 'Error', 'overdue'], changed: ['عُدّل بعد الترحيل', 'Edited after posting', 'overdue'], skipped: ['لم يُرسل', 'Not sent', ''], cancelled: ['أُلغي في Odoo', 'Cancelled in Odoo', ''] };
const ODOO_TYPE = { invoice: ['فاتورة ضريبية', 'Tax invoice'], credit_note: ['إشعار دائن', 'Credit note'], bill: ['مصروف / فاتورة مورد', 'Bill / expense'], receipt: ['مقبوض', 'Receipt'], payment: ['مدفوع', 'Payment'], partner: ['جهة اتصال', 'Contact'] };
const odooTag = s => { const l = ODOO_ST[s] || [s, s, '']; return `<span class="tag ${l[2]}">${tr(l[0], l[1])}</span>`; };

PAGES.odoo = async () => {
  const d = await api('GET', 'odoo'), c = d.config, admin = ME.role === 'admin', live = d.server && !window.STANDALONE;
  const day = sessionStorage.odooDay || today();
  const rep = await api('GET', 'odoo/report?date=' + day), t = rep.totals;
  const k = (l, v, cls = '') => `<div class="kpi"><div class="l">${l}</div><div class="v ${cls}">${v}</div></div>`;
  const on = c.enabled === '1';
  main(`<div class="bar"><h1>${tr('الربط مع Odoo', 'Odoo link')}</h1><span class="sp"></span>
    ${live && on ? `<button class="btn" id="sync">${tr('إرسال إلى Odoo الآن', 'Send to Odoo now')}</button>` : ''}</div>
  <p class="muted">${tr('يرسل النظام معاملات كل يوم إلى Odoo Accounting: جهات الاتصال، الفواتير الضريبية والإشعارات الدائنة، المصروفات وفواتير الموردين، المقبوضات والمدفوعات. كل معاملة تُرسل مرة واحدة ومعها رقمها المرجعي من هنا، فلا تتكرر.', 'Every day the system sends its transactions to Odoo Accounting: contacts, tax invoices and credit notes, bills, receipts and payments. Each record is sent once, with its reference from here, so nothing is duplicated.')}</p>
  <div class="grid">${k(tr('الحالة', 'Status'), on ? tr('مفعّل', 'On') : tr('غير مفعّل', 'Off'), on ? 'ok' : 'warn')}${k(tr('أُرسل', 'Sent'), d.counts.ok || 0)}${k(tr('أخطاء / تحتاج مراجعة', 'Errors / need review'), (d.counts.error || 0) + (d.counts.changed || 0), (d.counts.error || d.counts.changed) ? 'warn' : '')}${k(tr('آخر إرسال', 'Last run'), d.runs[0] ? esc(d.runs[0].finished.slice(0, 16)) : '—')}</div>

  <div class="card"><div class="bar"><h2>${tr('تقرير المعاملات اليومي', 'Daily transactions report')}</h2><span class="sp"></span><input type="date" id="day" value="${esc(day)}" style="max-width:170px"></div>
    <div class="grid">${k(tr('المفوتر', 'Invoiced'), money(t.invoiced))}${k(tr('ضريبة المخرجات', 'Output VAT'), money(t.output_vat))}${k(tr('المصروفات', 'Bills'), money(t.bills))}${k(tr('ضريبة المدخلات', 'Input VAT'), money(t.input_vat))}${k(tr('المقبوض', 'Received'), money(t.received))}${k(tr('المدفوع', 'Paid'), money(t.paid))}</div>
    <div class="tw"><table><thead><tr><th>${tr('النوع', 'Type')}</th><th>${tr('المرجع', 'Reference')}</th><th>${tr('الجهة', 'Party')}</th><th>${tr('المشروع', 'Project')}</th><th class="n">${tr('الصافي', 'Net')}</th><th class="n">${tr('الضريبة', 'VAT')}</th><th class="n">${tr('الإجمالي', 'Total')}</th><th>Odoo</th></tr></thead><tbody>
    ${rep.rows.map(r => `<tr${r.void ? ' style="opacity:.55"' : ''}><td>${tr(...(ODOO_TYPE[r.type] || [r.type, r.type]))}${r.void ? ` (${tr('ملغاة', 'void')})` : ''}</td><td>${esc(r.ref || '')}</td><td>${esc(r.party || '')}</td><td>${esc(r.project || '')}</td><td class="n">${money(r.net)}</td><td class="n">${money(r.vat)}</td><td class="n">${money(r.total)}</td><td>${odooTag(r.sync_status)}${r.sync_error ? `<div class="muted" style="font-size:12px">${esc(r.sync_error)}</div>` : ''}</td></tr>`).join('') || `<tr><td colspan="8" class="muted">${tr('لا توجد معاملات بهذا التاريخ', 'No transactions on this date')}</td></tr>`}
    </tbody></table></div></div>

  ${live ? `<div class="card"><h2>${tr('إعداد الاتصال', 'Connection')}</h2>
    ${admin ? `<p class="muted">${tr('من Odoo: الصورة الشخصية ← My Profile / Preferences ← Account Security ← New API Key. انسخ المفتاح هنا (يُحفظ على الخادم ولا يظهر مرة أخرى).', 'In Odoo: avatar → My Profile / Preferences → Account Security → New API Key. Paste the key here (stored on the server, never shown again).')}</p>
    <div class="f2"><div class="f"><label>${tr('عنوان Odoo', 'Odoo address')}</label><input id="o-url" dir="ltr" placeholder="https://trigon.odoo.com" value="${esc(c.url || '')}"></div>
    <div class="f"><label>${tr('اسم قاعدة البيانات', 'Database name')}</label><input id="o-db" dir="ltr" placeholder="trigon" value="${esc(c.db || '')}"></div>
    <div class="f"><label>${tr('بريد تسجيل الدخول في Odoo', 'Odoo login e-mail')}</label><input id="o-login" dir="ltr" value="${esc(c.login || '')}"></div>
    <div class="f"><label>${tr('مفتاح API', 'API key')}</label><input id="o-key" type="password" dir="ltr" autocomplete="new-password" placeholder="${c.key_set ? tr('محفوظ — اتركه فارغاً للإبقاء عليه', 'saved — leave empty to keep it') : ''}"></div>
    <div class="f"><label>${tr('إرسال المعاملات المؤرخة من', 'Send transactions dated from')}</label><input id="o-start" type="date" value="${esc(c.start || today())}"></div>
    <div class="f"><label>${tr('الإرسال التلقائي اليومي الساعة', 'Automatic daily send at hour')}</label><input id="o-hour" type="number" min="0" max="23" value="${esc(c.hour || '23')}"></div>
    <div class="f"><label>${tr('واجهة Odoo البرمجية', 'Odoo API')}</label><select id="o-api">${[['auto', tr('تلقائي حسب الإصدار', 'Automatic by version')], ['jsonrpc', 'JSON-RPC (Odoo ≤ 19)'], ['json2', 'JSON-2 (Odoo 19+)']].map(([v, l]) => `<option value="${v}"${(c.api || 'auto') === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div></div>
    <label style="display:flex;gap:8px;align-items:center;margin:6px 0"><input type="checkbox" style="width:auto" id="o-en"${on ? ' checked' : ''}> ${tr('تفعيل الربط', 'Enable the link')}</label>
    <label style="display:flex;gap:8px;align-items:center;margin:6px 0"><input type="checkbox" style="width:auto" id="o-auto"${c.auto === '1' ? ' checked' : ''}> ${tr('إرسال تلقائي كل يوم', 'Send automatically every day')}</label>
    <label style="display:flex;gap:8px;align-items:center;margin:6px 0"><input type="checkbox" style="width:auto" id="o-post"${c.post === '1' ? ' checked' : ''}> ${tr('ترحيل الفواتير والدفعات في Odoo مباشرة (بدون ذلك تصل كمسودات يراجعها المحاسب)', 'Post invoices and payments in Odoo right away (otherwise they arrive as drafts for the accountant to review)')}</label>
    <div class="bar" style="margin-top:12px"><button class="btn" id="o-save">${tr('حفظ', 'Save')}</button><button class="btn sec" id="o-test">${tr('اختبار الاتصال', 'Test connection')}</button></div><div id="o-res"></div>`
    : `<p class="muted">${esc(c.url || tr('لم يُضبط بعد — يضبطه مدير النظام', 'Not set up yet — an administrator sets it up'))}</p>`}</div>`
  : `<div class="card"><p>${tr('الإرسال المباشر إلى Odoo يعمل من نسخة الخادم فقط. في هذه النسخة استخدم ملفات الاستيراد أدناه.', 'Sending straight to Odoo works on the server edition only. In this edition use the import files below.')}</p></div>`}

  <div class="card"><h2>${tr('ملفات جاهزة للاستيراد في Odoo (بدون API)', 'Odoo import files (no API needed)')}</h2>
    <p class="muted">${tr('في Odoo افتح القائمة المطلوبة (جهات الاتصال / فواتير العملاء / فواتير الموردين / الدفعات) ← ⚙ ← Import records ← ارفع الملف. ابدأ بجهات الاتصال. إعادة استيراد نفس الملف تحدّث السجلات ولا تكررها.', 'In Odoo open the list (Contacts / Customer invoices / Vendor bills / Payments) → ⚙ → Import records → upload the file. Start with contacts. Importing the same file again updates instead of duplicating.')}</p>
    <div class="f2"><div class="f"><label>${tr('من', 'From')}</label><input type="date" id="x-from" value="${esc(day)}"></div><div class="f"><label>${tr('إلى', 'To')}</label><input type="date" id="x-to" value="${esc(day)}"></div></div>
    <div class="bar">${['partners', 'invoices', 'bills', 'payments'].map(kd => `<a class="btn sec" data-x="${kd}" href="#">${{ partners: tr('جهات الاتصال', 'Contacts'), invoices: tr('فواتير العملاء', 'Customer invoices'), bills: tr('فواتير الموردين', 'Vendor bills'), payments: tr('الدفعات', 'Payments') }[kd]} (CSV)</a>`).join('')}</div></div>

  ${live ? `<div class="card"><div class="bar"><h2>${tr('سجل الإرسال', 'Send history')}</h2><span class="sp"></span>${(d.counts.error || d.counts.skipped) ? `<button class="btn sec sm" id="retry">${tr('إعادة المحاولة للأخطاء', 'Retry failed')}</button>` : ''}</div>
    <div class="tw"><table><thead><tr><th>${tr('الوقت', 'Time')}</th><th>${tr('بواسطة', 'By')}</th><th class="n">${tr('أُرسل', 'Sent')}</th><th class="n">${tr('حُدّث', 'Updated')}</th><th class="n">${tr('فشل', 'Failed')}</th><th>${tr('ملاحظة', 'Note')}</th></tr></thead><tbody>
    ${d.runs.map(r => `<tr><td>${esc(r.finished.slice(0, 16))}</td><td>${esc(r.user || tr('تلقائي', 'automatic'))}</td><td class="n">${r.sent}</td><td class="n">${r.updated}</td><td class="n">${r.failed}</td><td class="muted">${esc(r.message || '')}</td></tr>`).join('') || `<tr><td colspan="6" class="muted">${tr('لم يتم أي إرسال بعد', 'Nothing sent yet')}</td></tr>`}
    </tbody></table></div></div>` : ''}`);

  $('#day').onchange = e => { sessionStorage.odooDay = e.target.value; render(); };
  const xHref = kd => `/api/odoo/export?kind=${kd}${kd === 'partners' ? '' : `&from=${$('#x-from').value}&to=${$('#x-to').value}`}`;
  document.querySelectorAll('[data-x]').forEach(a => { a.href = xHref(a.dataset.x); a.onmousedown = a.onfocus = () => { a.href = xHref(a.dataset.x); }; });
  if ($('#sync')) $('#sync').onclick = guard(async () => {
    $('#sync').disabled = true; toast(tr('جارٍ الإرسال…', 'Sending…'));
    try { const r = await api('POST', 'odoo/sync', {}); toast(`${tr('أُرسل', 'Sent')} ${r.sent} · ${tr('حُدّث', 'updated')} ${r.updated} · ${tr('فشل', 'failed')} ${r.failed}`); } finally { render(); }
  });
  if ($('#retry')) $('#retry').onclick = guard(async () => { await api('POST', 'odoo/retry'); toast(tr('ستُعاد محاولة الأخطاء في الإرسال القادم', 'Failed records will be retried on the next send')); render(); });
  if ($('#o-save')) {
    const body = () => ({ url: $('#o-url').value, db: $('#o-db').value, login: $('#o-login').value, key: $('#o-key').value || undefined, start: $('#o-start').value, hour: $('#o-hour').value, api: $('#o-api').value,
      enabled: $('#o-en').checked ? '1' : '0', auto: $('#o-auto').checked ? '1' : '0', post: $('#o-post').checked ? '1' : '0' });
    $('#o-save').onclick = guard(async () => { await api('PUT', 'odoo/config', body()); toast(tr('تم الحفظ', 'Saved')); render(); });
    $('#o-test').onclick = guard(async () => {
      await api('PUT', 'odoo/config', body()); $('#o-res').innerHTML = `<p class="muted">${tr('جارٍ الاتصال…', 'Connecting…')}</p>`;
      try {
        const r = await api('POST', 'odoo/test'), L = r.lookups;
        $('#o-res').innerHTML = `<p class="ok">✔ ${tr('تم الاتصال بـ Odoo', 'Connected to Odoo')} ${esc(r.version)} (${esc(r.api)})</p><ul class="muted">
          <li>${tr('ضريبة المبيعات', 'Sales tax')}: ${esc(L.sale_tax || '—')}</li><li>${tr('ضريبة المشتريات', 'Purchase tax')}: ${esc(L.purchase_tax || '—')}</li>
          <li>${tr('دفاتر', 'Journals')}: ${[L.sale_journal, L.purchase_journal, L.bank_journal, L.cash_journal].filter(Boolean).map(esc).join(' · ')}</li></ul>
          ${r.missing.length ? `<p class="err">${tr('ناقص في Odoo', 'Missing in Odoo')}: ${esc(r.missing.join(', '))} — ${tr('ثبّت الحزمة المحاسبية للإمارات (United Arab Emirates - Accounting) في Odoo', 'install the United Arab Emirates accounting localisation in Odoo')}</p>` : ''}`;
      } catch (e) { $('#o-res').innerHTML = `<p class="err">✘ ${esc(e.message)}</p>`; }
    });
  }
};
