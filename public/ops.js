// Operations pages: documents, RFQ/PO, subcontracts & certificates, stock, assets, petty cash.
Object.assign(STATUS, {
  open: ['مفتوح', 'Open'], awarded: ['تم الترسية', 'Awarded'], received: ['تم الاستلام', 'Received'], closed: ['مغلق', 'Closed'], disposed: ['مستبعد', 'Disposed'],
});
const canOps = () => ['admin', 'accountant', 'manager'].includes(ME.role);
const canFin = () => ['admin', 'accountant'].includes(ME.role);
const fileToData = f => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(f); });
const size = n => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');

// ---- attachments panel (used inside project page and record modals) -------------------------------
window.docsPanel = async (el, entity, id, canWrite) => {
  let box = el;
  if (el.classList.contains('overlay')) { box = document.createElement('div'); box.className = 'card'; const mod = el.querySelector('.modal'); mod.insertBefore(box, mod.querySelector('.acts')); }
  const draw = async () => {
    const rows = await api('GET', `documents?entity=${entity}&entity_id=${id}`).catch(() => []);
    box.innerHTML = `<h2>${tr('المستندات المرفقة', 'Attached documents')}</h2>
      <table><tbody>${rows.map(d => `<tr><td><a href="/api/documents/${d.id}/download">${esc(d.name)}</a> <span class="pill">${esc(d.category || '')}</span></td><td class="muted">${size(d.size)}</td><td>${d.expiry_date ? `${tr('ينتهي', 'Expires')} ${esc(d.expiry_date)}` : ''}</td><td>${canWrite ? `<button class="btn sec sm" data-dd="${d.id}">×</button>` : ''}</td></tr>`).join('') || `<tr><td class="muted">${tr('لا توجد مستندات', 'No documents')}</td></tr>`}</tbody></table>
      ${canWrite ? `<div class="f2" style="margin-top:8px"><div class="f"><input type="file" class="dfile"></div><div class="f"><input class="dcat" placeholder="${tr('النوع (عقد، رخصة، فاتورة…)', 'Type (contract, licence, invoice…)')}"></div><div class="f"><label>${tr('تاريخ الانتهاء (اختياري)', 'Expiry date (optional)')}</label><input type="date" class="dexp"></div><div class="f"><button type="button" class="btn sm dup" style="margin-top:18px">${tr('رفع', 'Upload')}</button></div></div>` : ''}`;
    box.querySelectorAll('[data-dd]').forEach(b => b.onclick = guard(async () => { if (confirmDel()) { await api('DELETE', 'documents/' + b.dataset.dd); draw(); } }));
    const up = box.querySelector('.dup');
    if (up) up.onclick = guard(async () => {
      const f = box.querySelector('.dfile').files[0]; if (!f) throw new Error(tr('اختر ملفاً', 'Choose a file'));
      if (f.size > 8 * 1024 * 1024) throw new Error(tr('الملف أكبر من ٨ ميجابايت', 'File is larger than 8 MB'));
      await api('POST', 'documents', { entity, entity_id: id, name: f.name, category: box.querySelector('.dcat').value, expiry_date: box.querySelector('.dexp').value, data: await fileToData(f) });
      toast(tr('تم الرفع', 'Uploaded')); draw();
    });
  };
  await draw();
};

PAGES.documents = async () => {
  const all = await api('GET', 'documents');
  const label = { project: ['مشروع', 'Project'], party: ['عميل/مورد', 'Party'], bill: ['مصروف', 'Bill'], invoice: ['فاتورة', 'Invoice'], purchase_order: ['أمر شراء', 'PO'], subcontract: ['باطن', 'Subcontract'], employee: ['موظف', 'Employee'], company: ['الشركة', 'Company'] };
  main(`<h1>${tr('المستندات', 'Documents')}</h1><div class="card" id="cdocs"></div>
    <h2>${tr('كل المرفقات', 'All attachments')}</h2><div class="tw"><table><thead><tr><th>${tr('الملف', 'File')}</th><th>${tr('يخص', 'Belongs to')}</th><th>${tr('النوع', 'Type')}</th><th>${tr('الانتهاء', 'Expiry')}</th><th>${tr('رُفع بواسطة', 'Uploaded by')}</th></tr></thead><tbody>
    ${all.map(d => `<tr><td><a href="/api/documents/${d.id}/download">${esc(d.name)}</a></td><td>${tr(...(label[d.entity] || [d.entity, d.entity]))}</td><td>${esc(d.category || '')}</td><td>${esc(d.expiry_date || '')}</td><td>${esc(d.uploaded_by || '')} ${esc(d.created || '')}</td></tr>`).join('') || `<tr><td colspan="5" class="muted">${tr('لا توجد مستندات', 'No documents')}</td></tr>`}</tbody></table></div>`);
  await docsPanel($('#cdocs'), 'company', 0, canFin());
  $('#cdocs h2').textContent = tr('مستندات الشركة (الرخصة، عقد التأسيس، التأمينات…)', 'Company documents (licence, MOA, insurance…)');
};

// ---- RFQ: items x suppliers comparison ------------------------------------------------------------
PAGES.rfq = async () => {
  const [rows, projects, parties] = await Promise.all([api('GET', 'rfqs'), api('GET', 'projects'), api('GET', 'parties')]);
  const suppliers = parties.filter(p => p.type !== 'client');
  main(`<div class="bar"><h1>${tr('طلبات الأسعار (RFQ)', 'Requests for quotation')}</h1><span class="sp"></span>${canOps() ? `<button class="btn" id="add">+ ${tr('طلب جديد', 'New RFQ')}</button>` : ''}</div>
  <p class="muted">${tr('أدخل البنود المطلوبة ثم أسعار كل مورد؛ يقارن النظام الإجمالي ويُبرز الأقل، وبنقرة واحدة تُحوَّل الترسية إلى أمر شراء.', 'List the items, enter each supplier’s prices; the system compares totals, highlights the lowest and turns the award into a purchase order in one click.')}</p>
  <div class="tw"><table><thead><tr><th>${tr('الرقم', 'No.')}</th><th>${tr('التاريخ', 'Date')}</th><th>${tr('الوصف', 'Description')}</th><th>${tr('المشروع', 'Project')}</th><th class="n">${tr('عروض', 'Quotes')}</th><th>${tr('الحالة', 'Status')}</th></tr></thead><tbody>
  ${rows.map(r => `<tr class="click" data-id="${r.id}"><td>${esc(r.number)}</td><td>${esc(r.date)}</td><td>${esc(r.description || '')}</td><td>${esc(r.project_name || '')}</td><td class="n">${r.quotes.length}</td><td>${tag(r.status)}</td></tr>`).join('') || `<tr><td colspan="6" class="muted">${tr('لا توجد طلبات', 'No RFQs yet')}</td></tr>`}</tbody></table></div>`);
  const open = row => {
    const st = { items: row ? row.items.map(i => ({ ...i })) : [{ description: '', unit: '', qty: 1 }], quotes: row ? row.quotes.map(q => ({ party_id: q.party_id, rates: [...(q.rates || [])], delivery_days: q.delivery_days || '', notes: q.notes || '' })) : [] };
    const m = modal(`<h2>${row ? esc(row.number) : tr('طلب أسعار جديد', 'New RFQ')} ${row ? tag(row.status) : ''}</h2><div class="f2">${field({ k: 'project_id', ar: 'المشروع', en: 'Project', type: 'select', options: refOpts(projects, p => `${p.code || ''} ${p.name}`) }, row?.project_id)}${field({ k: 'description', ar: 'الوصف', en: 'Description' }, row?.description)}</div><div id="mx"></div>
      <div class="acts"><button class="btn" id="save">${tr('حفظ', 'Save')}</button><button class="btn sec" id="cancel">${tr('إغلاق', 'Close')}</button><span class="sp"></span>${row ? `<button class="btn bad" id="del">${tr('حذف', 'Delete')}</button>` : ''}</div>`, true);
    const draw = () => {
      const tot = q => st.items.reduce((s, it, i) => s + (+it.qty || 0) * (+q.rates[i] || 0), 0), full = q => st.items.every((_, i) => +q.rates[i] > 0);
      const priced = st.quotes.filter(full), low = priced.length ? Math.min(...priced.map(tot)) : null;
      $('#mx', m).innerHTML = `<div class="tw items"><table><thead><tr><th>${tr('البند', 'Item')}</th><th style="width:70px">${tr('الوحدة', 'Unit')}</th><th style="width:80px">${tr('الكمية', 'Qty')}</th>
        ${st.quotes.map((q, qi) => `<th style="min-width:130px"><select data-qs="${qi}">${refOpts(suppliers, p => p.name).map(([k, l]) => `<option value="${k}" ${String(k) === String(q.party_id) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select> <button type="button" class="x" data-qx="${qi}">×</button></th>`).join('')}<th></th></tr></thead><tbody>
        ${st.items.map((it, i) => `<tr><td><input data-i="${i}" data-f="description" value="${esc(it.description)}"></td><td><input data-i="${i}" data-f="unit" value="${esc(it.unit || '')}"></td><td><input type="number" step="any" data-i="${i}" data-f="qty" value="${it.qty}"></td>
          ${st.quotes.map((q, qi) => `<td><input type="number" step="any" data-q="${qi}" data-r="${i}" value="${q.rates[i] ?? ''}" placeholder="${tr('السعر', 'Rate')}"></td>`).join('')}<td><button type="button" class="x" data-ix="${i}">×</button></td></tr>`).join('')}
        <tr style="font-weight:700"><td colspan="3">${tr('الإجمالي (بدون ضريبة)', 'Total (ex VAT)')}</td>${st.quotes.map(q => `<td class="${full(q) && tot(q) === low ? 'pos' : ''}">${full(q) ? money(tot(q)) : '—'}${full(q) && tot(q) === low ? ' ★' : ''}</td>`).join('')}<td></td></tr>
        <tr><td colspan="3" class="muted">${tr('مدة التوريد (يوم)', 'Delivery (days)')}</td>${st.quotes.map((q, qi) => `<td><input type="number" data-qd="${qi}" value="${q.delivery_days}"></td>`).join('')}<td></td></tr>
        ${row ? `<tr><td colspan="3"></td>${st.quotes.map((q, qi) => `<td>${row.status === 'awarded' ? (row.awarded_party_id === q.party_id ? tag('awarded') : '') : `<button type="button" class="btn sm" data-award="${q.party_id}" ${full(q) ? '' : 'disabled'}>${tr('ترسية + أمر شراء', 'Award + PO')}</button>`}</td>`).join('')}<td></td></tr>` : ''}</tbody></table></div>
        <button type="button" class="btn sec sm" id="ai" style="margin-top:6px">+ ${tr('بند', 'Item')}</button> <button type="button" class="btn sec sm" id="aq" style="margin-top:6px">+ ${tr('مورد', 'Supplier')}</button>`;
      $('#mx', m).querySelectorAll('[data-f]').forEach(x => x.onchange = () => { st.items[+x.dataset.i][x.dataset.f] = x.value; draw(); });
      $('#mx', m).querySelectorAll('[data-r]').forEach(x => x.onchange = () => { st.quotes[+x.dataset.q].rates[+x.dataset.r] = x.value === '' ? '' : +x.value; draw(); });
      $('#mx', m).querySelectorAll('[data-qs]').forEach(x => x.onchange = () => { st.quotes[+x.dataset.qs].party_id = +x.value; });
      $('#mx', m).querySelectorAll('[data-qd]').forEach(x => x.onchange = () => { st.quotes[+x.dataset.qd].delivery_days = x.value; });
      $('#mx', m).querySelectorAll('[data-qx]').forEach(x => x.onclick = () => { st.quotes.splice(+x.dataset.qx, 1); draw(); });
      $('#mx', m).querySelectorAll('[data-ix]').forEach(x => x.onclick = () => { st.items.splice(+x.dataset.ix, 1); st.quotes.forEach(q => q.rates.splice(+x.dataset.ix, 1)); draw(); });
      $('#ai', m).onclick = () => { st.items.push({ description: '', unit: '', qty: 1 }); draw(); };
      $('#aq', m).onclick = () => { st.quotes.push({ party_id: suppliers[0]?.id, rates: [], delivery_days: '', notes: '' }); draw(); };
      $('#mx', m).querySelectorAll('[data-award]').forEach(x => x.onclick = guard(async () => {
        const r = await api('POST', `rfqs/${row.id}/award`, { party_id: +x.dataset.award }); closeModal(); go('po'); setTimeout(() => poModal(r.id), 400);
      }));
    };
    draw();
    $('#cancel', m).onclick = closeModal;
    $('#save', m).onclick = guard(async () => {
      const body = { project_id: val(m, 'project_id'), description: val(m, 'description'), items: st.items.filter(i => i.description), quotes: st.quotes.filter(q => q.party_id) };
      row ? await api('PUT', 'rfqs/' + row.id, body) : await api('POST', 'rfqs', body); closeModal(); render();
    });
    if (row) $('#del', m).onclick = guard(async () => { if (confirmDel()) { await api('DELETE', 'rfqs/' + row.id); closeModal(); render(); } });
  };
  if ($('#add')) $('#add').onclick = () => open(null);
  document.querySelectorAll('tr.click').forEach(t => t.onclick = () => open(rows.find(r => r.id === +t.dataset.id)));
};

// ---- purchase orders ---------------------------------------------------------------------------
window.poModal = guard(async (id, preset = {}) => {
  const [parties, projects] = await Promise.all([api('GET', 'parties'), api('GET', 'projects')]);
  const row = id ? await api('GET', 'purchase_orders/' + id) : null, e = itemsEditor(row?.items || []);
  const r = row || { date: today(), vat_pct: S.vat_pct || 5, status: 'draft', terms: 'Delivery to site. Payment 30 days from invoice.', ...preset };
  const head = [
    { k: 'party_id', ar: 'المورد', en: 'Supplier', type: 'select', options: refOpts(parties.filter(p => p.type !== 'client'), p => p.name, false) },
    { k: 'project_id', ar: 'المشروع', en: 'Project', type: 'select', options: refOpts(projects, p => `${p.code || ''} ${p.name}`) },
    { k: 'date', ar: 'التاريخ', en: 'Date', type: 'date' }, { k: 'delivery_date', ar: 'تاريخ التسليم', en: 'Delivery date', type: 'date' },
    { k: 'vat_pct', ar: 'نسبة الضريبة %', en: 'VAT %', type: 'number' },
    { k: 'status', ar: 'الحالة', en: 'Status', type: 'select', options: [['draft', tr('مسودة', 'Draft')], ['sent', tr(...STATUS.sent)], ['received', tr(...STATUS.received)], ['closed', tr(...STATUS.closed)], ['cancelled', tr(...STATUS.cancelled)]] }];
  const m = modal(`<h2>${tr('أمر شراء', 'Purchase order')} ${esc(r.number || '')} ${row ? tag(r.status) : ''}</h2><div class="f2">${head.map(f => field(f, r[f.k])).join('')}</div>${e.html}<div class="totals" id="tot"></div>
    <div class="f2" style="margin-top:10px">${field({ k: 'terms', ar: 'الشروط', en: 'Terms', type: 'textarea' }, r.terms)}${field({ k: 'notes', ar: 'ملاحظات', en: 'Notes', type: 'textarea' }, r.notes)}</div>
    <div class="acts"><button class="btn" id="save">${tr('حفظ', 'Save')}</button>${row ? `<button class="btn sec" id="print">${tr('طباعة', 'Print')}</button><button class="btn sec" id="pdf">PDF</button><button class="btn sec" id="mail">${tr('إرسال للمورد', 'Email supplier')}</button>${row.bill_id ? '' : `<button class="btn sec" id="rcv">${tr('استلام وإنشاء فاتورة مورد', 'Receive → create bill')}</button>`}` : ''}
    <button class="btn sec" id="cancel">${tr('إغلاق', 'Close')}</button><span class="sp"></span>${row && !row.bill_id ? `<button class="btn bad" id="del">${tr('حذف', 'Delete')}</button>` : ''}</div>`, true);
  bindDoc(m, e.row, 1, false);
  if (row && window.docsPanel) docsPanel(m, 'purchase_order', row.id, canOps());
  $('#cancel', m).onclick = closeModal;
  $('#save', m).onclick = guard(async () => {
    const b = { items: readItems(m) }; head.forEach(f => b[f.k] = val(m, f.k)); b.terms = val(m, 'terms'); b.notes = val(m, 'notes');
    if (!b.party_id) throw new Error(tr('اختر المورد', 'Select a supplier'));
    row ? await api('PUT', 'purchase_orders/' + row.id, b) : await api('POST', 'purchase_orders', b); closeModal(); render();
  });
  if (row) {
    $('#print', m).onclick = () => window.open(`/api/doc/purchase_orders/${row.id}?print=1`, '_blank'); $('#pdf', m).onclick = () => window.open(`/api/doc/purchase_orders/${row.id}/pdf`, '_blank');
    $('#mail', m).onclick = guard(async () => { const to = prompt(tr('أرسل إلى بريد المورد:', 'Send to supplier email:'), parties.find(p => p.id === row.party_id)?.email || ''); if (!to) return; if (window.STANDALONE) return standaloneMail(to, `Purchase Order ${row.number} — ${S.company_name || ''}`, `Please find purchase order ${row.number}. Total: ${S.currency || 'AED'} ${money(row.total)}\n\n${S.company_name || ''}`); await api('POST', `purchase_orders/${row.id}/email`, { to }); toast(tr('تم الإرسال', 'Email sent')); });
    if ($('#rcv', m)) $('#rcv', m).onclick = guard(async () => { if (!confirm(tr('سيُنشأ مصروف (فاتورة مورد) بقيمة الأمر. متابعة؟', 'This creates a supplier bill for the order value. Continue?'))) return; const r2 = await api('POST', `purchase_orders/${row.id}/receive`, {}); closeModal(); toast(tr('تم إنشاء الفاتورة', 'Bill created')); openBill(r2.bill_id); });
    if ($('#del', m)) $('#del', m).onclick = guard(async () => { if (confirmDel()) { await api('DELETE', 'purchase_orders/' + row.id); closeModal(); render(); } });
  }
});
PAGES.po = async () => {
  const rows = await api('GET', 'purchase_orders');
  main(`<div class="bar"><h1>${tr('أوامر الشراء', 'Purchase orders')}</h1><span class="sp"></span>${canOps() ? `<button class="btn" id="add">+ ${tr('أمر شراء', 'New PO')}</button>` : ''}</div>
  <div class="tw"><table><thead><tr><th>${tr('الرقم', 'No.')}</th><th>${tr('التاريخ', 'Date')}</th><th>${tr('المورد', 'Supplier')}</th><th>${tr('المشروع', 'Project')}</th><th class="n">${tr('الإجمالي', 'Total')}</th><th>${tr('الحالة', 'Status')}</th></tr></thead><tbody>
  ${rows.map(r => `<tr class="click" data-id="${r.id}"><td>${esc(r.number)}</td><td>${esc(r.date)}</td><td>${esc(r.supplier_name || '')}</td><td>${esc(r.project_name || '')}</td><td class="n">${money(r.total)}</td><td>${tag(r.status)}</td></tr>`).join('') || `<tr><td colspan="6" class="muted">${tr('لا توجد أوامر شراء', 'No purchase orders yet')}</td></tr>`}</tbody></table></div>`);
  if ($('#add')) $('#add').onclick = () => poModal();
  document.querySelectorAll('tr.click').forEach(t => t.onclick = () => poModal(+t.dataset.id));
};

// ---- subcontracts & payment certificates -------------------------------------------------------------
PAGES.subcontracts = async () => {
  const [rows, projects, parties] = await Promise.all([api('GET', 'subcontracts'), api('GET', 'projects'), api('GET', 'parties')]);
  const c = await crud({ title: tr('مقاولو الباطن وشهادات الدفع', 'Subcontracts & payment certificates'), table: 'subcontracts', load: async () => rows, noAdd: !canOps(),
    intro: `<p class="muted">${tr('أنشئ عقد الباطن ثم أصدر شهادات دفع تراكمية؛ يحسب النظام المحتجزات والدفعة المقدمة والضريبة، وعند الاعتماد يُنشئ مصروفاً بتكلفة المشروع.', 'Create the subcontract, then issue cumulative payment certificates; retention, advance recovery and VAT are calculated and approval books the cost to the project.')}</p>`,
    fields: async () => [{ k: 'project_id', ar: 'المشروع', en: 'Project', type: 'select', options: refOpts(projects, p => `${p.code || ''} ${p.name}`, false) }, { k: 'party_id', ar: 'مقاول الباطن', en: 'Subcontractor', type: 'select', options: refOpts(parties.filter(p => p.type !== 'client'), p => p.name, false) },
      { k: 'description', ar: 'نطاق العمل', en: 'Scope of work', full: 1, req: 1 }, { k: 'contract_value', ar: 'قيمة العقد (بدون ضريبة)', en: 'Contract value (ex VAT)', type: 'number', def: 0 }, { k: 'retention_pct', ar: 'نسبة المحتجزات %', en: 'Retention %', type: 'number', def: 5 },
      { k: 'advance', ar: 'الدفعة المقدمة', en: 'Advance payment', type: 'number', def: 0 }, { k: 'status', ar: 'الحالة', en: 'Status', type: 'select', options: [['active', tr(...STATUS.active)], ['completed', tr(...STATUS.completed)], ['cancelled', tr(...STATUS.cancelled)]] }],
    onModal: (m, row) => row && docsPanel(m, 'subcontract', row.id, canOps()),
    cols: [{ ar: 'المقاول', en: 'Subcontractor', k: 'party_name' }, { ar: 'المشروع', en: 'Project', k: 'project_name' }, { ar: 'النطاق', en: 'Scope', k: 'description' }, { ar: 'قيمة العقد', en: 'Contract', n: 1, f: r => money(r.contract_value) },
      { ar: 'المعتمد', en: 'Certified', n: 1, f: r => money(r.certified) }, { ar: 'محتجزات', en: 'Retention held', n: 1, f: r => money(r.retention_held) }, { ar: 'شهادات', en: 'Certs', n: 1, k: 'certs' }, { ar: 'الحالة', en: 'Status', f: r => tag(r.status) }] });
  c.setRow(id => subDetail(rows.find(r => r.id === id), c.edit));
};
async function subDetail(sub, edit) {
  const certs = (await api('GET', 'sub_certs')).filter(x => x.subcontract_id === sub.id);
  const m = modal(`<h2>${esc(sub.party_name || '')} — ${esc(sub.description || '')}</h2><p class="muted">${esc(sub.project_name || '')} · ${tr('قيمة العقد', 'Contract')} ${money(sub.contract_value)} · ${tr('محتجزات', 'Retention')} ${sub.retention_pct}%</p>
    <div class="tw"><table><thead><tr><th>${tr('الشهادة', 'Cert')}</th><th>${tr('التاريخ', 'Date')}</th><th class="n">${tr('التراكمي', 'Cumulative')}</th><th class="n">${tr('هذه الفترة', 'This period')}</th><th class="n">${tr('المستحق الآن', 'Payable now')}</th><th>${tr('الحالة', 'Status')}</th></tr></thead><tbody>
    ${certs.map(x => `<tr class="click" data-c="${x.id}"><td>${esc(x.number)}</td><td>${esc(x.date)}</td><td class="n">${money(x.cumulative)}</td><td class="n">${money(x.gross_this)}</td><td class="n">${money(x.payable_now)}</td><td>${tag(x.status === 'approved' ? 'approved' : 'draft')}</td></tr>`).join('') || `<tr><td colspan="6" class="muted">${tr('لا توجد شهادات', 'No certificates yet')}</td></tr>`}</tbody></table></div>
    <div class="acts">${canOps() ? `<button class="btn" id="nc">+ ${tr('شهادة دفع', 'New certificate')}</button><button class="btn sec" id="es">${tr('تعديل العقد', 'Edit contract')}</button>` : ''}<button class="btn sec" id="cancel">${tr('إغلاق', 'Close')}</button></div>`, true);
  $('#cancel', m).onclick = closeModal;
  if ($('#nc', m)) $('#nc', m).onclick = () => certModal(sub, null, Math.max(0, ...certs.map(x => x.cumulative)));
  if ($('#es', m)) $('#es', m).onclick = () => { closeModal(); edit(sub); };
  m.querySelectorAll('[data-c]').forEach(t => t.onclick = () => certModal(sub, certs.find(x => x.id === +t.dataset.c), Math.max(0, ...certs.map(x => x.cumulative))));
}
function certModal(sub, row, latest = 0) {
  const m = modal(`<h2>${tr('شهادة دفع مقاول باطن', 'Subcontractor payment certificate')} ${esc(row?.number || '')} ${row ? tag(row.status === 'approved' ? 'approved' : 'draft') : ''}</h2>
    <div class="f2">${field({ k: 'date', ar: 'التاريخ', en: 'Date', type: 'date' }, row?.date || today())}${field({ k: 'cumulative', ar: 'قيمة الأعمال المنجزة حتى تاريخه (تراكمي، بدون ضريبة)', en: 'Work completed to date (cumulative, ex VAT)', type: 'number' }, row?.cumulative ?? '')}
    ${field({ k: 'retention_pct', ar: 'المحتجزات %', en: 'Retention %', type: 'number' }, row?.retention_pct ?? sub.retention_pct)}${field({ k: 'advance_recovery', ar: 'استرداد الدفعة المقدمة', en: 'Advance recovery', type: 'number' }, row?.advance_recovery ?? 0)}
    ${field({ k: 'deductions', ar: 'خصومات / تحميلات', en: 'Deductions / back-charges', type: 'number' }, row?.deductions ?? 0)}${field({ k: 'vat_pct', ar: 'الضريبة %', en: 'VAT %', type: 'number' }, row?.vat_pct ?? (S.vat_pct || 5))}
    ${field({ k: 'notes', ar: 'ملاحظات', en: 'Notes', type: 'textarea', full: 1 }, row?.notes)}</div><div class="totals" id="pv"></div>
    <div class="acts">${row?.status === 'approved' ? '' : `<button class="btn" id="save">${tr('حفظ', 'Save')}</button>`}${row && row.status !== 'approved' && canFin() ? `<button class="btn sec" id="ap">${tr('اعتماد وإنشاء مصروف', 'Approve & book cost')}</button>` : ''}${row ? `<button class="btn sec" id="pr">${tr('طباعة', 'Print')}</button><button class="btn sec" id="pdf">PDF</button>` : ''}<button class="btn sec" id="cancel">${tr('إغلاق', 'Close')}</button><span class="sp"></span>${row && row.status !== 'approved' ? `<button class="btn bad" id="del">${tr('حذف', 'Delete')}</button>` : ''}</div>`);
  const prevV = row ? row.previous : latest;
  const calc = () => {
    const cum = +val(m, 'cumulative') || 0, g = cum - prevV, ret = g * (+val(m, 'retention_pct') || 0) / 100, ded = +val(m, 'deductions') || 0, adv = +val(m, 'advance_recovery') || 0, vat = (g - ded) * (+val(m, 'vat_pct') || 0) / 100;
    $('#pv', m).innerHTML = `<div><span>${tr('المعتمد سابقاً', 'Previously certified')}</span><span>${money(prevV)}</span></div><div><span>${tr('هذه الفترة', 'This period')}</span><span>${money(g)}</span></div><div><span>${tr('المحتجزات', 'Retention')}</span><span>- ${money(ret)}</span></div><div><span>${tr('الضريبة', 'VAT')}</span><span>${money(vat)}</span></div><div class="t"><span>${tr('المستحق الآن', 'Payable now')}</span><span>${money(g - ded - ret - adv + vat)}</span></div>`;
  };
  m.addEventListener('input', calc); calc();
  $('#cancel', m).onclick = () => { closeModal(); render(); };
  if ($('#save', m)) $('#save', m).onclick = guard(async () => {
    const b = { subcontract_id: sub.id }; ['date', 'cumulative', 'retention_pct', 'advance_recovery', 'deductions', 'vat_pct', 'notes'].forEach(k => b[k] = val(m, k));
    row ? await api('PUT', 'sub_certs/' + row.id, b) : await api('POST', 'sub_certs', b); closeModal(); render();
  });
  if (row) {
    $('#pr', m).onclick = () => window.open(`/api/doc/sub_certs/${row.id}?print=1`, '_blank'); $('#pdf', m).onclick = () => window.open(`/api/doc/sub_certs/${row.id}/pdf`, '_blank');
    if ($('#ap', m)) $('#ap', m).onclick = guard(async () => { if (confirm(tr('بعد الاعتماد لا يمكن التعديل، وسيُسجَّل مصروف على المشروع. متابعة؟', 'After approval it cannot be edited and a cost is booked to the project. Continue?'))) { await api('POST', `sub_certs/${row.id}/approve`); closeModal(); render(); } });
    if ($('#del', m)) $('#del', m).onclick = guard(async () => { if (confirmDel()) { await api('DELETE', 'sub_certs/' + row.id); closeModal(); render(); } });
  }
}

// ---- stock -------------------------------------------------------------------------------------------
PAGES.stock = async () => {
  const [items, moves, projects] = await Promise.all([api('GET', 'stock_items'), api('GET', 'stock_moves'), api('GET', 'projects')]);
  const c = await crud({ title: tr('المخزون ومواد الموقع', 'Stock & site materials'), table: 'stock_items', load: async () => items, noAdd: !canOps(), extra: `${canOps() ? `<button class="btn sec" id="mv">${tr('حركة مخزون', 'Stock movement')}</button>` : ''}${xl('stock')}`,
    fields: async () => [{ k: 'code', ar: 'الرمز', en: 'Code' }, { k: 'name', ar: 'الصنف', en: 'Item', req: 1 }, { k: 'unit', ar: 'الوحدة', en: 'Unit' }, { k: 'min_qty', ar: 'حد إعادة الطلب', en: 'Reorder level', type: 'number', def: 0 }, { k: 'location', ar: 'الموقع / المخزن', en: 'Location' }],
    cols: [{ ar: 'الرمز', en: 'Code', k: 'code' }, { ar: 'الصنف', en: 'Item', f: r => `${esc(r.name)} ${r.low ? `<span class="tag overdue">${tr('منخفض', 'Low')}</span>` : ''}` }, { ar: 'الوحدة', en: 'Unit', k: 'unit' }, { ar: 'الكمية', en: 'Qty', n: 1, f: r => money(r.qty) }, { ar: 'متوسط التكلفة', en: 'Avg cost', n: 1, f: r => money(r.avg_cost) }, { ar: 'القيمة', en: 'Value', n: 1, f: r => money(r.value) }] });
  document.querySelector('#main').insertAdjacentHTML('beforeend', `<h2 style="margin-top:18px">${tr('آخر الحركات', 'Recent movements')}</h2><div class="tw"><table><thead><tr><th>${tr('التاريخ', 'Date')}</th><th>${tr('الصنف', 'Item')}</th><th>${tr('النوع', 'Type')}</th><th class="n">${tr('الكمية', 'Qty')}</th><th class="n">${tr('التكلفة', 'Unit cost')}</th><th>${tr('المشروع', 'Project')}</th><th>${tr('مرجع', 'Ref')}</th></tr></thead><tbody>
    ${moves.slice(0, 60).map(x => `<tr><td>${esc(x.date)}</td><td>${esc(x.item_name)}</td><td>${{ in: tr('استلام', 'In'), out: tr('صرف', 'Out'), adjust: tr('تسوية', 'Adjust') }[x.type]}</td><td class="n">${money(x.qty)}</td><td class="n">${x.type === 'out' ? '' : money(x.unit_cost)}</td><td>${esc(x.project_name || '')}</td><td>${esc(x.ref || '')}</td></tr>`).join('') || `<tr><td colspan="7" class="muted">—</td></tr>`}</tbody></table></div>
    <p class="muted">${tr('المخزون هنا لمتابعة الكميات والتكلفة المتوسطة فقط؛ لا يُنشئ قيوداً مالية، فتكلفة المواد تُسجَّل عبر المصروفات وأوامر الشراء.', 'Stock tracks quantities and average cost only; it posts no accounting entries — material cost is booked through bills and purchase orders.')}</p>`);
  if ($('#mv')) $('#mv').onclick = () => simpleModal({ title: tr('حركة مخزون', 'Stock movement'), table: 'stock_moves', after: render, fields: [
    { k: 'item_id', ar: 'الصنف', en: 'Item', type: 'select', options: refOpts(items, i => `${i.name} (${money(i.qty)} ${i.unit || ''})`, false) }, { k: 'type', ar: 'النوع', en: 'Type', type: 'select', options: [['in', tr('استلام', 'Receive')], ['out', tr('صرف للمشروع', 'Issue to project')], ['adjust', tr('تسوية (+/−)', 'Adjustment (+/−)')]] },
    { k: 'qty', ar: 'الكمية', en: 'Quantity', type: 'number', def: 1 }, { k: 'unit_cost', ar: 'تكلفة الوحدة (للاستلام)', en: 'Unit cost (receipts)', type: 'number', def: 0 }, { k: 'date', ar: 'التاريخ', en: 'Date', type: 'date', def: today() },
    { k: 'project_id', ar: 'المشروع', en: 'Project', type: 'select', options: refOpts(projects, p => `${p.code || ''} ${p.name}`) }, { k: 'ref', ar: 'مرجع', en: 'Reference' }] });
};

// ---- fixed assets --------------------------------------------------------------------------------
PAGES.assets = async () => {
  const [rows, projects] = await Promise.all([api('GET', 'fixed_assets'), api('GET', 'projects')]);
  await crud({ title: tr('الأصول والمعدات', 'Assets & equipment'), table: 'fixed_assets', load: async () => rows, noAdd: !canFin(), extra: xl('assets'),
    intro: `<p class="muted">${tr('الإهلاك بالقسط الثابت شهرياً من شهر الشراء. عند شراء أصل سجّل فاتورة المورد بالبند "شراء أصل ثابت" حتى لا يُحتسب مصروفاً كاملاً، ويُدخل النظام الإهلاك في المحاسبة وضريبة الشركات.', 'Straight-line depreciation monthly from the month of purchase. When you buy an asset, record the supplier bill with category “Fixed asset purchase” so it is not expensed in full; depreciation flows into the ledger and corporate-tax estimate.')}</p>`,
    fields: async () => [{ k: 'name', ar: 'الأصل', en: 'Asset', req: 1 }, { k: 'category', ar: 'الفئة (معدات، مركبات…)', en: 'Category' }, { k: 'serial', ar: 'الرقم التسلسلي / اللوحة', en: 'Serial / plate' }, { k: 'purchase_date', ar: 'تاريخ الشراء', en: 'Purchase date', type: 'date' },
      { k: 'cost', ar: 'التكلفة', en: 'Cost', type: 'number', def: 0 }, { k: 'salvage', ar: 'القيمة التخريدية', en: 'Salvage value', type: 'number', def: 0 }, { k: 'life_years', ar: 'العمر الإنتاجي (سنوات)', en: 'Useful life (years)', type: 'number', def: 5 },
      { k: 'status', ar: 'الحالة', en: 'Status', type: 'select', options: [['active', tr(...STATUS.active)], ['disposed', tr(...STATUS.disposed)]] }, { k: 'disposal_date', ar: 'تاريخ الاستبعاد', en: 'Disposal date', type: 'date' },
      { k: 'project_id', ar: 'المشروع الحالي', en: 'Current project', type: 'select', options: refOpts(projects, p => `${p.code || ''} ${p.name}`) }, { k: 'notes', ar: 'ملاحظات', en: 'Notes', type: 'textarea', full: 1 }],
    cols: [{ ar: 'الأصل', en: 'Asset', k: 'name' }, { ar: 'الفئة', en: 'Category', k: 'category' }, { ar: 'تاريخ الشراء', en: 'Purchased', k: 'purchase_date' }, { ar: 'التكلفة', en: 'Cost', n: 1, f: r => money(r.cost) }, { ar: 'مجمع الإهلاك', en: 'Accum. dep.', n: 1, f: r => money(r.accumulated) },
      { ar: 'القيمة الدفترية', en: 'Net book value', n: 1, f: r => money(r.nbv) }, { ar: 'الحالة', en: 'Status', f: r => tag(r.status) }] });
};

// ---- petty cash ----------------------------------------------------------------------------------
PAGES.petty = async () => {
  const [st, projects] = await Promise.all([api('GET', 'petty_topups'), api('GET', 'projects')]);
  main(`<div class="bar"><h1>${tr('العهدة النقدية', 'Petty cash')}</h1><span class="sp"></span><button class="btn" id="top">+ ${tr('تغذية العهدة', 'Top up')}</button><button class="btn" id="exp">+ ${tr('مصروف نقدي', 'Cash expense')}</button></div>
  <div class="grid"><div class="kpi"><div class="l">${tr('رصيد العهدة', 'Petty cash balance')}</div><div class="v ${st.balance >= 0 ? 'ok' : 'bad'}">${money(st.balance)}</div></div></div>
  <div class="f2"><div><h2>${tr('التغذية', 'Top-ups')}</h2><div class="tw"><table><tbody>${st.topups.map(t => `<tr><td>${esc(t.date)}</td><td>${esc(t.note || '')}</td><td class="n">${money(t.amount)}</td><td><button class="btn sec sm" data-dt="${t.id}">×</button></td></tr>`).join('') || `<tr><td class="muted">—</td></tr>`}</tbody></table></div></div>
  <div><h2>${tr('المصروفات النقدية', 'Cash expenses')}</h2><div class="tw"><table><tbody>${st.expenses.map(x => `<tr><td>${esc(x.date)}</td><td>${esc(x.description || '')}</td><td class="n">${money(x.amount)}</td></tr>`).join('') || `<tr><td class="muted">—</td></tr>`}</tbody></table></div></div></div>
  <p class="muted">${tr('كل مصروف نقدي يُسجَّل تلقائياً كمصروف على المشروع (وضريبة المدخلات إن وُجدت) ويُسدَّد من العهدة. احتفظ بإيصال/فاتورة ضريبية لكل مصروف.', 'Every cash expense is booked as a project expense (with input VAT if any) and paid from the float. Keep a receipt/tax invoice for each one.')}</p>`);
  $('#top').onclick = () => simpleModal({ title: tr('تغذية العهدة', 'Top up petty cash'), table: 'petty_topups', after: render, fields: [{ k: 'date', ar: 'التاريخ', en: 'Date', type: 'date', def: today() }, { k: 'amount', ar: 'المبلغ', en: 'Amount', type: 'number', def: 0 }, { k: 'note', ar: 'ملاحظة', en: 'Note', full: 1 }] });
  $('#exp').onclick = () => {
    const f = [{ k: 'date', ar: 'التاريخ', en: 'Date', type: 'date', def: today() }, { k: 'description', ar: 'الوصف', en: 'Description', req: 1 }, { k: 'amount', ar: 'المبلغ (بدون ضريبة)', en: 'Amount (ex VAT)', type: 'number', def: 0 }, { k: 'vat_amount', ar: 'ضريبة القيمة المضافة', en: 'VAT', type: 'number', def: 0 },
      { k: 'category', ar: 'البند', en: 'Category', type: 'select', options: Object.entries(CATS).filter(([k]) => k !== 'asset').map(([k, v]) => [k, tr(...v)]) }, { k: 'project_id', ar: 'المشروع', en: 'Project', type: 'select', options: refOpts(projects, p => `${p.code || ''} ${p.name}`) }];
    const m = modal(`<h2>${tr('مصروف نقدي من العهدة', 'Petty cash expense')}</h2><div class="f2">${f.map(x => field(x, x.def)).join('')}</div><div class="acts"><button class="btn" id="save">${tr('حفظ', 'Save')}</button><button class="btn sec" id="cancel">${tr('إلغاء', 'Cancel')}</button></div>`);
    $('#cancel', m).onclick = closeModal;
    $('#save', m).onclick = guard(async () => { const b = {}; f.forEach(x => b[x.k] = val(m, x.k)); await api('POST', 'petty_topups/expense', b); closeModal(); render(); });
  };
  document.querySelectorAll('[data-dt]').forEach(b => b.onclick = guard(async () => { if (confirmDel()) { await api('DELETE', 'petty_topups/' + b.dataset.dt); render(); } }));
};
