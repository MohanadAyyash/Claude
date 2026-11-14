// Printable documents with letterhead: HTML (browser print) and PDF (headless Chrome/Edge).
const { page, cover, bi, money, CSP, esc, cleanReportHtml } = require('../lib/render');
const { htmlToPdf } = require('../lib/pdf');
const crypto = require('node:crypto');

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

  // ---- any screen as a PDF on the letterhead (phones: iOS cannot print a page from the home-screen app) ----
  // The browser sends the screen's content; it is cleaned, wrapped in the letterhead and rendered with every network and file access
  // blocked by a CSP inside the page. The PDF is kept for 10 minutes under a random link, so the phone can open it in its PDF viewer
  // (share → print / save / send) even where the viewer does not carry the app's login.
  const READY = new Map(), TTL = 10 * 60e3;
  const clean = cleanReportHtml;
  const LOCK = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:">`;
  const REPORT_CSS = `<style>.rep h1{font-size:15pt;margin:0 0 3mm}.rep h2{font-size:11pt;margin:5mm 0 2mm;break-after:avoid}.rep .muted{color:#8A8578}.rep .pos,.rep .ok{color:#1a7f4b}.rep .neg,.rep .bad{color:#b73a3a}
    .rep .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:3mm;margin:3mm 0}.rep .kpi,.rep .card{border:.5pt solid #D6D2C8;padding:2.5mm;margin-bottom:2mm;break-inside:avoid}.rep .kpi .l{font-size:8pt;color:#8A8578}.rep .kpi .v{font-size:12pt;font-weight:600}
    .rep table{width:100%;border-collapse:collapse;font-size:8.5pt;margin:2mm 0}.rep th{text-align:start;color:#8A8578;font-weight:600;border-bottom:1.2pt solid #1F3A5F;padding:1.5mm}.rep td{border-bottom:.5pt solid #D6D2C8;padding:1.5mm;vertical-align:top}.rep .n{text-align:end;white-space:nowrap}
    .rep tr{break-inside:avoid}.rep .bar .sp{display:none}.rep *{-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .rep .bars{display:flex;gap:4mm;align-items:flex-end;height:40mm}.rep .bars .m{flex:1;text-align:center;font-size:7pt;color:#8A8578}.rep .bars .pair{display:flex;gap:1mm;align-items:flex-end;height:32mm;justify-content:center}.rep .bars .b{width:5mm;min-height:.3mm}.rep .b.in{background:#1a7f4b}.rep .b.out{background:#b73a3a}</style>`;
  const sweep = () => { const t = Date.now(); for (const [k, v] of READY) if (t - v.at > TTL) READY.delete(k); };
  ctx.servePdfToken = (res, token) => {
    sweep(); const r = /^[a-f0-9]{48}$/.test(token || '') && READY.get(token);
    if (!r) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('This PDF link has expired — create it again from the system.'); }
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${r.name}.pdf"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    return res.end(r.pdf);
  };

  return {
    async handle(req, res, url, [a, kind, id, c], me) {
      if (a === 'report-pdf' && req.method === 'POST') {
        const x = await ctx.readBody(req, 4e6), html = clean(x.html), title = String(x.title || 'Report').replace(/[\r\n<>]/g, ' ').slice(0, 120);
        if (!html.trim()) bad('Nothing to print on this page');
        const S = getSettings(), lang = x.lang === 'ar' ? 'ar' : 'en';
        let doc = page({ S, brand: ctx.brand, title, body: `${REPORT_CSS}<div class="rep" dir="${lang === 'ar' ? 'rtl' : 'ltr'}" lang="${lang}"><div class="muted" style="font-size:8pt;margin-bottom:3mm">${esc(title)} · ${esc(me.username)}</div>${html}</div>` });
        doc = doc.replace('<head>', '<head>' + LOCK);
        let pdf; try { pdf = await ctx.pdf(doc); } catch (e) { return send(res, 503, { error: 'PDF is not available on this server: ' + e.message }), true; }
        sweep(); if (READY.size > 200) READY.delete(READY.keys().next().value);
        const token = crypto.randomBytes(24).toString('hex'), name = (title.replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '') || 'report').slice(0, 60);
        READY.set(token, { pdf, at: Date.now(), name }); ctx.audit(req, 'pdf', 'report', 0, title);
        return send(res, 200, { url: `/api/report-pdf/${token}`, bytes: pdf.length }), true;
      }
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
