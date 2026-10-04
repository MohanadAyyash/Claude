// Browser self-test of the standalone edition (needs Playwright + Chromium; development only).
//   PLAYWRIGHT_PATH=/path/to/playwright CHROME_PATH=/path/to/chrome node standalone/selftest.js
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), assert = require('node:assert');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const dist = path.join(__dirname, '..', 'dist'), PREFIX = '/trigon/';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {                                  // static host mimicking GitHub Pages under /trigon/
  const u = new URL(req.url, 'http://x'); if (!u.pathname.startsWith(PREFIX)) { res.writeHead(404); return res.end('nope'); }
  let p = u.pathname.slice(PREFIX.length) || 'index.html'; const f = path.join(dist, p);
  if (!f.startsWith(dist) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
const api = (page, m, u, body) => page.evaluate(async ([m, u, body]) => { const r = await fetch('/api/' + u, { method: m, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { s: r.status, j: await r.json().catch(() => null) }; }, [m, u, body]);
module.exports = { server, api, PREFIX, dist };

if (require.main === module) server.listen(0, async () => {
  const origin = `http://localhost:${server.address().port}`, url = origin + PREFIX;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  const errs = [];
  try {
    const ctx = await browser.newContext(), page = await ctx.newPage();
    page.on('pageerror', e => errs.push(e.message)); page.on('dialog', d => d.accept());
    await page.goto(url); await page.waitForSelector('form.login', { timeout: 30000 });
    // ---- first run: create the admin account through the UI
    await page.fill('[name=username]', 'admin'); await page.fill('[name=password]', 'secret1'); await page.click('button.btn'); await page.waitForSelector('.side', { timeout: 30000 });
    // ---- business logic runs in the browser: invoices, VAT, payroll, ledger
    await api(page, 'PUT', 'settings', { trn: '100123456700003' });
    const cl = (await api(page, 'POST', 'parties', { type: 'client', name: 'Client A', trn: '100999999900003', address: 'Dubai' })).j.id;
    const pr = (await api(page, 'POST', 'projects', { name: 'Villa', client_id: cl })).j.id;
    const inv = (await api(page, 'POST', 'invoices', { project_id: pr, items: [{ description: 'Phase 1', qty: 10, rate: 1000 }] })).j;
    const i = (await api(page, 'GET', 'invoices/' + inv.id)).j; assert.equal(i.total, 10500); assert.equal(i.vat, 500);
    assert.equal((await api(page, 'GET', 'vat')).j.output_vat, 500);
    const fin = (await api(page, 'GET', 'financials')).j; assert.equal(fin.tb_debit, fin.tb_credit);
    assert.equal((await api(page, 'POST', 'brand/pack')).s, 200); assert.equal((await api(page, 'GET', 'settings')).j.license_no, '1656279');
    const doc = await page.evaluate(async id => (await fetch('/api/doc/invoices/' + id)).text(), inv.id); assert.match(doc, /Tax Invoice/); assert.match(doc, /data:image\/png;base64/);
    // ---- data survives a reload (IndexedDB) and the login session too
    await page.waitForTimeout(1200); await page.reload(); await page.waitForSelector('.side', { timeout: 30000 });
    assert.equal((await api(page, 'GET', 'invoices/' + inv.id)).j.total, 10500);
    assert.equal((await api(page, 'GET', 'invoices')).s, 200);
    // ---- logo image in the sidebar is served from the local database
    await page.waitForFunction(() => { const im = document.querySelector('.side .brand img'); return im && im.src.startsWith('blob:'); }, null, { timeout: 8000 });
    // ---- documents open in an in-page viewer (no new tab / server), downloads work, sync page renders
    await page.evaluate(() => window.open('/api/doc/invoices/1?print=1')); await page.waitForSelector('#dv-frame');
    const src = await page.$eval('#dv-frame', f => f.srcdoc); assert.match(src, /Tax Invoice/); assert.ok(!src.includes('window.print()'), 'auto-print script removed'); assert.ok(src.includes('/trigon/fonts/fonts.css'), 'font path rewritten for the sub-path');
    await page.click('#dv-close');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => { const a = document.createElement('a'); a.href = '/api/export/invoices'; document.body.appendChild(a); a.click(); })]);
    assert.match(dl.suggestedFilename(), /^invoices-.*\.csv$/);
    const [bk] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => { const a = document.createElement('a'); a.href = '/api/backup'; document.body.appendChild(a); a.click(); })]);
    assert.match(bk.suggestedFilename(), /\.sqlite$/);
    await page.evaluate(() => { location.hash = 'sync'; }); await page.waitForSelector('#si'); await page.screenshot({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + '/sync.png' : '/tmp/sync.png' });
    assert.equal(await page.evaluate(() => document.querySelector('.erp-chip') && document.querySelector('.erp-chip').textContent.includes('محلي')), true);
    console.log('STANDALONE LOCAL TESTS PASSED', errs.length ? 'page errors: ' + JSON.stringify(errs) : '');
  } catch (e) { console.error('FAIL', e.message || e, errs); process.exitCode = 1; }
  await browser.close(); server.close(); process.exit(process.exitCode || 0);
});
