// Tenders & opportunities pipeline: stages board, pipeline value, weighted forecast, win rate; quotation and project from a tender.
const TSTAGE = { lead: ['فرصة', 'Lead'], invited: ['دعوة لمناقصة', 'Invited'], preparing: ['قيد التسعير', 'Preparing'], submitted: ['مُقدَّمة', 'Submitted'], negotiation: ['تفاوض', 'Negotiation'], won: ['فزنا', 'Won'], lost: ['خسرنا', 'Lost'] };
PAGES.tenders = async () => {
  const d = await api('GET', 'tenders'), s = d.summary, ops = ['admin', 'accountant', 'manager', 'qs'].includes(ME.role);
  const k = (l, v, c = '') => `<div class="kpi"><div class="l">${l}</div><div class="v ${c}">${v}</div></div>`;
  const card = t => `<div class="card click" data-t="${t.id}" style="padding:10px;margin:6px 0;cursor:pointer"><b>${esc(t.title)}</b><div class="muted" style="font-size:12px">${esc(t.client || '')}</div>
    <div style="font-size:13px">${money(t.value)} · ${t.probability}%${t.submission_date ? ` · <span class="${t.due_soon ? 'neg' : 'muted'}">${tr('تقديم', 'due')} ${esc(t.submission_date)}</span>` : ''}</div>
    ${t.quote ? `<div class="muted" style="font-size:12px">${esc(t.quote.number)} ${tag(t.quote.status)}${t.quote.accepted_at ? ' ✔' : ''}</div>` : ''}</div>`;
  const open = ['lead', 'invited', 'preparing', 'submitted', 'negotiation'];
  main(`<div class="bar"><h1>${tr('المناقصات والفرص', 'Tenders & opportunities')}</h1><span class="sp"></span>${ops ? `<button class="btn" id="tadd">+ ${tr('مناقصة / فرصة', 'Tender / opportunity')}</button>` : ''}</div>
  <div class="grid">${k(tr('مفتوحة', 'Open'), s.open)}${k(tr('قيمة الفرص المفتوحة', 'Open pipeline'), money(s.pipeline))}${k(tr('المتوقع (القيمة × الاحتمال)', 'Weighted (value × probability)'), money(s.weighted))}${k(tr('فزنا هذا العام', 'Won this year'), money(s.won_value), 'ok')}${k(tr('نسبة الفوز', 'Win rate'), s.win_rate == null ? '—' : s.win_rate + '%')}</div>
  <div style="display:grid;grid-template-columns:repeat(${open.length},minmax(200px,1fr));gap:10px;overflow-x:auto">${open.map(st => { const rows = d.rows.filter(t => t.stage === st); return `<div><h3>${tr(...TSTAGE[st])} <span class="muted">(${rows.length})</span></h3><div class="muted" style="font-size:12px">${money(rows.reduce((x, t) => x + t.value, 0))}</div>${rows.map(card).join('')}</div>`; }).join('')}</div>
  <div class="f2" style="margin-top:12px">${['won', 'lost'].map(st => `<div class="card"><h3>${tr(...TSTAGE[st])}</h3>${d.rows.filter(t => t.stage === st).slice(0, 10).map(t => `<div class="click" data-t="${t.id}" style="cursor:pointer;padding:4px 0">${esc(t.title)} — ${money(t.value)}${t.lost_reason ? ` <span class="muted">(${esc(t.lost_reason)})</span>` : ''}</div>`).join('') || '<p class="muted">—</p>'}</div>`).join('')}</div>`);
  if ($('#tadd')) $('#tadd').onclick = () => tenderModal(null);
  document.querySelectorAll('[data-t]').forEach(c => c.onclick = () => tenderModal(d.rows.find(t => t.id === +c.dataset.t)));
};
async function tenderModal(t) {
  const [parties, people] = await Promise.all([api('GET', 'parties'), api('GET', 'tasks/people').catch(() => [])]), ops = ['admin', 'accountant', 'manager', 'qs'].includes(ME.role);
  const f = [{ k: 'title', ar: 'اسم المناقصة / الفرصة', en: 'Tender / opportunity', req: 1, full: 1 }, { k: 'client_id', ar: 'العميل', en: 'Client', type: 'select', options: refOpts(parties.filter(p => p.type === 'client'), p => p.name) },
    { k: 'client_name', ar: 'أو اسم جهة جديدة', en: 'Or a new organisation name' }, { k: 'source', ar: 'المصدر (دعوة، علاقة، منصة مناقصات…)', en: 'Source (invitation, referral, tender portal…)' },
    { k: 'stage', ar: 'المرحلة', en: 'Stage', type: 'select', options: Object.entries(TSTAGE).map(([k, v]) => [k, tr(...v)]) }, { k: 'value', ar: 'القيمة التقديرية', en: 'Estimated value', type: 'number' },
    { k: 'probability', ar: 'احتمال الفوز %', en: 'Win probability %', type: 'number' }, { k: 'submission_date', ar: 'موعد التقديم', en: 'Submission date', type: 'date' },
    { k: 'closing_date', ar: 'تاريخ الإغلاق المتوقع', en: 'Expected close', type: 'date' }, { k: 'owner_user_id', ar: 'المسؤول', en: 'Owner', type: 'select', options: refOpts(people, u => u.display_name || u.username) },
    { k: 'lost_reason', ar: 'سبب الخسارة (عند الخسارة)', en: 'Lost reason (when lost)' }, { k: 'notes', ar: 'ملاحظات', en: 'Notes', type: 'textarea', full: 1 }];
  const v = t || { stage: 'lead', probability: 20, owner_user_id: ME.id };
  const m = modal(`<h2>${t ? esc(t.title) : tr('مناقصة / فرصة جديدة', 'New tender / opportunity')}</h2><div class="f2">${f.map(x => field(x, v[x.k] ?? '')).join('')}</div>
    ${t ? `<div class="bar">${t.quote ? `<button class="btn sec" id="oq">${tr('فتح عرض السعر', 'Open quotation')} ${esc(t.quote.number)}</button>` : ops ? `<button class="btn sec" id="nq">${tr('إنشاء عرض سعر', 'Create quotation')}</button>` : ''}
      ${t.quote && !t.project_id && ops ? `<button class="btn sec" id="win">🏆 ${tr('فزنا — تحويل إلى مشروع', 'Won — convert to project')}</button>` : ''}${t.project_id ? `<a class="btn sec" href="#projects/${t.project_id}" onclick="closeModal()">${tr('المشروع', 'Project')}</a>` : ''}</div><div class="card" id="tnotes"></div>` : ''}
    <div class="acts">${ops ? `<button class="btn" id="save">${tr('حفظ', 'Save')}</button>` : ''}<button class="btn sec" id="cancel">${tr('إغلاق', 'Close')}</button><span class="sp"></span>${t && ops ? `<button class="btn bad" id="del">${tr('حذف', 'Delete')}</button>` : ''}</div>`, true);
  if (!ops) m.querySelectorAll('[name]').forEach(x => (x.disabled = true));
  $('#cancel', m).onclick = closeModal;
  if ($('#save', m)) $('#save', m).onclick = guard(async () => { const b = {}; f.forEach(x => b[x.k] = val(m, x.k)); t ? await api('PUT', 'tenders/' + t.id, b) : await api('POST', 'tenders', b); closeModal(); render(); });
  if ($('#del', m)) $('#del', m).onclick = guard(async () => { if (confirmDel()) { await api('DELETE', 'tenders/' + t.id); closeModal(); render(); } });
  if ($('#nq', m)) $('#nq', m).onclick = guard(async () => { const r = await api('POST', `tenders/${t.id}/quote`); closeModal(); docModal('quotes', await api('GET', 'quotes/' + r.quote_id)); });
  if ($('#oq', m)) $('#oq', m).onclick = guard(async () => { closeModal(); docModal('quotes', await api('GET', 'quotes/' + t.quote.id)); });
  if ($('#win', m)) $('#win', m).onclick = guard(async () => {
    if (!confirm(tr('تحويل عرض السعر إلى مشروع وتسجيل الفوز؟', 'Convert the quotation to a project and mark as won?'))) return;
    const r = await api('POST', `quotes/${t.quote.id}/convert`); await api('PUT', 'tenders/' + t.id, { stage: 'won', project_id: r.project_id }); closeModal(); go('projects/' + r.project_id);
  });
  if ($('#tnotes', m) && window.notesPanel) notesPanel($('#tnotes', m), 'tender', t.id);
}
