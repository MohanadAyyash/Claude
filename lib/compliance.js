// UAE compliance helpers — pure functions (no I/O) so they can be unit-tested.
// IMPORTANT: encodes the rules as understood at build time. Laws, rates and bank file
// formats change; always have an accountant / PRO / your bank confirm before filing or paying.
const round = n => Math.round((n + Number.EPSILON) * 100) / 100;

// ---- identifiers ------------------------------------------------------------
const validTrn = s => /^\d{15}$/.test(String(s || '').replace(/\s/g, ''));              // FTA Tax Registration Number
const validEid = s => /^784\d{12}$/.test(String(s || '').replace(/[-\s]/g, ''));        // Emirates ID
const validPersonCode = s => /^\d{14}$/.test(String(s || '').replace(/\s/g, ''));       // MOHRE labour card / person code
const validEstablishment = s => /^\d{13}$/.test(String(s || '').replace(/\s/g, ''));    // MOHRE establishment (employer) ID
const validRouting = s => /^\d{9}$/.test(String(s || '').replace(/\s/g, ''));           // CBUAE bank routing code
// UAE IBAN: AE + 2 check digits + 3-digit bank code + 16-digit account = 23 chars, ISO 7064 mod-97
function validIban(iban) {
  const s = String(iban || '').replace(/\s/g, '').toUpperCase();
  if (!/^AE\d{21}$/.test(s)) return false;
  let rem = 0;
  for (const ch of (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, c => c.charCodeAt(0) - 55)) rem = (rem * 10 + Number(ch)) % 97;
  return rem === 1;
}
const clean = s => String(s || '').replace(/[\s-]/g, '');

// ---- VAT (Federal Decree-Law 8/2017) ----------------------------------------
const EMIRATES = { abu_dhabi: 'Abu Dhabi', dubai: 'Dubai', sharjah: 'Sharjah', ajman: 'Ajman', uaq: 'Umm Al Quwain', rak: 'Ras Al Khaimah', fujairah: 'Fujairah' };
// line vat codes: std (5%), zero (zero-rated), exempt
function docTotals(items, vatPct, retPct = 0) {
  let std = 0, zero = 0, exempt = 0;
  for (const i of items) {
    const a = (+i.qty || 0) * (+i.rate || 0);
    if (i.vat === 'zero') zero += a; else if (i.vat === 'exempt') exempt += a; else std += a;
  }
  const sub = round(std + zero + exempt), vat = round(std * (+vatPct || 0) / 100);
  return { subtotal: sub, std_total: round(std), zero_total: round(zero), exempt_total: round(exempt), vat, total: round(sub + vat), retention: round(sub * (+retPct || 0) / 100) };
}

// ---- Labour law (Federal Decree-Law 33/2021) --------------------------------
const daysInMonth = ym => { const [y, m] = ym.split('-').map(Number); return new Date(y, m, 0).getDate(); };
function computePayroll(emp, inp = {}) {
  const fixedTotal = (+emp.basic || 0) + (+emp.housing || 0) + (+emp.other_allowance || 0);
  const days = Math.min(inp.days_worked ?? 30, 30);
  const fixed = round(fixedTotal * days / 30);
  const hourly = (+emp.basic || 0) / 30 / 8;                               // hourly rate from basic wage
  const overtime = round(hourly * 1.25 * (+inp.ot_normal_hours || 0) + hourly * 1.5 * (+inp.ot_special_hours || 0)); // +25% day, +50% night (10pm–4am) / rest day
  const bonus = +inp.bonus || 0, deductions = +inp.deductions || 0;
  const gross = round(fixed + overtime + bonus), net = round(gross - deductions);
  return { fixed, overtime, bonus, deductions, gross, net, deduction_ratio: gross ? deductions / gross : 0 };
}
// End-of-service gratuity: 21 days' basic wage per year for first 5 years, 30 days after; capped at 2 years' wage; none under 1 year.
function gratuity(emp, endDate) {
  const start = new Date(emp.join_date), end = new Date(endDate || new Date().toISOString().slice(0, 10));
  if (isNaN(start) || end < start) return { years: 0, amount: 0 };
  const years = (end - start) / 864e5 / 365;
  if (years < 1) return { years: round(years), amount: 0 };
  const daily = (+emp.basic || 0) / 30;
  const amt = daily * (21 * Math.min(years, 5) + 30 * Math.max(0, years - 5));
  return { years: round(years), amount: round(Math.min(amt, 24 * (+emp.basic || 0))) };
}

// ---- WPS: Salary Information File (SIF) -------------------------------------
function payrollIssues(settings, rows) {
  const out = [];
  if (!validEstablishment(settings.mohre_id)) out.push({ who: 'company', msg: 'MOHRE establishment ID must be 13 digits (Settings)' });
  if (!validRouting(settings.employer_routing)) out.push({ who: 'company', msg: 'Employer bank routing code must be 9 digits (Settings)' });
  for (const r of rows) {
    const w = r.name;
    if (!validPersonCode(r.person_code)) out.push({ who: w, msg: 'Person code / labour card number must be 14 digits' });
    if (!validRouting(r.routing_code)) out.push({ who: w, msg: 'Bank routing code must be 9 digits' });
    if (!validIban(r.iban)) out.push({ who: w, msg: 'Invalid UAE IBAN' });
    if (r.net <= 0) out.push({ who: w, msg: 'Net salary must be greater than zero' });
    if (r.deduction_ratio > 0.5) out.push({ who: w, msg: 'Deductions exceed 50% of wage — check legal limits', warn: true });
  }
  return out;
}
// net = fixed + variable ; deductions are netted off the variable part (and the fixed part if variable goes negative)
function wpsAmounts(r) {
  let fixed = r.fixed, variable = round(r.overtime + r.bonus - r.deductions);
  if (variable < 0) { fixed = round(fixed + variable); variable = 0; }
  return { fixed, variable };
}
function buildSif(settings, rows, month, now = new Date()) {
  const p = n => String(n).padStart(2, '0'), [y, m] = month.split('-');
  const date = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`, hhmm = p(now.getHours()) + p(now.getMinutes());
  const lines = rows.map(r => {
    const { fixed, variable } = wpsAmounts(r), last = daysInMonth(month);
    return ['EDR', clean(r.person_code), clean(r.routing_code), clean(r.iban).toUpperCase(), `${month}-01`, `${month}-${p(last)}`, r.days_worked, fixed.toFixed(2), variable.toFixed(2), r.leave_days || 0].join(',');
  });
  const total = round(rows.reduce((s, r) => s + r.net, 0));
  lines.push(['SCR', clean(settings.mohre_id), clean(settings.employer_routing), date, hhmm, m + y, rows.length, total.toFixed(2), 'AED', ''].join(','));
  const file = `${clean(settings.mohre_id)}${String(now.getFullYear()).slice(2)}${p(now.getMonth() + 1)}${p(now.getDate())}${hhmm}${p(now.getSeconds())}.SIF`;
  return { file, content: lines.join('\r\n') + '\r\n', total };
}

// ---- Corporate Tax (Federal Decree-Law 47/2022) -----------------------------
const CT = { rate: 0.09, threshold: 375000, sbr_revenue: 3000000, sbr_last_period_end: '2026-12-31' };
function corporateTax({ revenue, expenses, periodEnd }) {
  const profit = round(revenue - expenses), taxable = Math.max(0, profit);
  const standard = round(Math.max(0, taxable - CT.threshold) * CT.rate);
  const sbr = revenue <= CT.sbr_revenue && (periodEnd || '') <= CT.sbr_last_period_end;
  return { revenue: round(revenue), expenses: round(expenses), profit, taxable_income: taxable, tax: standard, tax_if_sbr: sbr ? 0 : standard, sbr_possible: sbr, ...CT };
}

module.exports = { round, validTrn, validEid, validPersonCode, validEstablishment, validRouting, validIban, clean, EMIRATES, docTotals, daysInMonth, computePayroll, gratuity, payrollIssues, wpsAmounts, buildSif, corporateTax, CT };
