// Printable documents with letterhead: HTML (browser print) and PDF (headless Chrome/Edge).
const { page, cover, CSP } = require('../lib/render');
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
    const out = { title: `${isQ ? 'Quotation' : isCN ? 'Credit note' : 'Tax invoice'} ${doc.number}`, filename: doc.number.replace(/[\/]/g, '-'), body, ref: doc.number, date: doc.date, label: 'Authorised signatory / المفوّض بالتوقيع', receiver: isQ ? undefined : 'Received by / المستلم' };
    if (isQ && !(q && q.get && q.get('cover') === '0')) {          // quotations open with the brand cover page
      out.cover = cover(S, ctx.brand, { ref: doc.number, title: `Quotation for ${doc.project_name || 'Works'}`, title_ar: `عرض سعر لـ ${doc.project_name || 'الأعمال'}`,
        rows: [['Project', doc.project_name], ['Submitted to', doc.client_name], ['Scope', (doc.items[0] || {}).description], ['Date', doc.date], ['Validity', `${doc.validity_days} days`]] });
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
