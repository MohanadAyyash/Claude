// Local health monitor and alert transitions: node --no-warnings test-health-monitor.js
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const { runMonitor } = require('./scripts/health-monitor');
const { notifyTeams, probeHealth } = require('./lib/opsmonitor');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-health-monitor-'));
let healthy = true;
const issues = [], teams = [], comments = [];
let failNextRecovery = false, recoveryAttempts = 0;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    const url = new URL(req.url, 'http://localhost');
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (url.pathname === '/api/health') return healthy ? json(200, { ok: true, db: 'ok' }) : json(503, { ok: false, db: 'error' });
    if (url.pathname === '/teams/hook') {
      const message = JSON.parse(body);
      if (message.attachments[0].content.body[0].text.includes('recovered')) {
        recoveryAttempts++;
        if (failNextRecovery) { failNextRecovery = false; res.writeHead(503); return res.end(); }
      }
      teams.push(message); res.writeHead(200); return res.end('ok');
    }
    if (url.pathname === '/api/repos/o/r/issues' && req.method === 'GET') return json(200, issues.filter(i => i.state === 'open'));
    if (url.pathname === '/api/repos/o/r/issues' && req.method === 'POST') {
      const issue = { number: issues.length + 1, state: 'open', ...JSON.parse(body) }; issues.push(issue); return json(201, issue);
    }
    if (/^\/api\/repos\/o\/r\/issues\/\d+\/comments$/.test(url.pathname)) { comments.push(JSON.parse(body)); return json(201, { id: comments.length }); }
    json(404, { error: 'not found' });
  });
});

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port, api = `http://127.0.0.1:${port}/api`;
  const env = {
    ...process.env,
    DATA_DIR: dataDir,
    PORT: String(port),
    GITHUB_REPORT_TOKEN: 'test-token',
    GITHUB_REPORT_REPO: 'o/r',
    GITHUB_REPORT_API: api,
    M365_TEAMS_WEBHOOK_URL: `http://127.0.0.1:${port}/teams/hook`,
    M365_TEAMS_EXTRA_HOSTS: '127.0.0.1',
  };
  const now = () => new Date('2026-11-21T18:00:00.000Z');
  try {
    const first = await runMonitor({ env, fetchImpl: fetch, now });
    assert.equal(first.status, 'ok'); assert.deepEqual(first.events, []);
    assert.equal(issues.length, 0); assert.equal(teams.length, 0);

    healthy = false;
    const down = await runMonitor({ env, fetchImpl: fetch, now });
    assert.equal(down.status, 'fail'); assert.equal(issues.length, 1); assert.equal(teams.length, 1);
    assert.match(issues[0].title, /^Health monitor FAIL/);
    assert.match(teams[0].attachments[0].content.body[0].text, /not responding/);

    const stillDown = await runMonitor({ env, fetchImpl: fetch, now });
    assert.equal(stillDown.changed, false); assert.equal(issues.length, 1); assert.equal(teams.length, 1);
    console.log('✔ outage opens one GitHub issue and sends one Teams alert');

    healthy = true;
    failNextRecovery = true;
    const recovered = await runMonitor({ env, fetchImpl: fetch, now });
    assert.equal(recovered.status, 'ok'); assert.equal(recovered.errors.length, 1); assert.equal(teams.length, 1);
    assert.equal(comments.length, 1); assert.match(comments[0].body, /responding again/);
    await runMonitor({ env, fetchImpl: fetch, now });
    assert.equal(teams.length, 2); assert.match(teams[1].attachments[0].content.body[0].text, /recovered/);
    await runMonitor({ env, fetchImpl: fetch, now });
    assert.equal(teams.length, 2); assert.equal(comments.length, 1);
    console.log('✔ failed recovery notifications retry once delivered; incident issues are not auto-closed');

    const unhealthy = await probeHealth(port, { fetchImpl: async () => new Response('bad', { status: 503 }) });
    assert.deepEqual(unhealthy, { ok: false, detail: 'Health endpoint returned HTTP 503' });
    await assert.rejects(() => notifyTeams('down', now().toISOString(), { url: 'http://127.0.0.1:3000/hook', extraHosts: [], fetchImpl: fetch }), /not an allowed Microsoft destination/);
    console.log('✔ unhealthy responses and disallowed webhook destinations are handled safely');
    console.log('HEALTH MONITOR TESTS PASSED');
  } catch (e) { console.error('FAIL', e); process.exitCode = 1; }
  finally { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); setTimeout(() => process.exit(process.exitCode || 0), 100); }
});
