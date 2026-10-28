/** SQLite persistence. Secrets go through the sealer and never leave as plaintext views. */
import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  ChannelLimits,
  approvalPreview,
  Lane,
  memoryTerms,
  NOT_CHECKED,
  Routing,
  Settings,
  STARTER_SKILLS,
  type Approval,
  type ApprovalStatus,
  type BotTurn,
  type BriefItem,
  type Briefing,
  type ChannelInput,
  type ConnectorInput,
  type ConnectorView,
  type ContextSummary,
  type McpToolDefinition,
  type LoginView,
  type Memory,
  type MemoryStatus,
  type Notice,
  type NoticeDelivery,
  type NoticeQuestion,
  type ProviderConfig,
  type Skill,
  type Task,
  type TaskEvent,
  type TaskQuestion,
} from "@z/core";
import type { ModelMessage, UIMessage } from "ai";
import type { z } from "zod";
import type { Sealer } from "./crypto.ts";
import type { VapidKeys } from "./webpush.ts";

type Row = Record<string, any>;
export type ChannelConfig = z.output<typeof ChannelInput>;
export type ChannelRecord = ChannelConfig & {
  configured: string[];
  lastEventAt: string | null;
  status: "ok" | "error" | "idle";
  statusDetail: string | null;
};

/** A write/external tool call a task run started (the crash journal). `finishedAt` null: no recorded result. */
export type TaskCall = {
  toolCallId: string;
  tool: string;
  risk: string;
  input: unknown;
  summary: string;
  output: unknown;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
};

/** A notice delivery as stored: the contract's NoticeDelivery plus where it goes and the sent message's ref. */
export type DeliveryRecord = NoticeDelivery & { address: string; threadId: string | null; ref: string | null };

/** Stored question: the contract's TaskQuestion plus the `ask_person` call it answers. */
export type StoredQuestion = TaskQuestion & { toolCallId: string };

export type ConnectorConfig = Omit<z.output<typeof ConnectorInput>, "url" | "headers"> & { url: string; headers: Record<string, string> };
/** Last successful `initialize` + `tools/list`, so views and tool names survive restarts. */
export type ConnectorCache = { server: { name: string; version: string } | null; instructions: string | null; tools: McpToolDefinition[] };
export type ConnectorRecord = ConnectorConfig & {
  urlDisplay: string;
  status: ConnectorView["status"];
  statusDetail: string | null;
  cache: ConnectorCache | null;
  hasOAuth: boolean;
  updatedAt: string;
};

const json = (value: unknown) => JSON.stringify(value ?? null);
const parse = <T>(value: string | null | undefined, fallback: T): T => (value ? (JSON.parse(value) as T) : fallback);
const now = () => new Date().toISOString();
const month = () => new Date().toISOString().slice(0, 7);
const MAX_EVENTS = 300;
const MAX_BOT_TURNS = 20;

export type Store = ReturnType<typeof createStore>;

export function createStore(db: DatabaseSync, sealer: Sealer) {
  const all = (sql: string, ...params: SQLInputValue[]) => db.prepare(sql).all(...params) as Row[];
  const get = (sql: string, ...params: SQLInputValue[]) => db.prepare(sql).get(...params) as Row | undefined;
  const run = (sql: string, ...params: SQLInputValue[]) => db.prepare(sql).run(...params);

  const kv = {
    get: <T>(key: string): T | undefined => {
      const row = get("SELECT value FROM kv WHERE key = ?", key);
      return row ? (JSON.parse(row.value) as T) : undefined;
    },
    set: (key: string, value: unknown) =>
      run("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, json(value)),
  };

  // ─── Settings & routing ───────────────────────────────────────────────────

  const settings = {
    get: (): Settings => Settings.parse(kv.get("settings") ?? {}),
    set: (value: Settings) => kv.set("settings", value),
  };

  const emptyRouting = (): Routing => Object.fromEntries(Lane.options.map((l) => [l, []])) as unknown as Routing;
  const routing = {
    get: (): Routing => ({ ...emptyRouting(), ...(kv.get<Routing>("routing") ?? {}) }),
    set: (value: Routing) => kv.set("routing", value),
  };

  // ─── Providers & usage ────────────────────────────────────────────────────

  const toProvider = (r: Row): ProviderConfig => ({
    id: r.id,
    kind: r.kind,
    label: r.label,
    ...(r.base_url ? { baseURL: r.base_url } : {}),
    ...(r.headers ? { headers: parse(r.headers, {}) } : {}),
    models: parse(r.models, []),
    enabled: Boolean(r.enabled),
    ...(r.monthly_budget_usd !== null ? { monthlyBudgetUsd: r.monthly_budget_usd } : {}),
    ...(r.context_windows ? { contextWindows: parse(r.context_windows, {}) } : {}),
    ...(r.command ? { command: r.command } : {}),
    apiKey: r.api_key ? sealer.open(r.api_key) : null,
  });

  const providers = {
    list: (): ProviderConfig[] => all("SELECT * FROM providers ORDER BY created_at").map(toProvider),
    get: (id: string) => {
      const r = get("SELECT * FROM providers WHERE id = ?", id);
      return r ? toProvider(r) : null;
    },
    keyHint: (id: string): string | null => get("SELECT key_hint FROM providers WHERE id = ?", id)?.key_hint ?? null,
    /** `apiKey`: undefined keeps the stored key, "" clears it. */
    upsert: (p: Omit<ProviderConfig, "apiKey">, apiKey: string | undefined) => {
      const existing = get("SELECT api_key, key_hint, created_at FROM providers WHERE id = ?", p.id);
      const sealed = apiKey === undefined ? (existing?.api_key ?? null) : apiKey ? sealer.seal(apiKey) : null;
      const hint = apiKey === undefined ? (existing?.key_hint ?? null) : apiKey ? apiKey.slice(-4) : null;
      run(
        `INSERT OR REPLACE INTO providers (id, kind, label, base_url, headers, models, enabled, monthly_budget_usd, context_windows, command, api_key, key_hint, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        p.id,
        p.kind,
        p.label,
        p.baseURL ?? null,
        p.headers ? json(p.headers) : null,
        json(p.models),
        p.enabled ? 1 : 0,
        p.monthlyBudgetUsd ?? null,
        p.contextWindows ? json(p.contextWindows) : null,
        p.command ?? null,
        sealed,
        hint,
        existing?.created_at ?? now(),
        now(),
      );
    },
    delete: (id: string) => run("DELETE FROM providers WHERE id = ?", id).changes > 0,
  };

  const usage = {
    add: (providerId: string, tokens: number, usd: number) =>
      run(
        `INSERT INTO usage (provider_id, month, tokens, usd) VALUES (?, ?, ?, ?)
         ON CONFLICT(provider_id, month) DO UPDATE SET tokens = tokens + excluded.tokens, usd = usd + excluded.usd`,
        providerId,
        month(),
        tokens,
        usd,
      ),
    month: (providerId: string) => {
      const r = get("SELECT tokens, usd FROM usage WHERE provider_id = ? AND month = ?", providerId, month());
      return { monthUsd: r?.usd ?? 0, monthTokens: r?.tokens ?? 0 };
    },
  };

  // ─── Tasks & approvals ────────────────────────────────────────────────────

  const toTask = (r: Row): Task => ({
    id: r.id,
    title: r.title,
    instructions: r.instructions,
    schedule: r.schedule,
    tools: parse(r.tools, null),
    lane: r.lane,
    mode: r.mode === "watch" ? "watch" : "do",
    ...(r.mode === "watch" ? { watch: parse<NonNullable<Task["watch"]>>(r.watch, { lastCheckAt: null, lastFinding: null }) } : {}),
    status: r.status,
    result: r.result,
    error: r.error,
    events: parse(r.events, []),
    nextRunAt: r.next_run_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...publicQuestion(parse<StoredQuestion | null>(r.question, null)),
    failures: r.failures ?? 0,
    missedPolicy: r.missed_policy === "skip" ? "skip" : "once",
  });
  const publicQuestion = (q: StoredQuestion | null) =>
    q ? { question: { question: q.question, choices: q.choices, askedAt: q.askedAt } } : { question: null };

  const toCall = (r: Row): TaskCall => ({
    toolCallId: r.tool_call_id,
    tool: r.tool,
    risk: r.risk,
    input: parse(r.input, null),
    summary: r.summary,
    output: parse(r.output, null),
    error: r.error,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  });

  const tasks = {
    list: (): Task[] => all("SELECT * FROM tasks ORDER BY created_at DESC").map(toTask),
    get: (id: string) => {
      const r = get("SELECT * FROM tasks WHERE id = ?", id);
      return r ? toTask(r) : null;
    },
    insert: (t: Task) =>
      run(
        `INSERT INTO tasks (id, title, instructions, schedule, tools, lane, mode, watch, status, result, error, events, next_run_at, created_at, updated_at, missed_policy)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        t.id,
        t.title,
        t.instructions,
        t.schedule,
        t.tools ? json(t.tools) : null,
        t.lane,
        t.mode ?? "do",
        t.watch ? json(t.watch) : null,
        t.status,
        t.result,
        t.error,
        json(t.events),
        t.nextRunAt,
        t.createdAt,
        t.updatedAt,
        t.missedPolicy ?? "once",
      ),
    update: (id: string, patch: Partial<Pick<Task, "title" | "status" | "result" | "error" | "nextRunAt" | "failures">>): Task | null => {
      const columns: Record<string, string> = {
        title: "title",
        status: "status",
        result: "result",
        error: "error",
        nextRunAt: "next_run_at",
        failures: "failures",
      };
      const entries = Object.entries(patch).filter(([k]) => k in columns);
      if (entries.length) {
        run(
          `UPDATE tasks SET ${entries.map(([k]) => `${columns[k]} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
          ...entries.map(([, v]) => (v ?? null) as SQLInputValue),
          now(),
          id,
        );
      }
      return tasks.get(id);
    },
    appendEvents: (id: string, events: TaskEvent[]) => {
      const current = parse<TaskEvent[]>(get("SELECT events FROM tasks WHERE id = ?", id)?.events, []);
      run("UPDATE tasks SET events = ?, updated_at = ? WHERE id = ?", json([...current, ...events].slice(-MAX_EVENTS)), now(), id);
    },
    messages: (id: string): ModelMessage[] | null => parse(get("SELECT messages FROM tasks WHERE id = ?", id)?.messages, null),
    setMessages: (id: string, messages: ModelMessage[] | null) =>
      run("UPDATE tasks SET messages = ? WHERE id = ?", messages ? json(messages) : null, id),
    /** Watch tasks: fingerprints of findings already notified, oldest first. */
    fingerprints: (id: string): string[] => parse(get("SELECT fingerprints FROM tasks WHERE id = ?", id)?.fingerprints, []),
    /** Record a watch check; `added` fingerprints are appended (capped). */
    recordWatch: (id: string, watch: NonNullable<Task["watch"]>, added: string[], cap: number) => {
      const next = [...tasks.fingerprints(id), ...added].slice(-cap);
      run("UPDATE tasks SET watch = ?, fingerprints = ?, updated_at = ? WHERE id = ?", json(watch), json(next), now(), id);
    },
    /** The open `ask_person` question, with its tool call id. */
    question: (id: string): StoredQuestion | null => parse(get("SELECT question FROM tasks WHERE id = ?", id)?.question, null),
    setQuestion: (id: string, question: StoredQuestion | null) =>
      run("UPDATE tasks SET question = ?, updated_at = ? WHERE id = ?", question ? json(question) : null, now(), id),
    /** Crash journal: write/external calls of the current run. */
    calls: (id: string): TaskCall[] => all("SELECT * FROM task_calls WHERE task_id = ? ORDER BY started_at", id).map(toCall),
    callStarted: (id: string, c: { toolCallId: string; tool: string; risk: string; input: unknown; summary: string }) =>
      run(
        `INSERT OR REPLACE INTO task_calls (task_id, tool_call_id, tool, risk, input, summary, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        id,
        c.toolCallId,
        c.tool,
        c.risk,
        json(c.input),
        c.summary,
        now(),
      ),
    callFinished: (id: string, toolCallId: string, result: { output?: unknown; error?: string }) =>
      run(
        "UPDATE task_calls SET output = ?, error = ?, finished_at = ? WHERE task_id = ? AND tool_call_id = ?",
        result.output === undefined ? null : json(result.output),
        result.error ?? null,
        now(),
        id,
        toolCallId,
      ),
    clearCalls: (id: string) => run("DELETE FROM task_calls WHERE task_id = ?", id),
    /** Recurring tasks: hash of the last successful result, to skip notices that repeat it. */
    resultHash: (id: string): string | null => (get("SELECT result_hash FROM tasks WHERE id = ?", id)?.result_hash as string | null) ?? null,
    setResultHash: (id: string, hash: string | null) => run("UPDATE tasks SET result_hash = ? WHERE id = ?", hash, id),
    byStatus: (...statuses: Task["status"][]) =>
      all(`SELECT * FROM tasks WHERE status IN (${statuses.map(() => "?").join(",")})`, ...statuses).map(toTask),
    delete: (id: string) => run("DELETE FROM tasks WHERE id = ?", id).changes > 0,
  };

  const toApproval = (r: Row): Approval => ({
    id: r.id,
    taskId: r.task_id,
    toolApprovalId: r.tool_approval_id,
    tool: r.tool,
    risk: r.risk,
    input: parse(r.input, null),
    summary: r.summary,
    // Rows from before previews existed get one rebuilt from the stored input.
    preview: parse(r.preview, null) ?? approvalPreview(r.tool, parse(r.input, null), { summary: r.summary }),
    reason: r.reason ?? null,
    status: r.status,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
  });

  const approvals = {
    list: (status?: ApprovalStatus) =>
      (status
        ? all("SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC", status)
        : all("SELECT * FROM approvals ORDER BY created_at DESC")
      ).map(toApproval),
    get: (id: string) => {
      const r = get("SELECT * FROM approvals WHERE id = ?", id);
      return r ? toApproval(r) : null;
    },
    forTask: (taskId: string) => all("SELECT * FROM approvals WHERE task_id = ? ORDER BY created_at", taskId).map(toApproval),
    note: (id: string): string | null => get("SELECT note FROM approvals WHERE id = ?", id)?.note ?? null,
    insert: (a: Approval) =>
      run(
        `INSERT INTO approvals (id, task_id, tool_approval_id, tool, risk, input, summary, preview, reason, status, created_at, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        a.id,
        a.taskId,
        a.toolApprovalId,
        a.tool,
        a.risk,
        json(a.input),
        a.summary,
        json(a.preview),
        a.reason,
        a.status,
        a.createdAt,
        a.decidedAt,
      ),
    decide: (id: string, status: ApprovalStatus, note: string | null) => {
      run("UPDATE approvals SET status = ?, note = ?, decided_at = ? WHERE id = ?", status, note, now(), id);
      return approvals.get(id)!;
    },
    /** Expire a task's pending approvals; returns the expired ones. */
    expireForTask: (taskId: string) => {
      const pending = all("SELECT id FROM approvals WHERE task_id = ? AND status = 'pending'", taskId);
      run("UPDATE approvals SET status = 'expired', decided_at = ? WHERE task_id = ? AND status = 'pending'", now(), taskId);
      return pending.map((r) => approvals.get(r.id)!);
    },
  };

  // ─── Briefings ────────────────────────────────────────────────────────────

  const toBriefing = (r: Row): Briefing => ({
    id: r.id,
    date: r.date,
    summary: r.summary,
    // Briefings from before triage: nothing sorted them, so they read as needing the user.
    items: parse<Partial<BriefItem>[]>(r.items, []).map((i) => ({ priority: "needs_you", reason: NOT_CHECKED, decidedBy: "rule", ...i }) as BriefItem),
    ...(r.could_not_check ? { couldNotCheck: parse(r.could_not_check, []) } : {}),
    createdAt: r.created_at,
  });

  const briefings = {
    latest: () => {
      const r = get("SELECT * FROM briefings ORDER BY created_at DESC LIMIT 1");
      return r ? toBriefing(r) : null;
    },
    all: () => all("SELECT * FROM briefings ORDER BY created_at DESC").map(toBriefing),
    insert: (b: Briefing) =>
      run(
        "INSERT INTO briefings (id, date, summary, items, could_not_check, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        b.id,
        b.date,
        b.summary,
        json(b.items),
        b.couldNotCheck?.length ? json(b.couldNotCheck) : null,
        b.createdAt,
      ),
  };

  // ─── Channels ─────────────────────────────────────────────────────────────

  const toChannel = (r: Row): ChannelRecord => ({
    id: r.id,
    kind: r.kind,
    label: r.label,
    enabled: Boolean(r.enabled),
    config: sealer.openJson(r.config, {}),
    always: Boolean(r.always),
    lane: r.lane,
    limits: ChannelLimits.parse(parse(r.limits, {})),
    configured: parse(r.configured, []),
    lastEventAt: r.last_event_at,
    status: r.status,
    statusDetail: r.status_detail,
  });

  const channels = {
    list: () => all("SELECT * FROM channels ORDER BY created_at").map(toChannel),
    get: (id: string) => {
      const r = get("SELECT * FROM channels WHERE id = ?", id);
      return r ? toChannel(r) : null;
    },
    upsert: (c: ChannelConfig) => {
      const existing = get("SELECT created_at, last_event_at, status, status_detail FROM channels WHERE id = ?", c.id);
      const configured = Object.keys(c.config).filter((k) => c.config[k]);
      run(
        `INSERT OR REPLACE INTO channels (id, kind, label, enabled, config, configured, always, lane, limits, last_event_at, status, status_detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        c.id,
        c.kind,
        c.label,
        c.enabled ? 1 : 0,
        sealer.sealJson(c.config),
        json(configured),
        c.always ? 1 : 0,
        c.lane,
        json(c.limits),
        existing?.last_event_at ?? null,
        existing?.status ?? "idle",
        existing?.status_detail ?? null,
        existing?.created_at ?? now(),
      );
    },
    setStatus: (id: string, status: ChannelRecord["status"], detail: string | null) =>
      run("UPDATE channels SET status = ?, status_detail = ? WHERE id = ?", status, detail, id),
    touch: (id: string) => run("UPDATE channels SET last_event_at = ? WHERE id = ?", now(), id),
    delete: (id: string) => {
      run("DELETE FROM bot_memory WHERE channel_id = ?", id);
      run("DELETE FROM channel_state WHERE channel_id = ?", id);
      run("DELETE FROM channel_deliveries WHERE channel_id = ?", id);
      return run("DELETE FROM channels WHERE id = ?", id).changes > 0;
    },
  };

  if (kv.get("migrate.webhookLegacySecret")) {
    for (const c of channels.list()) {
      if (c.kind === "webhook") channels.upsert({ ...c, config: { ...c.config, legacySecret: "on" } });
    }
    run("DELETE FROM kv WHERE key = 'migrate.webhookLegacySecret'");
  }

  /** Inbound delivery receipts (ChannelRuntime.deliveries), pruned after 7 days. */
  const DELIVERY_TTL_MS = 7 * 24 * 3600_000;
  let prunedAt = 0;
  const deliveries = {
    claim: (channelId: string, deliveryId: string): boolean => {
      if (Date.now() - prunedAt > 3600_000) {
        prunedAt = Date.now();
        run("DELETE FROM channel_deliveries WHERE received_at < ?", new Date(Date.now() - DELIVERY_TTL_MS).toISOString());
      }
      return (
        run("INSERT OR IGNORE INTO channel_deliveries (channel_id, delivery_id, received_at) VALUES (?, ?, ?)", channelId, deliveryId, now())
          .changes > 0
      );
    },
    release: (channelId: string, deliveryId: string) =>
      run("DELETE FROM channel_deliveries WHERE channel_id = ? AND delivery_id = ?", channelId, deliveryId),
  };

  /** Adapter cursors and ids (ChannelRuntime.state). */
  // Adapters keep cursors here, but also rotated credentials (X refresh tokens), so every value is sealed.
  const channelState = {
    get: (channelId: string, key: string): string | null => {
      const value = get("SELECT value FROM channel_state WHERE channel_id = ? AND key = ?", channelId, key)?.value;
      if (value == null) return null;
      try {
        return sealer.open(value);
      } catch {
        return value; // written before values were sealed; sealed on the next set
      }
    },
    set: (channelId: string, key: string, value: string) =>
      run("INSERT OR REPLACE INTO channel_state (channel_id, key, value) VALUES (?, ?, ?)", channelId, key, sealer.seal(value)),
  };

  const memory = {
    get: (channelId: string, threadId: string): BotTurn[] =>
      parse(get("SELECT turns FROM bot_memory WHERE channel_id = ? AND thread_id = ?", channelId, threadId)?.turns, []),
    append: (channelId: string, threadId: string, turns: BotTurn[]) =>
      run(
        `INSERT OR REPLACE INTO bot_memory (channel_id, thread_id, turns, updated_at) VALUES (?, ?, ?, ?)`,
        channelId,
        threadId,
        json([...memory.get(channelId, threadId), ...turns].slice(-MAX_BOT_TURNS)),
        now(),
      ),
  };

  // ─── Connectors ───────────────────────────────────────────────────────────

  /** Origin only: some services put the secret in the path or query. */
  const urlDisplay = (url: string) => {
    try {
      return `${new URL(url).origin}/…`;
    } catch {
      return "…";
    }
  };

  const toConnector = (r: Row): ConnectorRecord => ({
    id: r.id,
    label: r.label,
    url: sealer.open(r.url),
    urlDisplay: r.url_display,
    transport: r.transport,
    auth: r.auth,
    headers: sealer.openJson(r.headers, {}),
    enabled: Boolean(r.enabled),
    public: Boolean(r.public),
    risks: parse(r.risks, {}),
    status: r.status,
    statusDetail: r.status_detail,
    cache: parse(r.cache, null),
    hasOAuth: Boolean(r.oauth),
    updatedAt: r.updated_at,
  });

  const connectors = {
    list: () => all("SELECT * FROM connectors ORDER BY created_at").map(toConnector),
    get: (id: string) => {
      const r = get("SELECT * FROM connectors WHERE id = ?", id);
      return r ? toConnector(r) : null;
    },
    upsert: (c: ConnectorConfig) => {
      const existing = get("SELECT created_at, status, status_detail, cache, oauth FROM connectors WHERE id = ?", c.id);
      run(
        `INSERT OR REPLACE INTO connectors (id, label, url, url_display, transport, auth, headers, header_keys, enabled, public, risks, oauth, cache, status, status_detail, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        c.id,
        c.label,
        sealer.seal(c.url),
        urlDisplay(c.url),
        c.transport,
        c.auth,
        sealer.sealJson(c.headers),
        json(Object.keys(c.headers)),
        c.enabled ? 1 : 0,
        c.public ? 1 : 0,
        json(c.risks),
        existing?.oauth ?? null,
        existing?.cache ?? null,
        existing?.status ?? "connecting",
        existing?.status_detail ?? null,
        existing?.created_at ?? now(),
        now(),
      );
    },
    setStatus: (id: string, status: ConnectorRecord["status"], detail: string | null) =>
      run("UPDATE connectors SET status = ?, status_detail = ? WHERE id = ?", status, detail, id),
    setCache: (id: string, cache: ConnectorCache | null) => run("UPDATE connectors SET cache = ? WHERE id = ?", cache ? json(cache) : null, id),
    /** Sealed OAuth state (tokens, client registration, PKCE verifier, pending state). */
    oauth: <T>(id: string): T | null => sealer.openJson<T | null>(get("SELECT oauth FROM connectors WHERE id = ?", id)?.oauth ?? null, null),
    setOAuth: (id: string, value: unknown) => run("UPDATE connectors SET oauth = ? WHERE id = ?", value ? sealer.sealJson(value) : null, id),
    delete: (id: string) => run("DELETE FROM connectors WHERE id = ?", id).changes > 0,
  };

  // ─── Memory ───────────────────────────────────────────────────────────────

  const toMemory = (r: Row): Memory => ({
    id: r.id,
    text: r.text,
    source: r.source,
    status: r.status,
    pinned: Boolean(r.pinned),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
  type MemoryFilter = { status?: MemoryStatus; pinned?: boolean };
  const memoryWhere = ({ status, pinned }: MemoryFilter, where: string[] = [], params: SQLInputValue[] = []) => {
    if (status) {
      where.push("m.status = ?");
      params.push(status);
    }
    if (pinned !== undefined) {
      where.push("m.pinned = ?");
      params.push(pinned ? 1 : 0);
    }
    return { sql: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
  };

  const memories = {
    /** Newest first. */
    list: (filter: MemoryFilter = {}, limit = -1): Memory[] => {
      const where = memoryWhere(filter);
      return all(`SELECT m.* FROM memories m ${where.sql} ORDER BY m.updated_at DESC LIMIT ?`, ...where.params, limit).map(toMemory);
    },
    /** Full-text (FTS5) matches for any word of `query`, best bm25 first; none when it has no searchable words. */
    search: (query: string, filter: MemoryFilter = {}, limit = 50): Memory[] => {
      const terms = memoryTerms(query);
      if (terms.length === 0) return [];
      // Terms are letters and digits only, so quoting them is enough. Longer ones also match as prefixes, cut
      // back two letters so word forms the porter stemmer splits differently still meet ("allergy" → allergic).
      const prefix = (t: string) => (t.length >= 6 ? `"${t.slice(0, -2)}"*` : t.length >= 4 ? `"${t}"*` : `"${t}"`);
      const match = terms.map(prefix).join(" OR ");
      const where = memoryWhere(filter, ["memories_fts MATCH ?"], [match]);
      return all(
        `SELECT m.* FROM memories_fts JOIN memories m ON m.id = memories_fts.id ${where.sql}
         ORDER BY bm25(memories_fts), m.updated_at DESC LIMIT ?`,
        ...where.params,
        limit,
      ).map(toMemory);
    },
    /** For prompts (core `MemoryRecall`): active only. Pinned ones, then unpinned matches for `query`, then recent unpinned. */
    recall: (query: string): Memory[] => {
      const hits = memories.search(query, { status: "active", pinned: false }, 30);
      const seen = new Set(hits.map((m) => m.id));
      return [
        ...memories.list({ status: "active", pinned: true }),
        ...hits,
        ...memories.list({ status: "active", pinned: false }, 30).filter((m) => !seen.has(m.id)),
      ];
    },
    get: (id: string) => {
      const r = get("SELECT * FROM memories WHERE id = ?", id);
      return r ? toMemory(r) : null;
    },
    /** Same text again only refreshes the existing memory (and activates it when `status` is active). */
    add: (id: string, text: string, source: Memory["source"], status: MemoryStatus, pinned = false): Memory => {
      const existing = get("SELECT id FROM memories WHERE lower(text) = lower(?)", text);
      if (existing) {
        run(
          "UPDATE memories SET updated_at = ?, status = CASE WHEN ? = 'active' THEN 'active' ELSE status END WHERE id = ?",
          now(),
          status,
          existing.id,
        );
        return memories.get(existing.id)!;
      }
      run(
        "INSERT INTO memories (id, text, source, status, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        id,
        text,
        source,
        status,
        pinned ? 1 : 0,
        now(),
        now(),
      );
      return memories.get(id)!;
    },
    /** The owner wrote this version, so it is active from now on. */
    update: (id: string, text: string, pinned?: boolean): Memory | null => {
      run("UPDATE memories SET text = ?, status = 'active', pinned = coalesce(?, pinned), updated_at = ? WHERE id = ?", text, pinned === undefined ? null : pinned ? 1 : 0, now(), id);
      return memories.get(id);
    },
    confirm: (id: string): Memory | null => {
      run("UPDATE memories SET status = 'active', updated_at = ? WHERE id = ? AND status = 'unreviewed'", now(), id);
      return memories.get(id);
    },
    pin: (id: string, pinned: boolean): Memory | null => {
      run("UPDATE memories SET pinned = ? WHERE id = ?", pinned ? 1 : 0, id);
      return memories.get(id);
    },
    delete: (id: string) => run("DELETE FROM memories WHERE id = ?", id).changes > 0,
    clear: () => Number(run("DELETE FROM memories").changes),
  };

  // ─── Skills ───────────────────────────────────────────────────────────────

  const toSkill = (r: Row): Skill => ({
    id: r.id,
    name: r.name,
    description: r.description,
    instructions: r.instructions,
    tools: parse(r.tools, []),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });

  const skills = {
    list: (): Skill[] => all("SELECT * FROM skills ORDER BY name").map(toSkill),
    get: (id: string): Skill | null => {
      const r = get("SELECT * FROM skills WHERE id = ?", id);
      return r ? toSkill(r) : null;
    },
    byName: (name: string): Skill | null => {
      const r = get("SELECT * FROM skills WHERE name = ?", name);
      return r ? toSkill(r) : null;
    },
    /** Insert, or replace `id`. The caller checks that the name is free. */
    save: (id: string, input: Omit<Skill, "id" | "createdAt" | "updatedAt">): Skill => {
      const existing = get("SELECT created_at FROM skills WHERE id = ?", id);
      run(
        `INSERT INTO skills (id, name, description, instructions, tools, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, instructions = excluded.instructions,
           tools = excluded.tools, updated_at = excluded.updated_at`,
        id,
        input.name,
        input.description,
        input.instructions,
        json(input.tools),
        existing?.created_at ?? now(),
        now(),
      );
      return skills.get(id)!;
    },
    delete: (id: string) => run("DELETE FROM skills WHERE id = ?", id).changes > 0,
  };

  // Fresh install only (see the skills migration): the starter skills, once.
  if (kv.get("migrate.seedSkills")) {
    for (const skill of STARTER_SKILLS) if (!skills.byName(skill.name)) skills.save(randomUUID(), skill);
    run("DELETE FROM kv WHERE key = 'migrate.seedSkills'");
  }

  // ─── Plugins ──────────────────────────────────────────────────────────────

  const plugins = {
    get: (id: string): { enabled: boolean; settings: Record<string, string> } | null => {
      const r = get("SELECT * FROM plugins WHERE id = ?", id);
      return r ? { enabled: Boolean(r.enabled), settings: sealer.openJson(r.settings, {}) } : null;
    },
    set: (id: string, enabled: boolean, settings: Record<string, string>) =>
      run("INSERT OR REPLACE INTO plugins (id, enabled, settings) VALUES (?, ?, ?)", id, enabled ? 1 : 0, sealer.sealJson(settings)),
  };

  // ─── Chat threads ─────────────────────────────────────────────────────────

  const threads = {
    list: () =>
      all("SELECT id, title, updated_at FROM threads ORDER BY updated_at DESC").map((r) => ({
        id: r.id as string,
        title: r.title as string,
        updatedAt: r.updated_at as string,
      })),
    get: (id: string) => {
      const r = get("SELECT * FROM threads WHERE id = ?", id);
      return r ? { id: r.id as string, title: r.title as string, messages: parse<UIMessage[]>(r.messages, []) } : null;
    },
    save: (id: string, title: string, messages: UIMessage[]) => {
      // Upsert, not replace: the cached summary stays with the thread.
      run(
        `INSERT INTO threads (id, title, messages, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET messages = excluded.messages, updated_at = excluded.updated_at`,
        id,
        title,
        json(messages),
        now(),
        now(),
      );
    },
    /** The summary of the oldest turns last sent to the model in place of them. */
    summary: (id: string): ContextSummary | null => {
      const r = get("SELECT summary, summarized_up_to FROM threads WHERE id = ?", id);
      return r?.summary ? { text: r.summary, upTo: Number(r.summarized_up_to) } : null;
    },
    setSummary: (id: string, summary: ContextSummary) =>
      run("UPDATE threads SET summary = ?, summarized_up_to = ? WHERE id = ?", summary.text, summary.upTo, id),
    delete: (id: string) => run("DELETE FROM threads WHERE id = ?", id).changes > 0,
    clear: () => Number(run("DELETE FROM threads").changes),
    /** Every thread with its messages, for export. */
    all: () =>
      all("SELECT * FROM threads ORDER BY updated_at DESC").map((r) => ({
        id: r.id as string,
        title: r.title as string,
        messages: parse<UIMessage[]>(r.messages, []),
        createdAt: r.created_at as string,
        updatedAt: r.updated_at as string,
      })),
  };

  // ─── Notices & Web Push ───────────────────────────────────────────────────

  const toNotice = (r: Row): Notice => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    body: r.body,
    path: r.path,
    ...(r.approval_id ? { approvalId: r.approval_id } : {}),
    ...(r.question ? { question: parse<NoticeQuestion>(r.question, { taskId: "", text: "", choices: [] }) } : {}),
    ...(r.status ? { status: r.status } : {}),
    read: Boolean(r.read),
    createdAt: r.created_at,
  });

  const notices = {
    list: (limit = 100): Notice[] => all("SELECT * FROM notices ORDER BY created_at DESC LIMIT ?", limit).map(toNotice),
    insert: (n: Notice) =>
      run(
        "INSERT INTO notices (id, kind, title, body, path, approval_id, question, status, read, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        n.id,
        n.kind,
        n.title,
        n.body,
        n.path,
        n.approvalId ?? null,
        n.question ? json(n.question) : null,
        n.status ?? null,
        n.read ? 1 : 0,
        n.createdAt,
      ),
    get: (id: string): Notice | null => {
      const r = get("SELECT * FROM notices WHERE id = ?", id);
      return r ? toNotice(r) : null;
    },
    forApproval: (approvalId: string): Notice[] => all("SELECT * FROM notices WHERE approval_id = ?", approvalId).map(toNotice),
    /** Question notices of a task that are still unanswered. */
    openQuestions: (taskId: string): Notice[] =>
      all(
        "SELECT * FROM notices WHERE question IS NOT NULL AND json_extract(question, '$.taskId') = ? AND json_extract(question, '$.answer') IS NULL",
        taskId,
      ).map(toNotice),
    setQuestion: (id: string, question: NoticeQuestion) => run("UPDATE notices SET question = ? WHERE id = ?", json(question), id),
    /** All when `ids` is omitted. */
    markRead: (ids?: string[]) => {
      if (!ids) return run("UPDATE notices SET read = 1 WHERE read = 0");
      for (const id of ids) run("UPDATE notices SET read = 1 WHERE id = ?", id);
    },
  };

  // ─── Notice outbox: one delivery per (notice, target), retried with backoff ─

  const toDelivery = (r: Row): DeliveryRecord => ({
    id: r.id,
    noticeId: r.notice_id,
    target: r.target,
    address: r.address,
    threadId: r.thread_id ?? null,
    status: r.status,
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at ?? null,
    lastError: r.last_error ?? null,
    ref: r.ref ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });

  const outbox = {
    /** Insert pending deliveries (a repeated (notice, target, address) is ignored). */
    insert: (rows: Pick<DeliveryRecord, "id" | "noticeId" | "target" | "address" | "threadId" | "nextAttemptAt">[], at: string) => {
      for (const d of rows) {
        run(
          `INSERT OR IGNORE INTO notice_deliveries (id, notice_id, target, address, thread_id, status, attempts, next_attempt_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
          d.id,
          d.noticeId,
          d.target,
          d.address,
          d.threadId,
          d.nextAttemptAt,
          at,
          at,
        );
      }
    },
    get: (id: string): DeliveryRecord | null => {
      const r = get("SELECT * FROM notice_deliveries WHERE id = ?", id);
      return r ? toDelivery(r) : null;
    },
    forNotice: (noticeId: string): DeliveryRecord[] =>
      all("SELECT * FROM notice_deliveries WHERE notice_id = ? ORDER BY created_at, target", noticeId).map(toDelivery),
    /** Pending deliveries due at `at` (ISO), oldest first. */
    due: (at: string): DeliveryRecord[] =>
      all("SELECT * FROM notice_deliveries WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at", at).map(toDelivery),
    /** When the earliest pending delivery is due, or null when none waits. */
    nextDueAt: (): string | null =>
      (get("SELECT MIN(next_attempt_at) AS at FROM notice_deliveries WHERE status = 'pending'")?.at as string | null) ?? null,
    update: (id: string, patch: Partial<Pick<DeliveryRecord, "status" | "attempts" | "nextAttemptAt" | "lastError" | "ref">>, at: string) => {
      const columns: Record<string, string> = { status: "status", attempts: "attempts", nextAttemptAt: "next_attempt_at", lastError: "last_error", ref: "ref" };
      const entries = Object.entries(patch).filter(([k]) => k in columns);
      if (!entries.length) return;
      run(
        `UPDATE notice_deliveries SET ${entries.map(([k]) => `${columns[k]} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
        ...entries.map(([, v]) => (v ?? null) as SQLInputValue),
        at,
        id,
      );
    },
  };

  // ─── Saved sign-ins ───────────────────────────────────────────────────────

  type LoginSecret = { username: string; password: string; totp?: string };
  const toLogin = (r: Row): LoginView => ({
    id: r.id,
    origin: r.origin,
    username: sealer.openJson<LoginSecret>(r.secret, { username: "", password: "" }).username,
    hasTotp: Boolean(r.has_totp),
    updatedAt: r.updated_at,
    lastUsedAt: r.last_used_at ?? null,
  });

  const logins = {
    list: (): LoginView[] => all("SELECT * FROM logins ORDER BY origin").map(toLogin),
    get: (id: string): LoginView | null => {
      const r = get("SELECT * FROM logins WHERE id = ?", id);
      return r ? toLogin(r) : null;
    },
    byOrigin: (origin: string) => {
      const r = get("SELECT * FROM logins WHERE origin = ?", origin);
      return r ? { id: r.id as string, ...sealer.openJson<LoginSecret>(r.secret, { username: "", password: "" }) } : null;
    },
    /** Insert, or update `id`. Unset `password` / `totp` keep the stored ones; `totp: ""` removes it. */
    save: (id: string, input: { origin: string; username: string; password?: string; totp?: string }): LoginView => {
      const existing = get("SELECT * FROM logins WHERE id = ?", id);
      const old = sealer.openJson<LoginSecret>(existing?.secret ?? null, { username: "", password: "" });
      const totp = input.totp ?? old.totp;
      const secret: LoginSecret = { username: input.username, password: input.password ?? old.password, ...(totp ? { totp } : {}) };
      run(
        `INSERT INTO logins (id, origin, secret, has_totp, created_at, updated_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET origin = excluded.origin, secret = excluded.secret, has_totp = excluded.has_totp, updated_at = excluded.updated_at`,
        id,
        input.origin,
        sealer.sealJson(secret),
        totp ? 1 : 0,
        existing?.created_at ?? now(),
        now(),
        null,
      );
      return logins.get(id)!;
    },
    touch: (id: string) => run("UPDATE logins SET last_used_at = ? WHERE id = ?", now(), id),
    delete: (id: string) => run("DELETE FROM logins WHERE id = ?", id).changes > 0,
  };

  type PushKeys = { p256dh: string; auth: string };
  const push = {
    list: () =>
      all("SELECT * FROM push_subscriptions ORDER BY created_at").map((r) => ({
        endpoint: r.endpoint as string,
        keys: sealer.openJson<PushKeys>(r.keys, { p256dh: "", auth: "" }),
        device: r.device as string,
        createdAt: r.created_at as string,
      })),
    upsert: (endpoint: string, keys: PushKeys, device: string) =>
      run(
        `INSERT INTO push_subscriptions (endpoint, keys, device, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET keys = excluded.keys, device = excluded.device`,
        endpoint,
        sealer.sealJson(keys),
        device,
        now(),
      ),
    delete: (endpoint: string) => run("DELETE FROM push_subscriptions WHERE endpoint = ?", endpoint).changes > 0,
    /** The VAPID key pair as JWKs, sealed in kv. */
    vapid: {
      get: (): VapidKeys | null => sealer.openJson(kv.get<string>("vapid") ?? null, null),
      set: (keys: VapidKeys) => kv.set("vapid", sealer.sealJson(keys)),
    },
  };

  /** The applied migration count (`PRAGMA user_version`), for diagnostics. */
  const schemaVersion = (): number => Number(get("PRAGMA user_version")?.user_version ?? 0);

  /** Tasks per status, for diagnostics. */
  const taskCounts = (): Record<string, number> =>
    Object.fromEntries(all("SELECT status, COUNT(*) AS n FROM tasks GROUP BY status").map((r) => [r.status, Number(r.n)]));

  /**
   * Open every sealed value once at boot, so the secret registry (secrets.ts) knows all of them
   * before anything can be logged, not only the ones a request happened to decrypt.
   */
  const openAllSecrets = () => {
    providers.list();
    channels.list();
    for (const c of connectors.list()) connectors.oauth(c.id);
    for (const r of all("SELECT id FROM plugins")) plugins.get(r.id);
    for (const l of logins.list()) logins.byOrigin(l.origin);
    push.list();
    push.vapid.get();
  };

  return { settings, routing, providers, usage, tasks, approvals, briefings, channels, channelState, deliveries, memory, memories, skills, plugins, threads, notices, outbox, push, connectors, logins, kv, schemaVersion, taskCounts, openAllSecrets };
}
