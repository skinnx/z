import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { migrate, MIGRATION_COUNT, openDatabase } from "../src/db.ts";
import { cleanup, tempDir } from "./harness.ts";

type Column = { name: string; type: string };
/** Plain tables only: FTS5 virtual tables and their shadow tables are SQLite's own, kept in sync by triggers. */
const tables = (db: DatabaseSync) => {
  const all = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all() as {
    name: string;
    sql: string;
  }[];
  const virtual = all.filter((t) => /^CREATE VIRTUAL TABLE/i.test(t.sql)).map((t) => t.name);
  return all.map((t) => t.name).filter((name) => !virtual.some((v) => name === v || name.startsWith(`${v}_`)));
};
const columns = (db: DatabaseSync, table: string) => db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Column[];

/** A value for every column, so foreign keys (`task_id` → tasks.id) line up across tables. */
const valueFor = (c: Column) => (c.type.includes("INT") ? 1 : c.type.includes("REAL") ? 1.5 : "1");

for (let prefix = 0; prefix < MIGRATION_COUNT; prefix++) {
  test(`migrations: a database created by the first ${prefix} migration(s) upgrades without data loss`, () => {
    const dir = tempDir();
    try {
      const old = new DatabaseSync(join(dir, "z.db"));
      old.exec("PRAGMA foreign_keys = ON");
      migrate(old, prefix);
      const seeded = new Map<string, Record<string, unknown>>();
      for (const table of tables(old)) {
        const cols = columns(old, table);
        const row = Object.fromEntries(cols.map((c) => [c.name, valueFor(c)]));
        old.prepare(`INSERT INTO ${table} (${cols.map((c) => c.name).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(
          ...(Object.values(row) as (string | number)[]),
        );
        seeded.set(table, row);
      }
      old.close();

      const db = openDatabase(dir);
      assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, MIGRATION_COUNT);
      for (const [table, row] of seeded) {
        const rows = db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
        assert.equal(rows.length, 1, `${table} keeps its row`);
        for (const [key, value] of Object.entries(row)) assert.equal(rows[0]![key], value, `${table}.${key} unchanged`);
      }
      // Only a database from before the task-engine migration has tasks without these columns.
      if (seeded.has("tasks") && !("failures" in seeded.get("tasks")!)) {
        const task = db.prepare("SELECT failures, question FROM tasks").get() as { failures: number; question: string | null };
        assert.deepEqual({ ...task }, { failures: 0, question: null }, "new task columns get their defaults");
      }
      db.close();
    } finally {
      cleanup(dir);
    }
  });
}

test("migrations: reopening an up-to-date database is a no-op", () => {
  const dir = tempDir();
  try {
    openDatabase(dir).close();
    const db = openDatabase(dir);
    assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, MIGRATION_COUNT);
    assert.ok(tables(db).includes("task_calls"));
    db.close();
  } finally {
    cleanup(dir);
  }
});
