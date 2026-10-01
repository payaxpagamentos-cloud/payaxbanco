'use strict';

/* Adaptador de node:sqlite (DatabaseSync) sobre o sql.js (SQLite compilado para JavaScript). */
let SQL = null;
let restaurar = null;

class DatabaseSync {
  constructor() {
    this.db = restaurar ? new SQL.Database(restaurar) : new SQL.Database();
  }
  exec(sql) { this.db.exec(sql); }
  prepare(sql) {
    const db = this.db;
    const comLinhas = (params, fn) => {
      const st = db.prepare(sql);
      try { st.bind(params); return fn(st); } finally { st.free(); }
    };
    return {
      get: (...p) => comLinhas(p, (st) => (st.step() ? st.getAsObject() : undefined)),
      all: (...p) => comLinhas(p, (st) => { const out = []; while (st.step()) out.push(st.getAsObject()); return out; }),
      run: (...p) => {
        db.run(sql, p);
        const changes = db.getRowsModified();
        const lastInsertRowid = db.exec('SELECT last_insert_rowid()')[0].values[0][0];
        return { changes, lastInsertRowid };
      },
    };
  }
  export() { return this.db.export(); }
}

module.exports = {
  DatabaseSync,
  configurar(sql, bytes) { SQL = sql; restaurar = bytes || null; },
};
