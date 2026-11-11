// Spend approvals: purchase orders and supplier payments above the limits set in Settings.
PAGES.spend = async () => {
  const d = await api('GET', 'spend-approvals'), ST = { pending: tr('بانتظار الاعتماد', 'Waiting'), approved: tr('معتمد', 'Approved'), rejected: tr('مرفوض', 'Rejected') };
  const KIND = { po: tr('أمر شراء', 'Purchase order'), payment: tr('دفعة لمورد', 'Supplier payment') }, off = !d.limits.po && !d.limits.payment;
  const lim = v => v ? money(v) : `<span class="muted">${tr('غير مفعّل', 'off')}</span>`;
  main(`<div class="bar"><h1>${tr('اعتماد المشتريات والمدفوعات', 'Spend approvals')}</h1></div>
  <p class="muted">${tr('أوامر الشراء والدفعات للموردين التي تتجاوز الحد المحدد في الإعدادات تحتاج اعتماد مدير النظام قبل إصدارها أو صرفها. اطلب الاعتماد من هنا، والمدير يعتمد أو يرفض من نفس الشاشة.', 'Purchase orders and supplier payments above the limit set in Settings need the administrator\'s approval before they are issued or paid. Ask for approval here; the administrator approves or rejects on the same screen.')}</p>
  <p>${tr('حد أمر الشراء', 'Purchase order limit')}: <b>${lim(d.limits.po)}</b> &nbsp;·&nbsp; ${tr('حد الدفعة', 'Payment limit')}: <b>${lim(d.limits.payment)}</b>${off ? ` — <span class="neg">${tr('الاعتماد غير مفعّل. فعّله من الإعدادات بتحديد الحدود.', 'Approval is switched off. Set the limits in Settings to switch it on.')}</span>` : ''}</p>
  ${d.need_po.length || d.need_pay.length ? `<div class="card"><h2>${tr('يحتاج طلب اعتماد', 'Needs an approval request')}</h2><div class="tw"><table><thead><tr><th>${tr('النوع', 'Type')}</th><th>${tr('المستند', 'Document')}</th><th class="n">${tr('المبلغ', 'Amount')}</th><th></th></tr></thead><tbody>
    ${d.need_po.map(p => `<tr><td>${KIND.po}</td><td>${esc(p.number)} — ${esc(p.supplier_name || '')}${p.project_name ? `<div class="muted">${esc(p.project_name)}</div>` : ''}</td><td class="n">${money(p.total)}</td><td><button class="btn sec" data-req="po" data-id="${p.id}">${tr('اطلب الاعتماد', 'Ask for approval')}</button></td></tr>`).join('')}
    ${d.need_pay.map(b => `<tr><td>${KIND.payment}</td><td>${esc(b.label)}${b.project_name ? `<div class="muted">${esc(b.project_name)}</div>` : ''}</td><td class="n">${money(b.balance)}<div class="muted">${tr('الرصيد المفتوح', 'open balance')}</div></td><td><button class="btn sec" data-req="payment" data-id="${b.id}" data-max="${b.balance}">${tr('اطلب اعتماد الدفع', 'Ask to pay')}</button></td></tr>`).join('')}
    </tbody></table></div></div>` : ''}
  <div class="card" style="margin-top:16px"><h2>${tr('الطلبات', 'Requests')}</h2><div class="tw"><table><thead><tr><th>${tr('التاريخ', 'Date')}</th><th>${tr('النوع', 'Type')}</th><th>${tr('المستند', 'Document')}</th><th class="n">${tr('المبلغ', 'Amount')}</th><th>${tr('الطالب', 'By')}</th><th>${tr('الحالة', 'Status')}</th><th></th></tr></thead><tbody>
    ${d.rows.map(r => `<tr><td>${esc(r.requested_at || '')}</td><td>${KIND[r.kind] || esc(r.kind)}</td><td>${esc(r.label)}${r.project_name ? `<div class="muted">${esc(r.project_name)}</div>` : ''}${r.note ? `<div class="muted">${esc(r.note)}</div>` : ''}${r.stale ? `<div class="neg">${tr('تغيّر أمر الشراء بعد الطلب', 'the order changed after the request')}</div>` : ''}</td>
      <td class="n">${money(r.amount)}</td><td>${esc(r.requested_by || '')}</td><td><span class="${r.status === 'approved' ? 'ok' : r.status === 'rejected' ? 'neg' : ''}">${ST[r.status] || esc(r.status)}</span>${r.decided_by ? `<div class="muted">${esc(r.decided_by)} · ${esc(r.decided_at || '')}${r.decision_note && r.status === 'rejected' ? ' · ' + esc(r.decision_note) : ''}</div>` : ''}</td>
      <td>${r.status === 'pending' ? (d.can_decide ? `<button class="btn" data-dec="approved" data-id="${r.id}">${tr('اعتماد', 'Approve')}</button> <button class="btn bad" data-dec="rejected" data-id="${r.id}">${tr('رفض', 'Reject')}</button>` : (r.requested_by_id === ME.id ? `<button class="btn sec" data-wd="${r.id}">${tr('سحب الطلب', 'Withdraw')}</button>` : '')) : ''}</td></tr>`).join('') || `<tr><td colspan="7" class="muted">${tr('لا توجد طلبات', 'No requests')}</td></tr>`}
  </tbody></table></div></div>`);
  document.querySelectorAll('[data-req]').forEach(x => x.onclick = guard(async () => {
    const body = { kind: x.dataset.req, ref_id: +x.dataset.id };
    if (body.kind === 'payment') { const a = prompt(tr('المبلغ المطلوب اعتماد دفعه:', 'Amount to approve for payment:'), x.dataset.max); if (a === null) return; body.amount = +a; }
    const note = prompt(tr('ملاحظة للمدير (اختياري):', 'Note for the administrator (optional):')); if (note === null) return; body.note = note;
    await api('POST', 'spend-approvals', body); toast(tr('أُرسل الطلب', 'Request sent')); render();
  }));
  document.querySelectorAll('[data-dec]').forEach(x => x.onclick = guard(async () => {
    const note = x.dataset.dec === 'rejected' ? prompt(tr('سبب الرفض:', 'Reason for rejecting:')) : ''; if (note === null) return;
    await api('PUT', 'spend-approvals/' + x.dataset.id, { status: x.dataset.dec, note }); toast(tr('تم', 'Done')); render();
  }));
  document.querySelectorAll('[data-wd]').forEach(x => x.onclick = guard(async () => { await api('DELETE', 'spend-approvals/' + x.dataset.wd); render(); }));
};

// Settings → approval limits (administrator). Called by controlsCards' host element.
window.spendCard = el => {
  if (ME.role !== 'admin') return;
  el.insertAdjacentHTML('beforeend', `<div class="card"><h2>${tr('حدود اعتماد المشتريات والمدفوعات', 'Spend approval limits')}</h2>
    <p class="muted">${tr('أي أمر شراء أو دفعة لمورد أعلى من الحد يحتاج اعتمادك قبل الإصدار أو الصرف. اترك الحقل فارغاً أو صفراً لإيقاف الاعتماد.', 'Any purchase order or supplier payment above the limit needs your approval before it is issued or paid. Leave empty or 0 to switch the approval off.')}</p>
    <div class="f2"><div class="f"><label>${tr('حد أمر الشراء (شامل الضريبة)', 'Purchase order limit (incl. VAT)')}</label><input type="number" step="any" min="0" id="splpo" value="${esc(S.po_approval_limit || '')}"></div>
    <div class="f"><label>${tr('حد الدفعة للمورد', 'Supplier payment limit')}</label><input type="number" step="any" min="0" id="splpay" value="${esc(S.pay_approval_limit || '')}"></div></div>
    <button class="btn sec" id="splsave">${tr('حفظ الحدود', 'Save limits')}</button></div>`);
  $('#splsave', el).onclick = guard(async () => { const b = { po_approval_limit: $('#splpo', el).value, pay_approval_limit: $('#splpay', el).value }; await api('PUT', 'settings', b); Object.assign(S, b); toast(tr('تم الحفظ', 'Saved')); });
};
