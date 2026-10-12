import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";

export class JobSQLiteD1 {
  readonly sqlite = new DatabaseSync(":memory:");
  afterStatement: ((sql: string) => Promise<void>) | null = null;
  constructor() { this.sqlite.exec(readFileSync(new URL("../../schema.sql", import.meta.url), "utf8")); }
  withSession() { return this; }
  prepare(sql: string) {
    const source = this;
    const make = (params: SQLInputValue[]) => ({
      bind(...values: SQLInputValue[]) { return make(values); },
      async first<T>() { const row = source.sqlite.prepare(sql).get(...params); await source.afterStatement?.(sql); return row as T ?? null; },
      async all<T>() { const rows = source.sqlite.prepare(sql).all(...params); await source.afterStatement?.(sql); return { success: true, results: rows as T[], meta: { changes: 0 } }; },
      async run() { const result = source.sqlite.prepare(sql).run(...params); await source.afterStatement?.(sql); return { success: true, results: [], meta: { changes: Number(result.changes) } }; },
    });
    return make([]);
  }
  async batch(statements: { run(): Promise<unknown> }[]) {
    this.sqlite.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec("COMMIT"); return results;
    } catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
  }
  env() { return { DB: this as unknown as D1Database }; }
}
