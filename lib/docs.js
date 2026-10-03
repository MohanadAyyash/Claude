// Server-side HTML for emailing quotations / invoices / reminders.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => (+n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function docHtml({ kind, doc, settings: S, message, reminder }) {
  const isQ = kind === 'quotes', isCN = doc.kind === 'credit_note', sg = isCN ? -1 : 1, cur = S.currency || 'AED';
  const title = isQ ? 'Quotation / عرض سعر' : isCN ? 'Tax Credit Note / إشعار دائن ضريبي' : 'Tax Invoice / فاتورة ضريبية';
  const rows = doc.items.map((i, n) => `<tr><td>${n + 1}</td><td>${esc(i.description)}</td><td>${esc(i.unit)}</td><td align="right">${money(i.qty)}</td><td align="right">${money(i.rate)}</td>${isQ ? '' : `<td>${i.vat === 'zero' ? '0%' : i.vat === 'exempt' ? 'Exempt' : doc.vat_pct + '%'}</td>`}<td align="right">${money(sg * i.qty * i.rate)}</td></tr>`).join('');
  const td = 'style="border:1px solid #999;padding:5px 7px"';
  return `<div style="font-family:Arial,sans-serif;font-size:13px;color:#000;max-width:760px">
  ${message ? `<p>${esc(message).replace(/\n/g, '<br>')}</p>` : ''}
  ${reminder ? `<p style="color:#a02a2a"><b>Payment reminder / تذكير بالسداد:</b> invoice ${esc(doc.number)} was due on ${esc(doc.due_date)}. Outstanding: <b>${cur} ${money(doc.balance)}</b>.</p>` : ''}
  <h2 style="margin:0">${esc(S.company_name)}</h2><div>${esc(S.address)} ${esc(S.phone)}</div>${S.trn ? `<div>TRN: ${esc(S.trn)}</div>` : ''}
  <h3>${title} — ${esc(doc.number)}</h3><div>Date: ${esc(doc.date)}${doc.due_date ? ` &nbsp; Due: ${esc(doc.due_date)}` : ''}</div>
  <div>Client: ${esc(doc.client_name)} ${doc.client_trn ? `(TRN ${esc(doc.client_trn)})` : ''}<br>Project: ${esc(doc.project_name)}</div><br>
  <table cellspacing="0" style="border-collapse:collapse;width:100%"><thead><tr style="background:#eee"><th ${td}>#</th><th ${td}>Description</th><th ${td}>Unit</th><th ${td}>Qty</th><th ${td}>Unit price</th>${isQ ? '' : `<th ${td}>VAT</th>`}<th ${td}>Amount</th></tr></thead>
  <tbody>${rows.replace(/<td/g, `<td ${td}`)}</tbody></table>
  <p align="right">Total excl. VAT: ${cur} ${money(doc.subtotal)}<br>VAT ${doc.vat_pct}%: ${cur} ${money(doc.vat)}<br><b>Total: ${cur} ${money(doc.total)}</b></p>
  ${!isQ && !isCN && S.bank_details ? `<p><b>Bank details:</b><br>${esc(S.bank_details).replace(/\n/g, '<br>')}${S.employer_iban ? `<br>IBAN: ${esc(S.employer_iban)}` : ''}</p>` : ''}
  ${isQ && doc.terms ? `<p><b>Terms:</b><br>${esc(doc.terms).replace(/\n/g, '<br>')}</p>` : ''}</div>`;
}
const toText = html => html.replace(/<br\s*\/?>/g, '\n').replace(/<\/(p|tr|div|h\d)>/g, '\n').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/[ \t]+/g, ' ').replace(/\n\s+/g, '\n').trim();
module.exports = { docHtml, toText };
