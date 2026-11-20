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
  await cdp('Page.navigate', { url: 'about:blank' }); await sleep(100);        // a URL that differs only by #hash would not reload the app
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
    await api('PUT', 'settings', { trn: '100123456700003' }, ck);
    const cl = (await api('POST', 'parties', { type: 'client', name: 'Sample Client', trn: '100234567800003', address: 'Dubai' }, ck)).j.id;
    const pj = (await api('POST', 'projects', { name: 'Sample Tower', client_id: cl, contract_value: 500000, status: 'active' }, ck)).j.id;
    assert.equal((await api('POST', 'invoices', { project_id: pj, date: '2026-01-05', due_date: '2026-02-04', items: [{ description: 'Works', qty: 1, rate: 20000 }] }, ck)).s, 200);
    assert.equal((await api('POST', 'invoices', { project_id: pj, date: '2026-01-05', due_date: '2099-12-31', items: [{ description: 'Works', qty: 1, rate: 60000 }] }, ck)).s, 200);
    const dash = (await api('GET', 'dashboard', null, ck)).j;
    const overdueSum = Math.round(dash.overdue.reduce((t, i) => t + i.balance, 0) * 100) / 100;
    assert.ok(overdueSum > 0 && dash.receivable > overdueSum, 'one overdue and one open invoice');
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
    assert.equal(await ev(`document.documentElement.scrollWidth <= innerWidth + 1 && innerWidth === 390`), true, 'nothing wider than the phone screen');
    assert.equal(await ev(`document.querySelector('.side').getBoundingClientRect().right <= 0 || document.querySelector('.side').getBoundingClientRect().left >= innerWidth`), true, 'drawer hidden');
    await click('#menu');
    assert.equal(await ev(`document.querySelector('.side').classList.contains('open')`), true);
    await click('.side .g[data-g="Human resources"] .gh');
    await click('.side a[data-r="leave"]');
    await waitFor(`location.hash === '#leave' && !document.querySelector('.side').classList.contains('open')`);
    // Go to from inside the drawer: the drawer closes once the page opens (it used to stay over the page)
    await click('#menu');
    await click('#goto'); await waitFor(`!!document.querySelector('#gotoq')`);
    await typeQ('payroll'); await keyOn('#gotoq', 'Enter');
    await waitFor(`location.hash === '#payroll'`);
    await waitFor(`!document.querySelector('.side').classList.contains('open') && !document.querySelector('#scrim').classList.contains('on')`, 2000);
    await desktop();

    // 11. switching language redraws the menu in English; the current page's group is open and the groups still toggle
    await open('admin', 'secret12', 'ar', 'invoices');
    await click('#lang');
    await waitFor(`document.documentElement.dir === 'ltr' && /Accounting/.test(document.querySelector('.side .g[data-g="Accounting"] .gh').textContent)`);
    assert.deepEqual(await openGroups(), ['Projects & sales']);
    await click('.side .g[data-g="Accounting"] .gh');
    assert.deepEqual(await openGroups(), ['Accounting']);
    await click('#lang');
    await waitFor(`document.documentElement.dir === 'rtl'`);

    // 12. a new company name shows in the menu as soon as the settings are saved
    await open('admin', 'secret12', 'en', 'settings');
    await waitFor(`!!document.querySelector('#sf [name="company_name"]') && !!document.querySelector('#save')`);
    await ev(`document.querySelector('#sf [name="company_name"]').value = 'Renamed Contracting'; true`);
    await click('#save');
    await waitFor(`/Renamed Contracting/.test(document.querySelector('.side .brand').textContent)`, 4000);

    // 13. Trigon identity on every page: figures in a ruled row with document digits, plain status marks, section name above the title
    await open('admin', 'secret12', 'ar', 'invoices');
    const cs = (sel, prop) => ev(`getComputedStyle(document.querySelector(${JSON.stringify(sel)})).${prop}`);
    assert.equal(await ev(`document.querySelector('#main .crumb') && document.querySelector('#main .crumb').textContent.trim()`), 'المشاريع والمبيعات');
    assert.match(await cs('#main td.n', 'fontFamily'), /IBM Plex Mono/);
    assert.equal(await cs('#main > .bar', 'borderBottomStyle'), 'solid', 'letterhead rule under the title, also with the section name');
    assert.equal(await cs('#main > .bar h1', 'marginBottom'), '0px', 'the rule sits right under the title');
    assert.equal(await cs('#main .tag', 'backgroundColor'), 'rgba(0, 0, 0, 0)');
    await ev(`location.hash = 'dashboard'; true`);
    await waitFor(`!!document.querySelector('#main .kpi')`);
    assert.equal(await cs('#main .kpi', 'backgroundColor'), 'rgba(0, 0, 0, 0)');
    assert.match(await cs('#main .kpi .v', 'fontFamily'), /IBM Plex Mono/);
    assert.equal(await ev(`!!document.querySelector('#main .crumb')`), false, 'no section name for a page outside the groups');

    // 14. dashboard: client balances drawn like the Trigon mark, to one scale (overdue, not yet due, all open)
    const bars = await ev(`[...document.querySelectorAll('#main .markchart .mrow')].map(r => ({ v: +r.dataset.v, w: parseFloat(r.querySelector('.fill').style.width) }))`);
    assert.equal(bars.length, 3);
    assert.deepEqual(bars.map(b => b.v), [overdueSum, Math.round((dash.receivable - overdueSum) * 100) / 100, dash.receivable]);
    assert.equal(bars[2].w, 100);
    assert.ok(Math.abs(bars[0].w - overdueSum / dash.receivable * 100) < 0.1 && Math.abs(bars[1].w - (dash.receivable - overdueSum) / dash.receivable * 100) < 0.1, 'bars to scale');

    // 15. nothing of the old look: line icons instead of emoji, Steel Blue figures, document digits for references, identity on forms, alerts, notices, login
    await open('admin', 'secret12', 'ar', 'dashboard');
    await waitFor(`!!document.querySelector('#main .kpi') && !!document.querySelector('#hlp')`);
    const shellText = await ev(`[document.querySelector('.side'), document.querySelector('.topbar'), document.querySelector('#main > .bar')].map(e => e.textContent).join(' ')`);
    assert.doesNotMatch(shellText, /[\u{1F4D8}\u{1F50D}\u{1F514}\u{1F5A8}❓☰⚠⛔]/u, 'no emoji icons in the menu, top bar or page header');
    assert.ok(await ev(`!!document.querySelector('#goto svg') && !!document.querySelector('.side a.guide svg') && !!document.querySelector('#hlp svg') && !!document.querySelector('#prt svg')`), 'line icons');
    const steel = 'rgb(31, 58, 95)';
    assert.deepEqual([...new Set(await ev(`[...document.querySelectorAll('#main .kpi .v')].filter(v => !/^-/.test(v.textContent.trim())).map(v => getComputedStyle(v).color)`))], [steel], 'figures in Steel Blue (red is kept only for a negative figure)');
    assert.equal(await cs('#main .b.in', 'backgroundColor'), steel, 'cash in drawn in Steel Blue');
    assert.equal(await cs('#hlp', 'textDecorationLine'), 'none');
    assert.ok(await ev(`!!document.querySelector('#main .alert') && !/[⚠⛔]/.test(document.querySelector('#main .alert').textContent)`), 'compliance alerts as marks, not emoji');
    await ev(`location.hash = 'invoices'; true`);
    await waitFor(`!!document.querySelector('#main tbody td.ref')`);
    assert.match(await ev(`document.querySelector('#main tbody td.ref').textContent`), /^INV-/);
    assert.match(await cs('#main tbody td.ref', 'fontFamily'), /IBM Plex Mono/);
    await click('#add'); await waitFor(`!!document.querySelector('#modal-root .modal h2')`);
    assert.equal(await cs('#modal-root .modal h2', 'borderBottomColor'), steel, 'forms carry the letterhead rule');
    assert.equal(await cs('#modal-root .modal', 'backgroundColor'), 'rgb(251, 250, 248)');
    await ev(`document.querySelector('#modal-root').innerHTML = ''; true`);
    await ev(`toast('x'); true`);
    assert.equal(await cs('.toast', 'backgroundColor'), steel);
    await ev(`fetch('/api/logout', { method: 'POST' }).then(() => boot()).then(() => true)`);
    await waitFor(`!!document.querySelector('.login')`);
    assert.equal(await cs('.login', 'borderTopColor'), steel, 'sign-in card with the letterhead rule');
    await waitFor(`(() => { const m = document.querySelector('.login .lmark'); return !!m && !m.hidden && m.getBoundingClientRect().height > 0 && !document.querySelector('.login img.logo'); })()`);   // no logo installed: the Trigon mark instead

    console.log('test-ui-shell: all passed');
  } catch (e) { console.error(e); process.exitCode = 1; }
  finally { try { ws && ws.close(); } catch {} if (proc) proc.kill('SIGKILL'); server.close(); setTimeout(() => process.exit(process.exitCode || 0), 200); }
});
