import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

/** Ordered schema migrations; the index + 1 is stored in `PRAGMA user_version`. Append only. */
const MIGRATIONS: string[] = [
  `
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
  `
  CREATE TABLE channel_state (
    channel_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (channel_id, key)
  );
  `,
  // ─── Reach & delivery: notices, Web Push devices ──────────────────────────
  // IF NOT EXISTS: other branches may create `notices` too; the shape follows the Notice contract.
  `
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
  // ─── End reach & delivery ─────────────────────────────────────────────────
  // ─── Proactive: watch tasks (mode + de-dup fingerprints + last finding) ───
  `
  ALTER TABLE tasks ADD COLUMN mode TEXT NOT NULL DEFAULT 'do';
  ALTER TABLE tasks ADD COLUMN watch TEXT;          -- JSON Task["watch"]
  ALTER TABLE tasks ADD COLUMN fingerprints TEXT;   -- JSON string[] seen by earlier checks
  `,
  // ─── Proactive: long-term memory ──────────────────────────────────────────
  `
  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    source TEXT NOT NULL,     -- user | agent
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  // ─── End proactive ────────────────────────────────────────────────────────
  // ─── Connectors: MCP servers (url, headers and OAuth state are sealed) ────
  `
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
  // ─── End connectors ───────────────────────────────────────────────────────
  // ─── Context: per-model window overrides, cached chat summaries ───────────
  `
  ALTER TABLE providers ADD COLUMN context_windows TEXT; -- JSON Record<modelId, tokens>
  ALTER TABLE threads ADD COLUMN summary TEXT;           -- summary of the oldest turns sent to the model
  ALTER TABLE threads ADD COLUMN summarized_up_to INTEGER; -- model messages the summary covers
  `,
  // ─── End context ──────────────────────────────────────────────────────────
  // ─── Channels: per-channel bot limits, inbound delivery receipts (7 days) ─
  `
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
  // ─── End channels ─────────────────────────────────────────────────────────
  // ─── Approvals: full preview and why it asks ──────────────────────────────
  `
  ALTER TABLE approvals ADD COLUMN preview TEXT;    -- JSON ApprovalPreview
  ALTER TABLE approvals ADD COLUMN reason TEXT;
  `,
  // ─── End approvals ────────────────────────────────────────────────────────
];

export function openDatabase(dataDir: string): DatabaseSync {
  const db = new DatabaseSync(join(dataDir, "z.db"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  const current = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[i]!);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return db;
}
