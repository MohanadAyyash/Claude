// Daily-check → GitHub issue for the maintenance agent: node --no-warnings test-opsreport.js
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), assert = require('assert'), { execFile } = require('child_process');
const { reportToGitHub, formatIssue, needsAttention, redact } = require('./lib/opsreport');

const R = (status, extra = {}) => ({ status, time: '2026-11-12T03:00:00.000Z', results: [
  { id: 'trial_balance', title: 'Trial balance', status: 'ok', detail: '' },
  { id: 'invoice_numbers', title: 'Invoice numbers', status: extra.inv || 'ok', detail: '', items: extra.invItems },
  { id: 'errors_24h', title: 'Server errors', status: extra.err || 'ok', detail: '', items: extra.errItems },
] });

// fake GitHub API: records calls, keeps issues in memory
const calls = [], issues = [];
const gh = http.createServer((req, res) => {
  let b = ''; req.on('data', c => b += c); req.on('end', () => {
    calls.push({ m: req.method, u: req.url, auth: req.headers.authorization, body: b ? JSON.parse(b) : null });
    const j = (s, x) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(x)); };
    if (req.method === 'GET' && /\/issues\?state=open&labels=ops-report/.test(req.url)) return j(200, issues.filter(i => i.state === 'open'));
    if (req.method === 'POST' && /\/repos\/o\/r\/issues$/.test(req.url)) { const i = { number: issues.length + 1, state: 'open', ...JSON.parse(b) }; issues.push(i); return j(201, i); }
    if (req.method === 'POST' && /\/issues\/\d+\/comments$/.test(req.url)) return j(201, { id: 1 });
    j(404, {});
  });
});

gh.listen(0, async () => {
  const api = `http://localhost:${gh.address().port}`, opt = { token: 'tkn', repo: 'o/r', api };
  try {
    // redaction: request fragments, long numbers and e-mails never reach the issue
    assert.equal(redact(`Unexpected token 'x', "{"iban":"AE070331234567890123456"}" is not valid JSON`), 'Unexpected token "…"');
    assert.equal(redact(`Cannot read properties of undefined (reading 'name')`), `Cannot read properties of undefined (reading 'name')`);
    assert.equal(redact('employee 784199012345678 at a@b.ae'), 'employee # at <email>');
    const body = formatIssue(R('fail', { inv: 'fail', invItems: ['INV-2026-005'], err: 'warn', errItems: ['3× /api/x — bad "secret-value" AE070331234567890123456'] })).body;
    assert.ok(body.includes('INV-2026-005')); assert.ok(!body.includes('secret-value')); assert.ok(!body.includes('0331234567890123456'));
    console.log('✔ issue text is redacted (quoted fragments, long numbers, e-mails)');

    // what wakes the agent: failures and server errors, not plain warnings
    assert.equal(needsAttention(R('ok')), false);
    assert.equal(needsAttention(R('warn', { inv: 'warn' })), false);
    assert.equal(needsAttention(R('warn', { err: 'warn' })), true);
    assert.equal(needsAttention(R('fail', { inv: 'fail' })), true);
    assert.deepEqual(await reportToGitHub(R('fail', { inv: 'fail' }), {}), { skipped: 'GITHUB_REPORT_TOKEN / GITHUB_REPORT_REPO not set' });
    assert.deepEqual(await reportToGitHub(R('warn', { inv: 'warn' }), opt), { skipped: 'nothing needs attention' });
    assert.equal(calls.length, 0);
    console.log('✔ only failures / server errors are sent; nothing without a token');

    // first failure opens one labelled issue; the next ones only comment on it
    assert.deepEqual(await reportToGitHub(R('fail', { inv: 'fail' }), opt), { created: 1 });
    assert.deepEqual(issues[0].labels, ['ops-report']); assert.match(issues[0].title, /^Daily check FAIL — 2026-11-12$/);
    assert.equal(calls.at(-1).auth, 'Bearer tkn');
    assert.deepEqual(await reportToGitHub(R('fail', { inv: 'fail' }), opt), { commented: 1 });
    assert.equal(issues.length, 1);
    issues[0].state = 'closed';
    assert.deepEqual(await reportToGitHub(R('fail', { inv: 'fail' }), opt), { created: 2 });
    console.log('✔ one open ops-report issue at a time: new issue, then comments, new issue after it is closed');

    // end to end: the CLI on a broken database reports to GitHub and still writes the local report
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-opsrep-'));
    { process.env.DATA_DIR = dataDir; process.env.ZOHO_NO_SCHEDULER = '1'; process.env.SALES_NO_SCHEDULER = '1';
      const { ctx, server } = require('./server.js'); server.close();
      ctx.db.prepare("INSERT INTO journal_entries(date,memo,lines) VALUES('2026-01-01','bad',?)").run(JSON.stringify([{ account: '1000', debit: 100, credit: 0 }])); }
    issues.length = 0;
    const out = await new Promise(ok => execFile(process.execPath, ['--no-warnings', 'scripts/daily-check.js'],
      { env: { ...process.env, DATA_DIR: dataDir, GITHUB_REPORT_TOKEN: 'tkn', GITHUB_REPORT_REPO: 'o/r', GITHUB_REPORT_API: api } }, (e, stdout) => ok({ code: e ? e.code : 0, stdout })));
    assert.equal(out.code, 1); assert.match(out.stdout, /github: opened issue #1/);
    assert.ok(issues[0].body.includes('JV-1'));
    assert.equal(fs.readdirSync(path.join(dataDir, 'ops')).length, 1);
    console.log('✔ scripts/daily-check.js opens the GitHub issue on failure');
    console.log('OPS REPORT TESTS PASSED');
  } catch (e) { console.error('FAIL', e); process.exitCode = 1; }
  finally { gh.close(); setTimeout(() => process.exit(process.exitCode || 0), 100); }
});
