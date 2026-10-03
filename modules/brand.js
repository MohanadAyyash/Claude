// Company identity: logo, stamp, signature (stored in the DB, embedded in every printed document and email).
const NAMES = ['logo', 'logo_ar', 'logo_white', 'logo_line', 'mark', 'stamp', 'signature'];
const fs = require('node:fs'), path = require('node:path');
const PACK_DIR = path.join(__dirname, '..', 'brand');
// Trigon Civil Contracting L.L.C — legal identity exactly as in the Brand Guidelines v1.1 (Arabic spelling must match the trade licence)
const PACK_SETTINGS = { company_name: 'Trigon Civil Contracting L.L.C', company_name_ar: 'تريجون سيفيل للمقاولات ذ.م.م', license_no: '1656279', license_authority: 'Dubai DET', legal_form: 'LLC',
  address: 'Office 810, Bay View Tower, Business Bay, Dubai, UAE', address_ar: 'مكتب 810، برج باي فيو، الخليج التجاري، دبي، الإمارات', po_box: '334112', website: 'trigon.ae', footer_text: '' };
const OK = ['image/png', 'image/jpeg', 'image/webp'];                       // no SVG: it can carry scripts
const MAX = 2 * 1024 * 1024;

module.exports = ctx => {
  const { db, send, bad, audit, readBody } = ctx;
  db.exec('CREATE TABLE IF NOT EXISTS brand_assets(name TEXT PRIMARY KEY, mime TEXT, data BLOB)');
  ctx.brand = name => {
    const r = db.prepare('SELECT mime,data FROM brand_assets WHERE name=?').get(name);
    return r ? `data:${r.mime};base64,${Buffer.from(r.data).toString('base64')}` : null;
  };
  ctx.brandBuf = name => { const r = db.prepare('SELECT data FROM brand_assets WHERE name=?').get(name); return r ? Buffer.from(r.data) : null; };
  ctx.parseDataUrl = s => {
    const m = /^data:([\w.+/-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(s || ''));
    return m ? { mime: m[1], buf: Buffer.from(m[2].replace(/\s/g, ''), 'base64') } : null;
  };
  return {
    async handle(req, res, url, [a, name], me) {
      if (a !== 'brand') return false;
      if (req.method === 'GET' && !name) return send(res, 200, db.prepare('SELECT name,mime,length(data) size FROM brand_assets').all()), true;
      if (name === 'pack' && req.method === 'POST') {                       // one-click install of the bundled Trigon identity pack
        if (!fs.existsSync(path.join(PACK_DIR, 'logo.png'))) bad('Brand pack files are missing (brand/ folder)');
        const ins = db.prepare('INSERT OR REPLACE INTO brand_assets VALUES(?,?,?)'), set = db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)');
        for (const n of NAMES) { const f = path.join(PACK_DIR, n + '.png'); if (fs.existsSync(f)) ins.run(n, 'image/png', fs.readFileSync(f)); }
        for (const [k, v] of Object.entries(PACK_SETTINGS)) set.run(k, v);
        audit(req, 'update', 'brand', 0, 'Trigon brand pack installed');
        return send(res, 200, { ok: 1 }), true;
      }
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
