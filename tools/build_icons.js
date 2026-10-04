// App icons for "Add to Home Screen": Paper-coloured mark on Steel Blue (Trigon brand). Dev-only: node tools/build_icons.js
const fs = require('fs'), path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const root = path.join(__dirname, '..'), mark = fs.readFileSync(path.join(root, 'brand/mark.svg'), 'utf8');
const v = /viewBox="([\d.\-]+) ([\d.\-]+) ([\d.]+) ([\d.]+)"/.exec(mark), inner = /<g id="art">(.*)<\/g>/s.exec(mark)[1].replace(/fill="#1f3a5f"/g, 'fill="#f2f1ee"');
const icon = (size, pad) => { const w = size * (1 - 2 * pad), s = w / +v[3];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" fill="#1f3a5f"/><g transform="translate(${(size - w) / 2} ${(size - +v[4] * s) / 2}) scale(${s}) translate(${-v[1]} ${-v[2]})">${inner}</g></svg>`; };
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  for (const [name, size, pad] of [['icon-192.png', 192, .24], ['icon-512.png', 512, .24], ['icon-maskable-512.png', 512, .32], ['apple-touch-icon.png', 180, .24]]) {
    const p = await b.newPage({ viewport: { width: size, height: size } }); await p.setContent(`<body style="margin:0">${icon(size, pad)}</body>`);
    await p.screenshot({ path: path.join(root, 'public', name) }); await p.close();
  }
  await b.close(); console.log('icons ok');
})();
