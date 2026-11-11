// Two-step sign-in (TOTP): setup, confirm, login with code, no replay, switch off, administrator and console reset:
// node --no-warnings test-2fa.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert'), { execFileSync } = require('child_process');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-2fa-'));
process.env.ZOHO_NO_SCHEDULER = '1'; process.env.SALES_NO_SCHEDULER = '1';
const { server } = require('./server.js');
const T = require('./lib/totp.js');

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api/`; let cookie = '';
  const call = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j }; };
  const ok = (r, l) => { assert.equal(r.s, 200, `${l || ''} → ${r.s} ${JSON.stringify(r.j).slice(0, 300)}`); return r.j; };
  const now = s => T.codeAt(s, T.stepNow()), next = s => T.codeAt(s, T.stepNow() + 1);
  try {
    // RFC 6238 vectors
    const rfc = T.b32encode(Buffer.from('12345678901234567890')); assert.equal(T.codeAt(rfc, Math.floor(59 / 30)), '287082'); assert.equal(T.codeAt(rfc, Math.floor(1111111109 / 30)), '081804');
    ok(await call('POST', 'setup', { username: 'admin', password: 'secret12', company: 'Trigon' }));
    ok(await call('POST', 'users', { username: 'acc', password: 'secret12', role: 'accountant' }));
    const admin = cookie; cookie = ''; ok(await call('POST', 'login', { username: 'acc', password: 'secret12' })); const acc1 = cookie;

    // ---- switch on: a secret, then a code from it
    assert.equal(ok(await call('GET', '2fa')).enabled, false);
    const s = ok(await call('POST', '2fa/setup', {})); assert.match(s.secret, /^[A-Z2-7]{32}$/); assert.match(s.uri, /^otpauth:\/\/totp\/.*acc\?secret=/);
    assert.equal((await call('POST', '2fa/enable', { code: '000000' })).s, 400);
    cookie = ''; ok(await call('POST', 'login', { username: 'acc', password: 'secret12' }), 'not active until confirmed'); const acc2 = cookie;
    ok(await call('POST', '2fa/enable', { code: now(s.secret) })); assert.equal(ok(await call('GET', '2fa')).enabled, true);
    cookie = acc1; assert.equal((await call('GET', '2fa')).s, 401, 'other devices are signed out'); 

    // ---- sign in: password, then the code; wrong password never reveals that a code is needed
    cookie = '';
    let r = await call('POST', 'login', { username: 'acc', password: 'wrong' }); assert.equal(r.s, 401); assert.equal(r.j.need_code, undefined);
    r = await call('POST', 'login', { username: 'acc', password: 'secret12' }); assert.equal(r.s, 401); assert.equal(r.j.need_code, true); assert.equal(cookie, '');
    r = await call('POST', 'login', { username: 'acc', password: 'secret12', code: '123456' }); assert.equal(r.s, 401); assert.equal(r.j.need_code, true);
    assert.equal((await call('POST', 'login', { username: 'acc', password: 'secret12', code: now(s.secret) })).s, 401, 'the code used to switch it on cannot be used again');
    ok(await call('POST', 'login', { username: 'acc', password: 'secret12', code: next(s.secret) })); assert.equal(ok(await call('GET', '2fa')).enabled, true);
    console.log('✔ two-step sign-in: confirmed with a code, then every login needs password + a fresh code (no replay)');

    // ---- switch off needs the password; the administrator can reset a lost phone
    assert.equal((await call('POST', '2fa/disable', { password: 'nope' })).s, 400);
    assert.equal((await call('POST', '2fa/reset', { user_id: 1 })).s, 403);
    cookie = admin; assert.equal(ok(await call('GET', 'users')).find(u => u.username === 'acc').two_step, 1);
    ok(await call('POST', '2fa/reset', { user_id: ok(await call('GET', 'users')).find(u => u.username === 'acc').id }));
    cookie = ''; ok(await call('POST', 'login', { username: 'acc', password: 'secret12' }), 'password alone again');
    const s2 = ok(await call('POST', '2fa/setup', {})); ok(await call('POST', '2fa/enable', { code: now(s2.secret) }));
    ok(await call('POST', '2fa/disable', { password: 'secret12' })); assert.equal(ok(await call('GET', '2fa')).enabled, false);
    // console reset (the administrator's own lost phone)
    cookie = admin; const sa = ok(await call('POST', '2fa/setup', {})); ok(await call('POST', '2fa/enable', { code: now(sa.secret) }));
    cookie = ''; assert.equal((await call('POST', 'login', { username: 'admin', password: 'secret12' })).j.need_code, true);
    assert.match(execFileSync(process.execPath, ['--no-warnings', 'scripts/reset-2fa.js', 'admin'], { env: process.env, encoding: 'utf8' }), /is off for admin/);
    ok(await call('POST', 'login', { username: 'admin', password: 'secret12' }));
    assert.ok(ok(await call('GET', 'audit')).some(a => a.tbl === '2fa' && a.action === 'reset' && a.user === 'server console'));
    console.log('✔ switch off with the password; administrator reset; console reset script for a locked-out administrator');
    console.log('TWO-STEP SIGN-IN TESTS PASSED');
  } catch (err) { console.error('FAIL', err); process.exitCode = 1; }
  finally { server.close(); setTimeout(() => process.exit(process.exitCode || 0), 100); }
});
