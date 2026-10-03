// Company identity: logo, stamp, signature (stored in the DB, embedded in every printed document and email).
const NAMES = ['logo', 'stamp', 'signature'];
const OK = ['image/png', 'image/jpeg', 'image/webp'];                       // no SVG: it can carry scripts
const MAX = 2 * 1024 * 1024;

module.exports = ctx => {
  const { db, send, bad, audit, readBody } = ctx;
  db.exec('CREATE TABLE IF NOT EXISTS brand_assets(name TEXT PRIMARY KEY, mime TEXT, data BLOB)');
  ctx.brand = name => {
    const r = db.prepare('SELECT mime,data FROM brand_assets WHERE name=?').get(name);
    return r ? `data:${r.mime};base64,${Buffer.from(r.data).toString('base64')}` : null;
  };
  ctx.parseDataUrl = s => {
    const m = /^data:([\w.+/-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(s || ''));
    return m ? { mime: m[1], buf: Buffer.from(m[2].replace(/\s/g, ''), 'base64') } : null;
  };
  return {
    async handle(req, res, url, [a, name], me) {
      if (a !== 'brand') return false;
      if (req.method === 'GET' && !name) return send(res, 200, db.prepare('SELECT name,mime,length(data) size FROM brand_assets').all()), true;
      if (!NAMES.includes(name)) return send(res, 404, { error: 'not found' }), true;
      if (req.method === 'GET') {
        const r = db.prepare('SELECT mime,data FROM brand_assets WHERE name=?').get(name);
        if (!r) return send(res, 404, { error: 'not found' }), true;
        res.writeHead(200, { 'Content-Type': r.mime, 'Cache-Control': 'private, max-age=60', 'Content-Security-Policy': "default-src 'none'; sandbox" });
        return res.end(Buffer.from(r.data)), true;
      }
      if (req.method === 'PUT') {
        const f = ctx.parseDataUrl((await readBody(req, 4e6)).data);
        if (!f || !OK.includes(f.mime)) bad('Upload a PNG, JPG or WebP image');
        if (f.buf.length > MAX) bad('Image is larger than 2 MB');
        db.prepare('INSERT OR REPLACE INTO brand_assets VALUES(?,?,?)').run(name, f.mime, f.buf);
        audit(req, 'update', 'brand', 0, `${name} uploaded`);
        return send(res, 200, { ok: 1 }), true;
      }
      if (req.method === 'DELETE') { db.prepare('DELETE FROM brand_assets WHERE name=?').run(name); audit(req, 'delete', 'brand', 0, name); return send(res, 200, { ok: 1 }), true; }
      return false;
    },
  };
};
