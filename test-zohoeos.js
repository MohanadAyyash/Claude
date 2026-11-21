// Zoho journals always balance: an end-of-service provision split over projects in equal thirds (rounding): node --no-warnings test-zohoeos.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-zohoeos-'));
process.env.ZOHO_NO_SCHEDULER = '1'; process.env.SALES_NO_SCHEDULER = '1';
const mockZoho = require('./tools/zoho-mock.js');
const zoho = mockZoho();
process.env.ZOHO_CLIENT_ID = zoho.CLIENT_ID; process.env.ZOHO_CLIENT_SECRET = zoho.CLIENT_SECRET;      // as the office PC's .env would
const { server, ctx } = require('./server.js');
ctx.db.prepare("UPDATE zoho_config SET value='0' WHERE key='gate_required'").run();

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api/`; let cookie = '';
  const call = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j, t }; };
  const ok = (r, l) => { assert.equal(r.s, 200, `${l || ''} → ${r.s} ${JSON.stringify(r.j).slice(0, 300)}`); return r.j; };
  await new Promise(r => zoho.srv.listen(0, r)); process.env.ZOHO_ACCOUNTS_URL = zoho.accountsUrl;
  const RANGE = { from: '2026-10-01', to: '2026-12-31' }, writes = () => zoho.calls.filter(c => /^(POST|PUT)/.test(c)).length, out = [];
  try {
    ok(await call('POST', 'setup', { username: 'admin', password: 'secret12', company: 'Trigon' }));
    ok(await call('PUT', 'settings', { trn: '100123456700003', mohre_id: '1234567890123', employer_routing: '302620122' }));
    const WPS = { person_code: '12345678901234', routing_code: '302620122', iban: 'AE070331234567890123456' };
    const cl = ok(await call('POST', 'parties', { type: 'client', name: 'Emaar Test', trn: '100000000000003' })).id;
    const A = ok(await call('POST', 'projects', { name: 'Villa 12', client_id: cl, retention_pct: 10, status: 'active' })).id, B = ok(await call('POST', 'projects', { name: 'Roads', client_id: cl, status: 'active' })).id, P3 = ok(await call('POST', 'projects', { name: 'Third', client_id: cl, status: 'active' })).id;
    const inv = ok(await call('POST', 'invoices', { project_id: A, date: '2026-11-05', retention_pct: 10, items: [{ description: 'Excavation', qty: 100, rate: 50 }] })).id;
    // payroll Nov 2026: one worker 10 days on each of three projects (thirds that do not round evenly); one head-office employee
    const w = ok(await call('POST', 'employees', { name: 'Worker', join_date: '2025-01-01', basic: 3100, project_id: A, ...WPS })).id;
    ok(await call('POST', 'employees', { name: 'Accountant', join_date: '2025-01-01', basic: 6000, ...WPS }));
    for (let d = 1; d <= 30; d++) ok(await call('PUT', 'attendance', { employee_id: w, date: `2026-11-${String(d).padStart(2, '0')}`, status: 'present', project_id: d <= 10 ? A : d <= 20 ? B : P3 }));
    ok(await call('POST', 'hr/loans', { employee_id: w, amount: 600, installments: 2, start_month: '2026-11', method: 'cash' }));
    ok(await call('POST', 'payroll/generate', { month: '2026-11' })); ok(await call('POST', 'payroll/finalize', { month: '2026-11' }));
    ok(await call('POST', 'payroll/pay', { month: '2026-11', date: '2026-12-02' }));

    // ---- 3. connect with a grant code (client from .env)
    ok(await call('POST', 'zoho/connect', { code: '1000.code.one' }));
    ok(await call('PUT', 'zoho/config', { enabled: '1', start: '2026-11-01', post: '0' }));

    // ---- 4. mapping: accounts, project → reporting-tag option / Zoho project
    const mp = ok(await call('GET', 'zoho/mapping'));
    assert.ok(mp.zoho.accounts.length > 5); assert.equal(mp.zoho.tags[0].options.length, 2); assert.equal(mp.zoho.projects[0].id, '8001');
    for (const [k, z] of [['acct:5200', '3101'], ['acct:6200', '3101'], ['acct:2200', '3102'], ['acct:2250', '3104'], ['acct:1300', '3103'], ['acct:5260', '3105'], ['acct:2300', '3106'], ['acct:1150', '3202']]) ok(await call('PUT', 'zoho/mapping', { kind: 'account', local_key: k, zoho_id: z }));
    ok(await call('PUT', 'zoho/mapping', { kind: 'project', local_key: A, zoho_id: 'tag:7001:7101' }));
    ok(await call('PUT', 'zoho/mapping', { kind: 'project', local_key: B, zoho_id: 'project:8001' }));

    ok(await call('PUT', 'zoho/mapping', { kind: 'project', local_key: P3, zoho_id: 'tag:7001:7102' }));
    // the provision 3,100 / 30 × 21 / 12 = 180.83 split in thirds is 60.2766…: three lines rounded alone would be 180.84
    const d = ok(await call('POST', 'zoho/dry-run', RANGE));
    for (const p of d.payloads.filter(p => p.path === '/journals')) {
      const ls = p.body.line_items, dr = ls.filter(l => l.debit_or_credit === 'debit').reduce((s, l) => s + l.amount, 0), cr = ls.filter(l => l.debit_or_credit === 'credit').reduce((s, l) => s + l.amount, 0);
      assert.ok(Math.abs(dr - cr) < 0.001, `${p.body.reference_number}: debit ${dr.toFixed(2)} ≠ credit ${cr.toFixed(2)}`);
    }
    const round2 = x => Math.round(x * 100) / 100;
    const r = ok(await call('POST', 'zoho/sync', RANGE)); assert.equal(r.failed, 0, r.message);
    const eos = zoho.T.journals.find(j => j.reference_number === 'EOS-2026-11'); assert.ok(eos, 'the provision journal reached Zoho');
    const debits = eos.line_items.filter(l => l.debit_or_credit === 'debit');
    assert.equal(debits.length, 4, 'three projects + head office');
    assert.equal(round2(debits.reduce((s, l) => s + l.amount, 0)), eos.line_items.find(l => l.debit_or_credit === 'credit').amount);
    console.log('ZOHO JOURNAL BALANCE TESTS PASSED');
  } finally { server.close(); zoho.srv.close(); }
});
