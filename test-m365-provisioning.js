// Microsoft 365 provisioning tool (scripts/setup-m365-production.ps1, scripts/rollback-m365-provisioning.ps1, scripts/m365-provisioning.psm1).
//   node --no-warnings test-m365-provisioning.js
// 1. Static checks in Node: the PowerShell validation rules are the same as lib/m365graph.js, the .env names it prints are the ones the
//    ERP reads, the scripts are ASCII (Windows PowerShell 5.1 reads BOM-less files as ANSI), default mode is the dry run.
// 2. The behaviour suite (scripts/tests/m365-provisioning.tests.ps1: mocked Graph tenant, fake IDs/secrets, no network) under PowerShell
//    (pwsh, or powershell on Windows). Without PowerShell it is skipped locally and REQUIRED in CI (GitHub's ubuntu runners have pwsh).
'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert'), { spawnSync } = require('child_process');
const G = require('./lib/m365graph');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const rd = f => fs.readFileSync(path.join(__dirname, f), 'utf8');
const psm = rd('scripts/m365-provisioning.psm1'), setup = rd('scripts/setup-m365-production.ps1'), rollback = rd('scripts/rollback-m365-provisioning.ps1');
const tests = rd('scripts/tests/m365-provisioning.tests.ps1'), graph = rd('lib/m365graph.js');

// --- the same ID rules as lib/m365graph.js (text of the regexes, and behaviour on samples)
const jsSite = graph.match(/const SITE_ID = \/(.+)\/i;/)[1], jsOpaque = graph.match(/const OPAQUE_ID = \/(.+)\/;/)[1];
const psSite = psm.match(/\$script:SiteIdRe = '(.+)'/)[1], psOpaque = psm.match(/\$script:OpaqueIdRe = '(.+)'/)[1];
ok(jsSite === psSite, `site ID rule differs: js ${jsSite} ps ${psSite}`);
ok(jsOpaque === psOpaque, `drive ID rule differs: js ${jsOpaque} ps ${psOpaque}`);
ok(G.validSiteId('contoso.sharepoint.com,0f0f0f0f-1111-2222-3333-444444444444,5e5e5e5e-1111-2222-3333-444444444444') && !G.validSiteId('contoso.sharepoint.com/sites/x'), 'js samples (site)');
ok(G.validDriveId('b!FakeDriveId_ForTests-123') && !G.validDriveId('b!bad/drive'), 'js samples (drive)');
ok(tests.includes("'contoso.sharepoint.com,0f0f0f0f-1111-2222-3333-444444444444,5e5e5e5e-1111-2222-3333-444444444444'") && tests.includes("'b!bad/drive'"), 'PowerShell tests use the same samples');

// --- the .env names printed are exactly the ones the ERP reads
const printed = [...psm.matchAll(/W '#? ?(M365_[A-Z_]+)=/g)].map(m => m[1]).concat([...psm.matchAll(/W \('(M365_[A-Z_]+)=/g)].map(m => m[1]));
const example = rd('.env.example'), biz = rd('modules/m365business.js') + rd('modules/microsoft365.js');
for (const k of new Set(printed)) { ok(example.includes(k + '=') && biz.includes(k), `${k} is a real ERP setting`); }
for (const k of ['M365_SHAREPOINT_ENABLED', 'M365_SHAREPOINT_SITE_ID', 'M365_SHAREPOINT_DRIVE_ID', 'M365_SHAREPOINT_ROOT', 'M365_OUTLOOK_ENABLED', 'M365_TEAMS_WEBHOOK_URL']) ok(printed.includes(k), `env block prints ${k}`);

// --- safety properties visible in the source
for (const [name, src] of [['psm1', psm], ['setup', setup], ['rollback', rollback], ['tests', tests]]) ok(!/[^\x00-\x7f]/.test(src), `${name} is ASCII`);
ok(/\$doApply = \$Apply -and -not \$DryRun -and -not \$WhatIfPreference/.test(setup) && /\$doApply = \$Apply -and -not \$DryRun -and -not \$WhatIfPreference/.test(rollback), 'dry run unless -Apply (and -DryRun / -WhatIf win)');
ok(/SupportsShouldProcess/.test(setup) && /SupportsShouldProcess/.test(rollback), '-WhatIf supported');
ok(/if \(-not \$script:Apply\) \{ throw "Internal safety stop/.test(psm), 'mutating Graph calls are refused in dry run');
ok(!/passwordCredentials|keyCredentials/.test(psm.replace(/^\s*#.*$/gm, '')), 'never selects / reads app secrets from Graph');
ok(!/M365_CLIENT_SECRET'\]|M365_ENCRYPTION_KEY'\]\s*=/.test(psm) && /SecretsSet\[\$k\] = \$isSet/.test(psm), 'secrets only checked for presence');
ok(/ContextScope = 'Process'/.test(setup) && /ContextScope = 'Process'/.test(rollback), 'the admin token is not cached on disk');
ok(!/DELETE \('\/applications/.test(psm), 'the rollback never deletes the app registration');
// real-Graph query rules (the real-tenant 400 of 855c84e): Invoke-MgGraphRequest turns a bare "search=" into "$search=", and "$search=*"
// is a Graph syntax error; listing every site is not available with a delegated sign-in. Code lines only (comments may explain it).
const code = psm.replace(/^\s*#.*$/gm, '').replace(/#[^'"\n]*$/gm, '');
ok(!/[?&]search=/.test(code), 'no bare search= query (the Graph SDK rewrites it to $search=)');
ok(!/EscapeDataString\('\*'\)|\$search=\*|search=%2A/.test(code), 'no $search=* (HTTP 400 on real Graph)');
ok(!/getAllSites/.test(code), 'no getAllSites (application permission only)');
ok(!/ConsistencyLevel|\$count|endswith\(/.test(code), 'no advanced directory queries (they need ConsistencyLevel: eventual)');
ok(/function Convert-LikeGraphSdk/.test(tests) && /REGRESSION \(real tenant 400\)/.test(tests) && /Syntax error: character '\{0\}' is not valid at position 0/.test(tests), 'the mock applies the SDK rewrite and reproduces the Graph 400');
const steps = (psm.match(/Set-TGStep /g) || []).length;
ok(steps >= 25, 'every Graph call group is labelled with a step (' + steps + ')');
ok(/x-ms-ags-diagnostic/.test(tests) && /\{\\s\*"error"\\s\*:/.test(psm), 'error bodies are found after headers that contain JSON');
const added = [...psm.matchAll(/toAdd \+= \[pscustomobject\]@\{ name = '([^']+)'[^}]*type = '(\w+)'/g)].map(m => m[1] + '/' + m[2]);
ok(added.length === 2 && added.includes('Sites.Selected/Role') && added.includes('Mail.Send/Scope'), 'only Sites.Selected (Application) and Mail.Send (Delegated) can be added: ' + added);
ok(/roles = @\('write'\)/.test(psm) && !/roles = @\('(owner|fullcontrol)'\)/.test(psm), 'site grant is write, never owner / full control');
ok(/visibility = 'Private'/.test(psm), 'a new site is private');
ok(/StatePath = 'C:\\ERP\\data\\m365-provisioning-state\.json'/.test(setup), 'state file in data\\ (kept by Trigon-Update)');

// --- behaviour suite under PowerShell
const shells = process.platform === 'win32' ? ['pwsh', 'powershell'] : ['pwsh'];
let ran = false;
for (const sh of shells) {
  const r = spawnSync(sh, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'scripts', 'tests', 'm365-provisioning.tests.ps1')], { encoding: 'utf8', timeout: 300000 });
  if (r.error && r.error.code === 'ENOENT') continue;
  ran = true;
  process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || '');
  ok(r.status === 0, `PowerShell provisioning tests failed under ${sh} (exit ${r.status})`);
  // the real entry point, without the Microsoft Graph module: stops before any sign-in, explains how to install it, exit 2
  const probe = spawnSync(sh, ['-NoProfile', '-NonInteractive', '-Command', 'if (Get-Module -ListAvailable Microsoft.Graph.Authentication) { exit 9 } else { exit 0 }'], { encoding: 'utf8' });
  if (probe.status === 0) {
    const e = spawnSync(sh, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'scripts', 'setup-m365-production.ps1'), '-EnvPath', path.join(__dirname, 'no-such.env')], { encoding: 'utf8', timeout: 60000 });
    ok(e.status === 2 && /Install-Module Microsoft\.Graph\.Authentication/.test(e.stdout) && !/Signing in/.test(e.stdout), 'setup without the Graph module: clear message, no sign-in, exit 2 (' + e.status + ')');
  }
  break;
}
if (!ran) {
  if (process.env.CI) { console.error('PowerShell (pwsh) is required in CI for the provisioning tests'); process.exit(1); }
  console.log('PowerShell not found: the behaviour suite was SKIPPED (static checks only). Install pwsh to run it.');
}
console.log(`m365 provisioning: ${n} checks passed${ran ? ' (+ PowerShell suite)' : ''}`);
