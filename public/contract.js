// Project contract terms card: advance payment (invoice + recovery progress) and the two-stage retention release schedule.
Object.assign(ALERT, {
  retention_handover: a => `${tr('محتجزات مستحقة عند التسليم', 'Retention due at handover')} — ${a.who}: ${money(a.amount)} (${a.date})`,
  retention_dlp: a => `${tr('محتجزات مستحقة بعد فترة الصيانة', 'Retention due after the defects period')} — ${a.who}: ${money(a.amount)} (${a.date})`,
});
const baseProjectDetail = projectDetail;
projectDetail = async id => {
  await baseProjectDetail(id);
  const s = await api('GET', `projects/${id}/contract`).catch(() => null); if (!s || !$('#main')) return;
  const A = s.advance, R = s.retention, fin = ['admin', 'accountant'].includes(ME.role);
  const pct = A.invoiced ? Math.min(100, A.recovered / A.invoiced * 100) : 0;
  const row = (l, v, c = '') => `<tr><td>${l}</td><td class="n ${c}">${v}</td></tr>`;
  const card = document.createElement('div'); card.className = 'card'; card.id = 'contract-card';
  card.innerHTML = `<h2>${tr('الدفعة المقدمة والمحتجزات', 'Advance payment & retention')}</h2><div class="f2">
    <div><h3>${tr('الدفعة المقدمة', 'Advance payment')} ${A.pct ? `(${A.pct}% — ${tr('استرداد', 'recovered at')} ${A.recovery_pct}%)` : ''}</h3>
      ${A.invoiced ? `<table>${row(tr('فاتورة المقدمة', 'Advance invoiced'), money(A.invoiced))}${row(tr('المسترد من المستخلصات', 'Recovered from progress invoices'), money(A.recovered))}${row(tr('المتبقي للاسترداد', 'Still to recover'), money(A.remaining), A.remaining > 0 ? 'warn' : 'pos')}</table>
        <div style="background:#e6e2d8;border-radius:6px;height:8px;margin:8px 0"><div style="background:#2e7d4f;height:8px;border-radius:6px;width:${pct}%"></div></div>
        ${A.invoices.map(i => `<a href="#" onclick="openInvoice(${i.id});return false">${esc(i.number)}</a> ${tag(i.status)}`).join(' ')}`
      : A.pct ? (fin ? `<p class="muted">${tr('لم تُصدر فاتورة الدفعة المقدمة بعد. تُحسب عليها الضريبة، وتُسترد تلقائياً من كل فاتورة إنجاز.', 'No advance invoice yet. VAT applies to it, and it is recovered automatically from each progress invoice.')}</p><button class="btn sm" id="advinv">${tr('إصدار فاتورة الدفعة المقدمة', 'Issue the advance payment invoice')}</button>` : '')
      : `<p class="muted">${tr('لا توجد دفعة مقدمة في هذا العقد. حدّدها من «تعديل» المشروع.', 'No advance payment on this contract. Set it under Edit project.')}</p>`}</div>
    <div><h3>${tr('المحتجزات', 'Retention')}</h3><table>${row(tr('المحتجز حتى الآن', 'Held so far'), money(R.held))}${row(tr('المفرج عنه', 'Released'), money(R.released), 'pos')}
      ${row(`${tr('عند التسليم', 'At handover')} (${R.handover.pct}%) ${R.handover.date ? esc(R.handover.date) : `<span class="muted">${tr('تاريخ غير محدد', 'date not set')}</span>`}`, money(R.handover.outstanding), R.handover.date && R.handover.date <= today() && R.handover.outstanding > 0 ? 'neg' : '')}
      ${row(`${tr('بعد فترة الصيانة', 'After the defects period')} (${R.dlp.months} ${tr('شهر', 'months')}) ${R.dlp.date ? esc(R.dlp.date) : ''}`, money(R.dlp.outstanding), R.dlp.date && R.dlp.date <= today() && R.dlp.outstanding > 0 ? 'neg' : '')}</table>
      <p class="muted" style="font-size:12px">${tr('تُسجَّل دفعة الإفراج كمقبوض على الفاتورة مع خيار «دفعة تحرير محتجزات».', 'Record a release as a receipt on the invoice with “This is a retention release”.')}</p></div></div>`;
  const grid = $('#main .grid'); grid.after(card);
  if ($('#advinv')) $('#advinv').onclick = guard(async () => {
    if (!confirm(tr('إصدار فاتورة ضريبية للدفعة المقدمة؟', 'Issue a tax invoice for the advance payment?'))) return;
    const r = await api('POST', `projects/${id}/advance-invoice`, {}); toast(`${tr('تم الإصدار', 'Issued')} ${money(r.amount)}`); projectDetail(id);
  });
};
