// Screenshots of the screens added after the first guide (cheques, cash-flow, guarantees, spend approvals, closed period /
// backups, two-step sign-in, equipment log, programme). Plain captures of the main pane, Arabic and English.
//   DATA_DIR=/tmp/guide-data PORT=3999 node server.js &   →   node tools/guide-shots/seed.js   →   node tools/guide-shots/run5.js
const { chromium } = require('playwright'), path = require('path');
const BASE = process.env.BASE || 'http://localhost:3999', OUT = path.join(__dirname, '..', '..', 'public', 'guide', 'img');
(async () => {
  const b = await chromium.launch(), ctx = await b.newContext({ viewport: { width: 1366, height: 1000 }, deviceScaleFactor: 1.25 }), p = await ctx.newPage();
  p.on('dialog', d => d.accept());
  await p.goto(BASE); await p.waitForLoadState('networkidle'); await p.waitForTimeout(800);
  await p.evaluate(async () => {
    const j = (m, u, x) => fetch('/api/' + u, { method: m, headers: { 'Content-Type': 'application/json' }, body: x ? JSON.stringify(x) : undefined }).then(r => r.json());
    await j('POST', 'login', { username: 'admin', password: 'Trigon2026' });
    const d = n => { const x = new Date(Date.now() + n * 864e5); return new Date(x.getTime() - x.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
    const projects = await j('GET', 'projects'), P = projects.find(x => x.status === 'active') || projects[0], P2 = projects.find(x => x.id !== P.id) || P;
    if (!(await j('GET', 'bank_guarantees')).length) {
      await j('POST', 'bank_guarantees', { type: 'performance', project_id: P.id, beneficiary: 'Al Noor Developments', bank: 'Emirates NBD', number: 'PG-2026-0142', amount: 250000, margin: 25000, issue_date: d(-200), expiry_date: d(21), status: 'active' });
      await j('POST', 'bank_guarantees', { type: 'advance', project_id: P2.id, beneficiary: 'Sharjah Municipality', bank: 'ADCB', number: 'APG-2026-0031', amount: 180000, margin: 0, issue_date: d(-90), expiry_date: d(240), status: 'active' });
      await j('PUT', 'settings', { po_approval_limit: 20000, pay_approval_limit: 50000 });
      const pos = await j('GET', 'purchase_orders'); if (pos[0]) await j('POST', 'spend-approvals', { kind: 'po', ref_id: pos[0].id, note: 'Urgent — site is waiting' });
      await j('PUT', 'projects/' + P.id, { start_date: d(-60), end_date: d(120) });
      for (const [t, a, z, pr] of [['Site clearance & excavation', -60, -25, 100], ['Foundations & footings', -30, 10, 70], ['Concrete structure', 0, 60, 15], ['Blockwork & plaster', 45, 95, 0], ['MEP works', 50, 110, 0], ['Finishes', 80, 125, 0], ['Temporary site services', -50, -10, 60]])
        await j('POST', 'schedule', { project_id: P.id, title: t, start_date: d(a), end_date: d(z), progress: pr });
      const a1 = (await j('POST', 'fixed_assets', { name: 'Excavator CAT 320', category: 'Equipment', serial: 'DXB 45821', purchase_date: '2025-01-01', cost: 300000, life_years: 8, status: 'active', project_id: P.id, hourly_rate: 150 })).id;
      const a2 = (await j('POST', 'fixed_assets', { name: 'Backhoe loader JCB 3CX', category: 'Equipment', serial: 'SHJ 77120', purchase_date: '2024-06-01', cost: 180000, life_years: 8, status: 'active', project_id: P.id, hourly_rate: 110 })).id;
      for (let i = 1; i <= 4; i++) { await j('POST', 'equipment/logs', { asset_id: a1, kind: 'usage', date: d(-i), project_id: P.id, hours: 8, operator: 'Ali' }); await j('POST', 'equipment/logs', { asset_id: a2, kind: 'usage', date: d(-i), project_id: P.id, hours: 5 }); }
      await j('POST', 'equipment/logs', { asset_id: a1, kind: 'fuel', date: d(-2), project_id: P.id, litres: 620, cost: 1800 });
      await j('POST', 'equipment/logs', { asset_id: a1, kind: 'maintenance', date: d(-20), cost: 1450, description: 'Oil and filters changed', next_due_date: d(9) });
      await j('POST', 'equipment/logs', { asset_id: a2, kind: 'maintenance', date: d(-70), cost: 900, description: 'Periodic service', next_due_date: d(-4) });
      await j('POST', 'backup/run'); await j('PUT', 'period', { lock_date: d(-45) });
    }
    sessionStorage.schP = P.id;
  });
  const shot = async (lang, name, sel = '#main') => { await p.waitForLoadState('networkidle'); await p.waitForTimeout(700); await p.locator(sel).first().screenshot({ path: path.join(OUT, lang, name), type: 'jpeg', quality: 82 }); console.log(lang, name); };
  for (const lang of ['ar', 'en']) {
    await p.evaluate(l => { localStorage.lang = l; }, lang);
    for (const [route, name] of [['cheques', 'n1-cheques.jpg'], ['cashflow', 'n2-cashflow.jpg'], ['guarantees', 'n3-guarantees.jpg'], ['spend', 'n4-spend-approvals.jpg'], ['equipment', 'n7-equipment.jpg'], ['schedule', 'n8-programme.jpg']]) {
      await p.goto(BASE + '/#' + route); await p.reload(); await shot(lang, name);
    }
    await p.goto(BASE + '/#settings'); await p.reload(); await p.waitForSelector('#locksave');
    await p.evaluate(() => { const x = document.querySelector('#ctlcards span[dir=ltr]'); if (x) x.textContent = 'C:\\erp\\data\\backups'; });   // the demo server's temp folder → the office path
    await shot(lang, 'n5-period-backup.jpg', '#ctlcards');
    await p.locator('#tfaon').click(); await p.waitForSelector('#tfacode'); await shot(lang, 'n6-two-step.jpg', '#tfacard');
  }
  await b.close();
})();
