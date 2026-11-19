PAGES.copilot = async () => {
  const [status, history] = await Promise.all([api('GET', 'copilot/status'), api('GET', 'copilot/history')]);
  const topics = {
    project_status: tr('حالة المشاريع', 'Project status'),
    project_financials: tr('ملخصات مالية للمشاريع', 'Project financial summaries'),
    invoice_summary: tr('الفواتير', 'Invoices'),
    procurement_status: tr('المشتريات وأوامر الشراء', 'Procurement and purchase orders'),
    contract_summary: tr('عقود المقاولين من الباطن', 'Subcontract agreements'),
    project_documents: tr('بيانات مستندات المشاريع', 'Project document metadata'),
    approval_queue: tr('طلبات اعتماد الصرف', 'Spend approval queue'),
    sync_failures: tr('إخفاقات مزامنة SharePoint', 'SharePoint sync failures'),
  };
  const safeHref = href => /^#(?:projects|invoices|po|rfq|subcontracts)\/\d+$/.test(href || '') || ['#spend', '#settings'].includes(href);
  const value = v => typeof v === 'string' || typeof v === 'number' ? String(v) : JSON.stringify(v);
  const renderRows = rows => (rows || []).map(row => {
    const href = safeHref(row.href) ? row.href : '';
    const title = row.number || row.name || row.agreement_no || `${row.kind || row.entity || ''} ${row.id || row.entity_id || ''}`;
    const fields = Object.entries(row).filter(([key]) => key !== 'href' && key !== 'id' && key !== 'number' && key !== 'name' && key !== 'agreement_no');
    return `<article class="card"><div class="bar"><b>${esc(title)}</b>${href ? `<span class="sp"></span><a class="btn sec sm" href="${esc(href)}">${tr('فتح في النظام', 'Open in ERP')}</a>` : ''}</div>
      <div class="grid">${fields.map(([key, val]) => `<div><span class="muted">${esc(key)}</span><br>${esc(value(val))}</div>`).join('')}</div></article>`;
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
        <button class="btn" type="submit">${tr('اسأل', 'Ask')}</button><span id="copilot-error" class="neg" role="alert"></span></form>
    </div>
    <div id="copilot-answer"></div>
    <div class="card"><div class="bar"><h2>${tr('سجل محادثاتي', 'My history')}</h2><span class="sp"></span>
      <button class="btn sec sm" id="copilot-clear">${tr('مسح السجل', 'Clear history')}</button></div><div id="copilot-history"></div></div>`);
  drawHistory(history);
  $('#copilot-clear').onclick = guard(async () => {
    if (!confirm(tr('مسح سجل Copilot الخاص بك؟', 'Clear your Copilot history?'))) return;
    await api('DELETE', 'copilot/history'); drawHistory([]);
  });
  $('#copilot-form').onsubmit = guard(async event => {
    event.preventDefault();
    const button = $('button[type="submit"]', event.currentTarget), error = $('#copilot-error');
    button.disabled = true; error.textContent = '';
    try {
      const result = await api('POST', 'copilot/ask', { question: $('#copilot-question').value });
      $('#copilot-answer').innerHTML = `<article class="card"><h2>${esc(topics[result.intent] || result.intent)}</h2><p style="white-space:pre-wrap">${esc(result.answer)}</p>
        ${feedbackButtons(result.id)}${renderRows(result.data)}</article>`;
      $('#copilot-answer').querySelectorAll('[data-feedback]').forEach(feedback => feedback.onclick = guard(async () => {
        await api('POST', 'copilot/feedback', { history_id: +feedback.dataset.feedback, rating: feedback.dataset.rating });
        toast(tr('شكراً لملاحظاتك', 'Thank you for your feedback'));
      }));
      $('#copilot-question').value = '';
      drawHistory([result, ...(await api('GET', 'copilot/history')).filter(item => item.id !== result.id)]);
    } catch (e) { error.textContent = e.message; }
    finally { button.disabled = false; }
  });
};
