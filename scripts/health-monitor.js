'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { configuredPort } = require('./port');
const { probeHealth, notifyTeams } = require('../lib/opsmonitor');
const { reportToGitHub, reportRecoveryToGitHub } = require('../lib/opsreport');

const APP_DIR = path.join(__dirname, '..');
const STATE_NAME = 'health-monitor.json';

function readState(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || !['ok', 'fail'].includes(value.status)) throw new Error();
    return value;
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new Error('Health monitor state is unreadable; inspect the local ops state file');
  }
}

function writeState(file, state) {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}

function appendLog(file, lines) {
  if (!lines.length) return;
  fs.appendFileSync(file, `${lines.map(x => `${new Date().toISOString()} ${x}`).join('\n')}\n`, { mode: 0o600 });
  if (fs.statSync(file).size > 1024 * 1024) {
    const text = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, text.slice(-512 * 1024), { mode: 0o600 });
  }
}

async function runMonitor({ appDir = APP_DIR, env = process.env, fetchImpl = globalThis.fetch, now = () => new Date() } = {}) {
  const port = configuredPort(appDir, env);
  const dataDir = path.resolve(appDir, env.DATA_DIR || 'data');
  const opsDir = path.join(dataDir, 'ops');
  fs.mkdirSync(opsDir, { recursive: true });
  const stateFile = path.join(opsDir, STATE_NAME);
  const previous = readState(stateFile);
  const checkedAt = now().toISOString();
  const health = await probeHealth(port, { fetchImpl });
  const status = health.ok ? 'ok' : 'fail';
  const changed = !previous || previous.status !== status;
  const recovering = status === 'ok' && previous?.status === 'fail';
  const state = changed
    ? {
      status,
      since: checkedAt,
      githubNotified: recovering && previous.githubNotified,
      teamsNotified: recovering && previous.teamsNotified,
      recoveryPending: recovering,
      recoveryGithubNotified: false,
      recoveryTeamsNotified: false,
    }
    : previous;
  const errors = [], events = [];

  if (status === 'fail') {
    if (env.GITHUB_REPORT_TOKEN && env.GITHUB_REPORT_REPO && !state.githubNotified) {
      try {
        await reportToGitHub({
          source: 'health-monitor',
          status: 'fail',
          time: checkedAt,
          results: [{ id: 'server_health', title: 'ERP server health', status: 'fail', detail: health.detail }],
        }, { token: env.GITHUB_REPORT_TOKEN, repo: env.GITHUB_REPORT_REPO, api: env.GITHUB_REPORT_API, fetch: fetchImpl });
        state.githubNotified = true;
        events.push('GitHub incident reported');
      } catch {
        errors.push('GitHub incident report failed');
      }
    }
    if (env.M365_TEAMS_WEBHOOK_URL && !state.teamsNotified) {
      try {
        await notifyTeams('down', checkedAt, {
          url: env.M365_TEAMS_WEBHOOK_URL,
          extraHosts: String(env.M365_TEAMS_EXTRA_HOSTS || '').split(',').map(x => x.trim()).filter(Boolean),
          fetchImpl,
        });
        state.teamsNotified = true;
        events.push('Teams outage alert sent');
      } catch (e) {
        errors.push(e.message);
      }
    }
  } else if (state.recoveryPending) {
    if (env.GITHUB_REPORT_TOKEN && env.GITHUB_REPORT_REPO && state.githubNotified && !state.recoveryGithubNotified) {
      try {
        await reportRecoveryToGitHub(checkedAt, {
          token: env.GITHUB_REPORT_TOKEN,
          repo: env.GITHUB_REPORT_REPO,
          api: env.GITHUB_REPORT_API,
          fetch: fetchImpl,
        });
        state.recoveryGithubNotified = true;
        events.push('GitHub recovery recorded');
      } catch {
        errors.push('GitHub recovery report failed');
      }
    }
    if (env.M365_TEAMS_WEBHOOK_URL && state.teamsNotified && !state.recoveryTeamsNotified) {
      try {
        await notifyTeams('recovered', checkedAt, {
          url: env.M365_TEAMS_WEBHOOK_URL,
          extraHosts: String(env.M365_TEAMS_EXTRA_HOSTS || '').split(',').map(x => x.trim()).filter(Boolean),
          fetchImpl,
        });
        state.recoveryTeamsNotified = true;
        events.push('Teams recovery alert sent');
      } catch (e) {
        errors.push(e.message);
      }
    }
    const githubDone = !env.GITHUB_REPORT_TOKEN || !env.GITHUB_REPORT_REPO || !state.githubNotified || state.recoveryGithubNotified;
    const teamsDone = !env.M365_TEAMS_WEBHOOK_URL || !state.teamsNotified || state.recoveryTeamsNotified;
    state.recoveryPending = !(githubDone && teamsDone);
  }

  writeState(stateFile, state);
  if (changed || errors.length || events.length) appendLog(path.join(opsDir, 'health-monitor.log'), [
    ...(changed ? [`Health ${status.toUpperCase()}: ${health.detail}`, ...events] : []),
    ...errors.map(x => `Notification error: ${x}`),
  ]);
  return { ok: health.ok, changed, status, detail: health.detail, events, errors };
}

async function main() {
  try { process.loadEnvFile(path.join(APP_DIR, '.env')); } catch { /* no .env */ }
  try {
    const result = await runMonitor();
    if (result.changed) console.log(`Health monitor ${result.status}: ${result.detail}`);
    for (const event of result.events) console.log(event);
    for (const error of result.errors) console.error(error);
    if (!result.ok || result.errors.length) process.exitCode = 1;
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = { runMonitor };
