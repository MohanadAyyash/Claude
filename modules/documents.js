// Attachments: contracts, licences, invoices from suppliers, employee papers… with expiry tracking.
const { READERS, OPS, FIN } = require('../lib/acl');
const ENTITIES = {                     // entity: [read roles, write roles]
  project: [READERS, OPS], party: [READERS, OPS], bill: [READERS, FIN], invoice: [READERS, FIN], purchase_order: [READERS, OPS], subcontract: [READERS, OPS],
  employee: [['admin', 'accountant', 'hr'], ['admin', 'hr']], company: [['admin', 'accountant', 'hr'], ['admin', 'accountant']],
};
const MIMES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'text/plain', 'text/csv', 'application/msword', 'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];
const MAX = 8 * 1024 * 1024;

module.exports = ctx => {
  const { db, send, bad, audit, readBody, today } = ctx;
  db.exec(`CREATE TABLE IF NOT EXISTS documents(id INTEGER PRIMARY KEY, entity TEXT, entity_id INTEGER DEFAULT 0, category TEXT, name TEXT, mime TEXT, size INTEGER, data BLOB, expiry_date TEXT, uploaded_by TEXT, created TEXT)`);
  const allowed = (role, entity, write) => !!ENTITIES[entity] && (role === 'admin' || ENTITIES[entity][write ? 1 : 0].includes(role));
  return {
    async handle(req, res, url, [a, b, c], me) {
      if (a !== 'documents') return false;
      const m = req.method;
      if (m === 'GET' && !b) {
        const entity = url.searchParams.get('entity'), eid = +url.searchParams.get('entity_id') || 0;
        if (entity) { if (!allowed(me.role, entity, false)) return send(res, 403, { error: 'your role does not allow this action' }), true; }
        const rows = db.prepare(`SELECT id,entity,entity_id,category,name,mime,size,expiry_date,uploaded_by,created FROM documents ${entity ? 'WHERE entity=? AND entity_id=?' : ''} ORDER BY id DESC`).all(...(entity ? [entity, eid] : []));
        return send(res, 200, rows.filter(r => allowed(me.role, r.entity, false))), true;
      }
      if (m === 'POST' && !b) {
        const body = await readBody(req, 12e6);
        if (!allowed(me.role, body.entity, true)) return send(res, 403, { error: 'your role does not allow this action' }), true;
        const f = ctx.parseDataUrl(body.data);
        if (!f || !MIMES.includes(f.mime)) bad('Unsupported file type (PDF, images, Word, Excel, text)');
        if (f.buf.length > MAX) bad('File is larger than 8 MB');
        const name = String(body.name || 'file').replace(/[\r\n"\\/]/g, '_').slice(0, 120);
        const r = db.prepare('INSERT INTO documents(entity,entity_id,category,name,mime,size,data,expiry_date,uploaded_by,created) VALUES(?,?,?,?,?,?,?,?,?,?)')
          .run(body.entity, +body.entity_id || 0, body.category || '', name, f.mime, f.buf.length, f.buf, body.expiry_date || null, me.username, today());
        audit(req, 'upload', 'documents', Number(r.lastInsertRowid), `${body.entity} ${body.entity_id || ''}: ${name}`);
        return send(res, 200, { id: Number(r.lastInsertRowid) }), true;
      }
      const d = db.prepare('SELECT * FROM documents WHERE id=?').get(+b);
      if (!d) return send(res, 404, { error: 'not found' }), true;
      if (m === 'GET' && c === 'download') {
        if (!allowed(me.role, d.entity, false)) return send(res, 403, { error: 'your role does not allow this action' }), true;
        res.writeHead(200, { 'Content-Type': d.mime, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(d.name)}`, 'Content-Security-Policy': "default-src 'none'; sandbox" });
        return res.end(Buffer.from(d.data)), true;
      }
      if (!allowed(me.role, d.entity, true)) return send(res, 403, { error: 'your role does not allow this action' }), true;
      if (m === 'PUT') {
        const body = await readBody(req);
        db.prepare('UPDATE documents SET category=?, expiry_date=?, name=? WHERE id=?').run(body.category ?? d.category, body.expiry_date || null, String(body.name || d.name).replace(/[\r\n"\\/]/g, '_'), d.id);
        return send(res, 200, { ok: 1 }), true;
      }
      if (m === 'DELETE') { db.prepare('DELETE FROM documents WHERE id=?').run(d.id); audit(req, 'delete', 'documents', d.id, d.name); return send(res, 200, { ok: 1 }), true; }
      return false;
    },
  };
};
