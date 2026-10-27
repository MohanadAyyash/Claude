// Project control & teamwork screens: budget vs actual vs committed with forecast, weekly updates, tasks board, notes with @mentions.
const BCAT = ['materials', 'labour', 'subcontract', 'equipment', 'transport', 'permits', 'accommodation', 'visa', 'insurance', 'overhead', 'other'];
const PST = { on_track: ['على المسار', 'On track', 'paid'], at_risk: ['في خطر', 'At risk', 'unpaid'], off_track: ['خارج المسار', 'Off track', 'overdue'], on_hold: ['متوقف', 'On hold', ''], complete: ['مكتمل', 'Complete', 'paid'] };
const TST = { todo: ['جديدة', 'To do'], doing: ['قيد التنفيذ', 'In progress'], done: ['منجزة', 'Done'], cancelled: ['ملغاة', 'Cancelled'] };
const TTAG = { site: ['الموقع', 'Site'], commercial: ['تجاري', 'Commercial'], authorities: ['الجهات الحكومية', 'Authorities'], hse: ['السلامة', 'HSE'], qaqc: ['الجودة', 'QA/QC'], procurement: ['المشتريات', 'Procurement'], other: ['أخرى', 'Other'] };
const pst = s => { const l = PST[s] || [s, s, '']; return `<span class="tag ${l[2]}">${tr(l[0], l[1])}</span>`; };
let USERS = null;
const users = async () => USERS || (USERS = await api('GET', 'tasks/people').catch(() => []));
const uname = (list, id) => { const u = list.find(x => x.id === id); return u ? (u.display_name || u.username) : ''; };

// ---- notes panel (any record) ----
async function notesPanel(box, entity, id) {
  const draw = async () => {
    const rows = await api('GET', `notes?entity=${entity}&id=${id}`);
    box.innerHTML = `<h2>${tr('الملاحظات والمتابعة', 'Notes & follow-up')}</h2><div class="bar"><input id="nb-${entity}" placeholder="${tr('اكتب ملاحظة… واذكر زميلاً بـ @اسم_المستخدم ليصله تنبيه', 'Write a note… mention a colleague with @username to notify them')}"><button class="btn sm" id="ns-${entity}">${tr('إضافة', 'Add')}</button></div>
      ${rows.map(n => `<div style="padding:6px 0;border-bottom:1px solid #e6e2d8"><b>${esc(n.username)}</b> <span class="muted" style="font-size:12px">${esc(n.created)}</span>${n.user_id === ME.id || ME.role === 'admin' ? ` <a href="#" data-nd="${n.id}" class="muted" style="font-size:12px">×</a>` : ''}<div>${esc(n.body).replace(/@([\w.\-@]{3,40})/g, '<b>@$1</b>')}</div></div>`).join('') || `<p class="muted">—</p>`}`;
    $(`#ns-${entity}`, box).onclick = guard(async () => { const v = $(`#nb-${entity}`, box).value; const r = await api('POST', 'notes', { entity, entity_id: id, body: v }); if (r.mentioned.length) toast(`${tr('تم تنبيه', 'Notified')} ${r.mentioned.join(', ')}`); draw(); });
    box.querySelectorAll('[data-nd]').forEach(a => a.onclick = guard(async e => { e.preventDefault(); await api('DELETE', 'notes/' + a.dataset.nd); draw(); }));
  };
  await draw();
}
window.notesPanel = notesPanel;

// ---- task editor ----
async function taskModal(t, defaults = {}) {
  const us = await users(), projects = await api('GET', 'projects').catch(() => []);
  const canEdit = !t || ['admin', 'manager', 'hr', 'accountant'].includes(ME.role) || t.created_by === ME.id;
  const f = [{ k: 'title', ar: 'المهمة', en: 'Task', req: 1, full: 1 }, { k: 'assignee_user_id', ar: 'المسؤول', en: 'Assignee', type: 'select', options: refOpts(us, u => u.display_name || u.username) },
    { k: 'due_date', ar: 'الموعد النهائي', en: 'Due date', type: 'date' }, { k: 'status', ar: 'الحالة', en: 'Status', type: 'select', options: Object.entries(TST).map(([k, v]) => [k, tr(...v)]) },
    { k: 'tag', ar: 'التصنيف', en: 'Tag', type: 'select', options: [['', '—'], ...Object.entries(TTAG).map(([k, v]) => [k, tr(...v)])] }, { k: 'project_id', ar: 'المشروع', en: 'Project', type: 'select', options: refOpts(projects, p => `${p.code || ''} ${p.name}`) },
    { k: 'description', ar: 'التفاصيل', en: 'Details', type: 'textarea', full: 1 }];
  const v = { status: 'todo', ...defaults, ...(t || {}) };
  const m = modal(`<h2>${t ? tr('مهمة', 'Task') : tr('مهمة جديدة', 'New task')}</h2><div class="f2">${f.map(x => field(x, v[x.k] ?? '')).join('')}</div>
    ${t ? `<h3>${tr('مهام فرعية', 'Sub-tasks')}</h3>${t.subtasks.map(s => `<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" style="width:auto" data-sub="${s.id}" ${s.status === 'done' ? 'checked' : ''}> ${esc(s.title)} <span class="muted">${esc(uname(us, s.assignee_user_id))} ${esc(s.due_date || '')}</span></label>`).join('')}
      ${canEdit ? `<div class="bar"><input id="subt" placeholder="${tr('مهمة فرعية جديدة', 'New sub-task')}"><button type="button" class="btn sec sm" id="subadd">+</button></div>` : ''}<div class="card" id="tnotes"></div>` : ''}
    <div class="acts"><button class="btn" id="save">${tr('حفظ', 'Save')}</button><button class="btn sec" id="cancel">${tr('إغلاق', 'Close')}</button><span class="sp"></span>${t && canEdit ? `<button class="btn bad" id="del">${tr('حذف', 'Delete')}</button>` : ''}</div>`, true);
  if (!canEdit) m.querySelectorAll('[name]').forEach(x => { if (x.name !== 'status') x.disabled = true; });
  $('#cancel', m).onclick = () => { closeModal(); if (t && location.hash.startsWith('#tasks/')) go('tasks'); };
  $('#save', m).onclick = guard(async () => {
    const body = {}; f.forEach(x => { const el = m.querySelector(`[name="${x.k}"]`); if (el && !el.disabled) body[x.k] = el.value; });
    if (t) await api('PUT', 'tasks/' + t.id, body); else await api('POST', 'tasks', { ...defaults, ...body });
    closeModal(); render();
  });
  if ($('#del', m)) $('#del', m).onclick = guard(async () => { if (confirmDel()) { await api('DELETE', 'tasks/' + t.id); closeModal(); render(); } });
  m.querySelectorAll('[data-sub]').forEach(c => c.onchange = guard(async () => { await api('PUT', 'tasks/' + c.dataset.sub, { status: c.checked ? 'done' : 'todo' }); }));
  if ($('#subadd', m)) $('#subadd', m).onclick = guard(async () => { await api('POST', 'tasks', { parent_id: t.id, title: $('#subt', m).value }); taskModal(await api('GET', 'tasks/' + t.id)); });
  if ($('#tnotes', m) && ME.role !== 'employee') notesPanel($('#tnotes', m), 'task', t.id);
}
window.taskModal = taskModal;
const taskCard = (t, us) => `<div class="card click" data-task="${t.id}" style="padding:10px;margin:6px 0;cursor:pointer"><b>${esc(t.title)}</b>
  <div class="muted" style="font-size:12px">${t.tag ? `<span class="tag">${tr(...(TTAG[t.tag] || [t.tag, t.tag]))}</span> ` : ''}${esc(t.assignee ? (t.assignee.display_name || t.assignee.username || '') : uname(us, t.assignee_user_id))}${t.due_date ? ` · <span class="${t.overdue ? 'neg' : ''}">${esc(t.due_date)}</span>` : ''}${t.subtasks.length ? ` · ↳ ${t.subtasks.filter(s => s.status === 'done').length}/${t.subtasks.length}` : ''}</div></div>`;
const wireTasks = root => root.querySelectorAll('[data-task]').forEach(c => c.onclick = guard(async () => taskModal(await api('GET', 'tasks/' + c.dataset.task))));

// ---- tasks page ----
PAGES.tasks = async id => {
  if (id) { await PAGES.tasks(); return taskModal(await api('GET', 'tasks/' + id)); }
  const mine = sessionStorage.taskMine !== '0', [rows, us] = await Promise.all([api('GET', `tasks?open=1${mine ? '&mine=1' : ''}`), users()]);
  main(`<div class="bar"><h1>${tr('المهام', 'Tasks')}</h1><span class="sp"></span><select id="tm" style="width:auto"><option value="1" ${mine ? 'selected' : ''}>${tr('مهامي', 'My tasks')}</option><option value="0" ${mine ? '' : 'selected'}>${tr('كل المهام المفتوحة', 'All open tasks')}</option></select>${ME.role !== 'employee' ? `<button class="btn" id="tadd">+ ${tr('مهمة', 'Task')}</button>` : ''}</div>
    <div class="f2">${['todo', 'doing'].map(s => `<div><h3>${tr(...TST[s])} (${rows.filter(t => t.status === s).length})</h3>${rows.filter(t => t.status === s).map(t => taskCard(t, us)).join('') || '<p class="muted">—</p>'}</div>`).join('')}</div>`);
  $('#tm').onchange = e => { sessionStorage.taskMine = e.target.value; render(); };
  if ($('#tadd')) $('#tadd').onclick = () => taskModal(null);
  wireTasks($('#main'));
};

// ---- project page: budget, forecast, weekly updates, tasks board, notes ----
const baseProjectDetail2 = projectDetail;
projectDetail = async id => {
  await baseProjectDetail2(id);
  if (!$('#main')) return;
  if (!seesMoney()) {                                                     // site roles: tasks and notes only (no budget, no forecasts)
    const [tasks, us] = await Promise.all([api('GET', `tasks?project_id=${id}`), users()]);
    const tc = document.createElement('div'); tc.className = 'card';
    tc.innerHTML = `<div class="bar"><h2 style="margin:0">${tr('المهام', 'Tasks')}</h2><span class="sp"></span><button class="btn sm" id="padd">+ ${tr('مهمة', 'Task')}</button></div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px">${['todo', 'doing', 'done'].map(s => `<div><h3>${tr(...TST[s])}</h3>${tasks.filter(t => t.status === s).map(t => taskCard(t, us)).join('') || '<p class="muted">—</p>'}</div>`).join('')}</div>`;
    const nc = document.createElement('div'); nc.className = 'card';
    $('#main').append(tc, nc); notesPanel(nc, 'project', id); wireTasks(tc);
    $('#padd').onclick = () => taskModal(null, { project_id: id });
    return;
  }
  const [b, ups, tasks, us] = await Promise.all([api('GET', `projects/${id}/budget`), api('GET', `projects/${id}/updates`), api('GET', `tasks?project_id=${id}`), users()]);
  const edit = ['admin', 'accountant', 'manager'].includes(ME.role), F = b.forecast;
  const bc = document.createElement('div'); bc.className = 'card';
  bc.innerHTML = `<h2>${tr('الميزانية والتوقعات', 'Budget & forecast')}</h2>
    <div class="grid">${[[tr('الميزانية', 'Budget'), b.totals.budget], [tr('الفعلي', 'Actual'), b.totals.actual], [tr('ملتزم به (أوامر شراء ومقاولو باطن)', 'Committed (POs & subcontracts)'), b.totals.committed], [tr('التكلفة المتوقعة عند الإنجاز', 'Forecast cost at completion'), F.cost_at_completion], [tr('الربح المتوقع', 'Forecast margin'), F.margin]].map(([l, v], i) => `<div class="kpi"><div class="l">${l}</div><div class="v ${i === 3 && F.over_budget ? 'bad' : i === 4 ? (v >= 0 ? 'ok' : 'bad') : ''}">${money(v)}</div></div>`).join('')}</div>
    <p class="muted">${tr('التكلفة المتوقعة = الفعلي حتى الآن + ميزانية الأعمال غير المنجزة', 'Forecast cost = actual so far + budget of the work not yet done')} (${tr('الإنجاز', 'progress')} ${b.progress}%)${F.over_budget ? ` — <b class="neg">${tr('التكلفة المتوقعة تتجاوز الميزانية', 'forecast cost is over budget')}</b>` : ''}</p>
    <div class="tw"><table><thead><tr><th>${tr('البند', 'Category')}</th><th class="n">${tr('الميزانية', 'Budget')}</th><th class="n">${tr('الفعلي', 'Actual')}</th><th class="n">${tr('ملتزم به', 'Committed')}</th><th class="n">${tr('المتبقي', 'Remaining')}</th><th class="n">%</th></tr></thead><tbody>
    ${b.lines.map(l => `<tr><td>${tr(...(CATS[l.category] || [l.category, l.category]))}</td><td class="n">${edit ? `<input data-bud="${l.category}" type="number" step="any" style="width:120px" value="${l.budget || ''}">` : money(l.budget)}</td><td class="n">${money(l.actual)}</td><td class="n">${money(l.committed)}</td><td class="n ${l.remaining < 0 ? 'neg' : ''}">${money(l.remaining)}</td><td class="n ${l.used_pct > 100 ? 'neg' : ''}">${l.used_pct == null ? '—' : l.used_pct + '%'}</td></tr>`).join('')}</tbody></table></div>
    ${edit ? `<button class="btn sm" id="bsave">${tr('حفظ الميزانية', 'Save budget')}</button>` : ''}`;
  const uc = document.createElement('div'); uc.className = 'card';
  uc.innerHTML = `<div class="bar"><h2 style="margin:0">${tr('التقارير الأسبوعية', 'Weekly updates')}</h2><span class="sp"></span>${edit ? `<button class="btn sm" id="uadd">+ ${tr('تقرير', 'Update')}</button>` : ''}</div>
    ${ups.slice(0, 6).map(u => `<div style="padding:8px 0;border-bottom:1px solid #e6e2d8">${pst(u.status)} <b>${esc(u.date)}</b> · ${u.progress}% · <span class="muted">${esc(u.author)}</span><div>${esc(u.summary || '')}</div><div class="muted" style="font-size:12px">${tr('الفعلي', 'Actual')} ${money(u.snapshot.actual)} · ${tr('المتوقع', 'Forecast')} ${money(u.snapshot.cost_at_completion)} · ${tr('الربح المتوقع', 'Margin')} ${money(u.snapshot.margin)}</div></div>`).join('') || `<p class="muted">${tr('لا توجد تقارير بعد', 'No updates yet')}</p>`}`;
  const tc = document.createElement('div'); tc.className = 'card';
  tc.innerHTML = `<div class="bar"><h2 style="margin:0">${tr('المهام', 'Tasks')}</h2><span class="sp"></span><button class="btn sm" id="padd">+ ${tr('مهمة', 'Task')}</button></div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px">${['todo', 'doing', 'done'].map(s => `<div><h3>${tr(...TST[s])}</h3>${tasks.filter(t => t.status === s).map(t => taskCard(t, us)).join('') || '<p class="muted">—</p>'}</div>`).join('')}</div>`;
  const nc = document.createElement('div'); nc.className = 'card';
  const anchor = $('#contract-card') || $('#main .grid'); anchor.after(bc); bc.after(uc); uc.after(tc); tc.after(nc);
  notesPanel(nc, 'project', id); wireTasks(tc);
  $('#padd').onclick = () => taskModal(null, { project_id: id });
  if ($('#bsave')) $('#bsave').onclick = guard(async () => { const lines = {}; bc.querySelectorAll('[data-bud]').forEach(i => lines[i.dataset.bud] = +i.value || 0); await api('PUT', `projects/${id}/budget`, { lines }); toast(tr('تم الحفظ', 'Saved')); projectDetail(id); });
  if ($('#uadd')) $('#uadd').onclick = () => {
    const m = modal(`<h2>${tr('تقرير أسبوعي', 'Weekly update')}</h2><div class="f2">${field({ k: 'status', ar: 'الحالة', en: 'Status', type: 'select', options: Object.entries(PST).map(([k, v]) => [k, tr(v[0], v[1])]) }, 'on_track')}
      ${field({ k: 'progress', ar: 'نسبة الإنجاز %', en: 'Progress %', type: 'number' }, b.progress)}${field({ k: 'date', ar: 'التاريخ', en: 'Date', type: 'date' }, today())}${field({ k: 'summary', ar: 'كيف يسير المشروع؟ (الإنجازات، العوائق، الخطوات القادمة)', en: 'How is it going? (done, issues, next steps)', type: 'textarea', full: 1 }, '')}</div>
      <p class="muted">${tr('تُحفظ مع التقرير أرقام الميزانية والفعلي والمتوقع في هذا التاريخ.', 'The budget, actual and forecast figures at this date are saved with the update.')}</p>
      <div class="acts"><button class="btn" id="save">${tr('حفظ', 'Save')}</button><button class="btn sec" id="cancel">${tr('إلغاء', 'Cancel')}</button></div>`);
    $('#cancel', m).onclick = closeModal;
    $('#save', m).onclick = guard(async () => { await api('POST', `projects/${id}/updates`, { status: val(m, 'status'), progress: val(m, 'progress'), date: val(m, 'date'), summary: val(m, 'summary') }); closeModal(); projectDetail(id); });
  };
};

// ---- employee portal: my tasks ----
const basePortal2 = PAGES.portal;
PAGES.portal = async () => {
  await basePortal2();
  const rows = await api('GET', 'tasks?mine=1&open=1').catch(() => []);
  if (!rows.length || !$('#main')) return;
  const box = document.createElement('div'); box.className = 'card';
  box.innerHTML = `<h2>${tr('مهامي', 'My tasks')}</h2>${rows.map(t => `<label style="display:flex;gap:8px;align-items:center;padding:4px 0"><input type="checkbox" style="width:auto" data-done="${t.id}"> ${esc(t.title)} ${t.due_date ? `<span class="${t.overdue ? 'neg' : 'muted'}">${esc(t.due_date)}</span>` : ''}</label>`).join('')}`;
  $('#main .bar').after(box);
  box.querySelectorAll('[data-done]').forEach(c => c.onchange = guard(async () => { await api('PUT', 'tasks/' + c.dataset.done, { status: c.checked ? 'done' : 'todo' }); toast(tr('تم', 'Done')); }));
};

// ---- employee record: notes ----
const baseExtras2 = window.employeeExtras;
window.employeeExtras = async (m, row) => {
  if (baseExtras2) await baseExtras2(m, row);
  if (!row) return;
  const box = document.createElement('div'); box.className = 'card'; const mod = m.querySelector('.modal'); mod.insertBefore(box, mod.querySelector('.acts'));
  notesPanel(box, 'employee', row.id);
};
