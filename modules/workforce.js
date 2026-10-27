// HR phase 1: multi-level approvals (leave and employee requests), attendance from the phone with the site's GPS area,
// UAE labour-law checks (Federal Decree-Law 33/2021 and the midday-break resolution), onboarding / offboarding
// checklists and the final settlement. Uses ctx.notify (push.js) and the leave balance from hr.js.
const DAY = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const ONBOARD = [['offer', 'عرض العمل موقّع', 'Offer letter signed'], ['mohre', 'تصريح العمل وعقد MOHRE', 'MOHRE work permit and contract'], ['entry', 'تصريح الدخول / تعديل الإقامة', 'Entry permit / visa change'],
  ['medical', 'الفحص الطبي', 'Medical fitness test'], ['eid', 'بصمة الهوية الإماراتية', 'Emirates ID biometrics'], ['insurance', 'التأمين الصحي', 'Health insurance'], ['iloe', 'تسجيل التأمين ضد التعطل (ILOE)', 'Unemployment insurance (ILOE) registered'],
  ['wps', 'حساب بنكي / بطاقة راتب لنظام الأجور', 'Bank account / salary card for WPS'], ['labour_card', 'بطاقة العمل', 'Labour card'], ['induction', 'تعريف السلامة ومعدات الوقاية', 'Safety induction and PPE issued'],
  ['portal', 'حساب بوابة الموظف', 'Employee portal account'], ['probation', 'تحديد موعد تقييم فترة التجربة', 'Probation review date set']];
const OFFBOARD = [['notice', 'خطاب الاستقالة / إنهاء الخدمة وفترة الإشعار', 'Resignation / termination letter and notice period'], ['handover', 'تسليم العمل', 'Work handover'],
  ['assets', 'استرجاع العهد والأدوات ومعدات الوقاية', 'Company assets, tools and PPE returned'], ['settlement', 'التسوية النهائية (راتب، إجازات، نهاية خدمة)', 'Final settlement (salary, leave, gratuity)'],
  ['permit', 'إلغاء تصريح العمل (MOHRE)', 'Work permit cancelled (MOHRE)'], ['visa', 'إلغاء الإقامة', 'Residence visa cancelled'], ['insurance', 'إلغاء التأمين الصحي', 'Health insurance cancelled'],
  ['certificate', 'شهادة الخبرة', 'Experience certificate issued'], ['account', 'إيقاف حساب النظام', 'System account disabled']];

module.exports = ctx => {
  const { db, send, bad, audit, readBody, getSettings, today, round, C } = ctx;
  db.exec(`
  CREATE TABLE IF NOT EXISTS approval_flows(kind TEXT, level INTEGER, approver TEXT, min_days REAL DEFAULT 0, min_amount REAL DEFAULT 0, PRIMARY KEY(kind, level));
  CREATE TABLE IF NOT EXISTS approval_steps(id INTEGER PRIMARY KEY, kind TEXT, ref_id INTEGER, level INTEGER, approver TEXT, approver_user_id INTEGER, status TEXT, decided_by TEXT, decided_at TEXT, note TEXT);
  CREATE INDEX IF NOT EXISTS approval_steps_ref ON approval_steps(kind, ref_id);
  CREATE TABLE IF NOT EXISTS clock_events(id INTEGER PRIMARY KEY, employee_id INTEGER, kind TEXT, at TEXT, lat REAL, lng REAL, accuracy REAL, project_id INTEGER, distance_m REAL, inside INTEGER, source TEXT, by_user TEXT, note TEXT);
  CREATE INDEX IF NOT EXISTS clock_events_emp ON clock_events(employee_id, at);
  CREATE TABLE IF NOT EXISTS hr_checklist(id INTEGER PRIMARY KEY, employee_id INTEGER, kind TEXT, item TEXT, label_ar TEXT, label_en TEXT, done INTEGER DEFAULT 0, done_by TEXT, done_at TEXT, note TEXT, sort INTEGER);
  CREATE TABLE IF NOT EXISTS hr_offboarding(employee_id INTEGER PRIMARY KEY, last_day TEXT, reason TEXT, notice_date TEXT, other_deductions REAL DEFAULT 0, settlement TEXT, status TEXT DEFAULT 'open', created TEXT, completed TEXT);`);
  const addCol = (t, c, d) => { if (!db.prepare(`PRAGMA table_info(${t})`).all().some(x => x.name === c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`); };
  [['employees', 'manager_user_id', 'INTEGER'], ['employees', 'probation_end', 'TEXT'], ['projects', 'site_lat', 'REAL'], ['projects', 'site_lng', 'REAL'], ['projects', 'site_radius', 'REAL DEFAULT 300'],
    ['attendance', 'check_in', 'TEXT'], ['attendance', 'check_out', 'TEXT'], ['attendance', 'worked_hours', 'REAL'], ['attendance', 'source', "TEXT DEFAULT 'manual'"], ['attendance', 'flags', 'TEXT'],
    ['users', 'disabled', 'INTEGER DEFAULT 0']].forEach(a => addCol(...a));
  ctx.TABLES.employees.cols.push('manager_user_id', 'probation_end');
  ctx.TABLES.projects.cols.push('site_lat', 'site_lng', 'site_radius'); ctx.TABLES.projects.num = [...(ctx.TABLES.projects.num || []), 'site_radius'];

  const nowLocal = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().replace('T', ' ').slice(0, 19); };
  const emp = id => db.prepare('SELECT * FROM employees WHERE id=?').get(id);
  const hm = (t, d) => /^\d\d:\d\d$/.test(t) ? +t.slice(0, 2) * 60 + +t.slice(3) : d;
  const S = () => { const s = getSettings(); return { hours: +s.hr_work_hours || 8, brk: s.hr_break_min === undefined || s.hr_break_min === '' ? 60 : +s.hr_break_min, rest: s.hr_rest_day || 'fri', geofence: s.hr_geofence || 'flag',
    ramadanFrom: s.hr_ramadan_from || '', ramadanTo: s.hr_ramadan_to || '',
    // midday work ban (MOHRE, outdoor sites): dates MM-DD and hours HH:MM are settings; defaults 15 Jun – 15 Sep, 12:30 – 15:00
    middayFrom: s.hr_midday_from || '06-15', middayTo: s.hr_midday_to || '09-15', middayStart: hm(s.hr_midday_start || '12:30', 750), middayEnd: hm(s.hr_midday_end || '15:00', 900) }; };
  const notify = (to, msg) => ctx.notify ? ctx.notify(to, msg).catch(() => {}) : null;
  const isHr = me => ['admin', 'hr'].includes(me.role);

  // ======================= approvals =======================
  const TBL = { leave: 'leave_requests', request: 'hr_requests' };
  const DEFAULT_FLOWS = { leave: [['line_manager', 0, 0], ['role:hr', 0, 0]], request: [['role:hr', 0, 0], ['role:admin', 0, 5000]] };
  const flows = kind => { const r = db.prepare('SELECT * FROM approval_flows WHERE kind=? ORDER BY level').all(kind); return r.length ? r.map(x => [x.approver, x.min_days, x.min_amount]) : DEFAULT_FLOWS[kind]; };
  const label = (kind, r, e) => kind === 'leave' ? `${e ? e.name : ''} — ${r.type} ${r.start_date} → ${r.end_date} (${r.days})` : `${e ? e.name : ''} — ${r.type}${r.amount ? ' ' + r.amount + ' AED' : ''}`;
  const approverUsers = step => step.approver_user_id ? [step.approver_user_id] : db.prepare('SELECT id FROM users WHERE role=? AND COALESCE(disabled,0)=0').all(step.approver.slice(5)).map(u => u.id);
  const canDecide = (step, me) => me.role === 'admin' || (step.approver.startsWith('role:') ? me.role === step.approver.slice(5) : step.approver_user_id === me.id);
  const pingApprovers = (kind, step) => {
    const r = db.prepare(`SELECT * FROM ${TBL[kind]} WHERE id=?`).get(step.ref_id), e = r && emp(r.employee_id);
    notify(approverUsers(step), { title: kind === 'leave' ? 'طلب إجازة بانتظار موافقتك / Leave request to approve' : 'طلب موظف بانتظار موافقتك / Request to approve', body: r ? label(kind, r, e) : '', url: '#approvals' });
  };
  function start(kind, refId) {
    const r = db.prepare(`SELECT * FROM ${TBL[kind]} WHERE id=?`).get(refId), e = emp(r.employee_id);
    const levels = [];
    for (const [approver, minDays, minAmount] of flows(kind)) {
      if ((minDays && !(r.days >= minDays)) || (minAmount && !(r.amount >= minAmount))) continue;
      let uid = null;
      if (approver === 'line_manager') { uid = e && e.manager_user_id; if (!uid) continue; }          // no line manager → that level is skipped
      else if (approver.startsWith('user:')) uid = +approver.slice(5);
      const prev = levels[levels.length - 1];
      if (prev && prev.approver === approver && prev.uid === uid) continue;
      levels.push({ approver, uid });
    }
    if (!levels.length) levels.push({ approver: 'role:hr', uid: null });
    const ins = db.prepare('INSERT INTO approval_steps(kind,ref_id,level,approver,approver_user_id,status) VALUES(?,?,?,?,?,?)');
    levels.forEach((l, i) => ins.run(kind, refId, i + 1, l.approver, l.uid, i ? 'waiting' : 'pending'));
    pingApprovers(kind, db.prepare("SELECT * FROM approval_steps WHERE kind=? AND ref_id=? AND status='pending'").get(kind, refId));
  }
  const steps = (kind, refId) => db.prepare('SELECT * FROM approval_steps WHERE kind=? AND ref_id=? ORDER BY level').all(kind, refId);
  function decide(kind, refId, me, b, req) {
    const r = db.prepare(`SELECT * FROM ${TBL[kind]} WHERE id=?`).get(refId); if (!r) bad('Not found');
    if (r.status !== 'pending') bad('This request was already decided');
    if (!['approved', 'rejected'].includes(b.status)) bad('Decision must be approved or rejected');
    if (!steps(kind, refId).length) db.prepare("INSERT INTO approval_steps(kind,ref_id,level,approver,status) VALUES(?,?,1,'role:hr','pending')").run(kind, refId);   // records from before approvals existed
    const step = db.prepare("SELECT * FROM approval_steps WHERE kind=? AND ref_id=? AND status='pending' ORDER BY level LIMIT 1").get(kind, refId);
    if (!canDecide(step, me)) { const e = new Error('This request is waiting for another approver'); e.status = 403; throw e; }
    const last = !db.prepare("SELECT 1 FROM approval_steps WHERE kind=? AND ref_id=? AND status='waiting'").get(kind, refId);
    if (b.status === 'approved' && last) ctx.hrFinalize(TBL[kind], refId, 'approved', me, b.note, b.force, true);   // checks the leave balance before anything is written
    db.prepare('UPDATE approval_steps SET status=?, decided_by=?, decided_at=?, note=? WHERE id=?').run(b.status, me.username, nowLocal(), b.note || '', step.id);
    audit(req, b.status, TBL[kind], refId, `level ${step.level}`);
    if (b.status === 'rejected') {
      db.prepare("UPDATE approval_steps SET status='skipped' WHERE kind=? AND ref_id=? AND status='waiting'").run(kind, refId);
      return ctx.hrFinalize(TBL[kind], refId, 'rejected', me, b.note);
    }
    if (last) return ctx.hrFinalize(TBL[kind], refId, 'approved', me, b.note, b.force);
    const next = db.prepare("SELECT * FROM approval_steps WHERE kind=? AND ref_id=? AND status='waiting' ORDER BY level LIMIT 1").get(kind, refId);
    db.prepare("UPDATE approval_steps SET status='pending' WHERE id=?").run(next.id);
    pingApprovers(kind, next);
  }
  const drop = (kind, refId) => db.prepare('DELETE FROM approval_steps WHERE kind=? AND ref_id=?').run(kind, refId);
  ctx.approvals = { start, decide, drop, steps };

  function queue(me) {
    const out = [];
    for (const s of db.prepare("SELECT * FROM approval_steps WHERE status='pending' ORDER BY id").all()) {
      if (!canDecide(s, me)) continue;
      const r = db.prepare(`SELECT * FROM ${TBL[s.kind]} WHERE id=?`).get(s.ref_id); if (!r || r.status !== 'pending') continue;
      const e = emp(r.employee_id), all = steps(s.kind, s.ref_id);
      out.push({ step_id: s.id, kind: s.kind, ref_id: s.ref_id, level: s.level, levels: all.length, employee: e && e.name, employee_id: r.employee_id, record: r,
        history: all.filter(x => x.status === 'approved').map(x => ({ level: x.level, by: x.decided_by, at: x.decided_at, note: x.note })),
        balance: s.kind === 'leave' && e ? ctx.hrBalance(e) : null });
    }
    return out;
  }

  // ======================= attendance from the phone =======================
  const toRad = x => x * Math.PI / 180;
  const distance = (a, b, c, d) => { const R = 6371000, x = Math.sin(toRad(c - a) / 2) ** 2 + Math.cos(toRad(a)) * Math.cos(toRad(c)) * Math.sin(toRad(d - b) / 2) ** 2; return Math.round(2 * R * Math.asin(Math.sqrt(x))); };
  function site(e, lat, lng) {
    const sites = db.prepare("SELECT id,name,site_lat,site_lng,site_radius FROM projects WHERE site_lat IS NOT NULL AND site_lng IS NOT NULL AND status='active'").all();
    const own = sites.find(p => p.id === e.project_id);
    if (lat == null) return { project: own || null, distance: null, inside: null };
    const ranked = sites.map(p => ({ p, d: distance(lat, lng, p.site_lat, p.site_lng) })).sort((x, y) => x.d - y.d);
    const pick = own ? { p: own, d: distance(lat, lng, own.site_lat, own.site_lng) } : ranked[0];
    if (!pick) return { project: null, distance: null, inside: null };
    return { project: pick.p, distance: pick.d, inside: pick.d <= (pick.p.site_radius || 300) };
  }
  const minutes = t => +t.slice(11, 13) * 60 + +t.slice(14, 16);
  const overlap = (a, b, c, d) => Math.max(0, Math.min(b, d) - Math.max(a, c));
  // turn the day's clock events into the attendance row (worked hours, overtime per the law, flags); manual rows keep HR's status/overtime
  function recompute(employeeId, date) {
    const e = emp(employeeId), s = S();
    const next = new Date(Date.parse(date + 'T00:00:00Z') + 864e5).toISOString().slice(0, 10);
    const ev = db.prepare('SELECT * FROM clock_events WHERE employee_id=? AND at>=? AND at<? ORDER BY at, id').all(employeeId, date + ' 00:00:00', next + ' 12:00:00');
    let open = null, worked = 0, night = 0, midday = 0, closed = null; const flags = new Set();
    for (const x of ev) {
      if (x.at.slice(0, 10) === date || open) { if (x.inside === 0) flags.add('outside_site'); if (x.lat == null) flags.add('no_location'); }
      if (x.kind === 'in') { if (!open && x.at.slice(0, 10) === date) open = x; continue; }
      if (!open) continue;
      const a = minutes(open.at), b = minutes(x.at) + (x.at.slice(0, 10) > date ? 1440 : 0);
      worked += b - a; night += overlap(a, b, 0, 240) + overlap(a, b, 1320, 1680);
      midday += overlap(a, b, s.middayStart, s.middayEnd);
      open = null; closed = x;
    }
    const ins = ev.filter(x => x.kind === 'in' && x.at.slice(0, 10) === date);
    if (!ins.length) return;
    const md = date.slice(5); if (midday > 0 && md >= s.middayFrom && md <= s.middayTo && e.project_id) flags.add('midday_break');
    const ramadan = s.ramadanFrom && date >= s.ramadanFrom && date <= s.ramadanTo;
    const net = Math.max(0, worked - (worked > 300 ? s.brk : 0)), normal = (s.hours - (ramadan ? 2 : 0)) * 60;
    const restDay = DAY[new Date(date + 'T00:00:00Z').getUTCDay()] === s.rest;
    let otN = 0, otS = 0;
    if (restDay) otS = net; else { const ot = Math.max(0, net - normal); otS = Math.min(ot, night); otN = ot - otS; }
    if (!restDay && otN + otS > 120) flags.add('ot_over_2h');
    const q = m => Math.round(m / 15) / 4;                                               // quarter hours
    const cur = db.prepare('SELECT * FROM attendance WHERE employee_id=? AND date=?').get(employeeId, date);
    const checkIn = ins[0].at.slice(11, 16), checkOut = closed ? closed.at.slice(11, 16) : null;
    const proj = ins[0].project_id || e.project_id || null, fl = [...flags].join(',');
    if (cur && cur.source === 'manual' && cur.id) db.prepare('UPDATE attendance SET check_in=?, check_out=?, worked_hours=?, flags=? WHERE id=?').run(checkIn, checkOut, q(worked), fl, cur.id);
    else db.prepare(`INSERT INTO attendance(employee_id,date,status,ot_normal_hours,ot_special_hours,project_id,check_in,check_out,worked_hours,source,flags) VALUES(?,?,?,?,?,?,?,?,?,'clock',?)
      ON CONFLICT(employee_id,date) DO UPDATE SET status=excluded.status, ot_normal_hours=excluded.ot_normal_hours, ot_special_hours=excluded.ot_special_hours, project_id=excluded.project_id,
      check_in=excluded.check_in, check_out=excluded.check_out, worked_hours=excluded.worked_hours, source='clock', flags=excluded.flags`)
      .run(employeeId, date, 'present', q(otN), q(otS), proj, checkIn, checkOut, q(worked), fl);
  }
  function clock(e, { kind, lat, lng, accuracy, at, note }, by, source) {
    lat = lat === '' || lat == null ? null : +lat; lng = lng === '' || lng == null ? null : +lng;
    if (lat != null && !(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) bad('Invalid location');
    const when = at || nowLocal();
    if (!/^\d{4}-\d\d-\d\d \d\d:\d\d(:\d\d)?$/.test(when)) bad('Time must be YYYY-MM-DD HH:MM');
    const stamp = when.length === 16 ? when + ':00' : when, date = stamp.slice(0, 10);
    const last = db.prepare('SELECT * FROM clock_events WHERE employee_id=? AND at<=? ORDER BY at DESC, id DESC LIMIT 1').get(e.id, stamp), auto = !kind;
    if (!at && last && auto && Date.parse(stamp.replace(' ', 'T')) - Date.parse(last.at.replace(' ', 'T')) < 60e3) return { id: last.id, kind: last.kind, duplicate: true };   // double tap
    if (!kind) kind = last && last.kind === 'in' && last.at.slice(0, 10) >= new Date(Date.parse(date + 'T00:00:00Z') - 864e5).toISOString().slice(0, 10) ? 'out' : 'in';
    if (!['in', 'out'].includes(kind)) bad('kind must be in or out');
    if (!at && last && last.kind === kind && Date.parse(stamp.replace(' ', 'T')) - Date.parse(last.at.replace(' ', 'T')) < 60e3) return { id: last.id, kind, duplicate: true };
    const st = site(e, lat, lng), s = S();
    if (source === 'mobile' && s.geofence === 'block' && st.inside === false) bad(`You are outside the site area (${st.distance} m from ${st.project.name})`);
    if (source === 'mobile' && s.geofence === 'block' && lat == null) bad('Location is required to clock in — allow location access');
    const r = db.prepare('INSERT INTO clock_events(employee_id,kind,at,lat,lng,accuracy,project_id,distance_m,inside,source,by_user,note) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(e.id, kind, stamp, lat, lng, accuracy == null ? null : +accuracy, st.project ? st.project.id : null, st.distance, st.inside == null ? null : st.inside ? 1 : 0, source, by, note || '');
    recompute(e.id, kind === 'out' && last && last.kind === 'in' ? last.at.slice(0, 10) : date);
    if (st.inside === false && e.manager_user_id) notify([e.manager_user_id], { title: 'تسجيل حضور خارج الموقع / Clock-in outside the site', body: `${e.name} — ${kind} ${stamp.slice(11, 16)} · ${st.distance} m · ${st.project.name}`, url: '#attendance' });
    return { id: Number(r.lastInsertRowid), kind, at: stamp, project: st.project && st.project.name, distance_m: st.distance, inside: st.inside };
  }
  const todayState = e => {
    const ev = db.prepare('SELECT kind,at,inside,distance_m,project_id FROM clock_events WHERE employee_id=? AND at>=? ORDER BY at, id').all(e.id, today() + ' 00:00:00');
    const p = e.project_id ? db.prepare('SELECT id,name,site_lat,site_lng,site_radius FROM projects WHERE id=?').get(e.project_id) : null;
    return { events: ev, clocked_in: ev.length ? ev[ev.length - 1].kind === 'in' : false, site: p ? { name: p.name, located: p.site_lat != null, radius: p.site_radius } : null, geofence: S().geofence };
  };

  // ======================= labour-law checks =======================
  function compliance(month) {
    const first = `${month}-01`, last = `${month}-${String(C.daysInMonth(month)).padStart(2, '0')}`, issues = [];
    const add = (e, date, rule, law, detail) => issues.push({ employee_id: e.id, employee: e.name, date, rule, law, detail });
    const active = db.prepare("SELECT * FROM employees WHERE status='active' ORDER BY name").all();
    const s = S();
    for (const e of active) {
      const from = new Date(Date.parse(first + 'T00:00:00Z') - 20 * 864e5).toISOString().slice(0, 10);
      const rows = db.prepare('SELECT * FROM attendance WHERE employee_id=? AND date>=? AND date<=? ORDER BY date').all(e.id, from, last);
      const inMonth = rows.filter(r => r.date >= first);
      for (const r of inMonth) {
        const restDay = DAY[new Date(r.date + 'T00:00:00Z').getUTCDay()] === s.rest, ot = (r.ot_normal_hours || 0) + (r.ot_special_hours || 0);
        if (r.status === 'present' && !restDay && ot > 2) add(e, r.date, 'ot_daily', 'Decree-Law 33/2021 Art. 19(1)', `${ot} h overtime (max 2 h a day)`);
        const fl = (r.flags || '').split(',');
        if (fl.includes('midday_break')) add(e, r.date, 'midday_break', 'MOHRE midday break (15 Jun – 15 Sep, 12:30–15:00)', `worked on site ${r.check_in}–${r.check_out || '…'}`);
        if (fl.includes('outside_site')) add(e, r.date, 'outside_site', 'Company policy', 'clocked outside the site area');
      }
      const hours = r => r.status !== 'present' ? 0 : r.worked_hours != null ? Math.max(0, r.worked_hours - (r.worked_hours > 5 ? s.brk / 60 : 0)) : s.hours + (r.ot_normal_hours || 0) + (r.ot_special_hours || 0);
      const byDate = Object.fromEntries(rows.map(r => [r.date, r]));
      const dates = []; for (let t = Date.parse(first + 'T00:00:00Z'); t <= Date.parse(last + 'T00:00:00Z'); t += 864e5) dates.push(new Date(t).toISOString().slice(0, 10));
      let flagged3w = false, streak = 0, streakFlagged = false;
      for (let t = Date.parse(from + 'T00:00:00Z'); t <= Date.parse(last + 'T00:00:00Z'); t += 864e5) {
        const d = new Date(t).toISOString().slice(0, 10), r = byDate[d];
        streak = r && r.status === 'present' ? streak + 1 : 0;
        if (streak >= 7 && d >= first && !streakFlagged) { add(e, d, 'rest_day', 'Decree-Law 33/2021 Art. 21', '7 days in a row without a rest day'); streakFlagged = true; }
        if (!streak) streakFlagged = false;
        if (d >= first && !flagged3w) {
          let sum = 0; for (let k = 0; k < 21; k++) { const dd = new Date(t - k * 864e5).toISOString().slice(0, 10); if (byDate[dd]) sum += hours(byDate[dd]); }
          if (sum > 144) { add(e, d, 'hours_3weeks', 'Decree-Law 33/2021 Art. 19(1)', `${round(sum)} h in 3 weeks (max 144)`); flagged3w = true; }
        }
      }
      if (e.probation_end && e.join_date) {
        const max = new Date(Date.parse(e.join_date + 'T00:00:00Z')); max.setUTCMonth(max.getUTCMonth() + 6);
        if (e.probation_end > max.toISOString().slice(0, 10)) add(e, e.probation_end, 'probation_6m', 'Decree-Law 33/2021 Art. 9(1)', 'probation longer than 6 months');
        if (e.probation_end >= today() && e.probation_end <= new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10)) add(e, e.probation_end, 'probation_review', 'Reminder', 'probation ends within 14 days — review the employee');
      }
    }
    return issues;
  }

  // ======================= onboarding / offboarding =======================
  const checklist = (eid, kind) => db.prepare('SELECT * FROM hr_checklist WHERE employee_id=? AND kind=? ORDER BY sort, id').all(eid, kind);
  function startList(eid, kind) {
    if (checklist(eid, kind).length) return;
    const ins = db.prepare('INSERT INTO hr_checklist(employee_id,kind,item,label_ar,label_en,sort) VALUES(?,?,?,?,?,?)');
    (kind === 'onboarding' ? ONBOARD : OFFBOARD).forEach(([item, ar, en], i) => ins.run(eid, kind, item, ar, en, i));
  }
  const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);
  // UAE final settlement: wages to the last day, unused annual leave on basic wage (Art. 29), gratuity (Art. 51), notice shortfall (Art. 43)
  function settlement(e, { last_day, reason, notice_date, other_deductions }) {
    const wage = (+e.basic || 0) + (+e.housing || 0) + (+e.transport || 0) + (+e.other_allowance || 0), day = +last_day.slice(8, 10);
    const leave = ctx.hrBalance(e, last_day), leaveDays = Math.max(0, leave.balance);
    const g = C.gratuity(e, last_day, ctx.unpaidDays ? ctx.unpaidDays(e, last_day) : 0), notice = notice_date ? daysBetween(notice_date, last_day) : 0, shortfall = Math.max(0, 30 - notice);
    const noticePay = !shortfall || reason === 'end_of_contract' ? 0 : round((reason === 'resignation' ? -1 : 1) * shortfall * wage / 30);   // the side that cut the notice short pays it
    const lines = { salary: round(wage / 30 * Math.min(30, day)), leave_encashment: round(leaveDays * (+e.basic || 0) / 30), gratuity: g.amount, notice: noticePay, advance: -(ctx.loanBalance ? ctx.loanBalance(e.id) : 0), deductions: -round(+other_deductions || 0) };
    const warnings = [];
    if (notice_date && notice < 30) warnings.push(`notice period ${notice} days — the law requires at least 30 (Art. 43)`);
    if (notice > 90) warnings.push(`notice period ${notice} days — the law allows at most 90 (Art. 43)`);
    return { ...lines, total: round(Object.values(lines).reduce((s, v) => s + v, 0)), leave_days: leaveDays, service_years: g.years, unpaid_days: g.unpaid_days, notice_days: notice, wage, warnings };
  }

  return {
    async handle(req, res, url, [a, b, c, d], me) {
      const m = req.method;
      // ---------- approvals (any user who is an approver) ----------
      if (a === 'approvals') {
        if (m === 'GET' && !b) return send(res, 200, queue(me)), true;
        if (m === 'PUT' && b) {
          const s = db.prepare('SELECT * FROM approval_steps WHERE id=?').get(+b); if (!s) bad('Not found');
          const x = await readBody(req);
          if (s.status !== 'pending') bad('This step was already decided');
          decide(s.kind, s.ref_id, me, x, req); return send(res, 200, { ok: 1 }), true;
        }
        if (m === 'GET' && b === 'history') { const kind = url.searchParams.get('kind'), id = +url.searchParams.get('id'); return send(res, 200, steps(kind, id)), true; }
        return send(res, 404, { error: 'not found' }), true;
      }
      // ---------- my attendance ----------
      if (a === 'me' && b === 'clock') {
        if (!me.employee_id) return send(res, 403, { error: 'this account is not linked to an employee' }), true;
        const e = emp(me.employee_id); if (!e || e.status !== 'active') bad('Employee record not active');
        if (m === 'GET') return send(res, 200, todayState(e)), true;
        if (m === 'POST') { const x = await readBody(req); const r = clock(e, { kind: x.kind, lat: x.lat, lng: x.lng, accuracy: x.accuracy }, me.username, 'mobile'); audit(req, 'clock', 'attendance', e.id, `${r.kind} ${r.inside === false ? 'outside' : ''}`); return send(res, 200, r), true; }
      }
      if (a === 'me' && b === 'approvals' && m === 'GET') return send(res, 200, queue(me)), true;
      // ---------- crew clock-in by a supervisor, HR corrections ----------
      if (a === 'attendance' && b === 'clock' && m === 'POST') {
        const x = await readBody(req), ids = (Array.isArray(x.employee_ids) ? x.employee_ids : [x.employee_id]).map(Number).filter(Boolean);
        if (!ids.length) bad('Choose the employees');
        if (x.at && !isHr(me)) bad('Only HR can enter a past time');
        const out = ids.map(id => { const e = emp(id); if (!e) bad('Employee not found'); return { employee_id: id, ...clock(e, { kind: x.kind, lat: x.lat, lng: x.lng, accuracy: x.accuracy, at: x.at, note: x.note }, me.username, x.at ? 'hr' : 'supervisor') }; });
        audit(req, 'clock', 'attendance', 0, `${out.length} employees ${x.kind || ''}`);
        return send(res, 200, out), true;
      }
      if (a === 'attendance' && b === 'events' && m === 'GET') {
        const date = url.searchParams.get('date') || today();
        return send(res, 200, db.prepare('SELECT c.*, p.name project_name FROM clock_events c LEFT JOIN projects p ON p.id=c.project_id WHERE c.at>=? AND c.at<=? ORDER BY c.at').all(date + ' 00:00:00', date + ' 23:59:59')), true;
      }
      if (a !== 'hr') return false;
      // ---------- HR back office ----------
      if (b === 'compliance' && m === 'GET') { const month = url.searchParams.get('month') || today().slice(0, 7); if (!/^\d{4}-\d\d$/.test(month)) bad('month must be YYYY-MM'); return send(res, 200, compliance(month)), true; }
      if (b === 'flows') {
        if (m === 'GET') return send(res, 200, { leave: flows('leave'), request: flows('request'), custom: { leave: !!db.prepare("SELECT 1 FROM approval_flows WHERE kind='leave'").get(), request: !!db.prepare("SELECT 1 FROM approval_flows WHERE kind='request'").get() } }), true;
        if (m === 'PUT') {
          const x = await readBody(req);
          for (const kind of ['leave', 'request']) {
            if (!Array.isArray(x[kind])) continue;
            const lv = x[kind].filter(l => l && l[0]);
            for (const [ap] of lv) if (!/^(line_manager|role:(admin|hr|manager|accountant)|user:\d+)$/.test(ap)) bad('Unknown approver ' + ap);
            db.prepare('DELETE FROM approval_flows WHERE kind=?').run(kind);
            lv.forEach(([ap, dmin, amin], i) => db.prepare('INSERT INTO approval_flows(kind,level,approver,min_days,min_amount) VALUES(?,?,?,?,?)').run(kind, i + 1, ap, +dmin || 0, +amin || 0));
          }
          audit(req, 'update', 'approval_flows', 0, JSON.stringify(x).slice(0, 300)); return send(res, 200, { ok: 1 }), true;
        }
      }
      if (b === 'checklist') {
        if (m === 'GET') return send(res, 200, { onboarding: checklist(+c, 'onboarding'), offboarding: checklist(+c, 'offboarding'), offboard: db.prepare('SELECT * FROM hr_offboarding WHERE employee_id=?').get(+c) || null }), true;
        if (m === 'PUT') {
          const x = await readBody(req), it = db.prepare('SELECT * FROM hr_checklist WHERE id=?').get(+c); if (!it) bad('Not found');
          db.prepare('UPDATE hr_checklist SET done=?, done_by=?, done_at=?, note=? WHERE id=?').run(x.done ? 1 : 0, x.done ? me.username : null, x.done ? today() : null, x.note ?? it.note, it.id);
          return send(res, 200, { ok: 1 }), true;
        }
      }
      if (b === 'onboarding' && m === 'POST') { if (!emp(+c)) bad('Employee not found'); startList(+c, 'onboarding'); audit(req, 'start', 'onboarding', +c); return send(res, 200, checklist(+c, 'onboarding')), true; }
      if (b === 'offboarding') {
        const e = emp(+c); if (!e) bad('Employee not found');
        if (m === 'POST' && !d) {
          const x = await readBody(req);
          if (!/^\d{4}-\d\d-\d\d$/.test(x.last_day || '')) bad('Enter the last working day');
          if (!['resignation', 'termination', 'end_of_contract', 'other'].includes(x.reason)) bad('Choose the reason');
          if (x.notice_date && !/^\d{4}-\d\d-\d\d$/.test(x.notice_date)) bad('Invalid notice date');
          const st = settlement(e, x);
          db.prepare(`INSERT INTO hr_offboarding(employee_id,last_day,reason,notice_date,other_deductions,settlement,status,created) VALUES(?,?,?,?,?,?,'open',?)
            ON CONFLICT(employee_id) DO UPDATE SET last_day=excluded.last_day, reason=excluded.reason, notice_date=excluded.notice_date, other_deductions=excluded.other_deductions, settlement=excluded.settlement`)
            .run(e.id, x.last_day, x.reason, x.notice_date || null, +x.other_deductions || 0, JSON.stringify(st), today());
          startList(e.id, 'offboarding'); audit(req, 'start', 'offboarding', e.id, `${x.reason} ${x.last_day}`);
          return send(res, 200, st), true;
        }
        if (m === 'POST' && d === 'complete') {
          const ob = db.prepare('SELECT * FROM hr_offboarding WHERE employee_id=?').get(e.id); if (!ob) bad('Start the offboarding first');
          const open = checklist(e.id, 'offboarding').filter(i => !i.done), x = await readBody(req);
          if (open.length && !x.force) bad(`${open.length} checklist items are still open`);
          db.prepare("UPDATE employees SET status='left', end_date=? WHERE id=?").run(ob.last_day, e.id);
          if (ctx.hooks.onOffboard) ctx.hooks.onOffboard(e, ob.last_day, settlement(e, ob).gratuity);   // settle the end-of-service provision
          db.prepare("UPDATE hr_offboarding SET status='completed', completed=? WHERE employee_id=?").run(today(), e.id);
          for (const u of db.prepare('SELECT id FROM users WHERE employee_id=?').all(e.id)) { db.prepare('UPDATE users SET disabled=1 WHERE id=?').run(u.id); db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id); }
          audit(req, 'complete', 'offboarding', e.id, ob.last_day);
          return send(res, 200, { ok: 1 }), true;
        }
      }
      return false;
    },
  };
};
