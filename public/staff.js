// Employee accounts: my statement and expense claims (any user linked to an employee), expense claims for approvers and the
// accounts, employee statements of account. Server: modules/staffaccounts.js.
const CL_ST = { pending: ['بانتظار الموافقة', 'Pending'], approved: ['موافق عليها', 'Approved'], rejected: ['مرفوضة', 'Rejected'] };
const clPill = s => `<span class="pill ${s === 'approved' ? 'ok' : s === 'rejected' ? 'bad' : 'warn'}">${tr(...(CL_ST[s] || [s, s]))}</span>`;
const sSigned = v => v < 0 ? `<span class="neg">(${money(-v)})</span>` : money(v);
const CL_CATS = () => Object.entries(CATS).filter(([c]) => !['asset', 'sub_advance'].includes(c)).map(([c, v]) => [c, tr(...v)]);
const receiptsCell = c => (c.receipts || []).map(d => `<a href="/api/documents/${d.id}/download">📎 ${esc(d.name)}</a>`).join(' ') || `<span class="muted">${tr('بدون إيصال', 'no receipt')}</span>`;

// the statement tables (shared by "my account" and the accounts' view)
function staffStatementHtml(s) {
  const k = (l, v, c = '') => `<div class="kpi"><div class="l">${l}</div><div class="v ${c}">${v}</div></div>`;
  const secs = Object.entries(s.sections);
  return `<div class="grid">${secs.map(([, x]) => k(tr(x.name_ar, x.name), sSigned(x.closing))).join('')}${k(tr('الصافي لصالح الموظف', 'Net in the employee\'s favour'), sSigned(s.total), s.total < 0 ? 'bad' : 'ok')}</div>
  <p class="muted">${tr('المبالغ الموجبة مستحقة للموظف على الشركة؛ المبالغ بين قوسين مستحقة على الموظف (مثل سلفة لم تُسدَّد).', 'Positive amounts are owed by the company to the employee; amounts in brackets are owed by the employee (for example an advance not yet repaid).')}
  ${s.eos_provision ? ` ${tr('مكافأة نهاية الخدمة المتراكمة (غير مستحقة بعد):', 'End-of-service gratuity accrued (not yet due):')} <b>${money(s.eos_provision)}</b>` : ''}
  ${s.pending_claims && s.pending_claims.n ? ` · ${tr('مطالبات بانتظار الموافقة:', 'Claims awaiting approval:')} ${s.pending_claims.n} (${money(s.pending_claims.t)})` : ''}</p>
  ${secs.map(([, x]) => `<h2>${tr(x.name_ar, x.name)} <span class="muted">(${x.account})</span></h2><div class="tw"><table><thead><tr><th>${tr('التاريخ', 'Date')}</th><th>${tr('المرجع', 'Ref')}</th><th>${tr('البيان', 'Description')}</th><th class="n">${tr('المبلغ', 'Amount')}</th><th class="n">${tr('الرصيد', 'Balance')}</th></tr></thead><tbody>
    ${s.from ? `<tr><td>${esc(s.from)}</td><td></td><td>${tr('رصيد افتتاحي', 'Opening balance')}</td><td></td><td class="n">${sSigned(x.opening)}</td></tr>` : ''}
    ${x.lines.map(l => `<tr><td>${esc(l.date)}</td><td>${esc(l.ref)}</td><td>${esc(tr(l.description_ar || l.description, l.description))}</td><td class="n">${sSigned(l.amount)}</td><td class="n">${sSigned(l.balance)}</td></tr>`).join('') || `<tr><td colspan="5" class="muted">—</td></tr>`}</tbody>
    <tfoot><tr><td colspan="4"><b>${tr('الرصيد', 'Balance')}</b></td><td class="n"><b>${sSigned(x.closing)}</b></td></tr></tfoot></table></div>`).join('')}`;
}

// a claim form (my own, or entered by the accounts for an employee)
async function claimForm({ forEmployee, after, custody }) {
  const [projects, emps, mine] = await Promise.all([api('GET', 'projects').catch(() => []), forEmployee ? api('GET', 'employees').catch(() => []) : Promise.resolve([]), forEmployee ? Promise.resolve(null) : api('GET', 'me/petty').catch(() => null)]);
  const avail = mine ? mine.available : null;
  const m = modal(`<h2>${tr('مطالبة مصروف دفعته من مالك', 'Claim an expense you paid from your own money')}</h2>
    <p class="muted">${tr('أرفق صورة الإيصال أو الفاتورة. بعد الموافقة يُسجَّل المصروف على المشروع ويصبح المبلغ مستحقاً لك حتى يُصرف.', 'Attach a photo of the receipt or invoice. Once approved, the expense is booked on the project and the amount is owed to you until it is paid.')}</p>
    <div class="f2">${forEmployee ? field({ k: 'employee_id', ar: 'الموظف', en: 'Employee', type: 'select', options: emps.filter(e => e.status === 'active').map(e => [e.id, e.name]) }, '') : ''}
    ${field({ k: 'date', ar: 'تاريخ الدفع', en: 'Date paid', type: 'date' }, today())}${field({ k: 'description', ar: 'ماذا دفعت؟', en: 'What was paid for?', req: 1 }, '')}
    ${field({ k: 'amount', ar: 'المبلغ (بدون ضريبة)', en: 'Amount (ex VAT)', type: 'number', req: 1 }, '')}${field({ k: 'vat_amount', ar: 'ضريبة القيمة المضافة (إن وجدت في الفاتورة)', en: 'VAT (if on the invoice)', type: 'number' }, 0)}
    ${field({ k: 'category', ar: 'البند', en: 'Category', type: 'select', options: CL_CATS() }, 'other')}
    ${field({ k: 'project_id', ar: 'المشروع', en: 'Project', type: 'select', options: refOpts(projects, p => `${p.code || ''} ${p.name}`) }, '')}
    ${field({ k: 'reference', ar: 'رقم الإيصال / الفاتورة', en: 'Receipt / invoice no.' }, '')}
    ${field({ k: 'paid_from', ar: 'دُفع من', en: 'Paid from', type: 'select', options: [['own', tr('مالي الخاص (أستردّه)', 'My own money (to be paid back)')], ['custody', tr('العهدة النقدية التي بحوزتي', 'The petty cash I hold') + (avail != null ? ` — ${money(avail)}` : '')]] }, custody ? 'custody' : 'own')}
    <div class="f"><label>${tr('صورة الإيصال (صورة أو PDF)', 'Receipt (photo or PDF)')}</label><input type="file" name="receipt" accept="image/*,application/pdf" capture="environment"></div></div>
    <div class="acts"><button class="btn" id="save">${tr('إرسال للموافقة', 'Send for approval')}</button><button class="btn sec" id="cancel">${tr('إلغاء', 'Cancel')}</button></div>`, true);
  $('#cancel', m).onclick = closeModal;
  $('#save', m).onclick = guard(async () => {
    const b = {}; for (const k of ['employee_id', 'date', 'description', 'amount', 'vat_amount', 'category', 'project_id', 'reference', 'paid_from']) b[k] = val(m, k);
    const f = m.querySelector('[name=receipt]').files[0];
    if (f && f.size > 8 * 1024 * 1024) throw new Error(tr('الملف أكبر من ٨ ميغابايت', 'The file is larger than 8 MB'));
    const r = await api('POST', forEmployee ? 'expense_claims' : 'me/claims', b);
    if (f) { const data = await new Promise((ok, no) => { const rd = new FileReader(); rd.onload = () => ok(rd.result); rd.onerror = no; rd.readAsDataURL(f); }); await api('POST', `${forEmployee ? 'expense_claims' : 'me/claims'}/${r.id}/receipt`, { name: f.name, data }); }
    closeModal(); toast(tr('أُرسلت المطالبة للموافقة', 'Claim sent for approval')); after();
  });
}

// ---------------- my account & claims ----------------
PAGES.myaccount = async () => {
  if (!ME.employee_id) return main(`<h1>${tr('حسابي ومطالباتي', 'My account & claims')}</h1><div class="card"><p>${tr('حسابك غير مربوط بملف موظف. يربطه المسؤول من الإعدادات ← المستخدمين.', 'Your account is not linked to an employee record. The administrator links it in Settings → Users.')}</p></div>`);
  const [s, claims, pc] = await Promise.all([api('GET', 'me/statement'), api('GET', 'me/claims'), api('GET', 'me/petty').catch(() => null)]);
  const RQ = { pending: CL_ST.pending, approved: ['موافق عليه — بانتظار التسليم', 'Approved — to be handed over'], rejected: CL_ST.rejected, paid: ['سُلِّم', 'Handed over'] };
  main(`<div class="bar"><h1>${tr('حسابي ومطالباتي', 'My account & claims')} — ${esc(s.employee.name)}</h1><span class="sp"></span><button class="btn" id="nc">+ ${tr('مطالبة مصروف', 'Expense claim')}</button><button class="btn sec" id="pr">+ ${tr('طلب عهدة نقدية', 'Request petty cash')}</button></div>
  ${pc ? `<div class="grid"><div class="kpi"><div class="l">${tr('العهدة النقدية بحوزتي', 'Petty cash I hold')}</div><div class="v">${money(pc.held)}</div></div><div class="kpi"><div class="l">${tr('المتاح للصرف (بعد المصاريف بانتظار الموافقة)', 'Available (after expenses waiting for approval)')}</div><div class="v">${money(pc.available)}</div></div></div>
    ${pc.held > 0.005 ? `<p class="muted">${tr('سجّل كل ما تصرفه من العهدة بـ «مطالبة مصروف» ← دُفع من: العهدة، مع صورة الإيصال. يُرجَع الباقي للمحاسب.', 'Record everything you spend from the petty cash as an "Expense claim" → Paid from: the petty cash, with the receipt photo. Return what is left to the accountant.')}</p>` : ''}
    ${pc.requests.length ? `<div class="tw"><table><tbody>${pc.requests.map(r => `<tr><td>${esc(String(r.created || '').slice(0, 10))}</td><td>${esc(r.purpose || '')}${r.decision_note ? `<br><span class="muted">${esc(r.decision_note)}</span>` : ''}</td><td class="n">${money(r.amount)}</td><td><span class="pill">${tr(...(RQ[r.status] || [r.status, r.status]))}</span></td><td>${r.status === 'pending' ? `<button class="btn sec sm" data-wr="${r.id}">${tr('سحب', 'Withdraw')}</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : ''}` : ''}
  <h2>${tr('مطالباتي', 'My expense claims')}</h2><div class="tw"><table><thead><tr><th>${tr('التاريخ', 'Date')}</th><th>${tr('البيان', 'Description')}</th><th class="n">${tr('المبلغ', 'Amount')}</th><th>${tr('الحالة', 'Status')}</th><th>${tr('الإيصال', 'Receipt')}</th><th></th></tr></thead><tbody>
  ${claims.map(c => `<tr><td>${esc(c.date)}</td><td>${esc(c.description)}${c.project_name ? ` <span class="muted">· ${esc(c.project_name)}</span>` : ''}${c.paid_from === 'custody' ? ` <span class="pill">${tr('من العهدة', 'from petty cash')}</span>` : ''}${c.decision_note ? `<br><span class="muted">${esc(c.decision_note)}</span>` : ''}</td><td class="n">${money(c.total)}</td><td>${clPill(c.status)}</td>
    <td>${(c.receipts || []).length ? `📎 ${c.receipts.length}` : c.status === 'pending' ? `<label class="btn sec sm">${tr('إرفاق', 'Attach')}<input type="file" data-rc="${c.id}" accept="image/*,application/pdf" capture="environment" hidden></label>` : '—'}</td>
    <td>${c.status === 'pending' ? `<button class="btn sec sm" data-wd="${c.id}">${tr('سحب', 'Withdraw')}</button>` : ''}</td></tr>`).join('') || `<tr><td colspan="6" class="muted">${tr('لا توجد مطالبات', 'No claims')}</td></tr>`}</tbody></table></div>
  <h2 style="margin-top:16px">${tr('كشف حسابي', 'My statement')}</h2>${staffStatementHtml(s)}`);
  $('#nc').onclick = () => claimForm({ forEmployee: false, after: render });
  $('#pr').onclick = () => simpleModal({ title: tr('طلب عهدة نقدية', 'Request petty cash'), table: 'me/petty/requests', after: render, fields: [{ k: 'amount', ar: 'المبلغ', en: 'Amount', type: 'number', req: 1 }, { k: 'purpose', ar: 'لأي غرض؟', en: 'What is it for?', req: 1, full: 1 }] });
  document.querySelectorAll('[data-wr]').forEach(b => b.onclick = guard(async () => { if (confirm(tr('سحب هذا الطلب؟', 'Withdraw this request?'))) { await api('DELETE', 'me/petty/requests/' + b.dataset.wr); render(); } }));
  document.querySelectorAll('[data-wd]').forEach(b => b.onclick = guard(async () => { if (confirm(tr('سحب هذه المطالبة؟', 'Withdraw this claim?'))) { await api('DELETE', 'me/claims/' + b.dataset.wd); render(); } }));
  document.querySelectorAll('[data-rc]').forEach(inp => inp.onchange = guard(async () => {
    const f = inp.files[0]; if (!f) return; const data = await new Promise((ok, no) => { const rd = new FileReader(); rd.onload = () => ok(rd.result); rd.onerror = no; rd.readAsDataURL(f); });
    await api('POST', `me/claims/${inp.dataset.rc}/receipt`, { name: f.name, data }); toast(tr('أُرفق الإيصال', 'Receipt attached')); render();
  }));
};

// ---------------- expense claims (approvers, accounts) ----------------
PAGES.claims = async () => {
  const st = sessionStorage.clSt ?? 'pending', fin = ['admin', 'accountant'].includes(ME.role);
  const [d, preqs] = await Promise.all([api('GET', `expense_claims${st ? '?status=' + st : ''}`), api('GET', 'petty_requests?status=pending').catch(() => [])]);
  main(`<div class="bar"><h1>${tr('مطالبات مصاريف الموظفين', 'Employee expense claims')}</h1><span class="sp"></span>
    <select id="st" style="width:auto">${[['pending', ...CL_ST.pending], ['approved', ...CL_ST.approved], ['rejected', ...CL_ST.rejected], ['', 'الكل', 'All']].map(([k, a, e]) => `<option value="${k}" ${k === st ? 'selected' : ''}>${tr(a, e)}</option>`).join('')}</select>
    <button class="btn" id="nc">+ ${tr('مطالبة لموظف', 'Claim for an employee')}</button>${fin ? `<button class="btn" id="rb">${tr('صرف للموظف', 'Reimburse an employee')}</button>` : ''}${ME.role === 'admin' ? `<button class="btn sec" id="lim">${tr('حد موافقة المحاسب', 'Accountant\'s limit')}</button>` : ''}</div>
  <p class="muted">${tr('المدير والمسؤول يوافقان على أي مبلغ؛ المحاسب حتى', 'The manager and the administrator approve any amount; the accountant up to')} <b>${d.accountant_limit ? money(d.accountant_limit) : tr('(لم يُحدَّد)', '(not set)')}</b>. ${tr('لا أحد يوافق على مطالبته.', 'Nobody approves their own claim.')}</p>
  <div class="tw"><table><thead><tr><th>${tr('التاريخ', 'Date')}</th><th>${tr('الموظف', 'Employee')}</th><th>${tr('البيان', 'Description')}</th><th class="n">${tr('المبلغ', 'Amount')}</th><th>${tr('الإيصال', 'Receipt')}</th><th>${tr('الحالة', 'Status')}</th><th></th></tr></thead><tbody>
  ${d.rows.map(c => `<tr><td>${esc(c.date)}</td><td>${esc(c.employee_name)}</td><td>${esc(c.description)}${c.project_name ? ` <span class="muted">· ${esc(c.project_name)}</span>` : ''}${c.reference ? ` <span class="muted">· ${esc(c.reference)}</span>` : ''}${c.paid_from === 'custody' ? ` <span class="pill">${tr('من العهدة', 'from petty cash')}</span>` : ''}${c.decision_note ? `<br><span class="muted">${esc(c.decided_by || '')}: ${esc(c.decision_note)}</span>` : ''}</td>
    <td class="n">${money(c.total)}${c.vat_amount ? `<br><span class="muted">${tr('ضريبة', 'VAT')} ${money(c.vat_amount)}</span>` : ''}</td><td>${receiptsCell(c)}</td><td>${clPill(c.status)}</td>
    <td>${c.can_decide ? `<button class="btn sm" data-ok="${c.id}">${tr('موافقة', 'Approve')}</button> <button class="btn sec sm" data-no="${c.id}">${tr('رفض', 'Reject')}</button>` : c.block ? `<span class="muted" title="${esc(c.block)}">🔒</span>` : ''}
      ${c.status === 'approved' && ME.role === 'admin' ? `<button class="btn sec sm" data-undo="${c.id}">${tr('إلغاء الموافقة', 'Take back')}</button>` : ''}${c.status !== 'approved' && fin ? `<button class="btn sec sm" data-del="${c.id}">×</button>` : ''}</td></tr>`).join('') || `<tr><td colspan="7" class="muted">—</td></tr>`}</tbody></table></div>`);
  $('#main').insertAdjacentHTML('beforeend', `<h2 style="margin-top:16px">${tr('طلبات العهدة النقدية بانتظار الموافقة', 'Petty cash requests waiting for approval')}</h2><div class="tw"><table><tbody>
    ${preqs.map(r => `<tr><td>${esc(String(r.created || '').slice(0, 10))}</td><td>${esc(r.employee_name)}</td><td>${esc(r.purpose || '')}<br><span class="muted">${tr('بحوزته حالياً', 'Holds now')}: ${money(r.held)}</span></td><td class="n">${money(r.amount)}</td>
      <td>${r.can_decide ? `<button class="btn sm" data-pok="${r.id}">${tr('موافقة', 'Approve')}</button> <button class="btn sec sm" data-pno="${r.id}">${tr('رفض', 'Reject')}</button>` : `<span class="muted" title="${esc(r.block || '')}">🔒</span>`}</td></tr>`).join('') || `<tr><td class="muted">—</td></tr>`}</tbody></table></div>`);
  document.querySelectorAll('[data-pok]').forEach(b => b.onclick = guard(async () => { await api('POST', `petty_requests/${b.dataset.pok}/decide`, { status: 'approved' }); toast(tr('تمت الموافقة — يسلّمها المحاسب من صفحة العهدة', 'Approved — the accountant hands it over from Petty cash')); render(); }));
  document.querySelectorAll('[data-pno]').forEach(b => b.onclick = guard(async () => { const note = prompt(tr('سبب الرفض:', 'Reason for the rejection:')); if (!note) return; await api('POST', `petty_requests/${b.dataset.pno}/decide`, { status: 'rejected', note }); render(); }));
  $('#st').onchange = e => { sessionStorage.clSt = e.target.value; render(); };
  $('#nc').onclick = () => claimForm({ forEmployee: true, after: render });
  document.querySelectorAll('[data-ok]').forEach(b => b.onclick = guard(async () => { await api('POST', `expense_claims/${b.dataset.ok}/decide`, { status: 'approved', note: '' }); toast(tr('تمت الموافقة', 'Approved')); render(); }));
  document.querySelectorAll('[data-no]').forEach(b => b.onclick = guard(async () => { const note = prompt(tr('سبب الرفض:', 'Reason for the rejection:')); if (!note) return; await api('POST', `expense_claims/${b.dataset.no}/decide`, { status: 'rejected', note }); render(); }));
  document.querySelectorAll('[data-undo]').forEach(b => b.onclick = guard(async () => { if (confirm(tr('إلغاء الموافقة؟ يُحذف المصروف من المشروع وتعود المطالبة بانتظار الموافقة.', 'Take the approval back? The expense is removed from the project and the claim is pending again.'))) { await api('POST', `expense_claims/${b.dataset.undo}/undo`); render(); } }));
  document.querySelectorAll('[data-del]').forEach(b => b.onclick = guard(async () => { if (confirmDel()) { await api('DELETE', 'expense_claims/' + b.dataset.del); render(); } }));
  if ($('#lim')) $('#lim').onclick = guard(async () => { const v = prompt(tr('حد موافقة المحاسب (درهم، 0 = لا يوافق):', 'Accountant\'s approval limit (AED, 0 = cannot approve):'), d.accountant_limit || ''); if (v === null) return; await api('PUT', 'settings', { staff_approval_accountant_limit: String(+v || 0) }); render(); });
  if ($('#rb')) $('#rb').onclick = guard(async () => {
    const [list, banks] = await Promise.all([api('GET', 'staff_statements').catch(() => ({ rows: [] })), api('GET', 'bank_accounts')]);
    const owed = list.rows.filter(r => r.balances.claims > 0.005);
    const m = modal(`<h2>${tr('صرف مطالبات معتمدة لموظف', 'Pay a employee\'s approved claims')}</h2><div class="f2">
      ${field({ k: 'employee_id', ar: 'الموظف', en: 'Employee', type: 'select', options: owed.map(r => [r.id, `${r.name} — ${money(r.balances.claims)}`]) }, '')}${field({ k: 'date', ar: 'التاريخ', en: 'Date', type: 'date' }, today())}
      ${field({ k: 'amount', ar: 'المبلغ', en: 'Amount', type: 'number', req: 1 }, owed[0] ? owed[0].balances.claims : '')}
      ${field({ k: 'method', ar: 'طريقة الدفع', en: 'Paid by', type: 'select', options: [['bank', tr('بنك', 'Bank')], ['cash', tr('نقداً', 'Cash')]] }, 'bank')}
      ${field({ k: 'bank_account_id', ar: 'الحساب البنكي', en: 'Bank account', type: 'select', options: banks.filter(b => b.active).map(b => [b.id, b.name]) }, '')}${field({ k: 'reference', ar: 'المرجع', en: 'Reference' }, '')}</div>
      <div class="acts"><button class="btn" id="save">${tr('حفظ', 'Save')}</button><button class="btn sec" id="cancel">${tr('إلغاء', 'Cancel')}</button></div>`);
    m.querySelector('[name=employee_id]').onchange = e => { const r = owed.find(x => x.id === +e.target.value); if (r) m.querySelector('[name=amount]').value = r.balances.claims; };
    $('#cancel', m).onclick = closeModal;
    $('#save', m).onclick = guard(async () => { const b = {}; for (const k of ['employee_id', 'date', 'amount', 'method', 'bank_account_id', 'reference']) b[k] = val(m, k); await api('POST', 'expense_claims/reimburse', b); closeModal(); toast(tr('تم', 'Done')); render(); });
  });
};

// ---------------- employee statements (accounts, HR) ----------------
PAGES.staffaccounts = async id => {
  if (id) {
    const to = sessionStorage.esTo || today(), from = sessionStorage.esFrom || '', qs = `to=${to}${from ? '&from=' + from : ''}`;
    const s = await api('GET', `staff_statements/${id}?${qs}`);
    main(`<div class="bar"><button class="btn sec" onclick="go('staffaccounts')">←</button><h1 style="margin:0">${tr('كشف حساب موظف', 'Employee statement')} — ${esc(s.employee.name)}</h1><span class="sp"></span>
      <a class="btn sec" target="_blank" href="/api/doc/employee_statement/${id}?${qs}&print=1">${tr('طباعة', 'Print')}</a><a class="btn sec" target="_blank" href="/api/doc/employee_statement/${id}/pdf?${qs}">PDF</a></div>
    <div class="bar"><label class="muted">${tr('من', 'From')}</label><input type="date" id="sf" value="${esc(from)}" style="width:auto"><label class="muted">${tr('إلى', 'To')}</label><input type="date" id="st" value="${esc(to)}" style="width:auto">
      ${s.partner ? `<span class="muted">${tr('هذا الموظف شريك أيضاً — حسابه كشريك منفصل', 'This employee is also a partner — the partner account is separate')}</span>` : ''}</div>${staffStatementHtml(s)}`);
    $('#sf').onchange = e => { sessionStorage.esFrom = e.target.value; render(); };
    $('#st').onchange = e => { sessionStorage.esTo = e.target.value || today(); render(); };
    return;
  }
  const d = await api('GET', 'staff_statements'), keys = Object.keys(d.sections);
  main(`<div class="bar"><h1>${tr('كشوف حساب الموظفين', 'Employee statements')}</h1></div>
  <p class="muted">${tr('لكل موظف: ما له على الشركة (رواتب مستحقة، مطالبات معتمدة لم تُصرف) وما عليه (سلف لم تُسدَّد). اضغط على الموظف لكشفه.', 'For each employee: what the company owes (salaries due, approved claims not yet paid) and what the employee owes (advances not yet repaid). Click an employee for the statement.')}</p>
  <div class="tw"><table><thead><tr><th>${tr('الموظف', 'Employee')}</th>${keys.map(k => `<th class="n">${tr(d.sections[k].name_ar, d.sections[k].name)}</th>`).join('')}<th class="n">${tr('الصافي', 'Net')}</th></tr></thead><tbody>
  ${d.rows.map(r => `<tr class="click" data-e="${r.id}"><td>${esc(r.name)}${r.status !== 'active' ? ` <span class="muted">(${esc(r.status)})</span>` : ''}</td>${keys.map(k => `<td class="n">${r.balances[k] ? sSigned(r.balances[k]) : '<span class="muted">—</span>'}</td>`).join('')}<td class="n"><b>${sSigned(r.balances.total)}</b></td></tr>`).join('') || `<tr><td colspan="${keys.length + 2}" class="muted">—</td></tr>`}</tbody>
  <tfoot><tr><td><b>${tr('الإجمالي', 'Total')}</b></td>${keys.map(k => `<td class="n"><b>${sSigned(d.totals[k])}</b></td>`).join('')}<td class="n"><b>${sSigned(d.totals.total)}</b></td></tr></tfoot></table></div>`);
  document.querySelectorAll('tr[data-e]').forEach(r => r.onclick = () => go('staffaccounts/' + r.dataset.e));
};

// ---------------- petty cash per employee (added under the existing Petty cash page) ----------------
{
  const officePetty = PAGES.petty;
  PAGES.petty = async () => {
    await officePetty();
    const [d, banks] = await Promise.all([api('GET', 'petty_custody'), api('GET', 'bank_accounts').catch(() => [])]);
    const fin = ['admin', 'accountant'].includes(ME.role);
    $('#main').insertAdjacentHTML('beforeend', `<h2 style="margin-top:20px">${tr('العهدة النقدية بحوزة الموظفين', 'Petty cash held by employees')}</h2>
    <div class="bar">${fin ? `<button class="btn" id="ho">${tr('تسليم عهدة', 'Hand over petty cash')}</button><button class="btn sec" id="rt">${tr('استلام المتبقي', 'Receive what is left')}</button>` : ''}
      <span class="muted">${tr('بحوزة الموظفين', 'Held by employees')}: <b>${money(d.held_by_employees)}</b></span></div>
    ${d.approved_requests.length ? `<div class="card" style="border-color:var(--warn)"><b>${tr('طلبات معتمدة بانتظار التسليم', 'Approved requests to hand over')}</b>${d.approved_requests.map(r => `<div>${esc(r.employee_name)} — ${money(r.amount)} — ${esc(r.purpose || '')} ${fin ? `<button class="btn sm" data-hr="${r.id}">${tr('تسليم', 'Hand over')}</button>` : ''}</div>`).join('')}</div>` : ''}
    <div class="tw"><table><thead><tr><th>${tr('الموظف', 'Employee')}</th><th class="n">${tr('بحوزته', 'Holds')}</th><th class="n">${tr('مصاريف بانتظار الموافقة', 'Expenses waiting')}</th><th></th></tr></thead><tbody>
    ${d.custodians.map(c => `<tr><td>${esc(c.name)}${c.status && c.status !== 'active' ? ` <span class="neg">(${esc(c.status)})</span>` : ''}</td><td class="n">${money(c.held)}</td><td class="n">${c.pending ? money(c.pending) : '—'}</td><td><a class="btn sec sm" onclick="go('staffaccounts/${c.id}')">${tr('كشفه', 'Statement')}</a></td></tr>`).join('') || `<tr><td colspan="4" class="muted">—</td></tr>`}</tbody></table></div>
    <h2>${tr('التسليمات والاستلامات', 'Hand-overs and returns')}</h2><div class="tw"><table><tbody>
    ${d.handovers.map(t => `<tr><td>${esc(t.date)}</td><td>${esc(t.employee_name)}</td><td>${t.kind === 'return' ? tr('إرجاع للشركة', 'Returned') : tr('تسليم', 'Handed over')} · ${t.method === 'cash' ? tr('نقداً', 'cash') : tr('بنك', 'bank')}${t.note ? ` · ${esc(t.note)}` : ''}</td><td class="n">${money(t.amount)}</td>
      <td>${t.kind !== 'return' ? `<a class="btn sec sm" target="_blank" href="/api/doc/custody_receipt/${t.id}?print=1">${tr('إقرار استلام', 'Acknowledgement')}</a>` : ''} ${fin ? `<button class="btn sec sm" data-dh="${t.id}">×</button>` : ''}</td></tr>`).join('') || `<tr><td class="muted">—</td></tr>`}</tbody></table></div>`);
    const form = async (kind, preset) => {
      const people = kind === 'return' ? d.custodians.filter(c => c.held > 0.005) : null, emps = kind !== 'return' && !preset ? (await api('GET', 'employees')).filter(e => e.status === 'active') : null;
      const fields = [kind === 'return' ? { k: 'employee_id', ar: 'الموظف', en: 'Employee', type: 'select', options: people.map(c => [c.id, `${c.name} — ${money(c.held)}`]) }
        : preset ? { k: 'employee_id', type: 'hidden' } : { k: 'employee_id', ar: 'الموظف', en: 'Employee', type: 'select', options: emps.map(e => [e.id, e.name]) },
        ...(!preset && kind !== 'return' ? [{ k: 'note', ar: 'الغرض', en: 'Purpose' }] : []),
        { k: 'date', ar: 'التاريخ', en: 'Date', type: 'date', def: today() }, { k: 'amount', ar: 'المبلغ', en: 'Amount', type: 'number', req: 1, def: preset ? preset.amount : (people && people[0] ? people[0].held : '') },
        { k: 'method', ar: kind === 'return' ? 'استُلم' : 'سُلِّم', en: kind === 'return' ? 'Received' : 'Paid', type: 'select', options: [['cash', tr('نقداً', 'Cash')], ['bank', tr('بنك', 'Bank')]], def: 'cash' },
        { k: 'bank_account_id', ar: 'الحساب البنكي (للبنك)', en: 'Bank account (if bank)', type: 'select', options: banks.filter(b => b.active).map(b => [b.id, b.name]) }, { k: 'reference', ar: 'المرجع', en: 'Reference' },
        { k: 'request_id', type: 'hidden' }];
      const m = modal(`<h2>${kind === 'return' ? tr('استلام المتبقي من العهدة', 'Receive what is left of the petty cash') : `${tr('تسليم عهدة', 'Hand over petty cash')}${preset ? ' — ' + esc(preset.employee_name) : ' ' + tr('(مباشرة، بدون طلب: المسؤول فقط)', '(directly, without a request: administrator only)')}`}</h2><div class="f2">${fields.map(f => field(f, f.k === 'employee_id' && preset ? preset.employee_id : f.k === 'request_id' && preset ? preset.id : f.def)).join('')}</div>
        <div class="acts"><button class="btn" id="save">${tr('حفظ', 'Save')}</button><button class="btn sec" id="cancel">${tr('إلغاء', 'Cancel')}</button></div>`);
      $('#cancel', m).onclick = closeModal;
      $('#save', m).onclick = guard(async () => { const b = {}; fields.forEach(f => b[f.k] = val(m, f.k)); const r = await api('POST', `petty_custody/${kind === 'return' ? 'return' : 'handover'}`, b); closeModal(); render();
        if (kind !== 'return' && confirm(tr('طباعة إقرار الاستلام ليوقّعه الموظف؟', 'Print the acknowledgement for the employee to sign?'))) window.open(`/api/doc/custody_receipt/${r.id}?print=1`, '_blank'); });
    };
    document.querySelectorAll('[data-hr]').forEach(b => b.onclick = guard(() => form('handover', d.approved_requests.find(r => r.id === +b.dataset.hr))));
    if ($('#ho')) $('#ho').onclick = guard(async () => ME.role === 'admin' ? form('handover') : toast(d.approved_requests.length ? tr('اختر الطلب المعتمد من القائمة أعلاه', 'Pick the approved request above') : tr('لا توجد طلبات معتمدة: يطلب الموظف العهدة من «حسابي ومطالباتي» ويوافق عليها المدير', 'No approved requests: the employee asks from "My account & claims" and the manager approves')));
    if ($('#rt')) $('#rt').onclick = guard(() => form('return'));
    document.querySelectorAll('[data-dh]').forEach(b => b.onclick = guard(async () => { if (confirmDel()) { await api('DELETE', 'petty_custody/' + b.dataset.dh); render(); } }));
  };
}
