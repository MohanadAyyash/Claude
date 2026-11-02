// Builds public/guide/index.html — the searchable user guide (Arabic + English) — from docs/USER-GUIDE-AR.md and docs/USER-GUIDE-EN.md.
// Run after editing the guides:  node tools/build-guide.js      (no dependencies; the output is committed)
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..'), OUT = path.join(ROOT, 'public', 'guide', 'index.html');
const REPO = 'https://github.com/MohanadAyyash/Claude/blob/main/';
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const secId = text => { const m = /^(\d+)(?:\.(\d+))?/.exec(text.trim()); return m ? 's' + m[1] + (m[2] ? '-' + m[2] : '') : null; };

function inline(s) {
  s = esc(s);
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => `<img loading="lazy" alt="${alt}" src="${src.replace(/^(\.\.\/)?public\/guide\//, '')}">`);
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, href) => {
    if (href.startsWith('#')) { const id = secId(href.slice(1)); return `<a href="#${id || ''}" data-sec>${t}</a>`; }
    if (/^https?:/.test(href)) return `<a href="${href}" target="_blank" rel="noopener">${t}</a>`;
    if (/USER-GUIDE-(AR|EN)\.md$/.test(href)) return `<a href="#" data-lang="${/AR/.test(href) ? 'ar' : 'en'}">${t}</a>`;
    return `<a href="${REPO}${href.replace(/^\.\.\//, '')}" target="_blank" rel="noopener">${t}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
  return s;
}

function render(md, L) {
  const lines = md.replace(/<!--[\s\S]*?-->/g, '').replace(/<\/?div[^>]*>/g, '').split('\n');
  const out = []; let i = 0, para = [];
  const flush = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { flush(); i++; continue; }
    let m;
    if ((m = /^(#{1,3}) (.*)$/.exec(l))) {
      flush(); const lv = m[1].length, id = secId(m[2]);
      out.push({ h: lv, id, text: m[2] }); i++; continue;
    }
    if (/^---+$/.test(l.trim())) { flush(); i++; continue; }
    if (l.startsWith('>')) {
      flush(); const q = []; while (i < lines.length && lines[i].startsWith('>')) { q.push(lines[i].replace(/^>\s?/, '')); i++; }
      out.push(`<blockquote>${q.join('\n').split(/\n\s*\n/).map(p => `<p>${inline(p.replace(/\n/g, ' '))}</p>`).join('')}</blockquote>`); continue;
    }
    if (l.startsWith('|')) {
      flush(); const rows = []; while (i < lines.length && lines[i].startsWith('|')) { rows.push(lines[i]); i++; }
      const cells = r => r.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const head = cells(rows[0]), body = rows.slice(2).map(cells);
      out.push(`<div class="tw"><table><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`); continue;
    }
    if (/^\s*(\d+\.|-) /.test(l)) {
      flush();
      // nested lists by indentation
      const items = []; while (i < lines.length && (/^\s*(\d+\.|-) /.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) { items.push(lines[i]); i++; }
      const build = (arr, base) => {
        let html = '', open = null, k = 0;
        while (k < arr.length) {
          const ind = arr[k].match(/^\s*/)[0].length;
          if (ind > base) { const sub = []; while (k < arr.length && arr[k].match(/^\s*/)[0].length > base) { sub.push(arr[k]); k++; } html = html.replace(/<\/li>$/, '') + build(sub, sub[0].match(/^\s*/)[0].length) + '</li>'; continue; }
          const mm = /^\s*(\d+\.|-) (.*)$/.exec(arr[k]); const type = mm[1] === '-' ? 'ul' : 'ol';
          if (!open) { open = type; html += `<${type}${type === 'ol' && mm[1] !== '1.' ? ` start="${parseInt(mm[1])}"` : ''}>`; }
          html += `<li>${inline(mm[2])}</li>`; k++;
        }
        return html + (open ? `</${open}>` : '');
      };
      out.push(build(items, items[0].match(/^\s*/)[0].length)); continue;
    }
    if (/^\s*!\[/.test(l)) { flush(); out.push(`<figure>${inline(l.trim())}</figure>`); i++; continue; }
    para.push(l.trim()); i++;
  }
  flush();
  // group into searchable blocks: one per h2/h3 with the content up to the next heading
  let html = '', open = false, title = '';
  for (const x of out) {
    if (typeof x === 'object') {
      if (x.h === 1) { title = x.text; continue; }
      if (open) html += '</section>';
      const toc = /^(المحتويات|Contents)$/.test(x.text);
      html += `<section class="b h${x.h}"${x.id ? ` id="${L}-${x.id}"` : ''}${toc ? ' data-toc' : ''}><h${x.h}>${inline(x.text)}</h${x.h}>`; open = true;
    } else { if (!open) { html += '<section class="intro">'; open = true; } html += x; }
  }
  if (open) html += '</section>';
  return { title, html };
}

const ar = render(fs.readFileSync(path.join(ROOT, 'docs', 'USER-GUIDE-AR.md'), 'utf8'), 'ar');
const en = render(fs.readFileSync(path.join(ROOT, 'docs', 'USER-GUIDE-EN.md'), 'utf8'), 'en');

const page = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#1F3A5F">
<title>دليل الاستخدام — Trigon ERP</title>
<link rel="icon" href="../icon-192.png">
<link rel="stylesheet" href="../fonts/fonts.css">
<style>
:root{--blue:#1F3A5F;--paper:#F2F1EE;--stone:#D6D2C8;--grey:#8A8578;--red:#E11D2E}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:#1d2733;font:15px/1.75 'IBM Plex Sans Arabic','Archivo',Tahoma,Arial,sans-serif}
html[lang=en] body{font-family:'Archivo','IBM Plex Sans Arabic',Arial,sans-serif}
header{position:sticky;top:0;z-index:5;background:var(--blue);color:#fff;padding:10px 16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap;box-shadow:0 2px 8px rgba(0,0,0,.2)}
header .t{font-weight:700;font-size:17px;white-space:nowrap}
header .t small{display:block;font-weight:400;font-size:11px;color:#c8d3de;line-height:1.2}
.sbox{flex:1;min-width:220px;position:relative}
#q{width:100%;padding:10px 40px 10px 14px;border-radius:10px;border:0;font:inherit;font-size:16px;outline:3px solid transparent}
html[dir=rtl] #q{padding:10px 14px 10px 40px}
#q:focus{outline-color:#7fa3c7}
#clr{position:absolute;top:50%;transform:translateY(-50%);inset-inline-end:8px;border:0;background:#e5e2db;border-radius:50%;width:26px;height:26px;cursor:pointer;display:none;font-size:14px}
header button.l{background:transparent;color:#fff;border:1px solid #9fb3c6;border-radius:8px;padding:7px 12px;font:inherit;cursor:pointer}
#info{background:#fff;border-bottom:1px solid var(--stone);padding:8px 16px;font-size:13px;color:var(--grey);display:none}
#info b{color:var(--blue)}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
.chips a{background:#eef2f6;color:var(--blue);border-radius:14px;padding:2px 10px;text-decoration:none;font-size:12.5px}
.wrap{display:flex;gap:20px;max-width:1280px;margin:0 auto;padding:18px 16px 80px}
nav.toc{width:270px;flex:none;position:sticky;top:76px;align-self:flex-start;max-height:calc(100vh - 92px);overflow:auto;background:#fff;border:1px solid var(--stone);border-radius:12px;padding:10px 0;font-size:13.5px}
nav.toc a{display:block;padding:4px 14px;color:#2c3a48;text-decoration:none;line-height:1.5}
nav.toc a:hover,nav.toc a.on{background:#eef2f6;color:var(--blue)}
nav.toc a.h3{padding-inline-start:28px;font-size:12.5px;color:var(--grey)}
nav.toc a.dim{opacity:.3}
main{flex:1;min-width:0}
article{display:none}
article.on{display:block}
section.b{background:#fff;border:1px solid var(--stone);border-radius:12px;padding:6px 22px 14px;margin:0 0 14px;scroll-margin-top:84px}
section.h3{margin-top:-8px;border-top-left-radius:0;border-top-right-radius:0;border-top:0}
h1{color:var(--blue)}
h2{color:var(--blue);font-size:21px;margin:12px 0 6px}
h3{color:var(--blue);font-size:17px;margin:12px 0 4px}
p{margin:8px 0}
blockquote{margin:10px 0;border-inline-start:4px solid var(--blue);background:#f6f8fa;padding:4px 14px;border-radius:6px}
figure{margin:12px 0}
figure img{max-width:100%;border:1px solid var(--stone);border-radius:8px;display:block;cursor:zoom-in}
.tw{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:14px;margin:8px 0}
th,td{border:1px solid var(--stone);padding:6px 10px;text-align:start;vertical-align:top}
th{background:#f3f1ec}
code{background:#f1efe9;border-radius:4px;padding:1px 5px;font:13px 'IBM Plex Mono',monospace;direction:ltr;unicode-bidi:embed}
mark{background:#ffe066;color:inherit;border-radius:3px;padding:0 1px}
mark.cur{background:#ff9f1c}
.hide{display:none!important}
section.titleonly>*:not(h2){display:none}
section.intro{background:#fff;border:1px solid var(--stone);border-radius:12px;padding:6px 22px 10px;margin:0 0 14px}
body.searching section.intro{display:none}
section.titleonly{padding-bottom:4px}
#none{display:none;background:#fff;border:1px dashed var(--grey);border-radius:12px;padding:20px;text-align:center;color:var(--grey)}
#top{position:fixed;bottom:18px;inset-inline-end:18px;background:var(--blue);color:#fff;border:0;border-radius:50%;width:44px;height:44px;font-size:20px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3)}
#zoom{position:fixed;inset:0;background:rgba(10,20,30,.85);display:none;align-items:flex-start;justify-content:center;overflow:auto;z-index:20;padding:20px;cursor:zoom-out}
#zoom img{max-width:none;width:auto;max-height:none;border-radius:6px}
@media (max-width:900px){nav.toc{display:none}.wrap{padding:12px 8px 80px}section.b{padding:4px 14px 10px}header .t small{display:none}}
@media print{header,nav.toc,#top,#info{display:none}section.b{break-inside:avoid-page;border:0}}
</style>
</head>
<body>
<header>
  <div class="t" id="ttl">دليل الاستخدام<small>Trigon ERP</small></div>
  <div class="sbox"><input id="q" type="search" autocomplete="off" placeholder="ابحث: فاتورة، إضافة موظف، محتجزات، SIF…"><button id="clr" type="button" aria-label="clear">✕</button></div>
  <button class="l" id="lg" type="button">English</button>
</header>
<div id="info"></div>
<div class="wrap">
  <nav class="toc" id="toc"></nav>
  <main>
    <div id="none"></div>
    <article id="ar" lang="ar" dir="rtl">${ar.html}</article>
    <article id="en" lang="en" dir="ltr">${en.html}</article>
  </main>
</div>
<button id="top" type="button" aria-label="top">↑</button>
<div id="zoom"></div>
<script>
(function () {
  var $ = function (s, r) { return (r || document).querySelector(s); }, $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var T = {
    ar: { title: 'دليل الاستخدام', ph: 'ابحث: فاتورة، إضافة موظف، محتجزات، SIF…', other: 'English', res: function (n) { return n + ' نتيجة'; }, none: 'لا توجد نتائج لـ', near: 'لا يوجد قسم يحتوي كل الكلمات — هذه أقرب النتائج', tip: 'جرّب كلمة أقصر أو مرادفاً (مثل «فاتور» بدل «فواتير»).', alsoOther: 'نتائج باللغة الأخرى:', clear: 'مسح البحث', jump: 'انتقل إلى:' },
    en: { title: 'User guide', ph: 'Search: invoice, add employee, retention, SIF…', other: 'عربي', res: function (n) { return n + (n === 1 ? ' result' : ' results'); }, none: 'No results for', near: 'No section has all the words — closest results', tip: 'Try a shorter word or a synonym.', alsoOther: 'Results in the other language:', clear: 'Clear search', jump: 'Jump to:' } };
  var lang = 'ar';
  try { var q0 = new URLSearchParams(location.search); lang = q0.get('lang') || localStorage.lang || 'ar'; } catch (e) {}
  if (lang !== 'en') lang = 'ar';
  // ---- Arabic-aware normalisation: no diacritics/tatweel, one form of alef/yaa/taa marbuta/hamza, western digits
  function norm(s) {
    return String(s).toLowerCase().replace(/[\\u064B-\\u065F\\u0670\\u0640]/g, '').replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/[ىئ]/g, 'ي').replace(/ؤ/g, 'و')
      .replace(/[٠-٩]/g, function (d) { return String(d.charCodeAt(0) - 1632); }).replace(/[۰-۹]/g, function (d) { return String(d.charCodeAt(0) - 1776); });
  }
  var CLS = { 'ا': '[اأإآٱ]', 'ه': '[هة]', 'ي': '[يىئ]', 'و': '[وؤ]' };
  function pattern(word) {   // a regex for the word that tolerates the same variants and diacritics in the text
    var out = '';
    for (var i = 0; i < word.length; i++) {
      var c = word[i], d = /[0-9]/.test(c) ? '[' + c + String.fromCharCode(1632 + +c) + ']' : null;
      out += (d || CLS[c] || c.replace(/[.*+?^\${}()|[\\]\\\\\\/]/g, '\\\\$&')) + (i < word.length - 1 ? '[\\u064B-\\u065F\\u0670\\u0640]*' : '');
    }
    return out;
  }
  var data = {};
  ['ar', 'en'].forEach(function (l) {
    var art = $('#' + l), blocks = $$('section.b', art), parent = null;
    blocks.forEach(function (b) {
      if (b.classList.contains('h2')) parent = b; else b._parent = parent;
      var alt = $$('img', b).map(function (i) { return i.alt; }).join(' ');
      b._text = norm(b.textContent + ' ' + alt); b._head = norm($('h2,h3', b).textContent);
    });
    data[l] = blocks.filter(function (b) { return !b.hasAttribute('data-toc'); });
  });
  function buildToc() {
    $('#toc').innerHTML = data[lang].map(function (b) { var h = $('h2,h3', b); return '<a href="#' + b.id + '" class="' + (b.classList.contains('h3') ? 'h3' : '') + '" data-for="' + b.id + '">' + h.textContent + '</a>'; }).join('');
  }
  function setLang(l, keepQuery) {
    lang = l; try { localStorage.lang = l; } catch (e) {}
    document.documentElement.lang = l; document.documentElement.dir = l === 'ar' ? 'rtl' : 'ltr';
    $('#ar').classList.toggle('on', l === 'ar'); $('#en').classList.toggle('on', l === 'en');
    $('#ttl').innerHTML = T[l].title + '<small>Trigon ERP</small>'; $('#q').placeholder = T[l].ph; $('#lg').textContent = T[l].other; $('#clr').title = T[l].clear;
    document.title = T[l].title + ' — Trigon ERP';
    buildToc(); search(keepQuery ? $('#q').value : '');
  }
  // ---- highlighting
  function unmark(root) { $$('mark', root).forEach(function (m) { var t = document.createTextNode(m.textContent); m.parentNode.replaceChild(t, m); t.parentNode.normalize(); }); }
  function mark(root, re) {
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null), nodes = [], n;
    while ((n = w.nextNode())) if (n.nodeValue.trim() && !/^(SCRIPT|STYLE)$/.test(n.parentNode.nodeName)) nodes.push(n);
    nodes.forEach(function (node) {
      var s = node.nodeValue, m, last = 0, frag = document.createDocumentFragment(), hit = false; re.lastIndex = 0;
      while ((m = re.exec(s))) { if (!m[0]) { re.lastIndex++; continue; } hit = true; frag.appendChild(document.createTextNode(s.slice(last, m.index))); var mk = document.createElement('mark'); mk.textContent = m[0]; frag.appendChild(mk); last = m.index + m[0].length; }
      if (hit) { frag.appendChild(document.createTextNode(s.slice(last))); node.parentNode.replaceChild(frag, node); }
    });
  }
  function score(b, words) { var s = 0; words.forEach(function (w) { if (b._head.indexOf(w) >= 0) s += 5; var i = -1, c = 0; while ((i = b._text.indexOf(w, i + 1)) >= 0 && c < 20) c++; s += c; }); return s; }
  function goSec(id) { var el = document.getElementById(lang + '-' + id) || document.getElementById(id); if (!el) return; if (el.classList.contains('hide')) { $('#q').value = ''; search(''); } el.scrollIntoView(); }
  var timer;
  function search(raw) {
    var art = $('#' + lang); unmark(art);
    var words = norm(raw).split(/\\s+/).filter(function (w) { return w.length > 0; });
    $('#clr').style.display = raw ? 'block' : 'none';
    try { history.replaceState(null, '', raw ? '?q=' + encodeURIComponent(raw) + '&lang=' + lang : location.pathname + '?lang=' + lang + location.hash); } catch (e) {}
    var all = $$('section.b', art);
    document.body.classList.toggle('searching', words.length > 0);
    if (!words.length) {
      all.forEach(function (b) { b.classList.remove('hide', 'titleonly'); }); $('#info').style.display = 'none'; $('#none').style.display = 'none';
      $$('#toc a').forEach(function (a) { a.classList.remove('dim'); }); return;
    }
    var hits = data[lang].filter(function (b) { return words.every(function (w) { return b._text.indexOf(w) >= 0; }); }), near = false;
    if (!hits.length) { hits = data[lang].filter(function (b) { return words.some(function (w) { return b._text.indexOf(w) >= 0; }); }); near = hits.length > 0; }
    var show = new Set(hits);
    all.forEach(function (b) { b.classList.toggle('hide', !show.has(b)); b.classList.remove('titleonly'); });
    hits.forEach(function (b) { if (b._parent && !show.has(b._parent)) { b._parent.classList.remove('hide'); b._parent.classList.add('titleonly'); } });
    $$('#toc a').forEach(function (a) { var b = document.getElementById(a.getAttribute('data-for')); a.classList.toggle('dim', !b || b.classList.contains('hide')); });
    var re = new RegExp(words.map(pattern).join('|'), 'gi');
    hits.forEach(function (b) { mark(b, re); });
    // summary: count, best sections to jump to, and the other language when it has hits and this one does not
    var best = hits.slice().sort(function (a, b) { return score(b, words) - score(a, words); }).slice(0, 6);
    var info = $('#info'), t = T[lang];
    if (hits.length) {
      info.innerHTML = (near ? t.near + ' · ' : '') + '<b>' + t.res(hits.length) + '</b><div class="chips">' + best.map(function (b) { return '<a href="#' + b.id + '">' + $('h2,h3', b).textContent + '</a>'; }).join('') + '</div>';
      $('#none').style.display = 'none';
    } else {
      var other = lang === 'ar' ? 'en' : 'ar', oh = data[other].filter(function (b) { return words.every(function (w) { return b._text.indexOf(w) >= 0; }); });
      info.innerHTML = '';
      $('#none').innerHTML = t.none + ' «' + raw.replace(/[<>&]/g, '') + '». ' + t.tip + (oh.length ? '<br><br>' + t.alsoOther + ' <a href="#" id="go-other">' + T[other].res(oh.length) + '</a>' : '');
      $('#none').style.display = 'block';
      if ($('#go-other')) $('#go-other').onclick = function (e) { e.preventDefault(); setLang(other, true); };
    }
    info.style.display = 'block';
  }
  // ---- events
  $('#q').addEventListener('input', function () {
    clearTimeout(timer); var v = this.value;
    if (/[\\u0600-\\u06FF]/.test(v) && lang === 'en' && data.en.every(function (b) { return b._text.indexOf(norm(v.trim().split(/\\s+/)[0])) < 0; })) { timer = setTimeout(function () { setLang('ar', true); }, 150); return; }
    timer = setTimeout(function () { search(v); }, 140);
  });
  $('#q').addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { this.value = ''; search(''); }
    if (e.key === 'Enter') { var m = $('#' + lang + ' mark'); if (m) m.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  });
  $('#clr').onclick = function () { $('#q').value = ''; search(''); $('#q').focus(); };
  $('#lg').onclick = function () { setLang(lang === 'ar' ? 'en' : 'ar', true); };
  document.addEventListener('keydown', function (e) { if (e.key === '/' && document.activeElement !== $('#q')) { e.preventDefault(); $('#q').focus(); } });
  document.addEventListener('click', function (e) {
    var a = e.target.closest('a[data-lang]'); if (a) { e.preventDefault(); setLang(a.getAttribute('data-lang'), true); return; }
    var sl = e.target.closest('a[data-sec]'); if (sl) { e.preventDefault(); goSec(sl.getAttribute('href').slice(1)); return; }
    var img = e.target.closest('figure img'); if (img) { $('#zoom').innerHTML = '<img src="' + img.src + '" alt="">'; $('#zoom').style.display = 'flex'; return; }
    if (e.target.closest('#zoom')) $('#zoom').style.display = 'none';
  });
  $('#top').onclick = function () { scrollTo({ top: 0, behavior: 'smooth' }); };
  // ---- start: language, ?q= search, #section
  var qs = new URLSearchParams(location.search), q = qs.get('q') || '';
  $('#q').value = q; setLang(lang, true);
  if (location.hash.length > 1) setTimeout(function () { goSec(location.hash.slice(1).replace(/^(ar|en)-/, '')); }, 50);
  else if (!q && matchMedia('(min-width:900px)').matches) $('#q').focus();
})();
</script>
</body>
</html>
`;
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, page);
const count = (h, re) => (h.match(re) || []).length;
console.log(`guide: ${OUT} — ${count(ar.html, /<section/g)} AR sections, ${count(en.html, /<section/g)} EN sections, ${count(ar.html + en.html, /<img /g)} images`);
