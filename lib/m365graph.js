// Microsoft Graph: the one place that talks to graph.microsoft.com (and the Teams webhook host) for the business features
// (SharePoint documents, Outlook mail, Teams notifications). Pure helpers, no ERP state:
//  - URLs are always built here from a fixed base + validated IDs / path segments: callers never pass a URL (no SSRF);
//  - every call has a timeout; only idempotent calls (GET, PUT of file content) are retried, on 429 / 503 / 504 / network errors;
//  - errors become short, safe messages with a code; no token, code or secret is ever put into a message;
//  - names that end up in SharePoint paths are sanitised (no path traversal, no reserved names, length limits).
'use strict';

const RETRIES = 2;
// per-call timeout: M365_GRAPH_TIMEOUT_MS (default 15 s, kept between 0.2 s and 120 s); uploads get 4× that
const timeoutMs = () => { const n = +((typeof process !== 'undefined' && process.env && process.env.M365_GRAPH_TIMEOUT_MS) || 15000); return Number.isFinite(n) && n > 0 ? Math.min(120e3, Math.max(200, n)) : 15000; };
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d|desktop\.ini|_vti_.*|forms)$/i;

// ---------- identifiers and names ----------
// SharePoint site ID "host,guid,guid"; drive / item IDs are opaque base64-like strings
const SITE_ID = /^[a-z0-9.-]{3,200},[0-9a-f-]{36},[0-9a-f-]{36}$/i;
const OPAQUE_ID = /^[A-Za-z0-9!_\-]{4,200}$/;
const validSiteId = s => typeof s === 'string' && SITE_ID.test(s);
const validDriveId = s => typeof s === 'string' && OPAQUE_ID.test(s);
const validItemId = s => typeof s === 'string' && OPAQUE_ID.test(s);
const seg = (s, ok) => { if (!ok(s)) throw gerr('bad_id', 'Invalid Microsoft 365 identifier'); return encodeURIComponent(s); };

// one path segment (folder or file name) for SharePoint: no separators, no control characters, no "..", no reserved names
function safeName(name, { max = 120, fallback = 'document' } = {}) {
  let s = String(name == null ? '' : name).normalize('NFC')
    .replace(/[\u0000-\u001f\u007f"*:<>?/\\|#%~&{}+]/g, '-')        // characters SharePoint refuses, separators and URL-special ones
    .replace(/\s+/g, ' ').replace(/-{2,}/g, '-').trim()
    .replace(/^[.\s-]+|[.\s]+$/g, '');                                  // no leading dots (hidden / "..") and no trailing dot or space
  if (!s || s === '.' || s === '..') s = fallback;
  const dot = s.lastIndexOf('.'), base = dot > 0 ? s.slice(0, dot) : s, ext = dot > 0 ? s.slice(dot) : '';
  let out = (RESERVED.test(base) ? '_' + base : base).slice(0, Math.max(1, max - ext.length)) + ext.slice(0, 12);
  out = out.replace(/[.\s]+$/g, '');
  return out || fallback;
}
// a folder path made of sanitised segments, joined and URL-encoded segment by segment
const safePath = parts => parts.map(p => safeName(p, { max: 80, fallback: '_' })).filter(Boolean);
const encPath = parts => parts.map(encodeURIComponent).join('/');

// a link we got back from Graph and will show to users: https on SharePoint only
function safeWebUrl(u) {
  try { const x = new URL(String(u)); return x.protocol === 'https:' && /(^|\.)sharepoint\.com$/i.test(x.hostname) && !x.username && !x.password ? x.href : null; }
  catch { return null; }
}

// a Teams destination: an incoming-webhook / Workflows URL on Microsoft's hosts only (https, no credentials, default port).
// Extra exact host names (e.g. a local mock in tests) only through M365_TEAMS_EXTRA_HOSTS on the server.
function teamsUrlOk(u, extraHosts = []) {
  let x; try { x = new URL(String(u)); } catch { return false; }
  if (x.username || x.password || x.hash) return false;
  const h = x.hostname.toLowerCase();
  if (extraHosts.map(s => s.toLowerCase()).includes(h)) return x.protocol === 'https:' || ['127.0.0.1', 'localhost'].includes(h);
  if (x.protocol !== 'https:' || (x.port && x.port !== '443')) return false;
  return /\.webhook\.office\.com$/.test(h) || /\.logic\.azure\.com$/.test(h) || /\.environment\.api\.powerplatform\.com$/.test(h);
}

// ---------- errors ----------
function gerr(code, msg, status = 502) { return Object.assign(new Error(msg), { code, status, graph: true }); }
const SAFE = {
  400: ['bad_request', 'Microsoft 365 refused the request'], 401: ['consent_required', 'Microsoft 365 access has expired or was revoked — reconnect the Microsoft account / check the app consent'],
  403: ['forbidden', 'The Microsoft 365 app does not have the permission for this (ask the administrator to grant it)'], 404: ['not_found', 'Not found in Microsoft 365 (removed or wrong configuration)'],
  409: ['conflict', 'A file with that name is in the way in SharePoint'], 413: ['too_large', 'The file is too large for Microsoft 365'], 429: ['throttled', 'Microsoft 365 is busy — try again in a minute'],
  500: ['graph_unavailable', 'Microsoft 365 had an error — try again later'], 503: ['graph_unavailable', 'Microsoft 365 is unavailable — try again later'], 504: ['timeout', 'Microsoft 365 did not answer in time'],
};
const safeErr = status => { const [c, m] = SAFE[status] || (status >= 500 ? SAFE[503] : SAFE[400]); return gerr(c, m); };

// ---------- HTTP with timeout and safe retries ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
// call(url, opts): opts.method, headers, body (Buffer / string), json (object), timeout, idempotent (retry allowed), raw (return Response text)
async function call(url, { method = 'GET', headers = {}, body, json, timeout = timeoutMs(), idempotent, expect = 'json', fetchImpl = globalThis.fetch } = {}) {
  const canRetry = idempotent ?? (method === 'GET');
  let attempt = 0;
  for (;;) {
    let r;
    try {
      r = await fetchImpl(url, { method, signal: AbortSignal.timeout(timeout), headers: { Accept: 'application/json', ...(json ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: json ? JSON.stringify(json) : body });
    } catch (e) {
      if (canRetry && attempt < RETRIES) { attempt++; await sleep(300 * attempt); continue; }
      throw e && e.name === 'TimeoutError' ? gerr('timeout', 'Microsoft 365 did not answer in time') : gerr('graph_unavailable', 'Microsoft 365 could not be reached');
    }
    if ((r.status === 429 || r.status === 503 || r.status === 504) && canRetry && attempt < RETRIES) {
      const wait = Math.min(5000, (+r.headers.get('retry-after') || 0) * 1000 || 400 * (attempt + 1)); attempt++; await r.arrayBuffer().catch(() => {}); await sleep(wait); continue;
    }
    if (!r.ok) { await r.arrayBuffer().catch(() => {}); throw safeErr(r.status); }
    if (expect === 'none' || r.status === 202 || r.status === 204) { await r.arrayBuffer().catch(() => {}); return null; }
    const text = await r.text();
    if (expect === 'text') return text;
    try { return text ? JSON.parse(text) : {}; } catch { throw gerr('bad_response', 'Microsoft 365 sent an unreadable answer'); }
  }
}

module.exports = { call, gerr, safeName, safePath, encPath, safeWebUrl, teamsUrlOk, seg, validSiteId, validDriveId, validItemId, timeoutMs };
