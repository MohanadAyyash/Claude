// Post-dated cheque register, closed accounting period and backup status (Settings).
PAGES.cheques = async () => {
  const d = await api('GET', 'cheques'), fin = ['admin', 'accountant'].includes(ME.role), show = sessionStorage.pdcShow || 'pending', s = d.summary;
  const rows = d.rows.filter(r => show === 'all' || r.status === show || (show === 'pending' && r.status === 'pending'));
  const kpi = (l, v, cls = '') => `<div class="kpi"><div class="l">${l}</div><div class="v ${cls}">${typeof v === 'number' ? money(v) : v}</div></div>`;
  const ST = { pending: tr('مؤجل', 'Pending'), cleared: tr('محصَّل / مصروف', 'Cleared'), bounced: tr('مرتجع', 'Bounced') };
  const when = r => r.status !== 'pending' ? '' : r.overdue ? `<span class="neg">${tr('فات موعده منذ', 'past due by')} ${-r.days} ${tr('يوم', 'd')}</span>` : r.days === 0 ? `<b>${tr('اليوم', 'today')}</b>` : `${tr('بعد', 'in')} ${r.days} ${tr('يوم', 'd')}`;
  main(`<div class="bar"><h1>${tr('الشيكات المؤجلة', 'Post-dated cheques')}</h1><span class="sp"></span>
    <select id="pdcshow" style="width:auto"><option value="pending">${tr('المؤجلة فقط', 'Pending only')}</option><option value="cleared">${ST.cleared}</option><option value="bounced">${ST.bounced}</option><option value="all">${tr('الكل', 'All')}</option></select></div>
  <p class="muted">${tr('كل الشيكات المسجلة في المدفوعات والمقبوضات، مرتبة حسب تاريخ الاستحقاق. عند تحصيل الشيك أو صرفه غيّر حالته هنا؛ الشيك المؤجل لا يدخل في رصيد البنك حتى يُحصَّل.', 'Every cheque recorded under Payments, ordered by its date. When a cheque clears, change its status here; a pending cheque is not part of the bank balance until it clears.')}</p>
  <div class="grid">${kpi(tr('شيكات واردة مؤجلة', 'Cheques to collect'), s.in_pending, 'pos')}${kpi(tr('شيكات صادرة مؤجلة', 'Cheques to pay'), s.out_pending, 'neg')}${kpi(tr('تستحق لنا خلال ٧ أيام', 'To collect within 7 days'), s.in_week)}${kpi(tr('تستحق علينا خلال ٧ أيام', 'To pay within 7 days'), s.out_week, s.out_week > 0 ? 'neg' : '')}</div>
  <div class="tw"><table><thead><tr><th>${tr('تاريخ الاستحقاق', 'Cheque date')}</th><th></th><th>${tr('النوع', 'Type')}</th><th>${tr('الطرف', 'Party')}</th><th>${tr('رقم الشيك', 'Cheque no.')}</th><th>${tr('المستند', 'Document')}</th><th class="n">${tr('المبلغ', 'Amount')}</th><th>${tr('الحالة', 'Status')}</th></tr></thead><tbody>
  ${rows.map(r => `<tr><td>${esc(r.due)}</td><td>${when(r)}</td><td><span class="${r.kind === 'in' ? 'pos' : 'neg'}">${r.kind === 'in' ? tr('وارد', 'Received') : tr('صادر', 'Issued')}</span></td><td>${esc(r.party_name)}</td><td>${esc(r.reference)}</td><td>${esc(r.ref_label)}${r.project_name ? `<div class="muted">${esc(r.project_name)}</div>` : ''}</td><td class="n">${money(r.amount)}</td>
    <td>${fin ? `<select data-pdc="${r.id}" style="width:auto">${Object.keys(ST).map(k => `<option value="${k}" ${r.status === k ? 'selected' : ''}>${ST[k]}</option>`).join('')}</select>` : ST[r.status] || esc(r.status)}</td></tr>`).join('') || `<tr><td colspan="8" class="muted">${tr('لا توجد شيكات', 'No cheques')}</td></tr>`}
  </tbody></table></div>`);
  $('#pdcshow').value = show; $('#pdcshow').onchange = e => { sessionStorage.pdcShow = e.target.value; render(); };
  document.querySelectorAll('[data-pdc]').forEach(x => x.onchange = guard(async () => { await api('PUT', 'payments/' + x.dataset.pdc, { cheque_status: x.value }); toast(tr('تم التحديث', 'Updated')); render(); }));
};

// Settings → closed period (admin) and backups (admin). Called by the settings page with the element to fill.
window.controlsCards = async el => {
  if (ME.role !== 'admin') return;
  const [p, b] = await Promise.all([api('GET', 'period'), api('GET', 'backup/status')]), kb = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB';
  el.innerHTML = `<div class="card"><h2>${tr('إقفال الفترة المحاسبية', 'Close the accounting period')}</h2>
    <p class="muted">${tr('بعد تقديم الإقرار الضريبي أو اعتماد حسابات شهر، أقفل الفترة حتى تاريخ نهايتها: لا يمكن بعدها إضافة أو تعديل أو حذف أي فاتورة أو مصروف أو دفعة أو قيد أو رواتب بتاريخ يقع داخل الفترة المقفلة. التصحيح يكون بإشعار دائن أو قيد في الفترة المفتوحة. اترك التاريخ فارغاً لإعادة الفتح.', 'After filing the VAT return or approving a month, close the period up to its last day: no invoice, expense, payment, journal or payroll dated inside the closed period can then be added, changed or deleted. Corrections go through a credit note or a journal in the open period. Leave the date empty to reopen.')}</p>
    <p>${p.lock_date ? `🔒 ${tr('مقفلة حتى', 'Closed up to')} <b>${esc(p.lock_date)}</b>` : `<span class="muted">${tr('لا توجد فترة مقفلة', 'No period is closed')}</span>`}</p>
    <div class="f"><label>${tr('الإقفال حتى تاريخ', 'Close up to')}</label><input type="date" id="lockd" value="${esc(p.lock_date || '')}" max="${today()}"></div>
    <button class="btn sec" id="locksave">${tr('حفظ', 'Save')}</button></div>
  <div class="card"><h2>${tr('النسخ الاحتياطي التلقائي', 'Automatic backups')}</h2>
    <p class="${b.stale ? 'neg' : 'ok'}">${b.latest ? `${b.stale ? '⛔' : '✔'} ${tr('آخر نسخة', 'Last backup')}: <b>${esc(b.latest.at)}</b> (${kb(b.latest.size)})${b.stale ? ` — ${tr('قديمة، تحقق من جهاز الخادم', 'old — check the server')}` : ''}` : `⛔ ${tr('لا توجد نسخ احتياطية بعد', 'No backups yet')}`}</p>
    <p class="muted">${tr('يأخذ النظام نسخة كل يوم تلقائياً ويحتفظ بآخر', 'The system writes a backup every day and keeps the last')} ${b.keep_days} ${tr('يوماً في المجلد', 'days in')} <span dir="ltr">${esc(b.folder)}</span>. ${tr('نسخة على نفس الجهاز لا تحميك من تلف القرص أو السرقة: حدّد مجلداً ثانياً خارج الجهاز (قرص خارجي، مجلد OneDrive، مشاركة شبكة) لتُنسخ إليه كل نسخة.', 'A copy on the same PC does not protect you from a failed disk or theft: set a second folder off the machine (external disk, OneDrive folder, network share) and every backup is copied there too.')}</p>
    <div class="f"><label>${tr('مجلد النسخة الثانية (على جهاز الخادم)', 'Second copy folder (on the server PC)')}</label><input id="bkdir" dir="ltr" placeholder="D:\\ERP-Backups" value="${esc(b.copy_dir || '')}"></div>
    ${b.last_copy ? `<p class="${b.last_copy.ok ? 'ok' : 'neg'}">${b.last_copy.ok ? '✔' : '⛔'} ${tr('النسخ إلى المجلد الثاني', 'Copy to the second folder')}: ${esc(b.last_copy.at)}${b.last_copy.ok ? '' : ' — ' + esc(b.last_copy.error || '')}</p>` : ''}
    <button class="btn sec" id="bksave">${tr('حفظ المجلد', 'Save folder')}</button> <button class="btn sec" id="bknow">${tr('خذ نسخة الآن', 'Back up now')}</button>
    ${b.files.length ? `<details style="margin-top:10px"><summary>${tr('النسخ المحفوظة', 'Stored backups')} (${b.files.length})</summary><div class="tw"><table><tbody>${b.files.map(f => `<tr><td dir="ltr">${esc(f.name)}</td><td>${esc(f.at)}</td><td class="n">${kb(f.size)}</td></tr>`).join('')}</tbody></table></div></details>` : ''}
    <p class="muted" style="margin-top:10px">${tr('للاستعادة: شغّل Trigon-Restore.bat على جهاز الخادم واختر النسخة.', 'To restore: run Trigon-Restore.bat on the server PC and choose the backup.')}</p></div>`;
  $('#locksave', el).onclick = guard(async () => {
    const d = $('#lockd', el).value;
    if (!confirm(d ? tr(`إقفال كل الحركات حتى ${d}؟`, `Close everything up to ${d}?`) : tr('إعادة فتح كل الفترات؟', 'Reopen all periods?'))) return;
    await api('PUT', 'period', { lock_date: d }); toast(tr('تم الحفظ', 'Saved')); controlsCards(el);
  });
  $('#bksave', el).onclick = guard(async () => { await api('PUT', 'settings', { backup_copy_dir: $('#bkdir', el).value.trim() }); toast(tr('تم الحفظ', 'Saved')); controlsCards(el); });
  $('#bknow', el).onclick = guard(async () => { await api('PUT', 'settings', { backup_copy_dir: $('#bkdir', el).value.trim() }); await api('POST', 'backup/run'); toast(tr('تم أخذ النسخة', 'Backup written')); controlsCards(el); });
};
