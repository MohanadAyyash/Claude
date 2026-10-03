// HTML -> PDF using a locally installed Chrome / Edge / Chromium in headless mode (no npm packages needed).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

function findBrowser() {
  const c = [process.env.CHROME_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/microsoft-edge'];
  try { for (const d of fs.readdirSync('/opt/pw-browsers')) c.push(`/opt/pw-browsers/${d}/chrome-linux/chrome`); } catch {}
  return c.find(p => p && fs.existsSync(p)) || null;
}

// fonts are referenced as /fonts/*.woff2 on the web pages; for a file:// render they are inlined as data URIs
let fontStyle = null;
function embedFonts(html) {
  if (!html.includes('href="/fonts/fonts.css"')) return html;
  if (!fontStyle) {
    const dir = path.join(__dirname, '..', 'public', 'fonts');
    fontStyle = '<style>' + fs.readFileSync(path.join(dir, 'fonts.css'), 'utf8').replace(/url\(([\w.-]+\.woff2)\)/g, (_, f) => `url(data:font/woff2;base64,${fs.readFileSync(path.join(dir, f)).toString('base64')})`) + '</style>';
  }
  return html.replace('<link rel="stylesheet" href="/fonts/fonts.css">', () => fontStyle);
}
function htmlToPdf(html) {
  html = embedFonts(html);
  const exe = findBrowser();
  if (!exe) return Promise.reject(new Error('No Chrome/Edge found on this machine — PDF generation is unavailable (set CHROME_PATH)'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-pdf-')), src = path.join(dir, 'in.html'), out = path.join(dir, 'out.pdf');
  fs.writeFileSync(src, html);
  const args = ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-pdf-header-footer', `--user-data-dir=${path.join(dir, 'profile')}`, `--print-to-pdf=${out}`, 'file://' + (src.startsWith('/') ? '' : '/') + src.replace(/\\/g, '/')];
  return new Promise((ok, no) => execFile(exe, args, { timeout: 40000 }, err => {
    try {
      if (!fs.existsSync(out)) return no(new Error('PDF generation failed' + (err ? ': ' + err.message : '')));
      ok(fs.readFileSync(out));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }));
}
module.exports = { htmlToPdf, findBrowser };
