// Navigation helpers: grouping, search, Arabic normalisation: node --no-warnings test-nav.js
const assert = require('assert');
const { navNorm, navTree, navGroupOf, navSearch } = require('./public/nav.js');

const NAV = [['dashboard', 'لوحة التحكم', 'Dashboard'], ['tasks', 'المهام', 'Tasks'],
  ['#', 'المحاسبة', 'Accounting'], ['ledger', 'دفتر الأستاذ', 'General ledger'], ['journal', 'قيود اليومية', 'Journal entries'],
  ['#', 'الموارد البشرية', 'Human resources'], ['leave', 'الإجازات', 'Leave'], ['payroll', 'الرواتب ونظام حماية الأجور', 'Payroll & WPS'],
  ['#', 'الضرائب والامتثال', 'Tax & compliance'], ['vat', 'ضريبة القيمة المضافة', 'VAT report'],
  ['notifications', 'الإشعارات', 'Notifications'], ['settings', 'الإعدادات', 'Settings']];
const all = new Set(NAV.filter(n => n[0] !== '#').map(n => n[0]));

// Arabic spelling variants and tashkeel do not matter when searching
assert.equal(navNorm('الإجازات'), navNorm('الاجازات'));
assert.equal(navNorm('ضريبة'), navNorm('ضريبه'));
assert.equal(navNorm('مستشفى'), navNorm('مستشفي'));
assert.equal(navNorm('رَوَاتِب'), 'رواتب');
assert.equal(navNorm('  Payroll '), 'payroll');

// sections: leading loose links, one per '#' heading, notifications + settings kept outside the last group
const tree = navTree(NAV, all);
assert.deepEqual(tree.map(s => s.key), [null, 'Accounting', 'Human resources', 'Tax & compliance', null]);
assert.deepEqual(tree[4].items.map(r => r[0]), ['notifications', 'settings']);
assert.deepEqual(tree[3].items.map(r => r[0]), ['vat']);
assert.deepEqual(tree[0].items.map(r => r[0]), ['dashboard', 'tasks']);

// a group with no page the role may open is not shown at all
const t2 = navTree(NAV, new Set(['dashboard', 'leave', 'settings']));
assert.deepEqual(t2.map(s => s.key), [null, 'Human resources', null]);

// which group a route (with or without an id) belongs to
assert.equal(navGroupOf(tree, 'payroll'), 'Human resources');
assert.equal(navGroupOf(tree, 'ledger/5'), 'Accounting');
assert.equal(navGroupOf(tree, 'dashboard'), null);
assert.equal(navGroupOf(tree, 'nope'), null);

// search: Arabic variants, English while the UI is Arabic, group names, empty query, role limits
assert.equal(navSearch(tree, 'اجازات')[0].row[0], 'leave');
assert.equal(navSearch(tree, 'payroll')[0].row[0], 'payroll');
assert.deepEqual(navSearch(tree, 'المحاسبة').map(r => r.row[0]), ['ledger', 'journal']);
assert.equal(navSearch(tree, '').length, Math.min(9, all.size));
assert.equal(navSearch(tree, '', 3).length, 3);
assert.equal(navSearch(tree, 'payroll')[0].section.key, 'Human resources');
assert.equal(navSearch(navTree(NAV, new Set(['dashboard', 'leave'])), 'payroll').length, 0);

// the Trigon look has no emoji icons: every page script uses line icons (ico) and status marks (MK) instead
const fs = require('fs'), path = require('path');
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B50}\u{2B06}\u{2B07}]/u;
for (const f of fs.readdirSync(path.join(__dirname, 'public')).filter(f => f.endsWith('.js'))) {
  fs.readFileSync(path.join(__dirname, 'public', f), 'utf8').split('\n').forEach((l, i) => assert.doesNotMatch(l, EMOJI, `public/${f}:${i + 1} uses an emoji icon`));
}

// every character the screens use is drawn by a Trigon brand font (Archivo, IBM Plex): no browser fallback font
{ const css = fs.readFileSync(path.join(__dirname, 'public', 'fonts', 'fonts.css'), 'utf8');
  const sym = /@font-face\{font-family:"Archivo";font-weight:400;src:url\(trigon-symbols-400\.woff2\)[^}]*unicode-range:([^;}]+)/.exec(css);
  assert.ok(sym, 'arrows and marks come from IBM Plex Sans (trigon-symbols) inside the Archivo family');
  assert.ok(fs.existsSync(path.join(__dirname, 'public', 'fonts', 'trigon-symbols-400.woff2')) && fs.existsSync(path.join(__dirname, 'public', 'fonts', 'trigon-symbols-600.woff2')));
  const inRange = cp => sym[1].split(',').some(r => { const [a, b] = r.trim().replace(/^U\+/i, '').split('-').map(h => parseInt(h, 16)); return cp >= a && cp <= (b || a); });
  for (const ch of ['→', '←', '↳', '✓', '≠']) assert.ok(inRange(ch.codePointAt(0)), ch + ' covered');
  for (const f of fs.readdirSync(path.join(__dirname, 'public')).filter(f => f.endsWith('.js')))
    fs.readFileSync(path.join(__dirname, 'public', f), 'utf8').split('\n').forEach((l, i) => { if (!/^\s*\/\//.test(l)) assert.doesNotMatch(l, /[⋯⏳⏹▶]/, `public/${f}:${i + 1} uses a symbol no brand font has`); });
}

// the client's quotation-acceptance page (public/qa.css, modules/sales.js) uses the brand fonts and only characters they have
{ const qa = fs.readFileSync(path.join(__dirname, 'public', 'qa.css'), 'utf8'), sales = fs.readFileSync(path.join(__dirname, 'modules', 'sales.js'), 'utf8');
  assert.match(qa, /#qa,\.qa-done\{[^}]*font-family:"Archivo","IBM Plex Sans Arabic"/); assert.match(qa, /#qa button,#qa input,#qa textarea\{font:inherit\}/);
  assert.doesNotMatch(sales, /✔/, 'no heavy check mark (not in the brand fonts) on the client page'); }

console.log('test-nav: all passed');
