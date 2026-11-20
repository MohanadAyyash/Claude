PAGES.copilot = async () => {
  const [status, history] = await Promise.all([api('GET', 'copilot/status'), api('GET', 'copilot/history')]);
  const topics = {
    project_status: tr('حالة المشاريع', 'Project status'),
    project_financials: tr('ملخصات مالية للمشاريع', 'Project financial summaries'),
    invoice_summary: tr('الفواتير', 'Invoices'),
    procurement_status: tr('المشتريات وأوامر الشراء', 'Procurement and purchase orders'),
    quotation_summary: tr('عروض الأسعار', 'Quotations'),
    contract_summary: tr('عقود المقاولين من الباطن', 'Subcontract agreements'),
    certificate_summary: tr('شهادات مستخلصات المقاولين', 'Subcontract payment certificates'),
    project_documents: tr('بيانات مستندات المشاريع', 'Project document metadata'),
    approval_queue: tr('طلبات اعتماد الصرف', 'Spend approval queue'),
    sync_failures: tr('إخفاقات مزامنة SharePoint', 'SharePoint sync failures'),
  };
  const safeHref = href => /^#(?:projects|invoices|po|rfq|subcontracts)\/\d+$/.test(href || '') || ['#spend', '#settings'].includes(href);
  const safeSharePointHref = raw => {
    try {
      const url = new URL(raw), host = url.hostname.toLowerCase();
      const allowed = ['sharepoint.com', 'sharepoint.us', 'sharepoint.de', 'sharepoint.cn', 'sharepoint.africa', 'sharepoint-mil.us']
        .some(suffix => host === suffix || host.endsWith(`.${suffix}`));
      return url.protocol === 'https:' && allowed && !url.username && !url.password && (!url.port || url.port === '443') ? url.href : '';
    } catch { return ''; }
  };
  const labels = {
    code: tr('الرمز', 'Code'), location: tr('الموقع', 'Location'), status: tr('الحالة', 'Status'),
    start_date: tr('تاريخ البدء', 'Start date'), end_date: tr('تاريخ الانتهاء', 'End date'),
    project_name: tr('المشروع', 'Project'), number: tr('الرقم', 'Number'), date: tr('التاريخ', 'Date'),
    due_date: tr('تاريخ الاستحقاق', 'Due date'), kind: tr('النوع', 'Type'), subtotal: tr('قبل الضريبة', 'Subtotal'),
    vat: tr('ضريبة القيمة المضافة', 'VAT'), total: tr('الإجمالي', 'Total'), paid: tr('المدفوع', 'Paid'),
    balance: tr('الرصيد', 'Balance'), retention_open: tr('الاستقطاع المحتجز', 'Retention open'),
    status_explanation: tr('تفسير الحالة', 'Status explanation'), delivery_date: tr('تاريخ التسليم', 'Delivery date'),
    supplier_name: tr('المورد', 'Supplier'), approval_status: tr('حالة الاعتماد', 'Approval status'),
    purchase_order_count: tr('عدد أوامر الشراء', 'Purchase order count'), completion_date: tr('تاريخ إنجاز العقد', 'Contract completion date'),
    contract_value: tr('قيمة العقد', 'Contract value'), agreement_no: tr('رقم الاتفاقية', 'Agreement number'),
    description: tr('الوصف', 'Description'), doc_type: tr('نوع المستند', 'Document type'),
    category: tr('الفئة', 'Category'), expiry_date: tr('تاريخ الانتهاء', 'Expiry date'),
    created: tr('تاريخ الإضافة', 'Added'), sync_status: tr('حالة المزامنة', 'Sync status'),
    fails: tr('عدد المحاولات الفاشلة', 'Failed attempts'), updated_at: tr('آخر تحديث', 'Last update'),
    next_attempt_at: tr('المحاولة التالية', 'Next attempt'), requested_at: tr('وقت الطلب', 'Requested'),
    amount: tr('المبلغ', 'Amount'), invoice_count: tr('عدد الفواتير', 'Invoice count'),
    collected: tr('المحصّل', 'Collected'), receivable: tr('المستحق', 'Receivable'),
    cost: tr('التكلفة', 'Cost'), profit: tr('الربح', 'Profit'), margin: tr('الهامش %', 'Margin %'),
    revised_contract_value: tr('قيمة العقد المعدّلة', 'Revised contract value'), invoiced: tr('المفوتر', 'Invoiced'),
  };
  const value = (key, v) => {
    if (v == null || v === '') return '—';
    if (Array.isArray(v)) return key === 'history'
      ? v.map(item => `${item.action || ''} ${item.ts || ''}`.trim()).join(' · ') || '—'
      : v.map(item => typeof item === 'object' && item ? Object.values(item).filter(x => x != null).join(' · ') : String(item)).join(' · ');
    return typeof v === 'string' || typeof v === 'number' ? String(v) : '—';
  };
  const prompts = [
    tr('طلبات الشراء بانتظار الاعتماد', 'Purchase orders waiting for approval'),
    tr('أوامر الشراء المتأخرة', 'Overdue purchase orders'),
    tr('ملخص مشتريات المشروع', 'Project procurement summary'),
    tr('العقود التي تنتهي خلال 60 يوماً', 'Contracts expiring within 60 days'),
    tr('إخفاقات مزامنة SharePoint', 'SharePoint synchronization failures'),
  ];
  const renderRows = rows => (rows || []).map(row => {
    const href = safeHref(row.href) ? row.href : '';
    const title = row.number || row.name || row.agreement_no || `${row.kind || row.entity || ''} ${row.id || row.entity_id || ''}`;
    const sharePoint = safeSharePointHref(row.sharepoint_url);
    const fields = Object.entries(row).filter(([key]) => !['href', 'id', 'number', 'name', 'agreement_no', 'sharepoint_url'].includes(key));
    return `<article class="card"><div class="bar"><b>${esc(title)}</b>${href ? `<a class="btn sec sm" href="${esc(href)}">${tr('فتح في النظام', 'Open in ERP')}</a>` : ''}${sharePoint ? `<a class="btn sec sm" href="${esc(sharePoint)}" target="_blank" rel="noopener noreferrer">${tr('فتح في SharePoint', 'Open in SharePoint')}</a>` : ''}</div>
      <div class="grid">${fields.map(([key, val]) => `<div><span class="muted">${esc(labels[key] || key)}</span><br>${esc(value(key, val))}</div>`).join('')}</div></article>`;
  }).join('') || `<p class="muted">${tr('لا توجد نتائج منظمة لهذا السؤال.', 'No structured results for this question.')}</p>`;
  const feedbackButtons = id => `<div class="bar"><span class="muted">${tr('هل كانت الإجابة مفيدة؟', 'Was this answer helpful?')}</span>
    <button class="btn sec sm" data-feedback="${id}" data-rating="helpful">${tr('نعم', 'Yes')}</button>
    <button class="btn sec sm" data-feedback="${id}" data-rating="not_helpful">${tr('لا', 'No')}</button></div>`;
  const drawHistory = rows => {
    const box = $('#copilot-history');
    box.innerHTML = (rows || []).map(item => `<article class="card"><div class="muted">${esc(new Date(item.created_at).toLocaleString())}</div>
      <p><b>${esc(item.question)}</b></p><p style="white-space:pre-wrap">${esc(item.answer)}</p>${feedbackButtons(item.id)}</article>`).join('') ||
      `<p class="muted">${tr('لا يوجد سجل بعد.', 'No history yet.')}</p>`;
    box.querySelectorAll('[data-feedback]').forEach(button => button.onclick = guard(async () => {
      await api('POST', 'copilot/feedback', { history_id: +button.dataset.feedback, rating: button.dataset.rating });
      toast(tr('شكراً لملاحظاتك', 'Thank you for your feedback'));
    }));
  };
  main(`<h1>${tr('مساعد Trigon', 'Trigon Copilot')}</h1>
    <div class="card"><p>${tr('المساعد للقراءة فقط. يختار الخادم أداة مسموحاً بها ويطبّق صلاحيات ERP قبل إرسال إسقاط النتائج إلى المزوّد.', 'Read-only assistant. The server deterministically selects an allowed tool and applies ERP permissions before sending projected results to the provider.')}</p>
      <p class="muted">${tr('المواضيع', 'Topics')}: ${status.intents.map(intent => esc(topics[intent] || intent)).join(' · ')}</p>
      ${status.provider_configured ? '' : `<p class="neg">${tr('لم يتم إعداد مزوّد الإجابات؛ اطلب من المسؤول مراجعة إعدادات Copilot.', 'The answer provider is not configured; ask an administrator to review Copilot settings.')}</p>`}
      <form id="copilot-form"><div class="f"><label for="copilot-question">${tr('سؤالك', 'Your question')}</label>
        <textarea id="copilot-question" name="question" maxlength="1000" required rows="3"></textarea></div>
        <div class="bar" id="copilot-prompts">${prompts.map(prompt => `<button class="btn sec sm" type="button" data-prompt="${esc(prompt)}">${esc(prompt)}</button>`).join('')}</div>
        <button class="btn" type="submit">${tr('اسأل', 'Ask')}</button><span id="copilot-error" class="neg" role="alert"></span></form>
    </div>
    <div id="copilot-answer"></div>
    <div class="card"><div class="bar"><h2>${tr('سجل محادثاتي', 'My history')}</h2><span class="sp"></span>
      <button class="btn sec sm" id="copilot-clear">${tr('مسح السجل', 'Clear history')}</button></div><div id="copilot-history"></div></div>`);
  drawHistory(history);
  $('#copilot-prompts').querySelectorAll('[data-prompt]').forEach(button => button.onclick = () => {
    $('#copilot-question').value = button.dataset.prompt;
    $('#copilot-question').focus();
  });
  $('#copilot-clear').onclick = guard(async () => {
    if (!confirm(tr('مسح سجل Copilot الخاص بك؟', 'Clear your Copilot history?'))) return;
    await api('DELETE', 'copilot/history'); drawHistory([]);
  });
  $('#copilot-form').onsubmit = guard(async event => {
    event.preventDefault();
    const button = $('button[type="submit"]', event.currentTarget), error = $('#copilot-error');
    const submitLabel = button.textContent;
    button.disabled = true; button.textContent = tr('جارٍ البحث…', 'Searching…'); error.textContent = '';
    try {
      const result = await api('POST', 'copilot/ask', { question: $('#copilot-question').value });
      $('#copilot-answer').innerHTML = `<article class="card"><h2>${esc(topics[result.intent] || result.intent)}</h2>
        <p class="muted">${tr('شرح مولّد من بيانات ERP المصرح بها', 'Generated explanation from authorized ERP data')} · ${esc(new Date(result.created_at).toLocaleString())}</p>
        <h3>${tr('مراجع ERP المصرح بها', 'Authorized ERP references')}</h3>
        <p style="white-space:pre-wrap">${esc(result.answer)}</p>
        ${feedbackButtons(result.id)}${renderRows(result.data)}</article>`;
      $('#copilot-answer').querySelectorAll('[data-feedback]').forEach(feedback => feedback.onclick = guard(async () => {
        await api('POST', 'copilot/feedback', { history_id: +feedback.dataset.feedback, rating: feedback.dataset.rating });
        toast(tr('شكراً لملاحظاتك', 'Thank you for your feedback'));
      }));
      $('#copilot-question').value = '';
      drawHistory([result, ...(await api('GET', 'copilot/history')).filter(item => item.id !== result.id)]);
    } catch (e) { error.textContent = e.message; }
    finally { button.disabled = false; button.textContent = submitLabel; }
  });
};
