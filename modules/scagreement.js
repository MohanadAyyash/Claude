// Sub-contract agreement: Trigon's standard clauses (Settings, editable) with fields filled from the subcontract, optional
// per-subcontract wording, and appendices — 1 bill of quantities, 2 particular conditions / scope, 3 responsibility matrix.
const { esc, money } = require('../lib/render');
const { amountInWords } = require('../lib/words');

const TEMPLATE = `1. Definitions
In this Agreement the "Contractor" is {{company_legal}}, the "Sub-Contractor" is {{subcontractor}}, the "Project" is {{project}}, the "Main Contract" is the contract between the Contractor and {{client}} for {{main_contract}}, and the "Sub-Contract Works" are the works described in this Agreement and its appendices.

2. Scope of the Sub-Contract Works
The Sub-Contractor shall carry out and complete {{scope}} as described in Appendix 1 (Bill of Quantities) and Appendix 2 (Particular Conditions and Scope), to the drawings, specifications and instructions of the Contractor, and to the satisfaction of the Contractor, the Engineer and the Employer.

3. Main Contract
The Sub-Contractor is deemed to know the requirements of the Main Contract that relate to the Sub-Contract Works (other than the Contractor's prices) and shall carry out the works so that the Contractor does not breach its obligations under the Main Contract.

4. Sub-Contract Price
The Sub-Contract Price is {{value}} ({{value_words}}) excluding VAT. Quantities in Appendix 1 are provisional; the final price is the quantity actually executed and approved, valued at the rates in Appendix 1. Rates are fixed and include all labour, supervision, tools, equipment, transport and everything else needed, except what Appendix 3 places on the Contractor.

5. Programme
The Sub-Contractor shall start on {{start_date}} and complete the works by {{completion_date}}, or as instructed by the Contractor to suit the project programme, providing enough resources to keep to it.

6. Payment
The Sub-Contractor submits a monthly payment application with measurements approved by the Contractor's site team. The Contractor issues a payment certificate and pays the certified amount within {{payment_days}} days of receiving the Sub-Contractor's tax invoice for it. Retention of {{retention_pct}}% is deducted from each certificate; half is released after taking over of the works and the balance after the defects liability period of {{dlp_months}} months.

7. Value Added Tax
The Sub-Contractor shall be registered for VAT where required by law, give a copy of its tax registration certificate, and issue tax invoices showing both parties' TRNs. VAT at {{vat_pct}}% is added to certified amounts as the law requires.

8. Contra Charges and Set-Off
Costs the Contractor incurs because of the Sub-Contractor's failure to perform, or for materials, plant, labour, services or repairs it provides on the Sub-Contractor's behalf, are deducted from payment certificates at cost plus {{contra_uplift}}%. The Contractor may set off any sum due from the Sub-Contractor against any sum due to it.

9. Variations
No variation is valid unless instructed in writing by the Contractor. Variations are valued at the rates in Appendix 1 or, where none apply, at fair rates agreed in writing.

10. Quality and Defects
The works shall comply with the specifications and approved submittals. The Sub-Contractor shall correct defective work at its own cost during the works and the defects liability period.

11. Health, Safety and Environment
The Sub-Contractor shall follow the site HSE plan, the Contractor's instructions and UAE regulations, provide trained and certified personnel and personal protective equipment, and keep the site clean.

12. Labour and Licences
The Sub-Contractor is responsible for the visas, work permits, wages (through WPS), accommodation, transport and welfare of its personnel, and for keeping its trade licence and insurances valid.

13. Insurance and Indemnity
The Sub-Contractor shall insure its workers and equipment as required by law and indemnify the Contractor against claims for injury, death or damage arising from the Sub-Contract Works.

14. Default and Termination
If the Sub-Contractor fails to proceed with due diligence or breaches this Agreement and does not remedy it within seven days of written notice, the Contractor may take over all or part of the works and recover the extra cost from the Sub-Contractor.

15. Assignment
The Sub-Contractor shall not assign or sub-let any part of the works without the Contractor's written consent.

16. Confidentiality
The Sub-Contractor shall keep confidential all information about the Project, the Main Contract and the Contractor, and shall not publish photographs or information about the Project without written consent.

17. Disputes and Law
The parties shall try to settle disputes amicably. Failing that, disputes are referred to the courts of Dubai. This Agreement is governed by the laws of the Emirate of Dubai and the federal laws of the UAE.

18. Documents
This Agreement, Appendix 1 (Bill of Quantities), Appendix 2 (Particular Conditions and Scope) and Appendix 3 (Responsibility Matrix) form the whole agreement and take precedence over earlier correspondence and quotations. Where they conflict, Appendix 2 prevails.`;

const MATRIX = [['Site accommodation', [['Shaded messing facility'], ['Toilets / ablution facilities'], ['Site offices'], ['First aid'], ['Lay-down areas']]],
  ['Temporary services', [['Electricity'], ['Lighting'], ['Water']]],
  ['Plant and equipment', [['Scaffolding'], ['Cranage'], ['Unloading facilities'], ['Hand tools and small plant']]],
  ['General', [['Setting out'], ['Cleaning of works'], ['Rubbish skips'], ['Protection of sub-contract works'], ['Transportation of labour'], ['Site security'], ['Testing and approvals'], ['Permanent materials']]]];
const defaultMatrix = () => MATRIX.flatMap(([g, rows]) => [{ group: g }, ...rows.map(([item]) => ({ item, by: '', note: '' }))]);

module.exports = ctx => {
  const { db, send, bad, audit, readBody, getSettings, today, round } = ctx;
  const addCol = (t, c, d) => { if (!db.prepare(`PRAGMA table_info(${t})`).all().some(x => x.name === c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`); };
  [['agreement', 'TEXT']].forEach(([c, d]) => addCol('subcontracts', c, d));        // JSON: boq, matrix, particular, text, payment_days, dlp_months, sub_licence
  const notFound = () => { const e = new Error('not found'); e.status = 404; throw e; };
  const J = s => { try { return JSON.parse(s || '{}') || {}; } catch { return {}; } };
  const sub = id => db.prepare('SELECT * FROM subcontracts WHERE id=?').get(id) || notFound();
  const agreementOf = s => { const a = J(s.agreement); return { boq: Array.isArray(a.boq) ? a.boq : [], matrix: Array.isArray(a.matrix) && a.matrix.length ? a.matrix : defaultMatrix(), particular: a.particular || '', text: a.text || '',
    payment_days: a.payment_days ?? 60, dlp_months: a.dlp_months ?? 12, sub_licence: a.sub_licence || '', signatory: a.signatory || '' }; };
  const fmtDate = d => { if (!/^\d{4}-\d\d-\d\d$/.test(d || '')) return d || ''; const [y, m, dd] = d.split('-'); return `${+dd} ${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][+m - 1]} ${y}`; };

  function fields(s, a) {
    const S = getSettings(), p = db.prepare('SELECT * FROM projects WHERE id=?').get(s.project_id) || {}, party = db.prepare('SELECT * FROM parties WHERE id=?').get(s.party_id) || {};
    const client = db.prepare('SELECT * FROM parties WHERE id=?').get(p.client_id) || {}, cur = S.currency || 'AED';
    return { company_legal: S.legal_name || S.company_name || '', company: S.company_name || '', company_trn: S.trn || '', company_address: S.address || '', company_licence: S.license_no || '',
      subcontractor: party.name || '', sub_trn: party.trn || '', sub_address: party.address || '', sub_licence: a.sub_licence || '', scope: s.description || '', project: `${p.code ? p.code + ' — ' : ''}${p.name || ''}`,
      main_contract: p.main_contract || p.name || '', client: client.name || 'the Employer', value: `${cur} ${money(s.contract_value)}`, value_words: amountInWords(+s.contract_value || 0, cur),
      retention_pct: String(+s.retention_pct || 0), payment_days: String(a.payment_days), dlp_months: String(a.dlp_months), contra_uplift: String(+s.contra_uplift || 0), vat_pct: String(S.vat_registered === '0' ? 0 : (+S.vat_pct || 5)),
      agreement_no: s.agreement_no || '', agreement_date: fmtDate(s.agreement_date), start_date: fmtDate(s.start_date) || 'the date instructed by the Contractor', completion_date: fmtDate(s.completion_date) || 'the date required by the project programme' };
  }
  const fill = (text, f) => String(text).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in f ? f[k] : m));

  ctx.renderers.sc_agreement = id => {
    const s = sub(id), a = agreementOf(s), f = fields(s, a), S = getSettings(), cur = S.currency || 'AED';
    const text = fill(a.text || S.sc_template || TEMPLATE, f);
    // clauses: a line "12. Title" starts a clause; other lines are its paragraphs
    const clauses = text.split(/\n(?=\s*\d+\.\s+\S)/).map(b => { const lines = b.trim().split('\n'), h = lines.shift();
      return `<div class="cl"><h4>${esc(h)}</h4>${lines.filter(x => x.trim()).map(x => `<p>${esc(x)}</p>`).join('')}</div>`; }).join('');
    const [signName, signPos] = String(a.signatory || S.sc_signatory || '').split(',').map(x => x.trim());
    const boq = a.boq.filter(r => r.description || r.rate), boqTotal = round(boq.reduce((t, r) => t + (+r.qty || 0) * (+r.rate || 0), 0)), vp = +f.vat_pct;
    const kv = (k, v) => `<tr><td>${k}</td><td><b>${v || ''}</b></td></tr>`;
    const by = r => ({ contractor: ['✓', ''], sub: ['', '✓'], both: ['✓', '✓'], na: ['N/A', 'N/A'] }[r.by] || ['', '']);
    const css = `<style>.ag{font-size:9pt;line-height:1.45;text-align:justify}.ag .cl{margin:0 0 2.2mm;page-break-inside:avoid}.ag h4{margin:0 0 .6mm;font-size:9pt;color:#1F3A5F}.ag p{margin:0 0 1.5mm}
      .agc{min-height:200mm;display:flex;flex-direction:column;justify-content:center}.agc h1{text-align:center;font-size:20pt;margin:0 0 12mm;letter-spacing:.5px}.agc table{font-size:10.5pt}.agc td{padding:3mm 2mm}.agc td:first-child{width:38%;color:#8A8578}
      .apx h3{text-align:center;margin:0 0 1mm;font-size:12pt}.apx h5{text-align:center;margin:0 0 4mm;font-size:10pt;color:#8A8578;font-weight:600}
      .mx td,.mx th{border:.6pt solid #1F3A5F;text-align:center;padding:1.4mm}.mx td:first-child{text-align:start}.mx tr.g td{font-weight:700;background:#F2F1EE;text-align:start}
      .sgn{display:flex;gap:12mm;margin-top:6mm;page-break-inside:avoid;font-size:9pt}.sgn>div{flex:1}.sgn .ln{border-bottom:.5pt solid #1F3A5F;height:9mm;margin-bottom:1mm}.sgn .lb{color:#8A8578}</style>`;
    const cover = `<div class="agc"><h1>SUB-CONTRACT AGREEMENT</h1><table class="kv"><tbody>${kv('Main contract', esc(f.main_contract))}${kv('Project', esc(f.project))}${kv('Contractor', esc(f.company_legal))}${kv('Sub-contractor', esc(f.subcontractor))}
      ${kv('Sub-contract works', esc(f.scope))}${kv('Sub-contract no.', esc(f.agreement_no))}${kv('Sub-contract date', esc(f.agreement_date))}</tbody></table></div>`;
    const parties = `<div class="apx"><h3>SUB-CONTRACT AGREEMENT</h3><h5>No. ${esc(f.agreement_no)}${f.agreement_date ? ' — ' + esc(f.agreement_date) : ''}</h5>
      <p class="ag">This Agreement is made ${f.agreement_date ? `on ${esc(f.agreement_date)} ` : ''}between <b>${esc(f.company_legal)}</b>${f.company_address ? `, ${esc(f.company_address)}` : ''}${f.company_licence ? `, trade licence ${esc(f.company_licence)}` : ''}${f.company_trn ? `, TRN ${esc(f.company_trn)}` : ''} (the "Contractor"), and <b>${esc(f.subcontractor)}</b>${f.sub_address ? `, ${esc(f.sub_address)}` : ''}${f.sub_licence ? `, trade licence ${esc(f.sub_licence)}` : ''}${f.sub_trn ? `, TRN ${esc(f.sub_trn)}` : ''} (the "Sub-Contractor"). The parties agree as follows:</p>
      <div class="ag">${clauses}</div>
      <div class="sgn"><div><b>For the Contractor</b><div class="ln"></div><div class="lb">Signature and company stamp</div><p>Name: <b>${esc(signName || '')}</b><br>Position: <b>${esc(signPos || '')}</b><br>Date:</p><div class="ln"></div><div class="lb">Witness</div></div>
        <div><b>For the Sub-Contractor</b><div class="ln"></div><div class="lb">Signature and company stamp</div><p>Name:<br>Position:<br>Date:</p><div class="ln"></div><div class="lb">Witness</div></div></div></div>`;
    const ap1 = `<div class="apx"><h3>APPENDIX 1</h3><h5>BILL OF QUANTITIES</h5>${boq.length ? `<table><thead><tr><th>Item</th><th>Description</th><th>Unit</th><th class="n">Quantity</th><th class="n">Rate</th><th class="n">Amount ${esc(cur)}</th></tr></thead><tbody>
      ${boq.map((r, i) => `<tr><td>${esc(r.item || String.fromCharCode(65 + (i % 26)))}</td><td>${esc(r.description || '')}</td><td>${esc(r.unit || '')}</td><td class="n">${money(r.qty)}</td><td class="n">${money(r.rate)}</td><td class="n">${money((+r.qty || 0) * (+r.rate || 0))}</td></tr>`).join('')}</tbody></table>
      <table style="width:90mm;margin:3mm 0 0 auto"><tbody><tr><td>Total</td><td class="n"><b>${money(boqTotal)}</b></td></tr><tr><td>VAT ${vp}%</td><td class="n">${money(boqTotal * vp / 100)}</td></tr><tr><td><b>Grand total</b></td><td class="n"><b>${money(boqTotal * (1 + vp / 100))}</b></td></tr></tbody></table>
      <p style="font-size:8.5pt" class="muted">Quantities are provisional; payment is for the quantities executed and approved, at the rates above.</p>` : '<p class="muted">—</p>'}</div>`;
    const ap2 = `<div class="apx"><h3>APPENDIX 2</h3><h5>PARTICULAR CONDITIONS AND SCOPE OF WORKS</h5><div class="ag">${a.particular ? fill(a.particular, f).split('\n').map(x => x.trim() ? `<p>${esc(x)}</p>` : '').join('') : `<p>${esc(f.scope)}</p>`}</div></div>`;
    const ap3 = `<div class="apx"><h3>APPENDIX 3</h3><h5>RESPONSIBILITY MATRIX</h5><table class="mx"><thead><tr><th style="text-align:start">Item</th><th>Contractor</th><th>Sub-contractor</th><th>Comments</th></tr></thead><tbody>
      ${a.matrix.map(r => r.group ? `<tr class="g"><td colspan="4">${esc(r.group)}</td></tr>` : `<tr><td>${esc(r.item || '')}</td><td>${by(r)[0]}</td><td>${by(r)[1]}</td><td>${esc(r.note || '')}</td></tr>`).join('')}</tbody></table></div>`;
    return { title: `Sub-contract agreement ${s.agreement_no || ''}`, filename: `Sub-contract-${s.agreement_no || s.id}`, legal: true, stamp: false, signature: false, body: css + cover, after: [css + parties, css + ap1, css + ap2, css + ap3] };
  };

  return {
    async handle(req, res, url, [a, b], me) {
      if (a === 'sc-template' && req.method === 'GET') return send(res, 200, { text: TEMPLATE }), true;
      if (a !== 'sc-agreement' || !b) return false;
      const s = sub(+b);
      if (req.method === 'GET') return send(res, 200, { ...agreementOf(s), template: getSettings().sc_template || TEMPLATE, fields: fields(s, agreementOf(s)) }), true;
      if (req.method === 'PUT') {
        const x = await readBody(req), cur = agreementOf(s);
        const boq = Array.isArray(x.boq) ? x.boq.map(r => ({ item: String(r.item || ''), description: String(r.description || ''), unit: String(r.unit || ''), qty: +r.qty || 0, rate: +r.rate || 0 })) : cur.boq;
        const matrix = Array.isArray(x.matrix) ? x.matrix.map(r => (r.group ? { group: String(r.group) } : { item: String(r.item || ''), by: ['contractor', 'sub', 'both', 'na', ''].includes(r.by) ? r.by : '', note: String(r.note || '') })) : cur.matrix;
        const next = { boq, matrix, particular: x.particular ?? cur.particular, text: x.text ?? cur.text, payment_days: x.payment_days !== undefined ? +x.payment_days || 0 : cur.payment_days,
          dlp_months: x.dlp_months !== undefined ? +x.dlp_months || 0 : cur.dlp_months, sub_licence: x.sub_licence ?? cur.sub_licence, signatory: x.signatory ?? cur.signatory };
        db.prepare('UPDATE subcontracts SET agreement=? WHERE id=?').run(JSON.stringify(next), s.id);
        if (x.use_boq_value && boq.length) db.prepare('UPDATE subcontracts SET contract_value=? WHERE id=?').run(round(boq.reduce((t, r) => t + r.qty * r.rate, 0)), s.id);
        audit(req, 'update', 'subcontract_agreement', s.id);
        return send(res, 200, { ok: 1 }), true;
      }
      return false;
    },
  };
};
module.exports.TEMPLATE = TEMPLATE;
