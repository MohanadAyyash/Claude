// Side-menu helpers (no DOM): sections of NAV for a role, which section a page is in, and the "Go to" search.
// Loaded by the browser before app.js and required by test-nav.js in Node.
// A NAV row is [route, ar, en, roles]; a '#' row starts a group.
const NAV_TAIL = ['notifications', 'settings'];                           // kept outside the last group, always visible

// lower-case, no tashkeel / tatweel, one spelling for alef, taa marbuta and alef maqsura, so «اجازات» finds «الإجازات»
function navNorm(s) {
  return String(s || '').toLowerCase().replace(/[ً-ْٰـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/\s+/g, ' ').trim();
}

// [{ key, ar, en, items }]: key null for the loose links before the first group and the tail; empty sections dropped
function navTree(nav, ok) {
  const out = [], head = { key: null, ar: '', en: '', items: [] }, tail = { key: null, ar: '', en: '', items: [] };
  let cur = head;
  for (const n of nav) {
    if (n[0] === '#') { cur = { key: n[2], ar: n[1], en: n[2], items: [] }; out.push(cur); continue; }
    if (!ok.has(n[0])) continue;
    (NAV_TAIL.includes(n[0]) ? tail : cur).items.push(n);
  }
  return [head, ...out, tail].filter(s => s.items.length);
}

function navGroupOf(sections, route) {
  const r = String(route || '').split('/')[0];
  const s = sections.find(x => x.items.some(n => n[0] === r));
  return s ? s.key : null;
}

function navSearch(sections, query, limit = 9) {
  const q = navNorm(query), out = [];
  for (const section of sections) for (const row of section.items) {
    if (!q || [row[1], row[2], section.ar, section.en].some(t => navNorm(t).includes(q))) out.push({ row, section });
  }
  return out.slice(0, limit);
}

if (typeof module === 'object' && module.exports) module.exports = { NAV_TAIL, navNorm, navTree, navGroupOf, navSearch };
