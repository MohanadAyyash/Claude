// Builds the Trigon brand pack (brand/*.svg, brand/*.png) from the raw artwork extracted from the guideline PDFs.
// Requires Playwright + Chromium (development only):  node tools/build_brand.js <rawDir>
const fs = require('fs'), path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const raw = process.argv[2], out = path.join(__dirname, '..', 'brand');
const BLUE = '#1f3a5f', GREY = '#8a8578', PAPER = '#f2f1ee', STONE = '#d6d2c8';
const ar = fs.existsSync(path.join(raw, 'logo_ar_raw.svg'));

async function tight(page, svg) {                      // tight bounding box of the artwork, measured by the browser
  await page.setContent(`<html><body style="margin:0">${svg}</body></html>`);
  return page.evaluate(() => { const b = document.getElementById('art').getBBox(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
}
const retarget = (svg, b, pad = 0) => svg.replace(/width="[^"]+" height="[^"]+" viewBox="[^"]+"/, `width="${(b.w + 2 * pad).toFixed(2)}" height="${(b.h + 2 * pad).toFixed(2)}" viewBox="${(b.x - pad).toFixed(2)} ${(b.y - pad).toFixed(2)} ${(b.w + 2 * pad).toFixed(2)} ${(b.h + 2 * pad).toFixed(2)}"`);
const recolor = (svg, map) => Object.entries(map).reduce((s, [a, b]) => s.split(`fill="${a}"`).join(`fill="${b}"`), svg);

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  const page = await browser.newPage();
  const files = { logo: 'logo_raw.svg', logo_ar: 'logo_ar_raw.svg', logo_stacked: 'stacked_raw.svg' };
  const svgs = {};
  for (const [name, f] of Object.entries(files)) {
    if (!fs.existsSync(path.join(raw, f))) continue;
    const s = fs.readFileSync(path.join(raw, f), 'utf8'); svgs[name] = retarget(s, await tight(page, s));
  }
  // mark only = the three bars of the primary logo
  const bars = [...svgs.logo.matchAll(/<path fill="[^"]+" d="[^"]+"\/>/g)].slice(0, 3).map(m => m[0]).join('');
  const markSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" viewBox="0 0 1 1"><g id="art">${bars}</g></svg>`;
  svgs.mark = retarget(markSvg, await tight(page, markSvg));
  // single-line version for e-mail signatures: mark + wordmark, without the tagline
  const four = [...svgs.logo.matchAll(/<path fill="[^"]+" d="[^"]+"\/>/g)].slice(0, 4).map(m => m[0]).join('');
  const lineSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" viewBox="0 0 1 1"><g id="art">${four}</g></svg>`;
  svgs.logo_line = retarget(lineSvg, await tight(page, lineSvg));
  svgs.logo_white = recolor(svgs.logo, { [BLUE]: PAPER, [GREY]: STONE });
  svgs.logo_black = recolor(svgs.logo, { [BLUE]: '#000000', [GREY]: '#000000' });
  const px = { logo: 2400, logo_ar: 1800, logo_stacked: 900, logo_line: 900, mark: 600, logo_white: 2400, logo_black: 2400 };
  for (const [name, svg] of Object.entries(svgs)) {
    fs.writeFileSync(path.join(out, name + '.svg'), svg);
    const m = svg.match(/viewBox="[^"]*? ([\d.]+) ([\d.]+)"/), w = +m[1], h = +m[2], width = px[name], height = Math.round(width * h / w);
    const p2 = await browser.newPage({ viewport: { width, height } });
    await p2.setContent(`<html><body style="margin:0;background:transparent"><div style="width:${width}px;height:${height}px">${svg.replace(/width="[^"]+" height="[^"]+"/, `width="${width}" height="${height}"`)}</div></body></html>`);
    await p2.screenshot({ path: path.join(out, name + '.png'), omitBackground: true, clip: { x: 0, y: 0, width, height } });
    await p2.close(); console.log(name, width + 'x' + height);
  }
  await browser.close();
})();
