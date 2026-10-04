// Multi-device OneDrive-sync test against a mock Microsoft server (development only).
const assert = require('node:assert'), createMock = require('./mock-ms.js');
const { server, api, PREFIX } = require('./selftest.js');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (fn, ms = 15000, what = 'condition') => { const t = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } if (Date.now() - t > ms) throw new Error('timeout waiting for ' + what); await sleep(150); } };

server.listen(0, async () => {
  const ms = createMock(); await new Promise(ok => ms.server.listen(0, ok));
  const url = `http://localhost:${server.address().port}${PREFIX}`;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  const errs = [];
  const device = async () => {
    const ctx = await browser.newContext(); await ctx.addInitScript(([a, g]) => { localStorage.erp_od_authority = a; localStorage.erp_od_graph = g; localStorage.erp_od_client = 'test-client-id'; }, [ms.authority(), ms.graph()]);
    const page = await ctx.newPage(); page.on('pageerror', e => errs.push(e.message)); page.on('dialog', d => d.accept()); await page.goto(url);
    await page.waitForFunction(() => document.querySelector('form.login, .side'), null, { timeout: 30000 }); return { ctx, page };
  };
  const state = p => p.evaluate(() => ERPCloud.st.state);
  const link = async p => { await p.evaluate(() => ERPCloud.signIn()); await p.waitForURL(u => u.href.startsWith(url), { timeout: 20000 }); await p.waitForFunction(() => document.querySelector('form.login, .side'), null, { timeout: 30000 }); };
  const remoteBytes = () => ms.files.get(ms.FILE)?.bytes, remoteTag = () => ms.files.get(ms.FILE)?.etag;
  // wait until this device has uploaded a NEW version (remote etag moved past `before`) and is in sync with it
  const uploadedSince = (p, before, what) => waitFor(async () => remoteTag() !== before && (await p.evaluate(() => ERPStore.rec.baseETag)) === remoteTag() && (await state(p)) === 'synced', 20000, what);
  try {
    // ===== Device A: create data, link OneDrive, first upload =====
    const A = await device();
    await A.page.fill('[name=username]', 'admin'); await A.page.fill('[name=password]', 'secret1'); await A.page.click('button.btn'); await A.page.waitForSelector('.side');
    assert.equal((await api(A.page, 'POST', 'parties', { type: 'client', name: 'P1 from A' })).s, 200);
    await sleep(900); assert.equal(await state(A.page), 'local');                                   // not linked yet
    await link(A.page);
    await waitFor(() => remoteBytes(), 15000, 'first upload'); await waitFor(async () => (await state(A.page)) === 'synced', 15000, 'A synced');
    assert.ok([...ms.files.keys()].some(k => k.startsWith('Trigon-ERP/backups/erp-')), 'daily backup copy was written');
    console.log('✔ A linked OneDrive and uploaded', remoteBytes().length, 'bytes (+ daily backup)');

    // ===== Device B: new device pulls the OneDrive copy, logs in with the same password =====
    const B = await device(); await link(B.page);
    await waitFor(async () => (await B.page.evaluate(() => !!document.querySelector('form.login'))), 20000, 'B login screen');
    await B.page.fill('[name=username]', 'admin'); await B.page.fill('[name=password]', 'secret1'); await B.page.click('button.btn'); await B.page.waitForSelector('.side');
    assert.ok((await api(B.page, 'GET', 'parties')).j.some(p => p.name === 'P1 from A'), 'B received A\'s data');
    console.log('✔ B downloaded the OneDrive copy and logged in with the same account');

    // ===== B edits → uploads; A sees the update and pulls it =====
    let e0 = remoteTag(); await api(B.page, 'POST', 'parties', { type: 'client', name: 'P2 from B' }); await uploadedSince(B.page, e0, 'B uploaded P2');
    await A.page.evaluate(() => ERPCloud.syncNow()); await waitFor(async () => (await state(A.page)) === 'update', 10000, 'A sees update');
    await A.page.evaluate(() => ERPCloud.pull()); await A.page.waitForFunction(() => document.querySelector('.side, form.login'), null, { timeout: 30000 });
    assert.ok((await api(A.page, 'GET', 'parties')).j.some(p => p.name === 'P2 from B'), 'A pulled B\'s change');
    console.log('✔ change on B reached A (update banner → pull)');

    // ===== Conflict: A edits offline while B uploads; A chooses the OneDrive copy =====
    await A.ctx.setOffline(true);
    await api(A.page, 'POST', 'parties', { type: 'client', name: 'P3 only on A' }); await sleep(3500);
    assert.ok(['dirty', 'offline'].includes(await state(A.page)), 'A kept its change locally while offline');
    e0 = remoteTag(); await api(B.page, 'POST', 'parties', { type: 'client', name: 'P4 from B' }); await uploadedSince(B.page, e0, 'B uploaded P4');
    await A.ctx.setOffline(false);
    const diag = async () => console.log('  diag A:', JSON.stringify(await A.page.evaluate(() => ({ state: ERPCloud.st.state, msg: ERPCloud.st.message, dirty: ERPStore.dirty, recDirty: ERPStore.rec && ERPStore.rec.dirty, base: ERPStore.rec && ERPStore.rec.baseETag, vis: document.visibilityState, online: navigator.onLine }))), 'remote etag', ms.files.get(ms.FILE).etag);
    await A.page.evaluate(() => ERPCloud.syncNow()); await waitFor(async () => (await state(A.page)) === 'conflict', 12000, 'conflict detected').catch(async e => { await diag(); throw e; });
    console.log('✔ conflict detected (A has unsent changes, B changed OneDrive)');
    await A.page.evaluate(() => ERPCloud.resolve('remote')); await A.page.waitForFunction(() => document.querySelector('.side, form.login'), null, { timeout: 30000 });
    const names = (await api(A.page, 'GET', 'parties')).j.map(p => p.name); assert.ok(names.includes('P4 from B') && !names.includes('P3 only on A'), 'A now has B\'s data and dropped its unsent change');
    console.log('✔ conflict resolved with the OneDrive copy');

    // ===== Conflict resolved the other way: keep mine (overwrite OneDrive) =====
    await B.ctx.setOffline(true); await api(B.page, 'POST', 'parties', { type: 'client', name: 'P5 only on B' }); await sleep(3200);
    e0 = remoteTag(); await api(A.page, 'POST', 'parties', { type: 'client', name: 'P6 from A' }); await uploadedSince(A.page, e0, 'A uploaded P6');
    await B.ctx.setOffline(false); await B.page.evaluate(() => ERPCloud.syncNow()); await waitFor(async () => (await state(B.page)) === 'conflict', 15000, 'B conflict');
    await B.page.evaluate(() => ERPCloud.resolve('local')); await waitFor(async () => (await state(B.page)) === 'synced', 15000, 'B overwrote OneDrive');
    const fresh = await device(); await link(fresh.page);
    await waitFor(async () => (await fresh.page.evaluate(() => !!document.querySelector('form.login'))), 20000, 'fresh login');
    await fresh.page.fill('[name=username]', 'admin'); await fresh.page.fill('[name=password]', 'secret1'); await fresh.page.click('button.btn'); await fresh.page.waitForSelector('.side');
    const fn = (await api(fresh.page, 'GET', 'parties')).j.map(p => p.name); assert.ok(fn.includes('P5 only on B') && !fn.includes('P6 from A'), 'OneDrive holds the copy that was kept');
    console.log('✔ conflict resolved by keeping the local copy');

    // ===== Token refresh + large upload session (> 4 MB) =====
    ms.expireTokensIn(1); await B.page.evaluate(() => { const t = JSON.parse(localStorage.erp_od_tok); t.exp = 0; localStorage.erp_od_tok = JSON.stringify(t); });
    const before = ms.stats.refreshes;
    const big = 'data:application/pdf;base64,' + Buffer.alloc(5 * 1024 * 1024, 7).toString('base64');
    assert.equal((await api(B.page, 'POST', 'documents', { entity: 'company', entity_id: 0, name: 'big.pdf', data: big })).s, 200);
    await waitFor(async () => ms.files.get(ms.FILE).bytes.length > 4.5e6 && (await state(B.page)) === 'synced', 40000, 'large upload').catch(async e => {
      console.log('  diag B:', JSON.stringify(await B.page.evaluate(() => ({ state: ERPCloud.st.state, msg: ERPCloud.st.message, dirty: ERPStore.dirty, size: ERPStore.rec && ERPStore.rec.bytes.length }))), 'remote size', ms.files.get(ms.FILE).bytes.length, JSON.stringify(ms.stats)); throw e; });
    assert.ok(ms.stats.refreshes > before, 'expired access token was refreshed'); assert.ok(ms.stats.sessionPuts >= 2, 'large file used an upload session');
    console.log('✔ expired token refreshed; 5 MB database uploaded in chunks');

    // ===== Sign-out keeps local data, stops syncing =====
    await B.page.evaluate(() => ERPCloud.signOut()); assert.equal(await state(B.page), 'local');
    assert.equal((await api(B.page, 'GET', 'parties')).s, 200);
    console.log('STANDALONE CLOUD TESTS PASSED', errs.length ? 'page errors: ' + JSON.stringify(errs.slice(0, 3)) : '');
  } catch (e) { console.error('FAIL', e.message || e, errs.slice(0, 3)); process.exitCode = 1; }
  await browser.close(); server.close(); ms.server.close(); process.exit(process.exitCode || 0);
});
