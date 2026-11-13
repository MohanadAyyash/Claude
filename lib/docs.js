// Server-side HTML for quotations / invoices: `mode:'print'` (class based, used inside the letterhead pages) and `mode:'email'` (inline styles).
const { esc, money, bi, longDate, BLUE, STONE, GREY } = require('./render');
const ES = {                                                                  // e-mail clients need inline styles
  t: `font:700 18px Arial,sans-serif;color:${BLUE};margin:14px 0 8px`, kv: 'width:100%;border-collapse:collapse;font:13px Arial,sans-serif;color:' + BLUE, key: `padding:5px 6px;border-bottom:1px solid ${STONE};color:${GREY};width:30%`, val: `padding:5px 6px;border-bottom:1px solid ${STONE}`,
  table: 'width:100%;border-collapse:collapse;font:13px Arial,sans-serif;color:' + BLUE, th: `padding:6px;border-bottom:2px solid ${BLUE};color:${GREY};font-size:11px;text-transform:uppercase;text-align:left`, td: `padding:6px;border-bottom:1px solid ${STONE};vertical-align:top`,
  n: `padding:6px;border-bottom:1px solid ${STONE};text-align:right;white-space:nowrap;font-family:Consolas,monospace`, thn: `padding:6px;border-bottom:2px solid ${BLUE};color:${GREY};font-size:11px;text-transform:uppercase;text-align:right`,
  tot: 'width:260px;margin-left:auto;margin-top:10px;font:13px Arial,sans-serif;color:' + BLUE, box: `border-top:1px solid ${STONE};margin-top:12px;padding-top:6px;font:12px Arial,sans-serif;color:${BLUE}`,
};

// Quotation printed as a bill of quantities: items grouped by section (A1, A2 … with a sub-total each; plain 1, 2 … when no section is used),
// the grand total, and the provisional items (P1 …) in their own table, outside the total. `doc.subtotal / vat / total` already exclude them.
const lines = t => String(t || '').split(/\r?\n/).map(x => x.replace(/^\s*(\d+[.)]|[-•*])\s*/, '').trim()).filter(Boolean);
function boqHtml(doc, S) {
  const cur = S.currency || 'AED', amt = i => (+i.qty || 0) * (+i.rate || 0), up = x => esc(String(x || '').toUpperCase());
  const main = doc.items.filter(i => !i.provisional), prov = doc.items.filter(i => i.provisional);
  const secs = []; for (const i of main) { const n = String(i.section || '').trim(); let g = secs.find(x => x.name === n); if (!g) secs.push(g = { name: n, items: [] }); g.items.push(i); }
  const sectioned = secs.some(g => g.name), letter = n => (n >= 26 ? String.fromCharCode(64 + Math.floor(n / 26)) : '') + String.fromCharCode(65 + n % 26);
  const tr = (ref, i) => `<tr><td>${ref}</td><td>${esc(i.description)}</td><td class="c">${esc(i.unit || '')}</td><td class="n">${money(i.qty)}</td><td class="n">${money(i.rate)}</td><td class="n">${money(amt(i))}</td></tr>`;
  const sum = a => a.reduce((x, i) => x + amt(i), 0);
  const body = sectioned ? secs.map((g, k) => `<tr class="sec"><td colspan="6">${up(g.name || 'General items')}</td></tr>${g.items.map((i, n) => tr(letter(k) + (n + 1), i)).join('')}<tr class="sub"><td colspan="5">SUB-TOTAL — ${up(g.name || 'General items')}</td><td class="n">${money(sum(g.items))}</td></tr>`).join('')
    : main.map((i, n) => tr(n + 1, i)).join('');
  const cols = '<colgroup><col class="r"><col><col class="u"><col class="q"><col class="p"><col class="a"></colgroup>';
  const vat = +doc.vat_pct > 0, head = cols + '<thead><tr><th>Ref.</th><th>Description of Works</th><th class="c">Unit</th><th class="n">Qty</th><th class="n">Rate (' + esc(cur) + ')</th><th class="n">Amount (' + esc(cur) + ')</th></tr></thead>';
  const totals = vat ? `<tr class="gt"><td colspan="5">GRAND TOTAL (Excl. VAT ${doc.vat_pct}%)</td><td class="n">${money(doc.subtotal)}</td></tr><tr class="sub"><td colspan="5">VAT ${doc.vat_pct}% (added at invoice stage)</td><td class="n">${money(doc.vat)}</td></tr><tr class="gt"><td colspan="5">TOTAL INCLUSIVE OF VAT ${doc.vat_pct}%</td><td class="n">${money(doc.total)}</td></tr>`
    : `<tr class="gt"><td colspan="5">GRAND TOTAL</td><td class="n">${money(doc.total)}</td></tr>`;
  const provHtml = prov.length ? `<table class="boq pv">${cols}<tbody><tr class="sec"><td colspan="6">PROVISIONAL ITEMS — Payable only if executed / instructed (NOT included in Grand Total)</td></tr>${prov.map((i, n) => tr('P' + (n + 1), i)).join('')}<tr class="sub"><td colspan="5">TOTAL PROVISIONAL (if all executed)</td><td class="n">${money(sum(prov))}</td></tr></tbody></table>` : '';
  const notes = [...lines(doc.terms), ...lines(doc.notes)];
  const l1 = [doc.client_name && 'Client: ' + doc.client_name, doc.project_name, doc.location, doc.plot_no && 'Plot ' + doc.plot_no].filter(Boolean).map(esc).join(' | ');
  const l2 = ['Ref: ' + (doc.number || ''), 'Date: ' + longDate(doc.date), 'Currency: ' + cur, 'Valid: ' + doc.validity_days + ' Days', vat ? `Prices Exclude VAT ${doc.vat_pct}%` : ''].filter(Boolean).map(esc).join(' | ');
  return `<div><h2 class="t bq">BILL OF QUANTITIES${doc.project_name ? ' — ' + up(doc.project_name) : ''}</h2><div class="bq-meta"><div>${l1}</div><div>${l2}</div></div>
  <table class="boq">${head}<tbody>${body}${totals}</tbody></table>${provHtml}
  ${notes.length ? `<div class="bq-rem"><h4>NOTES</h4><ol>${notes.map(n => `<li>${esc(n)}</li>`).join('')}</ol></div>` : ''}</div>`;
}
function docHtml({ kind, doc, settings: S, message, reminder, bare, mode = 'email' }) {
  if (kind === 'quotes' && mode === 'print') return boqHtml(doc, S);
  const em = mode === 'email', A = c => (em ? `style="${ES[c] || ''}"` : `class="${c}"`);
  const isQ = kind === 'quotes', isCN = doc.kind === 'credit_note', sg = isCN ? -1 : 1, cur = S.currency || 'AED';
  const tax = S.vat_registered !== '0';                                                // not VAT-registered: no "tax" in the title
  const title = isQ ? bi(S, 'Quotation', 'عرض سعر') : isCN ? (tax ? bi(S, 'Tax Credit Note', 'إشعار دائن ضريبي') : bi(S, 'Credit Note', 'إشعار دائن')) : tax ? bi(S, 'Tax Invoice', 'فاتورة ضريبية') : bi(S, 'Invoice', 'فاتورة');
  const vatTxt = i => (i.vat === 'zero' ? '0%' : i.vat === 'exempt' ? 'Exempt' : doc.vat_pct + '%');
  const provItems = isQ ? doc.items.filter(i => i.provisional) : [];
  const rows = doc.items.filter(i => !isQ || !i.provisional).map((i, n) => `<tr><td ${A('td')}>${n + 1}</td><td ${A('td')}>${esc(i.description)}</td><td ${A('td')}>${esc(i.unit)}</td><td ${A(em ? 'n' : 'n')}>${money(i.qty)}</td><td ${A('n')}>${money(i.rate)}</td>${isQ ? '' : `<td ${A('td')}>${vatTxt(i)}</td>`}<td ${A('n')}>${money(sg * i.qty * i.rate)}</td></tr>`).join('');
  const th = (t, right) => `<th ${em ? `style="${right ? ES.thn : ES.th}"` : `class="${right ? 'n' : ''}"`}>${t}</th>`;
  const kv = (k, v) => v ? `<tr><td ${em ? `style="${ES.key}"` : ''}>${k}</td><td ${em ? `style="${ES.val}"` : ''}><b>${v}</b></td></tr>` : '';
  const client = `${esc(doc.client_name)}${doc.client_trn ? ` · TRN ${esc(doc.client_trn)}` : ''}${doc.client_address ? `<br><span ${em ? '' : 'class="muted"'}>${esc(doc.client_address)}</span>` : ''}`;
  const totalsHtml = `<div ${A('tot')}>${[['Total excl. VAT', `${cur} ${money(doc.subtotal)}`], [`VAT ${doc.vat_pct}%`, `${cur} ${money(doc.vat)}`]].map(([a, b]) => `<div ${em ? `style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid ${STONE}"` : ''}><span>${a}</span><span>${b}</span></div>`).join('')}
   <div ${em ? `style="display:flex;justify-content:space-between;padding:6px 0;border-top:2px solid ${BLUE};font-weight:700"` : 'class="t"'}><span>Total incl. VAT</span><span>${cur} ${money(doc.total)}</span></div>
   ${!isQ && !isCN && doc.retention ? `<div ${em ? 'style="display:flex;justify-content:space-between;padding:3px 0"' : ''}><span>Retention${doc.retention_amount != null ? '' : ' ' + doc.retention_pct + '%'}</span><span>- ${money(doc.retention)}</span></div><div ${em ? `style="display:flex;justify-content:space-between;font-weight:700"` : 'class="t"'}><span>Due now</span><span>${cur} ${money(doc.due_now)}</span></div>` : ''}</div>`;
  const bankHtml = !isQ && !isCN && S.bank_details ? `<b>Bank details</b><br>${esc(S.bank_details).replace(/\n/g, '<br>')}${S.employer_iban && !String(S.bank_details || '').replace(/\s/g, '').includes(String(S.employer_iban).replace(/\s/g, '')) ? `<br>IBAN: ${esc(S.employer_iban)}` : ''}` : '';
  const row = (k, v) => v ? `<tr><td>${k}</td><td>${v}</td></tr>` : '';
  const info = `<div class="info"><div><h4>${isQ ? 'Prepared for' : 'Bill to'}</h4><div class="nm">${esc(doc.client_name || '')}</div>${doc.client_trn && !isQ ? `<div>TRN ${esc(doc.client_trn)}</div>` : ''}${doc.client_address ? `<div class="muted">${esc(doc.client_address)}</div>` : ''}</div>
    <div><h4>${isQ ? 'Quotation details' : isCN ? 'Credit note details' : 'Invoice details'}</h4><table><tbody>${row(isQ ? 'Quotation no.' : isCN ? 'Credit note no.' : 'Invoice no.', `<b class="mono">${esc(doc.number)}</b>`)}${row('Date', esc(doc.date))}${isQ ? row('Valid for', `${doc.validity_days} days`) : row('Due date', esc(doc.due_date || ''))}
    ${row('Project', esc(doc.project_name || ''))}${isQ ? '' : row('Main contract', esc(doc.main_contract || '')) + row('Contract no.', esc(doc.contract_ref || '')) + row('Your ref.', esc(doc.client_ref || ''))}</tbody></table></div></div>`;
  return `<div ${em ? 'style="font:13px Arial,sans-serif;color:' + BLUE + ';max-width:760px"' : ''}>
  ${message ? `<p>${esc(message).replace(/\n/g, '<br>')}</p>` : ''}
  ${reminder ? `<p style="color:#a02a2a"><b>${bi(S, 'Payment reminder', 'تذكير بالسداد')}:</b> invoice ${esc(doc.number)} was due on ${esc(doc.due_date)}. Outstanding: <b>${cur} ${money(doc.balance)}</b>.</p>` : ''}
  ${em && !bare ? `<div style="font:700 16px Arial;color:${BLUE}">${esc(S.company_name)}</div><div style="color:${GREY};font-size:12px">${esc(S.address || '')} ${esc(S.phone || '')}${S.trn ? ` · TRN ${esc(S.trn)}` : ''}</div>` : ''}
  <h2 ${A('t')}>${title}</h2>
  ${em ? `  <table ${em ? `style="${ES.kv}"` : 'class="kv"'}><tbody>${kv('Number', `<span ${em ? '' : 'class="mono"'}>${esc(doc.number)}</span>`)}${kv('Date', esc(doc.date))}${kv(isQ ? 'Valid for' : 'Due', isQ ? `${doc.validity_days} days` : esc(doc.due_date || ''))}${kv('Client', client)}${kv('Project', esc(isQ ? doc.project_name : doc.project_name))}${isQ ? '' : kv('Main contract', esc(doc.main_contract || '')) + kv('Contract / sub-contract no.', esc(doc.contract_ref || '')) + kv('Your reference', esc(doc.client_ref || ''))}</tbody></table><br>` : info}
  <table ${A('table')}><thead><tr>${th('#')}${th('Description')}${th('Unit')}${th('Qty', 1)}${th('Unit price', 1)}${isQ ? '' : th('VAT')}${th('Amount (' + cur + ')', 1)}</tr></thead><tbody>${rows}</tbody></table>
  ${em ? totalsHtml + (bankHtml ? `<div ${A('box')}>${bankHtml}</div>` : '') : `<div class="tb"><div class="bank">${bankHtml}</div>${totalsHtml}</div>`}
  ${doc.notes && !(doc.pc_id && /^Against Payment Certificate/.test(doc.notes)) ? `<div ${A('box')}><b>Notes</b><br>${esc(doc.notes).replace(/\n/g, '<br>')}</div>` : ''}
  ${provItems.length ? `<div ${A('box')}><b>Provisional items — payable only if executed / instructed (not included in the total)</b><br>${provItems.map(i => `${esc(i.description)} — ${esc(i.unit || '')} ${money(i.qty)} × ${money(i.rate)} = ${cur} ${money(i.qty * i.rate)}`).join('<br>')}</div>` : ''}
  ${isQ && doc.terms ? `<div ${A('box')}><b>Terms</b><br>${esc(doc.terms).replace(/\n/g, '<br>')}</div>` : ''}
</div>`;
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
