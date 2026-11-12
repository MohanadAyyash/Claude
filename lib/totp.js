// Time-based one-time passwords (RFC 6238: HMAC-SHA1, 30-second step, 6 digits) — the codes of Google / Microsoft Authenticator.
const crypto = require('node:crypto');
const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const b32encode = buf => { let bits = 0, v = 0, out = ''; for (const b of buf) { v = (v << 8) | b; bits += 8; while (bits >= 5) { out += A[(v >>> (bits - 5)) & 31]; bits -= 5; } } if (bits) out += A[(v << (5 - bits)) & 31]; return out; };
const b32decode = s => { let bits = 0, v = 0; const out = []; for (const c of String(s).toUpperCase().replace(/[^A-Z2-7]/g, '')) { v = (v << 5) | A.indexOf(c); bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); };
const newSecret = () => b32encode(crypto.randomBytes(20));
function codeAt(secret, step) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', b32decode(secret)).update(msg).digest(), o = h[h.length - 1] & 15;
  return String(((h[o] & 127) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % 1e6).padStart(6, '0');
}
const stepNow = (ms = Date.now()) => Math.floor(ms / 30000);
// returns the matching time step (so a code cannot be used twice), or 0; one step either side allows for clock drift
function verify(secret, code, lastStep = 0, ms = Date.now()) {
  const c = String(code || '').replace(/\s/g, ''); if (!/^\d{6}$/.test(c) || !secret) return 0;
  const now = stepNow(ms);
  for (const s of [now, now - 1, now + 1]) if (s > lastStep && crypto.timingSafeEqual(Buffer.from(codeAt(secret, s)), Buffer.from(c))) return s;
  return 0;
}
const uri = (secret, account, issuer) => `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
module.exports = { newSecret, codeAt, stepNow, verify, uri, b32encode, b32decode };
