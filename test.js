// End-to-end API test: node --no-warnings test.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-'));
const net = require('net');
process.env.SETUP_TOKEN = 'tok-123456-secret';
const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const { server } = require('./server.js');
// tiny fake SMTP server that records the message
const mails = [];
const smtp = net.createServer(sock => {
  let inData = false, authStage = 0, cur = { rcpt: [], auth: [] };
  sock.write('220 fake ESMTP\r\n');
  sock.on('data', d => {
    for (const line of d.toString().split('\r\n')) {
      if (inData) { if (line === '.') { inData = false; mails.push(cur); cur = { rcpt: [], auth: [] }; sock.write('250 queued\r\n'); } else cur.body = (cur.body || '') + line + '\n'; continue; }
      if (!line) continue;
      if (authStage) { cur.auth.push(Buffer.from(line, 'base64').toString()); sock.write(authStage++ === 1 ? '334 UGFzc3dvcmQ6\r\n' : '235 ok\r\n'); if (authStage === 3) authStage = 0; continue; }
      if (/^EHLO/.test(line)) sock.write('250-fake\r\n250 AUTH LOGIN\r\n');
      else if (line === 'AUTH LOGIN') { authStage = 1; sock.write('334 VXNlcm5hbWU6\r\n'); }
      else if (/^MAIL FROM/.test(line)) { cur.from = line; sock.write('250 ok\r\n'); }
      else if (/^RCPT TO/.test(line)) { cur.rcpt.push(line); sock.write('250 ok\r\n'); }
      else if (line === 'DATA') { inData = true; sock.write('354 go\r\n'); }
      else if (line === 'QUIT') sock.end('221 bye\r\n');
    }
  });
});
smtp.listen(0);
server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api/`;
  let cookie = '';
  const call = async (m, u, b) => {
    const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie }, body: b ? JSON.stringify(b) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { s: r.status, j: await r.json().catch(() => null) };
  };
  try {
    assert.equal((await call('GET', 'projects')).s, 401);
    assert.equal((await call('POST', 'setup', { username: 'a', password: '123456', company: 'GRC' })).s, 403);                     // setup token required on public servers
    assert.equal((await call('POST', 'setup', { username: 'a', password: '123456', company: 'GRC', token: 'wrong-token-value' })).s, 403);
    assert.equal((await call('GET', 'status')).j.token_required, true);
    assert.equal((await call('POST', 'setup', { username: 'a', password: '123456', company: 'GRC', token: 'tok-123456-secret' })).s, 200);
    assert.equal((await call('POST', 'setup', { username: 'b', password: '123456' })).s, 403);
    // tax invoices require the company TRN
    const q0 = (await call('POST', 'parties', { type: 'client', name: 'Tmp' })).j.id;
    const p0 = (await call('POST', 'projects', { name: 'Tmp', client_id: q0 })).j.id;
    assert.equal((await call('POST', 'invoices', { project_id: p0, items: [] })).s, 400);
    assert.equal((await call('PUT', 'settings', { trn: '123' })).s, 400);
    assert.equal((await call('PUT', 'settings', { trn: '100123456700003', mohre_id: '1234567890123', employer_routing: '302620122', employer_iban: 'AE070331234567890123456' })).s, 200);
    assert.equal((await call('POST', 'parties', { name: 'x', trn: '12' })).s, 400);
    const client = (await call('POST', 'parties', { type: 'client', name: 'Client A' })).j.id;
    const sup = (await call('POST', 'parties', { type: 'supplier', name: 'Supplier S' })).j.id;
    const q = (await call('POST', 'quotes', { client_id: client, project_name: 'Villa', items: [{ description: 'Works', qty: 10, rate: 1000 }] })).j.id;
    const qq = (await call('GET', 'quotes/' + q)).j;
    assert.match(qq.number, /^TC\d\d\/01-CLIENT$/); assert.equal(qq.subtotal, 10000); assert.equal(qq.vat, 500); assert.equal(qq.total, 10500);
    const pid = (await call('POST', `quotes/${q}/convert`)).j.project_id;
    assert.equal((await call('POST', `quotes/${q}/convert`)).s, 400);
    const inv = (await call('POST', 'invoices', { project_id: pid, retention_pct: 10, due_date: '2020-01-01', items: [{ description: 'Phase 1', qty: 1, rate: 4000 }] })).j.id;
    let i = (await call('GET', 'invoices/' + inv)).j;
    assert.equal(i.total, 4200); assert.equal(i.retention, 400); assert.equal(i.due_now, 3800); assert.equal(i.status, 'overdue');
    await call('POST', 'payments', { kind: 'in', amount: 3800, invoice_id: inv });
    i = (await call('GET', 'invoices/' + inv)).j;
    assert.equal(i.balance, 0); assert.equal(i.retention_open, 400); assert.equal(i.status, 'retention');
    await call('POST', 'payments', { kind: 'in', amount: 400, invoice_id: inv, is_retention: 1 });
    assert.equal((await call('GET', 'invoices/' + inv)).j.status, 'paid');
    const bill = (await call('POST', 'bills', { party_id: sup, project_id: pid, category: 'materials', amount: 1000, vat_amount: 50 })).j.id;
    await call('POST', 'payments', { kind: 'out', amount: 500, bill_id: bill });
    const b = (await call('GET', 'bills/' + bill)).j; assert.equal(b.balance, 550); assert.equal(b.status, 'partial');
    const ps = (await call('GET', 'project-summary')).j.find(p => p.id === pid);
    assert.equal(ps.invoiced, 4000); assert.equal(ps.cost, 1000); assert.equal(ps.profit, 3000); assert.equal(ps.margin, 75); assert.equal(ps.contract_value, 10000);
    const v = (await call('GET', 'vat')).j; assert.equal(v.output_vat, 200); assert.equal(v.input_vat, 50); assert.equal(v.net_vat, 150);
    const d = (await call('GET', 'dashboard')).j; assert.equal(d.cash, 3800 + 400 - 500); assert.equal(d.payable, 550);
    assert.equal((await call('DELETE', 'projects/' + pid)).s, 409);
    assert.equal((await call('DELETE', 'parties/' + client)).s, 409);
    // invoices cannot be deleted; credit note + void flow
    assert.equal((await call('DELETE', 'invoices/' + inv)).s, 409);
    const cn = (await call('POST', `invoices/${inv}/credit-note`, { reason: 'test', items: [{ description: 'Adj', qty: 1, rate: 1000 }] })).j.id;
    const cnr = (await call('GET', 'invoices/' + cn)).j; assert.match(cnr.number, /^CN-/); assert.equal(cnr.total, -1050); assert.equal(cnr.vat, -50);
    assert.equal((await call('GET', 'vat')).j.output_vat, 150);
    const inv2 = (await call('POST', 'invoices', { project_id: pid, items: [{ description: 'Zero', qty: 1, rate: 1000, vat: 'zero' }, { description: 'Std', qty: 1, rate: 1000 }] })).j.id;
    const i2 = (await call('GET', 'invoices/' + inv2)).j; assert.equal(i2.vat, 50); assert.equal(i2.zero_total, 1000);
    assert.equal((await call('POST', `invoices/${inv2}/void`, {})).s, 400);
    assert.equal((await call('POST', `invoices/${inv2}/void`, { reason: 'mistake' })).s, 200);
    assert.equal((await call('GET', 'invoices/' + inv2)).j.status, 'void');
    assert.equal((await call('GET', 'invoices/' + inv2)).j.total, 0);

    // ---- BOQ, progress billing, variations, site diary ----
    const boq = (await call('GET', `boq_items?project_id=${pid}`)).j; assert.equal(boq.length, 1); assert.equal(boq[0].qty, 10);   // copied from quote
    assert.equal((await call('PUT', 'boq_items/' + boq[0].id, { done_pct: 150 })).s, 400);
    await call('PUT', 'boq_items/' + boq[0].id, { done_pct: 30, cost_rate: 700 });
    const pi = (await call('POST', `projects/${pid}/progress-invoice`)).j.id, pii = (await call('GET', 'invoices/' + pi)).j;
    assert.equal(pii.subtotal, 3000); assert.equal(pii.vat, 150);                       // 10 x 1000 x 30%
    assert.equal((await call('POST', `projects/${pid}/progress-invoice`)).s, 400);     // nothing new to bill
    await call('PUT', 'boq_items/' + boq[0].id, { done_pct: 50 });
    const pi2 = (await call('GET', 'invoices/' + (await call('POST', `projects/${pid}/progress-invoice`)).j.id)).j; assert.equal(pi2.subtotal, 2000);
    await call('POST', 'invoices/' + pi + '/void', { reason: 'cleanup' }); await call('POST', 'invoices/' + pi2.id + '/void', { reason: 'cleanup' });
    const vo = (await call('POST', 'variations', { project_id: pid, description: 'Extra', amount: 2000, status: 'approved' })).j.id;
    let ps2 = (await call('GET', 'project-summary')).j.find(p => p.id === pid);
    assert.equal(ps2.revised_value, 12000); assert.equal(ps2.boq_budget_cost, 7000); assert.equal(ps2.boq_progress, 50);
    await call('PUT', 'variations/' + vo, { status: 'rejected' });
    assert.equal((await call('GET', 'project-summary')).j.find(p => p.id === pid).revised_value, 10000);
    assert.equal((await call('POST', 'site_reports', { project_id: pid, date: '2026-09-01', work_done: 'Blockwork', labour_count: 12 })).s, 200);
    assert.equal((await call('GET', `site_reports?project_id=${pid}`)).j.length, 1);

    // ---- payroll / WPS ----
    const emp = (await call('POST', 'employees', { name: 'Worker 1', person_code: '12345678901234', routing_code: '302620122', iban: 'AE070331234567890123456', join_date: '2020-01-01', basic: 1500, housing: 500, other_allowance: 200, project_id: pid })).j.id;
    assert.equal((await call('POST', 'employees', { name: 'Bad', iban: 'AE000000000000000000000' })).s, 400);
    assert.equal((await call('POST', 'payroll/generate', { month: '2026-09' })).j.created, 1);
    assert.equal((await call('POST', 'payroll/generate', { month: '2026-09' })).j.created, 0);
    let pr = (await call('GET', 'payroll?month=2026-09')).j[0]; assert.equal(pr.net, 2200);
    assert.equal((await call('PUT', 'payroll/' + pr.id, { ot_normal_hours: 8, deductions: 100 })).s, 200);
    pr = (await call('GET', 'payroll?month=2026-09')).j[0];
    assert.equal(pr.overtime, 62.5); assert.equal(pr.net, 2162.5); // 1500/30/8 = 6.25/h x1.25 x8h
    await call('POST', 'payroll/finalize', { month: '2026-09' });
    assert.equal((await call('PUT', 'payroll/' + pr.id, { bonus: 5 })).s, 409);
    const sifRes = await fetch(base + 'payroll/sif?month=2026-09', { headers: { cookie } }), sif = await sifRes.text();
    const [edr, scr] = sif.trim().split('\r\n');
    // deductions exceed overtime, so the shortfall is netted off the fixed part and variable is 0
    assert.equal(edr, 'EDR,12345678901234,302620122,AE070331234567890123456,2026-09-01,2026-09-30,30,2162.50,0.00,0');
    assert.match(scr, /^SCR,1234567890123,302620122,\d{4}-\d\d-\d\d,\d{4},092026,1,2162\.50,AED,$/);
    assert.match(sifRes.headers.get('content-disposition'), /\.SIF"/);
    assert.equal((await call('DELETE', 'employees/' + emp)).s, 409);
    const g = (await call('GET', `employees/${emp}/gratuity?end=2026-01-01`)).j; assert.ok(g.amount > 0 && g.amount <= 36000);

    // ---- corporate tax & compliance ----
    const ct = (await call('GET', 'corporate-tax?from=2026-01-01&to=2026-12-31')).j;
    assert.equal(ct.rate, 0.09); assert.ok(ct.payroll_cost > 0); assert.equal(ct.tax, 0);
    assert.ok(Array.isArray((await call('GET', 'compliance')).j));
    assert.ok((await call('GET', 'audit')).j.length > 5);
    assert.equal((await call('POST', 'login', { username: 'a', password: 'bad' })).s, 401);
    assert.equal((await call('POST', 'login', { username: 'a', password: '123456' })).s, 200);
    // ---- roles & users ----
    const mk = async (u, role) => (await call('POST', 'users', { username: u, password: 'pass123', role })).s;
    assert.equal(await mk('acc1', 'accountant'), 200); assert.equal(await mk('pm1', 'manager'), 200); assert.equal(await mk('view1', 'viewer'), 200);
    assert.equal(await mk('acc1', 'viewer'), 400); assert.equal(await mk('bad1', 'root'), 400);
    const adminCookie = cookie;
    const as = async (u, fn) => { cookie = ''; await call('POST', 'login', { username: u, password: 'pass123' }); const r = await fn(); return r; };
    assert.equal((await as('view1', () => call('GET', 'projects'))).s, 200);
    assert.equal((await call('POST', 'parties', { name: 'x' })).s, 403);
    assert.equal((await call('GET', 'employees')).s, 403);
    assert.equal((await call('GET', 'users')).s, 403);
    assert.equal((await call('GET', 'settings')).j.smtp_pass, undefined);
    assert.equal((await as('pm1', () => call('POST', 'site_reports', { project_id: pid, date: '2026-09-02' }))).s, 200);
    assert.equal((await call('POST', 'invoices', { project_id: pid, items: [] })).s, 403);
    assert.equal((await call('GET', 'payroll?month=2026-09')).s, 403);
    assert.equal((await as('acc1', () => call('GET', 'payroll?month=2026-09'))).s, 200);
    assert.equal((await call('PUT', 'settings', { company_name: 'hack' })).s, 403);
    assert.equal((await call('GET', 'backup')).s, 403);
    cookie = adminCookie;
    const me = (await call('GET', 'users')).j; const adminId = me.find(u => u.username === 'a').id;
    assert.equal((await call('DELETE', 'users/' + adminId)).s, 400);                 // cannot delete self / last admin
    assert.equal((await call('PUT', 'users/' + adminId, { role: 'viewer' })).s, 400);
    const v1 = me.find(u => u.username === 'view1').id;
    await call('PUT', 'users/' + v1, { password: 'newpass1' });
    cookie = ''; assert.equal((await call('POST', 'login', { username: 'view1', password: 'pass123' })).s, 401);
    cookie = adminCookie;

    // ---- email (fake SMTP) ----
    assert.equal((await call('POST', `invoices/${i2.id}/email`, { to: 'c@x.com' })).s, 400);   // SMTP not configured / voided
    assert.equal((await call('PUT', 'settings', { smtp_host: '127.0.0.1', smtp_port: smtp.address().port, smtp_user: 'mailuser', smtp_pass: 's3cret', smtp_from: 'accounts@grc-uae.com' })).j.smtp_pass, undefined);
    assert.equal((await call('GET', 'settings')).j.smtp_pass_set, '1');
    assert.equal((await call('POST', 'settings/test-email', { to: 'not-an-email' })).s, 400);
    assert.equal((await call('POST', 'settings/test-email', { to: 'me@example.com' })).s, 200);
    const inv3 = (await call('POST', 'invoices', { project_id: pid, due_date: '2020-01-01', items: [{ description: 'Mail me', qty: 1, rate: 100 }] })).j.id;
    assert.equal((await call('POST', `invoices/${inv3}/email`, { to: 'client@example.com\r\nBcc: evil@x.com' })).s, 400);   // header injection blocked
    assert.equal((await call('POST', `invoices/${inv3}/email`, { to: 'client@example.com', reminder: true, message: 'Dear client' })).s, 200);
    assert.equal(mails.length, 2); const m = mails[1];
    assert.deepEqual(m.auth, ['mailuser', 's3cret']); assert.match(m.from, /accounts@grc-uae\.com/); assert.match(m.rcpt[0], /client@example\.com/);
    const subj = /Subject: =\?UTF-8\?B\?(.+?)\?=/.exec(m.body); assert.match(Buffer.from(subj[1], 'base64').toString(), /^Payment reminder — Invoice INV-/);
    const html = Buffer.from(m.body.split('text/html')[1].split('\n\n')[1].split('--')[0].replace(/\s/g, ''), 'base64').toString();
    assert.match(html, /INV-\d{4}-\d+/); assert.match(html, /Payment reminder/);

    // ---- HR: leave, requests, attendance, letters, payslips, employee portal ----
    const hrId = (await call('POST', 'users', { username: 'hr1', password: 'pass123', role: 'hr' })).s; assert.equal(hrId, 200);
    const loginAs = async u => { cookie = ''; assert.equal((await call('POST', 'login', { username: u, password: 'pass123' })).s, 200); };
    cookie = adminCookie;
    const e2 = (await call('POST', 'employees', { name: 'Ahmed Ali', person_code: '99999999999999', routing_code: '302620122', iban: 'AE070331234567890123456', join_date: '2024-01-01', basic: 3000, housing: 1000, other_allowance: 500, nationality: 'Egypt', passport_no: 'A123', designation: 'Foreman' })).j.id;
    await loginAs('hr1');
    assert.equal((await call('GET', 'invoices')).s, 403);                                    // HR cannot see finance
    assert.equal((await call('POST', 'users', { username: 'emp1', password: 'pass123', role: 'employee', employee_id: e2 })).s, 200);
    assert.equal((await call('POST', 'users', { username: 'x', password: 'pass123', role: 'accountant' })).s, 400);   // HR may only create employee accounts
    assert.equal((await call('POST', 'users', { username: 'emp2', password: 'pass123', role: 'employee', employee_id: e2 })).s, 400);  // one account per employee
    let bal = (await call('GET', 'hr/balances')).j.find(x => x.employee_id === e2); assert.ok(bal.accrued >= 30 && bal.balance === bal.accrued);
    await loginAs('emp1');
    const mine = (await call('GET', 'me')).j; assert.equal(mine.employee.name, 'Ahmed Ali'); assert.equal(mine.employee.basic, undefined);       // no salary data on profile
    assert.equal((await call('GET', 'employees')).s, 403); assert.equal((await call('GET', 'projects')).s, 403); assert.equal((await call('GET', 'hr/leave')).s, 403);
    const lv = (await call('POST', 'me/leave', { type: 'annual', start_date: '2026-10-10', end_date: '2026-10-14', reason: 'family' })).j.id;
    assert.equal((await call('POST', 'me/leave', { type: 'annual', start_date: '2026-10-12', end_date: '2026-10-20' })).s, 400);       // overlap
    const rq = (await call('POST', 'me/request', { type: 'salary_certificate', details: 'for bank' })).j.id;
    assert.equal((await call('POST', 'hr/leave/' + lv + '/decide', { status: 'approved' })).s, 403);                                        // employee cannot approve
    await loginAs('hr1');
    assert.equal((await call('PUT', `hr/leave/${lv}/decide`, { status: 'approved' })).s, 200);
    assert.equal((await call('PUT', `hr/leave/${lv}/decide`, { status: 'approved' })).s, 400);                                            // already decided
    bal = (await call('GET', 'hr/balances')).j.find(x => x.employee_id === e2); assert.equal(bal.used, 5);
    const lt = (await call('POST', 'hr/letters', { type: 'salary_certificate', employee_id: e2, request_id: rq, purpose: 'bank' })).j; assert.match(lt.number, /^TC\d\d\/01-HR$/);
    assert.equal((await call('GET', 'hr/requests')).j.find(x => x.id === rq).status, 'approved');                         // issuing the letter approves the request
    assert.equal((await call('PUT', `hr/requests/${rq}/decide`, { status: 'approved' })).s, 400);
    const letterHtml = await (await fetch(base + 'doc/letter/' + lt.id, { headers: { cookie } })).text();
    assert.match(letterHtml, /Salary Certificate/); assert.match(letterHtml, /4,500\.00/); assert.match(letterHtml, /Ahmed Ali/);
    await loginAs('emp1');
    assert.equal((await fetch(base + 'me/letter/' + lt.id, { headers: { cookie } })).status, 200);
    assert.equal((await fetch(base + 'doc/letter/' + lt.id, { headers: { cookie } })).status, 403);
    // site managers can record attendance but not read HR data
    await loginAs('pm1'); assert.equal((await call('GET', 'attendance?date=2026-11-10')).s, 200); assert.equal((await call('GET', 'hr/leave')).s, 403); assert.equal((await call('GET', 'employees')).s, 403);
    // unpaid leave + attendance overtime flow into payroll
    await loginAs('hr1');
    await call('POST', 'hr/leave', { employee_id: e2, type: 'unpaid', start_date: '2026-11-03', end_date: '2026-11-05' });
    const ul = (await call('GET', 'hr/leave')).j.find(x => x.type === 'unpaid'); await call('PUT', `hr/leave/${ul.id}/decide`, { status: 'approved' });
    assert.equal((await call('PUT', 'attendance', { employee_id: e2, date: '2026-11-10', status: 'present', ot_normal_hours: 4 })).s, 200);
    await call('POST', 'payroll/generate', { month: '2026-11' });
    const pr2 = (await call('GET', 'payroll?month=2026-11')).j.find(x => x.employee_id === e2);
    assert.equal(pr2.days_worked, 27); assert.equal(pr2.leave_days, 3); assert.equal(pr2.fixed, 4050); assert.equal(pr2.overtime, 62.5);   // 4500*27/30 ; 3000/30/8*1.25*4
    cookie = adminCookie;

    // ---- letterhead, brand assets, PDF ----
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    assert.equal((await call('PUT', 'brand/logo', { data: png })).s, 200); assert.equal((await call('PUT', 'brand/stamp', { data: png })).s, 200);
    assert.equal((await call('PUT', 'brand/logo', { data: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' })).s, 400);
    await call('PUT', 'settings', { company_name: 'Trigon Civil Contracting LLC', company_name_ar: 'تريجون سيفيل للمقاولات ذ م م' });
    const invHtml = await (await fetch(base + 'doc/invoices/' + inv3, { headers: { cookie } })).text();
    assert.match(invHtml, /Trigon Civil Contracting LLC/); assert.ok(!/class="logo-ar"/.test(invHtml)); assert.match(invHtml, /data:image\/png;base64/); assert.match(invHtml, /Tax Invoice/); assert.match(invHtml, /\/fonts\/fonts\.css/);
    const offHtml = await (await fetch(base + 'doc/letter/' + lt.id, { headers: { cookie } })).text(); assert.match(offHtml, /تريجون سيفيل/); assert.match(offHtml, /Ref: <b>TC\d\d\/01-HR/);   // HR letters use the official bilingual letterhead
    const { findBrowser } = require('./lib/pdf');
    if (findBrowser()) { const r = await fetch(base + `doc/invoices/${inv3}/pdf`, { headers: { cookie } }); const b = Buffer.from(await r.arrayBuffer()); assert.equal(r.status, 200); assert.equal(b.slice(0, 4).toString(), '%PDF'); console.log('PDF generated:', b.length, 'bytes'); }
    // emailed invoice carries the PDF
    const mails0 = mails.length; await call('POST', `invoices/${inv3}/email`, { to: 'client@example.com' });
    if (findBrowser()) assert.match(mails[mails0].body, /filename="INV-\d{4}-\d+\.pdf"/);

    // ---- documents ----
    const doc = (await call('POST', 'documents', { entity: 'company', entity_id: 0, name: 'trade-licence.pdf', category: 'licence', expiry_date: '2020-01-01', data: 'data:application/pdf;base64,JVBERi0xLjQK' })).j.id;
    assert.ok(doc); assert.equal((await call('GET', 'documents?entity=company&entity_id=0')).j.length, 1);
    assert.equal((await call('POST', 'documents', { entity: 'company', name: 'x.exe', data: 'data:application/x-msdownload;base64,AAAA' })).s, 400);
    const dl = await fetch(base + `documents/${doc}/download`, { headers: { cookie } }); assert.equal(dl.headers.get('content-disposition').includes('trade-licence.pdf'), true);
    await loginAs('hr1'); assert.equal((await call('POST', 'documents', { entity: 'project', entity_id: pid, name: 'a.pdf', data: 'data:application/pdf;base64,JVBERi0xLjQK' })).s, 403);
    cookie = adminCookie;

    // ---- procurement: RFQ -> PO -> bill, subcontract certificates, stock, assets, petty cash ----
    const sup2 = (await call('POST', 'parties', { type: 'supplier', name: 'Supplier T', trn: '100111111100003' })).j.id;
    const rfq = (await call('POST', 'rfqs', { project_id: pid, description: 'Steel', items: [{ description: 'Rebar 12mm', unit: 'ton', qty: 10 }, { description: 'Tie wire', unit: 'kg', qty: 100 }],
      quotes: [{ party_id: sup, rates: [2500, 8] }, { party_id: sup2, rates: [2400, 9], delivery_days: 7 }] })).j.id;
    let rv = (await call('GET', 'rfqs/' + rfq)).j; assert.match(rv.number, /^RFQ-\d{4}-001$/); assert.equal(rv.quotes[0].total, 25800); assert.equal(rv.quotes[1].total, 24900); assert.equal(rv.quotes[1].lowest, true);
    assert.equal((await call('POST', `rfqs/${rfq}/award`, { party_id: 9999 })).s, 400);
    const po = (await call('POST', `rfqs/${rfq}/award`, { party_id: sup2 })).j.id; let pov = (await call('GET', 'purchase_orders/' + po)).j;
    assert.equal(pov.subtotal, 24900); assert.equal(pov.vat, 1245); assert.equal(pov.supplier_name, 'Supplier T'); assert.equal((await call('POST', `rfqs/${rfq}/award`, { party_id: sup2 })).s, 400);
    const rcv = (await call('POST', `purchase_orders/${po}/receive`, { category: 'materials' })).j.bill_id; const bl2 = (await call('GET', 'bills/' + rcv)).j; assert.equal(bl2.amount, 24900); assert.equal(bl2.vat_amount, 1245);
    assert.equal((await call('POST', `purchase_orders/${po}/receive`, {})).s, 400);
    assert.match(await (await fetch(base + 'doc/purchase_orders/' + po, { headers: { cookie } })).text(), /Purchase Order/);
    const sc = (await call('POST', 'subcontracts', { project_id: pid, party_id: sup2, description: 'Plastering', contract_value: 50000, retention_pct: 10, advance: 5000 })).j.id;
    const c1 = (await call('POST', 'sub_certs', { subcontract_id: sc, cumulative: 20000, advance_recovery: 1000 })).j.id; let cv = (await call('GET', 'sub_certs/' + c1)).j;
    assert.equal(cv.gross_this, 20000); assert.equal(cv.retention, 2000); assert.equal(cv.vat, 1000); assert.equal(cv.payable_now, 20000 - 2000 - 1000 + 1000);
    const c2 = (await call('POST', 'sub_certs', { subcontract_id: sc, cumulative: 15000 })).s; assert.equal(c2, 400);       // cumulative cannot go backwards
    assert.equal((await call('POST', `sub_certs/${c1}/approve`)).s, 200); assert.equal((await call('POST', `sub_certs/${c1}/approve`)).s, 400);
    const sbill = (await call('GET', 'sub_certs/' + c1)).j.bill_id, sb = (await call('GET', 'bills/' + sbill)).j; assert.equal(sb.amount, 20000); assert.equal(sb.category, 'subcontract'); assert.equal(sb.paid, 1000);
    assert.equal((await call('PUT', 'sub_certs/' + c1, { cumulative: 30000 })).s, 400);                                        // approved = locked
    const c3 = (await call('POST', 'sub_certs', { subcontract_id: sc, cumulative: 35000 })).j.id; cv = (await call('GET', 'sub_certs/' + c3)).j; assert.equal(cv.previous, 20000); assert.equal(cv.gross_this, 15000);
    const sv = (await call('GET', 'subcontracts/' + sc)).j; assert.equal(sv.certified, 20000); assert.equal(sv.retention_held, 2000);
    const it = (await call('POST', 'stock_items', { name: 'Cement', unit: 'bag', min_qty: 20 })).j.id;
    await call('POST', 'stock_moves', { item_id: it, type: 'in', qty: 100, unit_cost: 10 }); await call('POST', 'stock_moves', { item_id: it, type: 'in', qty: 100, unit_cost: 20 });
    assert.equal((await call('POST', 'stock_moves', { item_id: it, type: 'out', qty: 500 })).s, 400);
    await call('POST', 'stock_moves', { item_id: it, type: 'out', qty: 150, project_id: pid }); const st1 = (await call('GET', 'stock_items/' + it)).j; assert.equal(st1.qty, 50); assert.equal(st1.avg_cost, 15); assert.equal(st1.value, 750);
    const fa = (await call('POST', 'fixed_assets', { name: 'Excavator', purchase_date: '2026-01-15', cost: 120000, salvage: 0, life_years: 5 })).j.id; const far = (await call('GET', 'fixed_assets?as_of=2026-12-31')).j.find(x => x.id === fa);
    assert.equal(far.accumulated, 24000); assert.equal(far.nbv, 96000); assert.equal(far.annual, 24000);
    assert.equal((await call('GET', 'corporate-tax?from=2026-01-01&to=2026-12-31')).j.depreciation, 24000);
    await call('POST', 'petty_topups', { date: '2026-10-01', amount: 500, note: 'float' });
    assert.equal((await call('POST', 'petty_topups/expense', { description: 'Site water', amount: 600 })).s, 400);               // over the float
    assert.equal((await call('POST', 'petty_topups/expense', { description: 'Site water', amount: 100, vat_amount: 5, project_id: pid })).s, 200);
    assert.equal((await call('GET', 'petty_topups')).j.balance, 395);

    // ---- accounting ----
    let fin = (await call('GET', 'financials?from=2026-01-01&to=2026-12-31')).j;
    assert.equal(fin.tb_debit, fin.tb_credit); assert.ok(fin.tb_debit > 0);                                                         // books balance
    assert.equal(fin.balance_sheet.total_assets, round2(fin.balance_sheet.total_liabilities + fin.balance_sheet.total_equity));    // A = L + E
    assert.equal(fin.net_profit, round2(fin.revenue - fin.expenses)); const dep = fin.pl.find(x => x.code === '6100'); assert.ok(dep && dep.amount > 0 && dep.amount <= 24000 && dep.amount % 2000 === 0);   // monthly depreciation posted up to the current month
    const jv = (await call('POST', 'journal_entries', { date: '2026-01-01', memo: 'Opening capital', lines: [{ account: '1000', debit: 100000 }, { account: '3000', credit: 100000 }] })).j.id; assert.ok(jv);
    assert.equal((await call('POST', 'journal_entries', { date: '2026-01-01', lines: [{ account: '1000', debit: 10 }, { account: '3000', credit: 9 }] })).s, 400);   // unbalanced
    assert.equal((await call('POST', 'journal_entries', { date: '2026-01-01', lines: [{ account: '9999', debit: 10 }, { account: '3000', credit: 10 }] })).s, 400);  // unknown account
    const fin2 = (await call('GET', 'financials?from=2026-01-01&to=2026-12-31')).j; assert.equal(fin2.tb_debit, fin2.tb_credit); assert.equal(fin2.trial_balance.find(x => x.code === '3000').credit, 100000);
    const led = (await call('GET', 'ledger?account=3000&from=2026-01-01&to=2026-12-31')).j; assert.equal(led.lines.at(-1).balance, -100000);
    assert.equal((await call('POST', 'accounts', { code: '5800', name: 'Insurance', type: 'expense' })).s, 200); assert.equal((await call('DELETE', 'accounts/1000')).s, 400); assert.equal((await call('POST', 'accounts', { code: 'x', name: 'bad', type: 'expense' })).s, 400);
    // bank reconciliation
    const pay1 = (await call('POST', 'payments', { kind: 'in', amount: 777, invoice_id: inv3, method: 'bank', date: '2026-10-02' })).j.id; assert.ok(pay1);
    const imp = (await call('POST', 'bank/import', { csv: 'date,description,amount\n2026-10-03,TRANSFER CLIENT A,777.00\n2026-10-04,BANK FEES,-25.00\n' })).j; assert.equal(imp.added, 2);
    assert.equal((await call('POST', 'bank/import', { csv: '2026-10-03,TRANSFER CLIENT A,777.00' })).j.added, 0);                       // duplicates skipped
    assert.equal((await call('POST', 'bank/auto-match')).j.matched, 1);
    const bk = (await call('GET', 'bank')).j; assert.equal(bk.lines.filter(l => l.payment_id).length, 1); assert.equal(bk.summary.unmatched_lines, -25);
    // exports
    const exp = await fetch(base + 'export/invoices', { headers: { cookie } }), raw = Buffer.from(await exp.arrayBuffer()), body = raw.toString('utf8'); assert.match(exp.headers.get('content-type'), /text\/csv/); assert.deepEqual([...raw.slice(0, 3)], [0xef, 0xbb, 0xbf]); assert.match(body, /Number,Type/); assert.match(body, /INV-\d{4}-\d+/);
    await call('POST', 'parties', { type: 'client', name: '=HYPERLINK("http://evil")' });
    const pcsv = await (await fetch(base + 'export/parties', { headers: { cookie } })).text(); assert.ok(pcsv.includes("'=HYPERLINK")); assert.ok(!/(^|,)"?=HYPERLINK/m.test(pcsv));
    const csp = (await fetch(base + 'doc/invoices/' + inv3 + '?print=1', { headers: { cookie } })).headers.get('content-security-policy'); assert.match(csp, /script-src 'sha256-/); assert.ok(!/script-src[^;]*unsafe-inline/.test(csp));
    assert.equal((await fetch(base + 'export/nothing', { headers: { cookie } })).status, 404);
    assert.equal((await fetch(base + 'export/trial_balance?from=2026-01-01&to=2026-12-31', { headers: { cookie } })).status, 200);
    assert.ok((await call('GET', 'einvoice')).j.invoices > 0);
    await loginAs('hr1'); assert.equal((await call('GET', 'financials')).s, 403); assert.equal((await fetch(base + 'export/invoices', { headers: { cookie } })).status, 403); cookie = adminCookie;

    // ---- Trigon brand pack, profile and branded e-mail signature ----
    assert.equal((await call('PUT', 'profile', { display_name: 'Mohanad Ayyash', job_title: 'Managing Partner', mobile: '+971 50 000 0000' })).j.display_name, 'Mohanad Ayyash');
    assert.equal((await call('POST', 'brand/pack')).s, 200);
    const stg = (await call('GET', 'settings')).j; assert.equal(stg.company_name_ar, 'تريجون سيفيل للمقاولات ذ.م.م'); assert.equal(stg.license_no, '1656279'); assert.equal(stg.po_box, '334112');
    for (const n of ['logo', 'logo_ar', 'logo_white', 'logo_line', 'mark']) assert.equal((await fetch(base + 'brand/' + n, { headers: { cookie } })).status, 200);   // (the stamp is not part of the public repository)
    const m3 = mails.length; await call('POST', `invoices/${inv3}/email`, { to: 'client@example.com' });
    const sigMail = mails[m3].body; assert.match(sigMail, /multipart\/related/); assert.match(sigMail, /Content-ID: <brandlogo>/);
    const sh = Buffer.from(sigMail.split('multipart/related')[1].split('text/html')[1].split('\n\n')[1].split('--')[0].replace(/\s/g, ''), 'base64').toString(); assert.match(sh, /Mohanad Ayyash/); assert.match(sh, /Managing Partner/); assert.match(sh, /cid:brandlogo/);
    // quotation printed with the brand cover page; letters on the official bilingual letterhead
    const qh = await (await fetch(base + 'doc/quotes/' + q, { headers: { cookie } })).text(); assert.match(qh, /class="cover"/); assert.match(qh, /Quotation for Villa/); assert.match(qh, /class="rules"/);
    assert.ok(!/class="cover"/.test(await (await fetch(base + 'doc/quotes/' + q + '?cover=0', { headers: { cookie } })).text()));
    assert.equal((await call('POST', 'brand/pack')).s, 200);                                                                                  // idempotent
    await loginAs('pm1'); assert.equal((await call('POST', 'brand/pack')).s, 403); cookie = adminCookie;

    // login lockout after repeated failures
    for (let k = 0; k < 8; k++) await call('POST', 'login', { username: 'a', password: 'wrong' });
    assert.equal((await call('POST', 'login', { username: 'a', password: '123456' })).s, 429);
    console.log('ALL TESTS PASSED');
  } catch (e) { console.error('FAIL', e); process.exitCode = 1; }
  server.close(); smtp.close(); process.exit(process.exitCode || 0);
});
