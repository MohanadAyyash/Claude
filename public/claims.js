// Main-contractor work on the project page: payment applications (proforma) → payment certificates (PC) received → tax invoice equal to the PC.
Object.assign(STATUS, { submitted: ['مُقدَّم', 'Submitted'], certified: ['معتمد بـ PC', 'Certified'], invoiced: ['مُفوتَر', 'Invoiced'], recorded: ['مسجّل', 'Recorded'] });
const CLAIM_EDIT = () => ['admin', 'accountant', 'manager', 'qs'].includes(ME.role), CLAIM_INV = () => ['admin', 'accountant'].includes(ME.role);
const CHECK_TXT = {
  prev_payments: ['الدفعات السابقة لا تساوي صافي الشهادات السابقة', 'Previous payments differ from the net of the earlier certificates'],
  prev_work: ['قيمة الأعمال السابقة لا تساوي الشهادة السابقة', 'Previous work done differs from the last PC'],
  prev_retention: ['المحتجزات السابقة لا تساوي الشهادة السابقة', 'Previous retention differs from the last PC'],
  prev_contra: ['الخصومات السابقة لا تساوي الشهادة السابقة', 'Previous contra charges differ from the last PC'],
  prev_adv_rec: ['استرداد المقدمة السابق لا يساوي الشهادة السابقة', 'Previous advance recovery differs from the last PC'],
  prev_release: ['الإفراج السابق عن المحتجزات لا يساوي الشهادة السابقة', 'Previous retention release differs from the last PC'],
  prev_materials: ['المواد بالموقع السابقة لا تساوي الشهادة السابقة', 'Previous materials on site differ from the last PC'],
  vat: ['الضريبة المعتمدة في الـ PC لا تساوي الضريبة المحسوبة — تحقق من أساس الضريبة في المشروع', 'The VAT on the PC differs from the calculated VAT — check the VAT basis on the project'],
  lines: ['مجموع البنود لا يساوي قيمة الأعمال المدخلة', 'The items do not add up to the value of work done'],
  retention_down: ['المحتجزات أقل من الشهادة السابقة — سجّل الفرق كإفراج عن محتجزات', 'Retention is lower than on the last PC — record the difference as a release'],
  release_exceeds: ['الإفراج أكبر من المحتجزات المسجلة في النظام — أدخل رصيد المحتجزات الافتتاحي بقيد يومية على حساب 1150', 'The release is larger than the retention held in the system — enter the opening retention with a journal to account 1150'],
};
const checkList = cs => (cs || []).map(c => `<p class="err" style="color:var(--warn)">⚠ ${tr(...(CHECK_TXT[c.code] || [c.code, c.code]))}: ${tr('المتوقع', 'expected')} ${money(c.expected)} — ${tr('المدخل', 'entered')} ${money(c.actual)}</p>`).join('');
const sumTable = rows => `<table class="claimsum" style="width:100%;max-width:520px;margin-inline-start:auto"><tbody>${rows.filter(Boolean).map(([l, v, b]) => `<tr${b ? ' style="font-weight:700;border-top:1px solid var(--stone)"' : ''}><td>${l}</td><td class="n">${typeof v === 'number' ? money(v) : v}</td></tr>`).join('')}</tbody></table>`;

// ---- payment application -------------------------------------------------------------------------------------------------------
async function appModal(app, pid) {
  const locked = ['certified', 'invoiced'].includes(app.status) || !CLAIM_EDIT();
  const m = modal(`<h2>${tr('طلب دفعة', 'Payment application')} ${app.seq} <span class="muted mono" style="font-size:13px">${esc(app.number)}</span> ${tag(app.status)}</h2>
    <p class="muted">${tr('فاتورة مبدئية (بروفورما) تقدَّم للمقاول الرئيسي — بدون أي أثر محاسبي أو ضريبي. الأرقام تراكمية مثل شهادة الدفع.', 'A proforma for the main contractor — no accounting or VAT effect. Figures are cumulative, as on the payment certificate.')}${app.previous_pc ? ` ${tr('آخر شهادة', 'Last PC')}: <b>${esc(app.previous_pc)}</b>` : ''}</p>
    <div class="f2">${field({ k: 'date', ar: 'التاريخ', en: 'Date', type: 'date' }, app.date)}${field({ k: 'period_to', ar: 'للأعمال حتى تاريخ', en: 'For works up to', type: 'date' }, app.period_to)}
      ${field({ k: 'materials', ar: 'المواد بالموقع (تراكمي)', en: 'Materials on site (cumulative)', type: 'number' }, app.materials)}${field({ k: 'notes', ar: 'ملاحظات', en: 'Notes', type: 'textarea' }, app.notes)}</div>
    <div class="tw"><table><thead><tr><th>${tr('البند', 'Item')}</th><th>${tr('الوصف', 'Description')}</th><th>${tr('الوحدة', 'Unit')}</th><th class="n">${tr('كمية العقد', 'Contract qty')}</th><th class="n">${tr('السعر', 'Rate')}</th><th class="n">${tr('السابق', 'Previous')}</th><th class="n">${tr('التراكمي حتى الآن', 'Cumulative to date')}</th><th class="n">${tr('القيمة التراكمية', 'Cumulative amount')}</th><th class="n">%</th></tr></thead><tbody>
    ${app.lines.map(l => `<tr><td>${esc(l.item || '')}</td><td>${esc((l.section ? l.section + ' — ' : '') + l.description)}</td><td>${esc(l.unit)}</td><td class="n">${money(l.qty)}</td><td class="n">${money(l.rate)}</td><td class="n">${money(l.prev_qty)}</td>
      <td class="n">${locked ? money(l.cum_qty) : `<input type="number" step="any" style="width:100px" data-cq="${esc(l.key)}" value="${l.cum_qty}">`}</td><td class="n">${money(l.cum_amount)}</td><td class="n">${l.qty ? Math.round(l.cum_qty / l.qty * 1000) / 10 : 0}%</td></tr>`).join('')}</tbody></table></div>
    ${sumTable([[tr('قيمة الأعمال المنجزة حتى تاريخه', 'Value of work done to date'), app.work], app.materials ? [tr('المواد بالموقع', 'Materials on site'), app.materials] : null, app.adv_rec_cum ? [tr('ناقص استرداد الدفعة المقدمة', 'Less advance recovery'), -app.adv_rec_cum] : null, [tr('المستحق حتى تاريخه (A)', 'Due to date (A)'), app.A, 1],
      [`${tr('المحتجزات', 'Retention')} ${app.retention_pct}%`, app.retention_cum], app.release_cum ? [tr('ناقص المفرج عنه', 'Less released'), -app.release_cum] : null, app.contra_cum ? [tr('خصومات (حسب آخر PC)', 'Contra charges (last PC)'), app.contra_cum] : null, [tr('الدفعات السابقة المعتمدة', 'Previous payments certified'), app.prev_payments], [tr('مجموع الخصومات (B)', 'Total deductions (B)'), app.B, 1],
      [tr('الصافي لهذا الطلب', 'Net this application'), app.net, 1], [`${tr('الضريبة', 'VAT')} ${app.vat_pct}%${app.basis === 'net' ? tr(' على الصافي', ' on the net') : ''}`, app.vat], [tr('المطلوب شامل الضريبة', 'Claimed incl. VAT'), app.total, 1]])}
    <div class="acts">${locked ? '' : `<button class="btn" id="asave">${tr('حفظ وإعادة الحساب', 'Save & recalculate')}</button>`}<button class="btn sec" id="aprint">${tr('طباعة', 'Print')}</button><button class="btn sec" id="apdf">PDF</button>
      ${!locked && app.status === 'draft' ? `<button class="btn sec" id="asub">${tr('تعليم كمُقدَّم', 'Mark as submitted')}</button>` : ''}${CLAIM_EDIT() && !app.pc ? `<button class="btn sec" id="apc">${tr('تسجيل الـ PC المستلم', 'Record the PC received')}</button>` : ''}${app.pc ? `<button class="btn sec" id="aopc">PC ${esc(app.pc.number)}</button>` : ''}
      <button class="btn sec" id="acl">${tr('إغلاق', 'Close')}</button><span class="sp"></span>${!locked ? `<button class="btn bad" id="adel">${tr('حذف', 'Delete')}</button>` : ''}</div>`, true);
  const reopen = async a => { closeModal(); projectDetail(pid); appModal(a, pid); };
  const body = () => ({ date: val(m, 'date'), period_to: val(m, 'period_to'), materials: val(m, 'materials'), notes: val(m, 'notes'), lines: [...m.querySelectorAll('[data-cq]')].map(i => ({ key: i.dataset.cq, cum_qty: i.value })) });
  $('#acl', m).onclick = () => { closeModal(); projectDetail(pid); };
  $('#aprint', m).onclick = () => window.open(`/api/doc/pay_app/${app.id}?print=1`, '_blank');
  $('#apdf', m).onclick = () => window.open(`/api/doc/pay_app/${app.id}/pdf`, '_blank');
  if ($('#asave', m)) $('#asave', m).onclick = guard(async () => reopen(await api('PUT', 'claims/apps/' + app.id, body())));
  if ($('#asub', m)) $('#asub', m).onclick = guard(async () => reopen(await api('PUT', 'claims/apps/' + app.id, { ...body(), status: 'submitted' })));
  if ($('#apc', m)) $('#apc', m).onclick = guard(async () => { if (!locked) await api('PUT', 'claims/apps/' + app.id, body()); closeModal(); pcModal(await api('GET', `claims/pcs/new?project_id=${pid}&app_id=${app.id}`), pid); });
  if ($('#aopc', m)) $('#aopc', m).onclick = guard(async () => { closeModal(); pcModal(await api('GET', 'claims/pcs/' + app.pc.id), pid); });
  if ($('#adel', m)) $('#adel', m).onclick = guard(async () => { if (confirmDel()) { await api('DELETE', 'claims/apps/' + app.id); closeModal(); projectDetail(pid); } });
}

// ---- payment certificate received from the main contractor -----------------------------------------------------------------------
const PCNUM = ['work_cum', 'materials', 'adv_rec_cum', 'retention_cum', 'release_cum', 'contra_cum', 'prev_payments', 'prev_work', 'prev_materials', 'prev_adv_rec', 'prev_retention', 'prev_release', 'prev_contra', 'prev_vat'];
async function pcModal(pc, pid) {
  const info = await api('GET', `claims?project_id=${pid}`), basis = info.project.vat_basis, isNew = !pc.id, inv = !!pc.invoice_id, locked = inv || !CLAIM_EDIT();
  const vpct = S.vat_registered === '0' ? 0 : (+S.vat_pct || 5);
  const appOpts = [['', '—'], ...info.apps.filter(a => !a.pc || a.pc.id === pc.id).map(a => [a.id, `${tr('طلب', 'Application')} ${a.seq} — ${a.number} (${money(a.total)})`])];
  const f = (k, ar, en, type = 'number') => field({ k, ar, en, type }, pc[k] ?? '');
  const m = modal(`<h2>${tr('شهادة دفع مستلمة (PC)', 'Payment certificate received (PC)')} ${pc.number ? esc(pc.number) : ''} ${pc.status ? tag(pc.status) : ''}</h2>
    <p class="muted">${tr('أدخل الأرقام كما هي مطبوعة على الـ PC (تراكمية). النظام يحسب الصافي والضريبة ويقارنها بالـ PC، ثم يصدر الفاتورة الضريبية بنفس المبلغ بالضبط.', 'Enter the figures as printed on the PC (cumulative). The system works out the net and VAT, checks them against the PC, then issues the tax invoice for exactly that amount.')}
      ${tr('أساس الضريبة في هذا المشروع', 'VAT basis on this project')}: <b>${basis === 'net' ? tr('على الصافي بعد المحتجزات والخصومات', 'on the net after retention and contra charges') : tr('على قيمة الأعمال (قبل المحتجزات)', 'on the work value (before retention)')}</b> — ${tr('يُغيَّر من «تعديل» المشروع', 'change it under Edit project')}.</p>
    ${pc.claimed_total != null ? `<p>${tr('المطلوب في طلب الدفعة', 'Claimed in the application')}: <b>${money(pc.claimed_total)}</b> — ${tr('المعتمد', 'certified')}: <b>${money(pc.total)}</b> — ${tr('الفرق', 'difference')}: <b class="${pc.total - pc.claimed_total < -0.004 ? 'neg' : ''}">${money(pc.total - pc.claimed_total)}</b></p>` : ''}
    ${checkList(pc.checks)}
    <div class="f2">${f('number', 'رقم الـ PC', 'PC no.', 'text')}${field({ k: 'app_id', ar: 'طلب الدفعة المرتبط', en: 'For payment application', type: 'select', options: appOpts }, pc.app_id || '')}
      ${f('issue_date', 'تاريخ الإصدار', 'Date of issue', 'date')}${f('period_to', 'للأعمال حتى', 'For works up to', 'date')}</div>
    <h3>${tr('الأرقام التراكمية كما في الـ PC', 'Cumulative figures as on the PC')}</h3>
    <div class="f2">${f('work_cum', 'قيمة الأعمال المنجزة (تراكمي)', 'Value of work done (cumulative)')}${f('materials', 'المواد بالموقع', 'Materials on site')}
      ${f('adv_rec_cum', 'استرداد الدفعة المقدمة (تراكمي)', 'Advance recovery (cumulative)')}${f('retention_cum', 'المحتجزات (تراكمي)', 'Retention (cumulative)')}
      ${f('release_cum', 'الإفراج عن المحتجزات (تراكمي)', 'Release of retention (cumulative)')}${f('contra_cum', 'الخصومات Contra Charges (تراكمي)', 'Contra charges (cumulative)')}
      ${f('prev_payments', 'الدفعات السابقة (بدون ضريبة)', 'Previous payments (excl. VAT)')}${f('vat_certified', 'الضريبة المعتمدة هذا الشهر (اختياري)', 'VAT certified this month (optional)')}</div>
    <details ${pc.first ? 'open' : ''} style="margin:8px 0"><summary style="cursor:pointer"><b>${tr('قيم الشهادة السابقة', 'Previous certificate values')}</b> <span class="muted">${pc.first ? tr('— هذه أول شهادة في النظام: أدخل القيم «السابقة» كما على الـ PC', '— first PC in the system: enter the “previous” values as on the PC') : tr('— تُعبّأ تلقائياً من آخر PC', '— filled from the last PC')}</span></summary>
      <div class="f2">${f('prev_work', 'الأعمال السابقة', 'Previous work done')}${f('prev_materials', 'المواد السابقة', 'Previous materials')}${f('prev_adv_rec', 'الاسترداد السابق', 'Previous advance recovery')}${f('prev_retention', 'المحتجزات السابقة', 'Previous retention')}
        ${f('prev_release', 'الإفراج السابق', 'Previous release')}${f('prev_contra', 'الخصومات السابقة', 'Previous contra charges')}${f('prev_vat', 'الضريبة السابقة (تراكمي)', 'VAT previously certified (cumulative)')}</div></details>
    ${(pc.lines || []).length ? `<details ${isNew ? 'open' : ''}><summary style="cursor:pointer"><b>${tr('الكميات المعتمدة لكل بند', 'Certified quantity per item')}</b> <span class="muted">${tr('— عدّل ما خصمه المقاول الرئيسي', '— change what the main contractor cut')}</span></summary>
      <div class="tw"><table><thead><tr><th>${tr('البند', 'Item')}</th><th>${tr('الوصف', 'Description')}</th><th class="n">${tr('السعر', 'Rate')}</th><th class="n">${tr('الكمية المعتمدة (تراكمي)', 'Certified qty (cumulative)')}</th><th class="n">${tr('القيمة', 'Amount')}</th></tr></thead><tbody>
      ${pc.lines.map(l => `<tr><td>${esc(l.item || '')}</td><td>${esc(l.description)}</td><td class="n">${money(l.rate)}</td><td class="n">${locked ? money(l.cert_qty) : `<input type="number" step="any" style="width:100px" data-ck="${esc(l.key)}" value="${l.cert_qty}">`}</td><td class="n" data-ca="${esc(l.key)}">${money((+l.cert_qty || 0) * l.rate)}</td></tr>`).join('')}</tbody></table></div>
      ${locked ? '' : `<button type="button" class="btn sec sm" id="usel">${tr('استخدم مجموع البنود كقيمة الأعمال', 'Use the item total as the value of work done')} (<span id="ltot"></span>)</button>`}</details>` : ''}
    <div class="f2">${field({ k: 'cost_codes', ar: 'توزيع الأكواد (اختياري)', en: 'Cost-code breakdown (optional)', type: 'textarea' }, pc.cost_codes)}${field({ k: 'notes', ar: 'ملاحظات', en: 'Notes', type: 'textarea' }, pc.notes)}</div>
    <div id="pcsum"></div>
    <div class="acts">${locked ? '' : `<button class="btn" id="psave">${tr('حفظ', 'Save')}</button>`}${!isNew && !inv && CLAIM_INV() ? `<button class="btn" id="pinv">${tr('إصدار الفاتورة الضريبية', 'Issue the tax invoice')}</button>` : ''}${inv ? `<button class="btn sec" id="popen">${tr('الفاتورة', 'Invoice')} ${esc(pc.invoice_number || '')}</button>` : ''}
      <button class="btn sec" id="pcl">${tr('إغلاق', 'Close')}</button><span class="sp"></span>${!isNew && !inv && CLAIM_EDIT() ? `<button class="btn bad" id="pdel">${tr('حذف', 'Delete')}</button>` : ''}</div>`, true);
  if (locked) m.querySelectorAll('.modal input,.modal select,.modal textarea').forEach(x => { if (!x.closest('.card')) x.disabled = true; });
  const n = k => +val(m, k) || 0, r2 = x => Math.round(x * 100) / 100;
  const calc = () => {                                                   // live preview — the same arithmetic as the server
    const A = r2(n('work_cum') + n('materials') - n('adv_rec_cum')), B = r2(n('retention_cum') - n('release_cum') + n('contra_cum') + n('prev_payments')), net = r2(A - B);
    const dret = n('retention_cum') - n('prev_retention'), drel = n('release_cum') - n('prev_release');
    const vc = r2((basis === 'net' ? net : net + dret - drel) * vpct / 100), vtxt = val(m, 'vat_certified'), vat = vtxt === '' ? vc : +vtxt;
    let lt = 0; m.querySelectorAll('[data-ck]').forEach(i => { const l = pc.lines.find(x => x.key === i.dataset.ck), a = r2((+i.value || 0) * l.rate); lt += a; m.querySelector(`[data-ca="${CSS.escape(i.dataset.ck)}"]`).textContent = money(a); });
    if ($('#ltot', m)) $('#ltot', m).textContent = money(r2(lt));
    $('#pcsum', m).innerHTML = sumTable([[tr('قيمة الأعمال حتى تاريخه', 'Value of work done'), n('work_cum')], n('materials') ? [tr('المواد بالموقع', 'Materials on site'), n('materials')] : null, n('adv_rec_cum') ? [tr('ناقص استرداد المقدمة', 'Less advance recovery'), -n('adv_rec_cum')] : null, [tr('المعتمد (A)', 'Certified amount (A)'), A, 1],
      [tr('المحتجزات', 'Retention'), n('retention_cum')], n('release_cum') ? [tr('ناقص الإفراج عن المحتجزات', 'Less retention released'), -n('release_cum')] : null, [tr('الخصومات', 'Contra charges'), n('contra_cum')], [tr('الدفعات السابقة', 'Previous payments'), n('prev_payments')], [tr('مجموع الخصومات (B)', 'Total deductions (B)'), B, 1],
      [tr('الصافي (A − B)', 'Net amount (A − B)'), net, 1], [`${tr('الضريبة', 'VAT')} ${vpct}%${vtxt !== '' && Math.abs(vat - vc) > 0.004 ? ` <span class="neg">(${tr('المحسوبة', 'calculated')} ${money(vc)})</span>` : ''}`, vat], [tr('الصافي المعتمد شامل الضريبة', 'Net certified incl. VAT'), r2(net + vat), 1],
      [tr('ملخص الضريبة: السابق / هذا الشهر / التراكمي', 'VAT summary: previous / this month / cumulative'), `${money(n('prev_vat'))} / ${money(vat)} / ${money(r2(n('prev_vat') + vat))}`]]);
  };
  m.addEventListener('input', calc); calc();
  if ($('#usel', m)) $('#usel', m).onclick = () => { m.querySelector('[name=work_cum]').value = $('#ltot', m).textContent.replace(/,/g, ''); calc(); };
  const body = () => { const b = { project_id: pid, lines: (pc.lines || []).map(l => { const i = m.querySelector(`[data-ck="${CSS.escape(l.key)}"]`); return { ...l, cert_qty: i ? i.value : l.cert_qty }; }) };
    for (const k of ['number', 'app_id', 'issue_date', 'period_to', 'vat_certified', 'cost_codes', 'notes', ...PCNUM]) b[k] = val(m, k); return b; };
  $('#pcl', m).onclick = () => { closeModal(); projectDetail(pid); };
  const save = async () => isNew ? api('POST', 'claims/pcs', body()) : api('PUT', 'claims/pcs/' + pc.id, body());
  if ($('#psave', m)) $('#psave', m).onclick = guard(async () => { const r = await save(); closeModal(); projectDetail(pid); pcModal(r, pid); if (!r.checks.length) toast(tr('تم الحفظ — الحسابات مطابقة', 'Saved — the arithmetic agrees')); });
  if ($('#pinv', m)) $('#pinv', m).onclick = guard(async () => {
    if (!locked) await save();
    const date = prompt(tr('تاريخ الفاتورة الضريبية:', 'Tax invoice date:'), today()); if (!date) return;
    let r;
    try { r = await api('POST', 'claims/pc-invoice/' + pc.id, { date }); }
    catch (e) {
      if (e.message !== 'check_pc') throw e;
      const cur = await api('GET', 'claims/pcs/' + pc.id);
      if (!confirm(tr('توجد فروقات في الـ PC:\n', 'The PC has differences:\n') + cur.checks.map(c => '• ' + tr(...(CHECK_TXT[c.code] || [c.code, c.code]))).join('\n') + tr('\n\nإصدار الفاتورة رغم ذلك؟', '\n\nIssue the invoice anyway?'))) return;
      r = await api('POST', 'claims/pc-invoice/' + pc.id, { date, force: 1 });
    }
    toast(`${tr('صدرت الفاتورة', 'Invoice issued')} ${r.number} — ${money(r.total)}`); closeModal(); projectDetail(pid); openInvoice(r.id);
  });
  if ($('#popen', m)) $('#popen', m).onclick = () => { closeModal(); openInvoice(pc.invoice_id); };
  if ($('#pdel', m)) $('#pdel', m).onclick = guard(async () => { if (confirmDel()) { await api('DELETE', 'claims/pcs/' + pc.id); closeModal(); projectDetail(pid); } });
  if (!isNew && window.docsPanel) docsPanel(m, 'client_pc', pc.id, CLAIM_EDIT());
}

// ---- project page card ---------------------------------------------------------------------------------------------------------
const baseProjectDetailClaims = projectDetail;
projectDetail = async id => {
  await baseProjectDetailClaims(id);
  if (!seesMoney() || !$('#main .grid')) return;
  const d = await api('GET', `claims?project_id=${id}`).catch(() => null); if (!d) return;
  const pr = d.project, rows = [...d.apps.map(a => ({ a, p: d.pcs.find(x => x.app_id === a.id) })), ...d.pcs.filter(x => !x.app_id).map(p => ({ a: null, p }))]
    .sort((x, y) => ((x.p && x.p.issue_date) || (x.a && x.a.date) || '').localeCompare((y.p && y.p.issue_date) || (y.a && y.a.date) || ''));
  const card = document.createElement('div'); card.className = 'card'; card.id = 'claims'; card.style.marginTop = '16px';
  card.innerHTML = `<div class="bar"><h2 style="margin:0">${tr('طلبات الدفعة وشهادات الدفع (PC)', 'Payment applications & certificates (PC)')}</h2><span class="sp"></span>
      ${CLAIM_EDIT() ? `<button class="btn sm" id="cnew">+ ${tr('طلب دفعة (بروفورما)', 'Payment application (proforma)')}</button><button class="btn sec sm" id="cpc">+ ${tr('تسجيل PC مستلم', 'Record a PC received')}</button>` : ''}</div>
    <p class="muted" style="margin:4px 0 8px">${tr('للعمل مع مقاول رئيسي: طلب دفعة ← PC من المقاول ← فاتورة ضريبية مطابقة للـ PC.', 'For work under a main contractor: payment application → PC from the main contractor → tax invoice equal to the PC.')}
      ${pr.client_contract_ref ? `${tr('العقد', 'Contract')}: <b>${esc(pr.client_contract_ref)}</b> · ` : ''}${tr('أساس الضريبة', 'VAT basis')}: <b>${pr.vat_basis === 'net' ? tr('بعد المحتجزات', 'after retention') : tr('على قيمة الأعمال', 'on the work value')}</b>${pr.payment_terms_days ? ` · ${tr('مدة الدفع', 'payment terms')} ${pr.payment_terms_days} ${tr('يوم', 'days')}` : ''}</p>
    <div class="tw"><table><thead><tr><th>${tr('طلب الدفعة', 'Application')}</th><th>${tr('للأعمال حتى', 'Works up to')}</th><th class="n">${tr('المطلوب (شامل الضريبة)', 'Claimed (incl. VAT)')}</th><th>${tr('الحالة', 'Status')}</th><th>PC</th><th class="n">${tr('المعتمد (شامل الضريبة)', 'Certified (incl. VAT)')}</th><th class="n">${tr('الفرق', 'Difference')}</th><th>${tr('الفاتورة', 'Invoice')}</th></tr></thead><tbody>
    ${rows.map(({ a, p }) => `<tr>
      <td>${a ? `<a href="#" data-app="${a.id}">${tr('طلب', 'No.')} ${a.seq} <span class="muted mono">${esc(a.number)}</span></a>` : '—'}</td><td>${esc((a && a.period_to) || (p && p.period_to) || '')}</td>
      <td class="n">${a ? money(a.total) : ''}</td><td>${tag((p && p.status) || (a && a.status))}</td><td>${p ? `<a href="#" data-pc="${p.id}">PC ${esc(p.number)}</a>${p.checks.length ? ' <span title="check" class="neg">⚠</span>' : ''}` : ''}</td>
      <td class="n">${p ? money(p.total) : ''}</td><td class="n ${a && p && p.total - a.total < -0.004 ? 'neg' : ''}">${a && p ? money(p.total - a.total) : ''}</td>
      <td>${p && p.invoice_id ? `<a href="#" data-inv="${p.invoice_id}">${esc(p.invoice_number || '')}</a>` : ''}</td></tr>`).join('') || `<tr><td colspan="8" class="muted">${tr('لا توجد طلبات بعد', 'Nothing yet')}</td></tr>`}</tbody></table></div>`;
  const before = [...$('#main').children].find(e => e.tagName === 'H2' && /الفواتير|Invoices/.test(e.textContent));
  before ? $('#main').insertBefore(card, before) : $('#main').appendChild(card);
  if ($('#cnew')) $('#cnew').onclick = guard(async () => appModal(await api('POST', 'claims/apps', { project_id: id }), id));
  if ($('#cpc')) $('#cpc').onclick = guard(async () => pcModal(await api('GET', `claims/pcs/new?project_id=${id}`), id));
  card.querySelectorAll('[data-app]').forEach(x => x.onclick = guard(async e => { e.preventDefault(); appModal(await api('GET', 'claims/apps/' + x.dataset.app), id); }));
  card.querySelectorAll('[data-pc]').forEach(x => x.onclick = guard(async e => { e.preventDefault(); pcModal(await api('GET', 'claims/pcs/' + x.dataset.pc), id); }));
  card.querySelectorAll('[data-inv]').forEach(x => x.onclick = e => { e.preventDefault(); openInvoice(+x.dataset.inv); });
};
