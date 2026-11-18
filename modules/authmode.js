// Authentication mode and the break-glass (emergency) administrator sign-in.
//   AUTH_MODE=hybrid (default)        password sign-in and "Sign in with Microsoft", as before
//   AUTH_MODE=microsoft-first         "Sign in with Microsoft" is the way in; the password form is off for everyone, and only the
//                                     emergency administrators named in AUTH_EMERGENCY_ADMINS can sign in locally at /auth/emergency
//                                     (password + ERP two-step code), e.g. when Microsoft or the internet is down.
// microsoft-first takes effect only when it is safe: Microsoft 365 sign-in enabled and configured, and at least one VALID emergency
// administrator (exists, role admin, active, ERP two-step on, not linked to Microsoft, so it depends on nothing outside this server).
// Otherwise the server stays in hybrid and says why (Settings, /api/m365/status, audit log). Every change of the effective mode is audited.
// No hidden bypass: the emergency accounts are normal ERP users (visible in Users), checked like the password form plus the code.
const STANDALONE = typeof process === 'undefined' || process.platform === 'browser';

module.exports = ctx => {
  const { db } = ctx;
  const TOTP = require('../lib/totp');
  const now = () => new Date().toISOString();
  const sysAudit = (user, action, rec, detail) => db.prepare('INSERT INTO audit_log(ts,user,action,tbl,rec,detail) VALUES(?,?,?,?,?,?)').run(now(), user || '', action, 'auth', rec || 0, String(detail).slice(0, 500));
  const env = () => (typeof process !== 'undefined' && process.env) || {};
  const emergencyNames = () => String(env().AUTH_EMERGENCY_ADMINS || '').split(',').map(x => x.trim()).filter(Boolean);

  // each named emergency account and what (if anything) makes it unusable
  function emergencyAccounts() {
    return emergencyNames().map(username => {
      const u = db.prepare('SELECT id, username, role, COALESCE(disabled,0) disabled, COALESCE(totp_on,0) totp_on FROM users WHERE username=?').get(username);
      const problems = [];
      if (!u) problems.push('no such user');
      else {
        if (u.role !== 'admin') problems.push('not an administrator');
        if (u.disabled) problems.push('disabled');
        if (!u.totp_on) problems.push('two-step sign-in (ERP code) is off');
        if (db.prepare('SELECT 1 FROM m365_connections WHERE user_id=?').get(u.id)) problems.push('linked to Microsoft (an emergency account must not depend on it)');
      }
      return { username, id: u ? u.id : null, ok: problems.length === 0, problems };
    });
  }

  // requested vs effective mode, and why
  function authState() {
    const raw = String(env().AUTH_MODE || 'hybrid').trim().toLowerCase(), emergency = emergencyAccounts();
    let mode = 'hybrid', reason = '';
    if (raw === 'microsoft-first') {
      if (STANDALONE) reason = 'not available in the standalone (browser) edition';
      else if (!(ctx.m365LoginAvailable && ctx.m365LoginAvailable())) reason = 'Microsoft 365 sign-in is not enabled and configured';
      else if (!emergency.some(e => e.ok)) reason = 'no valid emergency administrator (AUTH_EMERGENCY_ADMINS: an active administrator with two-step sign-in on, not linked to Microsoft)';
      else mode = 'microsoft-first';
    } else if (raw !== 'hybrid') reason = `unknown AUTH_MODE "${raw.replace(/[^\w-]/g, '').slice(0, 30)}"`;
    // every change of the effective mode is audited once (the mode comes from .env, so it changes at a restart or when a condition changes)
    const key = `${mode}|${raw}|${reason}`, prev = db.prepare("SELECT value FROM settings WHERE key='auth_mode_state'").get()?.value;
    if (prev !== key) {
      db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run('auth_mode_state', key);
      if (prev !== undefined || raw !== 'hybrid' || reason)                 // (a fresh hybrid installation has nothing to report)
        sysAudit('system', 'auth-mode', 0, `effective ${mode} (requested ${raw})${reason ? ' - ' + reason : ''}${prev ? ' [was ' + prev.split('|')[0] + ']' : ''}`);
      // entering microsoft-first ends every password session at once (switching back to hybrid must not bring them back)
      if (mode === 'microsoft-first' && (!prev || prev.split('|')[0] !== 'microsoft-first')) {
        const n = db.prepare("DELETE FROM sessions WHERE method IS NULL OR method NOT IN ('microsoft','emergency')").run().changes;
        if (n) sysAudit('system', 'auth-mode', 0, `${n} password session(s) ended by the switch to microsoft-first`);
      }
    }
    return { requested: raw, mode, reason: reason || null, emergency };
  }
  ctx.authState = authState;
  ctx.authMode = () => authState().mode;

  // ---------- /auth/emergency: break-glass administrator sign-in (password + ERP code), its own page outside the app ----------
  const LIMIT = 5, WINDOW = 15 * 60e3, tries = new Map();                    // per address and per account: 5 attempts in 15 minutes
  const over = k => { const t = (tries.get(k) || []).filter(x => Date.now() - x < WINDOW); if (tries.size > 5000) tries.clear(); tries.set(k, t); return t.length >= LIMIT; };
  const note = k => tries.get(k).push(Date.now());
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const page = (res, code, msg = '', extra = {}) => {
    res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'", ...extra });
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Emergency administrator sign-in</title>
<body style="font:15px system-ui,sans-serif;max-width:420px;margin:10vh auto;padding:0 16px;color:#1F3A5F">
<h2>Emergency administrator sign-in<br><span dir="rtl">دخول المسؤول للطوارئ</span></h2>
<p style="color:#6b7280">For the emergency administrator only, when "Sign in with Microsoft" cannot be used. Every attempt is recorded.</p>
<p dir="rtl" style="color:#6b7280">لمسؤول الطوارئ فقط، عندما لا يمكن استخدام الدخول عبر Microsoft. كل محاولة تُسجَّل.</p>
${msg ? `<p style="color:#b91c1c">${esc(msg)}</p>` : ''}
<form method="post" action="/auth/emergency" autocomplete="off">
<p><label>Username / اسم المستخدم<br><input name="username" required style="width:100%;padding:8px"></label></p>
<p><label>Password / كلمة المرور<br><input name="password" type="password" required style="width:100%;padding:8px"></label></p>
<p><label>Code from the authenticator app / رمز تطبيق المصادقة<br><input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required dir="ltr" style="width:100%;padding:8px"></label></p>
<p><button style="width:100%;padding:10px">Sign in / دخول</button></p></form>
<p><a href="/">← Trigon ERP</a></p></body>`);
    return true;
  };
  const readForm = req => new Promise((ok, no) => { let b = ''; req.on('data', c => { b += c; if (b.length > 4096) { no(new Error('too large')); req.destroy(); } }); req.on('end', () => ok(Object.fromEntries(new URLSearchParams(b)))); req.on('error', no); });
  // a POST must come from this site's own page (browsers send Origin on form posts)
  const sameOrigin = req => {
    const host = (process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-host'] ? String(req.headers['x-forwarded-host']).split(',').pop().trim() : String(req.headers.host || '')).toLowerCase();
    let o; try { o = new URL(req.headers.origin || req.headers.referer || ''); } catch { return false; }
    return o.host.toLowerCase() === host;
  };

  ctx.emergencyAuth = async (req, res) => {
    if (STANDALONE) return false;
    if (!emergencyNames().length) return page(res, 404, 'Emergency sign-in is not set up on this server (AUTH_EMERGENCY_ADMINS).');
    if (req.method === 'GET') return page(res, 200);
    if (req.method !== 'POST') return page(res, 405, 'Not allowed.');
    const ip = ctx.clientIp(req), fail = (who, rec, why, code = 401) => { sysAudit(who, 'emergency-login-failed', rec, `${why} (from ${String(ip).slice(0, 60)})`); return page(res, code, 'Sign-in failed. Check the username, password and code, or wait 15 minutes.'); };
    if (!sameOrigin(req)) return fail('', 0, 'refused: not posted from this site', 403);
    let f; try { f = await readForm(req); } catch { return fail('', 0, 'refused: unreadable form', 400); }
    const username = String(f.username || '').slice(0, 100), acct = 'em:' + username.toLowerCase();
    if (over('ip:' + ip) | over(acct)) { note('ip:' + ip); return fail(username, 0, 'refused: too many attempts', 429); }
    note('ip:' + ip); note(acct);                                              // every attempt counts, also the ones that succeed
    const named = emergencyAccounts().find(e => e.username === username);
    const u = db.prepare('SELECT * FROM users WHERE username=?').get(username);
    if (!named) return fail(username, u ? u.id : 0, 'refused: not an emergency administrator account');   // (same answer for unknown names)
    if (!u || !ctx.passwordOk(u, String(f.password || ''))) return fail(username, u ? u.id : 0, 'refused: wrong password');
    if (u.role !== 'admin') return fail(username, u.id, 'refused: not an administrator');
    if (u.disabled) return fail(username, u.id, 'refused: account disabled');
    if (!u.totp_on || !u.totp_secret) return fail(username, u.id, 'refused: two-step sign-in (ERP code) is not on for this account');
    const step = TOTP.verify(u.totp_secret, String(f.code || '').trim(), u.totp_last || 0);
    if (!step) return fail(username, u.id, 'refused: wrong or reused code');
    db.prepare('UPDATE users SET totp_last=? WHERE id=?').run(step, u.id);
    const old = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie || ''); if (old) db.prepare('DELETE FROM sessions WHERE token=?').run(old[1]);
    const sid = ctx.createSession(u.id, 'emergency');
    tries.delete(acct);
    sysAudit(username, 'emergency-login', u.id, `emergency administrator signed in (from ${String(ip).slice(0, 60)}; session 12 hours)`);
    res.writeHead(303, { Location: '/', 'Set-Cookie': ctx.sessionCookie(req, sid, 12 * 3600), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    return res.end(), true;
  };

  return { handle: async () => false };
};
