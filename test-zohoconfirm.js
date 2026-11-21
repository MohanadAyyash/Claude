// The confirmation checkbox of the account preview (public/zoho.js) and the legacy mapping repair it confirms, against the Zoho mock:
// the state of the real organisation after the approved accounts exist (nothing left to create), 1020 still mapped to Petty Cash.
//   node --no-warnings test-zohoconfirm.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert'), vm = require('vm');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-zohoconfirm-'));
process.env.ZOHO_NO_SCHEDULER = '1'; process.env.SALES_NO_SCHEDULER = '1';
const mockZoho = require('./tools/zoho-mock.js');
const zoho = mockZoho();
process.env.ZOHO_CLIENT_ID = zoho.CLIENT_ID; process.env.ZOHO_CLIENT_SECRET = zoho.CLIENT_SECRET;
const { server, ctx } = require('./server.js');
ctx.zohoReconPace = 0;

// the browser code of the Zoho page, loaded as the browser does (its globals from app.js: tr, esc); English labels
const ui = { PAGES: {}, tr: (ar, en) => en, esc: s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'public', 'zoho.js'), 'utf8'), ui);
const boxes = html => [...html.matchAll(/<input type="checkbox" class="zs-confirm" value="([^"]*)"/g)].map(m => m[1].replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
// what the "Provision approved accounts" button sends: the values of the ticked .zs-confirm boxes (here: all of them ticked)
const provisionBody = (preview, ticked) => ({ confirm: true, token: preview.token, confirm_adopt: ticked });

const PETTY = '1561314000000000361', CASH = '1561314000000130002', RE = '1561314000000000379';

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api/`; let cookie = '';
  const call = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j }; };
  const ok = (r, l) => { assert.equal(r.s, 200, `${l || ''} → ${r.s} ${JSON.stringify(r.j).slice(0, 400)}`); return r.j; };
  const T = zoho.T, out = [], db = ctx.db, mapOf = k => db.prepare("SELECT * FROM zoho_map WHERE kind='account' AND local_key=?").get(k);
  await new Promise(r => zoho.srv.listen(0, r)); process.env.ZOHO_ACCOUNTS_URL = zoho.accountsUrl;
  try {
    // ---- A. rendering (unit): the checkbox submits the key the preview lists in p.confirmable
    { const repairRow = { key: 'acct:1010', code: '1010', name: 'Petty Cash', classification: 'ADOPT_EXISTING_AFTER_CONFIRMATION', reason: 'LEGACY_MAPPING_REPAIR', repair: { key: 'repair:1020>1010', state: 'PROPOSED' }, zoho: { id: PETTY, name: 'Petty Cash', type: 'cash' } };
      const nameRow = { key: 'acct:2400', code: '2400', name: 'Advances from Customers', classification: 'ADOPT_EXISTING_AFTER_CONFIRMATION', reason: 'NAME_IN_USE', zoho: { id: '77', name: 'Advances from Customers', type: 'other_current_liability' } };
      const plan = (rows, confirmable) => ({ state: 'Missing', rows, vat: [], counts: {}, targets: { missing_mappings: 1, wrong_types: 0, ambiguous_matches: 0, blocking_conflicts: 0 }, mutations: [], adopts: [], confirmable, decisions: [] });
      assert.equal(ui.zsConfirmKey(repairRow, plan([repairRow], [{ key: 'repair:1020>1010', repair: true }])), 'repair:1020>1010');
      let v = boxes(ui.zsPlanHtml(plan([repairRow], [{ key: 'repair:1020>1010', zoho_id: PETTY, repair: true }])));
      assert.deepEqual(v, ['repair:1020>1010'], 'the legacy repair is confirmed by its repair key'); assert.ok(!v.includes('acct:1010'), 'never the row key acct:1010');
      // derived from the plan, not hard-coded: another repair's own key
      const other = { ...repairRow, key: 'acct:1040', repair: { key: 'repair:1045>1040', state: 'PROPOSED' } };
      assert.deepEqual(boxes(ui.zsPlanHtml(plan([other], [{ key: 'repair:1045>1040', repair: true }]))), ['repair:1045>1040']);
      // an ordinary name match (no repair) keeps the row key
      assert.deepEqual(boxes(ui.zsPlanHtml(plan([nameRow], [{ key: 'acct:2400', zoho_id: '77' }]))), ['acct:2400']);
      // both in one preview
      assert.deepEqual(boxes(ui.zsPlanHtml(plan([repairRow, nameRow], [{ key: 'acct:2400' }, { key: 'repair:1020>1010', repair: true }]))), ['repair:1020>1010', 'acct:2400']);
      // a row the preview does not list as confirmable gets no checkbox (a box the server would refuse is never offered)
      assert.deepEqual(boxes(ui.zsPlanHtml(plan([repairRow, nameRow], []))), []);
      out.push('A. checkbox value from p.confirmable: repair row → repair:1020>1010 (not acct:1010); another repair → its own key; ordinary name match → row key; not confirmable → no box'); }

    // ---- the organisation as in production: VAT pending; every approved account already in Zoho (nothing to create);
    //      Cash on Hand 1020 exists; Trigon's 1020 still mapped (legacy, mapping screen) to Zoho's Petty Cash
    ok(await call('POST', 'setup', { username: 'admin', password: 'secret12', company: 'Trigon' }));
    ok(await call('PUT', 'settings', { trn: '100123456700003' }));
    const cl = ok(await call('POST', 'parties', { type: 'client', name: 'Client Test', trn: '100000000000003' })).id;
    const P = ok(await call('POST', 'projects', { name: 'Site A', client_id: cl, status: 'active' })).id;
    const inv = ok(await call('POST', 'invoices', { project_id: P, date: '2026-11-05', items: [{ description: 'Works', qty: 10, rate: 100 }] })).id;
    ok(await call('POST', 'payments', { kind: 'in', date: '2026-11-10', amount: 1050, method: 'bank', invoice_id: inv }));
    const PA = ok(await call('POST', 'partners', { name: 'Partner Alpha' })).id;
    ok(await call('POST', `partners/${PA}/shares`, { pct: 100, from_date: '2026-01-01' }));
    T.taxes.length = 0;
    for (const a of T.chartofaccounts) if (a.account_id === '3201') a.is_system_account = true;
    const coded = { 3102: '2200', 3104: '2250', 3106: '2300', 3101: '5200', 3105: '5260', 3202: '1150', 3103: '1300' };
    for (const a of T.chartofaccounts) if (coded[a.account_id]) a.account_code = coded[a.account_id];
    T.bankaccounts.find(a => a.account_id === '2001').account_code = '1000';
    Object.assign(T.bankaccounts.find(a => a.account_id === '2002'), { account_id: PETTY, is_system_account: true });   // "Petty Cash", system, cash, no code
    T.chartofaccounts.push({ account_id: '3301', account_name: 'Accounts Payable', account_type: 'accounts_payable', is_active: true, is_system_account: true },
      { account_id: RE, account_name: 'Retained Earnings', account_type: 'equity', is_active: true, is_system_account: true },
      { account_id: '3801', account_name: 'Office Salaries', account_code: '6200', account_type: 'expense', is_active: true });
    for (const code of [...new Set(Object.keys(ctx.zohoX.CAT).map(c => ctx.expenseCode(c)))].filter(c => !['1600', '5200', '6200'].includes(c))) T.chartofaccounts.push({ account_id: 'C-' + code, account_name: 'Cost ' + code, account_code: code, account_type: 'expense', is_active: true });
    // ids as strings: Zoho ids exceed JavaScript's safe integers
    let nid = 10; const acc = (code, name, type, parent) => { const a = { account_id: code === '1020' ? CASH : '15613140000001400' + nid++, account_name: name, account_code: code, account_type: type, is_active: true, ...(parent ? { parent_account_id: parent } : {}) }; T.chartofaccounts.push(a); return a.account_id; };
    acc('1020', 'Cash on Hand', 'cash'); acc('1030', 'Employee Cash Custody', 'cash'); acc('1050', 'Cheques in Hand / PDC Received', 'other_current_asset');
    const fa = acc('1600', 'Fixed Assets', 'fixed_asset'); acc('1690', 'Accumulated Depreciation', 'fixed_asset', fa);
    acc('2050', 'Cheques Issued / PDC Payable', 'other_current_liability'); acc('2260', 'Employee Expense Claims Payable', 'other_current_liability'); acc('2400', 'Advances from Customers', 'other_current_liability');
    acc('3900', 'Opening Balance Equity', 'equity'); acc('6100', 'Depreciation', 'expense');
    for (const [code, name, type, sfx] of [['3000', 'Partner Capital', 'equity', 'Capital'], ['2500', 'Partner Loans', 'long_term_liability', 'Loan'], ['3110', 'Partner Current Accounts', 'equity', 'Current']]) acc(`${code}-P${PA}`, `Partner Alpha - ${sfx}`, type, acc(code, name, type));
    ok(await call('POST', 'zoho/connect', { code: '1000.code.one' }));
    ok(await call('PUT', 'zoho/config', { enabled: '1', start: '2026-10-01', start_v2: '2026-10-01', post: '1' }));
    ok(await call('PUT', 'zoho/mapping', { kind: 'account', local_key: 'acct:1020', zoho_id: PETTY, label: 'Petty Cash (cash)' }));
    ok(await call('PUT', 'zoho/mapping', { kind: 'account', local_key: 'acct:4000', zoho_id: '3004' }));
    const pettyBefore = JSON.stringify(T.bankaccounts.find(a => a.account_id === PETTY)), zohoBefore = JSON.stringify(T);
    const map1020 = JSON.stringify(mapOf('acct:1020')), auditBefore = db.prepare("SELECT * FROM audit_log WHERE tbl='zoho_map' ORDER BY id").all();
    const sendLog = () => JSON.stringify(db.prepare('SELECT * FROM zoho_sync ORDER BY rowid').all()), sentBefore = sendLog();
    const n0 = zoho.calls.length, writes = () => zoho.calls.slice(n0).filter(c => !/^GET /.test(c));
    const previewNow = async () => { ok(await call('POST', 'zoho-sync/preflight')); return ok(await call('GET', 'zoho-sync/preview')); };

    let pv = await previewNow();
    assert.equal(pv.counts.CREATE_APPROVED, 0); assert.deepEqual(pv.mutations, [], 'nothing to create');
    const r10 = pv.rows.find(r => r.key === 'acct:1010');
    assert.equal(r10.classification, 'ADOPT_EXISTING_AFTER_CONFIRMATION'); assert.equal(r10.reason, 'LEGACY_MAPPING_REPAIR'); assert.equal(r10.repair.key, 'repair:1020>1010'); assert.equal(r10.repair.state, 'PROPOSED');
    assert.deepEqual(r10.repair.operations.map(o => [o.op, o.trigon_key, o.zoho_id]), [['REMOVE_MAPPING_ONLY', 'acct:1020', PETTY], ['ADOPT_EXISTING', 'acct:1010', PETTY], ['MAP', 'acct:1020', CASH]], 'no creation: 1020 maps to the existing Cash on Hand');
    assert.deepEqual(pv.confirmable.map(c => c.key), ['repair:1020>1010']);

    // ---- E. the old value (acct:1010) — refused by the server as designed: nothing applied
    { const r = await call('POST', 'zoho-sync/provision', provisionBody(pv, ['acct:1010']));
      assert.equal(r.s, 400, JSON.stringify(r.j)); assert.match(r.j.error, /acct:1010 is not an account the preview proposed for confirmation/);
      const junk = await call('POST', 'zoho-sync/provision', provisionBody(pv, ['repair:9999>1010'])); assert.equal(junk.s, 400); assert.match(junk.j.error, /repair:9999>1010 is not an account the preview proposed/);
      assert.equal(JSON.stringify(mapOf('acct:1020')), map1020); assert.equal(mapOf('acct:1010'), undefined); assert.deepEqual(writes(), []); }
    out.push('E. invalid confirmation keys (acct:1010, repair:9999>1010) refused with 400 — nothing applied, zero calls');

    // ---- the page itself: zohoSync() in a small DOM. Elements by id; the .zs-confirm boxes are those in the current HTML of #zs-out,
    //      so replacing that HTML removes them (as in a browser); api() goes to this server; every request the page sends is recorded.
    const page = (() => {
      const els = {}, ticked = new Set(), sent = [], toasts = [], last = {};
      const mk = id => ({ id, disabled: false, onclick: null, onchange: null, _h: '', get innerHTML() { return this._h; },
        set innerHTML(h) { this._h = String(h); for (const m of this._h.matchAll(/\bid="([^"]+)"/g)) els[m[1]] = mk(m[1]); } });
      els.zsync = mk('zsync');
      const boxesNow = () => boxes(els['zs-out'] ? els['zs-out'].innerHTML : '');
      Object.assign(ui, {
        $: sel => (sel[0] === '#' ? els[sel.slice(1)] || null : null),
        document: { querySelectorAll: sel => { assert.equal(sel, '.zs-confirm:checked'); return boxesNow().filter(v => ticked.has(v)).map(value => ({ value, checked: true })); } },
        api: async (m, u, b) => { if (m !== 'GET') sent.push({ method: m, url: u, body: b === undefined ? undefined : JSON.parse(JSON.stringify(b)) });
          const r = await call(m, u, b); if (r.s !== 200) throw new Error((r.j && r.j.error) || 'HTTP ' + r.s); last[`${m} ${u}`] = r.j; return r.j; },
        guard: fn => async (...a) => { try { await fn(...a); } catch (e) { toasts.push(e.message); } },
        toast: m => toasts.push(m), confirm: () => true, money: v => String(v),
      });
      return { els, ticked, sent, toasts, last, boxesNow, click: id => els[id].onclick() };
    })();
    await ui.zohoSync(true);
    assert.ok(page.els['zs-pv'] && page.els['zs-prov'] && page.els['zs-out'], 'the Zoho Accounting Sync card is rendered');
    const provisions = () => page.sent.filter(x => x.method === 'POST' && x.url === 'zoho-sync/provision');
    const auditRepairs = () => db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='legacy_mapping_repair'").get().n;

    // ---- 1. the production bug, reproduced in the page: a ticked box disappears with the preview when the busy message replaces it
    await page.click('zs-pv'); assert.deepEqual(page.boxesNow(), ['repair:1020>1010']);
    page.ticked.add('repair:1020>1010');
    assert.deepEqual(ui.document.querySelectorAll('.zs-confirm:checked').map(x => x.value), ['repair:1020>1010'], 'ticked before busy()');
    page.els['zs-out'].innerHTML = '<p class="muted">Creating, then running the preflight again…</p>';       // what busy() does
    assert.deepEqual(ui.document.querySelectorAll('.zs-confirm:checked').map(x => x.value), [], 'after busy() the boxes are gone: reading them now gives []');
    page.ticked.clear();
    out.push('1. reproduced: the box is ticked before busy(); read after busy() it gives [] (the preview HTML, and its boxes, are replaced)');

    // ---- 3. Provision with the box NOT ticked: confirm_adopt [] — the repair is not applied
    { await page.click('zs-pv'); const pvw = page.last['GET zoho-sync/preview'];
      await page.click('zs-prov'); assert.deepEqual(page.toasts, []);
      const req = provisions().pop(); assert.deepEqual(req.body, { confirm: true, token: pvw.token, confirm_adopt: [] });
      const r = page.last['POST zoho-sync/provision'].result; assert.ok(!(r.repaired || []).length); assert.equal(r.created.length, 0); assert.equal(r.failed.length, 0);
      assert.equal(JSON.stringify(mapOf('acct:1020')), map1020, 'unticked: 1020 still on Petty Cash'); assert.equal(mapOf('acct:1010'), undefined); assert.equal(auditRepairs(), 0); assert.deepEqual(writes(), []); }
    out.push('3. Provision with the box unticked: request confirm_adopt [] — the repair is not applied (explicit confirmation required)');

    // ---- 4. a ticked value the current preview does not offer (stale page): refused in the page, before any request
    { await page.click('zs-pv'); page.ticked.add('repair:1020>1010');
      page.els['zs-out']._h += '<input type="checkbox" class="zs-confirm" value="repair:9999&gt;1010" style="width:auto">'; page.ticked.add('repair:9999>1010');
      const n = page.sent.length, maps = JSON.stringify(db.prepare('SELECT * FROM zoho_map ORDER BY rowid').all());
      await page.click('zs-prov');
      assert.equal(page.sent.length, n, 'no provisioning request sent'); assert.match(page.toasts.pop(), /no longer in the current preview — preview again/);
      assert.equal(JSON.stringify(db.prepare('SELECT * FROM zoho_map ORDER BY rowid').all()), maps, 'no mapping changed'); assert.deepEqual(writes(), [], 'no Zoho call');
      assert.ok(page.boxesNow().includes('repair:1020>1010'), 'the preview stays on screen'); page.ticked.clear(); }
    out.push('4. a ticked key not in preview.confirmable: refused before POST — no request, no mapping change, no Zoho call');

    // ---- 2. Provision with the 1010 box ticked: the request carries it, although busy() replaces the preview first
    await page.click('zs-pv'); const pvw = page.last['GET zoho-sync/preview'];
    assert.equal(pvw.counts.CREATE_APPROVED, 0); assert.deepEqual(pvw.mutations, []); assert.match(page.els['zs-out'].innerHTML, /Nothing to create\./);
    assert.equal(page.els['zs-prov'].disabled, false, 'Provision enabled: there is a confirmation to give');
    page.ticked.add('repair:1020>1010');
    await page.click('zs-prov'); assert.deepEqual(page.toasts, []);
    const req = provisions().pop();
    assert.deepEqual(req.body, { confirm: true, token: pvw.token, confirm_adopt: ['repair:1020>1010'] });
    assert.ok(req.body.confirm_adopt.length > 0 && !req.body.confirm_adopt.includes('acct:1010'));
    assert.deepEqual(page.boxesNow(), [], 'the busy message and then the result replaced the preview');
    out.push('2. Provision with the box ticked (CREATE_APPROVED 0, no mutations): POST {confirm: true, token: <preview token>, confirm_adopt: ["repair:1020>1010"]}');

    // ---- 5. the confirmed repair: Trigon-side only
    const res = page.last['POST zoho-sync/provision'], R = res.result;
    assert.equal(R.failed.length, 0, JSON.stringify(R.failed)); assert.equal(R.created.length, 0); assert.equal((R.repaired || []).length, 1);
    assert.match(page.els['zs-out'].innerHTML, /Created 0 · adopted/);
    assert.equal(mapOf('acct:1010').zoho_id, PETTY); assert.equal(mapOf('acct:1020').zoho_id, CASH); assert.notEqual(mapOf('acct:1010').zoho_id, mapOf('acct:1020').zoho_id);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM zoho_map WHERE kind='account' AND zoho_id=?").get(PETTY).n, 1, 'the legacy 1020 → Petty Cash mapping is gone');
    const ids = ['1010', '1020', '1030'].map(c => mapOf('acct:' + c).zoho_id); assert.equal(new Set(ids).size, 3, '1010 / 1020 / 1030 distinct');
    const auditAfter = db.prepare("SELECT * FROM audit_log WHERE tbl='zoho_map' ORDER BY id").all();
    for (const a of auditBefore) assert.ok(auditAfter.some(b => b.id === a.id && b.detail === a.detail && b.ts === a.ts), 'mapping audit history kept: ' + a.detail);
    const rep = auditAfter.filter(a => a.action === 'legacy_mapping_repair'); assert.equal(rep.length, 1);
    const det = JSON.parse(rep[0].detail); assert.equal(det.old_trigon_code, '1020'); assert.equal(det.new_trigon_code, '1010'); assert.equal(det.zoho_account_id, PETTY); assert.equal(det.new_mapping_for_old_code.zoho_id, CASH); assert.equal(det.zoho_changes, 'none');
    const w = writes(); assert.equal(w.filter(c => /chartofaccounts/.test(c)).length, 0, 'zero POST /chartofaccounts'); assert.deepEqual(w, [], 'zero modifying calls of any kind');
    for (const k of ['invoices', 'bills', 'journals', 'customerpayments', 'vendorpayments', 'creditnotes', 'expenses']) assert.ok(!(T[k] || []).length, 'nothing sent: ' + k);
    assert.equal(sendLog(), sentBefore, 'no transaction queued or sent');
    assert.equal(JSON.stringify(T.bankaccounts.find(a => a.account_id === PETTY)), pettyBefore, 'Petty Cash itself unchanged');
    assert.equal(JSON.stringify(T), zohoBefore, 'nothing changed in Zoho: no account created');
    out.push(`5. confirmed repair: 1020 → Petty Cash removed; 1010 → ${PETTY}; 1020 → ${CASH}; audit history kept + one legacy_mapping_repair record; zero Zoho accounts created, zero modifying calls`);

    // ---- 6. the gate after the repair
    const g = res.gate;
    assert.equal(g.state, 'READY_NON_VAT', JSON.stringify(g.reasons)); assert.deepEqual(g.targets_non_vat, { missing_mappings: 0, wrong_types: 0, ambiguous_matches: 0, blocking_conflicts: 0 });
    assert.equal(g.vat, 'VAT_PENDING'); assert.ok((res.plan.deferred || []).some(d => d.code === '6150'), '6150 ACCOUNTING_CHANGE_PENDING');
    const st = ok(await call('GET', 'zoho-sync')); assert.equal(st.continuous, false, 'continuous sync OFF'); assert.equal(st.gate, 'READY_NON_VAT');
    assert.deepEqual(writes(), []);
    out.push('6. gate READY_NON_VAT, non-VAT targets 0 / 0 / 0 / 0, VAT_PENDING, 6150 ACCOUNTING_CHANGE_PENDING, continuous OFF');

    // ---- 7. idempotent: no box any more, Provision disabled; pressing it anyway changes nothing
    await page.click('zs-pv'); assert.deepEqual(page.boxesNow(), []); assert.deepEqual(page.last['GET zoho-sync/preview'].confirmable, []);
    assert.equal(page.els['zs-prov'].disabled, true, 'nothing to provision');
    { const maps = JSON.stringify(db.prepare('SELECT * FROM zoho_map ORDER BY rowid').all());
      await page.click('zs-prov'); const again = page.last['POST zoho-sync/provision'].result;
      assert.deepEqual(provisions().pop().body.confirm_adopt, []); assert.ok(!(again.repaired || []).length && !again.created.length && !again.adopted.length);
      assert.equal(JSON.stringify(db.prepare('SELECT * FROM zoho_map ORDER BY rowid').all()), maps); assert.equal(auditRepairs(), 1, 'no second repair audit record'); assert.deepEqual(writes(), []); }
    out.push('7. after the repair: no confirmation box, Provision disabled; provisioning again changes nothing, no second audit record, no Zoho call');

    for (const o of out) console.log('  ✔ ' + o);
    console.log('ZOHO CONFIRMATION KEY TESTS PASSED');
  } catch (e) { console.error(e); process.exitCode = 1; }
  finally { server.close(); zoho.srv.close(); setTimeout(() => process.exit(process.exitCode || 0), 100); }
});
