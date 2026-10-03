// Accounting pages: financial statements, general ledger, journal entries, chart of accounts, bank reconciliation.
const ATYPE = { asset: ['الأصول', 'Assets'], liability: ['الالتزامات', 'Liabilities'], equity: ['حقوق الملكية', 'Equity'], revenue: ['الإيرادات', 'Revenue'], expense: ['المصروفات', 'Expenses'] };
const aname = a => (lang === 'ar' && a.name_ar ? a.name_ar : a.name);
const yearStart = () => `${new Date().getFullYear()}-01-01`;
const dateBar = (f, t, extra = '') => `<div class="bar noprint"><div><label>${tr('من', 'From')}</label><input type="date" id="df" value="${f}"></div><div><label>${tr('إلى', 'To')}</label><input type="date" id="dt" value="${t}"></div>${extra}<button class="btn" id="dgo" style="margin-top:16px">${tr('عرض', 'Show')}</button></div>`;

PAGES.financials = async () => {
  const f = sessionStorage.ff || yearStart(), t = sessionStorage.ft || today();
  const r = await api('GET', `financials?from=${f}&to=${t}`), bs = r.balance_sheet;
  const rows = (list, key = 'amount') => list.map(x => `<tr><td>${esc(x.code)}</td><td>${esc(aname(x))}</td><td class="n">${money(x[key])}</td></tr>`).join('') || `<tr><td colspan="3" class="muted">—</td></tr>`;
  main(`<h1>${tr('القوائم المالية', 'Financial statements')}</h1>${dateBar(f, t, `<a class="btn sec sm noprint" style="margin-top:16px" target="_blank" href="/api/export/trial_balance?from=${f}&to=${t}">Excel</a>`)}
  <p class="muted">${tr('تُولَّد القيود تلقائياً من الفواتير والمصروفات والمدفوعات والرواتب والإهلاك مع القيود اليدوية. الأرصدة الافتتاحية تُدخل كقيد يومية. هذه قوائم إدارية وليست قوائم مدققة.', 'Entries are generated automatically from invoices, bills, payments, payroll and depreciation plus manual journals. Enter opening balances as a journal entry. These are management accounts, not audited statements.')}</p>
  <div class="grid"><div class="kpi"><div class="l">${tr('الإيرادات', 'Revenue')}</div><div class="v">${money(r.revenue)}</div></div><div class="kpi"><div class="l">${tr('المصروفات', 'Expenses')}</div><div class="v">${money(r.expenses)}</div></div><div class="kpi"><div class="l">${tr('صافي الربح للفترة', 'Net profit (period)')}</div><div class="v ${r.net_profit >= 0 ? 'ok' : 'bad'}">${money(r.net_profit)}</div></div>
   <div class="kpi"><div class="l">${tr('ميزان المراجعة', 'Trial balance')}</div><div class="v ${r.tb_debit === r.tb_credit ? 'ok' : 'bad'}">${r.tb_debit === r.tb_credit ? tr('متوازن', 'Balanced') : tr('غير متوازن', 'Out of balance')}</div></div></div>
  <div class="f2"><div><h2>${tr('قائمة الدخل', 'Profit & loss')}</h2><div class="tw"><table><tbody>${rows(r.pl.filter(x => x.type === 'revenue'))}<tr><td colspan="2"><b>${tr('إجمالي الإيرادات', 'Total revenue')}</b></td><td class="n"><b>${money(r.revenue)}</b></td></tr>${rows(r.pl.filter(x => x.type === 'expense'))}<tr><td colspan="2"><b>${tr('إجمالي المصروفات', 'Total expenses')}</b></td><td class="n"><b>${money(r.expenses)}</b></td></tr><tr><td colspan="2"><b>${tr('صافي الربح', 'Net profit')}</b></td><td class="n"><b>${money(r.net_profit)}</b></td></tr></tbody></table></div></div>
  <div><h2>${tr('المركز المالي', 'Balance sheet')} (${esc(t)})</h2><div class="tw"><table><tbody>
    <tr><th colspan="3">${tr(...ATYPE.asset)}</th></tr>${rows(bs.assets)}<tr><td colspan="2"><b>${tr('إجمالي الأصول', 'Total assets')}</b></td><td class="n"><b>${money(bs.total_assets)}</b></td></tr>
    <tr><th colspan="3">${tr(...ATYPE.liability)}</th></tr>${rows(bs.liabilities)}<tr><td colspan="2"><b>${tr('إجمالي الالتزامات', 'Total liabilities')}</b></td><td class="n"><b>${money(bs.total_liabilities)}</b></td></tr>
    <tr><th colspan="3">${tr(...ATYPE.equity)}</th></tr>${rows(bs.equity)}<tr><td></td><td>${tr('أرباح الفترة الجارية', 'Current earnings')}</td><td class="n">${money(bs.current_earnings)}</td></tr><tr><td colspan="2"><b>${tr('إجمالي حقوق الملكية', 'Total equity')}</b></td><td class="n"><b>${money(bs.total_equity)}</b></td></tr></tbody></table></div></div></div>
  <h2 style="margin-top:18px">${tr('ميزان المراجعة', 'Trial balance')}</h2><div class="tw"><table><thead><tr><th>${tr('الرمز', 'Code')}</th><th>${tr('الحساب', 'Account')}</th><th class="n">${tr('مدين', 'Debit')}</th><th class="n">${tr('دائن', 'Credit')}</th></tr></thead><tbody>
  ${r.trial_balance.map(x => `<tr class="click" onclick="sessionStorage.la='${x.code}';go('ledger')"><td>${esc(x.code)}</td><td>${esc(aname(x))}</td><td class="n">${x.debit ? money(x.debit) : ''}</td><td class="n">${x.credit ? money(x.credit) : ''}</td></tr>`).join('') || `<tr><td colspan="4" class="muted">${tr('لا توجد قيود', 'No entries')}</td></tr>`}
  <tr style="font-weight:700"><td colspan="2">${tr('الإجمالي', 'Total')}</td><td class="n">${money(r.tb_debit)}</td><td class="n">${money(r.tb_credit)}</td></tr></tbody></table></div>`);
  $('#dgo').onclick = () => { sessionStorage.ff = $('#df').value; sessionStorage.ft = $('#dt').value; render(); };
};

PAGES.ledger = async () => {
  const f = sessionStorage.lf || yearStart(), t = sessionStorage.lt || today(), accs = await api('GET', 'accounts'), code = sessionStorage.la || '1100';
  const r = await api('GET', `ledger?account=${code}&from=${f}&to=${t}`);
  main(`<h1>${tr('دفتر الأستاذ', 'General ledger')}</h1>${dateBar(f, t, `<div><label>${tr('الحساب', 'Account')}</label><select id="ac" style="min-width:260px">${accs.map(a => `<option value="${a.code}" ${a.code === code ? 'selected' : ''}>${a.code} — ${esc(aname(a))}</option>`).join('')}</select></div><a class="btn sec sm noprint" style="margin-top:16px" target="_blank" href="/api/export/journal?from=${f}&to=${t}">Excel (${tr('كل القيود', 'all entries')})</a>`)}
  <div class="tw"><table><thead><tr><th>${tr('التاريخ', 'Date')}</th><th>${tr('المرجع', 'Ref')}</th><th>${tr('البيان', 'Description')}</th><th class="n">${tr('مدين', 'Debit')}</th><th class="n">${tr('دائن', 'Credit')}</th><th class="n">${tr('الرصيد', 'Balance')}</th></tr></thead><tbody>
  <tr class="muted"><td colspan="5">${tr('رصيد افتتاحي', 'Opening balance')}</td><td class="n">${money(r.opening)}</td></tr>
  ${r.lines.map(l => `<tr><td>${esc(l.date)}</td><td>${esc(l.ref || '')}</td><td>${esc(l.memo || '')}</td><td class="n">${l.debit ? money(l.debit) : ''}</td><td class="n">${l.credit ? money(l.credit) : ''}</td><td class="n">${money(l.balance)}</td></tr>`).join('') || `<tr><td colspan="6" class="muted">${tr('لا توجد حركات', 'No movements')}</td></tr>`}</tbody></table></div>
  <p class="muted">${tr('الرصيد الموجب = مدين، السالب = دائن.', 'Positive balance = debit, negative = credit.')}</p>`);
  $('#ac').onchange = e => { sessionStorage.la = e.target.value; render(); };
  $('#dgo').onclick = () => { sessionStorage.lf = $('#df').value; sessionStorage.lt = $('#dt').value; render(); };
};

PAGES.coa = async () => {
  const accs = await api('GET', 'accounts');
  main(`<div class="bar"><h1>${tr('دليل الحسابات', 'Chart of accounts')}</h1><span class="sp"></span><button class="btn" id="add">+ ${tr('حساب', 'Account')}</button></div>
  ${Object.keys(ATYPE).map(ty => `<h2 style="margin-top:14px">${tr(...ATYPE[ty])}</h2><div class="tw"><table><tbody>${accs.filter(a => a.type === ty).map(a => `<tr class="click" data-c="${a.code}"><td style="width:90px">${esc(a.code)}</td><td>${esc(a.name)}</td><td dir="rtl">${esc(a.name_ar || '')}</td><td>${a.system ? `<span class="pill">${tr('أساسي', 'built-in')}</span>` : ''}</td></tr>`).join('')}</tbody></table></div>`).join('')}`);
  const edit = a => {
    const m = modal(`<h2>${a ? tr('تعديل حساب', 'Edit account') : tr('حساب جديد', 'New account')}</h2><div class="f2">${a ? '' : field({ k: 'code', ar: 'الرمز (٣–٦ أرقام)', en: 'Code (3–6 digits)', req: 1 }, '')}${field({ k: 'name', ar: 'الاسم (إنجليزي)', en: 'Name (English)', req: 1 }, a?.name)}${field({ k: 'name_ar', ar: 'الاسم (عربي)', en: 'Name (Arabic)' }, a?.name_ar)}
      ${a ? '' : field({ k: 'type', ar: 'النوع', en: 'Type', type: 'select', options: Object.entries(ATYPE).map(([k, v]) => [k, tr(...v)]) }, 'expense')}</div>
      <div class="acts"><button class="btn" id="save">${tr('حفظ', 'Save')}</button><button class="btn sec" id="cancel">${tr('إلغاء', 'Cancel')}</button><span class="sp"></span>${a && !a.system ? `<button class="btn bad" id="del">${tr('حذف', 'Delete')}</button>` : ''}</div>`);
    $('#cancel', m).onclick = closeModal;
    $('#save', m).onclick = guard(async () => { a ? await api('PUT', 'accounts/' + a.code, { name: val(m, 'name'), name_ar: val(m, 'name_ar') }) : await api('POST', 'accounts', { code: val(m, 'code'), name: val(m, 'name'), name_ar: val(m, 'name_ar'), type: val(m, 'type') }); closeModal(); render(); });
    if ($('#del', m)) $('#del', m).onclick = guard(async () => { if (confirmDel()) { await api('DELETE', 'accounts/' + a.code); closeModal(); render(); } });
  };
  $('#add').onclick = () => edit(null);
  document.querySelectorAll('tr[data-c]').forEach(t => t.onclick = () => edit(accs.find(a => a.code === t.dataset.c)));
};

// ---- manual journal entries --------------------------------------------------------------------------
PAGES.journal = async () => {
  const [rows, accs] = await Promise.all([api('GET', 'journal_entries'), api('GET', 'accounts')]);
  main(`<div class="bar"><h1>${tr('قيود اليومية اليدوية', 'Manual journal entries')}</h1><span class="sp"></span><button class="btn" id="add">+ ${tr('قيد جديد', 'New entry')}</button></div>
  <p class="muted">${tr('للأرصدة الافتتاحية والتسويات (مخصص نهاية الخدمة، دفعات مقدمة، مصروفات مستحقة…). القيود الناتجة عن الفواتير والمصروفات والرواتب تُولَّد تلقائياً ولا تُدخل هنا.', 'For opening balances and adjustments (end-of-service provision, advances, accruals…). Entries from invoices, bills and payroll are generated automatically — do not re-enter them here.')}</p>
  <div class="tw"><table><thead><tr><th>${tr('الرقم', 'No.')}</th><th>${tr('التاريخ', 'Date')}</th><th>${tr('البيان', 'Memo')}</th><th>${tr('الأسطر', 'Lines')}</th><th class="n">${tr('المبلغ', 'Amount')}</th></tr></thead><tbody>
  ${rows.map(j => `<tr class="click" data-id="${j.id}"><td>JV-${j.id}</td><td>${esc(j.date)}</td><td>${esc(j.memo || '')}</td><td>${j.lines.map(l => `${esc(l.account)}${l.debit ? ' Dr' : ' Cr'}`).join(', ')}</td><td class="n">${money(j.lines.reduce((s, l) => s + l.debit, 0))}</td></tr>`).join('') || `<tr><td colspan="5" class="muted">${tr('لا توجد قيود يدوية', 'No manual entries')}</td></tr>`}</tbody></table></div>`);
  const edit = j => {
    const st = { lines: j ? j.lines.map(l => ({ ...l })) : [{ account: '', debit: '', credit: '' }, { account: '', debit: '', credit: '' }] };
    const m = modal(`<h2>${j ? 'JV-' + j.id : tr('قيد يومية جديد', 'New journal entry')}</h2><div class="f2">${field({ k: 'date', ar: 'التاريخ', en: 'Date', type: 'date' }, j?.date || today())}${field({ k: 'memo', ar: 'البيان', en: 'Memo' }, j?.memo)}</div><div id="jl"></div>
      <div class="acts"><button class="btn" id="save">${tr('حفظ', 'Save')}</button><button class="btn sec" id="cancel">${tr('إلغاء', 'Cancel')}</button><span class="sp"></span>${j ? `<button class="btn bad" id="del">${tr('حذف', 'Delete')}</button>` : ''}</div>`, true);
    const draw = () => {
      const d = st.lines.reduce((s, l) => s + (+l.debit || 0), 0), c = st.lines.reduce((s, l) => s + (+l.credit || 0), 0);
      $('#jl', m).innerHTML = `<div class="tw items"><table><thead><tr><th>${tr('الحساب', 'Account')}</th><th style="width:130px">${tr('مدين', 'Debit')}</th><th style="width:130px">${tr('دائن', 'Credit')}</th><th style="width:30px"></th></tr></thead><tbody>
        ${st.lines.map((l, i) => `<tr><td><select data-i="${i}" data-f="account"><option value=""></option>${accs.map(a => `<option value="${a.code}" ${a.code === l.account ? 'selected' : ''}>${a.code} — ${esc(aname(a))}</option>`).join('')}</select></td><td><input type="number" step="any" data-i="${i}" data-f="debit" value="${l.debit}"></td><td><input type="number" step="any" data-i="${i}" data-f="credit" value="${l.credit}"></td><td><button type="button" class="x" data-x="${i}">×</button></td></tr>`).join('')}
        <tr style="font-weight:700"><td>${tr('الإجمالي', 'Total')} <span class="${Math.abs(d - c) < 0.005 && d ? 'pos' : 'neg'}">${Math.abs(d - c) < 0.005 && d ? '✔ ' + tr('متوازن', 'balanced') : tr('الفرق', 'difference') + ' ' + money(d - c)}</span></td><td>${money(d)}</td><td>${money(c)}</td><td></td></tr></tbody></table></div><button type="button" class="btn sec sm" id="al" style="margin-top:6px">+ ${tr('سطر', 'Line')}</button>`;
      $('#jl', m).querySelectorAll('[data-f]').forEach(x => x.onchange = () => { st.lines[+x.dataset.i][x.dataset.f] = x.value; draw(); });
      $('#jl', m).querySelectorAll('[data-x]').forEach(x => x.onclick = () => { st.lines.splice(+x.dataset.x, 1); draw(); });
      $('#al', m).onclick = () => { st.lines.push({ account: '', debit: '', credit: '' }); draw(); };
    };
    draw();
    $('#cancel', m).onclick = closeModal;
    $('#save', m).onclick = guard(async () => { const b = { date: val(m, 'date'), memo: val(m, 'memo'), lines: st.lines.filter(l => l.account) }; j ? await api('PUT', 'journal_entries/' + j.id, b) : await api('POST', 'journal_entries', b); closeModal(); render(); });
    if (j) $('#del', m).onclick = guard(async () => { if (confirmDel()) { await api('DELETE', 'journal_entries/' + j.id); closeModal(); render(); } });
  };
  $('#add').onclick = () => edit(null);
  document.querySelectorAll('tr.click').forEach(t => t.onclick = () => edit(rows.find(r => r.id === +t.dataset.id)));
};

// ---- bank reconciliation -------------------------------------------------------------------------------
PAGES.bank = async () => {
  const d = await api('GET', 'bank'), s = d.summary, diff = Math.round((s.statement_balance - s.book_balance) * 100) / 100;
  const k = (l, v, c = '') => `<div class="kpi"><div class="l">${l}</div><div class="v ${c}">${money(v)}</div></div>`;
  main(`<div class="bar"><h1>${tr('مطابقة البنك', 'Bank reconciliation')}</h1><span class="sp"></span><button class="btn sec" id="am">${tr('مطابقة تلقائية', 'Auto-match')}</button><button class="btn" id="imp">${tr('استيراد كشف الحساب', 'Import statement')}</button></div>
  <p class="muted">${tr('الصق أو ارفع كشف الحساب بصيغة CSV (التاريخ، البيان، المبلغ — الإيداع موجب والسحب سالب). يطابق النظام الدفعات بنفس المبلغ خلال ٧ أيام، وتُطابَق البنود الأخرى يدوياً. النقد والعهدة لا تظهر في الكشف فلا تُدرج هنا.', 'Paste or upload the bank statement as CSV (date, description, amount — deposits positive, withdrawals negative). Payments with the same amount within 7 days are matched automatically; match the rest by hand. Cash and petty cash do not appear on the statement and are excluded.')}</p>
  <div class="grid">${k(tr('رصيد الكشف (من البنود المستوردة)', 'Statement balance (imported lines)'), s.statement_balance)}${k(tr('رصيد الدفاتر (حساب البنك)', 'Book balance (bank ledger)'), s.book_balance)}${k(tr('الفرق', 'Difference'), diff, Math.abs(diff) < 0.005 ? 'ok' : 'warn')}${k(tr('بنود كشف غير مطابقة', 'Unmatched statement lines'), s.unmatched_lines)}${k(tr('دفعات غير مطابقة', 'Unmatched book payments'), s.unmatched_payments)}</div>
  <div class="f2"><div><h2>${tr('بنود كشف الحساب', 'Statement lines')}</h2><div class="tw"><table><tbody>${d.lines.map(l => `<tr><td>${esc(l.date)}</td><td>${esc(l.description || '')}</td><td class="n ${l.amount < 0 ? 'neg' : 'pos'}">${money(l.amount)}</td><td>${l.payment_id ? `<span class="tag paid">${tr('مطابق', 'Matched')}</span> <button class="btn sec sm" data-un="${l.id}">${tr('إلغاء', 'Unmatch')}</button>` : `<button class="btn sm" data-m="${l.id}">${tr('مطابقة', 'Match')}</button> <button class="btn sec sm" data-dl="${l.id}">×</button>`}</td></tr>`).join('') || `<tr><td class="muted">${tr('لم يُستورد كشف', 'No statement imported')}</td></tr>`}</tbody></table></div></div>
  <div><h2>${tr('دفعات الدفاتر غير المطابقة', 'Unmatched book payments')}</h2><div class="tw"><table><tbody>${d.unmatched_payments.map(p => `<tr><td>${esc(p.date)}</td><td>${p.kind === 'in' ? tr('مقبوض', 'Receipt') : tr('مدفوع', 'Payment')} ${esc(p.reference || '')}</td><td class="n ${p.signed < 0 ? 'neg' : 'pos'}">${money(p.signed)}</td></tr>`).join('') || `<tr><td class="muted">✔</td></tr>`}</tbody></table></div></div></div>`);
  $('#am').onclick = guard(async () => { const r = await api('POST', 'bank/auto-match'); toast(`${r.matched} ${tr('بنداً طُوبق', 'matched')}`); render(); });
  $('#imp').onclick = () => {
    const m = modal(`<h2>${tr('استيراد كشف الحساب', 'Import bank statement')}</h2><div class="f"><input type="file" id="bf" accept=".csv,.txt"></div><div class="f"><label>${tr('أو الصق الأسطر هنا', 'or paste the lines here')}</label><textarea id="bt" style="min-height:160px" placeholder="2026-10-03,TRANSFER CLIENT A,12500.00&#10;2026-10-04,BANK FEES,-25.00"></textarea></div>
      <div class="acts"><button class="btn" id="save">${tr('استيراد', 'Import')}</button><button class="btn sec" id="cancel">${tr('إلغاء', 'Cancel')}</button></div>`);
    $('#cancel', m).onclick = closeModal;
    $('#bf', m).onchange = async e => { const f = e.target.files[0]; if (f) $('#bt', m).value = await f.text(); };
    $('#save', m).onclick = guard(async () => { const r = await api('POST', 'bank/import', { csv: $('#bt', m).value }); closeModal(); toast(`${r.added} ${tr('بنداً جديداً', 'new lines')}${r.skipped ? ` · ${r.skipped} ${tr('مكرر/غير صالح', 'skipped')}` : ''}`); render(); });
  };
  document.querySelectorAll('[data-un]').forEach(b => b.onclick = guard(async () => { await api('POST', 'bank/unmatch', { line_id: +b.dataset.un }); render(); }));
  document.querySelectorAll('[data-dl]').forEach(b => b.onclick = guard(async () => { if (confirmDel()) { await api('DELETE', 'bank/lines/' + b.dataset.dl); render(); } }));
  document.querySelectorAll('[data-m]').forEach(b => b.onclick = () => {
    const l = d.lines.find(x => x.id === +b.dataset.m), cands = [...d.unmatched_payments].sort((a, c) => Math.abs(a.signed - l.amount) - Math.abs(c.signed - l.amount));
    const m = modal(`<h2>${tr('مطابقة', 'Match')}: ${esc(l.date)} ${esc(l.description || '')} (${money(l.amount)})</h2><div class="tw"><table><tbody>${cands.map(p => `<tr class="click" data-p="${p.id}"><td>${esc(p.date)}</td><td>${p.kind === 'in' ? tr('مقبوض', 'Receipt') : tr('مدفوع', 'Payment')} ${esc(p.reference || '')}</td><td class="n ${Math.abs(p.signed - l.amount) < 0.005 ? 'pos' : ''}">${money(p.signed)}</td></tr>`).join('') || `<tr><td class="muted">${tr('لا توجد دفعات', 'No payments')}</td></tr>`}</tbody></table></div><div class="acts"><button class="btn sec" id="cancel">${tr('إغلاق', 'Close')}</button></div>`);
    $('#cancel', m).onclick = closeModal;
    m.querySelectorAll('[data-p]').forEach(r => r.onclick = guard(async () => {
      const p = cands.find(x => x.id === +r.dataset.p), force = Math.abs(p.signed - l.amount) > 0.005;
      if (force && !confirm(tr('المبلغان مختلفان. المطابقة رغم ذلك؟', 'Amounts differ. Match anyway?'))) return;
      await api('POST', 'bank/match', { line_id: l.id, payment_id: p.id, force }); closeModal(); render();
    }));
  });
};
