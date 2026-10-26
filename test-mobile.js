// Phone app layer: static caching/compression, service worker version, Web Push (VAPID + aes128gcm, checked by a mock
// push service that verifies the signature and decrypts the message), notification inbox, roles: node --no-warnings test-mobile.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert'), http = require('http'), crypto = require('crypto');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-mobile-'));
process.env.PUSH_ALLOW_ANY_ENDPOINT = '1';
const { server } = require('./server.js');

const b64u = b => Buffer.from(b).toString('base64url'), unb = s => Buffer.from(s, 'base64url');
const hkdf = (salt, ikm, info, n) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, n));
// a "browser": its own key pair + auth secret; the mock push service decrypts with them, as the phone would
function browser() { const ua = crypto.createECDH('prime256v1'); ua.generateKeys(); return { ua, keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(crypto.randomBytes(16)) } }; }
function decrypt(body, b) {
  const salt = body.subarray(0, 16), idlen = body[20], asPub = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen), uaPub = b.ua.getPublicKey();
  const ikm = hkdf(unb(b.keys.auth), b.ua.computeSecret(asPub), Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]), 32);
  const d = crypto.createDecipheriv('aes-128-gcm', hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16), hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12));
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2, 'last-record delimiter'); return JSON.parse(plain.subarray(0, -1).toString());
}
function verifyVapid(header, origin) {
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(header || ''); assert.ok(m, 'vapid header');
  const [h, c, s] = m[1].split('.'), claims = JSON.parse(unb(c)), pub = unb(m[2]);
  assert.equal(JSON.parse(unb(h)).alg, 'ES256'); assert.equal(claims.aud, origin); assert.ok(claims.exp > Date.now() / 1000); assert.match(claims.sub, /^mailto:/);
  const key = crypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) } });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, unb(s)), 'VAPID signature');
  return m[2];
}

server.listen(0, async () => {
  const port = server.address().port, base = `http://localhost:${port}/api/`;
  let cookie = '';
  const call = async (m, u, b) => {
    const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie }, body: b ? JSON.stringify(b) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch { j = text; }
    return { s: r.status, j, text };
  };
  const raw = (p, headers = {}) => new Promise((ok, no) => http.get({ port, path: p, headers: { cookie, ...headers } }, res => { const c = []; res.on('data', x => c.push(x)); res.on('end', () => ok({ s: res.statusCode, h: res.headers, body: Buffer.concat(c) })); }).on('error', no));
  // mock push service: records every delivery; endpoints ending in /gone answer 410 like an unsubscribed browser
  const got = [];
  const push = http.createServer((req, res) => { const c = []; req.on('data', x => c.push(x)); req.on('end', () => { got.push({ url: req.url, headers: req.headers, body: Buffer.concat(c) }); res.writeHead(req.url.endsWith('/gone') ? 410 : 201); res.end(); }); });
  await new Promise(ok => push.listen(0, '127.0.0.1', ok));
  const pushOrigin = `http://127.0.0.1:${push.address().port}`;
  try {
    // ---- static files: gzip, ETag → 304, versioned service worker
    const idx = await raw('/', { 'accept-encoding': 'gzip' });
    assert.equal(idx.s, 200); assert.equal(idx.h['content-encoding'], 'gzip'); assert.ok(idx.h.etag);
    assert.match(require('zlib').gunzipSync(idx.body).toString(), /mobile\.js/);
    assert.equal((await raw('/', { 'if-none-match': idx.h.etag })).s, 304);
    const sw = await raw('/sw.js');
    assert.equal(sw.s, 200); assert.ok(!sw.body.toString().includes('__VERSION__')); assert.match(sw.body.toString(), /const VERSION = '[0-9a-f]{12}'/); assert.match(sw.h['content-type'], /javascript/);
    assert.equal(JSON.parse((await raw('/manifest.webmanifest')).body).display, 'standalone');
    for (const f of ['app.js', 'mobile.js', 'style.css', 'fonts/fonts.css', 'icon-192.png']) assert.equal((await raw('/' + f)).s, 200, f);   // everything the worker pre-caches exists
    for (const f of JSON.parse('[' + /const SHELL = \[([^\]]+)\]/.exec(sw.body.toString())[1].replace(/'/g, '"') + ']')) if (f !== './') assert.equal((await raw('/' + f)).s, 200, 'precache ' + f);

    assert.equal((await call('POST', 'setup', { username: 'admin', password: 'secret12', company: 'Trigon' })).s, 200);
    // ---- big API answers are compressed
    for (let i = 0; i < 40; i++) await call('POST', 'parties', { type: 'client', name: `Client ${i} with a fairly long name LLC`, address: 'Office 810, Bay View Tower, Business Bay, Dubai' });
    const pr = await raw('/api/parties', { 'accept-encoding': 'gzip' });
    assert.equal(pr.h['content-encoding'], 'gzip'); assert.equal(JSON.parse(require('zlib').gunzipSync(pr.body)).length, 40);
    assert.equal((await raw('/api/parties')).h['content-encoding'], undefined);

    // ---- push: key, subscription checks, delivery verified end to end
    const k = (await call('GET', 'push/key')).j; assert.equal(k.enabled, true); assert.equal(unb(k.publicKey).length, 65); assert.equal(k.devices, 0);
    const phone = browser();
    assert.equal((await call('POST', 'push/subscribe', { subscription: { endpoint: 'https://evil.example/x', keys: phone.keys } })).s, 400);
    assert.equal((await call('POST', 'push/subscribe', { subscription: { endpoint: 'http://10.0.0.1/x', keys: phone.keys } })).s, 400);   // never to internal hosts
    assert.equal((await call('POST', 'push/subscribe', { subscription: { endpoint: pushOrigin + '/x' } })).s, 400);
    assert.equal((await call('POST', 'push/subscribe', { subscription: { endpoint: pushOrigin + '/phone1', keys: phone.keys }, device: 'iPhone' })).s, 200);
    const gone = browser();
    assert.equal((await call('POST', 'push/subscribe', { subscription: { endpoint: pushOrigin + '/gone', keys: gone.keys } })).s, 200);
    const t = (await call('POST', 'push/test')).j; assert.equal(t.sent, 1); assert.equal(t.failed, 1);
    const d = got.find(g => g.url === '/phone1'); assert.ok(d, 'delivered');
    assert.equal(d.headers['content-encoding'], 'aes128gcm'); assert.equal(d.headers.ttl, '86400');
    assert.equal(verifyVapid(d.headers.authorization, pushOrigin), k.publicKey);
    const msg = decrypt(d.body, phone); assert.equal(msg.title, 'Trigon ERP'); assert.match(msg.body, /Notifications work/); assert.equal(msg.url, '#notifications'); assert.equal(msg.badge, 1);
    assert.equal((await call('GET', 'push/key')).j.devices, 1, 'the unsubscribed browser (410) was removed');
    // ---- inbox
    let n = (await call('GET', 'notifications')).j; assert.equal(n.unread, 1); assert.equal(n.items[0].title, 'Trigon ERP');
    assert.equal((await call('GET', 'notifications?count=1')).j.items.length, 0);
    await call('POST', 'notifications/read'); assert.equal((await call('GET', 'notifications')).j.unread, 0);
    // ---- the private key never leaves the server
    const st = await call('GET', 'settings'); assert.ok(!/vapid|push_keys/i.test(st.text));
    const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(path.join(process.env.DATA_DIR, 'erp.db'), { readOnly: true });
    const priv = db.prepare('SELECT private FROM push_keys').get().private; db.close();
    for (const u of ['settings', 'push/key', 'notifications']) assert.ok(!(await call('GET', u)).text.includes(priv), u);

    // ---- employees use their own inbox and devices only
    const emp = (await call('POST', 'employees', { name: 'Imran', join_date: '2025-01-01', basic: 3000 })).j.id;
    assert.equal((await call('POST', 'users', { username: 'imran', password: 'pass1234', role: 'employee', employee_id: emp })).s, 200);
    const admin = cookie; cookie = '';
    await call('POST', 'login', { username: 'imran', password: 'pass1234' });
    assert.equal((await call('GET', 'push/key')).j.devices, 0);
    assert.equal((await call('GET', 'notifications')).j.items.length, 0, "does not see the admin's notifications");
    const ep = browser(); assert.equal((await call('POST', 'push/subscribe', { subscription: { endpoint: pushOrigin + '/imran', keys: ep.keys } })).s, 200);
    assert.equal((await call('POST', 'push/test')).j.sent, 1); assert.equal(decrypt(got.find(g => g.url === '/imran').body, ep).title, 'Trigon ERP');
    assert.equal((await call('DELETE', 'push/subscribe', { endpoint: pushOrigin + '/phone1' })).s, 200);   // someone else's device: untouched
    cookie = admin; assert.equal((await call('GET', 'push/key')).j.devices, 1);
    console.log('✔ static gzip/ETag/304, versioned service worker, compressed API, Web Push (VAPID verified, payload decrypted), 410 cleanup, inbox, roles');
    console.log('MOBILE TESTS PASSED');
  } catch (e) { console.error('FAIL', e); process.exitCode = 1; }
  finally { push.close(); server.close(); setTimeout(() => process.exit(process.exitCode || 0), 100); }
});
