// Any screen as a PDF on the letterhead (the print button on iPhone / iPad): node --no-warnings test-reportpdf.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-reportpdf-'));
process.env.ZOHO_NO_SCHEDULER = '1'; process.env.SALES_NO_SCHEDULER = '1';
const { server } = require('./server.js');
const { cleanReportHtml } = require('./lib/render.js');

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api/`; let cookie = '';
  const call = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j }; };
  const ok = (r, l) => { assert.equal(r.s, 200, `${l || ''} → ${r.s} ${JSON.stringify(r.j).slice(0, 300)}`); return r.j; };
  try {
    // ---- what the browser sends is reduced to plain markup
    const dirty = '<h1 onclick="x()">Dashboard</h1><script>alert(1)</script><iframe src="file:///etc/passwd"></iframe><object data="x"></object><img src="/api/brand/logo"><img src="file:///C:/erp/data/erp.db">'
      + '<img src="data:image/png;base64,iVBORw0KGgo="><a href="javascript:alert(1)">link</a><form action="/x"><b>kept</b></form><svg><script>1</script></svg><link rel="stylesheet" href="//evil"><meta http-equiv="refresh" content="0;url=file:///">'
      + '<div style="color:red" class="kpi">5</div><img src=x onerror=alert(1)><base href="file:///"><input value="secret"><td SRC = \'file:///x\'>';
    const c = cleanReportHtml(dirty);
    for (const bad of ['<script', 'iframe', 'object', 'onclick', 'onerror', 'javascript:', 'file:', '/api/brand', '<link', '<meta', '<svg', '<base', '<input', '<form', 'evil']) assert.ok(!c.toLowerCase().includes(bad.toLowerCase()), `"${bad}" removed: ${c}`);
    for (const keep of ['Dashboard', '<b>kept</b>', 'style="color:red"', 'class="kpi"', 'data:image/png;base64,iVBORw0KGgo=', '>link<']) assert.ok(c.includes(keep), `"${keep}" kept: ${c}`);
    console.log('✔ the screen content is cleaned: no scripts, frames, forms, handlers, file / network links; markup, styles and data images kept');

    // ---- endpoint: staff only, PDF behind a random link that works without the login, expires
    assert.equal((await call('POST', 'report-pdf', { html: '<p>x</p>' })).s, 401);
    ok(await call('POST', 'setup', { username: 'admin', password: 'secret12', company: 'Test Co' }));
    const emp = ok(await call('POST', 'employees', { name: 'Worker', join_date: '2025-01-01', basic: 1000 })).id;
    ok(await call('POST', 'users', { username: 'emp', password: 'secret12', role: 'employee', employee_id: emp }));
    ok(await call('POST', 'users', { username: 'view', password: 'secret12', role: 'viewer' }));
    assert.equal((await call('POST', 'report-pdf', { html: '<script>x</script>' })).s, 400, 'nothing left to print');
    const admin = cookie; cookie = ''; ok(await call('POST', 'login', { username: 'emp', password: 'secret12' }));
    assert.equal((await call('POST', 'report-pdf', { html: '<p>x</p>' })).s, 403, 'the employee portal has no report printing'); cookie = '';
    ok(await call('POST', 'login', { username: 'view', password: 'secret12' }));
    const r = await call('POST', 'report-pdf', { title: 'Dashboard', lang: 'ar', html: dirty + '<table><tr><th>Project</th><td class="n">1,000.00</td></tr></table>' });
    assert.equal((await fetch(base + 'report-pdf/' + 'f'.repeat(48))).status, 404, 'unknown link');
    assert.equal((await fetch(base + 'report-pdf/..%2F..%2Fserver.js')).status, 404);
    if (process.env.SKIP_PDF) { assert.equal(r.s, 503); assert.match(r.j.error, /PDF is not available/); console.log('✔ (no browser here: the endpoint answers 503 and the phone falls back to printing)'); }
    else {
      assert.equal(r.s, 200, JSON.stringify(r.j)); assert.match(r.j.url, /^\/api\/report-pdf\/[a-f0-9]{48}$/);
      const p = await fetch(`http://localhost:${server.address().port}${r.j.url}`);            // no cookie: the phone's PDF viewer
      assert.equal(p.status, 200); assert.equal(p.headers.get('content-type'), 'application/pdf'); assert.match(p.headers.get('content-disposition'), /inline; filename="Dashboard\.pdf"/);
      assert.equal(Buffer.from(await p.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
      cookie = admin; assert.ok(ok(await call('GET', 'audit')).some(a => a.tbl === 'report' && a.action === 'pdf'));
      console.log('✔ PDF made on the letterhead, opened by its random link without the login');
    }
    console.log('REPORT PDF TESTS PASSED');
  } catch (err) { console.error('FAIL', err); process.exitCode = 1; }
  finally { server.close(); setTimeout(() => process.exit(process.exitCode || 0), 100); }
});
