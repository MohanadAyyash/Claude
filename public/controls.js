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

// Settings → two-step sign-in (every user, own account).
window.twoStepCard = async el => {
  const st = await api('GET', '2fa'), admin = ['admin', 'accountant'].includes(ME.role);
  const head = `<h2>${tr('التحقق بخطوتين عند الدخول', 'Two-step sign-in')}</h2>`;
  if (st.enabled) {
    el.innerHTML = `<div class="card">${head}<p class="ok">✔ ${tr('مفعّل: الدخول يطلب كلمة المرور ثم رمزاً من تطبيق المصادقة على هاتفك.', 'On: signing in asks for the password, then a code from the authenticator app on your phone.')}</p>
      <div class="f"><input type="password" id="tfapw" autocomplete="current-password" placeholder="${tr('كلمة المرور الحالية', 'Current password')}"></div><button class="btn sec" id="tfaoff">${tr('إيقاف', 'Switch off')}</button></div>`;
    $('#tfaoff', el).onclick = guard(async () => { await api('POST', '2fa/disable', { password: $('#tfapw', el).value }); toast(tr('تم الإيقاف', 'Switched off')); twoStepCard(el); });
    return;
  }
  el.innerHTML = `<div class="card">${head}<p class="muted">${tr('حماية إضافية للحساب: حتى لو عُرفت كلمة المرور لا يمكن الدخول بدون هاتفك. تحتاج تطبيق مصادقة مجاني مثل Google Authenticator أو Microsoft Authenticator.', 'Extra protection: even with your password, nobody signs in without your phone. You need a free authenticator app such as Google Authenticator or Microsoft Authenticator.')}${admin ? ` <b>${tr('موصى به لحسابك لأنه يملك صلاحيات مالية.', 'Recommended for your account because it has financial permissions.')}</b>` : ''}</p>
    <button class="btn sec" id="tfaon">${tr('تفعيل', 'Switch on')}</button><div id="tfastep"></div></div>`;
  $('#tfaon', el).onclick = guard(async () => {
    const s = await api('POST', '2fa/setup', {}), key = s.secret.replace(/(.{4})/g, '$1 ').trim();
    $('#tfastep', el).innerHTML = `<ol style="margin:12px 0;padding-inline-start:20px;line-height:1.9">
      <li>${tr('افتح تطبيق المصادقة على هاتفك واختر «إضافة حساب» ثم «إدخال مفتاح الإعداد» (أو افتح هذه الصفحة من الهاتف واضغط الرابط).', 'Open the authenticator app on your phone, choose “Add account”, then “Enter a setup key” (or open this page on the phone and tap the link).')}</li>
      <li>${tr('اسم الحساب', 'Account name')}: <b dir="ltr">${esc(ME.username)}</b> — ${tr('المفتاح', 'Key')}: <b dir="ltr" style="font-family:monospace;user-select:all">${esc(key)}</b> — ${tr('النوع: حسب الوقت', 'Type: time-based')}<br><a href="${esc(s.uri)}">${tr('إضافة مباشرة من هذا الهاتف', 'Add directly from this phone')}</a></li>
      <li>${tr('اكتب الرمز المكوّن من ٦ أرقام الذي يظهر في التطبيق:', 'Type the 6-digit code the app shows:')}</li></ol>
      <div class="f"><input id="tfacode" inputmode="numeric" maxlength="7" dir="ltr" autocomplete="one-time-code" placeholder="123456"></div><button class="btn" id="tfago">${tr('تأكيد وتفعيل', 'Confirm and switch on')}</button>`;
    $('#tfaon', el).style.display = 'none';
    $('#tfago', el).onclick = guard(async () => { await api('POST', '2fa/enable', { code: $('#tfacode', el).value }); toast(tr('تم التفعيل', 'Two-step sign-in is on')); twoStepCard(el); });
  });
};

// Settings → Microsoft 365 link (administrator). Shown only when the server has the integration switched on.
window.m365Card = async el => {
  // every user, own account only (Phase 1C). No tenant or object IDs, tokens or server settings here; e-mail / name for information only.
  const s = await api('GET', 'm365/status').catch(() => null); if (!s || !s.enabled) { el.innerHTML = ''; return; }
  const head = `<h2>${tr('حساب Microsoft 365', 'Microsoft 365 account')}</h2>`;
  if (!s.configured) {
    el.innerHTML = ME.role === 'admin'
      ? `<div class="card">${head}<p class="neg">⛔ ${tr('الربط مفعّل لكن إعدادات الخادم ناقصة', 'The link is switched on but the server settings are incomplete')}: <span dir="ltr">${esc((s.missing || []).join(', '))}</span></p><p class="muted">${tr('تُضبط في ملف .env على جهاز الخادم ثم يُعاد تشغيل النظام.', 'They are set in the .env file on the server PC, then the system is restarted.')}</p></div>`
      : '';                                                                    // users: nothing to do until the administrator finishes the set-up
    return;
  }
  const c = s.connection;
  // administrators: the sign-in mode and the emergency accounts (names and problems only)
  const au = ME.role === 'admin' && s.auth, modeName = m => m === 'microsoft-first' ? tr('Microsoft أولاً', 'Microsoft first') : tr('مختلط (Microsoft + كلمة المرور)', 'Hybrid (Microsoft + password)');
  const authLine = au ? `<p class="muted">${tr('طريقة الدخول', 'Sign-in mode')}: <b>${modeName(au.mode)}</b>${au.requested !== au.mode ? ` — <span class="neg">${tr('المطلوب', 'requested')}: ${esc(au.requested)}; ${esc(au.reason || '')}</span>` : ''}
    ${au.emergency_admins.length ? `<br>${tr('مسؤولو الطوارئ', 'Emergency administrators')}: ${au.emergency_admins.map(e => `<span dir="ltr">${esc(e.username)}</span> ${e.ok ? '✔' : `<span class="neg">✖ ${esc(e.problems.join(', '))}</span>`}`).join(' · ')}` : ''}</p>` : '';
  el.innerHTML = `<div class="card">${head}${authLine}
    <p class="muted">${tr('اربط حسابك في النظام بحساب Microsoft الخاص بك لتتمكن من الدخول بزر «تسجيل الدخول باستخدام Microsoft». صلاحياتك في النظام لا تتغير، والدخول بكلمة المرور يبقى متاحاً. الصلاحية المطلوبة من Microsoft: قراءة ملفك الشخصي فقط.', 'Link your account in the system to your own Microsoft account to use "Sign in with Microsoft". Your permissions in the system do not change and the password sign-in stays available. Microsoft permission asked: read your profile only.')}</p>
    ${c ? `<p class="ok">✔ ${tr('مرتبط', 'Connected')}: <b dir="ltr">${esc(c.email || '')}</b>${c.display_name ? ' — ' + esc(c.display_name) : ''} <span class="muted">(${esc((c.linked_at || '').slice(0, 16).replace('T', ' '))})</span></p>
      <button class="btn sec" id="m365chk">${tr('فحص الربط', 'Check the link')}</button> <button class="btn bad" id="m365off">${tr('فصل الربط', 'Disconnect')}</button>
      <p class="muted" style="margin-top:8px">${tr('فصل الربط يحذفه مع رموز الدخول من نظام تريجون فوراً (لن يعمل الدخول باستخدام Microsoft لحسابك بعده). موافقتك على التطبيق تبقى في Microsoft حتى تزيلها من حساب Microsoft (My Apps) أو يزيلها مسؤول Entra.', 'Disconnecting removes the link and its tokens from Trigon ERP at once ("Sign in with Microsoft" stops working for your account). Your consent to the app stays in Microsoft until you remove it in your Microsoft account (My Apps) or an Entra administrator does.')}</p>`
      : `<p>${tr('غير مرتبط', 'Not connected')}</p><a class="btn" href="/auth/microsoft" style="text-decoration:none;display:inline-block">${tr('ربط حساب Microsoft', 'Connect Microsoft account')}</a>`}</div>`;
  { const ib = document.createElement('div'); el.appendChild(ib); if (window.m365IntegrationsCard) m365IntegrationsCard(ib).catch(() => {}); }   // SharePoint / Outlook / Teams
  if ($('#m365chk', el)) $('#m365chk', el).onclick = guard(async () => { const r = await api('POST', 'm365/check', {}); toast(`✔ ${r.email || r.display_name || 'OK'}`); });
  if ($('#m365off', el)) $('#m365off', el).onclick = guard(async () => { if (!confirm(tr('فصل حساب Microsoft عن حسابك في نظام تريجون؟ (الموافقة في Microsoft لا تُلغى من هنا)', 'Disconnect the Microsoft account from your Trigon ERP account? (Consent in Microsoft is not revoked from here)'))) return; await api('POST', 'm365/disconnect', {}); toast(tr('تم فصل الربط', 'Disconnected')); m365Card(el); });
};

// ---- Microsoft 365 business integration (SharePoint copy / Outlook) inside a record, and the integrations in Settings ----
// Everything is decided on the server (role, project, record state); the browser only shows the state and asks.
let m365IntCache = null;
const m365Ints = async (fresh) => (!fresh && m365IntCache) || (m365IntCache = await api('GET', 'm365/integrations').catch(() => null));
window.m365DocPanel = async (el, entity, id) => {
  const st = await m365Ints(); if (!st || window.STANDALONE) return;
  const canMail = st.outlook.enabled && ['purchase_orders', 'rfqs', 'quotes', 'invoices'].includes(entity), canSp = st.sharepoint.configured && entity !== 'rfqs';
  if (!canMail && !canSp) return;
  let box = el; if (el.classList.contains('overlay')) { box = document.createElement('div'); box.className = 'card'; const mod = el.querySelector('.modal'); mod.insertBefore(box, mod.querySelector('.acts')); }
  const draw = async () => {
    const d = canSp ? await api('GET', `m365/documents/${entity}/${id}`).catch(() => null) : null;
    const at = x => esc((x || '').slice(0, 16).replace('T', ' ')), retry = d && d.next_attempt_at ? ` · ${tr('محاولة تلقائية', 'next automatic try')} ${at(d.next_attempt_at)}` : '';
    const stLine = !d ? '' : d.status === 'uploaded' ? `<p class="ok">✔ ${tr('محفوظ في SharePoint', 'Saved in SharePoint')}${d.web_url ? ` — <a href="${esc(d.web_url)}" target="_blank" rel="noopener noreferrer">${tr('فتح', 'Open')}</a>` : ''} <span class="muted">${at(d.uploaded_at)} · ${esc(d.uploaded_by || '')}</span></p>`
      : d.status === 'failed' ? `<p class="neg">✖ ${tr('فشل الحفظ في SharePoint', 'SharePoint upload failed')}: ${esc(d.error || '')}<span class="muted">${retry || (d.auto ? ' · ' + tr('لا إعادة تلقائية — راجع السبب', 'no automatic retry — check the reason') : '')}</span></p>`
      : d.status === 'queued' ? `<p class="muted">⏳ ${tr('في قائمة الحفظ التلقائي في SharePoint', 'Queued: will be saved to SharePoint automatically')}${d.error ? ` · ${tr('المحاولة السابقة', 'last attempt')}: ${esc(d.error)}` : ''}${retry}</p>`
      : d.status === 'uploading' ? `<p class="muted">${tr('جارٍ الحفظ…', 'Uploading…')}</p>`
      : `<p class="muted">${d.auto && d.ready ? '⏳ ' + tr('سيُحفظ في SharePoint تلقائياً خلال دقائق', 'Will be saved to SharePoint automatically within minutes') : tr('غير محفوظ في SharePoint', 'Not in SharePoint')}</p>`;
    const upLabel = d && (d.status === 'failed' ? tr('إعادة المحاولة الآن', 'Retry now') : d.status === 'uploaded' ? tr('تحديث النسخة', 'Update the copy') : d.auto ? tr('حفظ الآن', 'Save now') : tr('حفظ في SharePoint', 'Save to SharePoint'));
    const upBtn = d && d.can_upload ? (d.ready ? `<button type="button" class="btn sec sm" id="m365up">${upLabel}</button>` : `<span class="muted">${esc(d.why_not || '')}</span>`) : '';
    const mailBtn = canMail ? (st.me.can_send_mail ? `<button type="button" class="btn sec sm" id="m365mail">${tr('إرسال عبر Outlook', 'Send via Outlook')}</button>`
      : `<span class="muted">${st.me.linked ? tr('للإرسال عبر Outlook: افصل حساب Microsoft ثم اربطه من جديد في الإعدادات.', 'To send through Outlook: Disconnect and Connect your Microsoft account again in Settings.') : tr('للإرسال عبر Outlook اربط حساب Microsoft في الإعدادات.', 'To send through Outlook, connect your Microsoft account in Settings.')}</span>`) : '';
    box.innerHTML = `<h2>Microsoft 365</h2>${stLine}<div>${upBtn} ${mailBtn}</div>`;
    if ($('#m365up', box)) $('#m365up', box).onclick = guard(async () => { await api('POST', `m365/documents/${entity}/${id}/upload`, {}); toast(tr('تم الحفظ في SharePoint', 'Saved in SharePoint')); draw(); });
    if ($('#m365mail', box)) $('#m365mail', box).onclick = guard(async () => {
      const to = prompt(tr('أرسل إلى (بريد أو أكثر، مفصولة بفاصلة):', 'Send to (one or more e-mail addresses, comma-separated):'), ''); if (!to) return;
      const message = prompt(tr('رسالة (اختياري):', 'Message (optional):'), '') || '';
      const go = confirm_resend => api('POST', `m365/mail/${entity}/${id}`, { to, message, confirm_resend });
      try { await go(false); } catch (x) {
        if (!(x.data && x.data.code === 'already_sent')) throw x;
        if (!confirm(x.message + '\n\n' + tr('إرسال مرة أخرى؟', 'Send it again?'))) return; await go(true);
      }
      toast(tr('أُرسل من بريدك في Outlook', 'Sent from your Outlook mailbox'));
    });
  };
  await draw();
};
// the automatic SharePoint queue (administrators): on/off, waiting, retrying, stopped, the latest failures, run now / retry all
const m365Names = { purchase_orders: ['أمر شراء', 'Purchase order'], quotes: ['عرض سعر', 'Quotation'], invoices: ['فاتورة', 'Invoice'], subcontracts: ['عقد مقاول باطن', 'Subcontract'],
  sub_certs: ['شهادة دفع مقاول باطن', 'Subcontractor certificate'], pay_apps: ['طلب دفع', 'Payment application'], ipc: ['شهادة دفع مرحلية', 'Interim payment certificate'], documents: ['مرفق', 'Attachment'] };
const m365SyncLine = y => {
  const q = y.queue || {}, t = x => esc((x || '').slice(0, 16).replace('T', ' '));
  return `<br><b>${tr('الحفظ التلقائي', 'Automatic saving')}</b>: ${y.on ? `<span class="ok">✔ ${tr('مفعّل', 'On')}</span>${y.attachments ? '' : ' · ' + tr('بدون المرفقات', 'without attachments')}${y.from ? ` · ${tr('من', 'from')} ${esc(y.from)}` : ''}` : `<span class="muted">${tr('متوقف', 'Off')}</span>`}
    <br><span class="muted">${tr('بالانتظار', 'waiting')} ${q.queued || 0} · ${tr('إعادة محاولة', 'retrying')} ${q.retrying || 0} · ${tr('متوقف لخطأ', 'stopped')} ${q.stopped || 0} · ${tr('محفوظ', 'saved')} ${q.uploaded || 0}${y.last_run ? ` · ${tr('آخر تشغيل', 'last run')} ${t(y.last_run.at)}` : ''}</span>
    ${(y.failures || []).length ? `<div class="tw"><table><tbody>${y.failures.map(f => `<tr><td>${tr(...(m365Names[f.entity] || [f.entity, f.entity]))} #${f.entity_id}</td><td>${esc(f.doc_type)}</td><td class="neg">${esc(f.error || '')}</td><td class="muted">${f.next_attempt_at ? `${tr('المحاولة التالية', 'next try')} ${t(f.next_attempt_at)}` : tr('لا إعادة تلقائية', 'no automatic retry')}</td></tr>`).join('')}</tbody></table></div>` : ''}
    ${y.on ? `<br><button class="btn sec sm" id="m365syncnow">${tr('تشغيل الحفظ الآن', 'Run now')}</button>${(q.retrying || q.stopped) ? ` <button class="btn sec sm" id="m365retry">${tr('إعادة محاولة كل الفاشل', 'Retry all failed')}</button>` : ''}` : ''}`;
};
// Settings → Microsoft 365: the integrations (administrators see the configuration status and can test; users see their own mail status)
window.m365IntegrationsCard = async el => {
  const st = await m365Ints(true); if (!st || window.STANDALONE || !el) return;
  const on = (b, t) => b ? `<span class="ok">✔ ${t || tr('مفعّل', 'On')}</span>` : `<span class="muted">${tr('غير مفعّل', 'Off')}</span>`;
  const hl = h => h ? `<span class="muted">${h.ok_at ? `${tr('آخر نجاح', 'last OK')} ${esc(h.ok_at.slice(0, 16).replace('T', ' '))}` : ''}${h.fail_at ? ` · ${tr('آخر خطأ', 'last error')} ${esc(h.fail_at.slice(0, 16).replace('T', ' '))}: ${esc(h.error || '')}` : ''}</span>` : '';
  const admin = ME.role === 'admin', sp = st.sharepoint, ol = st.outlook, tm = st.teams;
  el.innerHTML = `<div class="card"><h2>${tr('تكامل Microsoft 365', 'Microsoft 365 integration')}</h2>
    <p><b>SharePoint</b>: ${sp.enabled ? (sp.configured ? on(true, tr('مضبوط', 'Configured')) : `<span class="neg">✖ ${tr('ناقص', 'Incomplete')}${admin && sp.missing ? ': ' + esc(sp.missing.join(', ')) : ''}</span>`) : on(false)}
      ${admin && sp.configured ? `<br><span class="muted">${tr('الموقع', 'Site')}: ${esc(sp.site_name || '—')} · ${tr('المكتبة', 'Library')}: ${esc(sp.library_name || '—')} · ${tr('المجلد', 'Folder')}: ${esc(sp.root || '')} · ${tr('محفوظ', 'saved')} ${sp.documents?.uploaded || 0}, ${tr('فشل', 'failed')} ${sp.documents?.failed || 0}</span><br>${hl(sp.health)}` : ''}
      ${admin && sp.configured && sp.sync ? m365SyncLine(sp.sync) : ''}
      ${admin && sp.configured ? `<br><button class="btn sec sm" id="m365sptest">${tr('اختبار الاتصال', 'Test connection')}</button> <button class="btn sec sm" id="m365mig">${tr('خطة نقل المرفقات (بدون تنفيذ)', 'Attachment migration plan (dry run)')}</button>` : ''}</p>
    <p><b>Outlook</b>: ${on(ol.enabled)} ${ol.enabled ? (st.me.can_send_mail ? `· <span class="ok">${tr('يمكنك الإرسال من بريدك', 'You can send from your mailbox')}</span>` : st.me.linked ? `· <span class="neg">${tr('أعد ربط حساب Microsoft للسماح بالإرسال', 'Reconnect your Microsoft account to allow sending')}</span>` : `· <span class="muted">${tr('اربط حساب Microsoft أولاً', 'Connect your Microsoft account first')}</span>`) : ''}
      ${admin && ol.health ? `<br>${hl(ol.health)}` : ''}${ol.enabled && st.me.linked ? `<br><button class="btn sec sm" id="m365oltest">${tr('اختبار (لا يرسل بريداً)', 'Test (sends nothing)')}</button>` : ''}</p>
    <p><b>Teams</b>: ${tm.enabled ? (admin ? (tm.destination_ok ? on(true, esc(tm.destination_host || '')) : `<span class="neg">✖ ${tr('عنوان القناة غير صالح', 'Invalid channel address')}</span>`) : on(true)) : on(false)}
      ${admin && tm.enabled ? `<br><span class="muted">${tm.amounts_shown ? tr('المبالغ تظهر في الإشعارات', 'Amounts are shown in notifications') : tr('المبالغ لا تظهر في الإشعارات', 'Amounts are not shown in notifications')}</span> ${hl(tm.health)}
        <br><button class="btn sec sm" id="m365tmtest">${tr('إرسال إشعار تجريبي', 'Send a test notification')}</button> <button class="btn sec sm" id="m365tmov">${tr('إرسال أوامر الشراء المتأخرة', 'Send overdue purchase orders')}</button>` : ''}</p></div>`;
  const b = (id, fn) => { const x = $(id, el); if (x) x.onclick = guard(fn); };
  b('#m365syncnow', async () => { await api('POST', 'm365/sync/run', {}); toast(tr('بدأ الحفظ التلقائي الآن', 'Automatic saving started')); setTimeout(() => m365IntegrationsCard(el), 4000); });
  b('#m365retry', async () => { const r = await api('POST', 'm365/sync/retry', {}); toast(`${r.requeued} ${tr('مستند أُعيد إلى القائمة', 'document(s) queued again')}`); setTimeout(() => m365IntegrationsCard(el), 4000); });
  b('#m365sptest', async () => { const r = await api('POST', 'm365/sharepoint/test', {}); toast(`✔ ${r.site_name} / ${r.library_name}`); m365IntegrationsCard(el); });
  b('#m365mig', async () => { const r = await api('POST', 'm365/migrate', { execute: false }); alert(`${tr('خطة فقط — لم يُرفع شيء', 'Plan only — nothing was uploaded')}\n${tr('للرفع', 'To upload')}: ${r.planned}\n${tr('موجود مسبقاً', 'Already there')}: ${r.unchanged}\n${tr('متجاوز', 'Skipped')}: ${r.skipped.length}`); });
  b('#m365oltest', async () => { const r = await api('POST', 'm365/outlook/test', {}); toast(`✔ ${r.mailbox || ''} ${r.can_send ? '' : '(' + tr('الإرسال غير مسموح بعد', 'sending not allowed yet') + ')'}`); });
  b('#m365tmtest', async () => { await api('POST', 'm365/teams/test', {}); toast(tr('أُرسل الإشعار التجريبي', 'Test notification sent')); m365IntegrationsCard(el); });
  b('#m365tmov', async () => { const r = await api('POST', 'm365/teams/overdue', {}); toast(`${r.count} ${tr('أمر شراء متأخر', 'overdue purchase orders')}`); });
};
