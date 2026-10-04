// Standalone (serverless) edition — runtime. Runs the unchanged server code (erp-server.js) inside the page:
//   - SQLite = sql.js (WebAssembly); the database file lives in IndexedDB and is mirrored to OneDrive (standalone-cloud.js)
//   - fetch('/api/…') is answered by the in-page request handler, so the UI code needs no changes
//   - downloads, printable documents and brand images are routed through the same handler
(function () {
  'use strict';
  window.STANDALONE = true;
  const BASE = new URL('./', document.baseURI).href;
  const lang = () => localStorage.lang || 'ar';
  const T = (ar, en) => (lang() === 'ar' ? ar : en);

  // ---------- tiny IndexedDB key/value store ----------
  const idb = () => new Promise((ok, no) => { const r = indexedDB.open('trigon-erp', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
  const idbGet = async k => { const d = await idb(); return new Promise((ok, no) => { const q = d.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => ok(q.result); q.onerror = () => no(q.error); }); };
  const idbSet = async (k, v) => { const d = await idb(); return new Promise((ok, no) => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => ok(); t.onerror = () => no(t.error); }); };

  const S = window.ERPStore = { SQL: null, db: null, rec: null, BASE, T, idbGet, idbSet, dirty: false };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const loadScript = src => new Promise((ok, no) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => no(new Error('failed to load ' + src)); document.head.appendChild(s); });
  function fatal(msg) { document.getElementById('app').innerHTML = `<div style="max-width:420px;margin:15vh auto;padding:22px;background:#fff;border:1px solid #D6D2C8;border-radius:12px;font-family:Arial,sans-serif;color:#1F3A5F"><h3>Trigon ERP</h3><p>${msg}</p></div>`; }

  // ---------- persistence ----------
  let timer = null;
  S.flushNow = async function () {
    clearTimeout(timer);
    if (!S.db) return;
    const bytes = S.db.export();                                                    // note: re-opens the DB; we never cache prepared statements
    S.rec = { ...(S.rec || {}), bytes, dirty: S.dirty, savedAt: Date.now() };
    await idbSet('db', S.rec);
    if (S.dirty && window.ERPCloud) window.ERPCloud.schedule();
  };
  S.markDirty = function () { S.dirty = true; S.ver = (S.ver || 0) + 1; clearTimeout(timer); timer = setTimeout(() => S.flushNow().catch(e => console.error(e)), 500); if (window.ERPCloud) window.ERPCloud.notify(); };
  S.replaceDb = async function (bytes, etag) {                                       // used when pulling a newer copy from OneDrive / restoring a file
    S.rec = { bytes, baseETag: etag || null, dirty: !etag, savedAt: Date.now() }; await idbSet('db', S.rec);
  };
  S.hasUsers = db => { try { const r = db.exec('SELECT COUNT(*) FROM users'); return r[0].values[0][0] > 0; } catch { return false; } };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') S.flushNow().catch(() => {}); });
  addEventListener('pagehide', () => { S.flushNow().catch(() => {}); });

  // ---------- the in-page "server" ----------
  let sid = localStorage.erp_sid || '';
  function callHandler(method, pathAndQuery, bodyStr) {
    return new Promise(resolve => {
      const h = {}; let queued = false, status = 200; const out = {};
      const req = { method, url: pathAndQuery, headers: { cookie: sid ? 'sid=' + sid : '', 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' }, destroy() {},
        on(ev, cb) { (h[ev] = h[ev] || []).push(cb); if (!queued) { queued = true; queueMicrotask(() => { (h.data || []).forEach(f => f(bodyStr || '')); (h.end || []).forEach(f => f()); }); } return req; } };
      const res = { writeHead(s, hh) { status = s; for (const k in hh || {}) out[k.toLowerCase()] = hh[k]; }, setHeader(k, v) { out[k.toLowerCase()] = v; },
        end(d) { const enc = new TextEncoder(); const body = d == null ? new Uint8Array(0) : typeof d === 'string' ? enc.encode(d) : d; resolve({ status, headers: out, body }); } };
      try { Promise.resolve(window.__ERP_HANDLER(req, res)).catch(e => resolve({ status: 500, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ error: String(e && e.message || e) })) })); }
      catch (e) { resolve({ status: 500, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ error: String(e) })) }); }
    });
  }
  function takeCookie(headers) {
    const c = headers['set-cookie']; if (!c) return; const m = /(?:^|\s)sid=([^;]*)/.exec(String(c)); if (!m) return;
    if (!m[1] || /Max-Age=0/i.test(c)) { sid = ''; localStorage.removeItem('erp_sid'); } else { sid = m[1]; localStorage.erp_sid = sid; }
  }
  async function api(method, pathAndQuery, bodyStr) {
    const r = await callHandler(method, pathAndQuery, bodyStr); takeCookie(r.headers);
    if (method !== 'GET' && r.status < 400 && !/^\/api\/(login|logout)\b/.test(pathAndQuery)) S.markDirty();     // sign-in/out only touch the sessions table: not a data change, must not trigger uploads or conflicts
    return r;
  }
  const toResponse = r => { const h = new Headers(); for (const k in r.headers) if (k !== 'set-cookie') h.set(k, r.headers[k]); return new Response(r.body, { status: r.status, headers: h }); };
  S.api = api;

  const realFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (!url.pathname.startsWith('/api/')) return realFetch(input, init);
    const method = ((init && init.method) || (typeof input !== 'string' && input.method) || 'GET').toUpperCase();
    if (url.pathname === '/api/backup') return backup();
    return toResponse(await api(method, url.pathname + url.search, init && typeof init.body === 'string' ? init.body : ''));
  };
  async function backup() {                                                           // database file download (admin only, like the server edition)
    const chk = await callHandler('GET', '/api/audit', '');
    if (chk.status !== 200) return toResponse(chk);
    await S.flushNow();
    return new Response(S.db.export(), { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="trigon-erp-${new Date().toISOString().slice(0, 10)}.sqlite"` } });
  }

  // ---------- documents, downloads, brand images ----------
  function showDocument(html, title) {
    html = html.replace('href="/fonts/fonts.css"', `href="${BASE}fonts/fonts.css"`).replace(/<script>window\.onload=function\(\)\{setTimeout\(function\(\)\{window\.print\(\)\},300\)\}<\/script>/, '');
    let ov = document.getElementById('docview'); if (ov) ov.remove();
    ov = document.createElement('div'); ov.id = 'docview';
    ov.style.cssText = 'position:fixed;inset:0;z-index:100;background:#F2F1EE;display:flex;flex-direction:column';
    ov.innerHTML = `<div style="display:flex;gap:8px;align-items:center;padding:calc(8px + env(safe-area-inset-top)) 12px 8px;background:#1F3A5F;color:#fff;font:14px Arial"><b style="flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${(title || '').replace(/</g, '&lt;')}</b>
      <button id="dv-print" style="padding:8px 14px;border:0;border-radius:6px;background:#fff;color:#1F3A5F;font:600 14px Arial">${T('طباعة / حفظ PDF', 'Print / Save PDF')}</button><button id="dv-close" style="padding:8px 12px;border:0;border-radius:6px;background:rgba(255,255,255,.18);color:#fff;font:600 16px Arial">✕</button></div>
      <iframe id="dv-frame" style="flex:1;border:0;background:#fff;width:100%"></iframe>`;
    document.body.appendChild(ov);
    const fr = ov.querySelector('#dv-frame'); fr.srcdoc = html;
    ov.querySelector('#dv-close').onclick = () => ov.remove();
    ov.querySelector('#dv-print').onclick = () => { try { fr.contentWindow.focus(); fr.contentWindow.print(); } catch { window.print(); } };
  }
  function download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000); }
  async function openApi(u) {
    let p = u.pathname;
    const isDoc = /^\/api\/(doc\/|me\/(payslip|letter)\/)/.test(p);
    if (isDoc) { p = p.replace(/\/pdf$/, ''); const r = await fetch(p + u.search.replace(/[?&]print=1/, '')); const html = await r.text(); if (!r.ok) { alert((() => { try { return JSON.parse(html).error; } catch { return html; } })()); return; } showDocument(html, T('معاينة المستند', 'Document preview')); return; }
    const r = await fetch(u.pathname + u.search);
    if (!r.ok) { let m = r.statusText; try { m = (await r.json()).error || m; } catch { /* ignore */ } alert(m); return; }
    const cd = r.headers.get('content-disposition') || '', m = /filename\*=UTF-8''([^;]+)/i.exec(cd) || /filename="?([^";]+)"?/i.exec(cd);
    download(await r.blob(), m ? decodeURIComponent(m[1]) : 'download');
  }
  const realOpen = window.open.bind(window);
  window.open = function (url, ...rest) { const u = new URL(url, location.href); if (u.origin === location.origin && u.pathname.startsWith('/api/')) { openApi(u); return null; } return realOpen(url, ...rest); };
  document.addEventListener('click', e => {
    const a = e.target.closest && e.target.closest('a[href]'); if (!a) return;
    const u = new URL(a.getAttribute('href'), location.href); if (u.origin === location.origin && u.pathname.startsWith('/api/')) { e.preventDefault(); openApi(u); }
  }, true);
  // <img src="/api/brand/…"> → blob URLs served from the local database
  const imgCache = new Map();
  async function fixImg(img) {
    const src = img.getAttribute('src') || ''; if (!/^\/api\/brand\//.test(src)) return;
    const key = src.split('?')[0]; if (!imgCache.has(key)) imgCache.set(key, fetch(key).then(r => (r.ok ? r.blob() : null)).then(b => (b ? URL.createObjectURL(b) : null)));
    const url = await imgCache.get(key); if (url) img.src = url; else img.removeAttribute('src');
  }
  S.dropImgCache = () => imgCache.clear();
  const mo = new MutationObserver(ms => { for (const m of ms) { if (m.type === 'attributes') fixImg(m.target); else m.addedNodes.forEach(n => { if (n.nodeType === 1) { if (n.tagName === 'IMG') fixImg(n); n.querySelectorAll && n.querySelectorAll('img[src^="/api/brand/"]').forEach(fixImg); } }); } });
  mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });

  // ---------- start-up ----------
  window.__ERPReady = (async function () {
    try {
      if (navigator.locks) {                                                          // one tab at a time: two tabs would overwrite each other's data
        const got = await new Promise(ok => navigator.locks.request('trigon-erp-db', { ifAvailable: true }, lock => { ok(!!lock); if (lock) return new Promise(() => {}); }));
        if (!got) { fatal(T('النظام مفتوح في تبويب آخر. أغلقه أو استخدم ذلك التبويب.', 'The system is already open in another tab. Close it or use that tab.')); throw new Error('locked'); }
      }
      navigator.storage && navigator.storage.persist && navigator.storage.persist().catch(() => {});
      await loadScript(BASE + 'sql-wasm.js');
      S.SQL = await initSqlJs({ locateFile: f => BASE + f });
      if (window.ERPCloud) await window.ERPCloud.completeSignIn();                    // returns from the Microsoft sign-in page
      let rec = await idbGet('db'); S.rec = rec || null; S.dirty = !!(rec && rec.dirty);
      let db = rec && rec.bytes ? new S.SQL.Database(rec.bytes) : new S.SQL.Database();
      if (window.ERPCloud) {                                                          // decide between the local copy and the OneDrive copy before the server code starts
        const d = await window.ERPCloud.reconcile(rec, S.hasUsers(db));
        if (d && d.bytes) { await S.replaceDb(d.bytes, d.etag); S.rec = await idbGet('db'); S.dirty = !!S.rec.dirty; db = new S.SQL.Database(d.bytes); }
      }
      S.db = db; globalThis.__ERP_SQLDB = db;
      const files = globalThis.__ERP_FILES = {};                                      // brand pack files for the "install brand pack" button
      await Promise.all(['logo', 'logo_ar', 'logo_white', 'logo_line', 'mark'].map(async n => { try { const r = await realFetch(`${BASE}brand/${n}.png`); if (r.ok) files[`/brand/${n}.png`] = new Uint8Array(await r.arrayBuffer()); } catch { /* optional */ } }));
      await loadScript(BASE + 'erp-server.js');                                       // runs the schema/migrations on the loaded database
      if (!window.__ERP_HANDLER) throw new Error('server bundle did not initialise');
      await S.flushNow();
      if (window.ERPCloud) window.ERPCloud.start();
    } catch (e) { if (e.message !== 'locked') fatal(String(e.message || e)); console.error(e); throw e; }
  })();
})();
