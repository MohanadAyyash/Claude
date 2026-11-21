// Zoho new types and history: what was sent the old way stays as it was, nothing dated before the new types' start date is sent,
// a movement deleted here is removed there, salaries paid by date (a held salary does not hold the month): node --no-warnings test-zohohist.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-zohohist-'));
process.env.ZOHO_NO_SCHEDULER = '1'; process.env.SALES_NO_SCHEDULER = '1';
const mockZoho = require('./tools/zoho-mock.js');
const zoho = mockZoho();
process.env.ZOHO_CLIENT_ID = zoho.CLIENT_ID; process.env.ZOHO_CLIENT_SECRET = zoho.CLIENT_SECRET;      // as the office PC's .env would
const { server, ctx } = require('./server.js');
// this suite tests the send engine itself: the READY gate of the account-provisioning workflow is tested in test-zohoacct.js
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
    const A = ok(await call('POST', 'projects', { name: 'Villa 12', client_id: cl, retention_pct: 10, status: 'active' })).id, B = ok(await call('POST', 'projects', { name: 'Roads', client_id: cl, status: 'active' })).id;
    const inv = ok(await call('POST', 'invoices', { project_id: A, date: '2026-11-05', retention_pct: 10, items: [{ description: 'Excavation', qty: 100, rate: 50 }] })).id;
    // payroll Nov 2026: one worker 20 days on A, 10 on B; one head-office employee; an advance paid in cash
    const w = ok(await call('POST', 'employees', { name: 'Worker', join_date: '2025-01-01', basic: 3000, project_id: A, ...WPS })).id;
    ok(await call('POST', 'employees', { name: 'Accountant', join_date: '2025-01-01', basic: 6000, ...WPS }));
    for (let d = 1; d <= 30; d++) ok(await call('PUT', 'attendance', { employee_id: w, date: `2026-11-${String(d).padStart(2, '0')}`, status: 'present', project_id: d <= 20 ? A : B }));
    ok(await call('POST', 'hr/loans', { employee_id: w, amount: 600, installments: 2, start_month: '2026-11', method: 'cash' }));
    ok(await call('POST', 'payroll/generate', { month: '2026-11' })); ok(await call('POST', 'payroll/finalize', { month: '2026-11' }));
    ok(await call('POST', 'payroll/pay', { month: '2026-11', date: '2026-12-02' }));

    // ---- 3. connect with a grant code (client from .env)
    ok(await call('POST', 'zoho/connect', { code: '1000.code.one' }));
    ok(await call('PUT', 'zoho/config', { enabled: '1', start: '2026-11-01', post: '0' }));   // no start date for the new types yet

    // ---- 4. mapping: accounts, project → reporting-tag option / Zoho project
    const mp = ok(await call('GET', 'zoho/mapping'));
    assert.ok(mp.zoho.accounts.length > 5); assert.equal(mp.zoho.tags[0].options.length, 2); assert.equal(mp.zoho.projects[0].id, '8001');
    for (const [k, z] of [['acct:5200', '3101'], ['acct:6200', '3101'], ['acct:2200', '3102'], ['acct:2250', '3104'], ['acct:1300', '3103'], ['acct:5260', '3105'], ['acct:2300', '3106'], ['acct:1150', '3202']]) ok(await call('PUT', 'zoho/mapping', { kind: 'account', local_key: k, zoho_id: z }));
    ok(await call('PUT', 'zoho/mapping', { kind: 'project', local_key: A, zoho_id: 'tag:7001:7101' }));
    ok(await call('PUT', 'zoho/mapping', { kind: 'project', local_key: B, zoho_id: 'project:8001' }));

    const PA = ok(await call('POST', 'partners', { name: 'Partner Alpha' })).id, PB = ok(await call('POST', 'partners', { name: 'Partner Beta' })).id;
    ok(await call('POST', 'partner_txns', { partner_id: PA, date: '2026-11-02', type: 'capital_in', amount: 50000, method: 'bank' }));
    ok(await call('POST', 'petty_topups', { date: '2026-11-03', amount: 2000, note: 'office float' }));
    ok(await call('POST', 'petty_topups/expense', { date: '2026-11-07', description: 'Office water', amount: 100, vat_amount: 5 }));

    // ---- 1. the old way: the expense paid from the first Zoho cash account; partners and petty cash transfers not sent
    let r = ok(await call('POST', 'zoho/sync', RANGE)); assert.equal(r.failed, 0, r.message);
    const water = () => zoho.T.expenses.find(x => (x.description || '').startsWith('Office water'));
    assert.equal(water().paid_through_account_id, '2002');
    assert.equal(zoho.T.journals.filter(j => /^(PTR|PETTY)-/.test(j.reference_number)).length, 0, 'new types not sent while switched off');
    assert.equal(zoho.T.journals.filter(j => j.reference_number === 'PAY-2026-11').length, 2, 'November: accrual + salaries paid as one journal');
    out.push('switched off: only the old types are sent');

    // ---- 2. switch the new types on from 2026-11-05; map what they need
    ok(await call('PUT', 'zoho/config', { start_v2: '2026-11-05' }));
    const acc = (code, type, bank) => { const id = 'Z' + code.replace(/\D/g, ''); (bank ? zoho.T.bankaccounts : zoho.T.chartofaccounts).push({ account_id: id, account_name: 'Trigon ' + code, account_type: type, is_active: true }); return id; };
    for (const [code, type, bank] of [['1010', 'cash', 1], ['3000:p' + PA, 'equity'], ['3110:p' + PA, 'equity']]) ok(await call('PUT', 'zoho/mapping', { kind: 'account', local_key: 'acct:' + code, zoho_id: acc(code, type, bank) }));
    const wd = ok(await call('POST', 'partner_txns', { partner_id: PA, date: '2026-11-06', type: 'withdrawal', amount: 700, method: 'bank' })).id;
    const tp = ok(await call('POST', 'petty_topups', { date: '2026-11-08', amount: 500, note: 'office float' })).id;
    // December payroll: one salary paid on 28 December, the other held and paid on 30 December
    ok(await call('POST', 'payroll/generate', { month: '2026-12' })); ok(await call('POST', 'payroll/finalize', { month: '2026-12' })); ok(await call('POST', 'payroll/pay', { month: '2026-12', date: '2026-12-28' }));
    const dec = ctx.db.prepare("SELECT id, net FROM payroll WHERE month='2026-12' ORDER BY id").all(); assert.equal(dec.length, 2);
    ctx.db.prepare('UPDATE payroll SET paid_date=NULL WHERE id=?').run(dec[1].id);

    // ---- 3. the preflight before sending: history unchanged, nothing before the start date, the new ones planned
    const d = ok(await call('POST', 'zoho/dry-run', RANGE)).preflight, it = (k, ref) => d.items.find(i => i.kind === k && (i.ref === ref || i.local_id === ref));
    const wb = ctx.db.prepare("SELECT id FROM bills WHERE description='Office water'").get().id;
    assert.equal(d.items.find(i => i.kind === 'bill' && i.local_id === wb).action, 'unchanged', 'the expense sent the old way is not rewritten');
    assert.ok(!d.items.some(i => i.kind === 'jv_partner' && i.ref === 'PTR-1'), 'the capital of 2 November is before the start date: not sent');
    assert.ok(!d.items.some(i => i.kind === 'jv_petty' && i.local_id === 1), 'the top-up of 3 November: not sent');
    assert.equal(it('jv_partner', wd).action, 'create'); assert.equal(it('jv_petty', tp).action, 'create');
    assert.ok(!d.items.some(i => i.kind === 'jv_paypaid_d' && i.ref.startsWith('PAY-2026-11-')), 'November was sent as one journal: kept as it is');
    out.push('preflight: history unchanged, nothing before the start date, new movements planned');

    r = ok(await call('POST', 'zoho/sync', RANGE)); assert.equal(r.failed, 0, r.message);
    assert.ok(!zoho.calls.some(c => /^PUT \/expenses/.test(c)), 'no expense was updated'); assert.equal(water().paid_through_account_id, '2002');
    assert.equal(zoho.T.journals.filter(j => j.reference_number === 'PAY-2026-11').length, 2);
    const paidDec = zoho.T.journals.filter(j => /^PAY-2026-12-/.test(j.reference_number));
    assert.deepEqual(paidDec.map(j => [j.reference_number, j.line_items[0].amount]), [['PAY-2026-12-2026-12-28', dec[0].net]], 'only the salary paid so far — the held one does not hold the month back');
    // the held salary paid later: its own journal
    ctx.db.prepare("UPDATE payroll SET paid_date='2026-12-30' WHERE id=?").run(dec[1].id);
    ok(await call('POST', 'zoho/sync', RANGE));
    assert.deepEqual(zoho.T.journals.filter(j => /^PAY-2026-12-/.test(j.reference_number)).map(j => j.line_items[0].amount), [dec[0].net, dec[1].net]);
    out.push('salaries paid by date: the held salary goes on its own date');

    // ---- 4. deleted here → removed there
    const jWd = zoho.T.journals.find(j => j.reference_number === `PTR-${wd}`); assert.ok(jWd);
    ok(await call('DELETE', `partner_txns/${wd}`));
    const pre = ok(await call('POST', 'zoho/dry-run', RANGE)).preflight;
    assert.equal(pre.items.find(i => i.kind === 'jv_partner' && i.local_id === wd).action, 'remove');
    ok(await call('POST', 'zoho/sync', RANGE));
    assert.ok(!zoho.T.journals.includes(jWd), 'the withdrawal journal was deleted in Zoho');
    assert.equal(ctx.db.prepare("SELECT status FROM zoho_sync WHERE kind='jv_partner' AND local_id=?").get(wd).status, 'cancelled');
    out.push('a movement deleted here is removed from Zoho');

    // ---- 5. a partner without his own Zoho accounts: not sent, the missing mapping is named
    ok(await call('POST', 'partner_txns', { partner_id: PB, date: '2026-11-20', type: 'deposit', amount: 300, method: 'bank' }));
    const e5 = ok(await call('POST', 'zoho/dry-run', RANGE));
    assert.ok(e5.errors.some(x => new RegExp(`map our account 3110 of partner #${PB}`).test(x)), e5.errors.join(' | '));
    assert.ok(e5.preflight.missing_accounts.some(a => a.code === '3110:p' + PB));
    out.push('a partner without his own Zoho accounts: reported, not sent');

    console.log(out.map(x => '  ✔ ' + x).join('\n'));
    console.log('ZOHO HISTORY TESTS PASSED');
  } finally { server.close(); zoho.srv.close(); }
});
