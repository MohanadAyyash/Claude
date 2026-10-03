// Server-side HTML for quotations / invoices: `mode:'print'` (class based, used inside the letterhead pages) and `mode:'email'` (inline styles).
const { esc, money, BLUE, STONE, GREY } = require('./render');
const ES = {                                                                  // e-mail clients need inline styles
  t: `font:700 18px Arial,sans-serif;color:${BLUE};margin:14px 0 8px`, kv: 'width:100%;border-collapse:collapse;font:13px Arial,sans-serif;color:' + BLUE, key: `padding:5px 6px;border-bottom:1px solid ${STONE};color:${GREY};width:30%`, val: `padding:5px 6px;border-bottom:1px solid ${STONE}`,
  table: 'width:100%;border-collapse:collapse;font:13px Arial,sans-serif;color:' + BLUE, th: `padding:6px;border-bottom:2px solid ${BLUE};color:${GREY};font-size:11px;text-transform:uppercase;text-align:left`, td: `padding:6px;border-bottom:1px solid ${STONE};vertical-align:top`,
  n: `padding:6px;border-bottom:1px solid ${STONE};text-align:right;white-space:nowrap;font-family:Consolas,monospace`, thn: `padding:6px;border-bottom:2px solid ${BLUE};color:${GREY};font-size:11px;text-transform:uppercase;text-align:right`,
  tot: 'width:260px;margin-left:auto;margin-top:10px;font:13px Arial,sans-serif;color:' + BLUE, box: `border-top:1px solid ${STONE};margin-top:12px;padding-top:6px;font:12px Arial,sans-serif;color:${BLUE}`,
};

function docHtml({ kind, doc, settings: S, message, reminder, bare, mode = 'email' }) {
  const em = mode === 'email', A = c => (em ? `style="${ES[c] || ''}"` : `class="${c}"`);
  const isQ = kind === 'quotes', isCN = doc.kind === 'credit_note', sg = isCN ? -1 : 1, cur = S.currency || 'AED';
  const title = isQ ? 'Quotation / عرض سعر' : isCN ? 'Tax Credit Note / إشعار دائن ضريبي' : 'Tax Invoice / فاتورة ضريبية';
  const vatTxt = i => (i.vat === 'zero' ? '0%' : i.vat === 'exempt' ? 'Exempt' : doc.vat_pct + '%');
  const rows = doc.items.map((i, n) => `<tr><td ${A('td')}>${n + 1}</td><td ${A('td')}>${esc(i.description)}</td><td ${A('td')}>${esc(i.unit)}</td><td ${A(em ? 'n' : 'n')}>${money(i.qty)}</td><td ${A('n')}>${money(i.rate)}</td>${isQ ? '' : `<td ${A('td')}>${vatTxt(i)}</td>`}<td ${A('n')}>${money(sg * i.qty * i.rate)}</td></tr>`).join('');
  const th = (t, right) => `<th ${em ? `style="${right ? ES.thn : ES.th}"` : `class="${right ? 'n' : ''}"`}>${t}</th>`;
  const kv = (k, v) => v ? `<tr><td ${em ? `style="${ES.key}"` : ''}>${k}</td><td ${em ? `style="${ES.val}"` : ''}><b>${v}</b></td></tr>` : '';
  const client = `${esc(doc.client_name)}${doc.client_trn ? ` · TRN ${esc(doc.client_trn)}` : ''}${doc.client_address ? `<br><span ${em ? '' : 'class="muted"'}>${esc(doc.client_address)}</span>` : ''}`;
  return `<div ${em ? 'style="font:13px Arial,sans-serif;color:' + BLUE + ';max-width:760px"' : ''}>
  ${message ? `<p>${esc(message).replace(/\n/g, '<br>')}</p>` : ''}
  ${reminder ? `<p style="color:#a02a2a"><b>Payment reminder / تذكير بالسداد:</b> invoice ${esc(doc.number)} was due on ${esc(doc.due_date)}. Outstanding: <b>${cur} ${money(doc.balance)}</b>.</p>` : ''}
  ${em && !bare ? `<div style="font:700 16px Arial;color:${BLUE}">${esc(S.company_name)}</div><div style="color:${GREY};font-size:12px">${esc(S.address || '')} ${esc(S.phone || '')}${S.trn ? ` · TRN ${esc(S.trn)}` : ''}</div>` : ''}
  <h2 ${A('t')}>${title}</h2>
  <table ${em ? `style="${ES.kv}"` : 'class="kv"'}><tbody>${kv('Number', `<span ${em ? '' : 'class="mono"'}>${esc(doc.number)}</span>`)}${kv('Date', esc(doc.date))}${kv(isQ ? 'Valid for' : 'Due', isQ ? `${doc.validity_days} days` : esc(doc.due_date || ''))}${kv('Client', client)}${kv('Project', esc(isQ ? doc.project_name : doc.project_name))}</tbody></table><br>
  <table ${A('table')}><thead><tr>${th('#')}${th('Description')}${th('Unit')}${th('Qty', 1)}${th('Unit price', 1)}${isQ ? '' : th('VAT')}${th('Amount (' + cur + ')', 1)}</tr></thead><tbody>${rows}</tbody></table>
  <div ${A('tot')}>${[['Total excl. VAT', `${cur} ${money(doc.subtotal)}`], [`VAT ${doc.vat_pct}%`, `${cur} ${money(doc.vat)}`]].map(([a, b]) => `<div ${em ? `style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid ${STONE}"` : ''}><span>${a}</span><span>${b}</span></div>`).join('')}
   <div ${em ? `style="display:flex;justify-content:space-between;padding:6px 0;border-top:2px solid ${BLUE};font-weight:700"` : 'class="t"'}><span>Total incl. VAT</span><span>${cur} ${money(doc.total)}</span></div>
   ${!isQ && !isCN && doc.retention ? `<div ${em ? 'style="display:flex;justify-content:space-between;padding:3px 0"' : ''}><span>Retention ${doc.retention_pct}%</span><span>- ${money(doc.retention)}</span></div><div ${em ? `style="display:flex;justify-content:space-between;font-weight:700"` : 'class="t"'}><span>Due now</span><span>${cur} ${money(doc.due_now)}</span></div>` : ''}</div>
  ${doc.notes ? `<div ${A('box')}><b>Notes</b><br>${esc(doc.notes).replace(/\n/g, '<br>')}</div>` : ''}
  ${isQ && doc.terms ? `<div ${A('box')}><b>Terms</b><br>${esc(doc.terms).replace(/\n/g, '<br>')}</div>` : ''}
  ${!isQ && !isCN && S.bank_details ? `<div ${A('box')}><b>Bank details</b><br>${esc(S.bank_details).replace(/\n/g, '<br>')}${S.employer_iban ? `<br>IBAN: ${esc(S.employer_iban)}` : ''}</div>` : ''}</div>`;
}
const toText = html => html.replace(/<br\s*\/?>/g, '\n').replace(/<\/(p|tr|div|h\d)>/g, '\n').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n\s+/g, '\n').trim();

// E-mail signature (Brand Guidelines p.11): Arial text + the one-line logo as an inline PNG
function signatureHtml({ S, user, logoCid }) {
  const name = esc(user?.display_name || user?.username || ''), title = esc(user?.job_title || ''), mobile = esc(user?.mobile || '');
  const lines = [mobile && `M: ${mobile}`, S.email && `E: ${esc(S.email)}`, [S.address].filter(Boolean).map(esc).join('')].filter(Boolean).map(l => `<div>${l}</div>`).join('');
  return `<table cellspacing="0" cellpadding="0" style="font:12px Arial,sans-serif;color:${BLUE};margin-top:18px"><tr>
    <td style="padding-right:14px;border-right:2px solid ${BLUE};vertical-align:top"><div style="font:700 15px Arial;color:${BLUE}">${name}</div><div style="color:${GREY}">${title}</div></td>
    <td style="padding-left:14px;vertical-align:top;line-height:1.5">${lines}</td></tr>
    <tr><td colspan="2" style="padding-top:12px"><div style="border-top:1px solid ${STONE};padding-top:10px">${logoCid ? `<img src="cid:${logoCid}" alt="${esc(S.company_name || '')}" height="24" style="vertical-align:middle;height:24px">` : `<b>${esc(S.company_name || '')}</b>`} <span style="color:${GREY};padding-left:10px">Civil Contracting · ${esc((S.website || '').replace(/^https?:\/\//, ''))}</span></div></td></tr></table>`;
}
module.exports = { docHtml, toText, signatureHtml };
