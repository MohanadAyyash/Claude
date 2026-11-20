const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('public/copilot.js', 'utf8');

function widgetFor(statusResponse, history = []) {
  const host = { innerHTML: '' };
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      id, value: '', dataset: {}, addEventListener() {}, focus() {}, click() {}, requestSubmit() {},
    });
    return elements.get(id);
  };
  const storage = new Map([['trigon-copilot-open-7', '1'], ['trigon-copilot-conversation-7', 'thread-1']]);
  const document = {
    getElementById: id => id === 'copilot-root' ? host : element(id),
    querySelectorAll: () => [],
    addEventListener() {},
  };
  const requests = [];
  const fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith('/copilot/status')) return statusResponse;
    if (url.endsWith('/copilot/conversations')) return { ok: true, status: 200, json: async () => [
      { id: 'thread-1', title: 'XSS test', updated_at: Date.now() },
    ] };
    if (url.includes('/copilot/history?')) return { ok: true, status: 200, json: async () => history };
    if (url.endsWith('/copilot/memory')) return { ok: true, status: 200, json: async () => ({
      items: [], preferences: {}, personalization_enabled: true, first_use_notice: false,
    }) };
    throw new Error(`Unexpected mock request: ${url}`);
  };
  const window = {};
  vm.runInNewContext(source, {
    window, document, fetch, URL, localStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key),
    },
    COPILOT_AVAILABLE: true, ME: { id: 7 }, lang: 'en',
    tr: (...values) => values.length > 1 ? values[1] : values[0],
    confirm: () => true, setTimeout, clearTimeout, console,
  });
  return { host, window, requests };
}

(async () => {
  const disabled = widgetFor({ ok: true, status: 200, json: async () => ({ enabled: false }) });
  await disabled.window.mountCopilotWidget();
  assert.equal(disabled.host.innerHTML, '', 'the widget is not rendered when status says Copilot is disabled');

  const denied = widgetFor({ ok: false, status: 403, json: async () => ({ error: 'denied' }) });
  await denied.window.mountCopilotWidget();
  assert.equal(denied.host.innerHTML, '', 'the widget is not rendered when the ERP user is not allowlisted');

  const payload = '<img src=x onerror=alert(1)>';
  const visible = widgetFor({ ok: true, status: 200, json: async () => ({ enabled: true }) }, [{
    id: 42, question: payload, answer: payload, intent: 'project_status', created_at: Date.now(),
    data: [{ id: 1, name: payload, href: '#projects/1' }],
  }]);
  await visible.window.mountCopilotWidget();
  assert.match(visible.host.innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.ok(!visible.host.innerHTML.includes(payload), 'message and ERP record XSS payloads are rendered as text');
  assert.match(visible.host.innerHTML, /<section id="tc-window"/, 'an authorized user can see the floating chat window');
  assert.deepEqual(visible.requests.map(item => item.url.split('?')[0]), [
    '/api/copilot/status', '/api/copilot/conversations', '/api/copilot/history', '/api/copilot/memory',
  ]);
  const renderedCard = visible.window.TrigonCopilotWidget.recordCardHtml({ id: 1, name: payload, href: '#projects/1' });
  assert.ok(renderedCard.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!renderedCard.includes(payload), 'record card titles are escaped independently');
  console.log('COPILOT UI TESTS PASSED');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
