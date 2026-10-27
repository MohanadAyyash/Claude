// HR phase 1 screens: clock in/out from the phone, approvals queue, attendance with clock times and flags, crew clock-in,
// labour-law checks and approval chains on the HR dashboard, onboarding / offboarding inside the employee record, site location on projects.
const FLAG = { outside_site: ['خارج الموقع', 'Outside site'], no_location: ['بدون موقع', 'No location'], midday_break: ['وقت حظر العمل ظهراً', 'Midday ban hours'], ot_over_2h: ['إضافي فوق ساعتين', 'OT over 2 h'] };
const RULE = { ot_daily: ['إضافي أكثر من ساعتين في اليوم', 'More than 2 h overtime in a day'], hours_3weeks: ['أكثر من ١٤٤ ساعة في ٣ أسابيع', 'More than 144 h in 3 weeks'], rest_day: ['٧ أيام دون راحة أسبوعية', '7 days without a weekly rest day'],
  midday_break: ['عمل في الموقع وقت حظر الظهيرة', 'Site work during the midday ban'], outside_site: ['تسجيل خارج نطاق الموقع', 'Clocked outside the site area'], probation_6m: ['فترة تجربة أطول من ٦ أشهر', 'Probation longer than 6 months'], probation_review: ['تنتهي فترة التجربة قريباً', 'Probation ends soon'] };
const APPROVER = a => a === 'line_manager' ? tr('المدير المباشر', 'Line manager') : a.startsWith('role:') ? tr(...(ROLE[a.slice(5)] || [a, a])) : a;
const flagTags = f => (f || '').split(',').filter(Boolean).map(x => `<span class="tag overdue" style="font-size:11px">${tr(...(FLAG[x] || [x, x]))}</span>`).join(' ');
const getPos = () => new Promise(ok => {
  if (!navigator.geolocation) return ok({});
  navigator.geolocation.getCurrentPosition(p => ok({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy) }), () => ok({}), { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
});

// ---- employee portal: clock card + approvals waiting for me ----
const basePortal = PAGES.portal;
PAGES.portal = async () => {
  await basePortal();
  if (!ME.employee_id) return;
  const [st, q] = await Promise.all([api('GET', 'me/clock').catch(() => null), api('GET', 'me/approvals').catch(() => [])]);
  if (!st) return;
  const last = st.events[st.events.length - 1];
  const card = document.createElement('div'); card.className = 'card'; card.style.textAlign = 'center';
  card.innerHTML = `<h2>${tr('الحضور', 'Attendance')}${st.site ? ` — ${esc(st.site.name)}` : ''}</h2>
    <p class="muted">${last ? `${last.kind === 'in' ? tr('آخر دخول', 'Last in') : tr('آخر خروج', 'Last out')} ${esc(last.at.slice(11, 16))}${last.inside === 0 ? ` · <span class="neg">${tr('خارج الموقع', 'outside the site')}</span>` : ''}` : tr('لم تسجّل حضوراً اليوم', 'Not clocked in today')}</p>
    <button class="btn" id="clk" style="font-size:20px;padding:16px 28px;width:100%;max-width:340px">${st.clocked_in ? '⏹ ' + tr('تسجيل الانصراف', 'Clock out') : '▶ ' + tr('تسجيل الحضور', 'Clock in')}</button>
    <p class="muted" style="font-size:12px">${tr('يُسجَّل الوقت من الخادم ويُرفق موقعك الحالي.', 'The time comes from the server and your current location is attached.')}${st.site && !st.site.located ? ' ' + tr('(موقع المشروع غير محدد بعد)', '(project location not set yet)') : ''}</p>`;
  $('#main .bar').after(card);
  $('#clk').onclick = guard(async () => {
    $('#clk').disabled = true; $('#clk').textContent = tr('جارٍ تحديد الموقع…', 'Getting location…');
    try {
      const r = await api('POST', 'me/clock', await getPos());
      toast(r.duplicate ? tr('مسجّل مسبقاً', 'Already recorded') : `${r.kind === 'in' ? tr('تم تسجيل الحضور', 'Clocked in') : tr('تم تسجيل الانصراف', 'Clocked out')}${r.inside === false ? ' — ' + tr('خارج نطاق الموقع', 'outside the site area') : ''}`);
    } finally { render(); }
  });
  if (q.length) { const box = document.createElement('div'); box.className = 'card'; box.innerHTML = `<h2>${tr('بانتظار موافقتك', 'Waiting for your approval')}</h2>${approvalRows(q)}`; card.after(box); wireApprovals(box); }
};

// ---- approvals ----
const approvalRows = q => q.map(it => { const r = it.record; return `<div style="padding:10px 0;border-bottom:1px solid #e6e2d8"><b>${esc(it.employee)}</b> — ${it.kind === 'leave' ? `${lt(r.type)} ${esc(r.start_date)} → ${esc(r.end_date)} (${r.days} ${tr('يوم', 'days')})` : `${tr(...REQT[r.type])}${r.amount ? ' — ' + money(r.amount) : ''}`}
  <div class="muted" style="font-size:12px">${tr('المستوى', 'Level')} ${it.level}/${it.levels}${it.balance ? ` · ${tr('رصيد الإجازة', 'leave balance')} ${it.balance.balance}` : ''}${r.reason || r.details ? ' · ' + esc(r.reason || r.details) : ''}${it.history.map(h => ` · ✔ ${esc(h.by)}${h.note ? ': ' + esc(h.note) : ''}`).join('')}</div>
  <div class="bar" style="margin-top:6px"><button class="btn sm" data-ap="${it.step_id}">${tr('موافقة', 'Approve')}</button><button class="btn sec sm" data-rj="${it.step_id}">${tr('رفض', 'Reject')}</button></div></div>`; }).join('');
const wireApprovals = root => {
  root.querySelectorAll('[data-ap]').forEach(b => b.onclick = guard(async () => {
    const note = prompt(tr('ملاحظة (اختياري):', 'Note (optional):')) ?? ''; if (note === null) return;
    try { await api('PUT', 'approvals/' + b.dataset.ap, { status: 'approved', note }); }
    catch (e) { if (/Insufficient/.test(e.message) && confirm(e.message + '\n\n' + tr('الموافقة رغم ذلك؟', 'Approve anyway?'))) await api('PUT', 'approvals/' + b.dataset.ap, { status: 'approved', note, force: 1 }); else throw e; }
    toast(tr('تمت الموافقة', 'Approved')); render(); onShell();
  }));
  root.querySelectorAll('[data-rj]').forEach(b => b.onclick = guard(async () => { const note = prompt(tr('سبب الرفض:', 'Reason for rejection:')); if (note === null) return; await api('PUT', 'approvals/' + b.dataset.rj, { status: 'rejected', note }); render(); onShell(); }));
};
PAGES.approvals = async () => {
  const q = await api('GET', 'approvals');
  main(`<h1>${tr('الاعتمادات', 'Approvals')}</h1><p class="muted">${tr('الطلبات التي وصلت إلى مستواك في سلسلة الاعتماد. بعد موافقتك تنتقل للمستوى التالي، ويُبلَّغ الموظف بالقرار النهائي.', 'Requests that reached your level of the approval chain. After you approve they move to the next level; the employee is told the final decision.')}</p>
    <div class="card">${approvalRows(q) || `<p class="muted">${tr('لا يوجد ما ينتظر موافقتك', 'Nothing is waiting for you')}</p>`}</div>`);
  wireApprovals($('#main'));
};

// ---- attendance (HR / site managers): clock times, flags, crew clock-in ----
PAGES.attendance = async () => {
  const date = sessionStorage.ad || today();
  const [a, projects, ev] = await Promise.all([api('GET', `attendance?date=${date}`), api('GET', 'projects').catch(() => []), api('GET', `attendance/events?date=${date}`).catch(() => [])]);
  const byEmp = Object.fromEntries(a.rows.map(r => [r.employee_id, r]));
  const evOf = id => ev.filter(x => x.employee_id === id);
  const restDay = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date(date + 'T00:00:00Z').getUTCDay()] === (a.rest_day || 'fri');   // worked rest day: pay +50% or a substitute day
  main(`<div class="bar"><h1>${tr('الحضور والعمل الإضافي', 'Attendance & overtime')}</h1><span class="sp"></span><button class="btn" id="crew">📍 ${tr('تسجيل حضور الفريق', 'Clock in my crew')}</button><input type="date" id="d" value="${date}" style="width:auto"></div>
  <p class="muted">${tr('أوقات الدخول والخروج تأتي من الجوال. الساعات الإضافية تُحسب حسب القانون: بعد ساعات العمل اليومية وساعة الراحة، +٢٥٪ نهاراً و+٥٠٪ ليلاً (١٠م–٤ص) ويوم الراحة. أي تعديل يدوي هنا يبقى ولا يُستبدل بالتسجيل من الجوال.', 'In/out times come from the phone. Overtime follows the law: after the daily hours and the 1-hour break, +25% by day, +50% at night (10pm–4am) and on the rest day. A manual change here is kept; phone clocking does not overwrite it.')}</p>
  <div class="tw"><table><thead><tr><th>${tr('الموظف', 'Employee')}</th><th>${tr('دخول / خروج', 'In / out')}</th><th>${tr('الحالة', 'Status')}</th><th class="n">${tr('إضافي +٢٥٪', 'OT +25%')}</th><th class="n">${tr('إضافي +٥٠٪', 'OT +50%')}</th><th>${tr('المشروع', 'Project')}</th><th>${tr('ملاحظة', 'Note')}</th></tr></thead><tbody>
  ${a.roster.map(e => { const r = byEmp[e.id] || { status: 'present', ot_normal_hours: 0, ot_special_hours: 0, project_id: e.project_id, note: '' }, es = evOf(e.id);
    return `<tr data-e="${e.id}"><td>${esc(e.name)}<div class="muted">${esc(e.designation || '')}</div></td>
    <td>${r.check_in ? `${esc(r.check_in)} → ${esc(r.check_out || '…')}<div class="muted" style="font-size:12px">${r.worked_hours ?? ''} ${tr('ساعة', 'h')} ${es.filter(x => x.lat != null).slice(-1).map(x => `· <a target="_blank" rel="noopener" href="https://maps.google.com/?q=${x.lat},${x.lng}">${tr('الخريطة', 'map')}</a>`).join('')}</div>${flagTags(r.flags)}` : '<span class="muted">—</span>'}</td>
    <td><select data-f="status">${Object.entries(ATT_ST).map(([k, v]) => `<option value="${k}" ${r.status === k ? 'selected' : ''}>${tr(...v)}</option>`).join('')}</select></td>
    <td class="n"><input data-f="ot_normal_hours" type="number" step="any" style="width:70px" value="${r.ot_normal_hours}"></td><td class="n"><input data-f="ot_special_hours" type="number" step="any" style="width:70px" value="${r.ot_special_hours}"></td>
    <td><select data-f="project_id">${refOpts(projects, p => `${p.code || ''} ${p.name}`).map(([k, l]) => `<option value="${k}" ${String(k) === String(r.project_id ?? '') ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></td><td><input data-f="note" value="${esc(r.note || '')}">${restDay ? `<select data-f="rest_comp" title="${tr('تعويض العمل يوم الراحة', 'Rest-day work compensation')}"><option value="pay" ${r.rest_comp !== 'day' ? 'selected' : ''}>${tr('أجر +٥٠٪', 'Pay +50%')}</option><option value="day" ${r.rest_comp === 'day' ? 'selected' : ''}>${tr('يوم راحة بديل', 'Substitute day off')}</option></select>` : ''}</td></tr>`; }).join('') || `<tr><td colspan="7" class="muted">${tr('لا يوجد موظفون', 'No employees')}</td></tr>`}</tbody></table></div>`);
  $('#d').onchange = e => { sessionStorage.ad = e.target.value; render(); };
  document.querySelectorAll('tr[data-e]').forEach(tr_ => tr_.querySelectorAll('[data-f]').forEach(x => x.onchange = guard(async () => {
    const body = { employee_id: +tr_.dataset.e, date }; tr_.querySelectorAll('[data-f]').forEach(y => body[y.dataset.f] = y.value);
    await api('PUT', 'attendance', body); tr_.style.background = '#eefaf1'; setTimeout(() => (tr_.style.background = ''), 600);
  })));
  $('#crew').onclick = () => {
    const hr = ['admin', 'hr'].includes(ME.role);
    const m = modal(`<h2>${tr('تسجيل حضور الفريق', 'Clock in my crew')}</h2><p class="muted">${tr('للعمال بدون هاتف: اختر الأسماء، ويُسجَّل الوقت الحالي مع موقع هاتفك.', 'For workers without a phone: tick the names; the current time is recorded with your phone’s location.')}</p>
      <div class="f2"><div class="f"><label>${tr('النوع', 'Type')}</label><select name="kind"><option value="in">${tr('دخول', 'In')}</option><option value="out">${tr('خروج', 'Out')}</option></select></div>${hr ? `<div class="f"><label>${tr('وقت سابق (تصحيح من الموارد البشرية)', 'Past time (HR correction)')}</label><input name="at" type="datetime-local"></div>` : ''}</div>
      <div style="max-height:45vh;overflow:auto">${a.roster.map(e => `<label style="display:flex;gap:8px;align-items:center;padding:4px 0"><input type="checkbox" style="width:auto" value="${e.id}"> ${esc(e.name)}</label>`).join('')}</div>
      <div class="acts"><button class="btn" id="go">${tr('تسجيل', 'Record')}</button><button class="btn sec" id="cancel">${tr('إلغاء', 'Cancel')}</button></div>`);
    $('#cancel', m).onclick = closeModal;
    $('#go', m).onclick = guard(async () => {
      const ids = [...m.querySelectorAll('input[type=checkbox]:checked')].map(x => +x.value); if (!ids.length) throw new Error(tr('اختر الموظفين', 'Choose the employees'));
      const at = val(m, 'at'), pos = at ? {} : await getPos();
      await api('POST', 'attendance/clock', { employee_ids: ids, kind: val(m, 'kind'), ...pos, ...(at ? { at: at.replace('T', ' ') } : {}) });
      closeModal(); toast(tr('تم التسجيل', 'Recorded')); render();
    });
  };
};

// ---- HR dashboard: labour-law checks, approval chains, attendance rules ----
const baseHrdash = PAGES.hrdash;
PAGES.hrdash = async () => {
  await baseHrdash();
  const month = sessionStorage.hrm || today().slice(0, 7);
  const [iss, fl] = await Promise.all([api('GET', 'hr/compliance?month=' + month), api('GET', 'hr/flows')]);
  const card = document.createElement('div'); card.className = 'card';
  card.innerHTML = `<div class="bar"><h2>${tr('الالتزام بقانون العمل', 'Labour-law compliance')}</h2><span class="sp"></span><input type="month" id="hrm" value="${month}" style="width:auto"></div>
    ${iss.length ? `<div class="tw"><table><thead><tr><th>${tr('الموظف', 'Employee')}</th><th>${tr('التاريخ', 'Date')}</th><th>${tr('الملاحظة', 'Issue')}</th><th>${tr('المرجع', 'Reference')}</th></tr></thead><tbody>${iss.map(i => `<tr><td>${esc(i.employee)}</td><td>${esc(i.date)}</td><td>${tr(...(RULE[i.rule] || [i.rule, i.rule]))}<div class="muted" style="font-size:12px">${esc(i.detail)}</div></td><td class="muted">${esc(i.law)}</td></tr>`).join('')}</tbody></table></div>` : `<p class="pos">✔ ${tr('لا توجد مخالفات هذا الشهر', 'No issues this month')}</p>`}`;
  $('#main').append(card);
  $('#hrm').onchange = e => { sessionStorage.hrm = e.target.value; render(); };
  const opts = ['line_manager', 'role:hr', 'role:admin', 'role:manager', 'role:accountant'];
  const flowRows = (kind, rows) => rows.map(([ap, d, amt], i) => `<tr data-k="${kind}"><td>${i + 1}</td><td><select data-x="ap">${opts.map(o => `<option value="${o}" ${o === ap ? 'selected' : ''}>${APPROVER(o)}</option>`).join('')}<option value="">— ${tr('حذف', 'remove')} —</option></select></td><td>${kind === 'leave' ? `<input data-x="d" type="number" style="width:80px" value="${d || 0}">` : `<input data-x="amt" type="number" style="width:100px" value="${amt || 0}">`}</td></tr>`).join('');
  const fc = document.createElement('div'); fc.className = 'card';
  fc.innerHTML = `<h2>${tr('مستويات الاعتماد', 'Approval chains')}</h2><p class="muted">${tr('يُطبّق المستوى فقط إذا تجاوز الطلب الحد (عدد الأيام للإجازة، المبلغ للطلبات). إذا لم يكن للموظف مدير مباشر يُتخطّى ذلك المستوى.', 'A level applies only above its threshold (days for leave, amount for requests). If the employee has no line manager that level is skipped.')}</p>
    <div class="f2"><div><h3>${tr('الإجازات', 'Leave')}</h3><table><thead><tr><th>#</th><th>${tr('المعتمِد', 'Approver')}</th><th>${tr('من أيام', 'From days')}</th></tr></thead><tbody id="fl-leave">${flowRows('leave', fl.leave)}</tbody></table><button class="btn sec sm" data-add="leave">+</button></div>
    <div><h3>${tr('طلبات الموظفين', 'Employee requests')}</h3><table><thead><tr><th>#</th><th>${tr('المعتمِد', 'Approver')}</th><th>${tr('من مبلغ', 'From amount')}</th></tr></thead><tbody id="fl-request">${flowRows('request', fl.request)}</tbody></table><button class="btn sec sm" data-add="request">+</button></div></div>
    <button class="btn" id="fsave" style="margin-top:10px">${tr('حفظ', 'Save')}</button>`;
  $('#main').append(fc);
  fc.querySelectorAll('[data-add]').forEach(b => b.onclick = () => { const k = b.dataset.add, tb = $('#fl-' + k); tb.insertAdjacentHTML('beforeend', flowRows(k, [['role:hr', 0, 0]]).replace('<td>1</td>', `<td>${tb.children.length + 1}</td>`)); });
  $('#fsave').onclick = guard(async () => {
    const body = {}; for (const k of ['leave', 'request']) body[k] = [...$('#fl-' + k).children].map(r => [r.querySelector('[data-x=ap]').value, +(r.querySelector('[data-x=d]')?.value || 0), +(r.querySelector('[data-x=amt]')?.value || 0)]).filter(r => r[0]);
    await api('PUT', 'hr/flows', body); toast(tr('تم الحفظ', 'Saved')); render();
  });
  const rc = document.createElement('div'); rc.className = 'card'; const admin = ME.role === 'admin';
  const days = ['fri', 'sat', 'sun', 'mon', 'tue', 'wed', 'thu'], dn = { fri: ['الجمعة', 'Friday'], sat: ['السبت', 'Saturday'], sun: ['الأحد', 'Sunday'], mon: ['الاثنين', 'Monday'], tue: ['الثلاثاء', 'Tuesday'], wed: ['الأربعاء', 'Wednesday'], thu: ['الخميس', 'Thursday'] };
  rc.innerHTML = `<h2>${tr('قواعد الحضور', 'Attendance rules')}</h2><div class="f2" id="rules">
    ${field({ k: 'hr_work_hours', ar: 'ساعات العمل اليومية (الحد ٨)', en: 'Daily working hours (max 8)', type: 'number' }, S.hr_work_hours || 8)}${field({ k: 'hr_break_min', ar: 'الراحة بالدقائق (لا تُحسب من العمل)', en: 'Break minutes (not working time)', type: 'number' }, S.hr_break_min ?? 60)}
    ${field({ k: 'hr_rest_day', ar: 'يوم الراحة الأسبوعية', en: 'Weekly rest day', type: 'select', options: days.map(d => [d, tr(...dn[d])]) }, S.hr_rest_day || 'fri')}
    ${field({ k: 'hr_geofence', ar: 'التسجيل خارج نطاق الموقع', en: 'Clocking outside the site area', type: 'select', options: [['flag', tr('يُسمح ويُعلَّم وينبَّه المدير', 'Allowed, flagged, manager alerted')], ['block', tr('يُمنع', 'Blocked')]] }, S.hr_geofence || 'flag')}
    ${field({ k: 'hr_ramadan_from', ar: 'رمضان من (ساعتان أقل يومياً)', en: 'Ramadan from (2 h shorter days)', type: 'date' }, S.hr_ramadan_from)}${field({ k: 'hr_ramadan_to', ar: 'رمضان إلى', en: 'Ramadan to', type: 'date' }, S.hr_ramadan_to)}
    ${field({ k: 'hr_midday_from', ar: 'حظر الظهيرة من (شهر-يوم)', en: 'Midday ban from (MM-DD)' }, S.hr_midday_from || '06-15')}${field({ k: 'hr_midday_to', ar: 'حظر الظهيرة إلى (شهر-يوم)', en: 'Midday ban to (MM-DD)' }, S.hr_midday_to || '09-15')}
    ${field({ k: 'hr_midday_start', ar: 'ساعة بداية الحظر', en: 'Ban starts at', type: 'time' }, S.hr_midday_start || '12:30')}${field({ k: 'hr_midday_end', ar: 'ساعة نهاية الحظر', en: 'Ban ends at', type: 'time' }, S.hr_midday_end || '15:00')}
    ${field({ k: 'hr_sif_days', ar: 'خانة «أيام الفترة» في ملف SIF', en: '“Days in period” in the SIF file', type: 'select', options: [['calendar', tr('أيام الشهر الميلادية (النهاية − البداية + ١)', 'Calendar days of the period (end − start + 1)')], ['calendar_minus_leave', tr('أيام الشهر ناقص أيام الإجازة بدون أجر', 'Calendar days minus unpaid leave days')], ['legacy', tr('أيام العمل المحسوبة في الراتب (الطريقة السابقة)', 'Days worked on the payroll (previous method)')]] }, S.hr_sif_days || 'calendar')}</div>
    ${admin ? `<button class="btn" id="rsave">${tr('حفظ', 'Save')}</button>` : `<p class="muted">${tr('يعدّلها مدير النظام', 'An administrator changes these')}</p>`}`;
  $('#main').append(rc);
  if (!admin) rc.querySelectorAll('input,select').forEach(x => (x.disabled = true));
  if ($('#rsave')) $('#rsave').onclick = guard(async () => { const b = {}; ['hr_work_hours', 'hr_break_min', 'hr_rest_day', 'hr_geofence', 'hr_ramadan_from', 'hr_ramadan_to', 'hr_midday_from', 'hr_midday_to', 'hr_midday_start', 'hr_midday_end', 'hr_sif_days'].forEach(k => b[k] = val(rc, k));
    const mmdd = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/; if (!mmdd.test(b.hr_midday_from) || !mmdd.test(b.hr_midday_to)) throw new Error(tr('اكتب تواريخ حظر الظهيرة بصيغة شهر-يوم مثل 06-15', 'Write the midday ban dates as MM-DD, e.g. 06-15')); await api('PUT', 'settings', b); S = await api('GET', 'settings'); toast(tr('تم الحفظ', 'Saved')); });
};

// ---- employee record: onboarding / offboarding ----
const baseExtras = window.employeeExtras;
window.employeeExtras = async (m, row) => {
  if (baseExtras) await baseExtras(m, row);
  if (!row || !['admin', 'hr'].includes(ME.role)) return;
  const box = document.createElement('div'); box.className = 'card'; const mod = m.querySelector('.modal'); mod.insertBefore(box, mod.querySelector('.acts'));
  const draw = async () => {
    const d = await api('GET', `hr/checklist/${row.id}`), ob = d.offboard, st = ob && ob.settlement ? JSON.parse(ob.settlement) : null;
    const list = (items, kind) => items.map(i => `<label style="display:flex;gap:8px;align-items:center;padding:3px 0"><input type="checkbox" style="width:auto" data-ck="${i.id}" ${i.done ? 'checked' : ''}> ${esc(tr(i.label_ar, i.label_en))}${i.done ? ` <span class="muted" style="font-size:11px">${esc(i.done_by || '')} ${esc(i.done_at || '')}</span>` : ''}</label>`).join('');
    const line = (l, v) => `<tr><td>${l}</td><td class="n ${v < 0 ? 'neg' : ''}">${money(v)}</td></tr>`;
    box.innerHTML = `<h2>${tr('الانضمام والمغادرة', 'Onboarding & offboarding')}</h2>
      ${d.onboarding.length ? `<h3>${tr('إجراءات الانضمام', 'Onboarding')} (${d.onboarding.filter(i => i.done).length}/${d.onboarding.length})</h3>${list(d.onboarding)}` : `<button type="button" class="btn sec sm" id="onb">${tr('بدء إجراءات الانضمام', 'Start onboarding')}</button>`}
      <h3 style="margin-top:12px">${tr('المغادرة والتسوية النهائية', 'Leaving & final settlement')}</h3>
      ${ob && ob.status === 'completed' ? `<p class="muted">${tr('اكتملت المغادرة', 'Offboarding completed')} ${esc(ob.completed)}</p>` : ''}
      ${st ? `<table style="max-width:420px">${line(tr('راتب حتى آخر يوم', 'Salary to the last day'), st.salary)}${line(tr(`بدل إجازات (${st.leave_days} يوم)`, `Leave encashment (${st.leave_days} d)`), st.leave_encashment)}${line(tr(`مكافأة نهاية الخدمة (${st.service_years} سنة${st.unpaid_days ? ` بعد خصم ${st.unpaid_days} يوم غياب بدون أجر` : ''})`, `Gratuity (${st.service_years} y${st.unpaid_days ? ` after ${st.unpaid_days} unpaid days` : ''})`), st.gratuity)}${line(tr(`فترة الإشعار (${st.notice_days} يوم)`, `Notice (${st.notice_days} d)`), st.notice)}${st.advance ? line(tr('رصيد السلف المتبقي', 'Outstanding advance'), st.advance) : ''}${line(tr('خصومات', 'Deductions'), st.deductions)}<tr><td><b>${tr('الإجمالي', 'Total')}</b></td><td class="n"><b>${money(st.total)}</b></td></tr></table>
        ${st.warnings.map(w => `<p class="neg" style="font-size:13px">⚠ ${esc(w)}</p>`).join('')}${list(d.offboarding)}` : ''}
      ${!ob || ob.status !== 'completed' ? `<div class="f2"><div class="f"><label>${tr('آخر يوم عمل', 'Last working day')}</label><input type="date" id="ob-last" value="${esc(ob ? ob.last_day : '')}"></div>
        <div class="f"><label>${tr('السبب', 'Reason')}</label><select id="ob-reason">${[['resignation', tr('استقالة', 'Resignation')], ['termination', tr('إنهاء من الشركة', 'Termination by the company')], ['end_of_contract', tr('انتهاء العقد', 'End of contract')], ['other', tr('أخرى', 'Other')]].map(([k, l]) => `<option value="${k}" ${ob && ob.reason === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="f"><label>${tr('تاريخ الإشعار', 'Notice given on')}</label><input type="date" id="ob-notice" value="${esc(ob ? ob.notice_date || '' : '')}"></div><div class="f"><label>${tr('خصومات أخرى (عهد…) — السلف تُخصم تلقائياً', 'Other deductions (items…) — advances are deducted automatically')}</label><input type="number" id="ob-ded" value="${ob ? ob.other_deductions : 0}"></div></div>
        <div class="bar"><button type="button" class="btn sec sm" id="ob-calc">${ob ? tr('إعادة الحساب', 'Recalculate') : tr('بدء المغادرة وحساب التسوية', 'Start offboarding & calculate')}</button>${ob ? `<button type="button" class="btn bad sm" id="ob-done">${tr('إنهاء الخدمة وإيقاف الحساب', 'Complete & disable account')}</button>` : ''}</div>` : ''}`;
    box.querySelectorAll('[data-ck]').forEach(c => c.onchange = guard(async () => { await api('PUT', `hr/checklist/${c.dataset.ck}`, { done: c.checked ? 1 : 0 }); draw(); }));
    if ($('#onb', box)) $('#onb', box).onclick = guard(async () => { await api('POST', `hr/onboarding/${row.id}`); draw(); });
    if ($('#ob-calc', box)) $('#ob-calc', box).onclick = guard(async () => { await api('POST', `hr/offboarding/${row.id}`, { last_day: $('#ob-last', box).value, reason: $('#ob-reason', box).value, notice_date: $('#ob-notice', box).value || null, other_deductions: $('#ob-ded', box).value }); draw(); });
    if ($('#ob-done', box)) $('#ob-done', box).onclick = guard(async () => {
      if (!confirm(tr('إنهاء خدمة الموظف وإيقاف حسابه في النظام؟', 'End the employee’s service and disable their system account?'))) return;
      try { await api('POST', `hr/offboarding/${row.id}/complete`, {}); }
      catch (e) { if (/still open/.test(e.message) && confirm(e.message + '\n\n' + tr('المتابعة رغم ذلك؟', 'Continue anyway?'))) await api('POST', `hr/offboarding/${row.id}/complete`, { force: 1 }); else throw e; }
      closeModal(); render();
    });
  };
  await draw();
};

// ---- project form: "use my current location" for the site area ----
new MutationObserver(() => {
  const lat = $('#modal-root [name=site_lat]'); if (!lat || $('#geo-btn')) return;
  const b = document.createElement('button'); b.type = 'button'; b.id = 'geo-btn'; b.className = 'btn sec sm'; b.textContent = '📍 ' + tr('استخدم موقعي الحالي (وأنا في الموقع)', 'Use my current location (while on site)');
  b.onclick = guard(async () => { const p = await getPos(); if (p.lat == null) throw new Error(tr('تعذّر تحديد الموقع', 'Could not get the location')); lat.value = p.lat.toFixed(6); $('#modal-root [name=site_lng]').value = p.lng.toFixed(6); });
  lat.closest('.f').after(b);
}).observe(document.getElementById('modal-root'), { childList: true, subtree: true });
