// Ageing of receivables / payables and the statement of account per customer or supplier (print, PDF, e-mail).
const AGE_COLS = [['current', 'غير مستحق بعد', 'Not due'], ['d30', '١–٣٠ يوم', '1–30 days'], ['d60', '٣١–٦٠', '31–60'], ['d90', '٦١–٩٠', '61–90'], ['d90p', 'أكثر من ٩٠', '90+']];
PAGES.aging = async id => {
  if (id) return statementPage(+id);
  const type = sessionStorage.ageType || 'receivable', asOf = sessionStorage.ageDate || today();
  const d = await api('GET', `aging/${type}?as_of=${asOf}`), rec = type === 'receivable';
  const cell = (v, warn) => `<td class="n ${warn && v > 0 ? 'neg' : ''}">${v ? money(v) : '<span class="muted">—</span>'}</td>`;
  main(`<div class="bar"><h1>${tr('أعمار الديون وكشوف الحساب', 'Ageing & statements')}</h1><span class="sp"></span>
    <select id="ty" style="width:auto"><option value="receivable" ${rec ? 'selected' : ''}>${tr('مستحق لنا (العملاء)', 'Receivables (customers)')}</option><option value="payable" ${rec ? '' : 'selected'}>${tr('مستحق علينا (الموردون)', 'Payables (suppliers)')}</option></select>
    <label class="muted">${tr('حتى تاريخ', 'As of')}</label><input type="date" id="asof" value="${esc(asOf)}" style="width:auto"></div>
  <p class="muted">${rec ? tr('المبالغ موزعة حسب أيام التأخير عن تاريخ الاستحقاق. المحتجزات غير المستحقة بعد في عمود منفصل. اضغط على العميل لكشف حسابه.', 'Amounts are split by days past the due date. Retention not yet due is shown apart. Click a customer for the statement.') : tr('موزعة حسب عمر الفاتورة من تاريخها. اضغط على المورد لكشف حسابه.', 'Split by the age of the bill from its date. Click a supplier for the statement.')}</p>
  <div class="tw"><table><thead><tr><th>${rec ? tr('العميل', 'Customer') : tr('المورد', 'Supplier')}</th>${AGE_COLS.map(c => `<th class="n">${tr(c[1], c[2])}</th>`).join('')}<th class="n">${tr('الإجمالي', 'Total')}</th>${rec ? `<th class="n">${tr('محتجزات', 'Retention')}</th>` : ''}</tr></thead><tbody>
  ${d.rows.map(r => `<tr class="click" data-p="${r.party_id}"><td>${esc(r.name)}</td>${AGE_COLS.map(c => cell(r[c[0]], c[0] !== 'current')).join('')}<td class="n"><b>${money(r.total)}</b></td>${rec ? cell(r.retention) : ''}</tr>`).join('') || `<tr><td colspan="8" class="muted">${tr('لا توجد أرصدة مفتوحة', 'No open balances')}</td></tr>`}</tbody>
  <tfoot><tr><td><b>${tr('الإجمالي', 'Total')}</b></td>${AGE_COLS.map(c => `<td class="n"><b>${money(d.totals[c[0]])}</b></td>`).join('')}<td class="n"><b>${money(d.totals.total)}</b></td>${rec ? `<td class="n"><b>${money(d.totals.retention)}</b></td>` : ''}</tr></tfoot></table></div>`);
  $('#ty').onchange = e => { sessionStorage.ageType = e.target.value; render(); };
  $('#asof').onchange = e => { sessionStorage.ageDate = e.target.value; render(); };
  document.querySelectorAll('tr[data-p]').forEach(r => r.onclick = () => go('aging/' + r.dataset.p));
};
async function statementPage(id) {
  const to = sessionStorage.stTo || today(), from = sessionStorage.stFrom || '';
  const s = await api('GET', `statement/${id}?to=${to}${from ? '&from=' + from : ''}`), qs = `to=${to}${from ? '&from=' + from : ''}`;
  main(`<div class="bar"><button class="btn sec" onclick="go('aging')">←</button><h1 style="margin:0">${tr('كشف حساب', 'Statement of account')} — ${esc(s.party.name)}</h1><span class="sp"></span>
    <a class="btn sec" target="_blank" href="/api/doc/statement/${id}?${qs}&print=1">${tr('طباعة', 'Print')}</a><a class="btn sec" target="_blank" href="/api/doc/statement/${id}/pdf?${qs}">PDF</a>
    ${['admin', 'accountant'].includes(ME.role) ? `<button class="btn" id="mail">✉ ${tr('إرسال بالبريد', 'Email')}</button>` : ''}</div>
  <div class="bar"><label class="muted">${tr('من', 'From')}</label><input type="date" id="sf" value="${esc(from)}" style="width:auto"><label class="muted">${tr('إلى', 'To')}</label><input type="date" id="st" value="${esc(to)}" style="width:auto"></div>
  <div class="tw"><table><thead><tr><th>${tr('التاريخ', 'Date')}</th><th>${tr('المرجع', 'Ref')}</th><th>${tr('البيان', 'Description')}</th><th class="n">${tr('مدين', 'Debit')}</th><th class="n">${tr('دائن', 'Credit')}</th><th class="n">${tr('الرصيد', 'Balance')}</th></tr></thead><tbody>
  ${from ? `<tr><td>${esc(from)}</td><td></td><td>${tr('رصيد افتتاحي', 'Opening balance')}</td><td></td><td></td><td class="n">${money(s.opening)}</td></tr>` : ''}
  ${s.lines.map(l => `<tr><td>${esc(l.date)}</td><td>${esc(l.ref)}</td><td>${esc(l.description)}</td><td class="n">${l.debit ? money(l.debit) : ''}</td><td class="n">${l.credit ? money(l.credit) : ''}</td><td class="n">${money(l.balance)}</td></tr>`).join('') || `<tr><td colspan="6" class="muted">—</td></tr>`}</tbody>
  <tfoot><tr><td colspan="5"><b>${s.supplier ? tr('الرصيد المستحق للمورد', 'Balance owed to the supplier') : tr('الرصيد المستحق على العميل', 'Balance due from the customer')}</b></td><td class="n"><b>${money(s.closing)}</b></td></tr></tfoot></table></div>
  ${s.aging ? `<div class="grid" style="margin-top:12px">${AGE_COLS.map(c => `<div class="kpi"><div class="l">${tr(c[1], c[2])}</div><div class="v ${c[0] !== 'current' && s.aging[c[0]] > 0 ? 'bad' : ''}">${money(s.aging[c[0]])}</div></div>`).join('')}${s.supplier ? '' : `<div class="kpi"><div class="l">${tr('محتجزات غير مستحقة', 'Retention not yet due')}</div><div class="v">${money(s.aging.retention)}</div></div>`}</div>` : ''}`);
  $('#sf').onchange = e => { sessionStorage.stFrom = e.target.value; render(); };
  $('#st').onchange = e => { sessionStorage.stTo = e.target.value || today(); render(); };
  if ($('#mail')) $('#mail').onclick = guard(async () => {
    const addr = prompt(tr('البريد الإلكتروني للمستلم:', 'Recipient e-mail:'), s.party.email || ''); if (!addr) return;
    const r = await api('POST', `statement/${id}/email`, { to: addr, to_date: to, from: from || undefined });
    toast(r.attached ? tr('أُرسل الكشف مع ملف PDF', 'Statement sent with PDF') : tr('أُرسل (بدون PDF — لا يوجد متصفح على الخادم)', 'Sent (without PDF — no browser on the server)'));
  });
}
