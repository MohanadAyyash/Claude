// node:sqlite (DatabaseSync) on top of sql.js — enough of the API for this application.
class DatabaseSync {
  constructor() { this.db = globalThis.__ERP_SQLDB; if (!this.db) throw new Error('database is not loaded'); }
  exec(sql) { this.db.exec(sql); }
  prepare(sql) {
    const db = this.db;
    const bindable = p => p.map(v => (v === undefined ? null : typeof v === 'bigint' ? Number(v) : v));
    return {
      run(...p) { db.run(sql, bindable(p)); return { lastInsertRowid: db.exec('SELECT last_insert_rowid()')[0].values[0][0], changes: db.getRowsModified() }; },
      get(...p) { const st = db.prepare(sql); try { st.bind(bindable(p)); return st.step() ? st.getAsObject() : undefined; } finally { st.free(); } },
      all(...p) { const st = db.prepare(sql), out = []; try { st.bind(bindable(p)); while (st.step()) out.push(st.getAsObject()); return out; } finally { st.free(); } },
    };
  }
  close() {}
}
module.exports = { DatabaseSync };
