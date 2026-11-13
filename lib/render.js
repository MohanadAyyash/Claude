// Print-ready A4 pages following the Trigon letterheads (A4 print masters, Letterhead A "Standard English" and B "Official Bilingual"):
//   paper white A4 · margins 17 mm sides / 15 mm top / 9 mm bottom · Steel Blue text · one Stone hairline under the header and above the footer
//   A: logo 60 mm left, phone / e-mail / website stacked right; footer = legal name · address · P.O. Box | Lic.
//   B: English logo left, Arabic wordmark right, legal name + licence under each; footer = contact line, then the address in both languages
//   the mark (three bars) as a pale watermark in the middle of every page · Archivo / IBM Plex Sans Arabic / IBM Plex Mono (Arial fallback)
const crypto = require('node:crypto');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => (+n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nl2br = s => esc(s).replace(/\n/g, '<br>');
const BLUE = '#1F3A5F', STONE = '#D6D2C8', GREY = '#8A8578', PAPER = '#F2F1EE', WM = '#F4F5F7';

const FONTS = '<link rel="stylesheet" href="/fonts/fonts.css">';             // pdf.js inlines these when rendering to PDF
const CSS = `
@page{size:A4;margin:15mm 17mm 9mm}
*{box-sizing:border-box}
body{margin:0;font-family:"Archivo","IBM Plex Sans Arabic",Arial,sans-serif;font-size:10pt;color:${BLUE};line-height:1.5}
.mono,.n,.ref{font-family:"IBM Plex Mono",Consolas,"Courier New",monospace}
.lh{display:flex;justify-content:space-between;align-items:flex-start;gap:12mm;padding-top:1.5mm}
.lh img.logo{width:60mm;display:block}.lh img.logo-ar{height:11mm;display:block}.lh .name{font-size:15pt;font-weight:800}
.lh .contact{text-align:end;font-size:8.5pt;line-height:13pt;white-space:nowrap;margin-top:-.8mm}.lh .lgt{font-weight:600}
.hr{border-top:.5pt solid ${STONE};margin:8.5mm 0 5mm}.legal+.hr{margin-top:6mm}
.wm{position:fixed;z-index:-1;top:96mm;left:37.4mm;width:103mm;-webkit-print-color-adjust:exact;print-color-adjust:exact}.wm i{display:block;height:17mm;background:${WM};margin-bottom:13mm}.wm i:nth-child(1){width:45.8%}.wm i:nth-child(2){width:72.8%}.wm i:nth-child(3){margin-bottom:0}
.rules{margin:5mm 0 3mm}.rules i{display:block;border-top:.5pt solid ${BLUE};margin-bottom:1.1mm}.rules i:nth-child(1){width:30%}.rules i:nth-child(2){width:60%}.rules i:nth-child(3){width:100%;margin-bottom:0}
.legal{display:flex;justify-content:space-between;font-size:7pt;font-weight:600;margin-top:3mm}
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
.pg{width:100%;border-collapse:collapse;font-size:inherit}.pg>thead>tr>td,.pg>tbody>tr>td,.pg>tfoot>tr>td{padding:0;border:0}.fsp{height:10mm}.fsp.o{height:17mm}
tr,.sign,.tot{page-break-inside:avoid}.pg>tbody>tr{page-break-inside:auto}
.tb{display:flex;justify-content:space-between;align-items:flex-start;gap:8mm;margin-top:3mm;page-break-inside:avoid}.tb .bank{flex:1;font-size:8.5pt;line-height:1.55;padding-top:1mm}.tb .tot{margin-top:0;flex:none}
.info{display:flex;gap:6mm;margin:0 0 4mm;font-size:8.5pt;line-height:1.45}.info>div{flex:1;border-top:1pt solid ${BLUE};padding-top:1.5mm}
.info h4{margin:0 0 1mm;font-size:7pt;letter-spacing:.6px;text-transform:uppercase;color:${GREY};font-weight:600}.info .nm{font-size:10pt;font-weight:700}
.info table{font-size:8.5pt}.info td{padding:.6mm 0;border:0}.info td:first-child{color:${GREY};width:38%;padding-inline-end:2mm}
.foot{position:fixed;bottom:0;left:0;right:0;font-size:7.5pt;border-top:.5pt solid ${STONE};padding-top:3.2mm;background:#fff}
.foot .row{display:flex;justify-content:space-between;gap:8mm;font-size:7pt}.foot .row div:last-child{white-space:nowrap}.foot .mid{text-align:center;margin-bottom:.8mm}.foot .mid s{text-decoration:none;color:${GREY};margin:0 4mm}
.letter p{margin:3.5mm 0;font-size:10.5pt}.ar-p{direction:rtl;text-align:right}
.pg.cv{page-break-after:always}
.cv-ref{display:flex;justify-content:space-between;font-size:8pt;margin:0 0 4mm}.cv-ref b{font-weight:500}
.cv-ref span,.cv-to td:first-child,.cv-sign .fb{font-size:6.5pt;font-weight:600;letter-spacing:1.2px;color:${GREY};text-transform:uppercase}.cv-ref span{margin-inline-end:2mm}
.cv-to{width:auto;font-size:9.5pt}.cv-to td{border:0;padding:1mm 0}.cv-to td:first-child{width:26mm}.cv-to .nm{font-size:11pt;font-weight:700}
.cv-band{border-top:1.5pt solid ${BLUE};background:${PAPER};text-align:center;padding:4mm 4mm 3.5mm;margin-top:3mm;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.cv-band h1{font-size:19pt;font-weight:800;letter-spacing:4px;margin:0;line-height:1.2}.cv-band .sub{font-size:8.5pt;font-weight:600;letter-spacing:2px;text-transform:uppercase;margin-top:2mm}
.cv-kv{margin-top:4mm;font-size:9pt}.cv-kv td{border:.5pt solid ${STONE};padding:1.6mm 3mm}.cv-kv td:first-child{font-weight:700;width:23%}
.cv-tot{margin-top:4mm;border:1pt solid ${BLUE};page-break-inside:avoid;-webkit-print-color-adjust:exact;print-color-adjust:exact}.cv-tot div{display:flex;align-items:center}
.cv-tot span{flex:0 0 55%;padding:3mm 4mm;font-size:8.5pt;font-weight:700;letter-spacing:.4px}.cv-tot b{flex:1;text-align:center;padding:3mm;font-size:11pt;font-weight:500;border-inline-start:1pt solid ${BLUE}}
.cv-tot .inc{background:${BLUE};color:#fff}.cv-tot .inc b{border-color:${BLUE}}
.cv-payh{font-size:6.5pt;font-weight:600;letter-spacing:1.2px;color:${GREY};text-transform:uppercase;margin:4mm 0 1.5mm}
.cv-pay{display:flex;border:.5pt solid ${STONE};page-break-inside:avoid}.cv-pay div{flex:1;padding:2mm 3mm;border-inline-start:.5pt solid ${STONE}}.cv-pay div:first-child{border:0}.cv-pay b{display:block;font-size:10.5pt;font-weight:500;font-family:"IBM Plex Mono",Consolas,monospace}.cv-pay span{font-size:8pt;line-height:1.35;display:block}
h2.t.bq{font-size:13pt;font-weight:800;letter-spacing:.6px;margin:0 0 2mm}.bq-meta{font-size:7.5pt;line-height:1.6;margin-bottom:3mm}
.boq{font-size:8pt;table-layout:fixed;border:.5pt solid ${STONE};-webkit-print-color-adjust:exact;print-color-adjust:exact}.boq.pv{margin-top:5mm}
.boq col.r{width:11mm}.boq col.u{width:14mm}.boq col.q{width:19mm}.boq col.p{width:24mm}.boq col.a{width:27mm}
.boq th{background:${BLUE};color:#fff;border:0;font-family:inherit;font-size:7.5pt;font-weight:600;text-transform:none;letter-spacing:0;padding:2mm 2.5mm;text-align:center}.boq th.n{text-align:end}
.boq td{border:.5pt solid ${STONE};padding:1.6mm 2.5mm;vertical-align:middle}.boq td:first-child{text-align:center}.boq td.c{text-align:center;white-space:nowrap}.boq td.n{font-family:"IBM Plex Mono",Consolas,monospace;font-size:7.5pt}
.boq tr.sec td{background:${PAPER};font-weight:700;letter-spacing:.4px;text-align:start}.boq tr.sub td{font-weight:700;text-align:end}.boq tr.gt td{background:${BLUE};color:#fff;font-weight:700;text-align:end;border-color:${BLUE}}
.bq-rem{margin-top:5mm;page-break-inside:avoid}.bq-rem h4{font-size:7.5pt;letter-spacing:1px;margin:0 0 1.5mm}.bq-rem ol{margin:0;padding-inline-start:5mm;font-size:7.5pt;line-height:1.55}
.cv-intro{font-size:9.5pt;text-align:justify;margin:4mm 0 0}
.cv-sign{margin-top:5mm;position:relative;width:110mm;page-break-inside:avoid}.cv-sign .lg{font-size:9.5pt;font-weight:700}.cv-sign .seal{position:relative;height:13mm}
.cv-sign .seal img{position:absolute;object-fit:contain}.cv-sign .seal .st{height:32mm;left:56mm;top:-9mm}.cv-sign .seal .sg{height:15mm;left:4mm;top:-1mm}
.cv-sign .ln{border-top:.5pt solid ${BLUE};width:56mm;padding-top:1.5mm;font-size:9.5pt}.cv-sign .ln b{display:block}.cv-sign .ct{font-size:7pt;margin-top:.5mm}
@media screen{body{max-width:210mm;margin:10px auto;padding:0 17mm 60px;background:#fff}.wm{display:none}}
`;

// Printed documents are English only; the company can turn the Arabic half of the labels on (settings: print_arabic).
const bi = (S, en, ar) => (S && S.print_arabic === '1' ? `${en} / ${ar}` : en);
const bits = a => a.filter(Boolean).map(esc).join(' <s>|</s> ');
const WATERMARK = '<div class="wm"><i></i><i></i><i></i></div>';

// tax documents (taxDoc): the TRN stands out under the contact lines; the legal name is in the footer of every page
function header(S, brand, style, ref, date, trn = true, taxDoc = false) {
  const logo = brand('logo'), logoAr = brand('logo_ar'), legal = esc((S.company_name || '').toUpperCase());
  const refline = (ref || date) ? `<div class="refline"><div>${ref ? `Ref: <b>${esc(ref)}</b>` : ''}</div><div>${date ? `Date: <b>${esc(date)}</b>` : ''}</div></div>` : '';
  const left = logo ? `<img class="logo" src="${logo}" alt="${esc(S.company_name)}">` : `<div class="name">${esc(S.company_name || '')}</div>`;
  if (style === 'official') {
    const right = logoAr ? `<img class="logo-ar" src="${logoAr}" alt="">` : (S.company_name_ar ? `<div class="name" dir="rtl">${esc(S.company_name_ar)}</div>` : '');
    return { top: `<div class="lh">${left}${right}</div><div class="legal"><div>${legal}${S.license_no ? ` · Licence ${esc(S.license_no)}` : ''}</div><div dir="rtl">${esc(S.company_name_ar || '')}${S.license_no ? ` · رخصة رقم ${esc(S.license_no)}` : ''}</div></div><div class="hr"></div>`, refline };
  }
  const lines = [S.phone, S.email, S.website].filter(Boolean).map(x => `<div>${esc(x)}</div>`).join('');
  return { top: `<div class="lh">${left}<div class="contact">${lines}${trn && S.trn ? `<div${taxDoc ? ' class="lgt"' : ''}>TRN ${esc(S.trn)}</div>` : ''}</div></div><div class="hr"></div>`, refline };
}
function footer(S, style, useLegal = false) {
  const legal = (useLegal && S.legal_name) || S.company_name || '', lic = S.license_no ? `Lic. ${esc(S.license_no)}` : '';
  if (S.footer_text) return `<div class="foot"><div class="row"><div>${esc(S.footer_text)}</div><div>${lic}</div></div></div>`;
  if (style === 'official') {
    return `<div class="foot"><div class="mid">${bits([S.phone, S.email, S.website, S.po_box && `P.O. Box ${S.po_box}`])}</div><div class="row"><div>${esc(S.address || '')}</div><div dir="rtl">${esc([S.address_ar, S.address_ar && S.po_box && `ص.ب ${S.po_box}`].filter(Boolean).join(' · '))}</div></div></div>`;
  }
  return `<div class="foot"><div class="row"><div>${esc([legal, S.address, S.po_box && `P.O. Box ${S.po_box}`].filter(Boolean).join(' · '))}</div><div>${lic}</div></div></div>`;
}
function signBlock(brand, { stamp = true, signature = true, label = 'Authorised signatory', receiver } = {}) {
  const st = stamp && brand('stamp'), sg = signature && brand('signature');
  return `<div class="sign">${receiver ? `<div class="blk"><div class="seal"></div><div class="line">${esc(receiver)}</div></div>` : '<div></div>'}
    <div class="blk"><div class="seal">${st ? `<img class="st" src="${st}" alt="">` : ''}${sg ? `<img class="sg" src="${sg}" alt="">` : ''}</div><div class="line">${esc(label)}</div></div></div>`;
}
// Cover sheet of a quotation / tender (first page, on the letterhead): REF / DATE, addressee, title band, summary table, totals,
// covering paragraph and the signature "for & on behalf of" the legal name. Everything is optional except the title.
const longDate = d => { const t = /^\d{4}-\d{2}-\d{2}/.test(d || '') ? new Date(d.slice(0, 10) + 'T00:00:00Z') : null; return t && !isNaN(t) ? t.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : (d || ''); };
function cover(S, brand, { ref, date, to, attention, title = 'QUOTATION', subtitle, title_ar, rows = [], totals = [], payment = [], intro, signer = {} }) {
  const st = brand('stamp'), sg = brand('signature'), legal = (S.legal_name || S.company_name || '').toUpperCase();
  return `<section class="cover"><div class="cv-ref"><div>${ref ? `<span>REF</span> <b class="mono">${esc(ref)}</b>` : ''}</div><div>${date ? `<span>DATE</span> <b class="mono">${esc(longDate(date))}</b>` : ''}</div></div>
    <table class="cv-to"><tbody>${to ? `<tr><td>TO</td><td class="nm">${esc(to)}</td></tr>` : ''}${attention ? `<tr><td>ATTENTION</td><td>${esc(attention)}</td></tr>` : ''}</tbody></table>
    <div class="cv-band"><h1>${esc(title)}</h1>${subtitle ? `<div class="sub">${esc(subtitle)}</div>` : ''}${title_ar ? `<div class="sub" dir="rtl">${esc(title_ar)}</div>` : ''}</div>
    <table class="cv-kv"><tbody>${rows.filter(r => r[1]).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</tbody></table>
    ${totals.length ? `<div class="cv-tot">${totals.map(([k, v], i) => `<div${i === totals.length - 1 ? ' class="inc"' : ''}><span>${esc(k)}</span><b class="mono">${esc(v)}</b></div>`).join('')}</div>` : ''}
    ${payment.length ? `<div class="cv-payh">Payment terms</div><div class="cv-pay">${payment.map(([a, b]) => `<div><b>${esc(a)}</b><span>${esc(b)}</span></div>`).join('')}</div>` : ''}
    ${intro ? `<p class="cv-intro">${esc(intro)}</p>` : ''}
    <div class="cv-sign"><div class="fb">FOR &amp; ON BEHALF OF</div><div class="lg">${esc(legal)}</div><div class="seal">${st ? `<img class="st" src="${st}" alt="">` : ''}${sg ? `<img class="sg" src="${sg}" alt="">` : ''}</div>
      <div class="ln">${signer.name ? `<b>${esc(signer.name)}</b>` : ''}${signer.title ? `<div>${esc(signer.title)}</div>` : ''}${signer.contact ? `<div class="ct mono">${esc(signer.contact)}</div>` : ''}</div></div></section>`;
}

const AUTOPRINT = 'window.onload=function(){setTimeout(function(){window.print()},300)}';
// opts: body, title, style ('standard'|'official'), ref, date, cover (html), stamp, signature, label, receiver, autoprint
function page({ S, brand, body, title = 'Document', autoprint = false, style = 'standard', ref, date, cover: coverHtml = '', trn = true, legal = false, after = '', ...sign }) {
  if (sign.label == null) sign.label = bi(S, 'Authorised signatory', 'المفوّض بالتوقيع');
  const noSign = sign.stamp === false && sign.signature === false, h = header(S, brand, style, ref, date, trn, legal), fo = style === 'official' ? ' o' : '';
  // the letterhead repeats at the top of every printed page (thead) and the tfoot keeps room for the fixed footer, so text never runs under either
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>${FONTS}<style>${CSS}</style></head><body>
    ${coverHtml ? `<table class="pg cv"><thead><tr><td>${h.top}</td></tr></thead><tbody><tr><td>${coverHtml}</td></tr></tbody><tfoot><tr><td><div class="fsp${fo}"></div></td></tr></tfoot></table>` : ''}<table class="pg"><thead><tr><td>${h.top}</td></tr></thead><tbody><tr><td>${h.refline}${body}${noSign ? '' : signBlock(brand, sign)}</td></tr></tbody><tfoot><tr><td><div class="fsp${fo}"></div></td></tr></tfoot></table>${(Array.isArray(after) ? after : after ? [after] : []).map(x => `<table class="pg" style="page-break-before:always"><thead><tr><td>${h.top}</td></tr></thead><tbody><tr><td>${x}</td></tr></tbody><tfoot><tr><td><div class="fsp${fo}"></div></td></tr></tfoot></table>`).join('')}${WATERMARK}${footer(S, style, legal)}
    ${autoprint ? `<script>${AUTOPRINT}</script>` : ''}</body></html>`;
}
// the only inline script a printable page may run is the auto-print one (allowed by hash, so injected scripts stay blocked)
const CSP = "default-src 'none'; img-src data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'sha256-" + crypto.createHash('sha256').update(AUTOPRINT).digest('base64') + "'";
module.exports = { page, cover, longDate, bi, esc, money, nl2br, CSS, CSP, BLUE, STONE, GREY, PAPER };
