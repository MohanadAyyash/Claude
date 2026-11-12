// Site stock (quantities + weighted-average cost), fixed assets with straight-line depreciation, petty cash float.
module.exports = ctx => {
  const { db, send, bad, audit, readBody, today, round, TABLES, C } = ctx;
  db.exec(`
  CREATE TABLE IF NOT EXISTS stock_items(id INTEGER PRIMARY KEY, code TEXT, name TEXT NOT NULL, unit TEXT, min_qty REAL DEFAULT 0, location TEXT);
  CREATE TABLE IF NOT EXISTS stock_moves(id INTEGER PRIMARY KEY, item_id INTEGER, date TEXT, type TEXT, qty REAL, unit_cost REAL DEFAULT 0, project_id INTEGER, ref TEXT, notes TEXT);
  CREATE TABLE IF NOT EXISTS fixed_assets(id INTEGER PRIMARY KEY, name TEXT NOT NULL, category TEXT, serial TEXT, purchase_date TEXT, cost REAL DEFAULT 0, salvage REAL DEFAULT 0, life_years REAL DEFAULT 5, status TEXT DEFAULT 'active', disposal_date TEXT, project_id INTEGER, notes TEXT);
  CREATE TABLE IF NOT EXISTS petty_topups(id INTEGER PRIMARY KEY, date TEXT, amount REAL DEFAULT 0, note TEXT);`);
  Object.assign(TABLES, {
    stock_items: { cols: ['code', 'name', 'unit', 'min_qty', 'location'], num: ['min_qty'] },
    fixed_assets: { cols: ['name', 'category', 'serial', 'purchase_date', 'cost', 'salvage', 'life_years', 'status', 'disposal_date', 'project_id', 'notes', 'opening', 'disposal_proceeds'], num: ['cost', 'salvage', 'life_years', 'opening', 'disposal_proceeds'],
      check: r => { if (r.cost !== undefined && r.cost < 0) bad('Cost cannot be negative'); if (r.disposal_proceeds !== undefined && r.disposal_proceeds < 0) bad('Sale proceeds cannot be negative'); if (r.status === 'disposed' && !r.disposal_date) bad('Enter the disposal date'); } },
    petty_topups: { cols: ['date', 'amount', 'note'], num: ['amount'] },
  });

  for (const [c, d] of [['opening', 'INTEGER DEFAULT 0'], ['disposal_proceeds', 'REAL DEFAULT 0']]) if (!db.prepare('PRAGMA table_info(fixed_assets)').all().some(x => x.name === c)) db.exec(`ALTER TABLE fixed_assets ADD COLUMN ${c} ${d}`);
  // the register against the purchase bills: every asset is either bought through a bill booked as "fixed asset purchase" or marked as owned before the system
  const assetCheck = () => {
    const bills = round(db.prepare("SELECT COALESCE(SUM(amount),0) s FROM bills WHERE category='asset'").get().s), reg = round(db.prepare('SELECT COALESCE(SUM(cost),0) s FROM fixed_assets WHERE COALESCE(opening,0)=0').get().s);
    return { purchase_bills: bills, register_cost: reg, difference: round(bills - reg), balanced: Math.abs(bills - reg) < 0.01 };
  };
  // ---- stock ----
  const balances = () => db.prepare('SELECT * FROM stock_items ORDER BY name').all().map(it => {
    let qty = 0, value = 0;
    for (const mv of db.prepare('SELECT * FROM stock_moves WHERE item_id=? ORDER BY date, id').all(it.id)) {
      if (mv.type === 'in') { value += mv.qty * mv.unit_cost; qty += mv.qty; }
      else { const avg = qty > 0 ? value / qty : 0; const q = mv.type === 'out' ? mv.qty : -mv.qty; value -= avg * q; qty -= q; }   // adjust: positive qty adds at current average
    }
    return { ...it, qty: round(qty), avg_cost: qty > 0 ? round(value / qty) : 0, value: round(value), low: it.min_qty > 0 && qty <= it.min_qty };
  });
  const qtyOf = id => balances().find(x => x.id === id)?.qty || 0;
  // the balance must never go below zero at any point in date order — with a move added (extra) or removed (skipId)
  const stockOk = (itemId, extra, skipId) => {
    const mv = db.prepare('SELECT * FROM stock_moves WHERE item_id=?').all(itemId).filter(x => x.id !== skipId).map(x => ({ ...x }));
    if (extra) mv.push({ ...extra, id: 9e15 });
    mv.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.id - y.id));
    let q = 0; for (const x of mv) { q += x.type === 'in' ? x.qty : x.type === 'out' ? -x.qty : x.qty; if (q < -1e-9) return { ok: false, date: x.date, qty: round(q) }; }
    return { ok: true };
  };

  // ---- fixed assets: straight line, monthly, starting the month of purchase ----
  const months = (from, to) => { const a = new Date(from), b = new Date(to); return Math.max(0, (b.getFullYear() - a.getFullYear()) * 12 + b.getMonth() - a.getMonth() + 1); };
  const accumulated = (a, upTo) => {
    if (!a.purchase_date || upTo < a.purchase_date) return 0;
    // same schedule as the ledger (accounting.js): one charge at each month end, from the month of purchase to the month of disposal
    const disposed = a.status === 'disposed' && a.disposal_date && a.disposal_date.slice(0, 7) <= upTo.slice(0, 7);
    let n = months(a.purchase_date, disposed ? a.disposal_date : upTo);
    const ym = upTo.slice(0, 7), lastDay = `${ym}-${String(C.daysInMonth(ym)).padStart(2, '0')}`;
    if (upTo < lastDay && (!disposed || a.disposal_date.slice(0, 7) === ym)) n--;          // the current month is charged at its end
    const monthly = (a.cost - a.salvage) / Math.max(1, a.life_years * 12);
    return round(Math.max(0, Math.min(a.cost - a.salvage, monthly * Math.max(0, n))));
  };
  ctx.depreciation = (from, to) => round(db.prepare('SELECT * FROM fixed_assets').all().reduce((s, a) => s + accumulated(a, to) - (from ? accumulated(a, new Date(new Date(from).getTime() - 864e5).toISOString().slice(0, 10)) : 0), 0));
  ctx.assetRegister = (asOf = today()) => db.prepare('SELECT * FROM fixed_assets ORDER BY id DESC').all().map(a => ({ ...a, accumulated: accumulated(a, asOf), nbv: round(a.cost - accumulated(a, asOf)), annual: round((a.cost - a.salvage) / Math.max(1, a.life_years)), project_name: db.prepare('SELECT name FROM projects WHERE id=?').get(a.project_id)?.name }));

  // ---- petty cash ----
  const pettyState = () => {
    const topups = db.prepare('SELECT * FROM petty_topups ORDER BY date DESC, id DESC').all();
    const expenses = db.prepare("SELECT p.id,p.date,p.amount,b.description,b.category,b.vat_amount,b.project_id,b.id bill_id FROM payments p LEFT JOIN bills b ON b.id=p.bill_id WHERE p.method='petty' AND p.kind='out' ORDER BY p.date DESC, p.id DESC").all();
    return { topups, expenses, balance: round(topups.reduce((s, t) => s + t.amount, 0) - expenses.reduce((s, e) => s + e.amount, 0)) };
  };
  ctx.pettyBalance = () => pettyState().balance;

  return {
    async handle(req, res, url, [a, b], me) {
      const m = req.method;
      if (a === 'stock_items' && m === 'GET') { const rows = balances(); return send(res, 200, b ? rows.find(r => r.id === +b) || null : rows), true; }
      if (a === 'stock_moves') {
        if (m === 'GET') { const q = url.searchParams.get('item_id'); return send(res, 200, db.prepare(`SELECT s.*, i.name item_name, i.unit, p.name project_name FROM stock_moves s JOIN stock_items i ON i.id=s.item_id LEFT JOIN projects p ON p.id=s.project_id ${q ? 'WHERE s.item_id=?' : ''} ORDER BY s.date DESC, s.id DESC LIMIT 500`).all(...(q ? [+q] : []))), true; }
        if (m === 'POST') {
          const x = await readBody(req);
          if (!db.prepare('SELECT 1 FROM stock_items WHERE id=?').get(+x.item_id)) bad('Select an item');
          if (!['in', 'out', 'adjust'].includes(x.type)) bad('Invalid movement type');
          const qty = +x.qty; if (!(qty > 0) && x.type !== 'adjust') bad('Quantity must be greater than zero'); if (!qty) bad('Enter a quantity');
          if (x.date && !/^\d{4}-\d\d-\d\d$/.test(x.date)) bad('Invalid date'); if (!(+x.unit_cost >= 0 || x.unit_cost == null || x.unit_cost === '')) bad('Unit cost cannot be negative');
          if (x.type === 'out' && qty > qtyOf(+x.item_id) + 1e-9) bad(`Insufficient stock (available ${qtyOf(+x.item_id)})`);
          const chk = stockOk(+x.item_id, { date: x.date || today(), type: x.type, qty }); if (!chk.ok) bad(`Stock would go below zero on ${chk.date} (${chk.qty}) — check the date and quantity`);
          const r = db.prepare('INSERT INTO stock_moves(item_id,date,type,qty,unit_cost,project_id,ref,notes) VALUES(?,?,?,?,?,?,?,?)').run(+x.item_id, x.date || today(), x.type, qty, +x.unit_cost || 0, +x.project_id || null, x.ref || '', x.notes || '');
          audit(req, 'create', 'stock_moves', Number(r.lastInsertRowid), `${x.type} ${qty}`);
          return send(res, 200, { id: Number(r.lastInsertRowid) }), true;
        }
        if (m === 'DELETE') {
          const mv = db.prepare('SELECT * FROM stock_moves WHERE id=?').get(+b); if (!mv) return send(res, 404, { error: 'not found' }), true;
          const chk = stockOk(mv.item_id, null, mv.id); if (!chk.ok) bad(`Deleting this movement would leave the stock below zero on ${chk.date} (${chk.qty}) — delete the later issues first`);
          db.prepare('DELETE FROM stock_moves WHERE id=?').run(mv.id); audit(req, 'delete', 'stock_moves', mv.id, `${mv.type} ${mv.qty}`); return send(res, 200, { ok: 1 }), true;
        }
      }
      if (a === 'fixed_assets' && b === 'check' && m === 'GET') return send(res, 200, assetCheck()), true;
      if (a === 'fixed_assets' && m === 'GET') { const rows = ctx.assetRegister(url.searchParams.get('as_of') || today()); return send(res, 200, b ? rows.find(r => r.id === +b) || null : rows), true; }
      if (a === 'petty_topups' && m === 'GET') return send(res, 200, pettyState()), true;
      if (a === 'petty_topups' && b === 'expense' && m === 'POST') {
        const x = await readBody(req), amount = +x.amount, vat = +x.vat_amount || 0;
        if (!(amount > 0)) bad('Enter the expense amount'); if (!x.description) bad('Enter a description');
        if (amount + vat > pettyState().balance + 1e-9) bad(`Insufficient petty cash (balance ${pettyState().balance})`);
        const bill = db.prepare('INSERT INTO bills(date,party_id,project_id,category,description,amount,vat_amount,reference) VALUES(?,?,?,?,?,?,?,?)').run(x.date || today(), null, +x.project_id || null, x.category || 'other', x.description, amount, vat, x.reference || 'petty cash');
        db.prepare("INSERT INTO payments(kind,date,amount,method,reference,bill_id) VALUES('out',?,?,'petty',?,?)").run(x.date || today(), round(amount + vat), x.reference || 'petty cash', Number(bill.lastInsertRowid));
        audit(req, 'create', 'petty_cash', Number(bill.lastInsertRowid), `${x.description} ${amount + vat}`);
        return send(res, 200, { bill_id: Number(bill.lastInsertRowid) }), true;
      }
      return false;
    },
  };
};
