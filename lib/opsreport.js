// Sends a failing daily-check report to GitHub as an issue labelled "ops-report", which wakes the maintenance agent
// (.github/workflows/claude.yml). At most one open ops-report issue: while one is open, later reports are added as comments
// (comments do not wake the agent again), so a problem that persists costs one agent run, not one a day.
//
// The repository may be public: the issue carries check titles, counts, document numbers, record ids and error paths only.
// Error messages are redacted (quoted text and long numbers removed) because a parser error can echo part of a request.
const LABEL = 'ops-report';
const GITHUB_TIMEOUT_MS = 10_000;

const redact = s => String(s ?? '')
  .replace(/\((reading|setting) '([\w$]{1,40})'\)/g, '($1 \u0001$2\u0001)')   // keep the property name of a TypeError — code, not data
  .replace(/["'`][\s\S]*$/, '"…"')                     // drop everything from the first other quote on (JSON.parse, SQLite… can echo user data)
  .replace(/\u0001/g, "'")
  .replace(/\d{5,}/g, '#')                              // IBANs, Emirates IDs, phone numbers, amounts with many digits
  .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '<email>')
  .slice(0, 300);

// Only failures — and new server errors — are worth an agent run. Plain warnings (numbering gaps, payroll rows to review)
// stay in the local report for a person to look at.
const needsAttention = report => report.results.some(r => r.status === 'fail' || (r.id === 'errors_24h' && r.status !== 'ok'));

function formatIssue(report) {
  const day = report.time.slice(0, 10), icon = { ok: '✅', warn: '⚠️', fail: '❌' };
  const heading = report.source === 'health-monitor' ? 'Health monitor' : 'Daily check';
  const lines = [`Automatic ${heading.toLowerCase()} from the production server — ${report.time}`, '', '| | Check | Result |', '|---|---|---|'];
  for (const r of report.results) lines.push(`| ${icon[r.status]} | ${r.title} | ${redact(r.detail).replace(/\|/g, '/') || '—'} |`);
  for (const r of report.results.filter(x => x.status !== 'ok' && x.items?.length)) {
    lines.push('', `**${r.title}**`, '```', ...r.items.slice(0, 20).map(redact), '```');
  }
  lines.push('', '---', 'Maintenance agent: find the cause in the code, fix it with a test, and open a pull request. Do not change data.',
    'Stack traces are on the server (`GET /api/ops/errors`, administrator) — ask the owner in a comment if you need one.',
    'If the problem is in the data rather than the code, explain what an administrator should check in the app and do not open a pull request.');
  return { title: `${heading} ${report.status.toUpperCase()} — ${day}`, body: lines.join('\n') };
}

async function reportToGitHub(report, { token, repo, api = 'https://api.github.com', fetch = globalThis.fetch } = {}) {
  if (!token || !repo) return { skipped: 'GITHUB_REPORT_TOKEN / GITHUB_REPORT_REPO not set' };
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('GITHUB_REPORT_REPO must look like owner/name');
  if (!needsAttention(report)) return { skipped: 'nothing needs attention' };
  const gh = async (method, path, body) => {
    const r = await fetch(api + path, { method, body: body && JSON.stringify(body), signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'erp-daily-check', ...(body ? { 'Content-Type': 'application/json' } : {}) } });
    if (!r.ok) throw new Error(`GitHub ${method} ${path} → ${r.status}`);
    return r.json();
  };
  const { title, body } = formatIssue(report);
  const open = (await gh('GET', `/repos/${repo}/issues?state=open&labels=${LABEL}&per_page=1`)).filter(i => !i.pull_request)[0];
  if (open) {
    await gh('POST', `/repos/${repo}/issues/${open.number}/comments`, { body: `### ${title}\n\n${body}` });
    return { commented: open.number };
  }
  const created = await gh('POST', `/repos/${repo}/issues`, { title, body, labels: [LABEL] });
  return { created: created.number };
}

async function reportRecoveryToGitHub(time, { token, repo, api = 'https://api.github.com', fetch = globalThis.fetch } = {}) {
  if (!token || !repo) return { skipped: 'GITHUB_REPORT_TOKEN / GITHUB_REPORT_REPO not set' };
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('GITHUB_REPORT_REPO must look like owner/name');
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'erp-health-monitor' };
  const list = await fetch(api + `/repos/${repo}/issues?state=open&labels=${LABEL}&per_page=1`, { headers, signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS) });
  if (!list.ok) throw new Error(`GitHub GET ops report issue → ${list.status}`);
  const issue = (await list.json()).find(i => !i.pull_request);
  if (!issue) return { skipped: 'no open ops-report issue' };
  const response = await fetch(api + `/repos/${repo}/issues/${issue.number}/comments`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: `### Health monitor recovered — ${String(time).slice(0, 40)}\n\nThe local health endpoint and database are responding again. This incident was not closed automatically; please verify the cause and close it when appropriate.` }),
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`GitHub POST ops report recovery → ${response.status}`);
  return { commented: issue.number };
}

module.exports = { reportToGitHub, reportRecoveryToGitHub, formatIssue, needsAttention, redact, LABEL };
