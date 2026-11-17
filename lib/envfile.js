// .env next to server.js: server-side settings and secrets (Zoho, Microsoft 365, SMTP…), never in git, the database or a launcher.
// Loaded by server.js before anything reads process.env, whatever started it (run-server.cmd from the TrigonERP task,
// Trigon-Start.bat, Docker, a terminal). Same rules as Node's process.loadEnvFile (Node's own parser; a variable that is already set
// - e.g. SETUP_TOKEN / TRUST_PROXY from run-server.cmd - is never overridden), plus what Windows editors produce:
//   UTF-8 with or without BOM, UTF-16 LE/BE with BOM (Windows PowerShell 5.1 ">", Out-File, Notepad "UTF-16"), and a UTF-8 file with
//   lines appended in UTF-16 (PowerShell 5.1 ">>"). Node's loader silently reads nothing from UTF-16, so the ERP ran without them.
// It never fails silently: the report (setting NAMES only, never values) goes to the server log and to the Microsoft 365 status.
'use strict';
const fs = require('node:fs'), path = require('node:path');

// bytes → text, and which encoding it was
function decode(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { text: buf.subarray(3).toString('utf8'), encoding: 'UTF-8 with BOM' };
  if (buf[0] === 0xff && buf[1] === 0xfe) return { text: buf.subarray(2).toString('utf16le'), encoding: 'UTF-16 LE' };
  if (buf[0] === 0xfe && buf[1] === 0xff) { const b = Buffer.from(buf.subarray(2, buf.length - (buf.length % 2))); return { text: b.swap16().toString('utf16le'), encoding: 'UTF-16 BE' }; }
  if (!buf.includes(0)) return { text: buf.toString('utf8'), encoding: 'UTF-8' };
  // mixed: UTF-8 with UTF-16 parts (PowerShell 5.1 ">>"). Only safe when everything is plain ASCII: drop the NULs and the BOMs.
  const rest = [...buf].filter(c => c !== 0 && c !== 0xff && c !== 0xfe);
  if (rest.some(c => c > 0x7f)) return { text: null, encoding: 'mixed UTF-8 / UTF-16 with non-ASCII text' };
  return { text: Buffer.from(rest).toString('latin1'), encoding: 'UTF-8 with UTF-16 parts (PowerShell >>)' };
}

// read and parse; nothing is applied. → { file, found, encoding, values?, warning? }
function read(dir) {
  const file = path.join(dir, '.env'), r = { file, found: false, encoding: null, warning: null };
  let buf;
  try { buf = fs.readFileSync(file); }
  catch (e) {
    if (e.code === 'ENOENT') {
      const txt = ['.env.txt', '.env.env'].find(n => { try { return fs.statSync(path.join(dir, n)).isFile(); } catch { return false; } });
      if (txt) r.warning = `there is no .env but there is ${txt} (Windows hides the extension) - rename it to .env`;
      return r;
    }
    r.found = true;
    r.warning = e.code === 'EACCES' || e.code === 'EPERM' ? `.env cannot be read by the account running the ERP (${e.code}) - give it read access` : `.env could not be read (${e.code || e.message})`;
    return r;
  }
  r.found = true;
  const d = decode(buf); r.encoding = d.encoding;
  if (d.text == null) { r.warning = `.env is ${d.encoding} - save it again as UTF-8 (Notepad: Save as, Encoding: UTF-8)`; return r; }
  const { parseEnv } = process.getBuiltinModule('node:util');                // (Node >= 22.3; the browser edition never gets here)
  r.values = parseEnv(d.text.split(String.fromCharCode(0xfeff)).join(''));   // byte-order marks (also those of appended parts)
  if (!Object.keys(r.values).length && d.text.trim()) r.warning = '.env has text but no setting could be read from it (expected lines like NAME=value)';
  return r;
}

// read .env and set every variable that is not already set → report without values: { file, found, encoding, loaded[], kept[], warning }
function load(dir, env = process.env) {
  const r = read(dir), loaded = [], kept = [];
  for (const [k, v] of Object.entries(r.values || {})) { if (env[k] === undefined) { env[k] = v; loaded.push(k); } else kept.push(k); }
  delete r.values;
  return { ...r, loaded, kept };
}

// one line for the server log (names only)
const describe = r => !r.found && !r.warning ? '.env: none (no settings file next to server.js)'
  : `.env: ${r.loaded ? r.loaded.length : 0} setting(s) loaded${r.encoding ? ` (${r.encoding})` : ''}${r.loaded && r.loaded.length ? ': ' + r.loaded.join(', ') : ''}`
    + (r.kept && r.kept.length ? `; already set in the environment (e.g. by run-server.cmd), kept: ${r.kept.join(', ')}` : '') + (r.warning ? ` - WARNING: ${r.warning}` : '');

module.exports = { load, read, decode, describe };
