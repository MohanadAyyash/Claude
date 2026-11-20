// HTML -> PDF using a locally installed Chrome / Edge / Chromium in headless mode (no npm packages needed).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

function findBrowser() {
  if (process.env.SKIP_PDF) return null;                                   // e.g. CI: no PDF rendering
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
function htmlToPdf(html, opts = {}) {
  html = embedFonts(html);
  const exe = findBrowser();
  if (!exe) return Promise.reject(new Error('No Chrome/Edge found on this machine — PDF generation is unavailable (set CHROME_PATH)'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-pdf-')), src = path.join(dir, 'in.html'), out = path.join(dir, 'out.pdf'), log = path.join(dir, 'browser.log');
  fs.writeFileSync(src, html);
  const args = ['--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage', '--disable-extensions', '--disable-background-networking', '--no-first-run', '--no-pdf-header-footer',
    `--user-data-dir=${path.join(dir, 'profile')}`, `--print-to-pdf=${out}`, 'file://' + (src.startsWith('/') ? '' : '/') + src.replace(/\\/g, '/')];
  // Not execFile: browsers leave helper processes holding stdio open, so its callback may never fire. We watch for the output file instead
  // and kill the whole process group when done (or after the timeout). The browser's own messages go to a file (not a pipe, for the same reason)
  // so that a failure can say why.
  return new Promise((ok, no) => {
    let logFd = null; try { logFd = fs.openSync(log, 'w'); } catch { /* no diagnostics, the render itself still runs */ }
    const child = spawn(exe, args, { stdio: ['ignore', 'ignore', logFd === null ? 'ignore' : logFd], detached: process.platform !== 'win32' });
    let finished = false, lastSize = -1, stable = 0, exit = null, exitedAt = 0;
    const killAll = () => { try { process.platform === 'win32' ? child.kill() : process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } };
    const why = () => {                                                   // which browser, whether it is still running, and the last thing it said
      let tail = ''; try { tail = fs.readFileSync(log, 'utf8').replace(/\s+/g, ' ').trim().slice(-400); } catch { /* nothing written */ }
      return ` (browser: ${exe}; ${exit ? `exited with ${exit}` : 'still running'}${tail ? `; browser output: ${tail}` : '; no browser output'})`;
    };
    const finish = (err, buf) => { if (finished) return; finished = true; clearInterval(poll); clearTimeout(limit); if (err) err.message += why(); err ? no(err) : ok(buf); killAll(); if (logFd !== null) try { fs.closeSync(logFd); } catch { /* already closed */ } try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* left in the temp folder */ } };
    child.on('error', e => finish(new Error('Could not start the browser: ' + e.message)));
    child.on('exit', (code, signal) => { exit = signal ? `signal ${signal}` : `code ${code}`; exitedAt = Date.now(); });
    const poll = setInterval(() => {
      try {
        if (!fs.existsSync(out)) {
          // the browser ended with an error and wrote nothing: do not keep the user waiting for the full time-out
          if (exit && exit !== 'code 0' && Date.now() - exitedAt > 2000) finish(new Error('PDF generation failed'));
          return;
        }
        const size = fs.statSync(out).size; stable = size === lastSize && size > 0 ? stable + 1 : 0; lastSize = size;
        if (stable >= 2) finish(null, fs.readFileSync(out));
      } catch { /* the browser still holds the file — next tick */ }                      // size unchanged for ~0.5 s → the PDF is complete
    }, 250);
    const limit = setTimeout(() => finish(new Error('PDF generation timed out')), opts.timeout || 40000);
  });
}
module.exports = { htmlToPdf, findBrowser };
