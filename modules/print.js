// Printable documents with letterhead: HTML (browser print) and PDF (headless Chrome/Edge).
const { page } = require('../lib/render');
const { htmlToPdf } = require('../lib/pdf');

module.exports = ctx => {
  const { send, bad, getSettings, enrich, docHtml } = ctx;
  ctx.renderers = ctx.renderers || {};                       // kind -> (id, me) => { title, body, filename, ...signOpts }
  ctx.pdf = htmlToPdf;

  const docRenderer = kind => id => {
    const e = enrich(), doc = (kind === 'invoices' ? e.invoices : e.quotes).find(x => x.id === id);
    if (!doc) { const err = new Error('not found'); err.status = 404; throw err; }
    if (doc.voided) bad('Voided documents cannot be printed');
    const S = getSettings(), isCN = doc.kind === 'credit_note';
    const body = docHtml({ kind, doc: { ...doc, client_trn: e.parties[doc.client_id]?.trn }, settings: S, bare: true });
    const addr = e.parties[doc.client_id]?.address;
    return { title: `${kind === 'quotes' ? 'Quotation' : isCN ? 'Credit note' : 'Tax invoice'} ${doc.number}`, filename: doc.number, body: (addr ? `<div style="margin-bottom:6px">Client address: ${addr.replace(/</g, '&lt;')}</div>` : '') + body,
      label: 'Authorised signatory / المفوّض بالتوقيع', receiver: kind === 'invoices' ? 'Received by / المستلم' : undefined };
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
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'" });
      return res.end(html), true;
    },
  };
};
