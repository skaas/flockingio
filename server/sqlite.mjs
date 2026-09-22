import { DatabaseSync } from 'node:sqlite';

// The local adapter uses the same prepared statements and transactions as D1.
export function openDatabase(path = ':memory:') {
  const sqlite = new DatabaseSync(path);
  sqlite.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  function prepare(sql) {
    return {
      sql, values: [],
      bind(...values) { return { ...this, values }; },
      async first() { return sqlite.prepare(this.sql).get(...this.values) ?? null; },
      async all() { return execute(this); },
      async run() { return execute(this); },
    };
  }
  function execute(statement) {
    const query = sqlite.prepare(statement.sql);
    const results = query.columns().length ? query.all(...statement.values) : [];
    const meta = query.columns().length ? { changes: 0 } : query.run(...statement.values);
    return { success: true, results, meta: { changes: Number(meta.changes) } };
  }
  return {
    prepare,
    async batch(statements) {
      sqlite.exec('BEGIN');
      try { const result = statements.map(execute); sqlite.exec('COMMIT'); return result; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
    close() { sqlite.close(); },
  };
}
