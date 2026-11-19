// Partners: capital, partner loans and current accounts per partner, shares with effective dates, expenses a partner paid,
// year-end profit allocation and the partner statement of account (print / PDF). Server: modules/partners.js.
const P_SEC = { capital: ['رأس المال', 'Capital'], loan: ['قرض الشريك', 'Partner loan'], current: ['الحساب الجاري', 'Current account'] };
const P_TYPES = [['capital_in', 'دفع رأس مال', 'Capital paid in'], ['capital_out', 'إرجاع رأس مال', 'Capital returned'], ['loan_in', 'قرض من الشريك للشركة', 'Loan to the company'],
  ['loan_repay', 'سداد قرض للشريك', 'Loan repaid to the partner'], ['deposit', 'إيداع في الحساب الجاري', 'Deposit to current account'], ['withdrawal', 'سحب من الحساب الجاري', 'Withdrawal'],
  ['transfer', 'تحويل بين حسابات الشريك', 'Transfer between the partner\'s accounts']];
const P_METHODS = [['bank', 'تحويل بنكي', 'Bank'], ['cash', 'نقداً', 'Cash'], ['opening', 'رصيد افتتاحي (قبل النظام)', 'Opening balance (before the system)'], ['books', 'مسجّل مسبقاً بقيد يومية', 'Already in the books (journal entry)']];
const pSigned = v => v < 0 ? `<span class="neg">(${money(-v)})</span>` : money(v);
const pName = p => (lang === 'ar' && p.name_ar) ? p.name_ar : p.name;

PAGES.partners = async id => {
  if (id) return partnerPage(+id);
  const d = await api('GET', 'partners'), t = d.totals, r = d.reconciliation;
  const k = (l, v, c = '') => `<div class="kpi"><div class="l">${l}</div><div class="v ${c}">${v}</div></div>`;
  const unassigned = r && Math.abs(r.unassigned_capital) >= 0.01, diff = r && r.rows.some(x => x.section !== 'capital' && Math.abs(x.difference) >= 0.01);
  const names = Object.fromEntries(d.partners.map(p => [p.id, pName(p)]));
  main(`<div class="bar"><h1>${tr('الشركاء', 'Partners')}</h1><span class="sp"></span>
    <button class="btn" id="np">+ ${tr('شريك', 'Partner')}</button><button class="btn" id="nt">+ ${tr('حركة شريك', 'Partner movement')}</button>
    <button class="btn" id="ne">+ ${tr('مصروف دفعه شريك', 'Expense paid by a partner')}</button><button class="btn sec" id="al">${tr('توزيع أرباح السنة', 'Allocate a year\'s profit')}</button></div>
  <p class="muted">${tr('لكل شريك ثلاثة حسابات: رأس المال، وقرض الشريك (مبلغ تردّه الشركة له)، والحساب الجاري (إيداعات، سحوبات، مصاريف دفعها عن الشركة، ونصيبه من الأرباح). المبالغ الموجبة لصالح الشريك، وبين قوسين ما عليه للشركة.',
    'Each partner has three accounts: capital, partner loan (money the company must pay back), and current account (deposits, withdrawals, expenses paid for the company, share of profit). Positive amounts are in the partner\'s favour; amounts in brackets are owed by the partner.')}</p>
  <div class="grid">${k(tr('رأس المال', 'Capital'), money(t.capital))}${k(tr('قروض الشركاء', 'Partner loans'), money(t.loan))}${k(tr('جاري الشركاء', 'Current accounts'), pSigned(t.current))}
    ${k(tr('مجموع الحصص اليوم', 'Shares today'), d.shares_today + '%', Math.abs(d.shares_today - 100) > 0.01 && d.partners.length ? 'bad' : 'ok')}</div>
  ${unassigned ? `<div class="card" style="border-color:var(--warn)">${tr(`يوجد رأس مال في الدفاتر (${money(r.unassigned_capital)}) غير موزّع على الشركاء. سجّله لكل شريك: «حركة شريك» ← دفع رأس مال ← «مسجّل مسبقاً بقيد يومية» (لا يُقيَّد مرة ثانية).`, `Share capital in the books (${money(r.unassigned_capital)}) is not assigned to a partner. Record it per partner: Partner movement → Capital paid in → "Already in the books" (it is not posted twice).`)}</div>` : ''}
  ${diff ? `<div class="card" style="border-color:var(--bad);color:var(--bad)">${tr('حسابات الشركاء لا تطابق دفتر الأستاذ — راجع «فحوص النظام» وأبلغ الدعم.', 'The partner accounts do not equal the general ledger — see the system checks and report it.')}</div>` : ''}
  <div class="tw"><table><thead><tr><th>${tr('الشريك', 'Partner')}</th><th class="n">${tr('الحصة', 'Share')}</th><th class="n">${tr('رأس المال', 'Capital')}</th><th class="n">${tr('القرض', 'Loan')}</th><th class="n">${tr('الجاري', 'Current')}</th><th class="n">${tr('الإجمالي', 'Total')}</th></tr></thead><tbody>
  ${d.partners.map(p => `<tr class="click" data-p="${p.id}"><td>${esc(pName(p))}${p.active ? '' : ` <span class="muted">(${tr('غير نشط', 'inactive')})</span>`}</td><td class="n">${p.share ? p.share + '%' : '—'}</td><td class="n">${money(p.balances.capital)}</td><td class="n">${money(p.balances.loan)}</td><td class="n">${pSigned(p.balances.current)}</td><td class="n"><b>${pSigned(p.balances.total)}</b></td></tr>`).join('') || `<tr><td colspan="6" class="muted">${tr('أضف الشركاء أولاً، ثم حصصهم.', 'Add the partners first, then their shares.')}</td></tr>`}</tbody></table></div>
  <div class="f2" style="margin-top:12px"><div><h2>${tr('الحصص وتاريخ سريانها', 'Shares and their start dates')}</h2><div class="tw"><table><tbody>
    ${d.shares.slice().reverse().map(s => `<tr><td>${esc(names[s.partner_id] || '#' + s.partner_id)}</td><td class="n">${s.pct}%</td><td>${tr('من', 'from')} ${esc(s.from_date)}</td><td><button class="btn sec sm" data-ds="${s.id}">×</button></td></tr>`).join('') || `<tr><td class="muted">—</td></tr>`}</tbody></table></div>
    <p class="muted">${tr('عند تغيّر الحصص أضف حصة جديدة لكل شريك من نفس التاريخ (المجموع ١٠٠٪). الحصة صفر تعني خروج الشريك.', 'When shares change, add a new share for every partner from the same date (total 100%). A 0% share means the partner left.')}</p></div>
    <div><h2>${tr('توزيع الأرباح', 'Profit allocations')}</h2><div class="tw"><table><tbody>
    ${d.allocations.map(a => `<tr><td>${a.year}</td><td class="n">${pSigned(a.net_profit)}</td><td>${a.lines.map(l => `${esc(names[l.partner_id] || '')} ${l.pct}%`).join(' · ')}</td><td><button class="btn sec sm" data-da="${a.id}">×</button></td></tr>`).join('') || `<tr><td class="muted">${tr('لم توزَّع أرباح بعد (اختياري: بنهاية السنة).', 'Nothing allocated yet (optional: at year end).')}</td></tr>`}</tbody></table></div></div></div>`);
  document.querySelectorAll('tr[data-p]').forEach(x => x.onclick = () => go('partners/' + x.dataset.p));
  document.querySelectorAll('[data-ds]').forEach(x => x.onclick = guard(async () => { if (confirmDel()) { await api('DELETE', 'partners/shares/' + x.dataset.ds); render(); } }));
  document.querySelectorAll('[data-da]').forEach(x => x.onclick = guard(async () => { if (confirm(tr('حذف توزيع أرباح هذه السنة؟ يُلغى قيده من دفتر الأستاذ.', 'Delete this year\'s profit allocation? Its ledger entry is removed.'))) { await api('DELETE', 'partner_allocations/' + x.dataset.da); render(); } }));
  $('#np').onclick = () => partnerForm(null);
  $('#nt').onclick = () => partnerTxnForm(d.partners);
  $('#ne').onclick = () => partnerExpenseForm(d.partners);
  $('#al').onclick = () => allocationForm();
};

async function partnerForm(p) {
  const emps = await api('GET', 'employees').catch(() => []);
  simpleModal({ title: p ? tr('تعديل الشريك', 'Edit partner') : tr('شريك جديد', 'New partner'), table: 'partners', row: p, after: render, fields: [
    { k: 'name', ar: 'الاسم (إنجليزي)', en: 'Name', req: 1 }, { k: 'name_ar', ar: 'الاسم بالعربي', en: 'Arabic name' },
    ...(p ? [{ k: 'active', ar: 'الحالة', en: 'Status', type: 'select', options: [['1', tr('نشط', 'Active')], ['0', tr('غير نشط', 'Inactive')]] }] : []),
    { k: 'employee_id', ar: 'ملف الموظف (إن كان يعمل ويأخذ راتباً)', en: 'Employee record (if the partner works and draws a salary)', type: 'select', options: refOpts(emps, e => e.name, true) },
    { k: 'notes', ar: 'ملاحظات', en: 'Notes', full: 1 }] });
}

async function partnerTxnForm(partners, pid) {
  const banks = await api('GET', 'bank_accounts');
  const act = partners.filter(p => p.active || p.id === pid);
  const m = modal(`<h2>${tr('حركة شريك', 'Partner movement')}</h2><div class="f2">
    ${field({ k: 'partner_id', ar: 'الشريك', en: 'Partner', type: 'select', options: act.map(p => [p.id, pName(p)]) }, pid)}
    ${field({ k: 'date', ar: 'التاريخ', en: 'Date', type: 'date' }, today())}
    ${field({ k: 'type', ar: 'نوع الحركة', en: 'Movement', type: 'select', options: P_TYPES.map(x => [x[0], tr(x[1], x[2])]) }, 'capital_in')}
    ${field({ k: 'amount', ar: 'المبلغ', en: 'Amount', type: 'number', req: 1 }, '')}
    <div class="f" data-w="pay">${'<label>' + tr('طريقة الدفع', 'Paid by') + '</label>'}<select name="method">${P_METHODS.map(x => `<option value="${x[0]}">${esc(tr(x[1], x[2]))}</option>`).join('')}</select></div>
    <div class="f" data-w="bank"><label>${tr('الحساب البنكي', 'Bank account')}</label><select name="bank_account_id">${banks.filter(b => b.active).map(b => `<option value="${b.id}">${esc(b.name)}</option>`).join('')}</select></div>
    <div class="f" data-w="tr"><label>${tr('من حساب', 'From')}</label><select name="from_section">${Object.entries(P_SEC).map(([k, v]) => `<option value="${k}" ${k === 'current' ? 'selected' : ''}>${tr(...v)}</option>`).join('')}</select></div>
    <div class="f" data-w="tr"><label>${tr('إلى حساب', 'To')}</label><select name="to_section">${Object.entries(P_SEC).map(([k, v]) => `<option value="${k}" ${k === 'capital' ? 'selected' : ''}>${tr(...v)}</option>`).join('')}</select></div>
    ${field({ k: 'reference', ar: 'المرجع (رقم التحويل / الإيصال)', en: 'Reference (transfer / receipt no.)' }, '')}
    ${field({ k: 'note', ar: 'ملاحظة', en: 'Note', full: 1 }, '')}</div>
    <p class="muted" id="hint"></p>
    <div class="acts"><button class="btn" id="save">${tr('حفظ', 'Save')}</button><button class="btn sec" id="cancel">${tr('إلغاء', 'Cancel')}</button></div>`);
  const show = () => {
    const ty = val(m, 'type'), me = val(m, 'method'), isTr = ty === 'transfer';
    m.querySelectorAll('[data-w="tr"]').forEach(x => x.style.display = isTr ? '' : 'none');
    m.querySelector('[data-w="pay"]').style.display = isTr ? 'none' : '';
    m.querySelector('[data-w="bank"]').style.display = !isTr && me === 'bank' ? '' : 'none';
    $('#hint', m).textContent = me === 'books' && !isTr ? tr('«مسجّل مسبقاً»: المبلغ موجود في الدفاتر بقيد قديم؛ يُنسب للشريك فقط ولا يُقيَّد مرة ثانية.', '"Already in the books": the amount is in the books from an earlier entry; it is only assigned to the partner, not posted again.')
      : me === 'opening' && !isTr ? tr('«رصيد افتتاحي»: رصيد كان موجوداً قبل بدء العمل على النظام.', '"Opening balance": a balance that existed before the system was used.') : '';
  };
  m.querySelectorAll('select').forEach(x => x.onchange = show); show();
  $('#cancel', m).onclick = closeModal;
  $('#save', m).onclick = guard(async () => {
    const b = {}; for (const k of ['partner_id', 'date', 'type', 'amount', 'method', 'bank_account_id', 'from_section', 'to_section', 'reference', 'note']) b[k] = val(m, k);
    await api('POST', 'partner_txns', b); closeModal(); render();
  });
}

async function partnerExpenseForm(partners, pid) {
  const [projects, parties, bills] = await Promise.all([api('GET', 'projects'), api('GET', 'parties'), api('GET', 'bills')]);
  const open = bills.filter(b => b.balance > 0.005);
  const m = modal(`<h2>${tr('مصروف دفعه شريك من ماله الخاص', 'Expense a partner paid from own money')}</h2>
    <p class="muted">${tr('يُسجَّل المصروف على المشروع كأي مصروف (مع ضريبة المدخلات)، ويُضاف المبلغ لصالح الشريك في حسابه الجاري. لا يخرج شيء من بنك أو صندوق الشركة.', 'The expense is booked on the project like any expense (with input VAT), and the amount is credited to the partner\'s current account. No company bank or cash money moves.')}</p>
    <div class="f2">${field({ k: 'partner_id', ar: 'الشريك', en: 'Partner', type: 'select', options: partners.filter(p => p.active).map(p => [p.id, pName(p)]) }, pid)}
    ${field({ k: 'date', ar: 'التاريخ', en: 'Date', type: 'date' }, today())}
    ${field({ k: 'mode', ar: 'ماذا دفع؟', en: 'What was paid?', type: 'select', options: [['new', tr('مصروف جديد', 'A new expense')], ['bill', tr('فاتورة مورد مسجّلة', 'A recorded supplier bill')]] }, 'new')}</div>
    <div class="f2" id="nw">${field({ k: 'description', ar: 'الوصف', en: 'Description', req: 1 }, '')}
    ${field({ k: 'amount', ar: 'المبلغ (بدون ضريبة)', en: 'Amount (ex VAT)', type: 'number' }, '')}${field({ k: 'vat_amount', ar: 'ضريبة القيمة المضافة', en: 'VAT', type: 'number' }, 0)}
    ${field({ k: 'category', ar: 'البند', en: 'Category', type: 'select', options: Object.entries(CATS).filter(([c]) => !['asset', 'sub_advance'].includes(c)).map(([c, v]) => [c, tr(...v)]) }, 'other')}
    ${field({ k: 'project_id', ar: 'المشروع', en: 'Project', type: 'select', options: refOpts(projects, p => `${p.code || ''} ${p.name}`) }, '')}
    ${field({ k: 'party_id', ar: 'المورد (اختياري)', en: 'Supplier (optional)', type: 'select', options: refOpts(parties.filter(x => x.type !== 'client'), x => x.name) }, '')}</div>
    <div class="f2" id="bl" style="display:none">${field({ k: 'bill_id', ar: 'الفاتورة', en: 'Bill', type: 'select', options: open.map(b => [b.id, `${b.date} · ${b.party_name || ''} · ${b.description || ''} · ${money(b.balance)}`]) }, '')}
    ${field({ k: 'bill_amount', ar: 'المبلغ المدفوع (فارغ = كامل الرصيد)', en: 'Amount paid (empty = whole balance)', type: 'number' }, '')}</div>
    <div class="f2">${field({ k: 'reference', ar: 'المرجع / رقم الإيصال', en: 'Reference / receipt no.' }, '')}</div>
    <div class="acts"><button class="btn" id="save">${tr('حفظ', 'Save')}</button><button class="btn sec" id="cancel">${tr('إلغاء', 'Cancel')}</button></div>`, true);
  m.querySelector('[name="mode"]').onchange = e => { $('#nw', m).style.display = e.target.value === 'new' ? '' : 'none'; $('#bl', m).style.display = e.target.value === 'bill' ? '' : 'none'; };
  $('#cancel', m).onclick = closeModal;
  $('#save', m).onclick = guard(async () => {
    const pidv = val(m, 'partner_id'), mode = val(m, 'mode'), b = { date: val(m, 'date'), reference: val(m, 'reference') };
    if (mode === 'bill') Object.assign(b, { bill_id: val(m, 'bill_id'), amount: val(m, 'bill_amount') || undefined });
    else for (const k of ['description', 'amount', 'vat_amount', 'category', 'project_id', 'party_id']) b[k] = val(m, k);
    await api('POST', `partners/${pidv}/expense`, b); closeModal(); render();
  });
}

function allocationForm() {
  const y0 = new Date().getFullYear() - 1;
  const m = modal(`<h2>${tr('توزيع أرباح سنة على الشركاء', 'Allocate a year\'s profit to the partners')}</h2>
    <p class="muted">${tr('اختياري. ينقل صافي ربح (أو خسارة) السنة من الأرباح المبقاة إلى الحساب الجاري لكل شريك حسب حصته — موزونة بالأيام إذا تغيّرت الحصص خلال السنة. لا يُدفع شيء: الصرف الفعلي يكون «سحب» من الحساب الجاري.', 'Optional. Moves the year\'s net profit (or loss) from retained earnings to each partner\'s current account by share — weighted by days if the shares changed during the year. Nothing is paid out: a payout is a withdrawal from the current account.')}</p>
    <div class="f2">${field({ k: 'year', ar: 'السنة', en: 'Year', type: 'number' }, y0)}</div><div id="pv"></div>
    <div class="acts"><button class="btn sec" id="prev">${tr('معاينة', 'Preview')}</button><button class="btn" id="save" disabled>${tr('تأكيد التوزيع', 'Allocate')}</button><button class="btn sec" id="cancel">${tr('إلغاء', 'Cancel')}</button></div>`, true);
  $('#cancel', m).onclick = closeModal;
  $('#prev', m).onclick = guard(async () => {
    const p = await api('GET', `partners/allocation-preview?year=${encodeURIComponent(val(m, 'year'))}`);
    $('#pv', m).innerHTML = `<div class="grid"><div class="kpi"><div class="l">${tr('الإيرادات', 'Revenue')}</div><div class="v">${money(p.revenue)}</div></div><div class="kpi"><div class="l">${tr('المصروفات', 'Expenses')}</div><div class="v">${money(p.expenses)}</div></div><div class="kpi"><div class="l">${tr('صافي الربح', 'Net profit')}</div><div class="v ${p.net_profit < 0 ? 'bad' : 'ok'}">${pSigned(p.net_profit)}</div></div></div>
      ${p.segments.length > 1 ? `<p class="muted">${tr('تغيّرت الحصص خلال السنة؛ النسبة موزونة بعدد الأيام:', 'Shares changed during the year; weighted by days:')} ${p.segments.map(s => `${s.from} → ${s.to} (${s.days} ${tr('يوم', 'days')})`).join(' · ')}</p>` : ''}
      <div class="tw"><table><thead><tr><th>${tr('الشريك', 'Partner')}</th><th class="n">${tr('النسبة', 'Share')}</th><th class="n">${tr('المبلغ', 'Amount')}</th></tr></thead><tbody>${p.lines.map(l => `<tr><td>${esc(pName(l))}</td><td class="n">${l.pct}%</td><td class="n">${pSigned(l.amount)}</td></tr>`).join('')}</tbody></table></div>
      ${p.problems.length ? `<div class="card" style="border-color:var(--bad);color:var(--bad)">${p.problems.map(esc).join('<br>')}</div>` : ''}`;
    $('#save', m).disabled = !p.ok;
  });
  $('#save', m).onclick = guard(async () => { await api('POST', 'partner_allocations', { year: val(m, 'year') }); closeModal(); toast(tr('تم التوزيع', 'Allocated')); render(); });
}

async function partnerPage(id) {
  const to = sessionStorage.ptTo || today(), from = sessionStorage.ptFrom || '', qs = `to=${to}${from ? '&from=' + from : ''}`;
  const [s, all] = await Promise.all([api('GET', `partners/${id}/statement?${qs}`), api('GET', 'partners')]);
  const p = all.partners.find(x => x.id === id) || s.partner;
  const sec = k => {
    const x = s.sections[k];
    return `<h2>${tr(...P_SEC[k])} <span class="muted">(${x.account})</span></h2><div class="tw"><table><thead><tr><th>${tr('التاريخ', 'Date')}</th><th>${tr('المرجع', 'Ref')}</th><th>${tr('البيان', 'Description')}</th><th class="n">${tr('المبلغ', 'Amount')}</th><th class="n">${tr('الرصيد', 'Balance')}</th><th></th></tr></thead><tbody>
    ${from ? `<tr><td>${esc(from)}</td><td></td><td>${tr('رصيد افتتاحي', 'Opening balance')}</td><td></td><td class="n">${pSigned(x.opening)}</td><td></td></tr>` : ''}
    ${x.lines.map(l => `<tr><td>${esc(l.date)}</td><td>${esc(l.ref)}${l.reference ? ` · ${esc(l.reference)}` : ''}</td><td>${esc(tr(l.description_ar || l.description, l.description))}${l.note && l.note !== 'partner-expense' ? ` — ${esc(l.note)}` : ''}</td><td class="n">${pSigned(l.amount)}</td><td class="n">${pSigned(l.balance)}</td>
      <td>${l.kind === 'txn' ? `<button class="btn sec sm" data-dt="${l.id}">×</button>` : l.kind === 'expense' ? `<button class="btn sec sm" data-de="${l.id}">×</button>` : ''}</td></tr>`).join('') || `<tr><td colspan="6" class="muted">—</td></tr>`}</tbody>
    <tfoot><tr><td colspan="4"><b>${tr('الرصيد', 'Balance')}</b></td><td class="n"><b>${pSigned(x.closing)}</b></td><td></td></tr></tfoot></table></div>`;
  };
  main(`<div class="bar"><button class="btn sec" onclick="go('partners')">←</button><h1 style="margin:0">${tr('كشف حساب شريك', 'Partner statement')} — ${esc(pName(p))}</h1><span class="sp"></span>
    <button class="btn" id="nt">+ ${tr('حركة', 'Movement')}</button><button class="btn" id="ne">+ ${tr('مصروف دفعه', 'Expense paid')}</button><button class="btn sec" id="sh">+ ${tr('حصة', 'Share')}</button><button class="btn sec" id="ed">${tr('تعديل', 'Edit')}</button>
    <a class="btn sec" target="_blank" href="/api/doc/partner_statement/${id}?${qs}&print=1">${tr('طباعة', 'Print')}</a><a class="btn sec" target="_blank" href="/api/doc/partner_statement/${id}/pdf?${qs}">PDF</a></div>
  <div class="bar"><label class="muted">${tr('من', 'From')}</label><input type="date" id="sf" value="${esc(from)}" style="width:auto"><label class="muted">${tr('إلى', 'To')}</label><input type="date" id="st" value="${esc(to)}" style="width:auto">
    <span class="muted">${s.share ? `${tr('الحصة', 'Share')} ${s.share}%` : ''}</span></div>
  <div class="grid">${Object.keys(P_SEC).map(k => `<div class="kpi"><div class="l">${tr(...P_SEC[k])}</div><div class="v">${pSigned(s.sections[k].closing)}</div></div>`).join('')}
    <div class="kpi"><div class="l">${tr('الإجمالي لصالح الشريك', 'Total in the partner\'s favour')}</div><div class="v ${s.total < 0 ? 'bad' : 'ok'}">${pSigned(s.total)}</div></div></div>
  ${Object.keys(P_SEC).map(sec).join('')}`);
  $('#sf').onchange = e => { sessionStorage.ptFrom = e.target.value; render(); };
  $('#st').onchange = e => { sessionStorage.ptTo = e.target.value || today(); render(); };
  $('#nt').onclick = () => partnerTxnForm(all.partners, id);
  $('#ne').onclick = () => partnerExpenseForm(all.partners, id);
  $('#ed').onclick = () => partnerForm({ id: p.id, name: p.name, name_ar: p.name_ar, active: p.active ? '1' : '0', employee_id: p.employee_id || '', notes: p.notes });
  $('#sh').onclick = () => simpleModal({ title: tr('حصة الشريك', 'Partner share'), table: `partners/${id}/shares`, after: render, fields: [{ k: 'pct', ar: 'الحصة ٪', en: 'Share %', type: 'number', req: 1 }, { k: 'from_date', ar: 'تسري من تاريخ', en: 'Applies from', type: 'date', def: today() }] });
  document.querySelectorAll('[data-dt]').forEach(x => x.onclick = guard(async () => { if (confirmDel()) { await api('DELETE', 'partner_txns/' + x.dataset.dt); render(); } }));
  document.querySelectorAll('[data-de]').forEach(x => x.onclick = guard(async () => { if (confirm(tr('حذف هذا المصروف؟ يُحذف من المشروع ومن حساب الشريك.', 'Delete this expense? It is removed from the project and from the partner\'s account.'))) { await api('DELETE', 'partners/expense/' + x.dataset.de); render(); } }));
}
