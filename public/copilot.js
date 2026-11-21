// Floating, read-only Copilot chat. All user and ERP values are escaped before insertion.
const copilotEscape = value => String(value ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

function copilotRecordCard(row, labels = {}) {
  const safeHref = href => /^#(?:projects|invoices|po|rfq|subcontracts)\/\d+$/.test(href || '') || ['#spend', '#settings'].includes(href);
  let sharePoint = '';
  try {
    const url = new URL(row.sharepoint_url || ''), host = url.hostname.toLowerCase();
    const allowed = ['sharepoint.com', 'sharepoint.us', 'sharepoint.de', 'sharepoint.cn', 'sharepoint.africa', 'sharepoint-mil.us']
      .some(suffix => host === suffix || host.endsWith(`.${suffix}`));
    if (url.protocol === 'https:' && allowed && !url.username && !url.password && (!url.port || url.port === '443')) {
      url.search = ''; url.hash = ''; sharePoint = url.href;
    }
  } catch { /* an invalid reference is rendered without a link */ }
  const title = row.number || row.name || row.agreement_no || `${row.kind || row.entity || ''} ${row.id || row.entity_id || ''}`;
  const href = safeHref(row.href) ? row.href : '';
  const fields = Object.entries(row).filter(([key]) => ![
    'href', 'id', 'number', 'name', 'agreement_no', 'sharepoint_url',
  ].includes(key));
  const value = val => Array.isArray(val)
    ? val.map(item => item && typeof item === 'object' ? Object.values(item).filter(x => x != null).join(' · ') : String(item)).join(' · ')
    : String(val ?? '—');
  return `<article class="tc-record"><div class="tc-record-title"><b>${copilotEscape(title)}</b>
    ${href ? `<a class="btn sec sm" href="${copilotEscape(href)}">${tr('فتح في النظام', 'Open in ERP')}</a>` : ''}
    ${sharePoint ? `<a class="btn sec sm" href="${copilotEscape(sharePoint)}" target="_blank" rel="noopener noreferrer">${tr('فتح في SharePoint', 'Open in SharePoint')}</a>` : ''}</div>
    <dl>${fields.map(([key, val]) => `<div><dt>${copilotEscape(labels[key] || key)}</dt><dd>${copilotEscape(value(val))}</dd></div>`).join('')}</dl></article>`;
}

window.TrigonCopilotWidget = { escapeHtml: copilotEscape, recordCardHtml: copilotRecordCard };

(() => {
  const state = { userId: null, open: false, minimized: false, memoryMode: false, conversationId: null,
    conversations: [], messages: [], prompts: null, loading: false, pendingQuestion: '', error: '', memory: null };
  const root = () => document.getElementById('copilot-root');
  const userKey = suffix => `trigon-copilot-${suffix}-${state.userId}`;
  const safeHrefLabels = {
    project_status: ['حالة المشاريع', 'Project status'],
    project_financials: ['ملخصات مالية للمشاريع', 'Project financial summaries'],
    invoice_summary: ['الفواتير', 'Invoices'],
    procurement_status: ['المشتريات وأوامر الشراء', 'Procurement and purchase orders'],
    quotation_summary: ['عروض الأسعار', 'Quotations'],
    contract_summary: ['عقود المقاولين من الباطن', 'Subcontract agreements'],
    certificate_summary: ['شهادات مستخلصات المقاولين', 'Subcontract payment certificates'],
    project_documents: ['بيانات مستندات المشاريع', 'Project document metadata'],
    approval_queue: ['طلبات اعتماد الصرف', 'Spend approval queue'],
    sync_failures: ['إخفاقات مزامنة SharePoint', 'SharePoint sync failures'],
    help: ['المواضيع المدعومة', 'Supported topics'],
    clarification: ['توضيح مطلوب', 'Clarification needed'],
  };
  const fieldLabels = {
    code: ['الرمز', 'Code'], location: ['الموقع', 'Location'], status: ['الحالة', 'Status'],
    start_date: ['تاريخ البدء', 'Start date'], end_date: ['تاريخ الانتهاء', 'End date'],
    project_name: ['المشروع', 'Project'], number: ['الرقم', 'Number'], date: ['التاريخ', 'Date'],
    due_date: ['تاريخ الاستحقاق', 'Due date'], kind: ['النوع', 'Type'], subtotal: ['قبل الضريبة', 'Subtotal'],
    vat: ['ضريبة القيمة المضافة', 'VAT'], total: ['الإجمالي', 'Total'], paid: ['المدفوع', 'Paid'],
    balance: ['الرصيد', 'Balance'], retention_open: ['الاستقطاع المحتجز', 'Retention open'],
    status_explanation: ['تفسير الحالة', 'Status explanation'], delivery_date: ['تاريخ التسليم', 'Delivery date'],
    supplier_name: ['المورد', 'Supplier'], approval_status: ['حالة الاعتماد', 'Approval status'],
    purchase_order_count: ['عدد أوامر الشراء', 'Purchase order count'], completion_date: ['تاريخ إنجاز العقد', 'Contract completion date'],
    contract_value: ['قيمة العقد', 'Contract value'], agreement_no: ['رقم الاتفاقية', 'Agreement number'],
    description: ['الوصف', 'Description'], doc_type: ['نوع المستند', 'Document type'],
    category: ['الفئة', 'Category'], expiry_date: ['تاريخ الانتهاء', 'Expiry date'],
    created: ['تاريخ الإضافة', 'Added'], sync_status: ['حالة المزامنة', 'Sync status'],
    fails: ['عدد المحاولات الفاشلة', 'Failed attempts'], updated_at: ['آخر تحديث', 'Last update'],
    next_attempt_at: ['المحاولة التالية', 'Next attempt'], requested_at: ['وقت الطلب', 'Requested'],
    amount: ['المبلغ', 'Amount'], invoice_count: ['عدد الفواتير', 'Invoice count'],
    collected: ['المحصّل', 'Collected'], receivable: ['المستحق', 'Receivable'],
    cost: ['التكلفة', 'Cost'], profit: ['الربح', 'Profit'], margin: ['الهامش %', 'Margin %'],
    revised_contract_value: ['قيمة العقد المعدّلة', 'Revised contract value'], invoiced: ['المفوتر', 'Invoiced'],
  };
  const prompts = [
    { intent: 'procurement_status', label: ['طلبات الشراء بانتظار الاعتماد', 'Purchase orders waiting for approval'] },
    { intent: 'procurement_status', label: ['أوامر الشراء المتأخرة', 'Overdue purchase orders'] },
    { intent: 'procurement_status', label: ['ملخص مشتريات المشروع', 'Project procurement summary'] },
    { intent: 'contract_summary', label: ['العقود التي تنتهي خلال 60 يوماً', 'Contracts expiring within 60 days'] },
    { intent: 'sync_failures', label: ['إخفاقات مزامنة SharePoint', 'SharePoint synchronization failures'] },
  ];
  const jsonRequest = async (method, path, body) => {
    let response;
    try {
      response = await fetch('/api/' + path, { method, headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body) });
    } catch { throw Object.assign(new Error('network'), { status: 0 }); }
    let data = {};
    try { data = await response.json(); } catch { /* never surface raw response text */ }
    if (!response.ok) throw Object.assign(new Error('request'), { status: response.status, data });
    return data;
  };
  const friendlyError = error => {
    if (error.status === 401) return tr('انتهت الجلسة. سجّل الدخول مجدداً.', 'Your session expired. Please sign in again.');
    if (error.status === 403) return tr('لا تملك صلاحية لهذا الطلب.', 'You are not authorized for that request.');
    if (error.status === 422) return tr('لا أستطيع المساعدة في هذا الموضوع. جرّب سؤالاً عن موضوع ERP مدعوم.', 'I cannot help with that topic. Try a supported ERP question.');
    if (error.status === 429 || error.status === 503) return tr('وصلت إلى حد الطلبات أو أن الخدمة مشغولة. حاول بعد قليل.', 'The request limit was reached or the service is busy. Please try again shortly.');
    if (error.status === 504) return tr('استغرق الطلب وقتاً أطول من اللازم. حاول مرة أخرى.', 'That took too long. Please try again.');
    return tr('تعذّر إكمال الطلب. حاول مرة أخرى لاحقاً.', 'The request could not be completed. Please try again later.');
  };
  const time = stamp => {
    const n = Number(stamp);
    return Number.isFinite(n) ? new Date(n).toLocaleTimeString(lang === 'ar' ? 'ar' : 'en', { hour: '2-digit', minute: '2-digit' }) : '';
  };
  const direction = text => /[\u0600-\u06ff]/.test(String(text || '')) ? 'rtl' : 'ltr';
  const activeConversation = () => state.conversations.find(item => item.id === state.conversationId);
  const suggested = () => {
    const prefs = state.memory?.preferences?.intents || [];
    const rank = new Map(prefs.map((item, index) => [item.intent, index]));
    return prompts.slice().sort((a, b) => (rank.get(a.intent) ?? 99) - (rank.get(b.intent) ?? 99));
  };
  function messageHtml(item) {
    const topic = safeHrefLabels[item.intent] ? tr(...safeHrefLabels[item.intent]) : tr('شرح مساعد Trigon', 'Trigon Assistant');
    const records = (item.data || []).map(row => copilotRecordCard(row, Object.fromEntries(
      Object.entries(fieldLabels).map(([key, label]) => [key, tr(...label)]),
    ))).join('');
    return `<div class="tc-pair"><div class="tc-user" dir="${direction(item.question)}">
      <div>${copilotEscape(item.question)}</div><time>${copilotEscape(time(item.created_at))}</time></div>
      <section class="tc-assistant" dir="${direction(item.answer)}">
        <div class="tc-label">${copilotEscape(topic)} · ${copilotEscape(time(item.created_at))}</div>
        ${item.intent && !['help', 'clarification'].includes(item.intent) ? `<div class="tc-generated">${tr('شرح مولّد من بيانات ERP المصرح بها', 'Generated explanation from authorized ERP data')}</div>` : ''}
        <div class="tc-answer">${copilotEscape(item.answer)}</div>
        ${item.data?.length ? `<div class="tc-facts"><b>${tr('حقائق ERP المصرح بها', 'Authorized ERP facts')}</b>${records}</div>` : ''}
        ${item.id ? `<div class="tc-feedback"><span>${tr('هل كانت الإجابة مفيدة؟', 'Was this answer helpful?')}</span>
          <button type="button" class="btn sec sm" data-feedback="${item.id}" data-rating="helpful" aria-label="${tr('إجابة مفيدة', 'Helpful answer')}">${tr('نعم', 'Yes')}</button>
          <button type="button" class="btn sec sm" data-feedback="${item.id}" data-rating="not_helpful" aria-label="${tr('إجابة غير مفيدة', 'Not helpful')}">${tr('لا', 'No')}</button></div>` : ''}
      </section></div>`;
  }
  function memoryHtml() {
    const memory = state.memory || { items: [], preferences: {}, personalization_enabled: false };
    const prefs = memory.preferences || {};
    const lines = [
      ...(prefs.language ? [`${tr('اللغة المفضلة', 'Preferred language')}: ${prefs.language === 'ar' ? 'العربية' : 'English'}`] : []),
      ...(prefs.projects || []).map(item => `${tr('المشروع الأكثر استخداماً', 'Most referenced project')}: ${item.name}`),
      ...(prefs.intents || []).map(item => `${tr('المواضيع الأكثر استخداماً', 'Most asked topic')}: ${safeHrefLabels[item.intent] ? tr(...safeHrefLabels[item.intent]) : item.intent}`),
      ...(prefs.filters || []).map(item => `${tr('التصفية الشائعة', 'Common filter')}: ${item.filter}`),
    ];
    return `<div class="tc-memory-view">
      ${memory.first_use_notice ? `<aside class="tc-notice" id="tc-notice">${tr(
        'قد يحفظ Copilot ملاحظات تختارها وملخصات استخدامك (مثل اللغة والمواضيع والمشاريع) لتحسين تجربتك. يمكنك عرضها أو حذفها في «ذاكرتي». لا تغيّر الذاكرة صلاحيات ERP ولا تُرسل نصوصها إلى مزوّد الذكاء الاصطناعي.',
        'Copilot may save notes you choose and aggregated usage preferences (such as language, topics, and projects) to personalize your experience. View or delete them in “My memory”. Memory never changes ERP access and its text is not sent to the AI provider.',
      )}<button type="button" id="tc-notice-dismiss" class="btn sec sm">${tr('حسناً', 'Got it')}</button></aside>` : ''}
      <h3>${tr('ملاحظاتي المحفوظة', 'Saved notes')}</h3>
      <form id="tc-memory-form"><textarea id="tc-memory-input" maxlength="300" rows="2" aria-label="${tr('معلومة لتذكرها', 'Memory item to remember')}"></textarea>
        <button class="btn sm" type="submit">${tr('حفظ', 'Save')}</button></form>
      ${memory.items?.length ? memory.items.map(item => `<div class="tc-memory-item"><span>${copilotEscape(item.content)}</span>
        <button type="button" class="btn sec sm" data-delete-memory="${item.id}" aria-label="${tr('حذف المعلومة', 'Delete memory item')}">×</button></div>`).join('')
        : `<p class="muted">${tr('لا توجد ملاحظات محفوظة.', 'No saved notes.')}</p>`}
      <button type="button" class="btn sec sm" id="tc-clear-memory" ${memory.items?.length ? '' : 'disabled'}>${tr('حذف كل الملاحظات', 'Delete all notes')}</button>
      <h3>${tr('التخصيص من الاستخدام', 'Usage-based personalization')}</h3>
      <label class="tc-toggle"><input type="checkbox" id="tc-personalization" ${memory.personalization_enabled ? 'checked' : ''}>
        ${tr('استخدام التفضيلات المجمّعة لاقتراح المواضيع والمشروع الافتراضي واللغة', 'Use aggregated preferences for suggested topics, default project, and answer language')}</label>
      <p class="muted">${copilotEscape(lines.join(' · ') || tr('لا توجد تفضيلات مجمّعة بعد.', 'No aggregated preferences yet.'))}</p>
      <button type="button" class="btn sec sm" id="tc-reset-preferences">${tr('إعادة ضبط التفضيلات', 'Reset learned preferences')}</button>
      <button type="button" class="btn sec sm" id="tc-export">${tr('تنزيل بياناتي', 'Export my data')}</button>
      ${state.error ? `<div class="tc-error" role="alert">${copilotEscape(state.error)}</div>` : ''}
    </div>`;
  }
  function paint() {
    const host = root();
    if (!host) return;
    host.innerHTML = `<button type="button" class="tc-launcher" id="tc-launcher" title="Trigon Assistant / مساعد تريجون"
      aria-label="Trigon Assistant / مساعد تريجون" aria-expanded="${state.open && !state.minimized}" aria-controls="tc-window">T</button>
      ${state.open && !state.minimized ? `<section id="tc-window" class="tc-window" role="dialog" aria-modal="false"
        aria-labelledby="tc-title" dir="${lang === 'ar' ? 'rtl' : 'ltr'}">
        <header class="tc-header"><div class="tc-heading"><h2 id="tc-title">Trigon Assistant</h2>
          <select id="tc-conversation" aria-label="${tr('المحادثة', 'Conversation')}">
            ${state.conversations.map(item => `<option value="${copilotEscape(item.id)}" ${item.id === state.conversationId ? 'selected' : ''}>${copilotEscape(item.title)}</option>`).join('')}
            ${!state.conversations.length ? `<option value="">${tr('محادثة جديدة', 'New conversation')}</option>` : ''}
          </select></div>
          <div class="tc-actions"><button type="button" id="tc-memory" class="tc-icon" aria-label="${tr('ذاكرتي', 'My memory')}" title="${tr('ذاكرتي', 'My memory')}">M</button>
            <button type="button" id="tc-new" class="tc-icon" aria-label="${tr('محادثة جديدة', 'New conversation')}" title="${tr('محادثة جديدة', 'New conversation')}">＋</button>
            <button type="button" id="tc-delete" class="tc-icon" aria-label="${tr('حذف المحادثة', 'Delete conversation')}" title="${tr('حذف المحادثة', 'Delete conversation')}" ${state.conversationId ? '' : 'disabled'}>⌫</button>
            <button type="button" id="tc-clear-all" class="tc-icon" aria-label="${tr('مسح كل المحادثات', 'Clear all conversations')}" title="${tr('مسح كل المحادثات', 'Clear all conversations')}">⌧</button>
            <button type="button" id="tc-minimize" class="tc-icon" aria-label="${tr('تصغير', 'Minimize')}">−</button>
            <button type="button" id="tc-close" class="tc-icon" aria-label="${tr('إغلاق', 'Close')}">×</button></div>
        </header>
        ${state.memoryMode ? memoryHtml() : `<div class="tc-notice" id="tc-first-notice" ${state.memory?.first_use_notice ? '' : 'hidden'}>
          ${tr('يمكنك حفظ ملاحظاتك وتفضيلاتك في «ذاكرتي» وعرضها أو حذفها في أي وقت. لا تغيّر الذاكرة صلاحياتك.', 'You can save notes and preferences in “My memory”, and view or delete them any time. Memory never changes your access.')}
          <button type="button" id="tc-notice-open" class="btn sec sm">${tr('عرض', 'View')}</button></div>
          <div class="tc-thread" id="tc-thread" aria-live="polite">
            ${state.messages.length ? state.messages.map(messageHtml).join('') : `<div class="tc-empty">
              <p>${tr('كيف أستطيع مساعدتك؟', 'How can I help?')}</p><div class="tc-chips">${suggested().map(item =>
                `<button type="button" class="btn sec sm" data-prompt="${copilotEscape(tr(...item.label))}">${copilotEscape(tr(...item.label))}</button>`).join('')}</div></div>`}
            ${state.pendingQuestion ? `<div class="tc-user" dir="${direction(state.pendingQuestion)}"><div>${copilotEscape(state.pendingQuestion)}</div></div>` : ''}
            ${state.loading ? `<div class="tc-typing" role="status"><span></span><span></span><span></span>${tr('جارٍ التحقق…', 'Checking…')}</div>` : ''}
            ${state.error ? `<div class="tc-error" role="alert">${copilotEscape(state.error)}</div>` : ''}
          </div>
          <form id="tc-form" class="tc-compose"><textarea id="tc-input" maxlength="1000" rows="2"
            placeholder="${tr('اكتب سؤالك…', 'Ask a question…')}" aria-label="${tr('اكتب سؤالك', 'Ask a question')}" ${state.loading ? 'disabled' : ''}></textarea>
            <div class="tc-compose-row"><span id="tc-counter">0 / 1000</span>
              <button type="submit" class="btn" id="tc-send" ${state.loading ? 'disabled' : ''}>${tr('إرسال', 'Send')}</button></div>
          </form>`}
      </section>` : ''}`;
    const launcher = document.getElementById('tc-launcher');
    launcher.onclick = () => { state.open = !state.open; state.minimized = false; localStorage.setItem(userKey('open'), state.open ? '1' : '0'); paint(); if (state.open) document.getElementById('tc-input')?.focus(); };
    if (!state.open || state.minimized) return;
    document.getElementById('tc-close').onclick = () => { state.open = false; state.minimized = false; localStorage.setItem(userKey('open'), '0'); paint(); document.getElementById('tc-launcher')?.focus(); };
    document.getElementById('tc-minimize').onclick = () => { state.minimized = true; paint(); document.getElementById('tc-launcher')?.focus(); };
    document.getElementById('tc-new').onclick = () => newConversation();
    document.getElementById('tc-memory').onclick = () => toggleMemory();
    document.getElementById('tc-conversation').onchange = event => loadConversation(event.target.value || null);
    document.getElementById('tc-delete').onclick = () => deleteConversation();
    document.getElementById('tc-clear-all').onclick = () => clearAllHistory();
    document.getElementById('tc-notice-open')?.addEventListener('click', () => toggleMemory());
    document.querySelectorAll('[data-prompt]').forEach(button => button.onclick = () => {
      const input = document.getElementById('tc-input'); input.value = button.dataset.prompt; input.focus(); updateCounter();
    });
    document.querySelectorAll('[data-feedback]').forEach(button => button.onclick = async () => {
      button.disabled = true;
      try { await jsonRequest('POST', 'copilot/feedback', { history_id: Number(button.dataset.feedback), rating: button.dataset.rating }); }
      catch (error) { state.error = friendlyError(error); paint(); }
    });
    const input = document.getElementById('tc-input');
    const updateCounter = () => { const counter = document.getElementById('tc-counter'); if (counter) counter.textContent = `${Array.from(input.value).length} / 1000`; };
    input.addEventListener('input', updateCounter);
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); document.getElementById('tc-form').requestSubmit(); }
    });
    document.getElementById('tc-form').onsubmit = event => { event.preventDefault(); sendQuestion(input.value); };
    if (state.memoryMode) bindMemory();
    const thread = document.getElementById('tc-thread'); if (thread) thread.scrollTop = thread.scrollHeight;
  }
  async function loadConversations() {
    state.conversations = await jsonRequest('GET', 'copilot/conversations');
    const remembered = localStorage.getItem(userKey('conversation'));
    if (remembered && state.conversations.some(item => item.id === remembered)) state.conversationId = remembered;
    else state.conversationId = state.conversations[0]?.id || null;
    if (state.conversationId) await loadConversation(state.conversationId, false);
  }
  async function loadConversation(id, redraw = true) {
    state.conversationId = id;
    state.messages = id ? await jsonRequest('GET', `copilot/history?conversation_id=${encodeURIComponent(id)}`) : [];
    if (id) localStorage.setItem(userKey('conversation'), id); else localStorage.removeItem(userKey('conversation'));
    if (redraw) paint();
  }
  async function newConversation() {
    try {
      const conversation = await jsonRequest('POST', 'copilot/conversations', { title: tr('محادثة جديدة', 'New conversation') });
      state.conversations.unshift(conversation); state.conversationId = conversation.id; state.messages = [];
      state.memoryMode = false; state.error = ''; localStorage.setItem(userKey('conversation'), conversation.id); paint(); document.getElementById('tc-input')?.focus();
    } catch (error) { state.error = friendlyError(error); paint(); }
  }
  async function deleteConversation() {
    if (!state.conversationId || !confirm(tr('حذف هذه المحادثة؟', 'Delete this conversation?'))) return;
    try {
      await jsonRequest('DELETE', `copilot/conversations/${encodeURIComponent(state.conversationId)}`);
      state.conversations = state.conversations.filter(item => item.id !== state.conversationId);
      state.conversationId = null; state.messages = []; localStorage.removeItem(userKey('conversation')); paint();
    } catch (error) { state.error = friendlyError(error); paint(); }
  }
  async function clearAllHistory() {
    if (!confirm(tr('حذف جميع محادثات Copilot الخاصة بك؟', 'Delete all your Copilot conversations?'))) return;
    try {
      await jsonRequest('DELETE', 'copilot/history');
      state.conversations = []; state.conversationId = null; state.messages = [];
      localStorage.removeItem(userKey('conversation')); paint();
    } catch (error) { state.error = friendlyError(error); paint(); }
  }
  async function sendQuestion(text) {
    const question = text.trim();
    if (!question || state.loading) return;
    state.pendingQuestion = question; state.error = ''; state.loading = true; paint();
    try {
      const result = await jsonRequest('POST', 'copilot/ask', { question, ...(state.conversationId ? { conversation_id: state.conversationId } : {}) });
      state.conversationId = result.conversation_id; localStorage.setItem(userKey('conversation'), state.conversationId);
      state.messages.push({ ...result, question, created_at: result.created_at || Date.now() });
      state.conversations = await jsonRequest('GET', 'copilot/conversations');
      state.memory = await jsonRequest('GET', 'copilot/memory');
    } catch (error) {
      state.error = friendlyError(error);
      state.messages.push({ question, answer: state.error, intent: null, data: [], created_at: Date.now() });
      state.error = '';
    } finally { state.loading = false; state.pendingQuestion = ''; paint(); }
  }
  async function toggleMemory() {
    state.memoryMode = !state.memoryMode;
    if (state.memoryMode) {
      try { state.memory = await jsonRequest('GET', 'copilot/memory'); }
      catch (error) { state.error = friendlyError(error); state.memoryMode = false; }
    }
    paint();
  }
  function bindMemory() {
    document.getElementById('tc-memory-form').onsubmit = async event => {
      event.preventDefault(); const input = document.getElementById('tc-memory-input');
      try {
        await jsonRequest('POST', 'copilot/memory', { content: input.value });
        state.memory = await jsonRequest('GET', 'copilot/memory'); paint();
      } catch (error) { state.error = friendlyError(error); paint(); }
    };
    document.querySelectorAll('[data-delete-memory]').forEach(button => button.onclick = async () => {
      try { await jsonRequest('DELETE', `copilot/memory/${button.dataset.deleteMemory}`); state.memory = await jsonRequest('GET', 'copilot/memory'); paint(); }
      catch (error) { state.error = friendlyError(error); paint(); }
    });
    document.getElementById('tc-clear-memory').onclick = async () => {
      if (!confirm(tr('حذف جميع ملاحظات الذاكرة؟', 'Delete all memory notes?'))) return;
      try { await jsonRequest('DELETE', 'copilot/memory'); state.memory = await jsonRequest('GET', 'copilot/memory'); paint(); }
      catch (error) { state.error = friendlyError(error); paint(); }
    };
    document.getElementById('tc-personalization').onchange = async event => {
      try { await jsonRequest('POST', 'copilot/personalization', { enabled: event.target.checked }); state.memory = await jsonRequest('GET', 'copilot/memory'); paint(); }
      catch (error) { state.error = friendlyError(error); paint(); }
    };
    document.getElementById('tc-reset-preferences').onclick = async () => {
      try { await jsonRequest('DELETE', 'copilot/preferences'); state.memory = await jsonRequest('GET', 'copilot/memory'); paint(); }
      catch (error) { state.error = friendlyError(error); paint(); }
    };
    document.getElementById('tc-export').onclick = async () => {
      try {
        const data = await jsonRequest('GET', 'copilot/export'), blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const href = URL.createObjectURL(blob), a = document.createElement('a'); a.href = href; a.download = 'my-copilot-data.json'; a.click(); URL.revokeObjectURL(href);
      } catch (error) { state.error = friendlyError(error); paint(); }
    };
    document.getElementById('tc-notice-dismiss')?.addEventListener('click', async () => {
      await jsonRequest('POST', 'copilot/notice', {}); state.memory = await jsonRequest('GET', 'copilot/memory'); paint();
    });
  }
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && state.open && !state.minimized) {
      state.open = false; state.minimized = false; localStorage.setItem(userKey('open'), '0'); paint(); document.getElementById('tc-launcher')?.focus();
    }
  });
  window.mountCopilotWidget = async () => {
    const host = root();
    if (!host) return;
    if (!COPILOT_AVAILABLE || !ME?.id) { host.innerHTML = ''; state.userId = null; return; }
    let status;
    try { status = await jsonRequest('GET', 'copilot/status'); } catch { status = null; }
    if (!status?.enabled) { COPILOT_AVAILABLE = false; host.innerHTML = ''; state.userId = null; return; }
    const changedUser = state.userId !== ME.id;
    if (changedUser) {
      state.userId = ME.id; state.open = localStorage.getItem(userKey('open')) === '1'; state.minimized = false;
      state.conversationId = null; state.conversations = []; state.messages = []; state.memoryMode = false;
      try { await loadConversations(); state.memory = await jsonRequest('GET', 'copilot/memory'); } catch { state.conversations = []; state.messages = []; }
    }
    paint();
  };
})();
