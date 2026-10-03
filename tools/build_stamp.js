// Renders the official company stamp (Ø38 mm, Steel Blue ink) per Trigon Brand Guidelines v1.1 → brand/stamp.png
const fs = require('fs'), path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const root = path.join(__dirname, '..'), BLUE = '#1f3a5f';
const bars = fs.readFileSync(path.join(root, 'brand/mark.svg'), 'utf8');
const mv = /viewBox="([\d.\-]+) ([\d.\-]+) ([\d.]+) ([\d.]+)"/.exec(bars), inner = /<g id="art">(.*)<\/g>/s.exec(bars)[1];
const mw = +mv[3], mh = +mv[4], S = 330 / mw;                     // mark scaled to 330 units wide, centred
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" width="1000" height="1000">
 <defs><path id="top" d="M 135 500 A 365 365 0 0 1 865 500"/><path id="bot" d="M 80 500 A 420 420 0 0 0 920 500"/></defs>
 <circle cx="500" cy="500" r="485" fill="none" stroke="${BLUE}" stroke-width="16"/><circle cx="500" cy="500" r="455" fill="none" stroke="${BLUE}" stroke-width="5"/>
 <circle cx="500" cy="500" r="272" fill="none" stroke="${BLUE}" stroke-width="5"/>
 <text font-family="IBM Plex Sans Arabic" font-weight="600" font-size="60" fill="${BLUE}" text-anchor="middle" direction="rtl"><textPath href="#top" startOffset="50%">تريجون سيفيل للمقاولات ذ.م.م</textPath></text>
 <text font-family="Archivo" font-weight="600" font-size="46" letter-spacing="4" fill="${BLUE}" text-anchor="middle"><textPath href="#bot" startOffset="50%">TRIGON CIVIL CONTRACTING L.L.C</textPath></text>
 <g font-family="IBM Plex Mono" font-weight="500" font-size="28" fill="${BLUE}" text-anchor="middle"><text x="150" y="490">DUBAI</text><text x="150" y="526">U.A.E</text><text x="850" y="490">P.O. BOX</text><text x="850" y="526">334112</text></g>
 <g transform="translate(${500 - 330 / 2} ${500 - (mh * S) / 2}) scale(${S}) translate(${-mv[1]} ${-mv[2]})">${inner}</g></svg>`;
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined }), p = await b.newPage({ viewport: { width: 1000, height: 1000 } });
  await p.setContent(`<html><head><link rel="stylesheet" href="file://${root}/public/fonts/fonts.css"><style>body{margin:0;background:transparent}</style></head><body>${svg}</body></html>`);
  await p.goto('file://' + path.join(root, 'public/fonts/fonts.css')).catch(() => {});
  await p.setContent(`<html><head><style>${fs.readFileSync(path.join(root, 'public/fonts/fonts.css'), 'utf8').replace(/url\(/g, `url(file://${root}/public/fonts/`)}body{margin:0;background:transparent}</style></head><body>${svg}</body></html>`);
  await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(600);
  await p.screenshot({ path: path.join(root, 'brand/stamp.png'), omitBackground: true });
  fs.writeFileSync(path.join(root, 'brand/stamp.svg'), svg); await b.close(); console.log('stamp ok');
})();
