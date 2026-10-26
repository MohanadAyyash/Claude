// Service worker: opens the app instantly from the phone's cache, fetches a new version once after each update
// (the server stamps VERSION with a hash of the app files), and shows push notifications. API calls always go to the server.
const VERSION = '__VERSION__', CACHE = 'trigon-' + VERSION, BRAND = 'trigon-brand';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'ops.js', 'contract.js', 'statements.js', 'hr.js', 'workforce.js', 'collab.js', 'accounting.js', 'zoho.js', 'mobile.js', 'boot.js', 'manifest.webmanifest', 'icon-192.png', 'fonts/fonts.css',
  'fonts/ibm-plex-sans-arabic-arabic-400-normal.woff2', 'fonts/ibm-plex-sans-arabic-arabic-600-normal.woff2', 'fonts/archivo-latin-400-normal.woff2', 'fonts/archivo-latin-600-normal.woff2'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).catch(() => {}));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('trigon-') && k !== CACHE && k !== BRAND).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('message', e => { if (e.data === 'update') self.skipWaiting(); });

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (/^\/api\/brand\/(logo|logo_white|mark)$/.test(url.pathname)) {                      // logos: show the cached one, refresh it in the background
    e.respondWith(caches.open(BRAND).then(async c => {
      const hit = await c.match(req), net = fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
    return;
  }
  if (url.pathname.startsWith('/api/')) return;                                          // data: always live
  if (req.mode === 'navigate') { e.respondWith(caches.match('index.html').then(r => r || fetch(req))); return; }   // hash routes → one page
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(r => r || fetch(req).then(res => {
    if (res.ok && url.pathname.startsWith('/fonts/')) caches.open(CACHE).then(c => c.put(req, res.clone()));
    return res;
  })));
});

self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'Trigon', body: e.data ? e.data.text() : '' }; }
  const shown = self.registration.showNotification(d.title || 'Trigon', { body: d.body || '', icon: 'icon-192.png', badge: 'icon-192.png', tag: d.tag || undefined, data: { url: d.url || '' }, lang: 'ar', dir: 'auto' });
  const badge = navigator.setAppBadge && d.badge ? navigator.setAppBadge(d.badge).catch(() => {}) : null;
  e.waitUntil(Promise.all([shown, badge]));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const hash = (e.notification.data && e.notification.data.url) || '';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const w = list.find(c => c.url.startsWith(self.registration.scope));
    if (w) { w.postMessage({ go: hash.replace(/^#/, '') }); return w.focus(); }                // the open app switches page itself
    return self.clients.openWindow(new URL('./' + hash, self.registration.scope).href);
  }));
});
