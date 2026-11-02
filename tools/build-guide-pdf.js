// Prints the user guide to PDF (Arabic and English) from public/guide/index.html:  node tools/build-guide-pdf.js
// Output: docs/Trigon-ERP-User-Guide-AR.pdf and docs/Trigon-ERP-User-Guide-EN.pdf. Needs Playwright with Chromium.
// Run `npm run build:guide` first if the Markdown guides changed.
const path = require('path'), fs = require('fs'), { pathToFileURL } = require('url');
let chromium; try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('@playwright/test')); }
const ROOT = path.join(__dirname, '..');
const page = pathToFileURL(path.join(ROOT, 'public', 'guide', 'index.html')).href;
const logo = 'data:image/png;base64,' + fs.readFileSync(path.join(ROOT, 'brand', 'logo.png')).toString('base64');
const T = {
  ar: { title: 'دليل الاستخدام', sub: 'نظام تريجون لإدارة المقاولات — Trigon ERP', note: 'شرح خطوة بخطوة لكل شاشات النظام، مع صور مشروحة.', ver: 'الإصدار', page: 'صفحة', of: 'من', file: 'Trigon-ERP-User-Guide-AR.pdf', hint: 'في نسخة النظام يوجد بحث بالكلمات: القائمة الجانبية ← 📘 دليل الاستخدام.' },
  en: { title: 'User Guide', sub: 'Trigon Civil Contracting ERP', note: 'Step-by-step instructions for every screen, with annotated screenshots.', ver: 'Version', page: 'Page', of: 'of', file: 'Trigon-ERP-User-Guide-EN.pdf', hint: 'Inside the system the guide is searchable: side menu → 📘 User guide.' } };

(async () => {
  const b = await chromium.launch();
  for (const lang of ['ar', 'en']) {
    const t = T[lang], p = await b.newPage();
    await p.goto(`${page}?lang=${lang}`); await p.waitForLoadState('load');
    const date = new Date().toISOString().slice(0, 10);
    await p.evaluate(({ lang, t, logo, date }) => {
      const art = document.getElementById(lang);
      document.querySelectorAll('header,#info,#toc,#top,#none,#zoom,article:not(#' + lang + ')').forEach(e => e.remove());
      // images: load all now (they are lazy on the web page)
      art.querySelectorAll('img').forEach(i => { i.loading = 'eager'; i.src = i.src; });
      // contents links → anchors inside this language
      art.querySelectorAll('a[data-sec]').forEach(a => a.setAttribute('href', '#' + lang + '-' + a.getAttribute('href').slice(1)));
      art.querySelectorAll('a[data-lang]').forEach(a => (a.closest('p') || a).remove());
      // keep each "📷 caption" with its picture and numbered explanation
      art.querySelectorAll('p').forEach(p => { if (/^📷/.test(p.textContent.trim())) p.classList.add('cap'); });
      const cover = document.createElement('div'); cover.className = 'cover';
      cover.innerHTML = `<img src="${logo}" alt=""><h1>${t.title}</h1><div class="sub">${t.sub}</div><div class="note">${t.note}</div><div class="hint">${t.hint}</div><div class="ver">${t.ver} ${date}</div>`;
      art.prepend(cover); const intro = art.querySelector('section.intro'); if (intro) { intro.classList.add('onc'); cover.appendChild(intro); }
      const st = document.createElement('style');
      st.textContent = `
        body{background:#fff;font-size:11pt;line-height:1.7}
        .wrap{display:block;max-width:none;padding:0;margin:0}
        article{display:block!important}
        .cover{height:250mm;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;break-after:page}
        .cover img{width:95mm;margin-bottom:18mm}
        .cover section.onc{margin-top:14mm;text-align:start;font-size:10pt;max-width:165mm}
        .cover section.onc blockquote{border-inline-start:3pt solid #1F3A5F}
        .cover h1{font-size:34pt;margin:0 0 4mm;color:#1F3A5F}
        .cover .sub{font-size:15pt;color:#1F3A5F}
        .cover .note{margin-top:10mm;font-size:12pt;color:#555}
        .cover .hint{margin-top:4mm;font-size:10.5pt;color:#8A8578}
        .cover .ver{margin-top:12mm;font:10pt 'IBM Plex Mono',monospace;color:#8A8578}
        section.b,section.intro{border:0!important;border-radius:0;padding:0 2mm;margin:0 0 4mm;box-shadow:none;background:none}
        section.h2{break-before:page;border-bottom:1.5pt solid #1F3A5F!important;margin-bottom:5mm}
        section.intro+section.h2,section.intro{break-before:auto}
        section.h3{margin-top:0}
        h2{font-size:18pt;margin:2mm 0 3mm}
        h3{font-size:13.5pt;margin:5mm 0 2mm;break-after:avoid}
        p.cap{break-after:avoid;margin-top:5mm;color:#1F3A5F}
        figure{break-inside:avoid;break-after:avoid;margin:2mm 0 3mm}
        figure img{max-height:200mm;width:auto;max-width:100%;margin:0 auto;border:0.6pt solid #D6D2C8;cursor:default}
        figure+ol{break-before:avoid}
        li{break-inside:avoid}
        table,tr{break-inside:avoid}
        a{color:#1F3A5F;text-decoration:none}
        blockquote{break-inside:avoid}
        mark{background:none}`;
      document.head.appendChild(st);
    }, { lang, t, logo, date });
    await p.waitForFunction(() => [...document.images].every(i => i.complete && i.naturalWidth > 0), null, { timeout: 120000 });
    await p.evaluate(() => document.fonts.ready);
    const foot = `<div style="width:100%;font:8pt Arial,sans-serif;color:#8A8578;padding:0 14mm;display:flex;justify-content:space-between;direction:${lang === 'ar' ? 'rtl' : 'ltr'}"><span>Trigon ERP — ${t.title}</span><span>${t.page} <span class="pageNumber"></span> ${t.of} <span class="totalPages"></span></span></div>`;
    const out = path.join(ROOT, 'docs', t.file);
    await p.pdf({ path: out, format: 'A4', printBackground: true, margin: { top: '14mm', bottom: '16mm', left: '14mm', right: '14mm' }, displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate: foot, outline: true, tagged: true });
    console.log('pdf:', out, (fs.statSync(out).size / 1048576).toFixed(1) + ' MB');
    await p.close();
  }
  await b.close();
})();
