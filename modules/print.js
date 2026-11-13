// Printable documents with letterhead: HTML (browser print) and PDF (headless Chrome/Edge).
const { page, cover, bi, money, CSP, esc } = require('../lib/render');
const { htmlToPdf } = require('../lib/pdf');

module.exports = ctx => {
  const { send, bad, getSettings, enrich, docHtml } = ctx;
  ctx.renderers = ctx.renderers || {};                       // kind -> (id, me) => { title, body, filename, ...signOpts }
  ctx.pdf = htmlToPdf;

  const docRenderer = kind => (id, me, q) => {
    const e = enrich(), doc = (kind === 'invoices' ? e.invoices : e.quotes).find(x => x.id === id);
    if (!doc) { const err = new Error('not found'); err.status = 404; throw err; }
    if (doc.voided) bad('Voided documents cannot be printed');
    const S = getSettings(), isCN = doc.kind === 'credit_note', isQ = kind === 'quotes';
    const body = docHtml({ kind, doc: { ...doc, client_trn: e.parties[doc.client_id]?.trn, client_address: e.parties[doc.client_id]?.address }, settings: S, bare: true, mode: 'print' });
    const accepted = isQ && doc.accepted_at ? `<div style="margin-top:6mm;padding:3mm;border:.5pt solid #2e7d4f;font-size:9pt"><b>${bi(S, 'Accepted online by the client', 'قبول العميل إلكترونياً')}:</b> ${esc(doc.accepted_by)} — ${esc(doc.accepted_at)}${/^data:image\/png;base64,/.test(doc.signature || '') ? `<br><img src="${doc.signature}" style="height:22mm" alt="signature">` : ''}</div>` : '';
    const out = { title: `${isQ ? 'Quotation' : isCN ? 'Credit note' : 'Tax invoice'} ${doc.number}`, filename: doc.number.replace(/[\/]/g, '-'), body: body + accepted, ref: doc.number, date: doc.date, label: bi(S, 'Authorised signatory', 'المفوّض بالتوقيع'), ...(isQ ? {} : { stamp: false, signature: false, legal: true })   /* invoices and credit notes: no signature lines */ };
    if (isQ && !(q && q.get && q.get('cover') === '0')) {          // quotations open with the brand cover page
      const cur = S.currency || 'AED', u = me && me.id ? ctx.db.prepare('SELECT username,display_name,job_title,mobile FROM users WHERE id=?').get(me.id) : null;   // signed by the person who issues it (profile)
      out.cover = cover(S, ctx.brand, { ref: doc.number, date: doc.date, to: doc.client_name, subtitle: doc.project_name, title_ar: S.print_arabic === '1' ? 'عرض سعر' : '',
        attention: doc.attention, rows: [['Project', doc.project_name], ['Location', doc.location], ['Plot No.', doc.plot_no], ['NOC Reference', doc.noc_ref], ['Scope of Work', doc.scope || (doc.items[0] || {}).description], ['Contract Basis', doc.contract_basis], ['Validity', `${doc.validity_days} days from date of issue`]],
        payment: String(doc.payment_terms || '').split(/\r?\n/).map(l => /^\s*([^\s:|–—-]+)\s*[:|–—-]\s*(.+)$/.exec(l)).filter(Boolean).map(m => [m[1], m[2].trim()]).slice(0, 6),   // one stage per line: "25% - Upon signing of the agreement"
        totals: doc.vat_pct > 0 ? [[`TOTAL AMOUNT (Excl. VAT ${doc.vat_pct}%)`, `${cur} ${money(doc.subtotal)}`], [`TOTAL INCLUSIVE OF VAT ${doc.vat_pct}%`, `${cur} ${money(doc.total)}`]] : [['TOTAL AMOUNT', `${cur} ${money(doc.total)}`]],
        intro: 'We are pleased to submit our quotation for the above-mentioned works. The detailed Bill of Quantities is attached herewith. We trust our offer meets your requirements and remain at your disposal for any clarification.',
        signer: u ? { name: u.display_name || u.username, title: u.job_title, contact: [u.mobile, S.email].filter(Boolean).join(' · ') } : {} });
      out.stamp = false; out.signature = false;                    // signed and stamped once, on the cover
    }
    if (isQ) {
      out.ref = out.date = undefined;                               // the bill of quantities carries its own reference line
      out.trn = false;                                              // a quotation is not a tax document: the letterhead as designed, without the TRN line
    }
    return out;
  };
  ctx.renderers.invoices = docRenderer('invoices');
  ctx.renderers.quotes = docRenderer('quotes');

  ctx.renderPage = (kind, id, me, autoprint = false, q) => {
    const r = ctx.renderers[kind]; if (!r) { const e = new Error('not found'); e.status = 404; throw e; }
    const out = r(id, me, q);
    return { html: page({ S: getSettings(), brand: ctx.brand, autoprint, ...out }), filename: out.filename || kind };
  };

  return {
    async handle(req, res, url, [a, kind, id, c], me) {
      if (a !== 'doc' || req.method !== 'GET') return false;
      const { html, filename } = ctx.renderPage(kind, +id, me, url.searchParams.get('print') === '1', url.searchParams);
      if (c === 'pdf') {
        let pdf; try { pdf = await ctx.pdf(html); } catch (e) { return send(res, 503, { error: e.message }), true; }
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${String(filename).replace(/[^\w.-]/g, '_')}.pdf"` });
        return res.end(pdf), true;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP });
      return res.end(html), true;
    },
  };
};
