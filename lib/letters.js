// Bilingual HR letter templates. HR reviews before signing — these are standard wording, not legal advice.
const { esc, money } = require('./render');

const fmt = d => d || '—';
function letterBody(type, { emp, S, letter }) {
  const name = esc(emp.name), co = esc(S.company_name || ''), coAr = esc(S.company_name_ar || S.company_name || ''), role = esc(emp.designation || 'employee'),
    nat = esc(emp.nationality || ''), pass = esc(emp.passport_no || ''), joined = fmt(emp.join_date), total = (+emp.basic || 0) + (+emp.housing || 0) + (+emp.other_allowance || 0);
  const purpose = letter.purpose ? esc(letter.purpose) : '';
  const to = letter.addressed_to ? esc(letter.addressed_to) : 'To Whom It May Concern';
  const toAr = letter.addressed_to ? esc(letter.addressed_to) : 'إلى من يهمه الأمر';
  const ident = `${name}${nat ? ` (${nat})` : ''}${pass ? `, holder of passport no. ${pass}` : ''}`;
  const identAr = `${name}${nat ? ` (${nat})` : ''}${pass ? `، حامل/ة جواز السفر رقم ${pass}` : ''}`;
  const T = {
    salary_certificate: {
      title: 'Salary Certificate / شهادة راتب',
      en: `This is to certify that ${ident}, is employed with ${co} as <b>${role}</b> since <b>${joined}</b> and is currently in service. The monthly remuneration is: basic salary AED ${money(emp.basic)}, housing allowance AED ${money(emp.housing)}, other allowances AED ${money(emp.other_allowance)}, <b>total AED ${money(total)}</b>.`,
      ar: `نشهد بأن السيد/السيدة ${identAr}، يعمل لدى ${coAr} بوظيفة <b>${role}</b> منذ تاريخ <b>${joined}</b> وما زال على رأس عمله. ويبلغ راتبه الشهري: الراتب الأساسي ${money(emp.basic)} درهم، بدل السكن ${money(emp.housing)} درهم، بدلات أخرى ${money(emp.other_allowance)} درهم، <b>بإجمالي ${money(total)} درهم</b>.`,
      tail: true },
    employment_certificate: {
      title: 'Employment Certificate / شهادة عمل',
      en: `This is to certify that ${ident}, is employed with ${co} as <b>${role}</b> since <b>${joined}</b> and is currently in service.`,
      ar: `نشهد بأن السيد/السيدة ${identAr}، يعمل لدى ${coAr} بوظيفة <b>${role}</b> منذ تاريخ <b>${joined}</b> وما زال على رأس عمله.`, tail: true },
    noc: {
      title: 'No Objection Certificate / شهادة عدم ممانعة',
      en: `${co} confirms that ${ident}, who works with us as <b>${role}</b> since ${joined}, has <b>no objection</b> from the company${purpose ? ` for: <b>${purpose}</b>` : ''}.`,
      ar: `تفيد ${coAr} بأن السيد/السيدة ${identAr}، الذي يعمل لدينا بوظيفة <b>${role}</b> منذ ${joined}، <b>لا مانع لدى الشركة</b>${purpose ? ` من: <b>${purpose}</b>` : ''}.`, tail: true },
    experience: {
      title: 'Experience Certificate / شهادة خبرة',
      en: `This is to certify that ${ident}, worked with ${co} as <b>${role}</b> from <b>${joined}</b> ${emp.end_date ? `to <b>${emp.end_date}</b>` : 'until the date of this letter'}. We wish the employee every success in the future.`,
      ar: `نشهد بأن السيد/السيدة ${identAr}، عمل/ت لدى ${coAr} بوظيفة <b>${role}</b> في الفترة من <b>${joined}</b> ${emp.end_date ? `إلى <b>${emp.end_date}</b>` : 'وحتى تاريخ هذا الخطاب'}. ونتمنى له/ها التوفيق.`, tail: true },
    salary_transfer: {
      title: 'Salary Transfer Letter / خطاب تحويل راتب',
      en: `We confirm that ${ident}, is employed with ${co} as <b>${role}</b> since <b>${joined}</b>, with a total monthly salary of <b>AED ${money(total)}</b>. The salary is paid through the Wage Protection System to the employee's account${emp.iban ? ` (IBAN ${esc(emp.iban)})` : ''}${emp.bank_name ? ` with ${esc(emp.bank_name)}` : ''}. This letter is issued at the employee's request.`,
      ar: `نفيدكم بأن السيد/السيدة ${identAr}، يعمل لدى ${coAr} بوظيفة <b>${role}</b> منذ <b>${joined}</b> براتب شهري إجمالي <b>${money(total)} درهم</b>، ويُصرف الراتب عبر نظام حماية الأجور إلى حسابه${emp.iban ? ` (آيبان ${esc(emp.iban)})` : ''}${emp.bank_name ? ` لدى ${esc(emp.bank_name)}` : ''}. وقد أُعطي هذا الخطاب بناءً على طلبه.`, tail: true },
  };
  const t = T[type]; if (!t) return null;
  return { title: t.title, html: `<div class="letter"><div style="display:flex;justify-content:space-between"><div><b>Ref:</b> ${esc(letter.number)}</div><div><b>Date / التاريخ:</b> ${esc(letter.date)}</div></div>
    <p><b>${to}</b></p><h2 class="t">${t.title}</h2><p>${t.en}</p><p class="ar-p"><b>${toAr}</b></p><p class="ar-p">${t.ar}</p>
    ${t.tail ? `<p>This certificate is issued upon the employee's request without any liability on the company.</p><p class="ar-p">أُعطيت هذه الشهادة بناءً على طلب الموظف دون أدنى مسؤولية على الشركة.</p>` : ''}</div>` };
}

function payslipBody({ emp, row, S }) {
  const row2 = (a, b, v, strong) => `<tr${strong ? ' style="font-weight:700"' : ''}><td>${a} / ${b}</td><td class="n">${money(v)}</td></tr>`;
  return `<h2 class="t">Payslip / قسيمة راتب — ${esc(row.month)}</h2>
  <div class="box"><b>${esc(emp.name)}</b> — ${esc(emp.designation || '')}<br>Person code: ${esc(emp.person_code || '—')} · Days worked: ${row.days_worked} · Leave (unpaid) days: ${row.leave_days || 0}<br>
  Monthly package: basic ${money(emp.basic)} + housing ${money(emp.housing)} + other ${money(emp.other_allowance)}</div>
  <table><thead><tr><th>Item / البند</th><th class="n">AED</th></tr></thead><tbody>
  ${row2('Fixed salary (pro-rated)', 'الراتب الثابت', row.fixed)}${row2('Overtime', 'العمل الإضافي', row.overtime)}${row2('Bonus / other additions', 'مكافآت وإضافات', row.bonus)}
  ${row2('Gross pay', 'الإجمالي', row.gross, true)}${row2('Deductions', 'الخصومات', -row.deductions)}${row2('Net pay', 'صافي الراتب', row.net, true)}</tbody></table>
  <p>Paid by WPS${row.paid_date ? ` on ${esc(row.paid_date)}` : ' (payment pending)'}${emp.iban ? ` to IBAN ${esc(emp.iban)}` : ''}.</p>`;
}
module.exports = { letterBody, payslipBody };
