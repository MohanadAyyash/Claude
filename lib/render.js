// Print-ready A4 pages following the Trigon Brand Guidelines v1.1:
//   paper white A4 · margins 17 mm sides / 15 mm top / 11–14 mm bottom · Steel Blue text · Stone hairlines, no boxes or shaded panels
//   Letterhead A (standard, English) and B (official, bilingual) · three-rule divider · logo 60 mm · Archivo / IBM Plex Sans Arabic / IBM Plex Mono (Arial fallback)
const crypto = require('node:crypto');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => (+n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nl2br = s => esc(s).replace(/\n/g, '<br>');
const BLUE = '#1F3A5F', STONE = '#D6D2C8', GREY = '#8A8578', PAPER = '#F2F1EE';

const FONTS = '<link rel="stylesheet" href="/fonts/fonts.css">';             // pdf.js inlines these when rendering to PDF
const CSS = `
@page{size:A4;margin:15mm 17mm 16mm}
*{box-sizing:border-box}
body{margin:0;font-family:"Archivo","IBM Plex Sans Arabic",Arial,sans-serif;font-size:10pt;color:${BLUE};line-height:1.5}
.mono,.n,.ref{font-family:"IBM Plex Mono",Consolas,"Courier New",monospace}
.lh{display:flex;justify-content:space-between;align-items:flex-start;gap:12mm}
.lh img.logo{width:60mm;display:block}.lh img.logo-ar{height:17mm;display:block}.lh .name{font-size:15pt;font-weight:800}
.lh .contact{text-align:end;font-size:7.5pt;color:${GREY};line-height:1.7}.lh .lgl{font-family:"Archivo",Arial,sans-serif;font-size:10pt;font-weight:700;color:${BLUE};letter-spacing:.3px;margin-bottom:.5mm}.lh .lgt{color:${BLUE};font-weight:600;font-size:8.5pt}
.rules{margin:5mm 0 3mm}.rules i{display:block;border-top:.5pt solid ${BLUE};margin-bottom:1.1mm}.rules i:nth-child(1){width:30%}.rules i:nth-child(2){width:60%}.rules i:nth-child(3){width:100%;margin-bottom:0}
.legal{display:flex;justify-content:space-between;font-size:7pt;color:${GREY};letter-spacing:.2px;margin-bottom:4mm}
.refline{display:flex;justify-content:space-between;font-size:8.5pt;color:${GREY};margin:2mm 0 6mm}.refline b{color:${BLUE};font-weight:500}
h2.t{font-size:15pt;font-weight:700;margin:2mm 0 3mm;text-align:start}
.muted{color:${GREY}}
table{width:100%;border-collapse:collapse;font-size:9.5pt}
th{font-weight:600;text-align:start;border-bottom:1pt solid ${BLUE};padding:2.5mm 2mm 2mm;font-size:7.5pt;text-transform:uppercase;letter-spacing:.5px;color:${GREY};white-space:nowrap}
td{padding:2mm;border-bottom:.5pt solid ${STONE};vertical-align:top}
td.n,th.n{text-align:end;white-space:nowrap}
.box{border-top:.5pt solid ${STONE};border-bottom:.5pt solid ${STONE};padding:3mm 0;margin:3mm 0}
.kv td:first-child{color:${GREY};width:34%}
.tot{width:75mm;margin-inline-start:auto;margin-top:3mm}.tot div{display:flex;justify-content:space-between;padding:1mm 0;border-bottom:.5pt solid ${STONE}}.tot .t{border-top:1pt solid ${BLUE};border-bottom:0;font-weight:700;padding-top:2mm}
.sign{display:flex;justify-content:space-between;align-items:flex-end;margin-top:7mm;page-break-inside:avoid}.sign .blk{width:62mm;text-align:center;font-size:8pt;color:${GREY}}
.sign .line{border-top:.5pt solid ${BLUE};margin-top:2mm;padding-top:1.5mm}.sign .seal{position:relative;height:24mm}
.sign .seal img{position:absolute;object-fit:contain}.sign .seal .st{height:25mm;inset-inline-start:6mm;top:0}.sign .seal .sg{height:17mm;inset-inline-start:24mm;top:5mm}
.pg{width:100%;border-collapse:collapse;font-size:inherit}.pg>thead>tr>td,.pg>tbody>tr>td,.pg>tfoot>tr>td{padding:0;border:0}.pg>thead .rules{margin-bottom:5mm}.fsp{height:11mm}
tr,.sign,.tot{page-break-inside:avoid}.pg>tbody>tr{page-break-inside:auto}
.tb{display:flex;justify-content:space-between;align-items:flex-start;gap:8mm;margin-top:3mm;page-break-inside:avoid}.tb .bank{flex:1;font-size:8.5pt;line-height:1.55;padding-top:1mm}.tb .tot{margin-top:0;flex:none}
.info{display:flex;gap:6mm;margin:0 0 4mm;font-size:8.5pt;line-height:1.45}.info>div{flex:1;border-top:1pt solid ${BLUE};padding-top:1.5mm}
.info h4{margin:0 0 1mm;font-size:7pt;letter-spacing:.6px;text-transform:uppercase;color:${GREY};font-weight:600}.info .nm{font-size:10pt;font-weight:700}
.info table{font-size:8.5pt}.info td{padding:.6mm 0;border:0}.info td:first-child{color:${GREY};width:38%;padding-inline-end:2mm}
.foot{position:fixed;bottom:0;left:0;right:0;font-size:7pt;color:${GREY};border-top:.5pt solid ${STONE};padding-top:1.5mm}
.foot .row{display:flex;justify-content:space-between;gap:8mm;font-size:6.5pt}.foot .row div:last-child{white-space:nowrap}.foot .mid{text-align:center;margin-bottom:.8mm}
.letter p{margin:3.5mm 0;font-size:10.5pt}.ar-p{direction:rtl;text-align:right}
.cover{page-break-after:always;min-height:255mm;position:relative}
.cover .top{background:${PAPER};margin:-15mm -17mm 0;padding:15mm 17mm 12mm;min-height:92mm}
.cover .top img.logo{width:60mm}.cover .ref{font-size:8pt;color:${GREY};margin-top:24mm}.cover h1{font-size:23pt;font-weight:700;margin:2mm 0 1mm;line-height:1.15}.cover .ar{font-size:14pt;color:${GREY};direction:rtl;text-align:right}
.cover .rules{margin:8mm 0 6mm}.cover table td{padding:3mm 2mm}
@media screen{body{max-width:210mm;margin:10px auto;padding:0 17mm 60px;background:#fff}.cover .top{margin:0 -17mm}}
`;

const bits = a => a.filter(Boolean).map(esc).join(' &nbsp;|&nbsp; ');

function header(S, brand, style, ref, date, trn = true, taxDoc = false) {
  const logo = brand('logo'), logoAr = brand('logo_ar'), legal = esc((S.company_name || '').toUpperCase());
  const contact = bits([S.phone, S.email, S.website]);
  const refline = (ref || date) ? `<div class="refline"><div>${ref ? `Ref: <b>${esc(ref)}</b>` : ''}</div><div>${date ? `Date: <b>${esc(date)}</b>` : ''}</div></div>` : '';
  const left = logo ? `<img class="logo" src="${logo}" alt="${esc(S.company_name)}">` : `<div class="name">${esc(S.company_name || '')}</div>`;
  if (style === 'official') {
    const right = logoAr ? `<img class="logo-ar" src="${logoAr}" alt="">` : (S.company_name_ar ? `<div class="name" dir="rtl">${esc(S.company_name_ar)}</div>` : '');
    return { top: `<div class="lh">${left}${right}</div><div class="rules"><i></i><i></i><i></i></div>
      <div class="legal mono"><div>${legal}${S.license_no ? ` · Licence ${esc(S.license_no)}` : ''}</div><div dir="rtl">${esc(S.company_name_ar || '')}${S.license_no ? ` · رخصة رقم ${esc(S.license_no)}` : ''}</div></div>`, refline };
  }
  const lname = taxDoc ? `<div class="lgl">${esc(S.legal_name || S.company_name || '')}</div>` : '';      // tax invoices: the legal name as on the licence / TRN certificate, next to the TRN
  return { top: `<div class="lh">${left}<div class="contact mono">${lname}${(contact ? `<div>${contact}</div>` : '')}${trn && S.trn ? `<div${taxDoc ? ' class="lgt"' : ''}>TRN ${esc(S.trn)}</div>` : ''}</div></div><div class="rules"><i></i><i></i><i></i></div>`, refline };
}
function footer(S, style, useLegal = false) {
  const legal = esc((useLegal && S.legal_name) || S.company_name || ''), addr = esc([S.address, S.po_box && `P.O. Box ${S.po_box}`].filter(Boolean).join(' · '));
  if (S.footer_text) return `<div class="foot mono"><div class="row"><div>${esc(S.footer_text)}</div><div>${S.license_no ? `Lic. ${esc(S.license_no)}` : ''}</div></div></div>`;
  if (style === 'official') {
    return `<div class="foot mono"><div class="mid">${bits([S.phone, S.email, S.website, S.po_box && `P.O. Box ${S.po_box}`])}</div><div class="row"><div>${esc(S.address || '')}</div><div dir="rtl">${esc(S.address_ar || '')}</div></div></div>`;
  }
  return `<div class="foot mono"><div class="row"><div>${legal}${S.address ? ' · ' + esc(S.address) : ''}</div><div>${S.po_box ? `P.O. Box ${esc(S.po_box)}` : ''}${S.license_no ? ` · Lic. ${esc(S.license_no)}` : ''}</div></div></div>`;
}
function signBlock(brand, { stamp = true, signature = true, label = 'Authorised signatory / المفوّض بالتوقيع', receiver } = {}) {
  const st = stamp && brand('stamp'), sg = signature && brand('signature');
  return `<div class="sign">${receiver ? `<div class="blk"><div class="seal"></div><div class="line">${esc(receiver)}</div></div>` : '<div></div>'}
    <div class="blk"><div class="seal">${st ? `<img class="st" src="${st}" alt="">` : ''}${sg ? `<img class="sg" src="${sg}" alt="">` : ''}</div><div class="line">${esc(label)}</div></div></div>`;
}
// Cover page shared by quotations, tenders and reports (Brand Guidelines p.11)
function cover(S, brand, { ref, title, title_ar, rows = [] }) {
  const logo = brand('logo');
  return `<section class="cover"><div class="top">${logo ? `<img class="logo" src="${logo}" alt="">` : `<div class="name">${esc(S.company_name || '')}</div>`}
    <div class="ref mono">${esc(ref || '')}</div><h1>${esc(title)}</h1>${title_ar ? `<div class="ar">${esc(title_ar)}</div>` : ''}</div>
    <div class="rules" style="margin-top:8mm"><i></i><i></i><i></i></div>
    <table class="kv"><tbody>${rows.filter(r => r[1]).map(([k, v]) => `<tr><td>${esc(k)}</td><td><b>${esc(v)}</b></td></tr>`).join('')}</tbody></table></section>`;
}

const AUTOPRINT = 'window.onload=function(){setTimeout(function(){window.print()},300)}';
// opts: body, title, style ('standard'|'official'), ref, date, cover (html), stamp, signature, label, receiver, autoprint
function page({ S, brand, body, title = 'Document', autoprint = false, style = 'standard', ref, date, cover: coverHtml = '', trn = true, legal = false, after = '', ...sign }) {
  const noSign = sign.stamp === false && sign.signature === false, h = header(S, brand, style, ref, date, trn, legal);
  // the letterhead repeats at the top of every printed page (thead) and the tfoot keeps room for the fixed footer, so text never runs under either
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>${FONTS}<style>${CSS}</style></head><body>
    ${coverHtml}<table class="pg"><thead><tr><td>${h.top}</td></tr></thead><tbody><tr><td>${h.refline}${body}${noSign ? '' : signBlock(brand, sign)}</td></tr></tbody><tfoot><tr><td><div class="fsp"></div></td></tr></tfoot></table>${(Array.isArray(after) ? after : after ? [after] : []).map(x => `<table class="pg" style="page-break-before:always"><thead><tr><td>${h.top}</td></tr></thead><tbody><tr><td>${x}</td></tr></tbody><tfoot><tr><td><div class="fsp"></div></td></tr></tfoot></table>`).join('')}${footer(S, style, legal)}
    ${autoprint ? `<script>${AUTOPRINT}</script>` : ''}</body></html>`;
}
// the only inline script a printable page may run is the auto-print one (allowed by hash, so injected scripts stay blocked)
const CSP = "default-src 'none'; img-src data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'sha256-" + crypto.createHash('sha256').update(AUTOPRINT).digest('base64') + "'";
module.exports = { page, cover, esc, money, nl2br, CSS, CSP, BLUE, STONE, GREY, PAPER };
