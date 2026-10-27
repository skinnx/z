/** SQLite persistence. Secrets go through the sealer and never leave as plaintext views. */
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  Lane,
  Routing,
  Settings,
  type Approval,
  type ApprovalStatus,
  type BotTurn,
  type BriefItem,
  type Briefing,
  type ChannelInput,
  type Memory,
  type Notice,
  type ProviderConfig,
  type Task,
  type TaskEvent,
} from "@z/core";
import type { ModelMessage, UIMessage } from "ai";
import type { z } from "zod";
import type { Sealer } from "./crypto.ts";

type Row = Record<string, any>;
export type ChannelConfig = z.output<typeof ChannelInput>;
export type ChannelRecord = ChannelConfig & {
  configured: string[];
  lastEventAt: string | null;
  status: "ok" | "error" | "idle";
  statusDetail: string | null;
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
        `INSERT OR REPLACE INTO providers (id, kind, label, base_url, headers, models, enabled, monthly_budget_usd, api_key, key_hint, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        p.id,
        p.kind,
        p.label,
        p.baseURL ?? null,
        p.headers ? json(p.headers) : null,
        json(p.models),
        p.enabled ? 1 : 0,
        p.monthlyBudgetUsd ?? null,
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
  });

  const tasks = {
    list: (): Task[] => all("SELECT * FROM tasks ORDER BY created_at DESC").map(toTask),
    get: (id: string) => {
      const r = get("SELECT * FROM tasks WHERE id = ?", id);
      return r ? toTask(r) : null;
    },
    insert: (t: Task) =>
      run(
        `INSERT INTO tasks (id, title, instructions, schedule, tools, lane, mode, watch, status, result, error, events, next_run_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      ),
    update: (id: string, patch: Partial<Pick<Task, "title" | "status" | "result" | "error" | "nextRunAt">>): Task | null => {
      const columns: Record<string, string> = { title: "title", status: "status", result: "result", error: "error", nextRunAt: "next_run_at" };
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
        `INSERT INTO approvals (id, task_id, tool_approval_id, tool, risk, input, summary, status, created_at, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        a.id,
        a.taskId,
        a.toolApprovalId,
        a.tool,
        a.risk,
        json(a.input),
        a.summary,
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
    items: parse<BriefItem[]>(r.items, []),
    createdAt: r.created_at,
  });

  const briefings = {
    latest: () => {
      const r = get("SELECT * FROM briefings ORDER BY created_at DESC LIMIT 1");
      return r ? toBriefing(r) : null;
    },
    insert: (b: Briefing) =>
      run("INSERT INTO briefings (id, date, summary, items, created_at) VALUES (?, ?, ?, ?, ?)", b.id, b.date, b.summary, json(b.items), b.createdAt),
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
        `INSERT OR REPLACE INTO channels (id, kind, label, enabled, config, configured, always, lane, last_event_at, status, status_detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        c.id,
        c.kind,
        c.label,
        c.enabled ? 1 : 0,
        sealer.sealJson(c.config),
        json(configured),
        c.always ? 1 : 0,
        c.lane,
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
      return run("DELETE FROM channels WHERE id = ?", id).changes > 0;
    },
  };

  /** Adapter cursors and ids (ChannelRuntime.state). */
  const channelState = {
    get: (channelId: string, key: string): string | null =>
      get("SELECT value FROM channel_state WHERE channel_id = ? AND key = ?", channelId, key)?.value ?? null,
    set: (channelId: string, key: string, value: string) =>
      run("INSERT OR REPLACE INTO channel_state (channel_id, key, value) VALUES (?, ?, ?)", channelId, key, value),
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

  // ─── Notices ──────────────────────────────────────────────────────────────

  const toNotice = (r: Row): Notice => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    body: r.body,
    path: r.path,
    ...(r.approval_id ? { approvalId: r.approval_id } : {}),
    read: Boolean(r.read),
    createdAt: r.created_at,
  });

  const notices = {
    list: (limit = 100) => all("SELECT * FROM notices ORDER BY created_at DESC LIMIT ?", limit).map(toNotice),
    insert: (n: Notice) =>
      run(
        "INSERT INTO notices (id, kind, title, body, path, approval_id, read, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        n.id,
        n.kind,
        n.title,
        n.body,
        n.path,
        n.approvalId ?? null,
        n.read ? 1 : 0,
        n.createdAt,
      ),
    /** Mark read; all unread when `ids` is omitted. Returns the notices that changed. */
    markRead: (ids?: string[]): Notice[] => {
      const where = ids ? `id IN (${ids.map(() => "?").join(",")}) AND read = 0` : "read = 0";
      if (ids && ids.length === 0) return [];
      const changed = all(`SELECT * FROM notices WHERE ${where}`, ...(ids ?? [])).map(toNotice);
      run(`UPDATE notices SET read = 1 WHERE ${where}`, ...(ids ?? []));
      return changed.map((n) => ({ ...n, read: true }));
    },
    unreadForApproval: (approvalId: string) =>
      all("SELECT id FROM notices WHERE approval_id = ? AND read = 0", approvalId).map((r) => r.id as string),
  };

  // ─── Memory ───────────────────────────────────────────────────────────────

  const toMemory = (r: Row): Memory => ({ id: r.id, text: r.text, source: r.source, createdAt: r.created_at, updatedAt: r.updated_at });

  const memories = {
    list: (): Memory[] => all("SELECT * FROM memories ORDER BY updated_at DESC").map(toMemory),
    get: (id: string) => {
      const r = get("SELECT * FROM memories WHERE id = ?", id);
      return r ? toMemory(r) : null;
    },
    /** Same text again only refreshes the existing memory. */
    add: (id: string, text: string, source: Memory["source"]): Memory => {
      const existing = get("SELECT id FROM memories WHERE lower(text) = lower(?)", text);
      if (existing) {
        run("UPDATE memories SET updated_at = ? WHERE id = ?", now(), existing.id);
        return memories.get(existing.id)!;
      }
      run("INSERT INTO memories (id, text, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", id, text, source, now(), now());
      return memories.get(id)!;
    },
    update: (id: string, text: string): Memory | null => {
      run("UPDATE memories SET text = ?, updated_at = ? WHERE id = ?", text, now(), id);
      return memories.get(id);
    },
    delete: (id: string) => run("DELETE FROM memories WHERE id = ?", id).changes > 0,
  };

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
      const existing = get("SELECT title, created_at FROM threads WHERE id = ?", id);
      run(
        "INSERT OR REPLACE INTO threads (id, title, messages, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        id,
        existing?.title ?? title,
        json(messages),
        existing?.created_at ?? now(),
        now(),
      );
    },
    delete: (id: string) => run("DELETE FROM threads WHERE id = ?", id).changes > 0,
  };

  return { settings, routing, providers, usage, tasks, approvals, briefings, channels, channelState, memory, notices, memories, plugins, threads, kv };
}
