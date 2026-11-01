const { chromium } = require('playwright');
const path = require('path'), fs = require('fs');
const BASE = process.env.BASE || 'http://localhost:3999';
const OUT = path.join(__dirname, '..', '..', 'docs', 'img');
// find an element: {sel} css, or {text} visible text (exact first, then starts-with), optional {in} css scope, {nth}
async function rectOf(page, s) {
  return page.evaluate(s => {
    const scope = s.in ? document.querySelector(s.in) : document;
    if (!scope) return null;
    const vis = e => { const r = e.getBoundingClientRect(); const st = getComputedStyle(e); return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none'; };
    let els = [];
    if (s.sel) els = [...scope.querySelectorAll(s.sel)].filter(vis);
    else {
      const norm = t => (t || '').replace(/\s+/g, ' ').trim();
      const cand = [...scope.querySelectorAll(s.tags || 'button,a,label,h1,h2,h3,th,.l,.kpi,select,input,td,span,div,p,b,summary')].filter(vis);
      els = cand.filter(e => norm(e.innerText) === s.text);
      if (!els.length) els = cand.filter(e => norm(e.innerText).startsWith(s.text));
      if (!els.length) els = cand.filter(e => norm(e.innerText).includes(s.text));
      // smallest first
      els.sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height);
      if (s.nth === undefined) els = els.slice(0, 1);
    }
    let e = els[s.nth || 0]; if (!e) return null;
    if (s.up) for (let i = 0; i < s.up; i++) e = e.parentElement;
    if (s.closest) e = e.closest(s.closest) || e;
    if (s.scroll) e.scrollIntoView({ block: 'center' });
    const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, s);
}
async function shot(page, name, lang, notes = [], opts = {}) {
  await page.waitForTimeout(opts.wait || 350);
  await page.evaluate(() => document.querySelectorAll('.toast').forEach(t => t.remove()));
  // targets
  const items = [];
  for (const n of notes) {
    let r = await rectOf(page, n);
    if (!r && n.sel2) r = await rectOf(page, { ...n, sel: n.sel2 });
    if (!r) { console.log('   !! not found', name, JSON.stringify(n).slice(0, 110)); continue; }
    if (n.rect) r = { x: r.x + (n.rect[0] || 0), y: r.y + (n.rect[1] || 0), w: n.rect[2] ?? r.w, h: n.rect[3] ?? r.h };
    if (items.some(i => i.n === n.n)) continue;            // alternatives with the same number
    items.push({ r, n: n.n, label: n.label ? (lang === 'ar' ? n.label[0] : n.label[1]) : '' });
  }
  // crop area
  const vw = page.viewportSize();
  let crop = opts.clip;
  if (!crop) crop = await page.evaluate(({ c }) => {
    const pick = c && c !== 'full' ? document.querySelector(c) : (c === 'full' ? null : (document.querySelector('.overlay .modal') || document.querySelector('#main')));
    if (!pick) return null;
    const r0 = pick.getBoundingClientRect(), pad = pick.classList.contains('modal') ? 14 : 4;
    let bottom = r0.bottom; if (pick.id === 'main') { bottom = Math.max(...[...pick.children].map(k => k.getBoundingClientRect().bottom)) + 16; }
    const r = { x: r0.x, y: r0.y, right: r0.right, bottom: Math.min(r0.bottom, bottom) };
    const x = Math.max(0, r.x - pad), y = Math.max(0, r.y - pad);
    return { x, y, width: Math.min(innerWidth, r.right + pad) - x, height: Math.min(innerHeight, r.bottom + pad) - y };
  }, { c: opts.crop });
  if (!crop) crop = { x: 0, y: 0, width: vw.width, height: vw.height };
  // include all targets inside the crop
  for (const it of items) { const r = it.r; const x2 = Math.max(crop.x + crop.width, r.x + r.w + 8), y2 = Math.max(crop.y + crop.height, r.y + r.h + 8); crop.x = Math.max(0, Math.min(crop.x, r.x - 8)); crop.y = Math.max(0, Math.min(crop.y, r.y - 8)); crop.width = Math.min(vw.width, x2) - crop.x; crop.height = Math.min(vw.height, y2) - crop.y; }
  const buf = await page.screenshot({ type: 'png', clip: crop });
  // compose: screenshot + a callout gutter on the content side
  const G = items.some(i => i.label) ? 300 : 0, gl = lang === 'ar' ? true : false;      // gutter on the left in Arabic (content side), right in English
  const W = crop.width + G, H = crop.height;
  const H0 = H; const its = items.map(i => ({ ...i, r: { x: i.r.x - crop.x + (gl ? G : 0), y: i.r.y - crop.y, w: i.r.w, h: i.r.h } }));
  const cp = await page.context().newPage();
  await cp.setViewportSize({ width: Math.ceil(W), height: Math.ceil(H) });
  await cp.setContent(`<html><head><style>@font-face{font-family:Plex;src:url(${BASE}/fonts/ibm-plex-sans-arabic-arabic-600-normal.woff2)}body{margin:0;background:#fff}</style></head><body><div id="c" style="position:relative;width:${W}px;height:${H}px;background:#F7F6F3"><img id="im" src="data:image/png;base64,${buf.toString('base64')}" style="position:absolute;left:${gl ? G : 0}px;top:0;width:${crop.width}px;height:${crop.height}px"></div></body></html>`);
  await cp.waitForFunction(() => document.getElementById('im').complete);
  await cp.evaluate(({ its, G, gl, W, H, lang, imgX, imgW }) => {
    const c = document.getElementById('c'), NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('width', W); svg.setAttribute('height', H); svg.style.cssText = 'position:absolute;left:0;top:0';
    svg.innerHTML = '<defs><marker id="ah" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9 z" fill="#E11D2E"/></marker></defs>';
    c.appendChild(svg);
    const el = (t, a) => { const e = document.createElementNS(NS, t); for (const k in a) e.setAttribute(k, a[k]); svg.appendChild(e); return e; };
    // border line between gutter and image
    if (G) el('line', { x1: gl ? G : imgW, y1: 0, x2: gl ? G : imgW, y2: H, stroke: '#D6D2C8', 'stroke-width': 1 });
    for (const it of its) { const p = 4, r = it.r; el('rect', { x: r.x - p, y: r.y - p, width: r.w + 2 * p, height: r.h + 2 * p, rx: 6, fill: 'rgba(225,29,46,0.05)', stroke: '#E11D2E', 'stroke-width': 3 }); }
    let next = 8; const sorted = [...its].filter(i => i.label).sort((a, b) => (a.r.y + a.r.h / 2) - (b.r.y + b.r.h / 2));
    for (const it of sorted) {
      const lb = document.createElement('div'); lb.dir = lang === 'ar' ? 'rtl' : 'ltr';
      lb.innerHTML = `<b style="flex:none;display:inline-block;width:24px;height:24px;border-radius:50%;background:#E11D2E;color:#fff;text-align:center;line-height:24px;font:700 14px/24px Arial">${it.n}</b><span>${it.label}</span>`;
      lb.style.cssText = `position:absolute;width:${G - 34}px;display:flex;gap:8px;align-items:flex-start;background:#fff;border:2px solid #E11D2E;color:#1F2937;font:600 14px/1.4 ${lang === 'ar' ? 'Plex,Tahoma' : 'Arial'};padding:7px 9px;border-radius:8px;box-shadow:0 1px 4px rgba(0,0,0,.15);box-sizing:border-box`;
      c.appendChild(lb);
      const lh = lb.offsetHeight, cy = it.r.y + it.r.h / 2;
      let ly = Math.max(next, cy - lh / 2); next = ly + lh + 8;
      const lx = gl ? 12 : imgW + 22; lb.style.left = lx + 'px'; lb.style.top = ly + 'px';
      const sx = gl ? lx + (G - 34) : lx, sy = ly + lh / 2;
      const tx = gl ? it.r.x - 6 : it.r.x + it.r.w + 6, ty = Math.min(it.r.y + it.r.h - 4, Math.max(it.r.y + 4, cy));
      el('path', { d: `M${sx},${sy} C${(sx + tx) / 2},${sy} ${(sx + tx) / 2},${ty} ${tx},${ty}`, fill: 'none', stroke: '#E11D2E', 'stroke-width': 2.5, 'marker-end': 'url(#ah)' });
    }
    for (const it of its) { const b = document.createElement('div'); b.textContent = it.n; const bx = gl ? it.r.x + it.r.w - 4 : it.r.x - 18, by = it.r.y - 16;
      b.style.cssText = `position:absolute;left:${bx}px;top:${by}px;width:24px;height:24px;border-radius:50%;background:#E11D2E;color:#fff;font:700 13px/24px Arial;text-align:center;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.35)`; c.appendChild(b); }
    const need = Math.max(H, next + 4); if (need > H) { c.style.height = need + 'px'; svg.setAttribute('height', need); }
    return need;
  }, { its, G, gl, W, H, lang, imgX: gl ? G : 0, imgW: crop.width }).then(async need => { if (need > H) await cp.setViewportSize({ width: Math.ceil(W), height: Math.ceil(need) }); });
  fs.mkdirSync(path.join(OUT, lang), { recursive: true });
  await cp.screenshot({ path: path.join(OUT, lang, name + '.jpg'), type: 'jpeg', quality: 88 });
  await cp.close();
  console.log('  shot', lang, name);
}
module.exports = { chromium, BASE, shot, rectOf };
