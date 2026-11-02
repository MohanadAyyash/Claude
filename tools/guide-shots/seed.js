const base = 'http://localhost:3999/api/'; let cookie = '';
const call = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie }, body: b ? JSON.stringify(b) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const j = await r.json().catch(() => null); if (!r.ok) console.log('ERR', m, u, r.status, JSON.stringify(j)); return j; };
// valid UAE IBAN
const iban = (bank, acct) => { const bban = bank + acct; const num = (bban + '1014' + '00').split('').reduce((r, c) => (r * 10 + +c) % 97, 0); const ck = String(98 - num).padStart(2, '0'); return 'AE' + ck + bban; };
const ym = (o) => { const d = new Date(); d.setMonth(d.getMonth() + o); return d.toISOString().slice(0, 7); };
const day = o => { const d = new Date(); d.setDate(d.getDate() + o); return d.toISOString().slice(0, 10); };
(async () => {
  await call('POST', 'setup', { username: 'admin', password: 'Trigon2026', company: 'Trigon Civil Contracting' });
  await call('POST', 'brand/pack');
  await call('PUT', 'settings', { trn: '100123456700003', phone: '+971 4 000 0000', email: 'info@trigon.ae', mohre_id: '1234567890123', employer_bank: 'Emirates NBD', employer_routing: '302620122', employer_iban: iban('026', '0001234567890123'), license_expiry: day(40), bank_details: 'Emirates NBD — Trigon Civil Contracting\nIBAN ' + iban('026', '0001234567890123') });
  await call('PUT', 'profile', { display_name: 'Mohanad Ayyash', job_title: 'General Manager', mobile: '+971 50 000 0000' });
  const P = {};
  for (const [k, t, n, trn, em] of [['c1', 'client', 'Al Noor Real Estate Development', '100555666700003', 'projects@alnoor.ae'], ['c2', 'client', 'Emirates Hills Facilities LLC', '100777888900003', 'tenders@ehf.ae'], ['c3', 'client', 'Sharjah Municipality — Roads Dept.', '', 'roads@shj.gov.ae'],
    ['s1', 'supplier', 'Gulf Steel Trading LLC', '100222333400003', 'sales@gulfsteel.ae'], ['s2', 'supplier', 'Dubai Ready Mix Concrete', '100333444500003', 'orders@drmc.ae'], ['s3', 'supplier', 'Al Futtaim Building Materials', '100444555600003', 'bm@aft.ae'], ['b1', 'subcontractor', 'Precision MEP Services', '100666777800003', 'info@pmep.ae']])
    P[k] = (await call('POST', 'parties', { type: t, name: n, trn, email: em, phone: '+971 4 ' + Math.floor(1e6 + Math.random() * 8e6), address: 'Dubai, UAE' })).id;
  // users
  const U = {};
  for (const [u, r] of [['sara.pm', 'manager'], ['omar.qs', 'qs'], ['ali.site', 'site_engineer'], ['khan.foreman', 'foreman'], ['fatima.hr', 'hr'], ['rami.acc', 'accountant'], ['nabil.proc', 'procurement']]) U[u] = (await call('POST', 'users', { username: u, password: 'Trigon2026', role: r }))?.id;
  // projects
  const pj = async b => (await call('POST', 'projects', b)).id;
  const p1 = await pj({ code: 'P-2026-01', name: 'Al Noor Villas — Phase 1 (G+1, 12 villas)', client_id: P.c1, location: 'Dubai South', emirate: 'dubai', contract_value: 4850000, retention_pct: 10, status: 'active', start_date: day(-150), end_date: day(210), advance_pct: 10, handover_date: day(210), retention_handover_pct: 50, dlp_months: 12, site_lat: 24.8961, site_lng: 55.1609, site_radius: 300 });
  const p2 = await pj({ code: 'P-2026-02', name: 'EHF Warehouse Extension', client_id: P.c2, location: 'Jebel Ali Industrial 1', emirate: 'dubai', contract_value: 1720000, retention_pct: 5, status: 'active', start_date: day(-80), end_date: day(120) });
  const p3 = await pj({ code: 'P-2025-07', name: 'Interlock Paving — Al Khan Street', client_id: P.c3, location: 'Sharjah', emirate: 'sharjah', contract_value: 640000, retention_pct: 10, status: 'completed', start_date: day(-330), end_date: day(-40) });
  const boq = [['A — Substructure', 'Excavation and backfilling', 'm3', 3200, 28, 19, 100], ['A — Substructure', 'Reinforced concrete footings C35', 'm3', 640, 1150, 880, 100], ['B — Superstructure', 'RC columns, beams and slabs', 'm3', 1480, 1350, 1040, 70], ['B — Superstructure', 'Blockwork 200mm', 'm2', 9800, 62, 44, 45], ['C — Finishes', 'Internal plaster and paint', 'm2', 21000, 38, 27, 10], ['C — Finishes', 'Porcelain floor tiles', 'm2', 5400, 115, 86, 0], ['D — MEP', 'MEP works (subcontract)', 'LS', 1, 690000, 560000, 30]];
  const ids = [];
  for (const [s, d, u, q, r, c, done] of boq) ids.push([(await call('POST', 'boq_items', { project_id: p1, section: s, description: d, unit: u, qty: q, rate: r, cost_rate: c, done_pct: 0 })).id, done]);
  await call('POST', `projects/${p1}/advance-invoice`, {});
  // first progress invoice at half the progress
  for (const [id, d] of ids) await call('PUT', 'boq_items/' + id, { done_pct: Math.round(d / 2) });
  await call('POST', `projects/${p1}/progress-invoice`);
  for (const [id, d] of ids) await call('PUT', 'boq_items/' + id, { done_pct: d });
  await call('POST', 'variations', { project_id: p1, number: 'VO-01', date: day(-30), description: 'Additional boundary wall 120 m', amount: 96000, status: 'approved' });
  await call('POST', 'variations', { project_id: p1, number: 'VO-02', date: day(-6), description: 'Upgrade of entrance gates', amount: 38500, status: 'pending' });
  for (const [s, d, u, q, r, c, done] of [['', 'Steel structure extension', 'ton', 85, 9800, 7600, 60], ['', 'Sandwich panel cladding', 'm2', 3100, 165, 120, 40], ['', 'Concrete floor slab 200mm', 'm2', 2800, 145, 105, 80]])
    await call('POST', 'boq_items', { project_id: p2, section: s, description: d, unit: u, qty: q, rate: r, cost_rate: c, done_pct: done });
  await call('POST', `projects/${p2}/progress-invoice`);
  const inv3 = (await call('POST', 'invoices', { project_id: p3, date: day(-60), due_date: day(-30), vat_pct: 5, retention_pct: 10, items: [{ description: 'Interlock paving works — final', unit: 'LS', qty: 1, rate: 640000, vat: 'std' }] })).id;
  // payments
  const invs = await call('GET', 'invoices');
  for (const i of invs) { if (i.project_id === p1 && i.balance > 0) await call('POST', 'payments', { kind: 'in', date: day(-20), amount: Math.round(i.balance), method: 'bank', reference: 'TT-' + i.id, invoice_id: i.id, cheque_status: 'cleared' }); }
  await call('POST', 'payments', { kind: 'in', date: day(-15), amount: 300000, method: 'cheque', reference: 'CHQ 004512', invoice_id: inv3, cheque_date: day(10), cheque_status: 'pending' });
  // bills
  const bill = async b => (await call('POST', 'bills', b))?.id;
  const b1 = await bill({ date: day(-40), party_id: P.s1, project_id: p1, category: 'materials', description: 'Rebar 12/16 mm — 120 ton', amount: 312000, vat_amount: 15600, reference: 'GST-88123' });
  await bill({ date: day(-25), party_id: P.s2, project_id: p1, category: 'materials', description: 'Ready-mix concrete C35 — 450 m3', amount: 157500, vat_amount: 7875, reference: 'DRMC-5521' });
  await bill({ date: day(-12), party_id: P.s3, project_id: p2, category: 'materials', description: 'Sandwich panels 50mm', amount: 98000, vat_amount: 4900, reference: 'AFT-2210' });
  await bill({ date: day(-8), party_id: P.s3, category: 'equipment', description: 'Crane hire — shared between sites', amount: 24000, vat_amount: 1200, reference: 'AFT-2231', allocation: [{ project_id: p1, pct: 60 }, { project_id: p2, pct: 40 }] });
  await bill({ date: day(-5), party_id: P.s3, category: 'overhead', description: 'Office rent — quarter', amount: 45000, vat_amount: 2250, reference: 'RENT-Q4' });
  await call('POST', 'payments', { kind: 'out', date: day(-10), amount: 200000, method: 'bank', reference: 'TT-OUT-1', bill_id: b1, cheque_status: 'cleared' });
  // tenders + quotes
  await call('POST', 'tenders', { title: 'Community Mosque — Al Barsha South', party_name: 'Dubai Islamic Affairs (IACAD)', stage: 'preparing', value: 2300000, probability: 40, submission_date: day(12), source: 'Tender portal' });
  await call('POST', 'tenders', { title: 'Labour Camp Renovation', client_id: P.c2, stage: 'submitted', value: 860000, probability: 60, submission_date: day(-5) });
  await call('POST', 'tenders', { title: 'School Car Park Shade Structures', party_name: 'GEMS Education', stage: 'lead', value: 420000, probability: 20 });
  await call('POST', 'tenders', { title: 'Retail Fit-out — Mall Unit G-14', party_name: 'Majid Al Futtaim Properties', stage: 'negotiation', value: 1150000, probability: 75 });
  await call('POST', 'tenders', { title: 'Interlock Paving — Al Khan Street', client_id: P.c3, stage: 'won', value: 640000, probability: 100 });
  await call('POST', 'quotes', { client_id: P.c2, date: day(-4), project_name: 'Labour Camp Renovation', validity_days: 30, status: 'sent', vat_pct: 5, items: [{ description: 'Demolition and removal of existing finishes', unit: 'LS', qty: 1, rate: 85000, vat: 'std' }, { description: 'New toilets and wet areas', unit: 'no', qty: 24, rate: 14500, vat: 'std' }, { description: 'External painting', unit: 'm2', qty: 6200, rate: 22, vat: 'std' }] });
  await call('POST', 'quotes', { client_id: P.c1, date: day(-2), project_name: 'Al Noor Villas — Phase 2', validity_days: 45, status: 'draft', vat_pct: 5, items: [{ description: 'Substructure works', unit: 'LS', qty: 1, rate: 1250000, vat: 'std' }, { description: 'Superstructure works', unit: 'LS', qty: 1, rate: 2100000, vat: 'std' }] });
  // site diary
  for (let i = 1; i <= 4; i++) await call('POST', 'site_reports', { project_id: p1, date: day(-i), weather: ['Sunny 38°C', 'Hot & humid 41°C', 'Dusty, wind', 'Sunny 36°C'][i - 1], labour_count: 40 + i * 3, work_done: ['Casting first-floor slab villas 7–8', 'Blockwork ground floor villas 9–12', 'Column shuttering villas 9–10', 'Steel fixing first-floor slab'][i - 1], issues: i === 2 ? 'Concrete pump arrived 2 hours late' : '' });
  // RFQ, PO, subcontract
  const rfq = await call('POST', 'rfqs', { project_id: p1, description: 'Porcelain floor tiles 60×60', items: [{ description: 'Porcelain tile 60×60 matt', unit: 'm2', qty: 5600 }, { description: 'Tile adhesive 25 kg', unit: 'bag', qty: 1400 }], quotes: [{ party_id: P.s3, rates: [48, 21], delivery_days: 10 }, { party_id: P.s1, rates: [52, 19], delivery_days: 7 }] });
  await call('POST', 'purchase_orders', { date: day(-18), party_id: P.s2, project_id: p1, status: 'sent', vat_pct: 5, items: [{ description: 'Ready-mix concrete C35', unit: 'm3', qty: 300, rate: 350 }] });
  const sc = await call('POST', 'subcontracts', { project_id: p1, party_id: P.b1, description: 'MEP works — 12 villas', contract_value: 560000, retention_pct: 10, advance: 0, status: 'active' });
  if (sc) { const c = await call('POST', 'sub_certs', { subcontract_id: sc.id, cumulative: 140000, advance_recovery: 0 }); if (c) await call('POST', `sub_certs/${c.id}/approve`); await call('POST', 'sub_certs', { subcontract_id: sc.id, cumulative: 168000, advance_recovery: 0 }); }
  // stock
  for (const [n, u, mq, code, q, c] of [['Cement OPC 50 kg', 'bag', 200, 'MAT-001', 640, 18.5], ['Rebar 12 mm', 'ton', 10, 'MAT-002', 8, 2450], ['Plywood 18 mm', 'sheet', 50, 'MAT-003', 210, 62], ['Safety helmets', 'pc', 30, 'PPE-001', 85, 14]]) {
    const it = await call('POST', 'stock_items', { name: n, unit: u, min_qty: mq, code, location: 'Main store — Dubai South' });
    await call('POST', 'stock_moves', { item_id: it.id, type: 'in', qty: q, unit_cost: c, date: day(-20), reference: 'GRN-' + it.id });
    if (q > 50) await call('POST', 'stock_moves', { item_id: it.id, type: 'out', qty: Math.round(q / 4), project_id: p1, date: day(-3), reference: 'MIV-' + it.id });
  }
  await call('POST', 'fixed_assets', { name: 'Toyota Hilux pickup', category: 'Vehicles', serial: 'Dubai K 45821', purchase_date: '2025-03-01', cost: 98000, salvage: 20000, life_years: 5, project_id: p1, status: 'active' });
  await call('POST', 'fixed_assets', { name: 'Concrete mixer 1 m3', category: 'Plant', serial: 'CM-7741', purchase_date: '2025-08-15', cost: 42000, salvage: 4000, life_years: 6, status: 'active' });
  await call('POST', 'petty_topups', { date: day(-14), amount: 5000, note: 'Site float — Dubai South' });
  await call('POST', 'petty_topups/expense', { date: day(-6), project_id: p1, category: 'transport', description: 'Diesel for site generator', amount: 420, vat_amount: 21 });
  await call('POST', 'petty_topups/expense', { date: day(-3), project_id: p1, category: 'other', description: 'Drinking water for workers', amount: 260, vat_amount: 13 });
  // employees
  const E = [];
  const emps = [['Ahmed Hassan Mahmoud', 'Site Engineer', 'Egyptian', 9500, 3000, 1000, p1, -700], ['Mohammed Rafiq Khan', 'Foreman', 'Pakistani', 4200, 1200, 500, p1, -900], ['Suresh Kumar Nair', 'Mason', 'Indian', 1800, 600, 300, p1, -400], ['Abdul Karim Rahman', 'Steel Fixer', 'Bangladeshi', 1700, 600, 300, p1, -380], ['Joseph Mendoza', 'Accountant', 'Filipino', 7000, 2500, 800, null, -1200], ['Layla Saeed', 'HR Officer', 'Jordanian', 8000, 2500, 800, null, -150]];
  let n = 0;
  for (const [nm, des, nat, b, h, t, pid, jd] of emps) { n++;
    const e = await call('POST', 'employees', { name: nm, designation: des, nationality: nat, basic: b, housing: h, transport: t, other_allowance: 0, project_id: pid, join_date: day(jd), status: 'active', person_code: '1000000000000' + n, emirates_id: '78419' + (80 + n) + '1234567' + n, passport_no: 'P' + (5550000 + n), bank_name: 'Emirates NBD', routing_code: '302620122', iban: iban('026', '00012345678901' + String(10 + n)), eid_expiry: day(n === 3 ? 25 : 400), visa_expiry: day(n === 4 ? 45 : 500), passport_expiry: day(1500), card_expiry: day(450), phone: '+971 55 000 00' + n, probation_end: jd > -180 ? day(jd + 180) : '' });
    E.push(e.id); }
  if (U['ali.site']) await call('PUT', 'users/' + U['ali.site'], { employee_id: E[0] });
  await call('PUT', 'employees/' + E[2], { manager_user_id: U['khan.foreman'] }); await call('PUT', 'employees/' + E[3], { manager_user_id: U['khan.foreman'] });
  await call('POST', 'users', { username: 'suresh', password: 'Trigon2026', role: 'employee', employee_id: E[2] });
  // attendance for last month & today
  const lm = ym(-1);
  for (let d = 1; d <= 28; d++) { const date = `${lm}-${String(d).padStart(2, '0')}`; if (new Date(date).getDay() === 5) continue;
    for (const e of E.slice(0, 4)) await call('PUT', 'attendance', { employee_id: e, date, status: 'present', ot_normal_hours: d % 3 === 0 ? 2 : 0, ot_special_hours: 0, project_id: p1 }); }
  for (const e of E.slice(0, 4)) await call('PUT', 'attendance', { employee_id: e, date: day(0), status: 'present', ot_normal_hours: e === E[2] ? 2 : 0, ot_special_hours: 0, project_id: p1 });
  // leave & requests & loans
  await call('POST', 'hr/leave', { employee_id: E[2], type: 'annual', start_date: day(20), end_date: day(49), reason: 'Annual vacation — India' });
  await call('POST', 'hr/leave', { employee_id: E[3], type: 'sick', start_date: day(-9), end_date: day(-8), reason: 'Fever (medical certificate attached)' });
  await call('POST', 'hr/requests', { employee_id: E[0], type: 'salary_certificate', details: 'For Emirates NBD — car loan' });
  await call('POST', 'hr/requests', { employee_id: E[3], type: 'advance', amount: 1500, installments: 3, details: 'Family emergency' });
  await call('POST', 'hr/loans', { employee_id: E[1], amount: 3000, installments: 6, start_month: ym(0), method: 'bank', note: 'Approved by GM' });
  await call('POST', 'hr/letters', { type: 'noc', employee_id: E[0], addressed_to: 'To whom it may concern', purpose: 'Travel' });
  // payroll last month
  await call('POST', 'payroll/generate', { month: lm }); await call('POST', 'payroll/finalize', { month: lm }); await call('POST', 'payroll/pay', { month: lm, date: day(-25) });
  await call('POST', 'payroll/generate', { month: ym(0) });
  // tasks & notes
  const t = await call('POST', 'tasks', { project_id: p1, title: 'Authority NOCs (DEWA, Civil Defence)', tag: 'authorities', due_date: day(9), assignee_user_id: U['sara.pm'], details: 'Submit drawings and follow up' });
  if (t) { await call('POST', 'tasks', { parent_id: t.id, title: 'DEWA load approval', assignee_user_id: U['sara.pm'] }); }
  await call('POST', 'tasks', { project_id: p2, title: 'Submit IPC-03 to client', due_date: day(3), assignee_user_id: U['omar.qs'] });
  await call('POST', 'notes', { entity: 'project', entity_id: p1, body: '@omar.qs please prepare IPC-04 after the first-floor slabs of villas 7–8 are cast.' });
  await call('PUT', `projects/${p1}/budget`, { lines: { materials: 1650000, labour: 520000, subcontract: 560000, equipment: 180000, transport: 40000, overhead: 120000 } });
  await call('POST', `projects/${p1}/updates`, { status: 'on_track', progress: 52, date: day(-7), summary: 'Superstructure 70% complete. Blockwork started on villas 9–12. Next: first-floor slabs villas 7–8.' });
  await call('POST', 'journal_entries', { date: day(-200), memo: 'Opening capital', lines: [{ account: '1000', debit: 500000 }, { account: '3000', credit: 500000 }] });
  console.log('seeded', { p1, p2, p3, E });
})();
