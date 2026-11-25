// D1 imité sur node:sqlite (en mémoire), avec l'API utilisée par le Worker :
// db.prepare(sql).bind(...).all() / .run() / .first(), db.batch([...]) (atomique), db.exec(sql).
import { DatabaseSync } from 'node:sqlite';

export function creerD1Factice() {
  const base = new DatabaseSync(':memory:');
  const stats = { batch: 0, requetes: 0 };
  const plat = (lignes) => lignes.map((l) => ({ ...l }));
  const executer = (sql, valeurs) => {
    stats.requetes++;
    const st = base.prepare(sql);
    if (st.columns().length) return { results: plat(st.all(...valeurs)), success: true, meta: {} };
    const r = st.run(...valeurs);
    return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  };
  const instruction = (sql, valeurs = []) => ({
    sql,
    valeurs,
    bind: (...v) => instruction(sql, v),
    all: async () => executer(sql, valeurs),
    run: async () => executer(sql, valeurs),
    first: async () => executer(sql, valeurs).results[0] || null,
  });
  return {
    base,
    stats,
    prepare: (sql) => instruction(sql),
    exec: async (sql) => { base.exec(sql); return { count: 1 }; },
    batch: async (instructions) => {
      stats.batch++;
      base.exec('BEGIN');
      try {
        const res = instructions.map((i) => executer(i.sql, i.valeurs));
        base.exec('COMMIT');
        return res;
      } catch (e) {
        base.exec('ROLLBACK');
        throw e;
      }
    },
  };
}
