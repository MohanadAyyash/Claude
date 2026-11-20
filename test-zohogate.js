// Zoho gate while VAT registration is pending: READY_NON_VAT / VAT_PENDING, transactions with VAT held, 6150 deferred (asset
// disposals held), and the read-only diagnostic of who already owns an existing Zoho account — all against the Zoho mock.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-zohogate-'));
process.env.ZOHO_NO_SCHEDULER = '1'; process.env.SALES_NO_SCHEDULER = '1';
const mockZoho = require('./tools/zoho-mock.js');
const zoho = mockZoho();
process.env.ZOHO_CLIENT_ID = zoho.CLIENT_ID; process.env.ZOHO_CLIENT_SECRET = zoho.CLIENT_SECRET;
const { server, ctx } = require('./server.js');
ctx.zohoReconPace = 0;

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api/`; let cookie = '';
  const call = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j, t }; };
  const ok = (r, l) => { assert.equal(r.s, 200, `${l || ''} → ${r.s} ${JSON.stringify(r.j).slice(0, 400)}`); return r.j; };
  const T = zoho.T, acct = id => T.chartofaccounts.concat(T.bankaccounts).find(a => a.account_id === id), A = ctx.zohoAcct, out = [];
  const row = (kind, id) => ctx.db.prepare('SELECT * FROM zoho_sync WHERE kind=? AND local_id=?').get(kind, id);
  await new Promise(r => zoho.srv.listen(0, r)); process.env.ZOHO_ACCOUNTS_URL = zoho.accountsUrl;
  try {
    // ---- Trigon: an invoice with VAT and one without, a bill with VAT and one without, partners, petty cash, an asset sold
    ok(await call('POST', 'setup', { username: 'admin', password: 'secret12', company: 'Trigon' }));
    ok(await call('PUT', 'settings', { trn: '100123456700003' }));
    const cl = ok(await call('POST', 'parties', { type: 'client', name: 'Client Test', trn: '100000000000003' })).id, sup = ok(await call('POST', 'parties', { type: 'supplier', name: 'Supplier Test', trn: '100000000000011' })).id;
    const P = ok(await call('POST', 'projects', { name: 'Site A', client_id: cl, status: 'active' })).id;
    const vInv = ok(await call('POST', 'invoices', { project_id: P, date: '2026-11-05', items: [{ description: 'Works', qty: 10, rate: 100 }] })).id;
    const zInv = ok(await call('POST', 'invoices', { project_id: P, date: '2026-11-06', items: [{ description: 'Exported service', qty: 1, rate: 500, vat: 'zero' }] })).id;
    ok(await call('POST', 'payments', { kind: 'in', date: '2026-11-10', amount: 1050, method: 'bank', invoice_id: vInv }));
    const vBill = ok(await call('POST', 'bills', { party_id: sup, date: '2026-11-04', amount: 1000, vat_amount: 50, category: 'materials', project_id: P, reference: 'S-1' })).id;
    const nBill = ok(await call('POST', 'bills', { party_id: sup, date: '2026-11-04', amount: 300, vat_amount: 0, category: 'materials', project_id: P, reference: 'S-2' })).id;
    const PA = ok(await call('POST', 'partners', { name: 'Partner Alpha' })).id;
    ok(await call('POST', `partners/${PA}/shares`, { pct: 100, from_date: '2026-01-01' }));
    ok(await call('POST', 'partner_txns', { partner_id: PA, date: '2026-11-02', type: 'capital_in', amount: 50000, method: 'bank' }));
    ok(await call('POST', 'fixed_assets', { name: 'Old mixer', purchase_date: '2026-10-01', cost: 6000, salvage: 0, life_years: 1, opening: 1, status: 'disposed', disposal_date: '2026-10-20', disposal_proceeds: 7000 }));
    const zinv = ctx.enrich().invoices.find(i => i.id === zInv); assert.ok(Math.abs(zinv.vat) < 0.005, 'the zero-rated invoice carries no VAT');

    // ---- Zoho: VAT not set up (registration pending) — no taxes, no VAT accounts; Petty Cash is a system cash account
    T.taxes.length = 0;
    for (const a of T.chartofaccounts) if (a.account_id === '3201') a.is_system_account = true;
    const coded = { 3102: '2200', 3104: '2250', 3106: '2300', 3101: '5200', 3105: '5260', 3202: '1150', 3103: '1300' };
    for (const a of T.chartofaccounts) if (coded[a.account_id]) a.account_code = coded[a.account_id];
    T.bankaccounts.find(a => a.account_id === '2001').account_code = '1000';
    T.bankaccounts.find(a => a.account_id === '2002').is_system_account = true;            // "Petty Cash", system, cash, no code
    T.bankaccounts.push({ account_id: '2003', account_name: 'Cash on Hand', account_code: '1020', account_type: 'cash', is_active: true });   // the right account for 1020
    T.chartofaccounts.push({ account_id: '3301', account_name: 'Accounts Payable', account_type: 'accounts_payable', is_active: true, is_system_account: true },
      { account_id: '3501', account_name: 'Retained Earnings', account_type: 'equity', is_active: true, is_system_account: true },
      { account_id: '3801', account_name: 'Office Salaries', account_code: '6200', account_type: 'expense', is_active: true });
    for (const code of [...new Set(Object.keys(ctx.zohoX.CAT).map(c => ctx.expenseCode(c)))].filter(c => !['1600', '5200', '6200'].includes(c))) T.chartofaccounts.push({ account_id: 'C-' + code, account_name: 'Cost ' + code, account_code: code, account_type: 'expense', is_active: true });
    ok(await call('POST', 'zoho/connect', { code: '1000.code.one' }));
    ok(await call('PUT', 'zoho/config', { enabled: '1', start: '2026-10-01', start_v2: '2026-10-01', post: '1' }));
    // as in production: cash on hand (1020) was mapped to Zoho's "Petty Cash" on the mapping screen, before provisioning existed
    ok(await call('PUT', 'zoho/mapping', { kind: 'account', local_key: 'acct:1020', zoho_id: '2002', label: 'Petty Cash (cash)' }));
    ok(await call('PUT', 'zoho/mapping', { kind: 'account', local_key: 'acct:4000', zoho_id: '3004' }));
    const map1020 = JSON.stringify(ctx.db.prepare("SELECT * FROM zoho_map WHERE local_key='acct:1020'").get());

    // ---- 1. who owns Zoho's Petty Cash: read only, the mapping is not touched
    let n0 = zoho.calls.length; ok(await call('POST', 'zoho-sync/preflight'));
    let pv = ok(await call('GET', 'zoho-sync/preview')); assert.deepEqual(zoho.calls.slice(n0).filter(c => !/^GET /.test(c)), []);
    const pc = pv.rows.find(r => r.key === 'acct:1010'), own = pc.name_match.owned_by;
    assert.equal(pc.name_match.is_system_account, true); assert.equal(pc.name_match.account_type, 'cash'); assert.equal(pc.name_match.involved_in_transaction, false);
    assert.equal(own.length, 1); assert.equal(own[0].trigon_code, '1020'); assert.equal(own[0].mapping_source, 'mapping screen (before provisioning) — legacy mapping'); assert.match(own[0].legacy_audit[0], /admin: account acct:1020 → 2002/);
    // the legacy 1020 → Petty Cash mapping is detected and a Trigon-side repair is proposed: remove 1020's mapping only, adopt the same id for 1010
    assert.equal(pc.classification, 'ADOPT_EXISTING_AFTER_CONFIRMATION'); assert.equal(pc.reason, 'LEGACY_MAPPING_REPAIR'); assert.equal(pc.repair.state, 'PROPOSED');
    assert.ok(Object.values(pc.repair.checks).every(Boolean), JSON.stringify(pc.repair.checks)); assert.equal(Object.keys(pc.repair.checks).length, 9);
    assert.deepEqual(pc.repair.operations.map(o => [o.op, o.trigon_key, o.zoho_id]), [['REMOVE_MAPPING_ONLY', 'acct:1020', '2002'], ['ADOPT_EXISTING', 'acct:1010', '2002'], ['ADOPT_EXISTING', 'acct:1020', '2003']]);
    assert.match(pc.repair.zoho_changes, /^none/); assert.ok(pv.confirmable.some(c => c.key === 'repair:1020>1010'));
    // 1020 resolved on its own (exact code + cash), never the same account as 1010; nothing adopted outside the repair
    const r20 = pv.rows.find(r => r.key === 'acct:1020'); assert.equal(r20.classification, 'ADOPT_EXISTING'); assert.equal(r20.zoho.id, '2003'); assert.equal(r20.pending_repair, 'repair:1020>1010');
    assert.ok(!pv.adopts.some(a => ['acct:1010', 'acct:1020'].includes(a.key)), 'the repair is not part of the ordinary adoptions');
    assert.equal(JSON.stringify(ctx.db.prepare("SELECT * FROM zoho_map WHERE local_key='acct:1020'").get()), map1020, 'the owning mapping is not modified by the preview');
    out.push('legacy 1020 → Petty Cash detected; repair proposed (REMOVE_MAPPING_ONLY 1020, ADOPT_EXISTING 1010 on the same id, 1020 → Cash on Hand by code); 9 checks; preview changes nothing');

    // each safety condition blocks the reassignment on its own (LEGACY_MAPPING_REPAIR_BLOCKED) — nothing repaired
    const blockedBy = async (setup, undo, check) => { setup(); const q = await A.plan(), r = q.rows.find(x => x.key === 'acct:1010'); undo();
      assert.equal(r.reason, 'LEGACY_MAPPING_REPAIR_BLOCKED', check); assert.equal(r.repair.checks[check], false, check); assert.ok(!q.confirmable.some(c => c.key === 'repair:1020>1010')); };
    const pcA = acct('2002');
    await blockedBy(() => { pcA.is_involved_in_transaction = true; }, () => { delete pcA.is_involved_in_transaction; }, 'involved_in_transaction_false');
    await blockedBy(() => { pcA.account_type = 'other_current_asset'; }, () => { pcA.account_type = 'cash'; }, 'type_cash');
    await blockedBy(() => { pcA.is_active = false; }, () => { pcA.is_active = true; }, 'active');
    await blockedBy(() => ctx.db.prepare("UPDATE zoho_map SET mapped_at='2026-11-01 10:00:00' WHERE local_key='acct:1020'").run(), () => ctx.db.prepare("UPDATE zoho_map SET mapped_at=NULL WHERE local_key='acct:1020'").run(), 'current_owner_is_exactly_legacy_acct_1020');
    await blockedBy(() => ctx.db.prepare(`INSERT INTO zoho_sync(kind,local_id,zoho_id,zoho_type,status,sent_eff) VALUES('payment',999,'Z9','customerpayment','ok','{"lines":[[1,"","2002"]]}')`).run(), () => ctx.db.prepare("DELETE FROM zoho_sync WHERE local_id=999").run(), 'no_synchronized_object_depends_on_it');
    await blockedBy(() => { acct('2003').account_code = ''; }, () => { acct('2003').account_code = '1020'; }, 'new_1020_target_resolved_for_an_atomic_repair');
    { acct('2003').account_code = ''; const q = await A.plan(), r = q.rows.find(x => x.key === 'acct:1010'); acct('2003').account_code = '1020';
      assert.equal(r.repair.next_for_old_code.reason, 'CREATE_NEEDS_APPROVAL'); assert.deepEqual(r.repair.next_for_old_code.payload, { account_name: 'Cash on Hand', account_code: '1020', account_type: 'cash' }); assert.ok(!q.mutations.some(m => m.body.account_code === '1020'), 'not created unless approved'); }
    out.push('reassignment blocked (LEGACY_MAPPING_REPAIR_BLOCKED) by: transactions on the account, wrong type, inactive, a non-legacy owner, a synchronised object using it, no target for 1020 (then: CREATE_NEEDS_APPROVAL Cash on Hand / 1020 / cash, not created)');

    // 1010 and 1020 can never be on one Zoho account — on the mapping screen either
    const bad = await call('PUT', 'zoho/mapping', { kind: 'account', local_key: 'acct:1010', zoho_id: '2002' }); assert.equal(bad.s, 400); assert.match(bad.j.error, /must be different accounts/);
    assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM zoho_map WHERE local_key='acct:1010'").get().n, 0);
    out.push('1010 and 1020 can never map to the same Zoho id (the mapping screen refuses it too)');

    // ---- 2. VAT pending and 6150 deferred, in the preview
    assert.equal(pv.vat_state, 'VAT_PENDING'); assert.match(pv.vat_diagnostic.uae_vat_enabled, /^no/); assert.equal(pv.vat_diagnostic.standard_5_active, null);
    assert.deepEqual(pv.vat.map(v => v.classification), ['VAT_CONFIGURATION_REQUIRED', 'VAT_CONFIGURATION_REQUIRED', 'VAT_CONFIGURATION_REQUIRED']);
    const r6150 = pv.rows.find(r => r.key === 'acct:6150'); assert.equal(r6150.reason, 'DEFERRED_ACCOUNTING_CHANGE'); assert.ok(!pv.mutations.some(m => m.body.account_code === '6150'));
    assert.deepEqual(pv.deferred.map(d => d.code), ['6150']); assert.match(pv.decisions[2].treatment, /Gain on Asset Disposal → Other Income; Loss on Asset Disposal → Other Expense/);
    assert.equal(pv.targets.blocking_conflicts, 3, 'full targets: the three VAT items'); assert.deepEqual(pv.targets_non_vat, { missing_mappings: pv.targets_non_vat.missing_mappings, wrong_types: 0, ambiguous_matches: 0, blocking_conflicts: 0 });
    out.push('preview: VAT_PENDING (3 × VAT_CONFIGURATION_REQUIRED, diagnostic "no"), 6150 deferred — never created, not counted');

    // ---- 3. a non-VAT conflict keeps the gate closed; resolved by code (an "Office Float" coded 1010) → READY_NON_VAT
    let g = await A.preflightAndGate('test', 'test'); assert.equal(g.gate.state, 'NOT_READY', 'not ready before the repair');
    assert.equal(g.gate.expected_after_provisioning.state, 'READY_NON_VAT', JSON.stringify(g.gate.expected_after_provisioning)); assert.deepEqual(g.gate.expected_after_provisioning.targets_non_vat, { missing_mappings: 0, wrong_types: 0, ambiguous_matches: 0, blocking_conflicts: 0 });
    out.push('gate: NOT_READY today; expected after provisioning with the repair: READY_NON_VAT (0 / 0 / 0 / 0), VAT_PENDING and 6150 not blocking');
    pv = ok(await call('GET', 'zoho-sync/preview'));
    // a failure in the middle of the repair: everything rolls back (mappings and audit), nothing in Zoho
    const audit0 = ctx.db.prepare("SELECT * FROM audit_log WHERE tbl='zoho_map' ORDER BY id").all(), zw0 = zoho.calls.filter(c => !/^GET /.test(c)).length;
    for (const step of ['removed', 'adopted', 'remapped', 'audited']) {
      A._repairHook = st => { if (st === step) throw new Error('simulated failure after ' + st); };
      const res = await A.apply(await A.plan(), { user: 'admin', confirmed: ['repair:1020>1010'], only: () => false });
      assert.ok(res.failed.some(f => /LEGACY_MAPPING_REPAIR: simulated failure after/.test(f.error)), step);
      assert.equal(JSON.stringify(ctx.db.prepare("SELECT * FROM zoho_map WHERE local_key='acct:1020'").get()), map1020, 'rolled back: ' + step);
      assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM zoho_map WHERE local_key='acct:1010'").get().n, 0, step);
      assert.deepEqual(ctx.db.prepare("SELECT * FROM audit_log WHERE tbl='zoho_map' ORDER BY id").all(), audit0, 'no audit written: ' + step);
    }
    A._repairHook = null; assert.equal(zoho.calls.filter(c => !/^GET /.test(c)).length, zw0, 'nothing sent to Zoho');
    out.push('a failure after any step of the repair rolls the whole repair back (mappings and audit unchanged)');
    // without the confirmation nothing is repaired (and 1020 is not re-mapped on its own either)
    await A.apply(await A.plan(), { user: 'admin', confirmed: [], only: () => false });
    assert.equal(JSON.stringify(ctx.db.prepare("SELECT * FROM zoho_map WHERE local_key='acct:1020'").get()), map1020); assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM zoho_map WHERE local_key='acct:1010'").get().n, 0);
    // even if Zoho's Petty Cash also carried code 1020, 1020 is never resolved to the account 1010 takes
    acct('2002').account_code = '1020'; { const q = await A.plan(), r = q.rows.find(x => x.key === 'acct:1010'); acct('2002').account_code = '';
      assert.equal(r.repair.state, 'PROPOSED'); assert.equal(r.repair.operations[2].zoho_id, '2003'); assert.notEqual(r.repair.operations[2].zoho_id, r.repair.operations[1].zoho_id); }
    out.push('no repair without the explicit confirmation; 1020 is never resolved to the account 1010 takes');
    // confirmed: one Trigon transaction; no Zoho call for it; history kept; a new audit entry with every field
    const zw = zoho.calls.length;
    const prov = ok(await call('POST', 'zoho-sync/provision', { confirm: true, token: pv.token, confirm_adopt: ['repair:1020>1010'] }));
    assert.deepEqual(prov.result.repaired.map(x => x.key), ['repair:1020>1010']);
    assert.equal(ctx.db.prepare("SELECT zoho_id FROM zoho_map WHERE local_key='acct:1010'").get().zoho_id, '2002'); assert.equal(ctx.db.prepare("SELECT zoho_id FROM zoho_map WHERE local_key='acct:1020'").get().zoho_id, '2003');
    assert.deepEqual(zoho.calls.slice(zw).filter(c => !/^GET /.test(c) && c !== 'POST /chartofaccounts'), [], 'no Zoho change but the approved account creations');
    assert.ok(acct('2002').account_name === 'Petty Cash' && acct('2002').is_active && !acct('2002').account_code && acct('2002').account_type === 'cash', "Zoho's Petty Cash untouched");
    const audits = ctx.db.prepare("SELECT * FROM audit_log WHERE tbl='zoho_map' ORDER BY id").all();
    assert.ok(audit0.length && audit0.every(a => audits.some(b => b.id === a.id && b.detail === a.detail && b.ts === a.ts)), 'the mapping-screen history is kept');
    const rep1 = audits.filter(a => a.action === 'legacy_mapping_repair'); assert.equal(rep1.length, 1); const det = JSON.parse(rep1[0].detail);
    assert.equal(rep1[0].user, 'admin'); assert.ok(rep1[0].ts);
    for (const [k, v] of Object.entries({ reason: 'legacy_mapping_repair', actor: 'admin', old_trigon_code: '1020', new_trigon_code: '1010', zoho_account_id: '2002' })) assert.equal(det[k], v, k);
    assert.match(det.previous_mapping_source, /legacy/); assert.ok(det.previous_mapped_at); assert.match(det.confirmation, /confirmed repair:1020>1010/); assert.equal(det.new_mapping_for_old_code.zoho_id, '2003');
    out.push('repair applied on confirmation: 1010 → Petty Cash (same id), 1020 → Cash on Hand, one transaction, no Zoho call for it; old history kept; audit: actor, time, codes, Zoho id, reason, previous source / date, confirmation');
    // rerun: nothing to repair, nothing changes, no second audit entry
    const again = await A.plan(); assert.ok(!again.rows.some(r => r.repair)); assert.equal(again.rows.find(r => r.key === 'acct:1010').classification, 'ADOPT_EXISTING');
    await A.apply(again, { user: 'admin', confirmed: ['repair:1020>1010'] }); assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='legacy_mapping_repair'").get().n, 1);
    assert.equal(ctx.db.prepare("SELECT zoho_id FROM zoho_map WHERE local_key='acct:1020'").get().zoho_id, '2003');
    out.push('rerun after success: idempotent (no repair proposed, mappings unchanged, no second audit entry)');
    // provisioning itself refuses to put 1030 (or 1020) on the account 1010 holds
    await assert.rejects(A.apply({ token: 't', rows: [{ key: 'acct:1030', name: 'x', zoho: { id: '2002', name: 'Petty Cash', type: 'cash', code: '' } }], vat: [], mutations: [], adopts: [{ key: 'acct:1030', zoho_id: '2002', how: 'test' }] }, { user: 'admin' }), /SAME_ZOHO_ACCOUNT/);
    assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM zoho_map WHERE local_key='acct:1030' AND zoho_id='2002'").get().n, 0);

    assert.equal(prov.gate.state, 'READY_NON_VAT', JSON.stringify(prov.gate.reasons)); assert.equal(prov.gate.vat, 'VAT_PENDING'); assert.equal(ctx.zohoX.cfg().gate, 'READY_NON_VAT');
    assert.deepEqual(prov.gate.targets_non_vat, { missing_mappings: 0, wrong_types: 0, ambiguous_matches: 0, blocking_conflicts: 0 });
    assert.ok(prov.gate.targets.blocking_conflicts > 0, 'the full gate stays closed'); assert.equal(prov.gate.ready, false); assert.match(prov.gate.reasons[0], /^VAT_PENDING/);
    out.push('after the repair: gate READY_NON_VAT (non-VAT targets 0 / 0 / 0 / 0), VAT_PENDING, full gate still closed');

    // ---- 4. a send now: non-VAT records go; everything with VAT is held (no Zoho call for it); the disposal is held
    const r1 = ok(await call('POST', 'zoho/sync', {}));
    assert.equal(row('invoice', vInv).status, 'held'); assert.match(row('invoice', vInv).error, /^VAT_PENDING/); assert.equal(row('invoice', vInv).zoho_id, null);
    assert.equal(row('bill', vBill).status, 'held'); assert.match(row('bill', vBill).error, /^VAT_PENDING/);
    const pay = ctx.db.prepare("SELECT * FROM zoho_sync WHERE kind='payment'").get(); assert.equal(pay.status, 'held');
    assert.equal(row('invoice', zInv).status, 'ok', 'the zero-rated invoice is sent'); assert.equal(row('bill', nBill).status, 'ok', 'the bill without VAT is sent');
    assert.equal(T.invoices.length, 1); assert.ok(T.invoices.every(i => i.invoice_number !== ctx.enrich().invoices.find(x => x.id === vInv).number));
    assert.ok(T.bills.every(b => b.bill_number !== 'S-1'), 'the VAT bill never reached Zoho');
    const disp = ctx.db.prepare("SELECT * FROM zoho_sync WHERE kind='jv_asset' AND error LIKE 'ACCOUNTING_CHANGE_PENDING%'").get(); assert.ok(disp && disp.status === 'held', 'the disposal (6150) is held');
    assert.ok(ctx.db.prepare("SELECT COUNT(*) n FROM zoho_sync WHERE kind='jv_partner' AND status='ok'").get().n >= 1, 'partner journals sent');
    assert.ok(!T.journals.some(j => j.line_items.some(l => ['3401', '3402'].includes(l.account_id))));
    const st = ok(await call('GET', 'zoho-sync')); assert.equal(st.gate, 'READY_NON_VAT'); assert.equal(st.vat, 'VAT_PENDING'); assert.equal(st.continuous, false, 'continuous sync stays off'); assert.ok(st.queue.held >= 4);
    // held records are re-checked each run without any Zoho write
    const w = zoho.calls.filter(c => !/^GET /.test(c)).length; ok(await call('POST', 'zoho/sync', {})); assert.equal(zoho.calls.filter(c => !/^GET /.test(c)).length, w);
    out.push(`send with READY_NON_VAT: ${r1.sent} non-VAT record(s) sent; VAT invoice, VAT bill and its payment held (VAT_PENDING); the disposal held (ACCOUNTING_CHANGE_PENDING); continuous off`);

    // ---- 5. reconciliation shows the held records as BLOCKED with their reason
    const rc = await A.reconcile({ cutoff: ctx.today() });
    assert.equal(rc.items.find(x => x.kind === 'invoice' && x.local_id === vInv).status, 'BLOCKED'); assert.match(rc.items.find(x => x.kind === 'invoice' && x.local_id === vInv).note, /VAT_PENDING/);
    out.push('reconciliation: held records reported as BLOCKED (VAT_PENDING / ACCOUNTING_CHANGE_PENDING)');

    // ---- a non-VAT blocker still closes the non-VAT gate (a document already in Zoho under the same number: possible duplicate)
    const z2 = ok(await call('POST', 'invoices', { project_id: P, date: '2026-11-12', items: [{ description: 'Export 2', qty: 1, rate: 200, vat: 'zero' }] })).id;
    const num2 = ctx.enrich().invoices.find(i => i.id === z2).number;
    T.invoices.push({ invoice_id: '9990555', invoice_number: num2, customer_id: 'x', date: '2026-11-12', status: 'sent', line_items: [], total: 200, balance: 200 });
    g = await A.preflightAndGate('test', 'duplicate'); assert.equal(g.gate.state, 'NOT_READY'); assert.ok(g.gate.targets_non_vat.blocking_conflicts > 0); assert.ok(g.gate.reasons.some(x => /possible duplicate/.test(x)));
    T.invoices.pop(); g = await A.preflightAndGate('test', 'resolved'); assert.equal(g.gate.state, 'READY_NON_VAT', JSON.stringify(g.gate.reasons));
    out.push('a non-VAT blocker (possible duplicate) closes the non-VAT gate; once resolved it is READY_NON_VAT again');

    // ---- 6. once VAT is configured in Zoho (by its people) and adopted: READY; the VAT records go; 6150 stays held
    T.taxes.push({ tax_id: '1001', tax_name: 'Standard Rate', tax_percentage: 5, tax_type: 'tax' }, { tax_id: '1002', tax_name: 'Zero Rate', tax_percentage: 0, tax_type: 'tax' });
    T.chartofaccounts.push({ account_id: '3401', account_name: 'Input VAT', account_type: 'input_tax', is_active: true, is_system_account: true }, { account_id: '3402', account_name: 'Output VAT', account_type: 'output_tax', is_active: true, is_system_account: true });
    ok(await call('POST', 'zoho-sync/preflight')); pv = ok(await call('GET', 'zoho-sync/preview')); assert.equal(pv.vat_state, 'VAT_TO_ADOPT');
    const prov2 = ok(await call('POST', 'zoho-sync/provision', { confirm: true, token: pv.token })); assert.equal(prov2.gate.state, 'READY', JSON.stringify(prov2.gate.reasons)); assert.equal(prov2.gate.vat, 'VAT_READY');
    ok(await call('POST', 'zoho/sync', {}));
    assert.equal(row('invoice', vInv).status, 'ok'); assert.equal(row('bill', vBill).status, 'ok'); assert.equal(ctx.db.prepare("SELECT status FROM zoho_sync WHERE kind='payment'").get().status, 'ok');
    assert.equal(ctx.db.prepare('SELECT status FROM zoho_sync WHERE id=?').get(disp.id).status, 'held', '6150 still deferred');
    out.push('VAT configured in Zoho and adopted: gate READY, the held VAT records are sent; the disposal stays held until the 6150 accounting change');

    console.log(out.map(x => '  ✔ ' + x).join('\n'));
    console.log('ZOHO GATE (VAT PENDING) TESTS PASSED');
  } finally { server.close(); zoho.srv.close(); }
});
