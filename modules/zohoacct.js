// Zoho accounting sync (on top of the Zoho bridge in modules/zoho.js):
//   1. account provisioning — Trigon's accounting structure is ensured in Zoho, restricted to an allowlist of accounts and
//      the partner sub-accounts; mapped accounts are validated; nothing is adopted by a similar name; nothing in Zoho is renamed,
//      re-typed, merged or deleted; VAT accounts are never created (they come from Zoho's tax configuration)
//   2. the READY gate — no real transaction leaves Trigon before the read-only preflight reaches READY after provisioning
//   3. continuous sending — every minute, only when Trigon's books changed or a retry is due; Zoho being down never blocks Trigon
//   4. reconciliation — record by record (read back from Zoho) and Trial Balance against Trial Balance at the same cutoff,
//      with the statements derived from it. Differences are reported, never "fixed".
// Every Zoho request here is a GET, except POST /chartofaccounts during an administrator-confirmed provisioning (and, once the
// gate is READY, the automatic creation of a new partner's sub-accounts, which is the same allowlisted operation).
module.exports = ctx => {
  const { db, send, audit, readBody, today, round } = ctx;
  db.exec(`CREATE TABLE IF NOT EXISTS zoho_recon(id INTEGER PRIMARY KEY, started TEXT, finished TEXT, trigger TEXT, user TEXT, basis TEXT, date_from TEXT, cutoff TEXT, status TEXT,
    summary TEXT, tb TEXT, statements TEXT, items TEXT, zoho_only TEXT, message TEXT);
  CREATE TABLE IF NOT EXISTS zoho_provision_runs(id INTEGER PRIMARY KEY, at TEXT, user TEXT, trigger TEXT, token TEXT, created INTEGER DEFAULT 0, adopted INTEGER DEFAULT 0, conflicts INTEGER DEFAULT 0, failed INTEGER DEFAULT 0, result TEXT);`);
  const X = ctx.zohoX;                                                                   // modules/zoho.js (loaded before this module)
  const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
  const J = v => { try { return JSON.parse(v || 'null'); } catch { return null; } };

  // ---------- what may be created automatically: these accounts and the partner structure, nothing else ----------
  // [Trigon code, name in Zoho, the one Zoho type it is created with] — the type is one of those the preflight accepts for the code
  // [Trigon code, name in Zoho, the one Zoho type it is created with, parent code] — the type is one the preflight accepts for the code.
  // 1690 is the contra-asset: a fixed_asset account (credit balance) under 1600, so Zoho's balance sheet shows the net book value.
  // 6150 holds gains (credits) and losses (debits) on disposal, as Trigon's ledger does (one account, net).
  const ALLOW = [
    ['1010', 'Petty Cash', 'cash'], ['1030', 'Employee Cash Custody', 'cash'], ['1050', 'Cheques in Hand / PDC Received', 'other_current_asset'],
    ['1600', 'Fixed Assets', 'fixed_asset'], ['1690', 'Accumulated Depreciation', 'fixed_asset', '1600'], ['2050', 'Cheques Issued / PDC Payable', 'other_current_liability'],
    ['2260', 'Employee Expense Claims Payable', 'other_current_liability'], ['2400', 'Advances from Customers', 'other_current_liability'],
    ['3900', 'Opening Balance Equity', 'equity'], ['6100', 'Depreciation', 'expense'], ['6150', 'Gain / Loss on Asset Disposal', 'other_expense'],
  ];
  // partner control accounts (parents) and, per partner, one sub-account each — identified by the partner's id, never his name
  const PARENTS = [['3000', 'Partner Capital', 'equity', 'Capital'], ['2500', 'Partner Loans', 'long_term_liability', 'Loan'], ['3110', 'Partner Current Accounts', 'equity', 'Current']];
  // Zoho's own system accounts: adopted, never created or duplicated (3100 = Retained Earnings, 1100 = Accounts Receivable, 2000 = Accounts Payable)
  const SYS = { 3100: { type: 'equity', test: a => a.is_system_account === true && a.account_type === 'equity' && /^retained earnings$/i.test(String(a.account_name || '').trim()), what: "Zoho's system Retained Earnings account" },
    1100: { type: 'accounts_receivable', test: a => a.is_system_account === true && a.account_type === 'accounts_receivable', what: "Zoho's system Accounts Receivable account" },
    2000: { type: 'accounts_payable', test: a => a.is_system_account === true && a.account_type === 'accounts_payable', what: "Zoho's system Accounts Payable account" } };
  const VAT = { 1200: { label: 'VAT input', auto: 'input_tax', types: ['input_tax', 'other_current_asset'] }, 2100: { label: 'VAT output', auto: 'output_tax', types: ['output_tax', 'other_current_liability'] } };
  // what the preview calls each outcome
  const CLASS = { ok: 'ADOPT_EXISTING', adopt: 'ADOPT_EXISTING', sys: 'SYSTEM_ACCOUNT_ADOPT', confirm: 'ADOPT_EXISTING_AFTER_CONFIRMATION', create: 'CREATE_APPROVED', conflict: 'ACCOUNT_CONFLICT', ambiguous: 'AMBIGUOUS', blocked: 'BLOCKED', vat_required: 'VAT_CONFIGURATION_REQUIRED' };
  for (const [code, , type] of ALLOW) { const t = X.expectTypes('acct:' + code); if (!t || !t.includes(type)) throw new Error(`zohoacct: ${code} ${type} is not a type the preflight accepts`); }
  for (const [code, , type] of PARENTS) { const t = X.expectTypes(`acct:${code}:p1`); if (!t || !t.includes(type)) throw new Error(`zohoacct: partner ${code} ${type} is not a type the preflight accepts`); }

  const partners = () => (X.has('partners') ? db.prepare('SELECT id, name FROM partners ORDER BY id').all() : []);
  const mapRow = key => db.prepare("SELECT * FROM zoho_map WHERE kind='account' AND local_key=?").get(key);
  function saveMap(key, a, { created = 0, partnerId = null, label = '' } = {}) {
    const old = mapRow(key);
    db.prepare(`INSERT INTO zoho_map(kind,local_key,zoho_id,label,zoho_code,zoho_name,zoho_type,parent_id,created_by_trigon,mapped_at,verified_at,partner_id) VALUES('account',?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(kind,local_key) DO UPDATE SET zoho_id=excluded.zoho_id, label=COALESCE(NULLIF(excluded.label,''),label), zoho_code=excluded.zoho_code, zoho_name=excluded.zoho_name, zoho_type=excluded.zoho_type,
        parent_id=excluded.parent_id, created_by_trigon=MAX(created_by_trigon, excluded.created_by_trigon), mapped_at=COALESCE(mapped_at, excluded.mapped_at), verified_at=excluded.verified_at, partner_id=COALESCE(excluded.partner_id, partner_id)`)
      .run(key, String(a.account_id), label || (old && old.label) || a.account_name || '', a.account_code || '', a.account_name || '', a.account_type || '', a.parent_account_id ? String(a.parent_account_id) : '', created ? 1 : 0, stamp(), stamp(), partnerId);
  }

  // ---------- the provisioning plan: read Zoho, decide account by account (no write) ----------
  async function readZoho(cl) {
    const coa = (await cl.get('/chartofaccounts', { filter_by: 'AccountType.All' })).chartofaccounts || [];
    const banks = (await cl.get('/bankaccounts')).bankaccounts || [];
    const taxes = (await cl.get('/settings/taxes')).taxes || [];
    const all = [...coa]; for (const b of banks) if (!all.some(a => String(a.account_id) === String(b.account_id))) all.push(b);
    return { all, taxes };
  }
  const view = a => a ? { id: String(a.account_id), name: a.account_name || '', type: a.account_type || '', code: a.account_code || '', active: a.is_active !== false, system: !!a.is_system_account, parent_id: a.parent_account_id ? String(a.parent_account_id) : '' } : null;

  // UAE VAT as configured in Zoho (read only): the organisation's tax registration, the taxes, the input / output VAT control accounts.
  // Numbers such as the TRN are shown masked. Nothing in Zoho's tax configuration is changed, and no VAT account is ever created.
  async function vatDiagnostic(cl, all, taxes) {
    const mask = v => { const t = String(v == null ? '' : v); return /^\d{6,}$/.test(t.replace(/\s/g, '')) ? '•••' + t.replace(/\s/g, '').slice(-4) : t; };
    let org = null, orgError = '';
    try { const o = await cl.get('/organizations/' + X.cfg().org); org = o.organization || (o.organizations || []).find(x => String(x.organization_id) === String(X.cfg().org)) || null; } catch (e) { orgError = e.message; }
    const registration = {}; if (org) for (const [k, v] of Object.entries(org)) if (/tax|vat|trn|country|registr/i.test(k) && (v == null || typeof v !== 'object')) registration[k] = /reg_no|trn|number/i.test(k) ? mask(v) : v;
    const inactive = t => t.is_inactive === true || /inactive/i.test(String(t.status || ''));
    const list = taxes.map(t => ({ tax_id: String(t.tax_id), tax_name: t.tax_name, tax_percentage: +t.tax_percentage, tax_type: t.tax_type || '', specific_type: t.tax_specific_type || '', active: !inactive(t),
      ...Object.fromEntries(Object.entries(t).filter(([k, v]) => /account/i.test(k) && v != null && typeof v !== 'object')) }));
    const std = list.filter(t => t.tax_percentage === 5 && t.tax_type !== 'tax_group' && t.active);
    const acc = types => all.filter(a => types.includes(a.account_type)).map(a => ({ ...view(a), system: !!a.is_system_account }));
    const named = all.filter(a => a.is_system_account && /\b(vat|tax)\b/i.test(a.account_name || '') && !['input_tax', 'output_tax'].includes(a.account_type)).map(a => ({ ...view(a), system: true }));
    const enabled = list.length > 0 || acc(['input_tax', 'output_tax']).length > 0;
    return { uae_vat_enabled: enabled ? (std.length ? 'yes — taxes are set up' : 'partly — taxes exist but no active 5% tax') : 'no — no taxes and no VAT accounts in this organisation',
      organization: org ? { name: org.name, country: org.country || org.country_code || '', ...registration } : { error: orgError || 'not found' },
      taxes: list, standard_5_active: std.length === 1 ? std[0] : std.length > 1 ? `${std.length} active 5% taxes (ambiguous)` : null,
      input_vat_control: acc(['input_tax']), output_vat_control: acc(['output_tax']),
      other_system_tax_accounts: named, note: 'Diagnostic only: listed so the configuration can be checked. Accounts are never adopted by name; 1200 / 2100 need the input_tax / output_tax accounts of Zoho\'s UAE VAT, or an explicit mapping.' };
  }

  async function plan(cl) {
    const { all, taxes } = await readZoho(cl);
    const byId = new Map(all.map(a => [String(a.account_id), a])), low = s2 => String(s2 || '').trim().toLowerCase(), active = a => a.is_active !== false;
    const byCode = c => all.filter(a => String(a.account_code || '').trim() === c), byName = n => all.filter(a => low(a.account_name) === low(n));
    const cand = types => all.filter(a => active(a) && types.includes(a.account_type)).slice(0, 8).map(view);
    const out = (t, action, extra) => ({ ...t, action, classification: action === 'adopt' && extra && extra.sys ? CLASS.sys : CLASS[action], ...extra });
    const conflict = (t, reason, a, resolution) => out(t, 'conflict', { reason, zoho: view(a), resolution });
    // one account, in this order: its mapping (validated) → Zoho's system account (when it is one) → exact code + compatible type → create (allowlist) → stop
    function resolve(t) {
      const types = t.types, m = mapRow(t.key), sys = SYS[t.code] && !t.partner_id ? SYS[t.code] : null;
      if (m && m.zoho_id) {
        const a = byId.get(String(m.zoho_id));
        if (!a) return conflict(t, 'MAPPED_ACCOUNT_MISSING', { account_id: m.zoho_id, account_name: m.zoho_name, account_type: m.zoho_type, account_code: m.zoho_code }, 'The mapped Zoho account no longer exists. Trigon does not create a replacement (earlier transactions refer to it): map the replacement explicitly.');
        if (!active(a)) return conflict(t, 'INACTIVE', a, 'The mapped Zoho account is inactive. Reactivate it in Zoho, or map another account explicitly.');
        if (!types.includes(a.account_type)) return conflict(t, 'WRONG_TYPE', a, `Zoho type is ${a.account_type}; Trigon ${t.code} needs ${types.join(' or ')}. Trigon never changes the type of a Zoho account.`);
        if (sys && t.code === '3100' && !sys.test(a)) return conflict(t, 'NOT_SYSTEM_ACCOUNT', a, `3100 must be ${sys.what}; it is mapped to another account. Map it to the system account (never a replacement).`);
        if (t.allow && a.account_code && String(a.account_code).trim() !== t.code) return conflict(t, 'WRONG_CODE', a, `The mapped Zoho account has code ${a.account_code}; expected ${t.code}. Correct the code in Zoho, or map the right account.`);
        const note = t.partner_id && low(a.account_name) !== low(t.name) ? `name in Zoho "${a.account_name}" differs from Trigon's "${t.name}" (renamed in Trigon?) — kept as it is` : 'already mapped and valid';
        return out(t, 'ok', { state: 'MAPPED', zoho: view(a), note });
      }
      const hits = byCode(t.code), sysHits = sys ? all.filter(a => active(a) && sys.test(a)) : [];
      for (const a of hits) if (!types.includes(a.account_type)) return conflict(t, 'WRONG_TYPE', a, `Zoho already has code ${t.code} as "${a.account_name}" of type ${a.account_type}; Trigon needs ${types.join(' or ')}. Give that Zoho account another code (if it is a different account), or ask the accountant — Trigon will not rename, re-type or duplicate it.`);
      for (const a of hits) if (!active(a)) return conflict(t, 'INACTIVE', a, `The Zoho account with code ${t.code} is inactive. Reactivate it, or remove the code from it.`);
      if (sys) {
        if (sysHits.length > 1) return out(t, 'ambiguous', { reason: 'SEVERAL_SYSTEM_ACCOUNTS', candidates: sysHits.map(view), resolution: `${sysHits.length} accounts look like ${sys.what} — map the right one explicitly.` });
        if (sysHits.length === 1 && hits.length && hits.some(a => a.account_id !== sysHits[0].account_id))
          return t.code === '3100' ? conflict(t, 'REPLACEMENT_EXISTS', hits.find(a => a.account_id !== sysHits[0].account_id), `Another account carries code 3100 besides ${sys.what}. 3100 is always the system account: remove the code from the other account in Zoho.`)
            : out(t, 'ambiguous', { reason: 'TWO_CANDIDATES', candidates: [sysHits[0], ...hits].map(view), resolution: `Both ${sys.what} and another account with code ${t.code} exist — map the right one explicitly.` });
        if (sysHits.length === 1) return out(t, 'adopt', { sys: true, state: 'SYSTEM_ACCOUNT', zoho: view(sysHits[0]), note: sys.what });
        if (t.code === '3100') return out(t, 'blocked', { reason: 'SYSTEM_ACCOUNT_NOT_FOUND', zoho: hits[0] ? view(hits[0]) : null, resolution: `${sys.what} was not found (Zoho creates it with every organisation). Trigon never creates a replacement: check the Zoho chart of accounts and map it explicitly.` });
      }
      if (hits.length > 1) return out(t, 'ambiguous', { reason: 'DUPLICATE_CODE', candidates: hits.map(view), resolution: `${hits.length} Zoho accounts have the code ${t.code}. Keep the code on one account only.` });
      if (hits.length === 1) return out(t, 'adopt', { state: 'BY_CODE', zoho: view(hits[0]), note: `Zoho account with code ${t.code} and a compatible type (${hits[0].account_type})` });
      const same = t.allow ? byName(t.name) : [];                                          // never adopted by name alone — a name collision stops an account Trigon would create
      if (same.length) {
        // safe to propose (administrator-confirmed only): exactly one account, active, a compatible type, no other code, not already used for another Trigon account
        const a = same[0], usedBy = db.prepare("SELECT local_key FROM zoho_map WHERE kind='account' AND zoho_id=?").all(String(a.account_id)).map(x => x.local_key).filter(k => k !== t.key);
        const checks = { unique_name: same.length === 1, active: active(a), compatible_type: types.includes(a.account_type), no_other_code: !String(a.account_code || '').trim() || String(a.account_code).trim() === t.code, not_used_by_another_trigon_account: !usedBy.length };
        const safe = Object.values(checks).every(Boolean);
        if (safe && !t.partner_id) return out(t, 'confirm', { reason: 'NAME_IN_USE', zoho: view(a), name_match: { checks }, note: `Zoho already has "${a.account_name}" (${a.account_type}, ${a.account_code ? 'code ' + a.account_code : 'no code'}). It passes every safety check, but a name is not proof: it is adopted only if the administrator confirms it explicitly (then Trigon remembers its id; nothing is changed in Zoho). Alternatively give it the code ${t.code} in Zoho and it is adopted by code.` });
        return Object.assign(conflict(t, 'NAME_IN_USE', a, `Zoho already has an account named "${a.account_name}" (${a.account_type}${a.account_code ? ', code ' + a.account_code : ', no code'}). It cannot be adopted (${Object.entries(checks).filter(([, v]) => !v).map(([k]) => k.replace(/_/g, ' ')).join(', ').replace(/^/, 'fails: ')}). Rename one of them, or map the right account explicitly.`), { name_match: { checks } });
      }
      if (t.allow) return out(t, 'create', { state: 'CREATE' });
      const c = cand(types);
      return out(t, 'blocked', { reason: 'NO_ACCOUNT_WITH_CODE', candidates: c, resolution: c.length ? `No Zoho account carries code ${t.code}. Give the right one of these the code ${t.code} in Zoho (it is then adopted automatically): ${c.map(x => `"${x.name}" (${x.type})`).join(', ')} — or map it explicitly.` : `No Zoho account of type ${types.join(' or ')} — create it in Zoho with code ${t.code} (not on Trigon's automatic list).` });
    }
    const rows = [], rowOf = {};
    const add = r => { rows.push(r); rowOf[r.key] = r; return r; };
    for (const [code, name, type, parent] of ALLOW) add(resolve({ key: 'acct:' + code, code, name, type, types: X.expectTypes('acct:' + code), allow: true, ...(parent ? { parent_key: 'acct:' + parent } : {}) }));
    for (const [code, name, type] of PARENTS) add(resolve({ key: 'acct:' + code, code, name, type, types: [type], allow: true, group: 'partner parent' }));
    const ps = partners(), twins = new Set(ps.filter(p => ps.some(q => q.id !== p.id && low(q.name) === low(p.name))).map(p => p.id));
    for (const p of ps) for (const [code, , type, suffix] of PARENTS)
      // Zoho needs unique names: partners with the same name in Trigon carry their id in the name (the identity is the id)
      add(resolve({ key: `acct:${code}:p${p.id}`, code: `${code}-P${p.id}`, name: `${p.name}${twins.has(p.id) ? ` (#${p.id})` : ''} - ${suffix}`, type, types: [type], allow: true, partner_id: p.id, partner: p.name, parent_key: 'acct:' + code, group: 'partner' }));
    // the foundation (never created): Zoho's system accounts, then the rest by exact code + compatible type
    const done = new Set(rows.map(r => r.code));
    for (const [code, label, types] of X.REQUIRED) if (types !== 'tax' && !done.has(code)) { add(resolve({ key: 'acct:' + code, code, name: label, types, allow: false, group: SYS[code] ? 'system' : 'foundation' })); done.add(code); }
    if (!done.has('3100')) add(resolve({ key: 'acct:3100', code: '3100', name: 'Retained Earnings', types: ['equity'], allow: false, group: 'system' }));
    for (const b of X.bankAccounts()) if (!done.has(String(b.ledger_code))) { add(resolve({ key: 'acct:' + b.ledger_code, code: String(b.ledger_code), name: 'Bank — ' + b.name, types: ['bank'], allow: false, group: 'foundation' })); done.add(String(b.ledger_code)); }
    for (const cat of Object.keys(X.CAT)) { const code = ctx.expenseCode ? ctx.expenseCode(cat) : cat;
      add(resolve({ key: 'cat:' + cat, code: String(code), name: `Expense category — ${X.CAT[cat]}`, types: cat === 'asset' ? ['fixed_asset'] : ['cost_of_goods_sold', 'expense'], allow: false, group: 'category' })); }
    // a category on a code this provisioning creates (e.g. "asset" → 1600) follows the new account
    for (const r of rows) if (r.group === 'category' && r.reason === 'NO_ACCOUNT_WITH_CODE' && rowOf['acct:' + r.code] && rowOf['acct:' + r.code].action === 'create')
      Object.assign(r, { action: 'follow', classification: CLASS.adopt, reason: undefined, candidates: undefined, follows: 'acct:' + r.code, resolution: '', note: `uses the account created for ${r.code}` });
    // a sub-account waits for its parent: a parent in conflict / blocked / ambiguous blocks it
    for (const r of rows) if (r.parent_key && r.action === 'create') { const par = rowOf[r.parent_key];
      if (!['ok', 'adopt', 'create'].includes(par.action)) Object.assign(r, { action: 'blocked', classification: CLASS.blocked, reason: 'PARENT_NOT_RESOLVED', resolution: `Its parent account ${par.code} ${par.name} is ${par.classification} — resolve that first.` }); }
    // 1690 / 1600 / 6150: what the accountant reviews before provisioning
    const review = { 1690: 'Contra-asset: Zoho has no contra type, so it is a fixed_asset account carrying a credit balance, created as a sub-account of 1600 Fixed Assets so that Zoho\'s balance sheet shows Fixed Assets at net book value (cost less accumulated depreciation).',
      6150: 'One account for gains and losses, as in Trigon\'s ledger: a loss is a debit, a gain a credit. In Zoho\'s profit & loss it is an "other expense"; a net gain shows there as a negative other expense. Separate gain / loss accounts would need a change to Trigon\'s own ledger first (a separate PR).',
      3100: 'Always Zoho\'s system Retained Earnings account (Zoho closes the year into it). Never created, never replaced.' };
    for (const r of rows) if (review[r.code] && !r.partner_id) r.review = review[r.code];
    // VAT: from Zoho's tax configuration (a 5% tax) and its tax accounts — never created
    const tax5 = taxes.find(t => +t.tax_percentage === 5 && t.tax_type !== 'tax_group');
    const vat = Object.entries(VAT).map(([code, v]) => {
      const base = { key: 'acct:' + code, code, label: v.label, name: v.label, group: 'vat' }, m = mapRow('acct:' + code);
      if (m && m.zoho_id) { const a = byId.get(String(m.zoho_id));
        return a && active(a) && v.types.includes(a.account_type) ? out(base, 'ok', { state: 'MAPPED', zoho: view(a) }) : out(base, 'vat_required', { zoho: view(a), reason: a ? `mapped account is ${active(a) ? 'of type ' + a.account_type : 'inactive'}` : 'mapped account no longer exists' }); }
      const same = all.filter(a => a.account_type === v.auto && active(a));
      if (same.length === 1) return out(base, 'adopt', { sys: !!same[0].is_system_account, state: 'TAX_ACCOUNT', zoho: view(same[0]), note: `Zoho's only ${v.auto} account (from its tax configuration)` });
      if (same.length > 1) return out(base, 'ambiguous', { reason: 'SEVERAL_TAX_ACCOUNTS', candidates: same.map(view), resolution: `${same.length} Zoho accounts of type ${v.auto} — map Trigon ${code} to the right one` });
      return out(base, 'vat_required', { reason: `no Zoho ${v.auto} account — set up UAE VAT in Zoho (Settings → Taxes)` });
    });
    if (!tax5) vat.push(out({ key: 'tax:5', code: 'tax', label: 'Standard rate 5%', name: 'Standard rate 5%', group: 'vat' }, 'vat_required', { reason: 'no 5% tax in Zoho — set up UAE VAT in Zoho (Settings → Taxes)' }));
    // name collisions: everything the administrator needs to judge the existing account (read only)
    for (const r of rows.filter(x => x.reason === 'NAME_IN_USE' && x.zoho)) {
      let one = null; try { const g = await cl.get('/chartofaccounts/' + r.zoho.id); one = (g && g.chart_of_account) || g; } catch { one = null; }
      let used = one && one.is_involved_in_transaction != null ? !!one.is_involved_in_transaction : null;
      if (used == null) try { used = ((await cl.get('/chartofaccounts/accounttransactions', { account_id: r.zoho.id, per_page: 1 })).transactions || []).length > 0; } catch { used = 'unknown'; }
      const a = one || byId.get(r.zoho.id) || {};
      r.name_match = { ...(r.name_match || {}), account_id: String(a.account_id || r.zoho.id), account_name: a.account_name || r.zoho.name, account_code: a.account_code || '', account_type: a.account_type || r.zoho.type,
        parent_account: a.parent_account_id ? `${a.parent_account_name || ''} (${a.parent_account_id})` : '(none)', is_system_account: !!a.is_system_account, active: a.is_active !== false, involved_in_transaction: used };
      if (r.action === 'confirm') r.note += used === true ? ' It already has transactions in Zoho: after adoption they appear in the reconciliation as Zoho-only entries on this account (opening balances / manual entries), separately from Trigon\'s.' : '';
    }
    const vat_diagnostic = await vatDiagnostic(cl, all, taxes);
    // the exact payload of every CREATE_APPROVED account (not sent by the preview); parents before their sub-accounts
    const order = r => (r.partner_id ? 2 : r.parent_key ? 1 : 0);
    const creates = rows.filter(r => r.action === 'create').sort((a, b) => order(a) - order(b));
    const parentRef = k => { const par = rowOf[k]; return par.zoho ? par.zoho.id : `(the new "${par.name}")`; };
    const mutations = creates.map(r => ({ method: 'POST', path: '/chartofaccounts', key: r.key, body: { account_name: r.name, account_code: r.code, account_type: r.type, ...(r.parent_key ? { parent_account_id: parentRef(r.parent_key) } : {}) } }));
    for (const m of mutations) { rowOf[m.key].payload = m.body; if (m.body.parent_account_id) { const par = rowOf[rowOf[m.key].parent_key]; m.parent_name = par.zoho ? par.zoho.name : par.name; } }
    const adopts = [...rows, ...vat].filter(r => r.action === 'adopt').map(r => ({ key: r.key, zoho_id: r.zoho.id, how: r.classification }));
    const every = [...rows, ...vat], n = cl2 => every.filter(r => r.classification === cl2).length;
    const counts = { ADOPT_EXISTING: n('ADOPT_EXISTING'), ADOPT_EXISTING_AFTER_CONFIRMATION: n('ADOPT_EXISTING_AFTER_CONFIRMATION'), SYSTEM_ACCOUNT_ADOPT: n('SYSTEM_ACCOUNT_ADOPT'), CREATE_APPROVED: n('CREATE_APPROVED'), VAT_CONFIGURATION_REQUIRED: n('VAT_CONFIGURATION_REQUIRED'), ACCOUNT_CONFLICT: n('ACCOUNT_CONFLICT'), AMBIGUOUS: n('AMBIGUOUS'), BLOCKED: n('BLOCKED') };
    // the four numbers that must be 0 before synchronisation (after provisioning, every account is mapped)
    const targets = { missing_mappings: every.filter(r => r.action !== 'ok').length, wrong_types: every.filter(r => ['WRONG_TYPE', 'NOT_SYSTEM_ACCOUNT'].includes(r.reason)).length, ambiguous_matches: counts.AMBIGUOUS, blocking_conflicts: counts.ACCOUNT_CONFLICT + counts.BLOCKED + counts.VAT_CONFIGURATION_REQUIRED };
    const state = counts.ACCOUNT_CONFLICT || counts.BLOCKED ? 'Conflict' : counts.AMBIGUOUS ? 'Ambiguous' : counts.VAT_CONFIGURATION_REQUIRED ? 'VAT_CONFIGURATION_REQUIRED' : targets.missing_mappings ? 'Missing' : 'Ready';
    const confirmable = rows.filter(r => r.action === 'confirm').map(r => ({ key: r.key, zoho_id: r.zoho.id }));
    const token = X.hashOf([mutations.map(m => m.body), adopts, confirmable]);
    // the three accounting decisions, stated in the preview
    const d3100 = rowOf['acct:3100'], d1690 = rowOf['acct:1690'], d6150 = rowOf['acct:6150'];
    const decisions = [
      { code: '3100', title: 'Retained Earnings → the exact Zoho system account', classification: d3100.classification, zoho: d3100.zoho || null,
        treatment: d3100.classification === 'SYSTEM_ACCOUNT_ADOPT' ? `Adopt Zoho's system account "${d3100.zoho.name}" (id ${d3100.zoho.id}, ${d3100.zoho.type}, system). Never created, never replaced.` : `Not adopted: ${d3100.reason || d3100.classification} — ${d3100.resolution || ''}` },
      { code: '1690', title: 'Accumulated Depreciation → contra-asset under 1600', classification: d1690.classification, zoho: d1690.zoho || null, payload: d1690.payload || null,
        treatment: `Zoho type fixed_asset with a credit balance, a sub-account of 1600 Fixed Assets (${rowOf['acct:1600'].zoho ? 'existing account ' + rowOf['acct:1600'].zoho.id : 'created first in the same run'}). Depreciation: Dr 6100 / Cr 1690. Balance sheet: Fixed Assets shown with its sub-accounts — cost (1600) less accumulated depreciation (1690) = net book value. Disposal: Dr 1690, Cr 1600 (cost and accumulated depreciation leave together).` },
      { code: '6150', title: 'Gain / Loss on Asset Disposal → P&L presentation', classification: d6150.classification, zoho: d6150.zoho || null, payload: d6150.payload || null,
        treatment: 'One account (other_expense), as in Trigon\'s ledger. A loss is a debit: e.g. a loss of 4,500 shows in "Other expenses" as +4,500. A gain is a credit: e.g. a gain of 1,500 shows in "Other expenses" as −1,500. Several disposals in a period are netted (here 3,000 net loss). A period with a net gain shows a negative other expense. Separate gain (other_income) / loss (other_expense) accounts would first need a change to Trigon\'s own ledger.' },
    ];
    return { at: stamp(), state, rows, vat, mutations, adopts, confirmable, token, counts, targets, vat_diagnostic, decisions,
      // (older names, kept for the screen and the scheduler)
      legacy_counts: { create: counts.CREATE_APPROVED, adopt: adopts.length, conflict: counts.ACCOUNT_CONFLICT + counts.BLOCKED, missing: counts.BLOCKED, ambiguous: counts.AMBIGUOUS, vat_required: counts.VAT_CONFIGURATION_REQUIRED } };
  }

  // ---------- apply: POST /chartofaccounts only, each read back and checked, then remembered by its Zoho id ----------
  // the client given to provisioning cannot do anything else (a second barrier besides this code)
  const createOnly = cl => ({ get: (p, q) => cl.get(p, q), post: async (p, b) => { if (p !== '/chartofaccounts') throw new Error(`provisioning may only create accounts (refused: POST ${p})`); return cl.post(p, b); } });
  async function apply(p, { user = '', trigger = 'manual', only = null, confirmed = [] } = {}) {
    const c = X.cfg(), cl = createOnly(X.client(c)), res = { created: [], adopted: [], failed: [], conflicts: p.rows.filter(r => ['conflict', 'blocked'].includes(r.action)).map(r => ({ key: r.key, code: r.code, reason: r.reason })) };
    for (const k of confirmed) { const r = p.rows.find(x => x.key === k && x.action === 'confirm');   // administrator-confirmed adoption of an exact-name match
      if (!r) continue; saveMap(k, { account_id: r.zoho.id, account_name: r.zoho.name, account_type: r.zoho.type, account_code: r.zoho.code, parent_account_id: r.zoho.parent_id }, { label: r.name });
      res.adopted.push({ key: k, zoho_id: r.zoho.id, how: 'ADOPT_EXISTING_AFTER_CONFIRMATION' }); }
    for (const a of p.adopts) {                                                          // local only: remember the Zoho id
      if (only && !only(a.key)) continue;
      const r = [...p.rows, ...p.vat].find(x => (x.key || 'acct:' + x.code) === a.key);
      saveMap(a.key, { account_id: a.zoho_id, account_name: r.zoho.name, account_type: r.zoho.type, account_code: r.zoho.code, parent_account_id: r.zoho.parent_id }, { partnerId: r.partner_id || null, label: r.name || r.label });
      res.adopted.push({ key: a.key, zoho_id: a.zoho_id, how: a.how });
    }
    for (const m of p.mutations) {
      if (only && !only(m.key)) continue;
      const r = p.rows.find(x => x.key === m.key), body = { ...m.body };
      try {
        if (r.parent_key) { const par = mapRow(r.parent_key); if (!par || !par.zoho_id) throw new Error(`its parent ${r.parent_key.slice(5)} is not in Zoho`); body.parent_account_id = par.zoho_id; }
        const made = await cl.post('/chartofaccounts', body), id = String(((made && made.chart_of_account) || made || {}).account_id || '');
        if (!id) throw new Error('Zoho did not return the new account id');
        const back = await cl.get('/chartofaccounts/' + id), a = (back && back.chart_of_account) || back;   // read back what Zoho holds
        const bad = [['account_type', body.account_type], ['account_code', body.account_code], ['account_name', body.account_name], ...(body.parent_account_id ? [['parent_account_id', body.parent_account_id]] : [])].filter(([k, v]) => String(a[k] || '') !== String(v));
        saveMap(m.key, { ...a, account_id: id }, { created: 1, partnerId: r.partner_id || null, label: r.name });   // remembered at once (also when the check fails: never created twice)
        if (bad.length) { db.prepare("UPDATE zoho_map SET verified_at=NULL WHERE kind='account' AND local_key=?").run(m.key); throw new Error(`READ_BACK_MISMATCH: ${bad.map(([k, v]) => `${k} is "${a[k] || ''}", expected "${v}"`).join('; ')}`); }
        res.created.push({ key: m.key, zoho_id: id, name: body.account_name, code: body.account_code, type: body.account_type, parent_id: body.parent_account_id || '' });
      } catch (e) { res.failed.push({ key: m.key, name: body.account_name, error: String(e.message).slice(0, 300) }); }
    }
    for (const r of p.rows.filter(x => x.action === 'follow' && (!only || only(x.key)))) { const m = mapRow(r.follows); if (m && m.zoho_id) { saveMap(r.key, { account_id: m.zoho_id, account_name: m.zoho_name, account_type: m.zoho_type, account_code: m.zoho_code, parent_account_id: m.parent_id }, { label: r.name }); res.adopted.push({ key: r.key, zoho_id: m.zoho_id, how: 'FOLLOWS ' + r.follows }); } }
    db.prepare('INSERT INTO zoho_provision_runs(at,user,trigger,token,created,adopted,conflicts,failed,result) VALUES(?,?,?,?,?,?,?,?,?)').run(stamp(), user, trigger, p.token || '', res.created.length, res.adopted.length, res.conflicts.length, res.failed.length, JSON.stringify(res));
    return res;
  }

  // ---------- the gate: the read-only preflight, then the account check; READY only with nothing missing, wrong or in conflict ----------
  async function preflightAndGate(user, why) {
    const r = await X.sync({ trigger: 'preflight', user, dryRun: true }), pf = r.preflight;
    let p = null; try { p = await plan(X.client(X.cfg(), true)); } catch (e) { p = { state: 'Error', error: e.message, rows: [], vat: [], counts: {} }; }
    const accts = [...pf.required_accounts, ...pf.partner_accounts.flatMap(x => x.accounts)];
    const reasons = [...pf.blockers, ...pf.to_configure];
    const wrong = accts.filter(a => ['type_mismatch', 'not_found'].includes(a.status)).length, missing = accts.filter(a => ['missing', 'ambiguous'].includes(a.status)).length;
    if (p.state !== 'Ready') reasons.push(p.error ? `account check failed: ${p.error}` : `accounts: ${p.state} — ${Object.entries(p.counts).filter(([k, v]) => v && !['ADOPT_EXISTING'].includes(k)).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    for (const r of [...(p.rows || []), ...(p.vat || [])].filter(r => ['ACCOUNT_CONFLICT', 'AMBIGUOUS', 'BLOCKED', 'VAT_CONFIGURATION_REQUIRED'].includes(r.classification))) reasons.push(`${r.code} ${r.name}: ${r.classification}${r.reason ? ' (' + r.reason + ')' : ''}`);
    if (X.cfg().post !== '1') reasons.push('"Post documents in Zoho" is off: Zoho keeps drafts out of its ledger, so its accounting effect could not equal Trigon\'s — switch it on in the Zoho settings');
    const t = p.targets || { missing_mappings: 1, wrong_types: 0, ambiguous_matches: 0, blocking_conflicts: 0 };
    const missingAll = missing + t.missing_mappings, wrongAll = wrong + t.wrong_types, ambiguous = t.ambiguous_matches + accts.filter(a => a.status === 'ambiguous').length, blockingAll = pf.blockers.length + t.blocking_conflicts;
    const ready = pf.verdict === 'READY' && !missingAll && !wrongAll && !ambiguous && !blockingAll && p.state === 'Ready' && X.cfg().post === '1';
    const gate = { verdict: pf.verdict, ready, missing_mappings: missingAll, wrong_types: wrongAll, ambiguous_matches: ambiguous, blocking_conflicts: blockingAll, account_state: p.state, reasons: [...new Set(reasons)].slice(0, 60), at: stamp(), why };
    X.setCfg('gate', ready ? 'READY' : ''); X.setCfg('gate_info', JSON.stringify(gate)); X.setCfg('pf_verdict', pf.verdict); X.setCfg('pf_at', new Date().toISOString());
    return { gate, preflight: pf, plan: p };
  }

  // ---------- continuous sending ----------
  // the local fingerprint of what would be sent: computed without Zoho, so an idle minute costs no API call
  function fingerprint() {
    const c = X.cfg(), from = c.start || null, to = today(), { invoices, bills, payments } = X.data(from, to);
    return X.hashOf([invoices.map(i => [i.id, i.number, i.date, i.total, i.voided, i.items]), bills.map(b => [b.id, b.date, b.total, b.party_id, b.category]), payments.map(p => [p.id, p.date, p.amount, p.method, p.cheque_status, p.bill_id, p.invoice_id]),
      X.journals(from, to).map(j => [j.kind, j.local_id, j.date, j.lines]), db.prepare("SELECT local_key, zoho_id FROM zoho_map ORDER BY kind, local_key").all(), partners(), c.start_v2 || '', c.post || '']);
  }
  const due = () => db.prepare("SELECT COUNT(*) n FROM zoho_sync WHERE status IN ('error','retrying') AND (next_at IS NULL OR next_at <= ?)").get(new Date().toISOString()).n;
  let ticking = false;
  // one minute of the continuous sync. Returns what it did (tests call it directly).
  async function tick({ force = false } = {}) {
    const c = X.cfg();
    if (c.enabled !== '1' || c.continuous !== '1') return { skipped: 'off' };
    if (c.gate !== 'READY') return { skipped: 'gate' };
    if (ticking || X.isRunning()) return { skipped: 'busy' };
    if (!force && c.q_next_at && c.q_next_at > new Date().toISOString()) return { skipped: 'backoff' };
    ticking = true;
    try {
      // a partner added in Trigon: his three sub-accounts are created (the same allowlisted operation), nothing else
      const todo = partners().filter(p => PARENTS.some(([code]) => !(mapRow(`acct:${code}:p${p.id}`) || {}).zoho_id));
      const backoff = msg => { const k = (+X.cfg().q_fail || 0) + 1; X.setCfg('q_fail', k); X.setCfg('q_next_at', new Date(Date.now() + Math.min(60, 2 ** (k - 1)) * 60000).toISOString()); X.setCfg('q_error', String(msg).slice(0, 300)); };
      let prov = null;
      if (todo.length) {
        try { const p = await plan(X.client(c, true)), keys = new Set(todo.flatMap(t => PARENTS.map(([code]) => `acct:${code}:p${t.id}`)));
          prov = await apply(p, { trigger: 'continuous', only: k => keys.has(k) }); }
        catch (e) { backoff(e.message); return { ran: false, run_failed: true, error: e.message }; }   // Zoho unreachable: back off, Trigon carries on
      }
      const fp = fingerprint(), n = due();
      if (!force && fp === c.q_fp && !n && !(prov && (prov.created.length || prov.adopted.length))) return { skipped: 'nothing new', prov };
      const r = await X.sync({ trigger: 'continuous', user: 'continuous' });
      const runFailed = !!r.message && !(r.errors || []).length;                          // Zoho unreachable for the whole run: back off, Trigon carries on
      if (runFailed) { backoff(r.message); return { ran: true, run_failed: true, result: r, prov }; }
      X.setCfg('q_fail', 0); X.setCfg('q_next_at', ''); X.setCfg('q_error', ''); X.setCfg('q_fp', fp); X.setCfg('last_ok', stamp());
      return { ran: true, result: r, prov };
    } finally { ticking = false; }
  }

  // ---------- reconciliation ----------
  const PATHS = { invoice: ['/invoices', 'invoice'], creditnote: ['/creditnotes', 'creditnote'], bill: ['/bills', 'bill'], expense: ['/expenses', 'expense'], expense2: ['/expenses', 'expense'], journal: ['/journals', 'journal'], customerpayment: ['/customerpayments', 'payment'], vendorpayment: ['/vendorpayments', 'vendorpayment'] };
  const ZCLASS = t => (['bank', 'cash', 'other_current_asset', 'fixed_asset', 'other_asset', 'accounts_receivable', 'stock', 'input_tax', 'payment_clearing', 'prepaid_card'].includes(t) ? 'asset'
    : ['other_current_liability', 'credit_card', 'long_term_liability', 'other_liability', 'accounts_payable', 'output_tax', 'overseas_tax_payable', 'deferred_tax_liability'].includes(t) ? 'liability'
      : t === 'equity' ? 'equity' : ['income', 'other_income'].includes(t) ? 'revenue' : ['expense', 'cost_of_goods_sold', 'other_expense'].includes(t) ? 'expense' : 'other');
  const gone = e => e.status === 404 || e.code === 1002 || /does not exist/i.test(e.message || '');
  const sleep = ms => (ms > 0 ? new Promise(ok => setTimeout(ok, ms)) : Promise.resolve());
  const pace = () => (ctx.zohoReconPace != null ? ctx.zohoReconPace : 650);              // stay under Zoho's 100 requests a minute
  const near = (a, b) => Math.abs((a || 0) - (b || 0)) < 0.005;                          // the ledger's 2 decimals

  // which Zoho account holds each Trigon code (and each partner's share of 3000 / 2500 / 3110)
  function accountGroups(lk, all) {
    const g = new Map(), add = (zid, code, partnerId) => { if (!zid) return; zid = String(zid); const e = g.get(zid) || { zoho_id: zid, codes: new Set(), partners: new Set() }; e.codes.add(String(code)); if (partnerId) e.partners.add(partnerId); g.set(zid, e); };
    for (const m of db.prepare("SELECT local_key, zoho_id FROM zoho_map WHERE kind='account'").all()) {
      const [k, code, p] = m.local_key.split(':');
      if (k === 'acct') add(m.zoho_id, code, p ? +p.slice(1) : null);
      else if (k === 'cat') add(m.zoho_id, ctx.expenseCode ? ctx.expenseCode(code) : code);
    }
    const mapped = new Set([...g.values()].flatMap(e => [...e.codes]));
    const auto = (code, a) => { if (!mapped.has(code) && a) add(a.account_id, code); };
    for (const b of X.bankAccounts()) auto(b.ledger_code, lk.bank || lk.cash);
    auto('1020', lk.cash || lk.bank); auto('1100', lk.ar); auto('2000', lk.ap); auto('1150', lk.retention);
    const income = all.filter(a => a.account_type === 'income' && a.is_active !== false); if (income.length === 1) auto('4000', income[0]);
    return g;
  }
  async function zohoMovements(cl, zid, from, cutoff, ours) {
    let sum = 0, only = 0; const list = [];
    for (let page = 1; page <= 50; page++) {
      const r = await cl.get('/chartofaccounts/accounttransactions', { account_id: zid, ...(from ? { date_start: from } : {}), date_end: cutoff, page, per_page: 200 }), tx = r.transactions || [];
      for (const t of tx) { const v = round((+t.debit_amount || 0) - (+t.credit_amount || 0)); sum = round(sum + v);
        if (!ours.has(String(t.transaction_id))) { only = round(only + v); list.push({ zoho_account: zid, date: t.transaction_date || t.date, type: t.transaction_type, id: String(t.transaction_id || ''), ref: t.reference_number || t.entry_number || '', amount: v }); } }
      if (tx.length < 200 && !(r.page_context && r.page_context.has_more_page)) break;
      await sleep(pace());
    }
    return { sum, only, list };
  }

  async function reconcile({ user = '', trigger = 'manual', from: f, cutoff: t, basis = 'balance' } = {}) {
    const c = X.cfg(), cutoff = t || today(), started = stamp(), from = basis === 'movement' ? (f || c.start || null) : null, itemFrom = f || c.start || null;
    const id = db.prepare('INSERT INTO zoho_recon(started,trigger,user,basis,date_from,cutoff,status) VALUES(?,?,?,?,?,?,?)').run(started, trigger, user, basis, from || '', cutoff, 'running').lastInsertRowid;
    try {
      // a. Trigon's side record by record: what a send would do now (read only)
      const dryr = await X.sync({ trigger: 'reconcile', user, dryRun: true, keepVals: true, from: itemFrom, to: cutoff });
      const cl = X.client(c, true), lk = await X.lookups(cl), all = lk.coa;
      const act = new Map(); for (const i of dryr.items_all || []) if (i.kind !== 'contact') act.set(`${i.kind}:${i.local_id}`, i);
      const rows = db.prepare("SELECT * FROM zoho_sync WHERE kind <> 'contact'").all().filter(r => !r.doc_date || ((!itemFrom || r.doc_date >= itemFrom) && r.doc_date <= cutoff));
      const keys = new Set([...act.keys(), ...rows.map(r => `${r.kind}:${r.local_id}`)]), items = [];
      const byKey = new Map(rows.map(r => [`${r.kind}:${r.local_id}`, r]));
      for (const key of keys) {
        const i = act.get(key), r = byKey.get(key), [kind, lid] = key.split(':'), base = { kind, local_id: +lid, ref: i ? i.ref : '', zoho_id: r && r.zoho_id || null, zoho_type: r && r.zoho_type || null };
        let st, note = '';
        if ((r && ['cancelled', 'included'].includes(r.status) && !(i && ['create', 'update'].includes(i.action))) || (i && i.action === 'skip' && /part of the Zoho expense/.test(i.why))) continue;   // removed, or inside a Zoho expense
        if (r && r.status === 'blocked') { st = 'BLOCKED'; note = r.error || ''; }
        else if (r && r.status === 'retrying') { st = 'RETRYING'; note = r.error || ''; }
        else if (i && i.action === 'error') { st = /map our account|not mapped|map it|first\b/i.test(i.why) ? 'MISSING_MAPPING' : /ACCOUNT_CONFLICT|CLOSED_PERIOD|ZOHO_MODIFIED|POSSIBLE_DUPLICATE|VERIFY_MISMATCH/.test(i.why) ? 'BLOCKED' : 'PENDING_SYNC'; note = i.why; }
        else if (i && i.action === 'conflict') { st = 'BLOCKED'; note = i.why; }
        else if (i && ['create', 'update', 'remove', 'void', 'link'].includes(i.action)) { st = 'PENDING_SYNC'; note = `${i.action}${i.why ? ': ' + i.why : ''}`; }
        else if (i && i.action === 'skip') { st = 'TRIGON_ONLY'; note = `not sent by design: ${i.why}`; }
        else if (r && r.zoho_id && ['ok', 'changed'].includes(r.status) && PATHS[r.zoho_type]) {
          const [path, k] = PATHS[r.zoho_type];
          let obj = null; try { const res = await cl.get(`${path}/${r.zoho_id}`); obj = res[k]; } catch (e) { if (!gone(e)) throw e; }
          await sleep(pace());
          if (!obj) { st = 'TRIGON_ONLY'; note = 'deleted in Zoho'; }
          else if (obj.status === 'void' && r.status === 'ok') { st = 'TRIGON_ONLY'; note = 'void in Zoho, live in Trigon'; }
          else if (['draft'].includes(obj.status)) { st = 'PENDING_SYNC'; note = 'draft in Zoho — not posted to its ledger'; }
          else {
            const exp = r.sent_eff ? J(r.sent_eff) : (dryr.vals && dryr.vals.get(key) || {}).eff;
            st = exp ? X.compareEff(exp, X.effect(r.zoho_type, obj, lk)) : 'MATCH'; note = exp ? '' : 'sent before this version: compared by existence only';
            if (st !== 'MATCH') note = `changed in Zoho after Trigon sent it (${st.toLowerCase().replace('_', ' ')})`;
          }
        } else if (r && ['cancelled', 'included', 'skipped'].includes(r.status)) continue;
        else { st = 'PENDING_SYNC'; note = r ? r.status : 'not sent yet'; }
        items.push({ ...base, status: st, note: String(note || '').slice(0, 300) });
        if (r) db.prepare('UPDATE zoho_sync SET recon=?, recon_at=?, recon_note=? WHERE kind=? AND local_id=?').run(st, stamp(), String(note || '').slice(0, 300), kind, +lid);
      }

      // b. Trial Balance against Trial Balance at the same cutoff (per Zoho account; Trigon codes that share one are added up)
      const groups = accountGroups(lk, all), ours = new Set(db.prepare('SELECT zoho_id FROM zoho_sync WHERE zoho_id IS NOT NULL').all().map(r => String(r.zoho_id)));
      const tmov = {}, tpart = {}, inWin = d => (!from || d >= from) && d <= cutoff;
      for (const x of ctx.ledgerEntries ? ctx.ledgerEntries() : []) if (inWin(x.date)) for (const l of x.lines) tmov[String(l.account)] = round((tmov[String(l.account)] || 0) + l.debit - l.credit);
      for (const x of ctx.partnerEntries ? ctx.partnerEntries() : []) if (inWin(x.date) && x.partner_id) for (const [a, dr, cr] of x.lines) { const k = `${a}:${x.partner_id}`; tpart[k] = round((tpart[k] || 0) + dr - cr); }
      const accts = Object.fromEntries(db.prepare('SELECT code, name, type FROM accounts').all().map(a => [String(a.code), a]));
      const zohoAll = all.filter(a => a.is_active !== false), tb = [], zonly = [];
      // compared per "key": a Trigon code, or a partner's share of 3000 / 2500 / 3110 when he has his own Zoho account. Zoho accounts
      // that share a key (e.g. 1600 on the fixed-asset account and on the account of the "asset" bill category) form one row.
      const partnerSplit = new Set(['3000', '2500', '3110']);
      const keysOf = grp => [...grp.codes].flatMap(code => (partnerSplit.has(code) && grp.partners.size ? [...grp.partners].map(p => `${code}:p${p}`) : [code]));
      const own = {}; for (const g2 of groups.values()) for (const k of keysOf(g2)) if (k.includes(':p')) (own[k.split(':')[0]] ||= new Set()).add(+k.split(':p')[1]);
      const tval = k => { if (k.includes(':p')) { const [code, p] = k.split(':p'); return tpart[`${code}:${p}`] || 0; }
        return round((tmov[k] || 0) - (partnerSplit.has(k) ? [...(own[k] || [])].reduce((s2, p) => s2 + (tpart[`${k}:${p}`] || 0), 0) : 0)); };
      const comps = [], unmapped = [];
      for (const a of zohoAll) {
        const zid = String(a.account_id), grp = groups.get(zid), z = await zohoMovements(cl, zid, from, cutoff, ours); await sleep(pace());
        zonly.push(...z.list);
        const part = { id: zid, name: a.account_name, type: a.account_type, cls: ZCLASS(a.account_type), zoho: z.sum, only: z.only };
        if (!grp) { if (!near(z.sum, 0)) unmapped.push(part); continue; }
        const ks = new Set(keysOf(grp)), hit = comps.filter(cp => [...ks].some(k => cp.keys.has(k)));
        const merged = { keys: new Set([...ks, ...hit.flatMap(cp => [...cp.keys])]), parts: [...hit.flatMap(cp => cp.parts), part] };
        for (const cp of hit) comps.splice(comps.indexOf(cp), 1);
        comps.push(merged);
      }
      const covered = new Set();
      for (const cp of comps) {
        const keys = [...cp.keys], trig = round(keys.reduce((s2, k) => s2 + tval(k), 0)), zsum0 = round(cp.parts.reduce((s2, x) => s2 + x.zoho, 0));
        for (const k of keys) covered.add(k);
        tb.push({ zoho_id: cp.parts.map(x => x.id).join(','), zoho_name: cp.parts.map(x => x.name).join(' + '), zoho_type: [...new Set(cp.parts.map(x => x.type))].join(','), parts: cp.parts,
          codes: [...new Set(keys.map(k => k.split(':')[0]))], partners: [...new Set(keys.filter(k => k.includes(':p')).map(k => +k.split(':p')[1]))],
          trigon: trig, zoho: zsum0, zoho_only: round(cp.parts.reduce((s2, x) => s2 + x.only, 0)), difference: round(zsum0 - trig), status: near(zsum0, trig) ? 'MATCH' : 'DIFFERENCE' });
      }
      for (const x of unmapped) tb.push({ zoho_id: x.id, zoho_name: x.name, zoho_type: x.type, parts: [x], codes: [], partners: [], trigon: 0, zoho: x.zoho, zoho_only: x.only, difference: x.zoho, status: 'ZOHO_ONLY' });
      for (const code of Object.keys(tmov)) {                                             // Trigon movements on a code no Zoho account holds
        const rest = covered.has(code) ? 0 : tval(code);                                  // (for 3000 / 2500 / 3110: what is not on a partner's own account)
        if (!near(rest, 0)) tb.push({ zoho_id: null, zoho_name: '', zoho_type: '', parts: [], codes: [code], partners: [], trigon: rest, zoho: 0, zoho_only: 0, difference: round(-rest), status: 'MISSING_MAPPING' });
      }
      const tsum = (pred) => round(Object.entries(tmov).filter(([code]) => pred(code)).reduce((s, [, v]) => s + v, 0));
      const zsum = (pred) => round(tb.filter(r => r.zoho_id && pred(r)).reduce((s, r) => s + r.zoho, 0));
      const zcls = cls => round(tb.flatMap(r => r.parts || []).filter(x => x.cls === cls).reduce((s, x) => s + x.zoho, 0));
      const typeOf = code => (accts[code] || {}).type || '', inCodes = list => r => r.codes.some(c2 => list.includes(c2));
      const bankCodes = [...new Set([...X.bankAccounts().map(b => b.ledger_code), '1000', '1010', '1020', '1030'])];
      const line = (name, t2, z2) => ({ name, trigon: t2, zoho: z2, difference: round(z2 - t2), status: near(t2, z2) ? 'MATCH' : 'DIFFERENCE' });
      const statements = [
        line('Balance sheet — assets', tsum(c2 => typeOf(c2) === 'asset'), zcls('asset')),
        line('Balance sheet — liabilities', tsum(c2 => typeOf(c2) === 'liability'), zcls('liability')),
        line('Balance sheet — equity', tsum(c2 => typeOf(c2) === 'equity'), zcls('equity')),
        line('Profit & loss — revenue', tsum(c2 => typeOf(c2) === 'revenue'), zcls('revenue')),
        line('Profit & loss — expenses', tsum(c2 => typeOf(c2) === 'expense'), zcls('expense')),
        line('VAT control (1200, 2100)', tsum(c2 => ['1200', '2100'].includes(c2)), zsum(inCodes(['1200', '2100']))),
        line('Accounts receivable (1100, 1150)', tsum(c2 => ['1100', '1150'].includes(c2)), zsum(inCodes(['1100', '1150']))),
        line('Accounts payable (2000)', tsum(c2 => c2 === '2000'), zsum(inCodes(['2000']))),
        line('Bank and cash', tsum(c2 => bankCodes.includes(c2)), zsum(inCodes(bankCodes))),
        line('Fixed assets — net book value (1600 cost + 1690 accumulated depreciation)', tsum(c2 => ['1600', '1690'].includes(c2)), zsum(inCodes(['1600', '1690']))),
        line('Gain / loss on disposal (6150: debit = loss, credit = gain)', tsum(c2 => c2 === '6150'), zsum(inCodes(['6150']))),
        line('Partner accounts (3000, 2500, 3110)', tsum(c2 => ['3000', '2500', '3110'].includes(c2)), zsum(inCodes(['3000', '2500', '3110']))),
        line('Employee control accounts (1300, 1030, 2200, 2250, 2260, 2300)', tsum(c2 => ['1300', '1030', '2200', '2250', '2260', '2300'].includes(c2)), zsum(inCodes(['1300', '1030', '2200', '2250', '2260', '2300']))),
      ];
      const dr = rs => round(rs.reduce((s, v) => s + (v > 0 ? v : 0), 0)), crs = rs => round(rs.reduce((s, v) => s + (v < 0 ? -v : 0), 0));
      const totals = { trigon_debit: dr(Object.values(tmov)), trigon_credit: crs(Object.values(tmov)), zoho_debit: dr(tb.flatMap(r => r.parts || []).map(x => x.zoho)), zoho_credit: crs(tb.flatMap(r => r.parts || []).map(x => x.zoho)) };
      const by = {}; for (const x of items) by[x.status] = (by[x.status] || 0) + 1;
      const tbOk = tb.every(r => r.status === 'MATCH'), itemsOk = items.every(x => ['MATCH', 'TRIGON_ONLY'].includes(x.status) && !(x.status === 'TRIGON_ONLY' && /deleted|void in Zoho/.test(x.note)));
      const summary = { items: by, tb: { rows: tb.length, match: tb.filter(r => r.status === 'MATCH').length, difference: tb.filter(r => r.status === 'DIFFERENCE').length, zoho_only: tb.filter(r => r.status === 'ZOHO_ONLY').length, missing_mapping: tb.filter(r => r.status === 'MISSING_MAPPING').length }, totals, zoho_only_entries: zonly.length };
      const status = tbOk && itemsOk ? 'MATCH' : 'DIFFERENCES';
      db.prepare('UPDATE zoho_recon SET finished=?, status=?, summary=?, tb=?, statements=?, items=?, zoho_only=? WHERE id=?').run(stamp(), status, JSON.stringify(summary), JSON.stringify(tb), JSON.stringify(statements), JSON.stringify(items.slice(0, 5000)), JSON.stringify(zonly.slice(0, 2000)), id);
      X.setCfg('last_recon', stamp()); X.setCfg('last_recon_status', status);
      return { id, status, basis, from, cutoff, summary, tb, statements, items, zoho_only: zonly };
    } catch (e) {
      db.prepare('UPDATE zoho_recon SET finished=?, status=?, message=? WHERE id=?').run(stamp(), 'FAILED', String(e.message).slice(0, 500), id);
      throw e;
    }
  }

  // ---------- status for the administrator ----------
  function status() {
    const c = X.cfg(), q = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM zoho_sync GROUP BY status').all().map(r => [r.status, r.n]));
    const last = db.prepare("SELECT id, started, finished, status, cutoff, basis, summary FROM zoho_recon WHERE status <> 'running' ORDER BY id DESC LIMIT 1").get();
    const gate = J(c.gate_info) || {}, prov = db.prepare('SELECT at, user, trigger, created, adopted, conflicts, failed FROM zoho_provision_runs ORDER BY id DESC LIMIT 1').get();
    let changes = null; try { changes = c.q_fp ? fingerprint() !== c.q_fp : null; } catch { changes = null; }
    return { connection: { connected: !!(c.client_id && c.client_secret && c.refresh_token), organization: c.org_name || '', organization_id: c.org || '', data_centre: c.dc },
      enabled: c.enabled === '1', continuous: c.continuous === '1', post: c.post === '1', gate: c.gate === 'READY' ? 'READY' : 'NOT READY', gate_info: gate, account_provisioning: gate.account_state || 'not checked yet',
      queue: { retrying: q.retrying || 0, error: q.error || 0, blocked: q.blocked || 0, sending: q.sending || 0, synced: q.ok || 0, due_now: due(), unsent_changes: changes, backoff_until: c.q_next_at || '', last_error: c.q_error || '' },
      last_successful_sync: c.last_ok || '', last_reconciliation: last ? { ...last, summary: J(last.summary) } : null,
      trial_balance: !last ? 'not reconciled yet' : (() => { const t2 = (J(last.summary) || {}).tb || {}; return t2.difference || t2.missing_mapping || t2.zoho_only ? 'Difference' : 'Match'; })(),
      last_provisioning: prov || null, recon_hour: c.recon_hour || '2' };
  }

  // scheduler (server edition only): the continuous sync every minute, the reconciliation once a day
  if (typeof window === 'undefined' && !process.env.ZOHO_NO_SCHEDULER) {
    setInterval(() => { tick().catch(() => {}); }, 60 * 1000).unref();
    setInterval(() => { const c = X.cfg(), h = new Date().getHours();
      if (c.enabled === '1' && c.continuous === '1' && c.gate === 'READY' && h === +(c.recon_hour || 2) && (c.last_recon || '').slice(0, 10) !== today()) reconcile({ trigger: 'daily', user: 'scheduler' }).catch(() => {}); }, 10 * 60 * 1000).unref();
  }
  ctx.zohoAcct = { plan: () => plan(X.client(X.cfg(), true)), apply, _createOnly: createOnly, preflightAndGate, tick, reconcile, status, fingerprint, ALLOW, PARENTS };

  const canFin = me => ['admin', 'accountant'].includes(me.role);
  return {
    async handle(req, res, url, [a, b], me) {
      if (a !== 'zoho-sync') return false;
      if (!canFin(me)) return send(res, 403, { error: 'forbidden' }), true;
      const m = req.method, admin = me.role === 'admin', no = () => send(res, 403, { error: 'only an administrator can do this' });
      const run = async fn => { try { return send(res, 200, await fn()), true; } catch (e) { return send(res, 400, { error: e.message }), true; } };
      if (m === 'GET' && !b) return send(res, 200, status()), true;
      if (m === 'POST' && b === 'preflight') return run(async () => { const r = await preflightAndGate(me.username, 'preflight'); audit(req, 'preflight', 'zoho', 0, `${r.preflight.verdict}; gate ${r.gate.ready ? 'READY' : 'not ready'}`); return { gate: r.gate, verdict: r.preflight.verdict, preflight: r.preflight, plan: r.plan }; });
      if (m === 'GET' && b === 'preview') return run(async () => plan(X.client(X.cfg(), true)));
      if (m === 'POST' && b === 'provision') {
        if (!admin) return no(), true;
        return run(async () => {
          const x = await readBody(req), c = X.cfg();
          if (!['READY', 'READY WITH MISSING MAPPINGS'].includes(c.pf_verdict) || !c.pf_at || Date.now() - Date.parse(c.pf_at) > 24 * 3600 * 1000) throw new Error('Run the read-only preflight first (it must be READY or READY WITH MISSING MAPPINGS, within the last 24 hours)');
          const p = await plan(X.client(c, true));
          if (!x.confirm || x.token !== p.token) throw new Error('The proposed changes differ from the preview you confirmed (or nothing was confirmed) — preview again');
          const confirmed = (Array.isArray(x.confirm_adopt) ? x.confirm_adopt : []).map(String);
          for (const k of confirmed) if (!p.confirmable.some(c => c.key === k)) throw new Error(`${k} is not an account the preview proposed for confirmation`);
          const r = await apply(p, { user: me.username, trigger: 'manual', confirmed });
          audit(req, 'provision', 'zoho_accounts', 0, `created ${r.created.length}, adopted ${r.adopted.length}, conflicts ${r.conflicts.length}, failed ${r.failed.length}`);
          const again = await preflightAndGate(me.username, 'after provisioning');       // the second preflight decides the gate
          return { result: r, gate: again.gate, plan: again.plan };
        });
      }
      if (m === 'POST' && b === 'retry') {
        if (!admin) return no(), true;
        const n = db.prepare("UPDATE zoho_sync SET next_at=NULL, attempts=0, status=CASE WHEN status='blocked' THEN 'error' ELSE status END WHERE status IN ('error','retrying','blocked')").run().changes;
        X.setCfg('q_next_at', ''); X.setCfg('q_fail', 0); audit(req, 'retry', 'zoho_sync', 0, `${n} record(s) released for a new attempt`);
        return send(res, 200, { released: n }), true;
      }
      if (m === 'POST' && b === 'reconcile') return run(async () => { const x = await readBody(req); const r = await reconcile({ user: me.username, from: x.from, cutoff: x.cutoff, basis: x.basis === 'movement' ? 'movement' : 'balance' }); audit(req, 'reconcile', 'zoho', 0, `${r.status} (cutoff ${r.cutoff})`); return r; });
      if (m === 'GET' && b === 'recon') {
        const id = +url.searchParams.get('id') || (db.prepare("SELECT id FROM zoho_recon WHERE status <> 'running' ORDER BY id DESC LIMIT 1").get() || {}).id;
        const r = id && db.prepare('SELECT * FROM zoho_recon WHERE id=?').get(id);
        if (!r) return send(res, 404, { error: 'no reconciliation yet' }), true;
        return send(res, 200, { ...r, summary: J(r.summary), tb: J(r.tb), statements: J(r.statements), items: J(r.items), zoho_only: J(r.zoho_only) }), true;
      }
      if (m === 'PUT' && b === 'settings') {
        if (!admin) return no(), true;
        const x = await readBody(req);
        if (x.recon_hour != null && !(+x.recon_hour >= 0 && +x.recon_hour <= 23)) return send(res, 400, { error: 'Hour must be 0–23' }), true;
        if (x.continuous !== undefined) X.setCfg('continuous', x.continuous === '1' || x.continuous === true ? '1' : '0');
        if (x.recon_hour != null) X.setCfg('recon_hour', String(+x.recon_hour));
        audit(req, 'update', 'zoho_config', 0, `continuous ${X.cfg().continuous}, reconciliation hour ${X.cfg().recon_hour || 2}`);
        return send(res, 200, status()), true;
      }
      return send(res, 404, { error: 'not found' }), true;
    },
  };
};
