// Web Push without dependencies: VAPID (RFC 8292) signed with ES256 and payload encryption aes128gcm (RFC 8291).
// Works with the push services of Chrome/Android (FCM), Safari/iOS 16.4+ (Apple, installed web apps only), Firefox and Edge.
const crypto = require('node:crypto');
const b64u = buf => Buffer.from(buf).toString('base64url');
const unb64u = s => Buffer.from(String(s), 'base64url');

function generateVapid() {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const j = privateKey.export({ format: 'jwk' });
  return { publicKey: b64u(Buffer.concat([Buffer.from([4]), unb64u(j.x), unb64u(j.y)])), privateKey: j.d };
}
function vapidKeyObject({ publicKey, privateKey }) {
  const pub = unb64u(publicKey);
  return crypto.createPrivateKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', d: privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) } });
}
function vapidHeader(endpoint, vapid, subject, now = Date.now()) {
  const enc = o => b64u(JSON.stringify(o));
  const unsigned = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })}`;
  const sig = crypto.sign('sha256', Buffer.from(unsigned), { key: vapidKeyObject(vapid), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${b64u(sig)}, k=${vapid.publicKey}`;
}
const hkdf = (salt, ikm, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));

// one record, no padding: salt(16) | rs(4) | idlen(1) | keyid = server public key(65) | ciphertext + tag
function encrypt(payload, { p256dh, auth }) {
  const ua = unb64u(p256dh), as = crypto.createECDH('prime256v1'); as.generateKeys();
  const asPub = as.getPublicKey(), salt = crypto.randomBytes(16);
  const ikm = hkdf(unb64u(auth), as.computeSecret(ua), Buffer.concat([Buffer.from('WebPush: info\0'), ua, asPub]), 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16), nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const head = Buffer.alloc(21); salt.copy(head); head.writeUInt32BE(4096, 16); head[20] = 65;
  return Buffer.concat([head, asPub, body]);
}

// → { ok, status, gone } ; gone = the browser unsubscribed (404/410): delete the subscription
async function sendPush(sub, data, { vapid, subject, ttl = 86400, timeout = 15000 }) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), timeout);
  try {
    const r = await fetch(sub.endpoint, { method: 'POST', signal: ac.signal, body: encrypt(JSON.stringify(data), sub),
      headers: { Authorization: vapidHeader(sub.endpoint, vapid, subject), TTL: String(ttl), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', Urgency: 'normal' } });
    return { ok: r.status >= 200 && r.status < 300, status: r.status, gone: r.status === 404 || r.status === 410 };
  } catch (e) { return { ok: false, status: 0, error: e.message }; }
  finally { clearTimeout(t); }
}
module.exports = { generateVapid, sendPush, encrypt, vapidHeader };
