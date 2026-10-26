// Public quotation page: signature pad + accept / decline (no login; served with a strict CSP, so no inline script).
(function () {
  var box = document.getElementById('qa'); if (!box) return;
  var tok = box.getAttribute('data-token'), cv = document.getElementById('qa-sig'), cx = cv.getContext('2d'), drawn = false, down = false;
  cx.lineWidth = 2.2; cx.lineCap = 'round'; cx.strokeStyle = '#12283a';
  function pos(e) { var r = cv.getBoundingClientRect(), t = e.touches ? e.touches[0] : e; return [(t.clientX - r.left) * cv.width / r.width, (t.clientY - r.top) * cv.height / r.height]; }
  function start(e) { e.preventDefault(); down = true; var p = pos(e); cx.beginPath(); cx.moveTo(p[0], p[1]); }
  function move(e) { if (!down) return; e.preventDefault(); var p = pos(e); cx.lineTo(p[0], p[1]); cx.stroke(); drawn = true; }
  function end() { down = false; }
  ['mousedown', 'touchstart'].forEach(function (k) { cv.addEventListener(k, start, { passive: false }); });
  ['mousemove', 'touchmove'].forEach(function (k) { cv.addEventListener(k, move, { passive: false }); });
  ['mouseup', 'mouseleave', 'touchend'].forEach(function (k) { cv.addEventListener(k, end); });
  var msg = document.getElementById('qa-msg');
  function post(kind, body) {
    msg.textContent = '…';
    return fetch('/pub/q/' + tok + '/' + kind, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || r.statusText); return j; }); })
      .then(function () { location.reload(); }, function (e) { msg.textContent = e.message; });
  }
  document.getElementById('qa-clear').onclick = function () { cx.clearRect(0, 0, cv.width, cv.height); drawn = false; };
  document.getElementById('qa-accept').onclick = function () {
    var name = document.getElementById('qa-name').value.trim();
    if (name.length < 3) { msg.textContent = 'Please type your full name / يرجى كتابة الاسم الكامل'; return; }
    if (!drawn) { msg.textContent = 'Please sign in the box / يرجى التوقيع في المربع'; return; }
    post('accept', { name: name, signature: cv.toDataURL('image/png') });
  };
  document.getElementById('qa-reject').onclick = function () { post('reject', { comment: document.getElementById('qa-comment').value }); };
})();
