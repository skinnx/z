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
  return all
    .map((t) => t.name)
    .filter((name) => name !== "schema_migrations" && !virtual.some((v) => name === v || name.startsWith(`${v}_`)));
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
      // Rows earlier migrations wrote themselves (markers in kv) count too: an upgrade must keep them all.
      const before = new Map<string, number>();
      for (const table of tables(old)) {
        before.set(table, Number((old.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n));
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
        assert.equal(rows.length, before.get(table)! + 1, `${table} keeps its rows`);
        const kept = rows.find((r) => Object.entries(row).every(([key, value]) => r[key] === value));
        assert.ok(kept, `${table}: the seeded row is unchanged`);
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

test("migrations: a database from before named migrations (user_version only) adopts them and upgrades", () => {
  const dir = tempDir();
  try {
    const old = new DatabaseSync(join(dir, "z.db"));
    migrate(old, 5);
    old.exec("DROP TABLE schema_migrations");
    old.exec("INSERT INTO kv (key, value) VALUES ('legacy', 'yes')");
    old.close();

    const db = openDatabase(dir);
    const ids = (db.prepare("SELECT id FROM schema_migrations").all() as { id: string }[]).length;
    assert.equal(ids, MIGRATION_COUNT, "every migration is recorded once");
    assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, MIGRATION_COUNT);
    assert.equal((db.prepare("SELECT value FROM kv WHERE key = 'legacy'").get() as { value: string }).value, "yes");
    db.close();
  } finally {
    cleanup(dir);
  }
});

test("migrations: settings saved before timezoneSet keep their timezone as chosen; fresh installs don't", () => {
  const dir = tempDir();
  try {
    const old = new DatabaseSync(join(dir, "z.db"));
    migrate(old, MIGRATION_COUNT - 2); // up to, not including, 0017-timezone-chosen (0018-server-text follows it)
    old.prepare("INSERT INTO kv (key, value) VALUES ('settings', ?)").run(JSON.stringify({ timezone: "UTC", handle: "z" }));
    old.close();
    const db = openDatabase(dir);
    const value = JSON.parse((db.prepare("SELECT value FROM kv WHERE key = 'settings'").get() as { value: string }).value);
    assert.equal(value.timezoneSet, true);
    assert.equal(value.timezone, "UTC");
    db.close();

    const fresh = tempDir();
    try {
      const f = openDatabase(fresh);
      assert.equal(f.prepare("SELECT value FROM kv WHERE key = 'settings'").get(), undefined, "nothing to mark on a fresh install");
      f.close();
    } finally {
      cleanup(fresh);
    }
  } finally {
    cleanup(dir);
  }
});
