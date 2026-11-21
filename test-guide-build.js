// Regression test: the searchable guides build from the bilingual Markdown sources.
const fs = require('node:fs'), assert = require('node:assert'), { execFileSync } = require('node:child_process');

execFileSync(process.execPath, ['tools/build-guide.js'], { stdio: 'inherit' });
const html = fs.readFileSync('public/guide/index.html', 'utf8');
assert.ok(html.includes('Trigon Copilot (read-only assistant)'), 'English Copilot guide is searchable');
assert.ok(html.includes('مساعد Trigon للقراءة فقط'), 'Arabic Copilot guide is searchable');
console.log('GUIDE BUILD TESTS PASSED');
