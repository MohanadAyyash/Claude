// End-to-end API test: node --no-warnings test.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-'));
const net = require('net');
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
    assert.equal((await call('POST', 'setup', { username: 'a', password: '123456', company: 'GRC' })).s, 200);
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
    assert.match(qq.number, /^QT-\d{4}-001$/); assert.equal(qq.subtotal, 10000); assert.equal(qq.vat, 500); assert.equal(qq.total, 10500);
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

    // login lockout after repeated failures
    for (let k = 0; k < 8; k++) await call('POST', 'login', { username: 'a', password: 'wrong' });
    assert.equal((await call('POST', 'login', { username: 'a', password: '123456' })).s, 429);
    console.log('ALL TESTS PASSED');
  } catch (e) { console.error('FAIL', e); process.exitCode = 1; }
  server.close(); smtp.close(); process.exit(process.exitCode || 0);
});
