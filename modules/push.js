// Notifications: an in-app inbox for every user plus Web Push to the phones/computers where they switched it on.
// ctx.notify(target, { title, body, url }) is used by other modules (approvals, HR alerts). VAPID keys are generated
// on first use and kept in their own table (never in settings, which the browser can read).
const { generateVapid, sendPush } = require('../lib/webpush');
// push services of the major browsers; the server only ever POSTs to these (a subscription is user input)
const PUSH_HOSTS = ['fcm.googleapis.com', 'android.googleapis.com', 'push.apple.com', 'push.services.mozilla.com', 'notify.windows.com'];
const okEndpoint = u => { try { const x = new URL(u); return x.protocol === 'https:' && PUSH_HOSTS.some(h => x.hostname === h || x.hostname.endsWith('.' + h)); } catch { return false; } };

module.exports = ctx => {
  const { db, send, bad, readBody, getSettings } = ctx;
  db.exec(`CREATE TABLE IF NOT EXISTS push_keys(id INTEGER PRIMARY KEY CHECK(id=1), public TEXT, private TEXT);
  CREATE TABLE IF NOT EXISTS push_subs(id INTEGER PRIMARY KEY, user_id INTEGER, endpoint TEXT UNIQUE, p256dh TEXT, auth TEXT, device TEXT, created TEXT, last_ok TEXT);
  CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY, user_id INTEGER, ts TEXT, title TEXT, body TEXT, url TEXT, read INTEGER DEFAULT 0);
  CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, read);`);
  const server = typeof window === 'undefined';                                     // the browser-only edition has no push (no background process)
  const allowAny = !!process.env.PUSH_ALLOW_ANY_ENDPOINT;                           // tests only (mock push service on localhost)
  const keys = () => {
    if (!server) return null;
    let k = db.prepare('SELECT public, private FROM push_keys WHERE id=1').get();
    if (!k) { const g = generateVapid(); db.prepare('INSERT INTO push_keys(id,public,private) VALUES(1,?,?)').run(g.publicKey, g.privateKey); k = { public: g.publicKey, private: g.privateKey }; }
    return { publicKey: k.public, privateKey: k.private };
  };
  const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

  // target: user id, array of ids, { roles: [...] } or { employee_id }
  function users(target) {
    if (Array.isArray(target)) return [...new Set(target.filter(Boolean).map(Number))];
    if (typeof target === 'number') return [target];
    if (target && target.roles) return db.prepare(`SELECT id FROM users WHERE role IN (${target.roles.map(() => '?').join(',')})`).all(...target.roles).map(r => r.id);
    if (target && target.employee_id) return db.prepare('SELECT id FROM users WHERE employee_id=?').all(target.employee_id).map(r => r.id);
    return [];
  }
  ctx.notify = async (target, { title, body = '', url = '' }) => {
    const ids = users(target); if (!ids.length) return { users: 0, sent: 0, failed: 0 };
    const ins = db.prepare('INSERT INTO notifications(user_id,ts,title,body,url) VALUES(?,?,?,?,?)');
    for (const id of ids) ins.run(id, now(), String(title).slice(0, 200), String(body).slice(0, 1000), url);
    const k = keys(); let sent = 0, failed = 0;
    if (!k) return { users: ids.length, sent, failed };
    const S = getSettings(), subject = 'mailto:' + (S.smtp_from || S.email || 'admin@example.com');
    const subs = db.prepare(`SELECT * FROM push_subs WHERE user_id IN (${ids.map(() => '?').join(',')})`).all(...ids);
    await Promise.all(subs.map(async s => {
      const unread = db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read=0').get(s.user_id).n;
      const r = await sendPush(s, { title, body, url, badge: unread }, { vapid: k, subject });
      if (r.ok) { sent++; db.prepare('UPDATE push_subs SET last_ok=? WHERE id=?').run(now(), s.id); }
      else { failed++; if (r.gone) db.prepare('DELETE FROM push_subs WHERE id=?').run(s.id); }
    }));
    return { users: ids.length, sent, failed };
  };

  return {
    async handle(req, res, url, [a, b], me) {
      const m = req.method;
      if (a === 'push') {
        if (m === 'GET' && b === 'key') { const k = keys(); return send(res, 200, { enabled: !!k, publicKey: k ? k.publicKey : null, devices: db.prepare('SELECT COUNT(*) n FROM push_subs WHERE user_id=?').get(me.id).n }), true; }
        if (b === 'subscribe' && m === 'POST') {
          const x = await readBody(req), s = x.subscription || x;
          if (!s || !s.endpoint || !s.keys || !s.keys.p256dh || !s.keys.auth) bad('Invalid subscription');
          if (!okEndpoint(s.endpoint) && !(allowAny && /^http:\/\/127\.0\.0\.1:\d+\//.test(s.endpoint))) bad('Unknown push service');
          db.prepare(`INSERT INTO push_subs(user_id,endpoint,p256dh,auth,device,created) VALUES(?,?,?,?,?,?)
            ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth, device=excluded.device`)
            .run(me.id, s.endpoint, s.keys.p256dh, s.keys.auth, String(x.device || '').slice(0, 120), now());
          return send(res, 200, { ok: 1 }), true;
        }
        if (b === 'subscribe' && m === 'DELETE') { const x = await readBody(req); db.prepare('DELETE FROM push_subs WHERE endpoint=? AND user_id=?').run(String(x.endpoint || ''), me.id); return send(res, 200, { ok: 1 }), true; }
        if (b === 'test' && m === 'POST') return send(res, 200, await ctx.notify(me.id, { title: 'Trigon ERP', body: 'الإشعارات تعمل على هذا الجهاز ✔ / Notifications work on this device', url: '#notifications' })), true;
        return send(res, 404, { error: 'not found' }), true;
      }
      if (a === 'notifications') {
        if (m === 'GET') return send(res, 200, { unread: db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read=0').get(me.id).n,
          items: url.searchParams.get('count') ? [] : db.prepare('SELECT id,ts,title,body,url,read FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 50').all(me.id) }), true;
        if (m === 'POST' && b === 'read') { db.prepare('UPDATE notifications SET read=1 WHERE user_id=?').run(me.id); return send(res, 200, { ok: 1 }), true; }
        return send(res, 404, { error: 'not found' }), true;
      }
      return false;
    },
  };
};
