// node:crypto subset: scrypt (same parameters as Node's default, so password hashes stay compatible), random bytes, sha256, constant-time compare.
const { scrypt } = require('@noble/hashes/scrypt.js');
const { sha256 } = require('@noble/hashes/sha2.js');
const { Buffer } = require('buffer');
const utf8 = s => new TextEncoder().encode(String(s));
exports.scryptSync = (password, salt, keylen) => Buffer.from(scrypt(utf8(password), utf8(salt), { N: 16384, r: 8, p: 1, dkLen: keylen }));
exports.randomBytes = n => { const a = new Uint8Array(n); globalThis.crypto.getRandomValues(a); return Buffer.from(a); };
exports.timingSafeEqual = (a, b) => { if (a.length !== b.length) throw new RangeError('Input buffers must have the same byte length'); let r = 0; for (let i = 0; i < a.length; i++) r |= a[i] ^ b[i]; return r === 0; };
exports.createHash = alg => {
  if (alg !== 'sha256') throw new Error('only sha256 is available in the standalone edition');
  const parts = [];
  return { update(d) { parts.push(typeof d === 'string' ? utf8(d) : d); return this; },
    digest(enc) { const all = Buffer.concat(parts.map(p => Buffer.from(p))), out = Buffer.from(sha256(new Uint8Array(all))); return enc ? out.toString(enc) : out; } };
};
