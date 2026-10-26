// Phone app layer: service worker (instant start, update prompt), "install app" button / iPhone hint,
// notifications bell + page (in-app inbox and push to this device).
const ALLR = ['admin', 'accountant', 'manager', 'hr', 'viewer', 'employee'];
let installEvt = null, swReg = null;
const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent), standaloneApp = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const pushOk = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; if ($('#main')) onShell(); });
window.addEventListener('appinstalled', () => { installEvt = null; toast(tr('تم تثبيت التطبيق', 'App installed')); });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then(reg => {
    swReg = reg;
    const offer = w => {
      if (!w || !navigator.serviceWorker.controller) return;                                 // first install: nothing to refresh
      const bar = document.createElement('div'); bar.className = 'toast'; bar.style.cursor = 'pointer';
      bar.textContent = tr('نسخة جديدة من النظام متوفرة — اضغط للتحديث', 'A new version is available — tap to update');
      bar.onclick = () => w.postMessage('update'); document.body.appendChild(bar);
    };
    if (reg.waiting) offer(reg.waiting);
    reg.addEventListener('updatefound', () => { const w = reg.installing; w && w.addEventListener('statechange', () => { if (w.state === 'installed') offer(w); }); });
  }).catch(() => {});
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloading) { reloading = true; location.reload(); } });
  navigator.serviceWorker.addEventListener('message', e => { if (e.data && e.data.go != null) go(e.data.go || landing()); });
}

// called by shell() after every redraw: bell count, install button, iPhone hint
window.onShell = async () => {
  const foot = $('.side .foot');
  if (foot && installEvt && !$('#inst')) {
    const b = document.createElement('button'); b.className = 'btn'; b.id = 'inst'; b.textContent = '📲 ' + tr('تثبيت التطبيق', 'Install app');
    b.onclick = async () => { installEvt.prompt(); await installEvt.userChoice.catch(() => {}); installEvt = null; b.remove(); };
    foot.prepend(b);
  }
  if (isIos && !standaloneApp && !localStorage.iosHint && $('#main') && !$('#ioshint')) {
    const d = document.createElement('div'); d.className = 'card'; d.id = 'ioshint';
    d.innerHTML = `<b>📲 ${tr('ثبّت التطبيق على الآيفون', 'Install the app on iPhone')}</b><p class="muted" style="margin:6px 0">${tr('من Safari اضغط زر المشاركة ⬆︎ ثم «إضافة إلى الشاشة الرئيسية». بعدها يفتح كتطبيق وتصلك الإشعارات.', 'In Safari tap Share ⬆︎ then “Add to Home Screen”. It then opens like an app and can receive notifications.')}</p><button class="btn sec sm">${tr('حسناً', 'OK')}</button>`;
    d.querySelector('button').onclick = () => { localStorage.iosHint = '1'; d.remove(); };
    $('#main').before(d);
  }
  try {
    const n = (await api('GET', 'notifications?count=1')).unread;
    const link = $('.side a[data-r="notifications"]'); if (link) link.innerHTML = `🔔 ${tr('الإشعارات', 'Notifications')}${n ? ` <span class="tag overdue">${n}</span>` : ''}`;
    let bell = $('#bell');
    if (!bell && $('.topbar')) { bell = document.createElement('button'); bell.id = 'bell'; bell.type = 'button'; bell.style.marginInlineStart = 'auto'; bell.onclick = () => go('notifications'); $('.topbar').append(bell); }
    if (bell) bell.innerHTML = `🔔${n ? `<sup style="font-size:12px">${n}</sup>` : ''}`;
    if (navigator.setAppBadge) (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
  } catch { /* offline */ }
};

const b64ToBytes = s => { const p = '='.repeat((4 - s.length % 4) % 4), b = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(b, c => c.charCodeAt(0)); };
async function pushState() {
  if (!pushOk() || !swReg) return { supported: false };
  const sub = await swReg.pushManager.getSubscription();
  return { supported: true, permission: Notification.permission, subscribed: !!sub, sub };
}
async function enablePush() {
  const k = await api('GET', 'push/key'); if (!k.enabled) throw new Error(tr('الإشعارات غير متاحة في هذه النسخة', 'Notifications are not available in this edition'));
  if (await Notification.requestPermission() !== 'granted') throw new Error(tr('لم يُسمح بالإشعارات — فعّلها من إعدادات المتصفح', 'Notifications were not allowed — enable them in the browser settings'));
  const sub = await swReg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(k.publicKey) });
  await api('POST', 'push/subscribe', { subscription: sub.toJSON(), device: `${navigator.platform || ''} ${isIos ? 'iOS' : ''}`.trim() });
}
async function disablePush() {
  const s = await pushState(); if (!s.sub) return;
  await api('DELETE', 'push/subscribe', { endpoint: s.sub.endpoint }).catch(() => {}); await s.sub.unsubscribe();
}

PAGES.notifications = async () => {
  const [d, ps] = await Promise.all([api('GET', 'notifications'), pushState()]);
  const device = !ps.supported
    ? `<p class="muted">${isIos && !standaloneApp ? tr('على الآيفون تعمل الإشعارات بعد تثبيت التطبيق على الشاشة الرئيسية (iOS 16.4 أو أحدث).', 'On iPhone, notifications work once the app is added to the Home Screen (iOS 16.4+).') : tr('هذا المتصفح لا يدعم الإشعارات.', 'This browser does not support notifications.')}</p>`
    : ps.subscribed ? `<p class="ok">✔ ${tr('الإشعارات مفعّلة على هذا الجهاز', 'Notifications are on for this device')}</p><div class="bar"><button class="btn sec" id="ptest">${tr('إرسال تجربة', 'Send a test')}</button><button class="btn sec" id="poff">${tr('إيقاف على هذا الجهاز', 'Turn off on this device')}</button></div>`
    : `<p class="muted">${tr('فعّلها لتصلك الاعتمادات والقرارات والتنبيهات على هاتفك حتى والتطبيق مغلق.', 'Turn them on to get approvals, decisions and alerts on your phone even when the app is closed.')}</p><button class="btn" id="pon">🔔 ${tr('تفعيل الإشعارات على هذا الجهاز', 'Turn on notifications on this device')}</button>`;
  main(`<div class="bar"><h1>${tr('الإشعارات', 'Notifications')}</h1><span class="sp"></span>${d.unread ? `<button class="btn sec sm" id="rd">${tr('تعليم الكل كمقروء', 'Mark all read')}</button>` : ''}</div>
  <div class="card"><h2>${tr('هذا الجهاز', 'This device')}</h2>${device}</div>
  <div class="card">${d.items.map(n => `<div style="padding:8px 0;border-bottom:1px solid #e6e2d8;${n.read ? 'opacity:.6' : ''}${n.url ? ';cursor:pointer' : ''}" ${n.url ? `data-go="${esc(n.url.replace(/^#/, ''))}"` : ''}><b>${esc(n.title)}</b><div>${esc(n.body)}</div><div class="muted" style="font-size:12px">${esc(n.ts)}</div></div>`).join('') || `<p class="muted">${tr('لا توجد إشعارات', 'No notifications')}</p>`}</div>`);
  document.querySelectorAll('[data-go]').forEach(x => x.onclick = () => go(x.dataset.go));
  if ($('#rd')) $('#rd').onclick = guard(async () => { await api('POST', 'notifications/read'); render(); onShell(); });
  if ($('#pon')) $('#pon').onclick = guard(async () => { await enablePush(); toast(tr('تم التفعيل', 'Turned on')); render(); });
  if ($('#poff')) $('#poff').onclick = guard(async () => { await disablePush(); render(); });
  if ($('#ptest')) $('#ptest').onclick = guard(async () => { const r = await api('POST', 'push/test'); toast(r.sent ? tr('أُرسل — انظر إلى الهاتف', 'Sent — check the phone') : tr('لم يصل لأي جهاز', 'Not delivered to any device')); });
};
