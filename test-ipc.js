// Phase 3: payment certificate (IPC), advance recovery, revenue per worker-day: node --no-warnings test-ipc.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-ipc-'));
process.env.ZOHO_NO_SCHEDULER = '1'; process.env.SALES_NO_SCHEDULER = '1';
const { server } = require('./server.js');

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api/`; let cookie = '';
  const call = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j }; };
  const ok = (r, l) => { assert.equal(r.s, 200, `${l || ''} → ${r.s} ${JSON.stringify(r.j).slice(0, 200)}`); return r.j; };
  const out = [];
  try {
    ok(await call('POST', 'setup', { username: 'admin', password: 'secret12', company: 'Trigon' }));
    ok(await call('PUT', 'settings', { trn: '100123456700003', vat_pct: 5 }));
    const cl = ok(await call('POST', 'parties', { type: 'client', name: 'Client', trn: '100234567800003', address: 'Dubai' })).id;

    // ---- 1. interlock: 1,000 m² × 11, retention 10%; IPC 1 at 40%, IPC 2 at 100%
    const p = ok(await call('POST', 'projects', { name: 'Interlock works', code: 'PRJ-IL', client_id: cl, contract_value: 11000, retention_pct: 10, status: 'active' })).id;
    const bq = ok(await call('POST', 'boq_items', { project_id: p, description: 'Interlock paving 80mm', unit: 'm2', qty: 1000, rate: 11 })).id;
    ok(await call('PUT', 'boq_items/' + bq, { done_pct: 40 }));
    const i1 = ok(await call('POST', `projects/${p}/progress-invoice`, { date: '2026-09-30' })).id;
    ok(await call('PUT', 'boq_items/' + bq, { done_pct: 100 }));
    const i2 = ok(await call('POST', `projects/${p}/progress-invoice`, { date: '2026-10-31' })).id;
    const c = ok(await call('GET', `invoices/${i2}/certificate`));
    const L = c.lines[0];
    assert.equal(c.number, 'IPC-02');
    assert.deepEqual([L.prev_qty, L.prev_amount, L.this_qty, L.this_amount, L.cum_qty, L.cum_amount, L.cum_pct], [400, 4400, 600, 6600, 1000, 11000, 100]);
    assert.deepEqual([c.work.cumulative, c.work.previous, c.work.this], [11000, 4400, 6600]);
    assert.deepEqual([c.retention.cumulative, c.retention.previous, c.retention.this], [1100, 440, 660]);
    assert.equal(c.net, 5940); assert.equal(c.vat, 330); assert.equal(c.due, 6270);
    const inv2 = ok(await call('GET', 'invoices/' + i2)); assert.equal(inv2.due_now, 6270, 'certificate = tax invoice'); assert.equal(inv2.ipc, true);
    out.push(`IPC 2: previous 400 m² = ${L.prev_amount} | this 600 m² = ${L.this_amount} | cumulative 1,000 m² = ${L.cum_amount}`);
    out.push(`retention cumulative ${c.retention.cumulative}, previous ${c.retention.previous}, this ${c.retention.this} | net ${c.net} + VAT ${c.vat} = due ${c.due}`);
    const html = await fetch(base + `doc/ipc/${i2}`, { headers: { cookie } }).then(r => r.text());
    assert.match(html, /Interim Payment Certificate No\. 2/); assert.match(html, /6,270\.00/); assert.match(html, /landscape/);
    const pdf = await fetch(base + `doc/ipc/${i2}/pdf`, { headers: { cookie } });
    if (pdf.status === 200) { const buf = Buffer.from(await pdf.arrayBuffer()); assert.equal(buf.slice(0, 4).toString(), '%PDF'); fs.writeFileSync(path.join(process.env.DATA_DIR, 'IPC-02.pdf'), buf); out.push(`PDF generated (${buf.length} bytes) → ${path.join(process.env.DATA_DIR, 'IPC-02.pdf')}`); }
    else out.push(`PDF: ${pdf.status} (no headless browser here)`);
    assert.equal((await call('GET', `invoices/${i1}/certificate`)).j.number, 'IPC-01');

    // ---- 2. advance recovery: 10% advance, recovered at 20% of each IPC until cleared
    const a = ok(await call('POST', 'projects', { name: 'Advance job', client_id: cl, contract_value: 11000, retention_pct: 10, advance_pct: 10, advance_recovery_pct: 20, status: 'active' })).id;
    const ba = ok(await call('POST', 'boq_items', { project_id: a, description: 'Interlock', unit: 'm2', qty: 1000, rate: 11 })).id;
    ok(await call('POST', `projects/${a}/advance-invoice`, {}));                                  // 1,100
    const rec = [];
    for (const pct of [40, 70, 100]) {
      ok(await call('PUT', 'boq_items/' + ba, { done_pct: pct }));
      const id = ok(await call('POST', `projects/${a}/progress-invoice`, {})).id;
      rec.push(ok(await call('GET', `invoices/${id}/certificate`)));
    }
    assert.deepEqual(rec.map(x => x.recovery.this), [880, 220, 0]);                               // 20% × 4,400 = 880; then the 220 left; then nothing
    assert.equal(rec[2].recovery.cumulative, 1100);
    assert.equal(ok(await call('GET', `projects/${a}/contract`)).advance.remaining, 0);
    // VAT on the work net of recovery, retention on the work value
    assert.equal(rec[0].vat, 176); assert.equal(rec[0].retention.this, 440); assert.equal(rec[0].due, 4400 - 880 - 440 + 176);
    out.push(`advance 1,100 recovered 20% per IPC: ${rec.map(x => x.recovery.this).join(' / ')} → remaining 0`);

    // ---- 3. revenue per worker-day: 10 workers × 22 days on a project, 50,000 certified in the month → 227.27 (target 219)
    const k = ok(await call('POST', 'projects', { name: 'KPI job', client_id: cl, contract_value: 100000, status: 'active' })).id;
    const bk = ok(await call('POST', 'boq_items', { project_id: k, description: 'Asphalt', unit: 'm2', qty: 1000, rate: 100 })).id;
    for (let w = 0; w < 10; w++) {
      const e = ok(await call('POST', 'employees', { name: 'Worker ' + w, join_date: '2025-01-01', basic: 1200, project_id: k })).id;
      for (let d = 1; d <= 22; d++) ok(await call('PUT', 'attendance', { employee_id: e, date: `2026-11-${String(d).padStart(2, '0')}`, status: 'present', project_id: k }));
    }
    ok(await call('PUT', 'boq_items/' + bk, { done_pct: 50 }));
    ok(await call('POST', `projects/${k}/progress-invoice`, { date: '2026-11-30' }));
    const kp = ok(await call('GET', `project-summary/manday?month=2026-11&project_id=${k}`));
    assert.equal(kp.target, 219); assert.equal(kp.rows[0].worker_days, 220); assert.equal(kp.rows[0].certified, 50000); assert.equal(kp.rows[0].per_worker_day, 227.27); assert.equal(kp.rows[0].on_target, true);
    ok(await call('PUT', 'settings', { kpi_manday_target: 250 }));
    assert.equal(ok(await call('GET', `project-summary/manday?month=2026-11&project_id=${k}`)).rows[0].on_target, false);
    out.push(`revenue per worker-day: 50,000 ÷ 220 = ${kp.rows[0].per_worker_day} (target 219 ✔; with target 250 → below)`);
    // money view only
    ok(await call('POST', 'users', { username: 'fm1', password: 'pass1234', role: 'foreman' }));
    const adminCookie = cookie; cookie = ''; ok(await call('POST', 'login', { username: 'fm1', password: 'pass1234' }));
    assert.equal((await call('GET', 'project-summary/manday?month=2026-11')).s, 403); assert.equal((await call('GET', `invoices/${i2}/certificate`)).s, 403);
    assert.equal((await fetch(base + `doc/ipc/${i2}`, { headers: { cookie } })).status, 403);
    cookie = adminCookie;
    out.push('foreman cannot see certificates or the revenue KPI');
    console.log(out.map(x => '✔ ' + x).join('\n'));
    console.log('IPC PHASE 3 TESTS PASSED');
  } catch (e) { console.log(out.map(x => '✔ ' + x).join('\n')); console.error('FAIL', e); process.exitCode = 1; }
  finally { server.close(); setTimeout(() => process.exit(process.exitCode || 0), 100); }
});
