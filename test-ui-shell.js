// The app shell in a real headless browser (side menu, Go to): node --no-warnings test-ui-shell.js
// Drives Chrome / Edge over the DevTools protocol with Node's built-in WebSocket, so no extra package is needed.
// Skipped with SKIP_UI=1, or when no browser is installed (same search as PDF printing: lib/pdf.js, CHROME_PATH).
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert'), { spawn } = require('child_process');
const { findBrowser } = require('./lib/pdf');
const skipPdf = process.env.SKIP_PDF; delete process.env.SKIP_PDF;        // findBrowser() honours SKIP_PDF (set in CI); this test has its own switch
const exe = process.env.SKIP_UI === '1' ? null : findBrowser();
if (skipPdf !== undefined) process.env.SKIP_PDF = skipPdf;
if (!exe) { console.log(`test-ui-shell: skipped (${process.env.SKIP_UI === '1' ? 'SKIP_UI=1' : 'no Chrome/Edge found, set CHROME_PATH'})`); process.exit(0); }
if (typeof WebSocket !== 'function') { console.log('test-ui-shell: skipped (this Node has no built-in WebSocket)'); process.exit(0); }

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-ui-'));
process.env.ZOHO_NO_SCHEDULER = '1'; process.env.SALES_NO_SCHEDULER = '1';
const { server } = require('./server.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let proc, ws, seq = 0; const pending = new Map();
async function launch() {
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-ui-chrome-'));
  proc = spawn(exe, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${prof}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((res, rej) => {
    let buf = ''; const t = setTimeout(() => rej(new Error('browser did not start: ' + buf.slice(-400))), 20000);
    proc.stderr.on('data', d => { buf += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf); if (m) { clearTimeout(t); res(m[1]); } });
    proc.on('exit', c => rej(new Error(`browser exited (${c}): ${buf.slice(-400)}`)));
  });
  const port = new URL(wsUrl).port;
  const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.rej(new Error(JSON.stringify(d.error))) : p.res(d.result); } };
}
const cdp = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
async function ev(expr) {
  const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`${expr}\n→ ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
  return r.result.value;
}
async function waitFor(expr, ms = 6000) {
  const end = Date.now() + ms; let last;
  while (Date.now() < end) { try { last = await ev(expr); if (last) return last; } catch (e) { last = e.message; } await sleep(80); }
  throw new Error(`timed out waiting for: ${expr} (last: ${last})`);
}
const desktop = () => cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 520, deviceScaleFactor: 1, mobile: false });
let base;
async function open(user, pass, lng = 'ar', hash = '') {
  await cdp('Page.navigate', { url: base + 'index.html' }); await waitFor('document.readyState === "complete"');
  // the service worker reloads the page once when it first takes control (mobile.js): let that happen before the test starts
  await ev(`'serviceWorker' in navigator ? navigator.serviceWorker.ready.then(() => true) : true`);
  await waitFor(`!('serviceWorker' in navigator) || !!navigator.serviceWorker.controller`);
  await waitFor('document.readyState === "complete"');
  await ev(`fetch('/api/logout', { method: 'POST' }).catch(() => {})`);
  await ev(`fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: ${JSON.stringify(user)}, password: ${JSON.stringify(pass)} }) }).then(r => r.status)`)
    .then(s => assert.equal(s, 200, 'login ' + user));
  await ev(`localStorage.clear(); localStorage.lang = ${JSON.stringify(lng)}; true`);
  await cdp('Page.navigate', { url: base + 'index.html' + (hash ? '#' + hash : '') });
  await waitFor(`!!document.querySelector('.side') && document.querySelector('#main') && document.querySelector('#main').children.length > 0`);
}
const click = sel => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error('no element ${sel.replace(/'/g, '')}'); e.click(); return true; })()`);
const openGroups = () => ev(`[...document.querySelectorAll('.side .g.open')].map(g => g.dataset.g)`);
const active = () => ev(`[...document.querySelectorAll('.side a.on')].map(a => a.dataset.r)`);

server.listen(0, async () => {
  base = `http://localhost:${server.address().port}/`;
  const api = async (m, u, b, cookie) => { const r = await fetch(base + 'api/' + u, { method: m, headers: { 'Content-Type': 'application/json', cookie: cookie || '' }, body: b ? JSON.stringify(b) : undefined }); return { s: r.status, c: (r.headers.get('set-cookie') || '').split(';')[0], j: await r.json().catch(() => null) }; };
  try {
    const setup = await api('POST', 'setup', { username: 'admin', password: 'secret12', company: 'Demo Contracting' });
    const ck = setup.c || (await api('POST', 'login', { username: 'admin', password: 'secret12' })).c;
    assert.equal((await api('POST', 'users', { username: 'storekeeper1', password: 'pass1234', role: 'storekeeper' }, ck)).s, 200);
    await launch(); await desktop();

    // 1. clicking a link low in the menu keeps the menu where it was (it used to be rebuilt and jump back to the top)
    await open('admin', 'secret12');
    if (await ev(`!!document.querySelector('.side .g[data-g="Procurement & stock"] .gh')`)) await click('.side .g[data-g="Procurement & stock"] .gh');
    const top = await ev(`(() => { const s = document.querySelector('.side'); s.scrollTop = s.scrollHeight; s.__probe = 1; return s.scrollTop; })()`);
    assert.ok(top > 0, 'the menu is taller than the window, so it scrolls');
    await click('.side a[data-r="settings"]');
    await waitFor(`location.hash === '#settings' && document.querySelector('#main').children.length > 0`);
    await sleep(300);
    assert.equal(await ev(`document.querySelector('.side').__probe`), 1, 'the menu was not rebuilt');
    assert.equal(await ev(`document.querySelector('.side').scrollTop`), top, 'the menu kept its scroll position');
    assert.deepEqual(await active(), ['settings']);

    // 2. groups are collapsed except the current page's; opening one closes the other
    await open('admin', 'secret12', 'ar', 'invoices');
    assert.deepEqual(await openGroups(), ['Projects & sales']);
    await click('.side .g[data-g="Accounting"] .gh');
    assert.deepEqual(await openGroups(), ['Accounting']);
    assert.equal(await ev(`document.querySelector('.side .g[data-g="Accounting"] .gh').getAttribute('aria-expanded')`), 'true');
    assert.equal(await ev(`document.querySelector('.side .g[data-g="Projects & sales"] .gh').getAttribute('aria-expanded')`), 'false');
    await click('.side .g[data-g="Accounting"] .gh');
    assert.deepEqual(await openGroups(), [], 'clicking the open group closes it');

    // 3. arriving from outside the menu (notification, typed address): the page's group opens and its link is marked
    await ev(`location.hash = 'payroll'; true`);
    await waitFor(`document.querySelector('.side a.on') && document.querySelector('.side a.on').dataset.r === 'payroll'`);
    assert.deepEqual(await openGroups(), ['Human resources']);

    // 4. Go to (Ctrl+K): Arabic search, then Enter opens the page and its group
    const ctrlK = () => ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, bubbles: true })); true`);
    const typeQ = q => ev(`(() => { const i = document.querySelector('#gotoq'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    const results = () => ev(`[...document.querySelectorAll('#gotores button')].map(b => b.dataset.r)`);
    const keyOn = (sel, key) => ev(`document.querySelector(${JSON.stringify(sel)}).dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true })); true`);
    await open('admin', 'secret12');
    await ctrlK(); await waitFor(`!!document.querySelector('#gotoq')`);
    await typeQ('رواتب');
    assert.equal((await results())[0], 'payroll');
    await keyOn('#gotoq', 'Enter');
    await waitFor(`location.hash === '#payroll' && !document.querySelector('.goto')`);
    assert.deepEqual(await openGroups(), ['Human resources']);

    // 5. English names work while the screen is in Arabic
    await click('#goto'); await waitFor(`!!document.querySelector('#gotoq')`);
    await typeQ('payroll');
    assert.equal((await results())[0], 'payroll');
    await keyOn('#gotoq', 'Escape');

    // 6. Esc closes it and gives the focus back; Ctrl+K does nothing while a form is open
    await ctrlK(); await waitFor(`!!document.querySelector('#gotoq')`);
    await keyOn('#gotoq', 'Escape');
    await waitFor(`!document.querySelector('.goto')`);
    assert.equal(await ev(`document.activeElement && document.activeElement.id`), 'goto');
    await ev(`document.querySelector('#modal-root').insertAdjacentHTML('beforeend', '<div class="overlay" id="fakemodal"></div>'); true`);
    await ctrlK(); await sleep(300);
    assert.equal(await ev(`!!document.querySelector('.goto')`), false, 'no finder over an open form');
    await ev(`document.querySelector('#fakemodal').remove(); true`);

    // 7. a storekeeper only finds the pages a storekeeper may open
    await open('storekeeper1', 'pass1234');
    await ctrlK(); await waitFor(`!!document.querySelector('#gotoq')`);
    await typeQ('دفتر');
    assert.deepEqual(await results(), [], 'no general ledger for a storekeeper');
    await typeQ('');
    const menu = await ev(`[...document.querySelectorAll('.side a[data-r]')].map(a => a.dataset.r)`), found = await results();
    assert.ok(found.length > 0 && found.every(r => menu.includes(r)), 'every result is a page in this user\'s menu');

    // 8. English: left-to-right, the same groups and finder
    await open('admin', 'secret12', 'en');
    assert.equal(await ev(`document.documentElement.dir`), 'ltr');
    assert.match(await ev(`document.querySelector('.side .g[data-g="Accounting"] .gh').textContent`), /Accounting/);
    await click('.side .g[data-g="Accounting"] .gh');
    assert.deepEqual(await openGroups(), ['Accounting']);
    await ctrlK(); await waitFor(`!!document.querySelector('#gotoq')`);
    await typeQ('قيود');
    assert.equal((await results())[0], 'journal', 'Arabic names work while the screen is in English');
    await keyOn('#gotoq', 'Escape');

    // 9. Trigon identity: Paper page, light menu; printing is untouched
    const bg = sel => ev(`getComputedStyle(document.querySelector(${JSON.stringify(sel)})).backgroundColor`);
    assert.equal(await bg('body'), 'rgb(242, 241, 238)', 'Paper #F2F1EE');
    assert.equal(await bg('.side'), 'rgb(233, 231, 225)', 'menu #E9E7E1');
    assert.equal(await ev(`getComputedStyle(document.querySelector('#print-area')).display`), 'none');

    // 10. phone: the menu is a drawer with the same groups; choosing a page closes it
    await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 800, deviceScaleFactor: 2, mobile: true });
    await open('admin', 'secret12');
    assert.equal(await ev(`getComputedStyle(document.querySelector('.topbar')).display`), 'flex');
    assert.equal(await ev(`document.querySelector('.side').getBoundingClientRect().right <= 0 || document.querySelector('.side').getBoundingClientRect().left >= innerWidth`), true, 'drawer hidden');
    await click('#menu');
    assert.equal(await ev(`document.querySelector('.side').classList.contains('open')`), true);
    await click('.side .g[data-g="Human resources"] .gh');
    await click('.side a[data-r="leave"]');
    await waitFor(`location.hash === '#leave' && !document.querySelector('.side').classList.contains('open')`);
    await desktop();

    console.log('test-ui-shell: all passed');
  } catch (e) { console.error(e); process.exitCode = 1; }
  finally { try { ws && ws.close(); } catch {} if (proc) proc.kill('SIGKILL'); server.close(); setTimeout(() => process.exit(process.exitCode || 0), 200); }
});
