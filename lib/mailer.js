// Minimal dependency-free SMTP client (implicit TLS on 465, STARTTLS on 587, AUTH LOGIN/PLAIN).
const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');

const b64 = s => Buffer.from(s, 'utf8').toString('base64');
const wrap = s => b64(s).replace(/(.{76})/g, '$1\r\n');
const noCrlf = s => String(s || '').replace(/[\r\n]+/g, ' ').trim();
const word = s => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);          // RFC 2047 for non-ASCII headers
const validEmail = s => /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/.test(String(s || ''));
const isLocal = h => ['localhost', '127.0.0.1', '::1'].includes(h);

class Conn {
  constructor(sock) {
    this.sock = sock; this.buf = ''; this.lines = []; this.waiter = null; this.err = null;
    sock.on('data', d => { this.buf += d.toString('utf8'); this.pump(); });
    sock.on('error', e => this.fail(e));
    sock.on('close', () => this.fail(new Error('connection closed')));
    sock.setTimeout(20000, () => this.fail(new Error('SMTP timeout')));
  }
  pump() {
    let i; while ((i = this.buf.indexOf('\r\n')) >= 0) { this.lines.push(this.buf.slice(0, i)); this.buf = this.buf.slice(i + 2); }
    if (this.waiter && this.lines.length) { const w = this.waiter; this.waiter = null; w.res(this.lines.shift()); }
  }
  fail(e) { this.err = this.err || e; if (this.waiter) { const w = this.waiter; this.waiter = null; w.rej(this.err); } }
  line() { return new Promise((res, rej) => { if (this.lines.length) return res(this.lines.shift()); if (this.err) return rej(this.err); this.waiter = { res, rej }; }); }
  async resp() { const out = []; for (;;) { const l = await this.line(); out.push(l); if (/^\d{3}( |$)/.test(l)) return { code: +l.slice(0, 3), lines: out }; } }
  async cmd(c, ok, label) { this.sock.write(c + '\r\n'); const r = await this.resp(); if (!ok.includes(r.code)) throw new Error(`SMTP ${label || c.split(' ')[0]} failed: ${r.lines.join(' ')}`); return r; }
}

function buildMessage({ from, fromName, to, subject, html, text, attachments = [], inline = [] }) {
  const rnd = () => crypto.randomBytes(12).toString('hex'), boundary = 'b' + rnd(), domain = from.split('@')[1], mixed = attachments.length > 0, outer = 'm' + rnd(), rel = 'r' + rnd();
  const head = [`From: ${fromName ? word(noCrlf(fromName)) + ' ' : ''}<${from}>`, `To: ${to.join(', ')}`, `Subject: ${word(noCrlf(subject))}`, `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${rnd()}@${domain}>`, 'MIME-Version: 1.0',
    mixed ? `Content-Type: multipart/mixed; boundary="${outer}"` : `Content-Type: multipart/alternative; boundary="${boundary}"`];
  const part = (type, body) => `--${boundary}\r\nContent-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap(body)}\r\n`;
  // inline images (e.g. the logo in the signature) travel with the HTML part as multipart/related, referenced by cid:
  const htmlPart = !inline.length ? part('text/html', html || '') :
    `--${boundary}\r\nContent-Type: multipart/related; boundary="${rel}"\r\n\r\n--${rel}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap(html || '')}\r\n` +
    inline.map(i => `--${rel}\r\nContent-Type: ${i.mime}\r\nContent-Transfer-Encoding: base64\r\nContent-ID: <${i.cid}>\r\nContent-Disposition: inline\r\n\r\n${Buffer.from(i.content).toString('base64').replace(/(.{76})/g, '$1\r\n')}\r\n`).join('') + `--${rel}--\r\n`;
  const alt = part('text/plain', text || '') + htmlPart + `--${boundary}--\r\n`;
  if (!mixed) return head.join('\r\n') + '\r\n\r\n' + alt;
  const files = attachments.map(a => {
    const fname = noCrlf(a.filename).replace(/"/g, ''), enc = /^[\x20-\x7e]*$/.test(fname) ? `filename="${fname}"` : `filename*=UTF-8''${encodeURIComponent(fname)}`;
    return `--${outer}\r\nContent-Type: ${a.mime || 'application/octet-stream'}; name="${fname.replace(/[^\x20-\x7e]/g, '_')}"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; ${enc}\r\n\r\n${Buffer.from(a.content).toString('base64').replace(/(.{76})/g, '$1\r\n')}\r\n`;
  }).join('');
  return head.join('\r\n') + '\r\n\r\n' + `--${outer}\r\nContent-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n` + alt + files + `--${outer}--\r\n`;
}

async function sendMail(cfg, msg) {
  const to = [].concat(msg.to).map(noCrlf);
  if (!cfg.host) throw new Error('SMTP host is not configured');
  if (!validEmail(cfg.from)) throw new Error('"From" address is not a valid email');
  if (!to.length || !to.every(validEmail)) throw new Error('Recipient email address is not valid');
  const port = +cfg.port || (cfg.secure ? 465 : 587);
  let sock = cfg.secure ? tls.connect(port, cfg.host, { servername: cfg.host }) : net.connect(port, cfg.host);
  await new Promise((ok, no) => { sock.once(cfg.secure ? 'secureConnect' : 'connect', ok); sock.once('error', no); });
  let c = new Conn(sock);
  try {
    const hello = await c.resp(); if (hello.code !== 220) throw new Error('SMTP greeting failed: ' + hello.lines.join(' '));
    let caps = (await c.cmd('EHLO erp.local', [250])).lines.join(' ').toUpperCase();
    if (!cfg.secure) {
      if (/STARTTLS/.test(caps)) {
        await c.cmd('STARTTLS', [220]); sock.removeAllListeners('data');
        sock = tls.connect({ socket: sock, servername: cfg.host }); await new Promise((ok, no) => { sock.once('secureConnect', ok); sock.once('error', no); });
        c = new Conn(sock); caps = (await c.cmd('EHLO erp.local', [250])).lines.join(' ').toUpperCase();
      } else if (cfg.user && !isLocal(cfg.host)) throw new Error('Server does not offer STARTTLS — refusing to send credentials unencrypted');
    }
    if (cfg.user) {
      if (/AUTH[^\n]*LOGIN/.test(caps)) { await c.cmd('AUTH LOGIN', [334]); await c.cmd(b64(cfg.user), [334], 'AUTH'); await c.cmd(b64(cfg.pass || ''), [235], 'AUTH'); }
      else await c.cmd('AUTH PLAIN ' + b64(`\0${cfg.user}\0${cfg.pass || ''}`), [235], 'AUTH');
    }
    await c.cmd(`MAIL FROM:<${cfg.from}>`, [250]);
    for (const r of to) await c.cmd(`RCPT TO:<${r}>`, [250, 251]);
    await c.cmd('DATA', [354]);
    const data = buildMessage({ from: cfg.from, fromName: cfg.fromName, to, subject: msg.subject, html: msg.html, text: msg.text, attachments: msg.attachments, inline: msg.inline }).replace(/^\./gm, '..');
    await c.cmd(data + '\r\n.', [250], 'DATA');
    sock.write('QUIT\r\n');
  } finally { sock.destroy(); }
}

module.exports = { sendMail, validEmail, buildMessage };
