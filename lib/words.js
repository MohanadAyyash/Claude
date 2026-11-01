// Amounts in words for certificates and invoices: "Dirhams Sixteen Thousand Seven Hundred Twelve and Fils 87/100 only"
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
function under1000(n) {
  const h = Math.floor(n / 100), r = n % 100, out = [];
  if (h) out.push(ONES[h] + ' Hundred');
  if (r) out.push(r < 20 ? ONES[r] : TENS[Math.floor(r / 10)] + (r % 10 ? '-' + ONES[r % 10] : ''));
  return out.join(' ');
}
function intWords(n) {
  if (n === 0) return 'Zero';
  const parts = [], scales = [[1e9, 'Billion'], [1e6, 'Million'], [1e3, 'Thousand']];
  for (const [v, w] of scales) if (n >= v) { parts.push(under1000(Math.floor(n / v)) + ' ' + w); n %= v; }
  if (n) parts.push(under1000(n));
  return parts.join(' ');
}
function amountInWords(amount, currency = 'AED') {
  const neg = amount < 0, a = Math.round(Math.abs(+amount || 0) * 100), whole = Math.floor(a / 100), fils = a % 100;
  const cur = currency === 'AED' ? 'Dirhams' : currency;
  return `${neg ? 'Minus ' : ''}${cur} ${intWords(whole)}${fils ? ` and Fils ${String(fils).padStart(2, '0')}/100` : ''} only`;
}
module.exports = { amountInWords, intWords };
