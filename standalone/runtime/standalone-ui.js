// Standalone edition — UI additions (loaded after the application scripts, before boot): sync page, status chip, conflict dialog, mailto fallback.
(function () {
  'use strict';
  const C = window.ERPCloud, S = window.ERPStore;
  const tx = (ar, en) => (typeof tr === 'function' ? tr(ar, en) : en);
  const LBL = { local: ['محلي فقط (غير مرتبط بـ OneDrive)', 'Local only (OneDrive not linked)', '#8A8578'], synced: ['متزامن مع OneDrive', 'Synced with OneDrive', '#1a7f4b'], dirty: ['تعديلات بانتظار الرفع', 'Changes waiting to upload', '#b26b00'],
    syncing: ['جاري الرفع…', 'Uploading…', '#b26b00'], offline: ['بدون اتصال', 'Offline', '#b26b00'], signin: ['سجّل الدخول لـ OneDrive', 'Sign in to OneDrive', '#b73a3a'], conflict: ['تعارض في البيانات', 'Data conflict', '#b73a3a'],
    update: ['تحديث متاح من جهاز آخر', 'Update available from another device', '#b26b00'], error: ['خطأ في المزامنة', 'Sync error', '#b73a3a'] };

  // --- navigation entry + page
  const at = NAV.findIndex(n => n[0] === 'settings');
  NAV.splice(at < 0 ? NAV.length : at, 0, ['sync', 'البيانات والمزامنة', 'Data & sync', ['admin', 'accountant', 'manager', 'hr', 'viewer']]);

  // --- status chip (sidebar + top bar) and floating banner
  const chipHtml = () => { const l = LBL[C.st.state] || LBL.local; return `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${l[2]};margin-inline-end:6px"></span>${tx(l[0], l[1])}`; };
  function paint() {
    document.querySelectorAll('.erp-chip').forEach(e => (e.innerHTML = chipHtml()));
    let b = document.getElementById('erp-banner'); const need = ['update', 'conflict', 'signin'].includes(C.st.state);
    if (!need) { if (b) b.remove(); return; }
    if (!b) { b = document.createElement('div'); b.id = 'erp-banner'; b.style.cssText = 'position:fixed;z-index:60;inset-inline:12px;bottom:calc(12px + env(safe-area-inset-bottom));background:#1F3A5F;color:#fff;border-radius:12px;padding:12px 14px;display:flex;gap:10px;align-items:center;box-shadow:0 6px 24px rgba(0,0,0,.25);font:14px Arial'; document.body.appendChild(b); }
    const act = { update: [tx('تحديث الآن', 'Update now'), () => C.pull()], conflict: [tx('حل التعارض', 'Resolve'), conflictDialog], signin: [tx('تسجيل الدخول', 'Sign in'), () => C.signIn()] }[C.st.state];
    b.innerHTML = `<span style="flex:1">${C.st.message || tx(...LBL[C.st.state])}</span><button style="padding:8px 12px;border:0;border-radius:8px;background:#fff;color:#1F3A5F;font-weight:700">${act[0]}</button>`;
    b.querySelector('button').onclick = act[1];
  }
  const origShell = window.shell;
  window.shell = function () {
    origShell();
    const foot = document.querySelector('.side .foot'); if (foot) foot.insertAdjacentHTML('beforebegin', `<a class="erp-chip-wrap" style="font-size:12px;cursor:pointer"><span class="erp-chip"></span></a>`);
    const tb = document.querySelector('.topbar'); if (tb) tb.insertAdjacentHTML('beforeend', `<span class="erp-chip" style="margin-inline-start:auto;font-size:12px;color:#D6D2C8"></span>`);
    document.querySelectorAll('.erp-chip-wrap').forEach(e => (e.onclick = () => { location.hash = 'sync'; }));
    paint();
  };
  C.onChange(paint);

  // --- conflict dialog
  function conflictDialog() {
    const m = document.createElement('div'); m.className = 'overlay'; m.style.zIndex = 90;
    m.innerHTML = `<div class="modal"><h2>${tx('تعارض في البيانات', 'Data conflict')}</h2>
      <p>${tx('تغيّرت بيانات OneDrive من جهاز آخر وأنت عندك تعديلات لم تُرفع. اختر ما تريد الاحتفاظ به:', 'The OneDrive data changed on another device and you have changes that were not uploaded. Choose what to keep:')}</p>
      <div class="acts" style="flex-direction:column;align-items:stretch">
       <button class="btn" id="c-remote">${tx('تحميل نسخة OneDrive (تجاهل تعديلاتي هنا)', 'Use the OneDrive copy (discard my changes here)')}</button>
       <button class="btn sec" id="c-local">${tx('رفع نسختي (استبدال ما في OneDrive)', 'Upload my copy (replace OneDrive)')}</button>
       <button class="btn sec" id="c-file">${tx('حفظ نسختي كملف أولاً (للاحتياط)', 'Save my copy as a file first (safety)')}</button>
       <button class="btn sec" id="c-x">${tx('لاحقاً', 'Later')}</button></div></div>`;
    document.body.appendChild(m);
    const go = f => async () => { try { await f(); m.remove(); } catch (e) { alert(e.message); } };
    m.querySelector('#c-remote').onclick = go(() => (confirm(tx('سيُستبدل ما على هذا الجهاز بنسخة OneDrive. متابعة؟', 'This device will be replaced by the OneDrive copy. Continue?')) ? C.resolve('remote') : Promise.reject(new Error('cancelled'))));
    m.querySelector('#c-local').onclick = go(() => (confirm(tx('سيُستبدل ما في OneDrive بنسختك. متابعة؟', 'OneDrive will be replaced by your copy. Continue?')) ? C.resolve('local') : Promise.reject(new Error('cancelled'))));
    m.querySelector('#c-file').onclick = async () => { await S.flushNow(); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([S.rec.bytes])); a.download = `trigon-erp-my-copy-${new Date().toISOString().slice(0, 10)}.sqlite`; a.click(); };
    m.querySelector('#c-x').onclick = () => m.remove();
  }
  window.erpConflictDialog = conflictDialog;

  // --- e-mail: no SMTP in the browser, so open the phone's mail app instead
  window.standaloneMail = function (to, subject, body) { location.href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`; };

  // --- the "Data & sync" page
  PAGES.sync = async () => {
    const st = C.st, l = LBL[st.state] || LBL.local, admin = ME.role === 'admin', last = st.last ? new Date(st.last).toLocaleString(localStorage.lang === 'ar' ? 'ar-AE' : 'en-GB') : '—';
    const err = C.lastError();
    main(`<h1>${tx('البيانات والمزامنة', 'Data & sync')}</h1>
    <div class="card"><h2>${tx('أين تُحفظ بياناتي؟', 'Where is my data stored?')}</h2>
      <p>${tx('هذه النسخة المستقلة تعمل بالكامل داخل المتصفح: قاعدة البيانات على هذا الجهاز، ويمكن ربطها بملف في OneDrive الخاص بك ليظهر نفس المحتوى على أجهزتك. لا يوجد خادم، والتطبيق لا يرسل بياناتك لأي طرف سوى حسابك في OneDrive.', 'This standalone edition runs entirely in the browser: the database lives on this device and can be linked to a file in your own OneDrive so your devices show the same data. There is no server, and nothing is sent anywhere except your OneDrive account.')}</p>
      <ul class="muted"><li>${tx('استخدم جهازاً واحداً في كل مرة؛ عند التعارض يطلب النظام منك الاختيار.', 'Use one device at a time; on a conflict the system asks you to choose.')}</li>
      <li>${tx('بدون ربط OneDrive تبقى بياناتك على هذا الجهاز فقط وقد تضيع إن مُسحت بيانات المتصفح — حمّل نسخة احتياطية بانتظام.', 'Without OneDrive your data exists only on this device and can be lost if browser data is cleared — download backups regularly.')}</li>
      <li>${tx('الإيميل يُفتح عبر تطبيق البريد في جهازك، وملفات PDF عبر الطباعة ← حفظ PDF.', 'E-mail opens your device mail app; PDFs via Print → Save as PDF.')}</li></ul></div>
    <div class="card"><h2>${tx('الحالة', 'Status')}</h2><p><b>${chipHtml()}</b></p>
      ${C.connected() ? `<p class="muted">${tx('الحساب', 'Account')}: ${esc(C.user() || '—')}<br>${tx('آخر مزامنة', 'Last sync')}: ${esc(last)}<br>${tx('الملف', 'File')}: OneDrive/Trigon-ERP/erp.sqlite</p>` : ''}
      ${st.message ? `<p class="muted">${esc(st.message)}</p>` : ''}${err ? `<p class="err">${esc(err)}</p>` : ''}
      ${C.connected() ? `<div class="bar"><button class="btn" id="sn">${tx('مزامنة الآن', 'Sync now')}</button>${st.conflict ? `<button class="btn sec" id="rc">${tx('حل التعارض', 'Resolve conflict')}</button>` : ''}<button class="btn sec" id="pl">${tx('تحميل نسخة OneDrive (استبدال ما هنا)', 'Load the OneDrive copy (replace this device)')}</button>${admin ? `<button class="btn sec" id="so">${tx('فصل OneDrive', 'Disconnect OneDrive')}</button>` : ''}</div>` : ''}</div>
    ${!C.connected() && admin ? `<div class="card"><h2>${tx('ربط OneDrive (مرة واحدة)', 'Link OneDrive (once)')}</h2>
      <p class="muted">${tx('تحتاج تسجيل تطبيق مجاني في Microsoft Entra (خطوات مفصّلة في دليل STANDALONE.md). ثم الصق معرّف التطبيق (Application / Client ID) هنا.', 'You need a free app registration in Microsoft Entra (detailed steps in STANDALONE.md). Then paste the Application (client) ID here.')}</p>
      <div class="f"><label>Redirect URI (${tx('انسخه في تسجيل التطبيق كنوع Single-page application', 'add it to the app registration as a Single-page application')})</label><input id="ru" dir="ltr" readonly value="${esc(C.redirectUri)}"></div>
      <div class="f"><label>${tx('معرّف التطبيق (Client ID)', 'Application (client) ID')}</label><input id="cid" dir="ltr" value="${esc(C.cfg.client)}" placeholder="00000000-0000-0000-0000-000000000000"></div>
      <button class="btn" id="si">${tx('تسجيل الدخول بحساب مايكروسوفت', 'Sign in with Microsoft')}</button></div>` : ''}
    <div class="card"><h2>${tx('نسخة احتياطية يدوية', 'Manual backup')}</h2>
      <div class="bar"><a class="btn sec" href="/api/backup">${tx('تحميل ملف قاعدة البيانات', 'Download database file')}</a>
      ${admin ? `<label class="btn sec" style="cursor:pointer">${tx('استرجاع من ملف…', 'Restore from file…')}<input type="file" id="rf" accept=".sqlite,.db" style="display:none"></label>` : ''}</div>
      <p class="muted">${tx('احفظ الملف خارج الجهاز (OneDrive / ملفات). الاسترجاع يستبدل كل البيانات الحالية.', 'Keep the file outside the device (OneDrive / Files). Restoring replaces all current data.')}</p></div>`);
    const run = f => async () => { try { await f(); } catch (e) { toast(e.message); } };
    if ($('#sn')) $('#sn').onclick = run(async () => { await C.syncNow(); render(); });
    if ($('#rc')) $('#rc').onclick = conflictDialog;
    if ($('#pl')) $('#pl').onclick = run(async () => { if (confirm(tx('سيُستبدل ما على هذا الجهاز بنسخة OneDrive (تُفقد التعديلات غير المرفوعة). متابعة؟', 'This device will be replaced by the OneDrive copy (unuploaded changes are lost). Continue?'))) await C.pull(); });
    if ($('#so')) $('#so').onclick = run(async () => { if (confirm(tx('سيُفصل OneDrive وتبقى بياناتك على هذا الجهاز. متابعة؟', 'OneDrive will be disconnected; your data stays on this device. Continue?'))) { C.signOut(); render(); } });
    if ($('#si')) $('#si').onclick = run(async () => { C.cfg.client = $('#cid').value; await C.signIn(); });
    if ($('#rf')) $('#rf').onchange = run(async e => {
      const f = e.target.files[0]; if (!f) return; const bytes = new Uint8Array(await f.arrayBuffer());
      let ok = false; try { const d = new S.SQL.Database(bytes); ok = d.exec("SELECT COUNT(*) FROM settings").length > 0; d.close(); } catch { ok = false; }
      if (!ok) throw new Error(tx('الملف ليس نسخة صالحة من النظام', 'This is not a valid system backup'));
      if (!confirm(tx('سيُستبدل كل ما على هذا الجهاز بمحتوى الملف. متابعة؟', 'Everything on this device will be replaced by the file. Continue?'))) return;
      await S.replaceDb(bytes, null); location.reload();
    });
  };
  C.onChange(() => { if (location.hash.slice(1).split('/')[0] === 'sync') { const m = document.getElementById('main'); if (m && !document.activeElement.matches('input')) render(); } });
})();
