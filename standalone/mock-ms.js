// Minimal mock of Microsoft identity (authorize/token) + the Graph/OneDrive calls used by the sync code — for tests only.
const http = require('node:http'), crypto = require('node:crypto');
module.exports = function createMock() {
  const files = new Map();                       // path -> { id, bytes, etag, mtime }
  const codes = new Map(), sessions = new Map(), stats = { tokens: 0, refreshes: 0, puts: 0, sessionPuts: 0, deletes: 0 };
  let n = 0, tokenTtl = 3600;
  const cfg = { expireAccessAfter: () => tokenTtl };
  const validAT = new Set();
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://m'), origin = req.headers.origin || '*';
    const cors = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || '*', 'Access-Control-Allow-Methods': 'GET,PUT,POST,DELETE,OPTIONS', 'Access-Control-Expose-Headers': 'ETag' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    const chunks = []; for await (const c of req) chunks.push(c); const body = Buffer.concat(chunks);
    const send = (s, o, h = {}) => { const b = Buffer.isBuffer(o) ? o : Buffer.from(JSON.stringify(o)); res.writeHead(s, { 'Content-Type': Buffer.isBuffer(o) ? 'application/octet-stream' : 'application/json', ...cors, ...h }); res.end(b); };
    const item = (path, f) => ({ id: f.id, name: path.split('/').pop(), size: f.bytes.length, eTag: f.etag, lastModifiedDateTime: new Date(f.mtime).toISOString(), '@microsoft.graph.downloadUrl': `${base()}/dl/${f.id}` });
    const base = () => `http://localhost:${server.address().port}`;
    if (u.pathname === '/common/oauth2/v2.0/authorize') {
      const code = 'code-' + crypto.randomBytes(6).toString('hex'); codes.set(code, u.searchParams.get('code_challenge'));
      res.writeHead(302, { Location: `${u.searchParams.get('redirect_uri')}?code=${code}&state=${u.searchParams.get('state')}` }); return res.end();
    }
    if (u.pathname === '/common/oauth2/v2.0/token') {
      const p = new URLSearchParams(body.toString());
      if (p.get('grant_type') === 'authorization_code') {
        const ch = codes.get(p.get('code')); const ok = ch && crypto.createHash('sha256').update(p.get('code_verifier')).digest('base64url') === ch; codes.delete(p.get('code'));
        if (!ok) return send(400, { error: 'invalid_grant', error_description: 'bad code or verifier' });
      } else if (p.get('grant_type') === 'refresh_token') { if (!String(p.get('refresh_token')).startsWith('RT-')) return send(400, { error: 'invalid_grant', error_description: 'expired refresh token' }); stats.refreshes++; }
      else return send(400, { error: 'unsupported_grant_type' });
      stats.tokens++; const at = 'AT-' + (++n); validAT.add(at);
      return send(200, { access_token: at, refresh_token: 'RT-' + crypto.randomBytes(4).toString('hex'), expires_in: cfg.expireAccessAfter() });
    }
    if (u.pathname.startsWith('/dl/')) { const f = [...files.values()].find(x => x.id === u.pathname.slice(4)); return f ? send(200, Buffer.from(f.bytes)) : send(404, {}); }
    if (u.pathname.startsWith('/up/')) {                                                    // upload-session chunks
      const s = sessions.get(u.pathname.slice(4)); if (!s) return send(404, {});
      const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(req.headers['content-range'] || ''); s.parts.push(body); stats.sessionPuts++;
      if (+m[2] + 1 < +m[3]) return send(202, { nextExpectedRanges: [`${+m[2] + 1}-`] });
      const f = { id: s.id, bytes: Buffer.concat(s.parts), etag: `"etag-${++n}"`, mtime: Date.now() }; files.set(s.path, f); return send(200, item(s.path, f));
    }
    // ---- Graph
    const auth = /^Bearer (AT-\d+)$/.exec(req.headers.authorization || ''); if (!auth || !validAT.has(auth[1])) return send(401, { error: { code: 'InvalidAuthenticationToken' } });
    const gp = decodeURIComponent(u.pathname.replace(/^\/v1\.0/, ''));
    if (gp === '/me') return send(200, { displayName: 'Test User', userPrincipalName: 'test@example.com' });
    let m = /^\/me\/drive\/root:\/(.+?)(?::\/(content|createUploadSession|children))?$/.exec(gp);
    if (m && req.method === 'DELETE') return send(404, {});
    if (!m) { m = /^\/me\/drive\/items\/(.+)$/.exec(gp); if (m && req.method === 'DELETE') { for (const [k, f] of files) if (f.id === m[1]) { files.delete(k); stats.deletes++; } return send(204, Buffer.alloc(0)); } return send(404, { error: 'unknown' }); }
    const path = m[1], op = m[2];
    if (op === 'children') { const out = [...files].filter(([k]) => k.startsWith(path + '/')).map(([k, f]) => item(k, f)); return send(200, { value: out }); }
    if (op === 'content' && req.method === 'PUT') {
      const cur = files.get(path), im = req.headers['if-match'];
      if (cur && im && im !== cur.etag) return send(412, { error: { code: 'preconditionFailed' } });
      if (!cur && im) return send(404, { error: { code: 'itemNotFound' } });
      const f = { id: cur ? cur.id : 'id' + (++n), bytes: body, etag: `"etag-${++n}"`, mtime: Date.now() }; files.set(path, f); stats.puts++; return send(200, item(path, f));
    }
    if (op === 'createUploadSession') {
      const cur = files.get(path), im = req.headers['if-match']; if (cur && im && im !== cur.etag) return send(412, {});
      const id = crypto.randomBytes(6).toString('hex'); sessions.set(id, { path, parts: [], id: cur ? cur.id : 'id' + (++n) }); return send(200, { uploadUrl: `${base()}/up/${id}` });
    }
    if (!op && req.method === 'GET') { const f = files.get(path); return f ? send(200, item(path, f)) : send(404, { error: { code: 'itemNotFound' } }); }
    send(404, { error: 'unknown' });
  });
  return { server, files, stats, expireTokensIn: s => { tokenTtl = s; }, authority: () => `http://localhost:${server.address().port}/common`, graph: () => `http://localhost:${server.address().port}/v1.0`, FILE: 'Trigon-ERP/erp.sqlite' };
};
