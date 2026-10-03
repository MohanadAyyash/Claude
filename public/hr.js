// Human resources pages and the employee self-service portal.
const LEAVE = { annual: ['سنوية', 'Annual'], sick: ['مرضية', 'Sick'], unpaid: ['بدون راتب', 'Unpaid'], maternity: ['وضع', 'Maternity'], paternity: ['أبوة', 'Paternity'], bereavement: ['وفاة', 'Bereavement'], other: ['أخرى', 'Other'] };
const REQT = { salary_certificate: ['شهادة راتب', 'Salary certificate'], employment_certificate: ['شهادة عمل', 'Employment certificate'], noc: ['شهادة عدم ممانعة (NOC)', 'No-objection certificate'], salary_transfer: ['خطاب تحويل راتب', 'Salary transfer letter'],
  experience: ['شهادة خبرة', 'Experience certificate'], advance: ['سلفة على الراتب', 'Salary advance'], id_renewal: ['تجديد إقامة / هوية / جواز', 'Visa / ID / passport renewal'], complaint: ['شكوى / ملاحظة', 'Complaint / feedback'], other: ['طلب آخر', 'Other'] };
const LETTER_TYPES = ['salary_certificate', 'employment_certificate', 'noc', 'salary_transfer', 'experience'];
const ATT_ST = { present: ['حاضر', 'Present'], absent: ['غائب', 'Absent'], leave: ['إجازة', 'Leave'], sick: ['مرضية', 'Sick'], holiday: ['عطلة رسمية', 'Public holiday'], off: ['راحة', 'Rest day'] };
const RS = { pending: ['بانتظار القرار', 'Pending'], approved: ['موافق عليه', 'Approved'], rejected: ['مرفوض', 'Rejected'] };
const rtag = s => `<span class="tag ${s === 'pending' ? 'unpaid' : s === 'approved' ? 'paid' : 'overdue'}">${tr(...RS[s])}</span>`;
const lt = t => tr(...(LEAVE[t] || [t, t]));

// ---- HR dashboard ---------------------------------------------------------------------------
PAGES.hrdash = async () => {
  const [s, leaves, reqs] = await Promise.all([api('GET', 'hr/summary'), api('GET', 'hr/leave'), api('GET', 'hr/requests')]);
  const k = (l, v, c = '', go_) => `<div class="kpi" ${go_ ? `style="cursor:pointer" onclick="go('${go_}')"` : ''}><div class="l">${l}</div><div class="v ${c}">${v}</div></div>`;
  main(`<h1>${tr('لوحة الموارد البشرية', 'HR dashboard')}</h1>
  <div class="grid">${k(tr('موظفون على رأس العمل', 'Active employees'), s.active_employees, '', 'employees')}${k(tr('إجازات بانتظار الموافقة', 'Leave awaiting approval'), s.pending_leave, s.pending_leave ? 'warn' : '', 'leave')}
   ${k(tr('طلبات بانتظار القرار', 'Requests awaiting decision'), s.pending_requests, s.pending_requests ? 'warn' : '', 'hrrequests')}${k(tr('في إجازة اليوم', 'On leave today'), s.on_leave_today)}</div>
  <div class="f2"><div class="card"><h2>${tr('إجازات معلّقة', 'Pending leave')}</h2>${leaves.filter(l => l.status === 'pending').slice(0, 6).map(l => `<div>• ${esc(l.name)} — ${lt(l.type)} ${esc(l.start_date)} → ${esc(l.end_date)} (${l.days})</div>`).join('') || `<span class="muted">—</span>`}</div>
  <div class="card"><h2>${tr('طلبات معلّقة', 'Pending requests')}</h2>${reqs.filter(r => r.status === 'pending').slice(0, 6).map(r => `<div>• ${esc(r.name)} — ${tr(...REQT[r.type])}</div>`).join('') || `<span class="muted">—</span>`}</div></div>
  <div class="card"><h2>${tr('مستندات تنتهي خلال ٦٠ يوماً', 'Documents expiring within 60 days')}</h2>${s.expiring.map(e => `<div>⚠ <b>${esc(e.name)}</b>: ${[['eid_expiry', tr('هوية', 'Emirates ID')], ['visa_expiry', tr('إقامة', 'Visa')], ['passport_expiry', tr('جواز', 'Passport')], ['card_expiry', tr('بطاقة عمل', 'Labour card')]].filter(([f]) => e[f]).map(([f, l]) => `${l} ${e[f]}`).join(' · ')}</div>`).join('') || `<span class="pos">✔ ${tr('لا شيء', 'None')}</span>`}</div>`);
};

// ---- leave ------------------------------------------------------------------------------------
const decideReq = (url, label) => guard(async () => {
  const approve = confirm(`${label}\n\n${tr('موافقة؟ (إلغاء = رفض)', 'Approve? (Cancel = reject)')}`);
  const note = prompt(tr('ملاحظة القرار (اختياري):', 'Decision note (optional):')) || '';
  try { await api('PUT', url, { status: approve ? 'approved' : 'rejected', note }); }
  catch (e) { if (approve && /Insufficient/.test(e.message) && confirm(e.message + '\n\n' + tr('الموافقة رغم ذلك؟', 'Approve anyway?'))) await api('PUT', url, { status: 'approved', note, force: 1 }); else throw e; }
  render();
});
PAGES.leave = async () => {
  const [rows, bal, emps] = await Promise.all([api('GET', 'hr/leave'), api('GET', 'hr/balances'), api('GET', 'employees')]);
  main(`<div class="bar"><h1>${tr('الإجازات', 'Leave management')}</h1><span class="sp"></span><button class="btn" id="add">+ ${tr('تسجيل إجازة لموظف', 'Record leave')}</button></div>
  <p class="muted">${tr('الرصيد التقديري وفق المرسوم بقانون اتحادي ٣٣ لسنة ٢٠٢١: يومان لكل شهر بعد ٦ أشهر خدمة، و٣٠ يوماً سنوياً بعد السنة الأولى؛ الإجازة المرضية حتى ٩٠ يوماً في السنة. الإجازة بدون راتب والغياب يُخصمان تلقائياً عند إنشاء كشف الرواتب. تقسيم أجر المرضية (كامل/نصف/بدون) يُدخل يدوياً كخصم.', 'Estimated entitlement per Federal Decree-Law 33/2021: 2 days/month after 6 months of service, 30 days/year after the first year; sick leave up to 90 days/year. Unpaid leave and absences are deducted automatically when payroll is generated. Sick-pay tiers (full/half/unpaid) are entered manually as deductions.')}</p>
  <div class="tw"><table><thead><tr><th>${tr('الموظف', 'Employee')}</th><th>${tr('النوع', 'Type')}</th><th>${tr('من', 'From')}</th><th>${tr('إلى', 'To')}</th><th class="n">${tr('أيام', 'Days')}</th><th>${tr('السبب', 'Reason')}</th><th>${tr('الحالة', 'Status')}</th><th></th></tr></thead><tbody>
  ${rows.map(l => `<tr><td>${esc(l.name)}</td><td>${lt(l.type)}</td><td>${esc(l.start_date)}</td><td>${esc(l.end_date)}</td><td class="n">${l.days}</td><td>${esc(l.reason || '')}${l.decision_note ? `<div class="muted">${esc(l.decision_note)}</div>` : ''}</td><td>${rtag(l.status)}</td><td>${l.status === 'pending' ? `<button class="btn sm" data-dec="${l.id}" data-who="${esc(l.name)}">${tr('قرار', 'Decide')}</button>` : `<button class="btn sec sm" data-dl="${l.id}">×</button>`}</td></tr>`).join('') || `<tr><td colspan="8" class="muted">${tr('لا توجد إجازات', 'No leave records')}</td></tr>`}</tbody></table></div>
  <h2 style="margin-top:18px">${tr('أرصدة الإجازات', 'Leave balances')}</h2><div class="tw"><table><thead><tr><th>${tr('الموظف', 'Employee')}</th><th class="n">${tr('أشهر الخدمة', 'Months')}</th><th class="n">${tr('المستحق', 'Accrued')}</th><th class="n">${tr('افتتاحي', 'Opening')}</th><th class="n">${tr('المستخدم', 'Used')}</th><th class="n">${tr('الرصيد', 'Balance')}</th><th class="n">${tr('مرضية (١٢ شهر)', 'Sick (12m)')}</th></tr></thead><tbody>
  ${bal.map(b => `<tr><td>${esc(b.name)}</td><td class="n">${b.months_of_service}</td><td class="n">${b.accrued}</td><td class="n">${b.opening}</td><td class="n">${b.used}</td><td class="n"><b class="${b.balance < 0 ? 'neg' : ''}">${b.balance}</b></td><td class="n">${b.sick_used_12m}/90</td></tr>`).join('') || `<tr><td colspan="7" class="muted">—</td></tr>`}</tbody></table></div>`);
  $('#add').onclick = () => simpleModal({ title: tr('تسجيل إجازة', 'Record leave'), table: 'hr/leave', after: render, fields: [
    { k: 'employee_id', ar: 'الموظف', en: 'Employee', type: 'select', options: refOpts(emps.filter(e => e.status === 'active'), e => e.name, false) }, { k: 'type', ar: 'النوع', en: 'Type', type: 'select', options: Object.entries(LEAVE).map(([k, v]) => [k, tr(...v)]) },
    { k: 'start_date', ar: 'من', en: 'From', type: 'date', def: today() }, { k: 'end_date', ar: 'إلى', en: 'To', type: 'date', def: today() }, { k: 'reason', ar: 'السبب', en: 'Reason', full: 1 }] });
  document.querySelectorAll('[data-dec]').forEach(b => b.onclick = decideReq(`hr/leave/${b.dataset.dec}/decide`, b.dataset.who));
  document.querySelectorAll('[data-dl]').forEach(b => b.onclick = guard(async () => { if (confirmDel()) { await api('DELETE', 'hr/leave/' + b.dataset.dl); render(); } }));
};

// ---- employee requests & letters ---------------------------------------------------------------
async function issueLetter(type, employee_id, request_id, defaults = {}, after = render) {
  const f = [{ k: 'addressed_to', ar: 'موجّه إلى (اختياري)', en: 'Addressed to (optional)', def: defaults.addressed_to || '' }, { k: 'purpose', ar: 'الغرض (مثلاً: السفر، فتح حساب بنكي)', en: 'Purpose (e.g. travel, bank account)', def: defaults.purpose || '' }];
  const m = modal(`<h2>${tr(...REQT[type])}</h2><div class="f2">${f.map(x => field(x, x.def)).join('')}</div><p class="muted">${tr('سيُعطى الخطاب رقماً مرجعياً تسلسلياً ويُطبع بترويسة الشركة والختم والتوقيع، ويُعتمد الطلب تلقائياً. راجع النص قبل التوقيع.', 'The letter gets a sequential reference number and prints on the letterhead with stamp and signature; the request is approved automatically. Review the wording before signing.')}</p>
    <div class="acts"><button class="btn" id="save">${tr('إصدار وطباعة', 'Issue & print')}</button><button class="btn sec" id="cancel">${tr('إلغاء', 'Cancel')}</button></div>`);
  $('#cancel', m).onclick = closeModal;
  $('#save', m).onclick = guard(async () => {
    const l = await api('POST', 'hr/letters', { type, employee_id, request_id, addressed_to: val(m, 'addressed_to'), purpose: val(m, 'purpose') });
    closeModal(); window.open(`/api/doc/letter/${l.id}?print=1`, '_blank'); toast(l.number); after();
  });
}
PAGES.hrrequests = async () => {
  const [rows, emps] = await Promise.all([api('GET', 'hr/requests'), api('GET', 'employees')]);
  main(`<div class="bar"><h1>${tr('طلبات الموظفين', 'Employee requests')}</h1><span class="sp"></span><button class="btn" id="add">+ ${tr('طلب نيابةً عن موظف', 'Request on behalf')}</button></div>
  <div class="tw"><table><thead><tr><th>${tr('التاريخ', 'Date')}</th><th>${tr('الموظف', 'Employee')}</th><th>${tr('الطلب', 'Request')}</th><th>${tr('التفاصيل', 'Details')}</th><th>${tr('الحالة', 'Status')}</th><th></th></tr></thead><tbody>
  ${rows.map(r => `<tr><td>${esc(r.created)}</td><td>${esc(r.name)}</td><td>${tr(...REQT[r.type])}${r.amount ? ` — ${money(r.amount)}` : ''}</td><td>${esc(r.details || '')}${r.decision_note ? `<div class="muted">${esc(r.decision_note)}</div>` : ''}</td><td>${rtag(r.status)}</td>
   <td>${r.status === 'pending' ? (LETTER_TYPES.includes(r.type) ? `<button class="btn sm" data-iss="${r.id}">${tr('إصدار الخطاب', 'Issue letter')}</button> ` : `<button class="btn sm" data-dec="${r.id}" data-who="${esc(r.name)}">${tr('قرار', 'Decide')}</button> `) : (r.letter_id ? `<a class="btn sec sm" target="_blank" href="/api/doc/letter/${r.letter_id}?print=1">${tr('الخطاب', 'Letter')}</a>` : '')}${r.status === 'pending' && LETTER_TYPES.includes(r.type) ? `<button class="btn sec sm" data-rej="${r.id}">${tr('رفض', 'Reject')}</button>` : ''}</td></tr>`).join('') || `<tr><td colspan="6" class="muted">${tr('لا توجد طلبات', 'No requests')}</td></tr>`}</tbody></table></div>`);
  $('#add').onclick = () => simpleModal({ title: tr('طلب جديد', 'New request'), table: 'hr/requests', after: render, fields: [
    { k: 'employee_id', ar: 'الموظف', en: 'Employee', type: 'select', options: refOpts(emps.filter(e => e.status === 'active'), e => e.name, false) }, { k: 'type', ar: 'نوع الطلب', en: 'Request type', type: 'select', options: Object.entries(REQT).map(([k, v]) => [k, tr(...v)]) },
    { k: 'amount', ar: 'المبلغ (للسلفة)', en: 'Amount (advances)', type: 'number', def: 0 }, { k: 'details', ar: 'التفاصيل', en: 'Details', full: 1 }] });
  document.querySelectorAll('[data-dec]').forEach(b => b.onclick = decideReq(`hr/requests/${b.dataset.dec}/decide`, b.dataset.who));
  document.querySelectorAll('[data-rej]').forEach(b => b.onclick = guard(async () => { const note = prompt(tr('سبب الرفض:', 'Reason for rejection:')); if (note !== null) { await api('PUT', `hr/requests/${b.dataset.rej}/decide`, { status: 'rejected', note }); render(); } }));
  document.querySelectorAll('[data-iss]').forEach(b => b.onclick = guard(async () => {
    const r = rows.find(x => x.id === +b.dataset.iss);
    await issueLetter(r.type, r.employee_id, r.id, { purpose: r.details });
  }));
};
PAGES.letters = async () => {
  const [rows, emps] = await Promise.all([api('GET', 'hr/letters'), api('GET', 'employees')]);
  main(`<div class="bar"><h1>${tr('الخطابات الرسمية', 'Official letters')}</h1><span class="sp"></span><button class="btn" id="add">+ ${tr('خطاب جديد', 'New letter')}</button></div>
  <div class="tw"><table><thead><tr><th>${tr('المرجع', 'Ref')}</th><th>${tr('التاريخ', 'Date')}</th><th>${tr('النوع', 'Type')}</th><th>${tr('الموظف', 'Employee')}</th><th>${tr('الغرض', 'Purpose')}</th><th>${tr('أصدره', 'Issued by')}</th><th></th></tr></thead><tbody>
  ${rows.map(l => `<tr><td>${esc(l.number)}</td><td>${esc(l.date)}</td><td>${tr(...REQT[l.type])}</td><td>${esc(l.name)}</td><td>${esc(l.purpose || '')}</td><td>${esc(l.created_by || '')}</td><td><a class="btn sec sm" target="_blank" href="/api/doc/letter/${l.id}?print=1">${tr('طباعة', 'Print')}</a> <a class="btn sec sm" target="_blank" href="/api/doc/letter/${l.id}/pdf">PDF</a></td></tr>`).join('') || `<tr><td colspan="7" class="muted">${tr('لا توجد خطابات', 'No letters yet')}</td></tr>`}</tbody></table></div>`);
  $('#add').onclick = () => {
    const f = [{ k: 'employee_id', ar: 'الموظف', en: 'Employee', type: 'select', options: refOpts(emps, e => e.name, false) }, { k: 'type', ar: 'نوع الخطاب', en: 'Letter type', type: 'select', options: LETTER_TYPES.map(k => [k, tr(...REQT[k])]) },
      { k: 'addressed_to', ar: 'موجّه إلى', en: 'Addressed to' }, { k: 'purpose', ar: 'الغرض', en: 'Purpose' }];
    const m = modal(`<h2>${tr('خطاب جديد', 'New letter')}</h2><div class="f2">${f.map(x => field(x, '')).join('')}</div><div class="acts"><button class="btn" id="save">${tr('إصدار وطباعة', 'Issue & print')}</button><button class="btn sec" id="cancel">${tr('إلغاء', 'Cancel')}</button></div>`);
    $('#cancel', m).onclick = closeModal;
    $('#save', m).onclick = guard(async () => { const b = {}; f.forEach(x => b[x.k] = val(m, x.k)); const l = await api('POST', 'hr/letters', b); closeModal(); window.open(`/api/doc/letter/${l.id}?print=1`, '_blank'); render(); });
  };
};

// ---- attendance ----------------------------------------------------------------------------------
PAGES.attendance = async () => {
  const date = sessionStorage.ad || today();
  const [a, projects] = await Promise.all([api('GET', `attendance?date=${date}`), api('GET', 'projects').catch(() => [])]);
  const byEmp = Object.fromEntries(a.rows.map(r => [r.employee_id, r]));
  main(`<div class="bar"><h1>${tr('الحضور والعمل الإضافي', 'Attendance & overtime')}</h1><span class="sp"></span><input type="date" id="d" value="${date}" style="width:auto"></div>
  <p class="muted">${tr('تُحفظ كل تغييرات السطر تلقائياً. الساعات الإضافية والغياب يغذّيان كشف الرواتب عند إنشائه (+٢٥٪ نهاراً، +٥٠٪ ليلاً/راحة).', 'Each row saves automatically. Overtime hours and absences feed the payroll sheet when it is generated (+25% day, +50% night/rest day).')}</p>
  <div class="tw"><table><thead><tr><th>${tr('الموظف', 'Employee')}</th><th>${tr('الحالة', 'Status')}</th><th class="n">${tr('إضافي عادي (ساعة)', 'OT +25% (h)')}</th><th class="n">${tr('إضافي ليلي/راحة (ساعة)', 'OT +50% (h)')}</th><th>${tr('المشروع', 'Project')}</th><th>${tr('ملاحظة', 'Note')}</th></tr></thead><tbody>
  ${a.roster.map(e => { const r = byEmp[e.id] || { status: 'present', ot_normal_hours: 0, ot_special_hours: 0, project_id: e.project_id, note: '' }; return `<tr data-e="${e.id}"><td>${esc(e.name)}<div class="muted">${esc(e.designation || '')}</div></td>
    <td><select data-f="status">${Object.entries(ATT_ST).map(([k, v]) => `<option value="${k}" ${r.status === k ? 'selected' : ''}>${tr(...v)}</option>`).join('')}</select></td>
    <td class="n"><input data-f="ot_normal_hours" type="number" step="any" style="width:80px" value="${r.ot_normal_hours}"></td><td class="n"><input data-f="ot_special_hours" type="number" step="any" style="width:80px" value="${r.ot_special_hours}"></td>
    <td><select data-f="project_id">${refOpts(projects, p => `${p.code || ''} ${p.name}`).map(([k, l]) => `<option value="${k}" ${String(k) === String(r.project_id ?? '') ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></td><td><input data-f="note" value="${esc(r.note || '')}"></td></tr>`; }).join('') || `<tr><td colspan="6" class="muted">${tr('لا يوجد موظفون', 'No employees')}</td></tr>`}</tbody></table></div>`);
  $('#d').onchange = e => { sessionStorage.ad = e.target.value; render(); };
  document.querySelectorAll('tr[data-e]').forEach(tr_ => tr_.querySelectorAll('[data-f]').forEach(x => x.onchange = guard(async () => {
    const body = { employee_id: +tr_.dataset.e, date }; tr_.querySelectorAll('[data-f]').forEach(y => body[y.dataset.f] = y.value);
    await api('PUT', 'attendance', body); tr_.style.background = '#eefaf1'; setTimeout(() => (tr_.style.background = ''), 600);
  })));
};

// ---- extras inside the employee edit modal: documents + portal login ----------------------------------
window.employeeExtras = async (m, row) => {
  if (!row) return;
  if (window.docsPanel) await docsPanel(m, 'employee', row.id, ['admin', 'hr'].includes(ME.role));
  if (!['admin', 'hr'].includes(ME.role)) return;
  const users = await api('GET', 'users').catch(() => []), acc = users.find(u => u.employee_id === row.id);
  const box = document.createElement('div'); box.className = 'card';
  const mod = m.querySelector('.modal'); mod.insertBefore(box, mod.querySelector('.acts'));
  box.innerHTML = `<h2>${tr('حساب بوابة الموظف', 'Employee portal account')}</h2>` + (acc
    ? `<p>${tr('اسم المستخدم', 'Username')}: <b>${esc(acc.username)}</b> <button type="button" class="btn sec sm" id="rp">${tr('إعادة تعيين كلمة المرور', 'Reset password')}</button></p>`
    : `<div class="f2"><div class="f"><input id="pu" placeholder="${tr('اسم المستخدم', 'Username')}"></div><div class="f"><input id="pp" type="password" placeholder="${tr('كلمة مرور (٦ أحرف+)', 'Password (6+ chars)')}"></div></div><button type="button" class="btn sm" id="cu">${tr('إنشاء حساب', 'Create account')}</button>
       <p class="muted">${tr('يرى الموظف رصيد إجازاته وقسائم راتبه ويقدّم طلباته فقط. يحتاج النظام أن يكون متاحاً أونلاين ليستخدمه الموظفون من هواتفهم.', 'The employee sees only their leave balance and payslips and files requests. The system must be reachable online for staff to use it from their phones.')}</p>`);
  if ($('#cu', box)) $('#cu', box).onclick = guard(async () => { await api('POST', 'users', { username: $('#pu', box).value, password: $('#pp', box).value, role: 'employee', employee_id: row.id }); toast(tr('تم إنشاء الحساب', 'Account created')); closeModal(); render(); });
  if ($('#rp', box)) $('#rp', box).onclick = guard(async () => { const p = prompt(tr('كلمة المرور الجديدة:', 'New password:')); if (p) { await api('PUT', 'users/' + acc.id, { password: p }); toast(tr('تم', 'Done')); } });
};

// ---- employee self-service portal ---------------------------------------------------------------------
PAGES.portal = async () => {
  const d = await api('GET', 'me'), e = d.employee, b = d.balance;
  const k = (l, v, c = '') => `<div class="kpi"><div class="l">${l}</div><div class="v ${c}">${v}</div></div>`;
  const exp = [['eid_expiry', tr('الهوية الإماراتية', 'Emirates ID')], ['visa_expiry', tr('الإقامة', 'Residence visa')], ['passport_expiry', tr('جواز السفر', 'Passport')], ['card_expiry', tr('بطاقة العمل', 'Labour card')]].filter(([f]) => e[f]);
  main(`<div class="bar"><h1>${tr('أهلاً', 'Welcome')} ${esc(e.name)}</h1><span class="sp"></span><button class="btn" id="rl">+ ${tr('طلب إجازة', 'Request leave')}</button><button class="btn sec" id="rq">+ ${tr('طلب آخر', 'Other request')}</button></div>
  <p class="muted">${esc(e.designation || '')} · ${tr('تاريخ الالتحاق', 'Joined')} ${esc(e.join_date || '—')}</p>
  <div class="grid">${k(tr('رصيد الإجازة السنوية (أيام)', 'Annual leave balance (days)'), b.balance, b.balance < 0 ? 'bad' : 'ok')}${k(tr('المستحق حتى اليوم', 'Accrued to date'), b.accrued)}${k(tr('المستخدم', 'Used'), b.used)}${k(tr('إجازة مرضية (آخر ١٢ شهراً)', 'Sick leave (last 12 months)'), `${b.sick_used_12m}/90`)}</div>
  ${exp.length ? `<div class="card"><h2>${tr('تواريخ انتهاء مستنداتي', 'My document expiry dates')}</h2>${exp.map(([f, l]) => `<div>${l}: <b>${esc(e[f])}</b></div>`).join('')}</div>` : ''}
  <h2>${tr('إجازاتي', 'My leave')}</h2><div class="tw"><table><tbody>${d.leaves.map(l => `<tr><td>${lt(l.type)}</td><td>${esc(l.start_date)} → ${esc(l.end_date)}</td><td class="n">${l.days}</td><td>${rtag(l.status)}${l.decision_note ? `<div class="muted">${esc(l.decision_note)}</div>` : ''}</td><td>${l.status === 'pending' ? `<button class="btn sec sm" data-cl="${l.id}">${tr('إلغاء', 'Cancel')}</button>` : ''}</td></tr>`).join('') || `<tr><td class="muted">—</td></tr>`}</tbody></table></div>
  <h2 style="margin-top:16px">${tr('طلباتي', 'My requests')}</h2><div class="tw"><table><tbody>${d.requests.map(r => `<tr><td>${esc(r.created)}</td><td>${tr(...REQT[r.type])}${r.amount ? ` — ${money(r.amount)}` : ''}</td><td>${rtag(r.status)}${r.decision_note ? `<div class="muted">${esc(r.decision_note)}</div>` : ''}</td><td>${r.status === 'approved' && r.letter_id ? `<a class="btn sec sm" target="_blank" href="/api/me/letter/${r.letter_id}?print=1">${tr('تحميل الخطاب', 'Open letter')}</a> <a class="btn sec sm" target="_blank" href="/api/me/letter/${r.letter_id}/pdf">PDF</a>` : ''}${r.status === 'pending' ? `<button class="btn sec sm" data-cr="${r.id}">${tr('إلغاء', 'Cancel')}</button>` : ''}</td></tr>`).join('') || `<tr><td class="muted">—</td></tr>`}</tbody></table></div>
  <h2 style="margin-top:16px">${tr('قسائم الراتب', 'Payslips')}</h2><div class="tw"><table><tbody>${d.payslips.map(p => `<tr><td>${esc(p.month)}</td><td class="n">${money(p.net)}</td><td>${p.paid_date ? `${tr('صُرف', 'Paid')} ${esc(p.paid_date)}` : tr('قيد الصرف', 'Pending')}</td><td><a class="btn sec sm" target="_blank" href="/api/me/payslip/${p.id}?print=1">${tr('عرض / طباعة', 'View / print')}</a> <a class="btn sec sm" target="_blank" href="/api/me/payslip/${p.id}/pdf">PDF</a></td></tr>`).join('') || `<tr><td class="muted">${tr('لا توجد قسائم بعد', 'No payslips yet')}</td></tr>`}</tbody></table></div>`);
  $('#rl').onclick = () => simpleModal({ title: tr('طلب إجازة', 'Leave request'), table: 'me/leave', after: render, fields: [
    { k: 'type', ar: 'نوع الإجازة', en: 'Leave type', type: 'select', options: Object.entries(LEAVE).map(([k, v]) => [k, tr(...v)]) }, { k: 'start_date', ar: 'من', en: 'From', type: 'date', def: today() }, { k: 'end_date', ar: 'إلى', en: 'To', type: 'date', def: today() }, { k: 'reason', ar: 'السبب', en: 'Reason', full: 1 }] });
  $('#rq').onclick = () => simpleModal({ title: tr('طلب جديد', 'New request'), table: 'me/request', after: render, fields: [
    { k: 'type', ar: 'نوع الطلب', en: 'Request type', type: 'select', options: Object.entries(REQT).map(([k, v]) => [k, tr(...v)]) }, { k: 'amount', ar: 'المبلغ (للسلفة)', en: 'Amount (advances)', type: 'number', def: 0 }, { k: 'details', ar: 'التفاصيل (الغرض / الجهة الموجّه إليها)', en: 'Details (purpose / addressed to)', full: 1 }] });
  document.querySelectorAll('[data-cl]').forEach(x => x.onclick = guard(async () => { await api('DELETE', 'me/leave/' + x.dataset.cl); render(); }));
  document.querySelectorAll('[data-cr]').forEach(x => x.onclick = guard(async () => { await api('DELETE', 'me/request/' + x.dataset.cr); render(); }));
};
