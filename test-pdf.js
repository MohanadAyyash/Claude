// PDF rendering failures must say why: node --no-warnings test-pdf.js
// Uses fake "browsers" (shell scripts) through CHROME_PATH, so no real browser is needed.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
if (process.platform === 'win32') { console.log('test-pdf: skipped on Windows (uses shell scripts as fake browsers)'); process.exit(0); }
delete process.env.SKIP_PDF;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-pdftest-'));
const fake = (name, body) => { const p = path.join(dir, name); fs.writeFileSync(p, '#!/bin/sh\n' + body + '\n', { mode: 0o755 }); return p; };
const { htmlToPdf } = require('./lib/pdf');
const fails = async opts => { try { await htmlToPdf('<html><body>x</body></html>', opts); } catch (e) { return e.message; } assert.fail('expected the PDF render to fail'); };

(async () => {
  try {
    // 1. the browser starts but never writes the file (what a hung headless browser looks like): the time-out names the browser and its last output
    process.env.CHROME_PATH = fake('hung-browser', 'echo "hang-diagnostic: cannot open display" >&2\nsleep 30');
    let t = Date.now(), msg = await fails({ timeout: 1500 });
    assert.match(msg, /PDF generation timed out/);
    assert.match(msg, /hung-browser/, 'names the browser that was used');
    assert.match(msg, /still running/);
    assert.match(msg, /hang-diagnostic: cannot open display/, 'carries the browser output');
    assert.ok(Date.now() - t < 10000);

    // 2. the browser exits with an error and no file: fail at once with the exit code instead of waiting for the time-out
    process.env.CHROME_PATH = fake('broken-browser', 'echo "boom-diagnostic" >&2\nexit 3');
    t = Date.now(); msg = await fails();
    assert.match(msg, /exited with code 3/);
    assert.match(msg, /boom-diagnostic/);
    assert.ok(Date.now() - t < 15000, 'does not wait for the 40 s time-out');

    // 3. a browser that writes the file still works, and its exit is not treated as a failure
    process.env.CHROME_PATH = fake('ok-browser', 'for a in "$@"; do case "$a" in --print-to-pdf=*) printf "%%PDF-1.4 fake" > "${a#--print-to-pdf=}";; esac; done\nexit 0');
    const buf = await htmlToPdf('<html><body>x</body></html>');
    assert.equal(buf.subarray(0, 4).toString(), '%PDF');
    console.log('test-pdf: OK');
  } catch (e) { console.error(e); process.exitCode = 1; }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
})();
