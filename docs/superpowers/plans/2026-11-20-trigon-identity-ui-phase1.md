# Trigon Identity UI — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapsible, identity-styled navigation shell that keeps its scroll position, a "Go to" (Ctrl+K) page finder, and Trigon brand styling on all shared UI elements.

**Architecture:** Pure navigation helpers (grouping, search, Arabic normalisation) go in a new browser/Node-dual file `public/nav.js`, tested in Node. `shell()` in `public/app.js` renders the frame once; route changes only re-mark the active link and call `render()`. Styling is token-based in `public/style.css`. A headless-Chrome test driven over the DevTools protocol (Node 22 built-in `WebSocket`, no dependencies) proves the shell behaviour.

**Tech Stack:** Plain browser JS/CSS, Node ≥ 22.5 (`node:sqlite`, global `WebSocket`, `fetch`), local brand fonts in `public/fonts`.

**Spec:** `docs/superpowers/specs/2026-11-20-trigon-identity-ui-design.md` (reference prototype: `docs/superpowers/specs/2026-11-20-trigon-identity-ui-prototype.html`, tab «د»)

## Global Constraints
- No new dependencies (runtime or dev). No framework.
- `NAV` in `public/app.js` stays the single source of pages, labels, order and roles; do not change it.
- Do not touch print/PDF rules (`.doc`, `.doc.rep`, `#print-area`, `@media print`, `lib/render.js`, `lib/pdf.js` behaviour).
- Brand colours: Steel Blue `#1F3A5F`, Paper `#F2F1EE`, Stone `#D6D2C8`, Warm Grey `#8A8578`. Fonts: Archivo, IBM Plex Sans Arabic, IBM Plex Mono (already in `public/fonts/fonts.css`).
- Keep `apple-mobile-web-app-status-bar-style=black-translucent` and `theme-color` unchanged; the safe-area strip above the mobile topbar stays Steel Blue.
- All visible text in Arabic and English via `tr(ar, en)`.
- Every fix has a test that fails before it; `npm test` and `npm run build:standalone` must pass. New UI test skips only with `SKIP_UI=1` or when no browser is found (never on `SKIP_PDF`).
- Keep links as `.side a[data-r="<route>"]` — `public/mobile.js` `onShell()` rewrites `a[data-r="notifications"]` by that selector.
- Server code also runs in the browser bundle; `public/nav.js` must not use Node APIs at top level.

## Review Focus
1. Arabic spelling variants in search (أ/إ/آ vs ا, ة vs ه, ى vs ي, tashkeel): «اجازات» must find «الإجازات». → test in Task 1.
2. Arriving at a page in a collapsed group from outside the menu (notification click, SW `go` message, typed hash): its group must open and the link be marked. → test in Task 2.
3. A role whose allowed pages make a group empty: the group heading must not appear (today's behaviour). → test in Task 1.
4. Ctrl+K while a form modal (`.overlay`) is open must do nothing; Esc closes the finder. → test in Task 3.
5. Switching language rebuilds the shell in LTR with the same open group and working toggles. → test in Task 4.

---

### Task 1: Pure navigation helpers (`public/nav.js`)

**Files:**
- Create: `public/nav.js`
- Create: `test-nav.js`
- Modify: `package.json` (`test` script: append `&& node --no-warnings test-nav.js`)
- Modify: `public/index.html` (add `<script src="nav.js"></script>` immediately before `<script src="app.js"></script>`)
- Modify: `public/sw.js` (add `'nav.js'` to `SHELL` right after `'app.js'`)

**Interfaces:**
- Produces (globals in the browser, `module.exports` in Node — guard with `if (typeof module === 'object' && module.exports) module.exports = {...}`):
  - `navNorm(s: string): string` — lower-case, strip Arabic tashkeel (U+064B–U+0652, U+0670) and tatweel (U+0640), map أ إ آ ٱ → ا, ة → ه, ى → ي, collapse whitespace, trim.
  - `navTree(nav: Row[], ok: Set<string>): Section[]` where `Row = [route, ar, en, roles?]` and `Section = { key: string|null, ar: string, en: string, items: Row[] }`. Rows before the first `'#'` row form a leading section with `key: null`. Each `'#'` row starts a section with `key` = its English label. Rows whose route is in `NAV_TAIL = ['notifications', 'settings']` go to a trailing `key: null` section. Rows not in `ok` are dropped; sections with no items are dropped.
  - `navGroupOf(sections: Section[], route: string): string|null` — key of the section containing `route` (first path segment only: `'invoices/12'` → `'invoices'`), or `null`.
  - `navSearch(sections: Section[], query: string, limit = 9): { row: Row, section: Section }[]` — empty query returns the first `limit` rows in menu order; otherwise rows where `navNorm(query)` is a substring of `navNorm` of row ar, row en, section ar or section en, in menu order, capped at `limit`.

- [ ] **Step 1: Write the failing test `test-nav.js`**

Header comment like the other suites (`// Navigation helpers: grouping, search, Arabic normalisation: node --no-warnings test-nav.js`). Use a small fake NAV:
```js
const NAV = [['dashboard','لوحة التحكم','Dashboard'],['tasks','المهام','Tasks'],
  ['#','المحاسبة','Accounting'],['ledger','دفتر الأستاذ','General ledger'],['journal','قيود اليومية','Journal entries'],
  ['#','الموارد البشرية','Human resources'],['leave','الإجازات','Leave'],['payroll','الرواتب ونظام حماية الأجور','Payroll & WPS'],
  ['#','الضرائب والامتثال','Tax & compliance'],['vat','ضريبة القيمة المضافة','VAT report'],
  ['notifications','الإشعارات','Notifications'],['settings','الإعدادات','Settings']];
```
Assertions:
- `navNorm('الإجازات') === navNorm('الاجازات')`, `navNorm('ضريبة') === navNorm('ضريبه')`, `navNorm('مستشفى') === navNorm('مستشفي')`, `navNorm('رَوَاتِب') === 'رواتب'`, `navNorm('  Payroll ') === 'payroll'`.
- all allowed: `navTree(NAV, all).map(s => s.key)` deep-equals `[null, 'Accounting', 'Human resources', 'Tax & compliance', null]`; last section routes `['notifications','settings']`; `'Tax & compliance'` section routes `['vat']`.
- ok = `{dashboard, leave, settings}`: keys `[null, 'Human resources', null]` (empty groups dropped).
- `navGroupOf(tree, 'payroll') === 'Human resources'`, `navGroupOf(tree, 'ledger/5') === 'Accounting'`, `navGroupOf(tree, 'dashboard') === null`.
- `navSearch(tree, 'اجازات')[0].row[0] === 'leave'`; `navSearch(tree, 'payroll')[0].row[0] === 'payroll'`; `navSearch(tree, 'المحاسبة').map(r => r.row[0])` deep-equals `['ledger','journal']` (section-name match); `navSearch(tree, '').length === Math.min(9, total)`; with ok = `{dashboard, leave}` `navSearch(t2, 'payroll').length === 0`.
- End with `console.log('test-nav: all passed')`.

- [ ] **Step 2: Run it to verify it fails**
Run: `node --no-warnings test-nav.js` — Expected: FAIL, `Cannot find module './public/nav.js'`.

- [ ] **Step 3: Implement the four functions in `public/nav.js`** per the Interfaces block. Add the script tag, the `sw.js` entry and the `package.json` test entry.

- [ ] **Step 4: Run to verify it passes**
Run: `node --no-warnings test-nav.js` — Expected: `test-nav: all passed`.

- [ ] **Step 5: Commit** — `git add public/nav.js test-nav.js package.json public/index.html public/sw.js && git commit -m "Navigation helpers: grouping, search with Arabic normalisation"`

---

### Task 2: Shell rendered once, collapsible groups, scroll kept (+ browser test harness)

**Files:**
- Create: `test-ui-shell.js`
- Modify: `public/app.js` (`shell()` around lines 112–129, `window.onhashchange` line 131)
- Modify: `package.json` (append `&& node --no-warnings test-ui-shell.js`)
- Modify: `public/style.css` (only the minimal rules needed for groups to collapse: `.side .g:not(.open) .items{display:none}`; full styling is Task 4)

**Interfaces:**
- Consumes: `navTree`, `navGroupOf` (Task 1).
- Produces:
  - DOM: `<nav class="side">` containing `.brand`, `#goto` placeholder button (wired in Task 3), then per section: `key === null` → links directly; otherwise `<div class="g" data-g="<key>">` with `<button type="button" class="gh" aria-expanded>` (label, `.bar`, `.cnt` = item count) and `<div class="items">` of links. Links stay `<a data-r="route">`, active one has class `on`.
  - `navOpen(key: string|null): void` in `app.js` — opens that group, closes the others, saves `localStorage.navOpen = key` (try/catch).
  - `markRoute(): void` in `app.js` — sets `on` on the link of the current route, opens `navGroupOf(...)` of it when not null, and calls `link.scrollIntoView({block:'nearest'})`.
  - On load, the current route's group wins over `localStorage.navOpen`; if the current route has no group, `localStorage.navOpen` is opened.
  - `window.onhashchange`: `route = location.hash.slice(1) || landing(); if ($('#main')) { markRoute(); render(); if (window.onShell) onShell(); }` — no `shell()` call. `shell()` is still called by `boot()` and language switch.
- Test harness inside `test-ui-shell.js` (used by Tasks 3–4, which add cases to this same file):
  - `const { findBrowser } = require('./lib/pdf')`; skip with `console.log('test-ui-shell: skipped (…)')` and `process.exit(0)` when `process.env.SKIP_UI === '1'` or `findBrowser()` returns nothing.
  - Server as in `test-roles.js` (temp `DATA_DIR`, `require('./server.js')`, `server.listen(0)`), setup admin via `POST /api/setup`, create users via `POST /api/users` (`storekeeper1` role `storekeeper`).
  - `launch()` → spawn browser `--headless=new --no-sandbox --disable-gpu --remote-debugging-port=0 --user-data-dir=<tmp> about:blank`, parse `DevTools listening on (ws://\S+)` from stderr, read `http://127.0.0.1:<port>/json/list` for the page target, connect `new WebSocket(url)`.
  - `cdp(method, params)` (promise keyed by id), `ev(expr)` → `Runtime.evaluate` with `awaitPromise: true, returnByValue: true`, throwing on `exceptionDetails`.
  - `login(user, pass, lang)` → navigate to base URL, `ev` a `fetch('/api/login', …)`, set `localStorage.lang`, reload, wait for `.side`.
  - `waitFor(expr, ms = 5000)` polling `ev`.
  - Viewport `Emulation.setDeviceMetricsOverride({width:1280,height:520,deviceScaleFactor:1,mobile:false})` so the menu scrolls.
  - Always kill the browser and close the server in `finally`.

- [ ] **Step 1: Write the failing test cases (admin, Arabic)**
  1. `scroll kept`: if `.side .g[data-g="Procurement & stock"] .gh` exists click it; set `side.scrollTop = side.scrollHeight`, record `top = side.scrollTop` (assert `> 0`), tag `side.__probe = 1`, click `.side a[data-r="settings"]`, `waitFor` `location.hash === '#settings'` and `#main` non-empty; assert `side.__probe === 1` (same element) and `side.scrollTop === top`; assert `.side a.on` is `settings`.
  2. `collapsed by default`: after a fresh load on `#invoices`, exactly one `.g.open` and its `data-g` is `Projects & sales`; clicking `.g[data-g="Accounting"] .gh` leaves only `Accounting` open and sets its `aria-expanded="true"`.
  3. `opens from outside the menu` (Review Focus 2): `location.hash = 'payroll'` from `ev`; `waitFor` `.g.open` = `Human resources` and `.side a.on` = `payroll`.

- [ ] **Step 2: Run it to verify it fails**
Run: `node --no-warnings test-ui-shell.js` — Expected: FAIL at case 1 (`side.__probe` undefined: the menu was rebuilt).

- [ ] **Step 3: Implement** `shell()` from `navTree(NAV, okSet)`, `navOpen`, `markRoute`, group-header click handler (toggle: clicking the open group closes it), and the new `onhashchange`. Keep the brand block, guide link, language and logout buttons and `.foot` (where `onShell` puts the install button).

- [ ] **Step 4: Run to verify it passes**
Run: `node --no-warnings test-ui-shell.js` — Expected: `test-ui-shell: all passed`. Then `SKIP_PDF=1 npm test` — Expected: all suites pass.

- [ ] **Step 5: Commit** — `git commit -m "Menu keeps its scroll position; groups collapse; browser test for the shell"`

---

### Task 3: "Go to" finder (Ctrl+K)

**Files:**
- Modify: `public/app.js` (in/next to `shell()`)
- Modify: `public/style.css` (finder dialog rules)
- Modify: `test-ui-shell.js` (new cases)

**Interfaces:**
- Consumes: `navTree`, `navSearch` (Task 1); `navOpen`, `markRoute`, `#goto` button (Task 2).
- Produces: `openGoto(): void` — creates `<div class="goto" role="dialog">` with `<input id="gotoq">` and `<div id="gotores">` of `<button data-r>` rows (page label, then section label in `.muted`, both via `tr`). The section label for `key === null` sections is omitted. Keys: ArrowUp/Down move `.sel`, Enter goes to the selected row (`go(route)`), Esc or a click on the backdrop closes it and returns focus to `#goto`. Opening when already open just focuses the input.
- Global `keydown` handler, registered once (guard with a module-level flag, not inside `shell()`): `(e.ctrlKey || e.metaKey) && e.code === 'KeyK'` → `preventDefault()`, then `openGoto()` unless `#modal-root .overlay` exists or the user is not logged in (`!$('.side')`).
- Search always matches both languages (navNorm on ar and en), regardless of `lang`.
- Labels: button `tr('انتقل إلى…', 'Go to…')` with `<kbd>Ctrl K</kbd>`; input placeholder `tr('اكتب اسم الصفحة…', 'Type a page name…')`; empty result `tr('لا توجد صفحة بهذا الاسم', 'No page with that name')`.

- [ ] **Step 1: Write the failing test cases**
  1. admin: dispatch `new KeyboardEvent('keydown', {key:'k', code:'KeyK', ctrlKey:true, bubbles:true})` on `document`; `waitFor` `#gotoq`; set value `رواتب` + `input` event; first `#gotores button` has `data-r="payroll"`; dispatch Enter on `#gotoq`; `waitFor` hash `#payroll`, `.goto` gone, `.g.open` = `Human resources`.
  2. admin: query `payroll` (English while UI is Arabic) → first result `payroll`.
  3. storekeeper1: open finder, query `دفتر` → zero result buttons; query `` (empty) → every `data-r` is in the set of `.side a[data-r]` routes.
  4. (Review Focus 4) admin: insert `<div class="overlay"></div>` into `#modal-root`, send Ctrl+K → after 300 ms `.goto` does not exist; remove the overlay; open finder; send `Escape` on `#gotoq` → `.goto` gone and `document.activeElement.id === 'goto'`.

- [ ] **Step 2: Run to verify they fail** — `node --no-warnings test-ui-shell.js` — Expected: FAIL waiting for `#gotoq`.

- [ ] **Step 3: Implement** `openGoto`, the `#goto` click handler, and the single global key handler.

- [ ] **Step 4: Run to verify they pass** — `node --no-warnings test-ui-shell.js` — Expected: `all passed`.

- [ ] **Step 5: Commit** — `git commit -m "Go to (Ctrl+K): find any allowed page by Arabic or English name"`

---

### Task 4: Trigon identity styling, mobile and English

**Files:**
- Modify: `public/style.css`
- Modify: `public/app.js` (`shell()` brand block: use `logo` instead of `logo_white`; topbar image too)
- Modify: `test-ui-shell.js` (cases below)

**Interfaces / values (from the spec and prototype tab «د»):**
- Tokens on `:root`: `--steel:#1F3A5F; --paper:#F2F1EE; --stone:#D6D2C8; --warm:#8A8578; --side-bg:#E9E7E1; --card:#FBFAF8;` keep existing token names (`--bg --card --ink --mute --line --brand --brand-d --ok --warn --bad`) and remap them to these values so untouched page code keeps working (`--bg:var(--paper)`, `--line:var(--stone)`, `--mute:var(--warm)`, `--ink`/`--brand:var(--steel)`).
- Fonts: body `"IBM Plex Sans Arabic","Archivo",…` as today; headings `h1,h2` and the wordmark `"Archivo","IBM Plex Sans Arabic"`.
- Radius 3–4px on `.btn`, `.card`, `.kpi`, `.tw`, inputs, `.modal`; remove decorative shadows.
- Side: background `--side-bg`, `border-inline-end:1px solid var(--stone)`, text `--steel`. Group bar `.gh .bar` 14×4px Stone → 22×4px Steel when `.g.open`. Active link: Steel, weight 600, `::before` 16×3px Steel bar at the start side, no background.
- Logo: `max-width:180px; max-height:40px; object-fit:contain`. Without a logo: company name + CSS three-bar mark (bars 12.6 / 20 / 27.5 px wide, 4.6px tall, 3.4px gap — ratio of `brand/mark.svg`).
- Page title: `#main .bar:has(h1)` (or a class added in `render()`'s existing bar code) gets `border-bottom:1.5px solid var(--steel); padding-bottom:10px`.
- Tables: `th` no background, `color:var(--warm)`, `border-bottom:1.5px solid var(--steel)`; `td` border Stone; keep `td.n` tabular-nums, end-aligned.
- Mobile (≤800px): `.topbar` background `--side-bg`, text Steel, `padding-top` area painted Steel: `box-shadow: inset 0 env(safe-area-inset-top) 0 var(--steel)` (or an equivalent `::before` of height `env(safe-area-inset-top)`), menu button and bell Steel.
- Do not edit any `.doc`, `.doc.rep`, `@media print`, `#print-area` rule.

- [ ] **Step 1: Write the failing test cases**
  1. (Review Focus 5) admin: login with `lang = 'en'`, assert `document.documentElement.dir === 'ltr'`, `.g[data-g="Accounting"] .gh` text contains `Accounting`; click it → only `Accounting` open; open finder and query `قيود` → first result `journal`.
  2. Styling applied: `getComputedStyle(document.body).backgroundColor === 'rgb(242, 241, 238)'` and `getComputedStyle($('.side')).backgroundColor === 'rgb(233, 231, 225)'`.
  3. Mobile: `Emulation.setDeviceMetricsOverride({width:390,height:800,mobile:true,deviceScaleFactor:2})`, reload; `.topbar` visible, `.side` off-screen; click `#menu` → `.side.open`; click a link in an open group → drawer closes and hash changes.
  4. Print untouched: `getComputedStyle($('#print-area')).display === 'none'`.

- [ ] **Step 2: Run to verify they fail** — Expected: FAIL on case 2 (background colours).
- [ ] **Step 3: Implement the styles and the logo change.** Compare against the prototype tab «د» by screenshot (Arabic desktop, English desktop, 390px phone) once.
- [ ] **Step 4: Run** `node --no-warnings test-ui-shell.js`, `SKIP_PDF=1 npm test`, `npm run build:standalone` — Expected: all pass, build completes.
- [ ] **Step 5: Commit** — `git commit -m "Trigon identity styling for the shell and shared elements"`

---

### Task 5: User guide and final verification

**Files:**
- Modify: `docs/USER-GUIDE-AR.md` (lines ~96 and ~109: side menu description), `docs/USER-GUIDE-EN.md` (~99, ~107)
- Regenerate: `public/guide` via `npm run build:guide`

- [ ] **Step 1:** Describe in both languages: sections open and close by clicking their title; the section of the current page opens by itself; «انتقل إلى… / Go to…» button and Ctrl+K (⌘K on Mac) to jump to any page by typing part of its name. Same facts in both files.
- [ ] **Step 2:** Run `npm run build:guide` — Expected: completes; `git diff --stat public/guide` shows the regenerated guide.
- [ ] **Step 3:** Full check: `SKIP_PDF=1 npm test` and `npm run build:standalone` — Expected: every suite prints passed (test-ui-shell runs, not skipped, in this container), build completes.
- [ ] **Step 4: Commit and push** — `git commit -m "User guide: collapsible menu and Go to (Ctrl+K)"`, `git push -u origin ccr-dbd9eebb-nrzxye`.
