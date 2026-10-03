// Print-ready A4 pages with the company letterhead, stamp and signature.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => (+n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nl2br = s => esc(s).replace(/\n/g, '<br>');

const CSS = `
@page{size:A4;margin:14mm 14mm 18mm}
*{box-sizing:border-box}body{margin:0;font-family:"Segoe UI",Tahoma,Arial,sans-serif;font-size:12px;color:#111;line-height:1.45}
.lh{display:flex;justify-content:space-between;align-items:center;gap:16px;border-bottom:2px solid #111;padding-bottom:10px;margin-bottom:14px}
.lh img.logo{max-height:74px;max-width:190px;object-fit:contain}.lh .names{text-align:end}.lh h1{margin:0;font-size:17px}.lh .ar{font-size:15px;font-weight:700}.lh .meta{font-size:11px;color:#333}
h2.t{font-size:16px;margin:4px 0 10px;text-align:center;text-transform:uppercase;letter-spacing:.3px}
table{width:100%;border-collapse:collapse}th,td{border:1px solid #888;padding:5px 7px;vertical-align:top}th{background:#eee}
td.n,th.n{text-align:end;white-space:nowrap}.box{border:1px solid #888;padding:8px 10px;margin:8px 0}
.tot{width:290px;margin-inline-start:auto;margin-top:8px}.tot div{display:flex;justify-content:space-between;padding:2px 0}.tot .t{border-top:2px solid #111;font-weight:700}
.sign{display:flex;justify-content:space-between;align-items:flex-end;margin-top:40px;page-break-inside:avoid}.sign .blk{width:230px;text-align:center}.sign .line{border-top:1px solid #111;margin-top:6px;padding-top:4px}
.sign .seal{position:relative;height:92px}.sign .seal img{position:absolute;max-height:90px;max-width:120px;object-fit:contain}.sign .seal .st{inset-inline-start:10px;top:0;opacity:.9}.sign .seal .sg{inset-inline-start:60px;top:22px;max-height:60px}
.foot{position:fixed;bottom:0;left:0;right:0;text-align:center;font-size:10px;color:#444;border-top:1px solid #aaa;padding-top:4px}
.letter p{margin:10px 0;font-size:13px}.ar-p{direction:rtl;text-align:right}
@media screen{body{max-width:210mm;margin:10px auto;padding:0 14mm 60px;background:#fff}}
`;

function header(S, brand) {
  const logo = brand('logo');
  const bits = [S.address, S.po_box && `P.O. Box ${S.po_box}`, S.phone, S.email, S.website].filter(Boolean).map(esc).join(' · ');
  return `<div class="lh"><div>${logo ? `<img class="logo" src="${logo}" alt="">` : ''}</div>
    <div class="names"><h1>${esc(S.company_name || '')}</h1>${S.company_name_ar ? `<div class="ar" dir="rtl">${esc(S.company_name_ar)}</div>` : ''}
    <div class="meta">${bits}</div><div class="meta">${S.trn ? `TRN / الرقم الضريبي: ${esc(S.trn)}` : ''}${S.license_no ? ` · Licence No. ${esc(S.license_no)}` : ''}</div></div></div>`;
}
function signBlock(S, brand, { stamp = true, signature = true, label = 'Authorised signatory / المفوّض بالتوقيع', receiver } = {}) {
  const st = stamp && brand('stamp'), sg = signature && brand('signature');
  return `<div class="sign">${receiver ? `<div class="blk"><div class="seal"></div><div class="line">${esc(receiver)}</div></div>` : '<div></div>'}
    <div class="blk"><div class="seal">${st ? `<img class="st" src="${st}" alt="">` : ''}${sg ? `<img class="sg" src="${sg}" alt="">` : ''}</div><div class="line">${esc(label)}</div></div></div>`;
}
// body: inner HTML. opts: {title, stamp, signature, autoprint, label, receiver}
function page({ S, brand, body, title = 'Document', autoprint = false, ...sign }) {
  const foot = S.footer_text || [S.company_name, S.address].filter(Boolean).join(' — ');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body>
    ${header(S, brand)}${body}${sign.stamp === false && sign.signature === false ? '' : signBlock(S, brand, sign)}<div class="foot">${esc(foot)}</div>
    ${autoprint ? '<script>window.onload=function(){setTimeout(function(){window.print()},300)}</script>' : ''}</body></html>`;
}
module.exports = { page, esc, money, nl2br, CSS };
