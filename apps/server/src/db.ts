import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

/**
 * Schema migrations, applied in array order; each one's id is recorded in `schema_migrations` once it ran.
 * Append only: never edit, rename or reorder one that has shipped. New ids sort after the last one
 * (`NNNN-name`), so parallel branches only ever add entries and any database upgrades from any of them.
 */
type Migration = { id: string; sql: string };
const MIGRATIONS: Migration[] = [
  {
    id: "0001-base",
    sql: `
  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE providers (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    base_url TEXT,
    headers TEXT,             -- JSON
    models TEXT NOT NULL,     -- JSON string[]
    enabled INTEGER NOT NULL,
    monthly_budget_usd REAL,
    api_key TEXT,             -- sealed
    key_hint TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE usage (
    provider_id TEXT NOT NULL,
    month TEXT NOT NULL,      -- YYYY-MM (UTC)
    tokens INTEGER NOT NULL DEFAULT 0,
    usd REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (provider_id, month)
  );

  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    instructions TEXT NOT NULL,
    schedule TEXT,
    tools TEXT,               -- JSON string[] | null
    lane TEXT NOT NULL,
    status TEXT NOT NULL,
    result TEXT,
    error TEXT,
    events TEXT NOT NULL,     -- JSON TaskEvent[]
    messages TEXT,            -- JSON ModelMessage[] while paused on approvals
    next_run_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    tool_approval_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    risk TEXT NOT NULL,
    input TEXT NOT NULL,      -- JSON
    summary TEXT NOT NULL,
    status TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL,
    decided_at TEXT
  );
  CREATE INDEX approvals_task ON approvals(task_id);

  CREATE TABLE briefings (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    summary TEXT NOT NULL,
    items TEXT NOT NULL,      -- JSON BriefItem[]
    created_at TEXT NOT NULL
  );

  CREATE TABLE channels (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    config TEXT,              -- sealed JSON
    configured TEXT NOT NULL, -- JSON string[]
    always INTEGER NOT NULL,
    lane TEXT NOT NULL,
    last_event_at TEXT,
    status TEXT NOT NULL,
    status_detail TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE plugins (
    id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL,
    settings TEXT             -- sealed JSON
  );

  CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    messages TEXT NOT NULL,   -- JSON UIMessage[]
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE bot_memory (
    channel_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    turns TEXT NOT NULL,      -- JSON BotTurn[]
    updated_at TEXT NOT NULL,
    PRIMARY KEY (channel_id, thread_id)
  );
  `,
  },
  {
    id: "0002-channel-state",
    sql: `
  CREATE TABLE channel_state (
    channel_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (channel_id, key)
  );
  `,
  },
  // ─── Reach & delivery: notices, Web Push devices ──────────────────────────
  // IF NOT EXISTS: other branches may create `notices` too; the shape follows the Notice contract.
  {
    id: "0003-notices-push",
    sql: `
  CREATE TABLE IF NOT EXISTS notices (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    path TEXT NOT NULL,
    approval_id TEXT,
    read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS notices_created ON notices(created_at);

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    keys TEXT NOT NULL,       -- sealed JSON { p256dh, auth }
    device TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
  },
  // ─── End reach & delivery ─────────────────────────────────────────────────
  // ─── Proactive: watch tasks (mode + de-dup fingerprints + last finding) ───
  {
    id: "0004-watch-tasks",
    sql: `
  ALTER TABLE tasks ADD COLUMN mode TEXT NOT NULL DEFAULT 'do';
  ALTER TABLE tasks ADD COLUMN watch TEXT;          -- JSON Task["watch"]
  ALTER TABLE tasks ADD COLUMN fingerprints TEXT;   -- JSON string[] seen by earlier checks
  `,
  },
  // ─── Proactive: long-term memory ──────────────────────────────────────────
  {
    id: "0005-memories",
    sql: `
  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    source TEXT NOT NULL,     -- user | agent
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  },
  // ─── End proactive ────────────────────────────────────────────────────────
  // ─── Connectors: MCP servers (url, headers and OAuth state are sealed) ────
  {
    id: "0006-connectors",
    sql: `
  CREATE TABLE IF NOT EXISTS connectors (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    url TEXT NOT NULL,         -- sealed
    url_display TEXT NOT NULL, -- origin + "/…"
    transport TEXT NOT NULL,
    auth TEXT NOT NULL,
    headers TEXT,              -- sealed JSON Record<string, string>
    header_keys TEXT NOT NULL, -- JSON string[]
    enabled INTEGER NOT NULL,
    public INTEGER NOT NULL,
    risks TEXT NOT NULL,       -- JSON Record<toolName, Risk>
    oauth TEXT,                -- sealed JSON: tokens, client registration, PKCE verifier, pending state
    cache TEXT,                -- JSON { server, instructions, tools }: last tools/list
    status TEXT NOT NULL,
    status_detail TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  },
  // ─── End connectors ───────────────────────────────────────────────────────
  // ─── Context: per-model window overrides, cached chat summaries ───────────
  {
    id: "0007-context-windows",
    sql: `
  ALTER TABLE providers ADD COLUMN context_windows TEXT; -- JSON Record<modelId, tokens>
  ALTER TABLE threads ADD COLUMN summary TEXT;           -- summary of the oldest turns sent to the model
  ALTER TABLE threads ADD COLUMN summarized_up_to INTEGER; -- model messages the summary covers
  `,
  },
  // ─── End context ──────────────────────────────────────────────────────────
  // ─── Channels: per-channel bot limits, inbound delivery receipts (7 days) ─
  {
    id: "0008-channel-limits",
    sql: `
  ALTER TABLE channels ADD COLUMN limits TEXT;        -- JSON ChannelLimits; NULL = defaults
  CREATE TABLE IF NOT EXISTS channel_deliveries (
    channel_id TEXT NOT NULL,
    delivery_id TEXT NOT NULL,
    received_at TEXT NOT NULL,
    PRIMARY KEY (channel_id, delivery_id)
  );
  CREATE INDEX IF NOT EXISTS channel_deliveries_received ON channel_deliveries(received_at);
  -- Webhook channels from before signed deliveries keep accepting X-Z-Secret: the store turns on
  -- their (sealed) legacySecret config once, then deletes this marker.
  INSERT INTO kv (key, value) SELECT 'migrate.webhookLegacySecret', 'true'
    WHERE EXISTS (SELECT 1 FROM channels WHERE kind = 'webhook');
  `,
  },
  // ─── End channels ─────────────────────────────────────────────────────────
  // ─── Approvals: full preview and why it asks ──────────────────────────────
  {
    id: "0009-approval-previews",
    sql: `
  ALTER TABLE approvals ADD COLUMN preview TEXT;    -- JSON ApprovalPreview
  ALTER TABLE approvals ADD COLUMN reason TEXT;
  `,
  },
  // ─── End approvals ────────────────────────────────────────────────────────
  // ─── Memory review, pinning and full-text search ──────────────────────────
  // Existing memories stay active. The FTS table keeps its own copy of the text (keyed by id, not rowid,
  // which VACUUM may renumber on a TEXT-keyed table); triggers keep it in sync.
  {
    id: "0010-memory-review-fts",
    sql: `
  ALTER TABLE memories ADD COLUMN status TEXT NOT NULL DEFAULT 'active';  -- unreviewed | active
  ALTER TABLE memories ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;

  CREATE VIRTUAL TABLE memories_fts USING fts5(id UNINDEXED, text, tokenize = 'porter unicode61 remove_diacritics 2');
  INSERT INTO memories_fts (id, text) SELECT id, text FROM memories;

  CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts (id, text) VALUES (new.id, new.text);
  END;
  CREATE TRIGGER memories_fts_delete AFTER DELETE ON memories BEGIN
    DELETE FROM memories_fts WHERE id = old.id;
  END;
  CREATE TRIGGER memories_fts_update AFTER UPDATE OF text ON memories BEGIN
    DELETE FROM memories_fts WHERE id = old.id;
    INSERT INTO memories_fts (id, text) VALUES (new.id, new.text);
  END;
  `,
  },
  // ─── End memory review ────────────────────────────────────────────────────
  // ─── Task engine: crash journal, consecutive failures, questions, briefing gaps ─
  // `task_calls`: every write/external tool call a run started, and its result once it ends.
  // A `running` task whose started call has no result was stopped mid-action and is never re-run.
  {
    id: "0011-task-engine",
    sql: `
  CREATE TABLE IF NOT EXISTS task_calls (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    tool_call_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    risk TEXT NOT NULL,
    input TEXT NOT NULL,      -- JSON
    summary TEXT NOT NULL,
    output TEXT,              -- JSON, once finished
    error TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    PRIMARY KEY (task_id, tool_call_id)
  );
  ALTER TABLE tasks ADD COLUMN failures INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN question TEXT;       -- JSON TaskQuestion & { toolCallId } while needs_input
  ALTER TABLE briefings ADD COLUMN could_not_check TEXT; -- JSON CouldNotCheck[]
  `,
  },
  // ─── End task engine ──────────────────────────────────────────────────────
  // ─── Saved sign-ins: one login per origin; username, password and TOTP secret are sealed ─
  {
    id: "0012-logins",
    sql: `
  CREATE TABLE IF NOT EXISTS logins (
    id TEXT PRIMARY KEY,
    origin TEXT NOT NULL UNIQUE,
    secret TEXT NOT NULL,      -- sealed JSON { username, password, totp? }
    has_totp INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_used_at TEXT
  );
  `,
  },
  // ─── End saved sign-ins ───────────────────────────────────────────────────
  // ─── Skills: reusable instructions invoked with /name ─────────────────────
  // A fresh install (nothing configured yet) gets the starter skills: the store seeds them once and
  // deletes this marker, so a deleted starter skill never comes back and upgrades get none.
  {
    id: "0013-skills",
    sql: `
  CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL,
    instructions TEXT NOT NULL,
    tools TEXT NOT NULL,       -- JSON string[]: tool names or globs
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  INSERT INTO kv (key, value) SELECT 'migrate.seedSkills', 'true'
    WHERE NOT EXISTS (SELECT 1 FROM providers) AND NOT EXISTS (SELECT 1 FROM tasks) AND NOT EXISTS (SELECT 1 FROM threads);
  `,
  },
  // ─── End skills ───────────────────────────────────────────────────────────
  // ─── Delivery & missed runs: notice outbox, stored questions, result de-dup, missed-run policy ─
  // `notice_deliveries`: one row per (notice, target) — a push device endpoint or the owner channel
  // (address = channel id, thread_id = owner thread). `ref` is the platform message id once sent.
  {
    id: "0014-delivery-outbox",
    sql: `
  CREATE TABLE IF NOT EXISTS notice_deliveries (
    id TEXT PRIMARY KEY,
    notice_id TEXT NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
    target TEXT NOT NULL,          -- push | channel
    address TEXT NOT NULL,         -- push endpoint | channel id
    thread_id TEXT,
    status TEXT NOT NULL,          -- pending | sent | failed | dropped
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    last_error TEXT,
    ref TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (notice_id, target, address)
  );
  CREATE INDEX IF NOT EXISTS notice_deliveries_due ON notice_deliveries(status, next_attempt_at);
  ALTER TABLE notices ADD COLUMN question TEXT;     -- JSON NoticeQuestion
  ALTER TABLE tasks ADD COLUMN missed_policy TEXT NOT NULL DEFAULT 'once';
  ALTER TABLE tasks ADD COLUMN result_hash TEXT;    -- sha256 of the last successful recurring result, whitespace-normalized
  `,
  },
  // ─── End delivery & missed runs ───────────────────────────────────────────
  // ─── Task notices carry how the run ended (Notice.status) ─────────────────
  {
    id: "0015-notice-status",
    sql: `
  ALTER TABLE notices ADD COLUMN status TEXT;       -- TaskStatus, task notices only
  `,
  },
  // ─── Codex CLI provider: optional path to the `codex` binary ──────────────
  {
    id: "0016-codex-cli",
    sql: `
  ALTER TABLE providers ADD COLUMN command TEXT;
  `,
  },
  // ─── End Codex CLI provider ───────────────────────────────────────────────
  // Settings saved before `timezoneSet` existed hold a timezone the owner may have chosen on purpose
  // (UTC included): mark it as chosen so the web app never swaps it for the browser's.
  {
    id: "0017-timezone-chosen",
    sql: `
  UPDATE kv SET value = json_set(value, '$.timezoneSet', json('true'))
    WHERE key = 'settings' AND json_extract(value, '$.timezoneSet') IS NULL;
  `,
  },
];

/** Apply migrations from the stored `user_version` up to `upTo` (all by default). Exported for tests. */
/** Apply pending migrations in order, the first `upTo` of them (all by default). Exported for tests. */
export function migrate(db: DatabaseSync, upTo = MIGRATIONS.length) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  // Databases from before named migrations counted them in user_version: adopt that many, in order.
  const legacy = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  const applied = new Set((db.prepare("SELECT id FROM schema_migrations").all() as { id: string }[]).map((r) => r.id));
  if (applied.size === 0 && legacy > 0) {
    const adopt = db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)");
    for (const m of MIGRATIONS.slice(0, legacy)) {
      adopt.run(m.id, new Date().toISOString());
      applied.add(m.id);
    }
  }
  for (const m of MIGRATIONS.slice(0, upTo)) {
    if (applied.has(m.id)) continue;
    db.exec("BEGIN");
    try {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(m.id, new Date().toISOString());
      // Kept for diagnostics and older tooling: how many migrations this database has.
      applied.add(m.id);
      db.exec(`PRAGMA user_version = ${MIGRATIONS.filter((x) => applied.has(x.id)).length}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      applied.delete(m.id);
      throw error;
    }
  }
}

export const MIGRATION_COUNT = MIGRATIONS.length;

export function openDatabase(dataDir: string): DatabaseSync {
  const db = new DatabaseSync(join(dataDir, "z.db"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}
