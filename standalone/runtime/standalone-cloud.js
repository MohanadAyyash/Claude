// OneDrive sync for the standalone edition.
//   Sign-in: Microsoft identity platform, authorization-code flow with PKCE (no client secret, no server).
//   Storage : one SQLite file  <OneDrive>/Trigon-ERP/erp.sqlite  (+ a daily copy in Trigon-ERP/backups/), via Microsoft Graph.
//   Safety  : the local copy (IndexedDB) is always written first; uploads use If-Match (ETag) so two devices can never silently overwrite each other.
(function () {
  'use strict';
  const BASE = new URL('./', document.baseURI).href;
  const ls = localStorage;
  const FOLDER = 'Trigon-ERP', FILE = 'erp.sqlite', SCOPE = 'Files.ReadWrite offline_access User.Read';
  const cfg = {
    get client() { return ls.erp_od_client || ''; }, set client(v) { ls.erp_od_client = String(v || '').trim(); },
    get auth() { return ls.erp_od_authority || 'https://login.microsoftonline.com/common'; },     // overridable for tests
    get graph() { return ls.erp_od_graph || 'https://graph.microsoft.com/v1.0'; },
  };
  const Store = () => window.ERPStore;
  const T = (ar, en) => Store().T(ar, en);
  const readTok = () => { try { return JSON.parse(ls.erp_od_tok || 'null'); } catch { return null; } };
  const st = { state: 'local', last: ls.erp_od_last ? +ls.erp_od_last : null, message: '', conflict: null, remoteNewer: false };
  const listeners = new Set();
  const setState = (s, msg = '') => { st.state = s; st.message = msg; listeners.forEach(f => { try { f(st); } catch { /* ignore */ } }); };
  const connected = () => !!(readTok() && cfg.client);
  const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const rand = n => b64url(crypto.getRandomValues(new Uint8Array(n)));
  const today = () => new Date().toISOString().slice(0, 10);
  const authErr = m => Object.assign(new Error(m), { auth: true });
  const httpErr = async (r, what) => Object.assign(new Error(`${what}: ${r.status} ${(await r.text().catch(() => '')).slice(0, 160)}`), { status: r.status });

  // ---------- sign-in ----------
  async function signIn() {
    if (!cfg.client) throw new Error(T('أدخل معرّف التطبيق (Client ID) أولاً', 'Enter the application (client) ID first'));
    await Store().flushNow().catch(() => {});
    const verifier = rand(48), state = rand(12), challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    ls.erp_od_pkce = JSON.stringify({ verifier, state, t: Date.now() });
    const q = new URLSearchParams({ client_id: cfg.client, response_type: 'code', redirect_uri: BASE, response_mode: 'query', scope: SCOPE, state, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account' });
    location.assign(`${cfg.auth}/oauth2/v2.0/authorize?${q}`);
  }
  async function tokenRequest(params) {
    const r = await fetch(`${cfg.auth}/oauth2/v2.0/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: cfg.client, scope: SCOPE, ...params }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw authErr(j.error_description || j.error || 'sign-in failed');
    const old = readTok() || {};
    ls.erp_od_tok = JSON.stringify({ access: j.access_token, refresh: j.refresh_token || old.refresh, exp: Date.now() + (j.expires_in || 3600) * 1000 });
    return readTok();
  }
  async function completeSignIn() {                                              // runs on page load: handles the redirect back from Microsoft
    const q = new URLSearchParams(location.search);
    if (!q.get('code') && !q.get('error')) return;
    const clean = () => history.replaceState({}, '', BASE);
    if (q.get('error')) { ls.erp_od_err = q.get('error_description') || q.get('error'); clean(); return; }
    let p = null; try { p = JSON.parse(ls.erp_od_pkce || 'null'); } catch { /* ignore */ }
    clean(); ls.removeItem('erp_od_pkce');
    if (!p || p.state !== q.get('state')) { ls.erp_od_err = T('فشل التحقق من تسجيل الدخول (state)', 'Sign-in check failed (state mismatch)'); return; }
    try { await tokenRequest({ grant_type: 'authorization_code', code: q.get('code'), redirect_uri: BASE, code_verifier: p.verifier }); ls.removeItem('erp_od_err'); ls.erp_od_fresh = '1'; }
    catch (e) { ls.erp_od_err = e.message; }
  }
  async function accessToken() {
    let t = readTok(); if (!t) throw authErr('not signed in');
    if (t.exp - 60000 > Date.now()) return t.access;
    if (!t.refresh) throw authErr('session expired');
    try { t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh }); } catch (e) { if (e.auth) { setState('signin', T('انتهت جلسة مايكروسوفت — سجّل الدخول من جديد', 'Your Microsoft session expired — sign in again')); } throw e; }
    return t.access;
  }
  function signOut() { ['erp_od_tok', 'erp_od_user', 'erp_od_last', 'erp_od_bk'].forEach(k => ls.removeItem(k)); st.last = null; st.conflict = null; setState('local'); }

  // ---------- Graph helpers ----------
  async function gfetch(path, opts = {}, retry = true) {
    const token = await accessToken();
    let r; try { r = await fetch(path.startsWith('http') ? path : cfg.graph + path, { ...opts, headers: { Authorization: 'Bearer ' + token, ...(opts.headers || {}) } }); }
    catch (e) { throw Object.assign(new Error('offline'), { offline: true }); }
    if (r.status === 401 && retry) { const t = readTok(); if (t) { t.exp = 0; ls.erp_od_tok = JSON.stringify(t); } return gfetch(path, opts, false); }
    return r;
  }
  const itemPath = (sub = '') => `/me/drive/root:/${FOLDER}${sub}`;
  async function remoteMeta() {
    const r = await gfetch(`${itemPath('/' + FILE)}`);
    if (r.status === 404) return null;
    if (!r.ok) throw await httpErr(r, 'OneDrive');
    return r.json();
  }
  async function download(meta) {
    let r = meta['@microsoft.graph.downloadUrl'] ? await fetch(meta['@microsoft.graph.downloadUrl']) : await gfetch(`${itemPath('/' + FILE)}:/content`);
    if (!r.ok) throw await httpErr(r, 'download');
    return new Uint8Array(await r.arrayBuffer());
  }
  async function putFile(sub, bytes, etag) {
    const url = `${itemPath(sub)}:/content?@microsoft.graph.conflictBehavior=replace`;
    if (bytes.length <= 4 * 1000 * 1000) {
      let r = await gfetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', ...(etag ? { 'If-Match': etag } : {}) }, body: bytes });
      if (r.status === 404 && etag) r = await gfetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes });   // remote file was deleted
      if (r.status === 412) throw Object.assign(new Error('conflict'), { status: 412 });
      if (!r.ok) throw await httpErr(r, 'upload');
      return r.json();
    }
    const s = await gfetch(`${itemPath(sub)}:/createUploadSession`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(etag ? { 'If-Match': etag } : {}) }, body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } }) });
    if (s.status === 412) throw Object.assign(new Error('conflict'), { status: 412 });
    if (!s.ok) throw await httpErr(s, 'upload session');
    const { uploadUrl } = await s.json(), chunk = 320 * 1024 * 12; let last = null;
    for (let a = 0; a < bytes.length; a += chunk) {
      const b = Math.min(a + chunk, bytes.length) - 1;
      const r = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Range': `bytes ${a}-${b}/${bytes.length}` }, body: bytes.slice(a, b + 1) });
      if (!r.ok && r.status !== 202) throw await httpErr(r, 'upload chunk');
      if (r.status !== 202) last = await r.json();
    }
    return last;
  }
  async function dailyBackup(bytes) {                                              // one dated copy per day; keep the last 30
    if (ls.erp_od_bk === today()) return;
    try {
      await putFile(`/backups/erp-${today()}.sqlite`, bytes, null); ls.erp_od_bk = today();
      const r = await gfetch(`${itemPath('/backups')}:/children?$select=id,name,lastModifiedDateTime&$top=200`);
      if (r.ok) for (const f of (await r.json()).value || []) if (Date.now() - new Date(f.lastModifiedDateTime).getTime() > 30 * 864e5) await gfetch(`/me/drive/items/${f.id}`, { method: 'DELETE' });
    } catch { /* backup copy is best-effort */ }
  }
  async function whoAmI() { try { const r = await gfetch('/me?$select=displayName,userPrincipalName'); if (r.ok) { const j = await r.json(); ls.erp_od_user = j.displayName ? `${j.displayName} (${j.userPrincipalName || ''})` : (j.userPrincipalName || ''); } } catch { /* optional */ } }

  // ---------- sync logic ----------
  let busy = false, timer = null, pendingUpload = false;
  const classify = e => { if (e.status === 412) return; if (e.auth) setState('signin', e.message); else if (e.offline || !navigator.onLine) setState('offline', T('لا يوجد اتصال — التغييرات محفوظة على الجهاز وستُرفع لاحقاً', 'Offline — changes are saved on this device and will upload later')); else setState('error', e.message); };
  function conflict(meta) { st.conflict = { remote: meta }; setState('conflict', T('تعارض: تغيّرت البيانات على جهاز آخر', 'Conflict: the data changed on another device')); }

  async function reconcile(rec, hasUsers) {                                        // startup: choose between the local and OneDrive copy
    if (!connected()) return null;
    try {
      const meta = await remoteMeta();
      if (ls.erp_od_fresh) { ls.removeItem('erp_od_fresh'); whoAmI(); }
      if (!meta) { if (hasUsers) pendingUpload = true; return null; }
      const base = rec && rec.baseETag;
      if (!hasUsers && !(rec && rec.dirty)) return { bytes: await download(meta), etag: meta.eTag };      // empty device: take the OneDrive copy
      if (!base) { conflict(meta); return null; }                                  // both sides have data and were never linked
      if (base === meta.eTag) return null;
      if (rec && rec.dirty) { conflict(meta); return null; }
      return { bytes: await download(meta), etag: meta.eTag };
    } catch (e) { classify(e); return null; }
  }
  async function syncUp() {
    if (!connected() || busy || st.conflict) return;
    const S = Store(); if (!S.dirty && !(S.rec && S.rec.dirty) && !pendingUpload) { if (['dirty', 'syncing'].includes(st.state)) setState(st.last ? 'synced' : 'local'); return; }
    busy = true; setState('syncing');
    try {
      const v = S.ver || 0; await S.flushNow();
      const bytes = S.rec.bytes, item = await putFile('/' + FILE, bytes, S.rec.baseETag || null);
      S.rec = { ...S.rec, baseETag: item.eTag, dirty: (S.ver || 0) !== v }; S.dirty = S.rec.dirty; pendingUpload = false;
      await S.idbSet('db', S.rec); st.last = Date.now(); ls.erp_od_last = String(st.last); st.remoteNewer = false;
      setState(S.dirty ? 'dirty' : 'synced'); if (S.dirty) schedule();
      dailyBackup(bytes);
    } catch (e) {
      if (e.status === 412) { try { conflict(await remoteMeta()); } catch (x) { classify(x); } } else classify(e);
    } finally { busy = false; }
  }
  function schedule(ms = 2500) { if (!connected()) return; clearTimeout(timer); timer = setTimeout(syncUp, ms); }
  async function poll() {
    if (!connected() || busy || st.conflict || document.visibilityState !== 'visible') return;
    try {
      const meta = await remoteMeta(), S = Store(); if (!meta) return;
      if (S.rec && S.rec.baseETag && meta.eTag !== S.rec.baseETag) { if (S.dirty || S.rec.dirty) conflict(meta); else { st.remoteNewer = true; setState('update', T('يوجد تحديث من جهاز آخر', 'An update from another device is available')); } }
      else if (st.state === 'offline' || st.state === 'error') setState(S.dirty ? 'dirty' : 'synced');
    } catch (e) { classify(e); }
  }
  async function syncNow() { st.conflict = st.conflict; await poll(); await syncUp(); }
  async function pull() {                                                          // take the OneDrive copy (used by the "update available" banner and conflict choice)
    const meta = st.conflict ? st.conflict.remote : await remoteMeta(); if (!meta) throw new Error(T('لا يوجد ملف في OneDrive', 'No file in OneDrive'));
    const bytes = await download(meta); await Store().replaceDb(bytes, meta.eTag); location.reload();
  }
  async function resolve(which) {
    if (which === 'remote') return pull();
    const meta = await remoteMeta(), S = Store(); await S.flushNow();                // keep mine: overwrite OneDrive with the local copy
    const item = await putFile('/' + FILE, S.rec.bytes, meta ? meta.eTag : null);
    S.rec = { ...S.rec, baseETag: item.eTag, dirty: false }; S.dirty = false; await S.idbSet('db', S.rec);
    st.conflict = null; st.last = Date.now(); ls.erp_od_last = String(st.last); setState('synced'); dailyBackup(S.rec.bytes);
  }
  function start() {
    if (!connected()) { setState('local'); return; }
    setState(st.last ? 'synced' : 'local');
    if (st.conflict) return;
    const S = Store(); if (pendingUpload || S.dirty || (S.rec && S.rec.dirty)) schedule(800); else poll();
    setInterval(poll, 45000); document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') poll(); });
    addEventListener('online', () => { schedule(500); poll(); });
  }
  function notify() { if (connected() && !st.conflict && st.state !== 'syncing') setState('dirty'); }
  function disconnectKeepLocal() { signOut(); }

  window.ERPCloud = { cfg, st, onChange: f => { listeners.add(f); return () => listeners.delete(f); }, connected, signIn, signOut: disconnectKeepLocal, completeSignIn, reconcile, start, schedule, notify, syncNow, pull, resolve, redirectUri: BASE,
    user: () => ls.erp_od_user || '', lastError: () => ls.erp_od_err || '', clearError: () => ls.removeItem('erp_od_err') };
})();
