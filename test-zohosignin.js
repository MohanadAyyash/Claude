// Zoho sign-in diagnostics (preflight on the office PC): every failure of the access-token request is described — HTTP status,
// Zoho's OAuth error, Node's cause code, host, and whether it is a timeout, TLS, DNS, network or OAuth rejection — and no secret
// (client ID, client secret, refresh token, access token, Authorization header, request body) ever appears in what is shown.
// Also: the .env check of the preflight script (encoding, BOM, CRLF, which keys Node really reads).
'use strict';
const assert = require('assert'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const Z = require('./lib/zoho.js');
const { inspectEnv, netEnv, decide } = require('./scripts/zoho-preflight.js');

const CID = '1000.FAKECLIENTID0000000000', SECRET = 'fake-secret-0123456789abcdef', RT = '1000.fakerefresh0123456789abcdef.0123456789abcdef', AT = '1000.fakeaccess0123456789abcdef.fedcba9876543210';
const SECRETS = [CID, SECRET, RT, AT];
const clean = (what, o) => { const s = JSON.stringify(o) + (o && o.message ? o.message : ''); for (const x of SECRETS) assert.ok(!s.includes(x), `${what}: a secret leaked`); assert.ok(!/Zoho-oauthtoken \w|client_secret=\w|refresh_token=\w/.test(s), `${what}: credential field leaked`); };
const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const out = [];

(async () => {
  // a stand-in for Zoho's sign-in server + one Books read; each scenario decides how the token endpoint answers
  let oauth = () => ({ status: 200, body: { access_token: AT, api_domain: '', token_type: 'Bearer', expires_in: 3600 } }), seen = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => (b += c)); req.on('end', () => {
      const u = new URL(req.url, 'http://x'); seen.push(`${req.method} ${u.pathname}`);
      if (u.pathname === '/oauth/v2/token') {
        const f = new URLSearchParams(b), a = oauth(f);
        if (a.hang) return;                                                               // never answers → timeout
        if (a.html) { res.writeHead(a.status, { 'Content-Type': 'text/html' }); return res.end(a.html); }
        res.writeHead(a.status, { 'Content-Type': 'application/json;charset=UTF-8' }); return res.end(JSON.stringify(a.body));
      }
      if (u.pathname === '/books/v3/organizations' && req.headers.authorization === 'Zoho-oauthtoken ' + AT) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ code: 0, organizations: [{ organization_id: '944000001', name: 'Fake Org' }] })); }
      res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code: 57, message: 'not authorized' }));
    });
  });
  const port = await listen(srv), base = `http://127.0.0.1:${port}`;
  const client = (o = {}) => Z.createClient({ accounts: base, client_id: CID, client_secret: SECRET, refresh_token: RT, api_domain: base, org: '944000001', cache: {}, readOnly: true, timeout: 1500, ...o });
  const fail = async (o) => { try { await client(o).get('/organizations'); } catch (e) { clean('error', e); clean('diag', e.diag); return e; } assert.fail('expected a failure'); };
  try {
    // 1. valid OAuth response → token, then the Books read
    { const r = await client().get('/organizations'); assert.equal(r.organizations[0].name, 'Fake Org'); assert.deepEqual(seen.slice(-2), ['POST /oauth/v2/token', 'GET /books/v3/organizations']); out.push('valid OAuth response: access token, then GET /organizations'); }

    // 2. invalid client (Zoho answers HTTP 200 with an OAuth error)
    oauth = () => ({ status: 200, body: { error: 'invalid_client' } });
    { const e = await fail(); assert.equal(e.diag.stage, 'oauth'); assert.equal(e.diag.kind, 'oauth_rejected'); assert.equal(e.diag.http_status, 200); assert.equal(e.diag.oauth_error, 'invalid_client');
      assert.equal(e.diag.host, `127.0.0.1:${port}`); assert.match(e.diag.hint, /Client ID \/ Client Secret/); assert.match(e.message, /refused to renew access \(invalid_client\)/); out.push('invalid client → oauth_rejected, invalid_client, HTTP 200'); }

    // 3. invalid client secret (Zoho may also report it as invalid_client — both are covered)
    oauth = f => ({ status: 200, body: { error: f.get('client_secret') === SECRET ? 'invalid_client_secret' : 'x' } });
    { const e = await fail(); assert.equal(e.diag.oauth_error, 'invalid_client_secret'); assert.match(e.diag.hint, /ZOHO_CLIENT_SECRET/); out.push('invalid client secret → invalid_client_secret with its hint'); }

    // 4. invalid / revoked refresh token; an error description that echoes a credential is scrubbed
    oauth = f => ({ status: 400, body: { error: 'invalid_code', error_description: `refresh token ${f.get('refresh_token')} revoked; client_secret=${SECRET}` } });
    { const e = await fail(); assert.equal(e.diag.oauth_error, 'invalid_code'); assert.equal(e.diag.http_status, 400); assert.match(e.diag.hint, /refresh token is invalid, revoked/);
      assert.match(e.diag.oauth_error_description, /\[hidden\]/); out.push('invalid / revoked refresh token → invalid_code, description scrubbed'); }
    // rate limit and a non-Zoho answer (a proxy page) are told apart from a rejection
    oauth = () => ({ status: 400, body: { error: 'Access Denied', error_description: 'You have made too many requests continuously. Please try again after some time.' } });
    { const e = await fail(); assert.match(e.diag.hint, /limiting access-token requests/); }
    oauth = () => ({ status: 403, html: '<html>Blocked by policy</html>' });
    { const e = await fail(); assert.equal(e.diag.kind, 'unexpected_response'); assert.equal(e.diag.http_status, 403); assert.match(e.diag.content_type, /text\/html/); assert.equal(e.diag.body_is_json, false); out.push('rate limit and a proxy page are reported as such'); }

    // 6. timeout: the sign-in server accepts the connection but never answers
    oauth = () => ({ hang: true });
    { const t0 = Date.now(), e = await fail({ timeout: 300 }); assert.equal(e.diag.stage, 'connect'); assert.equal(e.diag.kind, 'timeout'); assert.equal(e.diag.http_status, null); assert.ok(Date.now() - t0 < 3000);
      assert.match(e.message, /Zoho unreachable \(127\.0\.0\.1:\d+\): timeout/); out.push('timeout → stage connect, kind timeout, no HTTP status'); }
    // connection timeout inside undici, and an IPv4/IPv6 attempt that timed out on every address (AggregateError)
    { const d = Z.netFailure(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) }), 'accounts.zoho.com', SECRETS);
      assert.equal(d.kind, 'timeout'); assert.equal(d.cause_code, 'UND_ERR_CONNECT_TIMEOUT');
      const agg = Object.assign(new AggregateError([Object.assign(new Error('connect ETIMEDOUT 136.143.190.100:443'), { code: 'ETIMEDOUT', address: '136.143.190.100', port: 443 }), Object.assign(new Error('connect ENETUNREACH 2a00::1:443'), { code: 'ENETUNREACH', address: '2a00::1', port: 443 })]), { code: 'ETIMEDOUT' });
      const d2 = Z.netFailure(Object.assign(new TypeError('fetch failed'), { cause: agg }), 'accounts.zoho.com', SECRETS);
      assert.equal(d2.kind, 'timeout'); assert.deepEqual(d2.cause_codes, ['ETIMEDOUT', 'ENETUNREACH']); assert.deepEqual(d2.addresses, ['136.143.190.100:443', '2a00::1:443']); }

    // 7. TLS / network failure — real ones against local ports, and the certificate errors an inspecting antivirus or proxy causes
    { const e = await Z.http(base.replace('http:', 'https:') + '/oauth/v2/token', { method: 'POST', body: 'grant_type=refresh_token' }, 1500, SECRETS).then(() => assert.fail('TLS should fail'), x => x);   // https to a plain-http port
      clean('tls', e.diag); assert.equal(e.diag.kind, 'tls'); assert.ok(e.diag.cause_code, 'TLS cause code reported'); }
    for (const code of ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'SELF_SIGNED_CERT_IN_CHAIN', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID']) {
      const d = Z.netFailure(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('unable to verify'), { code }) }), 'accounts.zoho.com', SECRETS);
      assert.equal(d.kind, 'tls', code); assert.equal(d.cause_code, code); }
    { const tmp = http.createServer(); const p = await listen(tmp); await new Promise(r => tmp.close(r));       // a closed port → refused
      const e = await fail({ accounts: `http://127.0.0.1:${p}` }); assert.equal(e.diag.kind, 'network'); assert.equal(e.diag.cause_code, 'ECONNREFUSED'); assert.deepEqual(e.diag.addresses, [`127.0.0.1:${p}`]); }
    { const rst = http.createServer(q => q.socket.destroy()); const p = await listen(rst);                      // connection cut
      const e = await fail({ accounts: `http://127.0.0.1:${p}` }); assert.equal(e.diag.kind, 'network'); assert.match(e.diag.cause_code, /UND_ERR_SOCKET|ECONNRESET/); rst.close(); }
    { const d = Z.netFailure(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND accounts.zoho.com'), { code: 'ENOTFOUND' }) }), 'accounts.zoho.com', SECRETS);
      assert.equal(d.kind, 'dns'); }
    out.push('TLS (real + certificate codes), refused, reset and DNS failures classified with Node\'s cause code');
    // the scrubber itself
    assert.equal(Z.scrub(`a ${SECRET} b ${RT} Zoho-oauthtoken ${AT} client_id=${CID}&refresh_token=x`, SECRETS), 'a [hidden] b [hidden] Zoho-oauthtoken [hidden] client_id=[hidden]&refresh_token=[hidden]');
    assert.equal(Z.scrub('token 1000.abcdef0123456789.zz'), 'token [hidden]', 'anything shaped like a Zoho token, even when not passed');
  } finally { srv.close(); }

  // 5. the .env check — compared with what Node itself reads, so the check cannot drift from Node's parser
  const nodeReads = buf => { const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'erp-env-')), '.env'); fs.writeFileSync(f, buf); const before = new Set(Object.keys(process.env));
    try { process.loadEnvFile(f); } catch { /* unreadable */ } const got = Object.keys(process.env).filter(k => !before.has(k)); for (const k of got) delete process.env[k]; return got; };
  const LINES = ['ZOHO_CLIENT_ID=' + CID, 'ZOHO_CLIENT_SECRET=' + SECRET, 'ZOHO_DC=com', 'PORT=3000'];
  const strip = k => k.replace(/^\uFEFF/, '');
  { const ok = Buffer.from(LINES.join('\r\n') + '\r\n'), i = inspectEnv(ok);      // CRLF (PowerShell / Notepad) is fine
    assert.equal(i.encoding, 'utf-8'); assert.equal(i.line_endings, 'CRLF'); assert.deepEqual(i.problems, []); assert.deepEqual(i.blocking, []);
    assert.deepEqual(i.keys, ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_DC', 'PORT']); assert.deepEqual(nodeReads(ok).sort(), ['PORT', 'ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_DC']); clean('.env check', i); }
  { const bom = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(LINES.join('\r\n'))]), i = inspectEnv(bom);   // Set-Content -Encoding UTF8 (Windows PowerShell 5.1)
    assert.equal(i.encoding, 'utf-8 with BOM'); assert.equal(i.blocking.length, 1); assert.deepEqual(i.problems, i.blocking); assert.equal(i.keys[0], 'ZOHO_CLIENT_ID (unreadable: BOM)'); assert.match(i.blocking[0], /BOM.*ZOHO_CLIENT_ID.*ignored/);
    const got = nodeReads(bom); assert.ok(!got.includes('ZOHO_CLIENT_ID') && got.some(k => strip(k) === 'ZOHO_CLIENT_ID' && k !== 'ZOHO_CLIENT_ID'), 'Node really misreads the first key after a BOM'); clean('.env check', i); }
  { const bom = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('# Trigon\r\nPORT=3000\r\n' + LINES.slice(0, 3).join('\r\n'))]), i = inspectEnv(bom);   // BOM before a comment: only a warning
    assert.deepEqual(i.blocking, []); assert.equal(i.problems.length, 1); assert.match(i.problems[0], /BOM/); }
  { const u16 = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(LINES.join('\r\n'), 'utf16le')]), i = inspectEnv(u16);   // Out-File / ">" in Windows PowerShell
    assert.equal(i.encoding, 'utf-16le'); assert.match(i.blocking[0], /UTF-16LE.*cannot read any setting/); assert.ok(!nodeReads(u16).some(k => /ZOHO_/.test(k) && /^ZOHO_[A-Z_]+$/.test(k)), 'Node reads no Zoho key from UTF-16'); }
  { const i = inspectEnv(Buffer.from('ZOHO_CLIENT_ID=\nZOHO_CLIENT_SECRET="abc\nZOHO_DC=com\nZOHO_REFRESH_TOKEN ' + RT + '\nZOHO_DC=ae\n'));
    assert.ok(i.blocking.includes('ZOHO_CLIENT_ID is empty')); assert.ok(i.blocking.some(p => /ZOHO_CLIENT_SECRET starts with a quote/.test(p)));
    assert.ok(i.problems.includes('line 4 has no "=" — ignored by Node')); assert.ok(i.blocking.includes('ZOHO_DC appears more than once')); clean('.env check', i); }
  { const i = inspectEnv(null); assert.equal(i.exists, false); assert.deepEqual(i.blocking, []); }
  out.push('.env check: CRLF ok; BOM, UTF-16, empty value, open quote, missing "=" and duplicate keys reported (values never shown), checked against Node\'s own parser');
  { const n = netEnv({ HTTPS_PROXY: 'http://user:pass@proxy:8080', NODE_EXTRA_CA_CERTS: 'C:\\ca.pem' }); assert.equal(n.HTTPS_PROXY, 'set'); assert.equal(n.NO_PROXY, 'not set'); assert.ok(!JSON.stringify(n).includes('pass')); }
  // the only non-GET the guard lets through is still the refresh-token request
  assert.equal(decide('https://accounts.zoho.com/oauth/v2/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', client_id: 'x' }) }), 'access token');
  assert.equal(decide('https://www.zohoapis.com/books/v3/invoices', { method: 'POST' }), 'BLOCKED');

  console.log(out.map(x => '  ✔ ' + x).join('\n'));
  console.log('ZOHO SIGN-IN DIAGNOSTICS TESTS PASSED');
})().catch(e => { console.error(e); process.exit(1); });
