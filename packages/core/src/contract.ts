/**
 * The shared contract between core, server, adapters and web.
 * Everything that crosses a process or package boundary is defined here.
 */
import { z } from "zod";

// ─── BYOK: providers & model routing ────────────────────────────────────────

export const ProviderKind = z.enum([
  "openai",
  "anthropic",
  "google",
  "xai",
  "openrouter",
  "ollama",
  "openai-compatible",
]);
export type ProviderKind = z.infer<typeof ProviderKind>;

/** A provider as the user configures it. `apiKey` is write-only over the API. */
export const ProviderInput = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
  kind: ProviderKind,
  label: z.string().min(1).max(64),
  baseURL: z.url().optional(),
  /** Omit to keep the stored key; empty string clears it. */
  apiKey: z.string().optional(),
  /** Extra headers sent with every request (e.g. OpenRouter attribution). */
  headers: z.record(z.string(), z.string()).optional(),
  models: z.array(z.string().min(1)).default([]),
  enabled: z.boolean().default(true),
  /** Soft monthly cap in USD; background work pauses when exceeded. */
  monthlyBudgetUsd: z.number().nonnegative().optional(),
});
export type ProviderInput = z.input<typeof ProviderInput>;

/** A provider as returned to clients. Keys never leave the server. */
export type ProviderView = Omit<z.output<typeof ProviderInput>, "apiKey"> & {
  hasKey: boolean;
  /** Last four characters of the key, for recognition only. */
  keyHint: string | null;
  usage: { monthUsd: number; monthTokens: number };
};

/** `providerId:modelId`, e.g. `anthropic:claude-opus-5-5` or `local:llama4`. */
export const ModelRef = z.string().regex(/^[a-z0-9-]+:.+$/);
export type ModelRef = z.infer<typeof ModelRef>;

/** Which models serve which job. Each lane is an ordered fallback chain. */
export const Lane = z.enum(["chat", "agent", "briefing", "bot", "fast"]);
export type Lane = z.infer<typeof Lane>;
export const Routing = z.record(Lane, z.array(ModelRef));
export type Routing = z.infer<typeof Routing>;

// ─── Tools, risk & approvals ────────────────────────────────────────────────

/**
 * Risk decides the approval policy:
 * - read:     never asks (search, fetch, read inbox)
 * - write:    asks unless the user allows it for that tool
 * - external: always asks (send message, post publicly, pay, delete)
 */
export const Risk = z.enum(["read", "write", "external"]);
export type Risk = z.infer<typeof Risk>;

export const ApprovalPolicy = z.record(z.string(), z.enum(["ask", "allow", "deny"]));
export type ApprovalPolicy = z.infer<typeof ApprovalPolicy>;

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

// ─── Approvals: preview, safety floor & action reviewer ─────────────────────
// Every non-read call passes, in order: the safety floor (credentials, security settings,
// payments, account deletion always ask the person, whatever the policy), the per-tool policy,
// then for `write` tools the action reviewer (`fast` lane), which may only let through what the
// owner explicitly asked for and fails closed. `external` tools always ask.

/**
 * Exactly what an approval acts on, nothing cut. `fields` lead with recipients, subject and body
 * when the call sends something; `fullText` is the whole preview as plain text. Push and channel
 * messages carry Approve buttons only when all of `fullText` fits; otherwise "Open to review".
 */
export type ApprovalPreview = {
  kind: "send" | "change" | "generic";
  fields: { label: string; value: string }[];
  fullText: string;
};

/** `auto`: the reviewer may run `write` tools set to Ask when the owner explicitly asked for that exact action. */
export const ReviewerMode = z.enum(["off", "auto"]);
export type ReviewerMode = z.infer<typeof ReviewerMode>;

// ─── End approvals ──────────────────────────────────────────────────────────

export type Approval = {
  id: string;
  taskId: string;
  /** AI SDK tool approval id, used to resume the loop. */
  toolApprovalId: string;
  tool: string;
  risk: Risk;
  input: unknown;
  /** One-line, human readable description of what will happen. */
  summary: string;
  /** The full preview the person approves (see ApprovalPreview). */
  preview: ApprovalPreview;
  /** Why it asks, completing "Asking because …" (safety floor or reviewer); null for a plain policy ask. */
  reason: string | null;
  status: ApprovalStatus;
  createdAt: string;
  decidedAt: string | null;
};

export const ApprovalDecision = z.object({
  approve: z.boolean(),
  /** Remember the choice for this tool from now on. */
  remember: z.boolean().default(false),
  note: z.string().max(500).optional(),
});
export type ApprovalDecision = z.input<typeof ApprovalDecision>;

// ─── Tasks: the proactive agent ─────────────────────────────────────────────

export type TaskStatus =
  | "queued"
  | "running"
  | "waiting" // blocked on an approval
  | "scheduled" // recurring, idle until next run
  | "done"
  | "failed"
  | "cancelled";

export const TaskInput = z.object({
  instructions: z.string().min(1).max(8000),
  /** Cron expression for recurring work; omit for one-shot. */
  schedule: z.string().max(120).optional(),
  /** Restrict to these tool names; omit for every enabled tool. */
  tools: z.array(z.string()).optional(),
  lane: Lane.default("agent"),
  /**
   * `do` runs the instructions. `watch` is a standing check ("tell me when …"):
   * it runs on `schedule` and only raises a Notice when something new matters.
   */
  mode: z.enum(["do", "watch"]).default("do"),
});
export type TaskInput = z.input<typeof TaskInput>;

/** Watches without a schedule check hourly. */
export const DEFAULT_WATCH_SCHEDULE = "0 * * * *";

export type TaskEvent =
  | { type: "step"; at: string; text: string }
  | { type: "tool"; at: string; tool: string; input: unknown; output?: unknown; error?: string }
  | { type: "approval"; at: string; approvalId: string }
  | { type: "model"; at: string; model: ModelRef; tokens: number };

export type Task = {
  id: string;
  /** Short title the agent derives from the instructions. */
  title: string;
  instructions: string;
  schedule: string | null;
  tools: string[] | null;
  lane: Lane;
  mode?: "do" | "watch";
  /** Watch tasks only: when it last checked and the last thing it reported. */
  watch?: { lastCheckAt: string | null; lastFinding: { title: string; body: string; at: string } | null };
  status: TaskStatus;
  result: string | null;
  error: string | null;
  events: TaskEvent[];
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
};

// ─── Briefing: the morning summary ──────────────────────────────────────────

export type BriefItem = {
  id: string;
  /** Source plugin id, e.g. `rss`, `github`, `tasks`. */
  source: string;
  kind: "headline" | "todo" | "followup" | "metric";
  text: string;
  url?: string;
  /** Suggested follow-up the user can turn into a task with one tap. */
  suggestion?: string;
};

export type Briefing = {
  id: string;
  /** Local date, YYYY-MM-DD. */
  date: string;
  summary: string;
  items: BriefItem[];
  createdAt: string;
};

export const Settings = z.object({
  /** Name the bot answers to in channels, e.g. `z` for "@z is this true?". */
  handle: z.string().min(1).max(32).default("z"),
  timezone: z.string().default("UTC"),
  /** Cron for the daily briefing in `timezone`. */
  briefingCron: z.string().default("0 7 * * *"),
  persona: z.string().max(4000).default(""),
  approvals: ApprovalPolicy.default({}),
  /** The action reviewer (see "Approvals: preview, safety floor & action reviewer"). */
  reviewer: ReviewerMode.default("auto"),
  /** Use and update long-term memory. Off: nothing is recalled or remembered (stored memories are kept). */
  memory: z.boolean().default(true),
  /**
   * Where z reaches its owner when away: approvals with buttons, watch hits, briefings.
   * Set by pairing (POST /api/owner/link, then send `/link <code>` to the bot). Read-only over PUT.
   */
  owner: z
    .object({ channelId: z.string(), threadId: z.string(), authorId: z.string(), label: z.string() })
    .nullable()
    .default(null),
});
export type Settings = z.output<typeof Settings>;

// ─── Channels: the summonable bot ───────────────────────────────────────────

export const ChannelKind = z.enum(["webhook", "telegram", "discord", "slack", "x"]);
export type ChannelKind = z.infer<typeof ChannelKind>;

export const ChannelInput = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
  kind: ChannelKind,
  label: z.string().min(1).max(64),
  enabled: z.boolean().default(true),
  /** Adapter specific, secrets included. Write-only like provider keys. */
  config: z.record(z.string(), z.string()).default({}),
  /** Answer every message instead of only mentions/replies. */
  always: z.boolean().default(false),
  lane: Lane.default("bot"),
});
export type ChannelInput = z.input<typeof ChannelInput>;

export type ChannelView = Omit<z.output<typeof ChannelInput>, "config"> & {
  /** Config keys that have a value; values are never returned. */
  configured: string[];
  /** Public URL the platform should call, when the adapter uses webhooks. */
  webhookUrl: string | null;
  lastEventAt: string | null;
  status: "ok" | "error" | "idle";
  statusDetail: string | null;
};

/** What an adapter hands to the bot runtime for one inbound message. */
export type InboundMessage = {
  channelId: string;
  /** Platform conversation/thread id, used to keep per-thread memory. */
  threadId: string;
  messageId: string;
  author: { id: string; name: string };
  text: string;
  /** Whether the bot was explicitly mentioned or replied to. */
  addressed: boolean;
  /** The post/message being replied to: what "is this true?" refers to. */
  context?: { author: string; text: string; url?: string; images?: string[] }[];
  /**
   * Image URLs attached to the message itself (fetchable by the server). Adapters for platforms
   * whose files need auth to download (Slack) pass `data:` URLs instead.
   */
  images?: string[];
  receivedAt: string;
};

export type Source = { title: string; url: string };
/** The bot's call on a claim it was asked to check. */
export type Verdict = "true" | "false" | "misleading" | "unverified";
/**
 * `text` already leads with the verdict when there is one. `sources` are pages a tool actually
 * returned or read (never model-invented URLs); adapters render them after `text` in the platform's link style.
 */
export type OutboundReply = { text: string; replyTo: string; verdict?: Verdict; sources?: Source[] };

// ─── Plugins: the extension point ───────────────────────────────────────────

export type PluginManifest = {
  id: string;
  name: string;
  description: string;
  tools: { name: string; description: string; risk: Risk; defaultPolicy?: "ask" | "allow" }[];
  /** Settings keys the plugin reads, shown as a form in the UI. */
  settings: { key: string; label: string; secret: boolean; required: boolean }[];
  briefing: boolean;
  enabled: boolean;
};

export type AdapterManifest = {
  kind: ChannelKind;
  label: string;
  /** Fields for ChannelInput.config, rendered as a form. */
  config: { key: string; label: string; secret: boolean; required: boolean }[];
  /** Whether the platform calls us (needs Z_PUBLIC_URL) or we connect out. */
  mode: "webhook" | "connect";
};

// ─── Live events (SSE on /api/events) ───────────────────────────────────────

// ─── Memory: what z knows about its owner ───────────────────────────────────

export const MemoryInput = z.object({ text: z.string().min(1).max(2000) });
export type Memory = {
  id: string;
  text: string;
  /** `user` when written in the UI, `agent` when z remembered it via a tool. */
  source: "user" | "agent";
  createdAt: string;
  updatedAt: string;
};

// ─── Notices: what z tells its owner, delivered in-app, by Web Push and to the owner channel ─

export type Notice = {
  id: string;
  kind: "approval" | "watch" | "task" | "briefing";
  title: string;
  body: string;
  /** App path to open, e.g. `/tasks?id=…`. */
  path: string;
  /** Present for approvals: lets push and channels offer Approve / Deny. */
  approvalId?: string;
  read: boolean;
  createdAt: string;
};

export const PushSubscriptionInput = z.object({
  endpoint: z.url(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
  /** Free text the user recognises, e.g. "Pixel 9 · Chrome". */
  device: z.string().max(80).default(""),
});

// ─── Connectors: any MCP server as a data source (Composio, Zapier, Pipedream, self-hosted…) ─

export const ConnectorAuth = z.enum(["none", "headers", "oauth"]);
export type ConnectorAuth = z.infer<typeof ConnectorAuth>;

export const ConnectorInput = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
  label: z.string().min(1).max(64),
  /** Required when creating; omit on update to keep the stored URL. */
  url: z.url().optional(),
  transport: z.enum(["http", "sse"]).default("http"),
  auth: ConnectorAuth.default("none"),
  /** Static headers (e.g. `Authorization`, `x-api-key`). Write-only like provider keys; omit to keep, `{}` clears. */
  headers: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().default(true),
  /** Offer this connector's read tools to channel bots, which strangers reach. Off by default. */
  public: z.boolean().default(false),
  /** Per-tool risk override, keyed by the server's own tool name. Wins over the server's hints. */
  risks: z.record(z.string(), Risk).default({}),
});
export type ConnectorInput = z.input<typeof ConnectorInput>;

export type ConnectorTool = {
  /** The server's own tool name. */
  name: string;
  /** Name the model sees and approval policy keys use: `mcp_<connectorId>_<name>`, sanitised. */
  toolName: string;
  title: string | null;
  description: string;
  risk: Risk;
  /** `hint`: derived from the server's annotations (untrusted); `default`: no hints, treated as write; `user`: overridden. */
  riskSource: "hint" | "default" | "user";
};

export type ConnectorView = Omit<z.output<typeof ConnectorInput>, "headers" | "url"> & {
  /**
   * The URL with path and query hidden (`https://mcp.zapier.com/…`): some services embed
   * the secret in the URL, so the full URL is write-only like headers. PUT without `url` keeps it.
   */
  urlDisplay: string;
  /** Header names that have a stored value; values are never returned. */
  headerKeys: string[];
  status: "connected" | "connecting" | "needs_auth" | "error" | "disabled";
  statusDetail: string | null;
  server: { name: string; version: string } | null;
  /** Server-provided usage instructions, shown to the model with its tools. */
  instructions: string | null;
  tools: ConnectorTool[];
  /** Present when auth is `oauth` and a token is stored. */
  oauth: { connected: boolean; scope: string | null; expiresAt: string | null } | null;
  updatedAt: string;
};

/** A one-tap starting point in the UI. Static catalog shipped with z. */
export type ConnectorPreset = {
  id: string;
  label: string;
  /** May contain `{placeholders}` the user fills, e.g. `https://gitmcp.io/{owner}/{repo}`. */
  url: string;
  transport: "http" | "sse";
  auth: ConnectorAuth;
  /** For `headers` auth: the header to fill and how its value is built, e.g. `Authorization: Bearer {token}`. */
  header?: { name: string; template: string; label: string };
  docsUrl: string;
  /** Plain-language caveat shown before connecting, e.g. who holds the OAuth tokens. */
  note?: string;
  category: "docs" | "dev" | "work" | "aggregator";
};

export type LiveEvent =
  | { type: "task"; task: Task }
  | { type: "approval"; approval: Approval }
  | { type: "briefing"; briefing: Briefing }
  | { type: "channel"; channel: ChannelView }
  | { type: "notice"; notice: Notice }
  | { type: "connector"; connector: ConnectorView };

// ─── HTTP API ───────────────────────────────────────────────────────────────
// All JSON. Errors: `{ error: string }` with a 4xx/5xx status.
//
// GET    /api/health                       → { ok: true, version }
// GET    /api/settings                     → Settings
// PUT    /api/settings      Settings       → Settings
// GET    /api/providers                    → ProviderView[]
// PUT    /api/providers/:id ProviderInput  → ProviderView
// DELETE /api/providers/:id                → { ok: true }
// POST   /api/providers/:id/test           → { ok: boolean, model?: string, latencyMs?: number, error?: string }
// GET    /api/providers/:id/models         → { models: string[] }   (live list from the provider when supported)
// GET    /api/routing                      → Routing
// PUT    /api/routing       Routing        → Routing
// POST   /api/chat          { id, messages: UIMessage[], model?: ModelRef }
//                                          → AI SDK UI message stream (useChat compatible)
// GET    /api/threads                      → { id, title, updatedAt }[]
// GET    /api/threads/:id                  → { id, title, messages: UIMessage[] }
// DELETE /api/threads/:id                  → { ok: true }
// GET    /api/tasks                        → Task[]           (newest first)
// POST   /api/tasks         TaskInput      → Task
// POST   /api/tasks/:id/run                → Task             (run now)
// POST   /api/tasks/:id/cancel             → Task
// DELETE /api/tasks/:id                    → { ok: true }
// GET    /api/approvals?status=pending     → Approval[]
// POST   /api/approvals/:id ApprovalDecision → Approval
// GET    /api/briefing                     → Briefing | null  (latest)
// POST   /api/briefing                     → Briefing         (generate now)
// GET    /api/adapters                     → AdapterManifest[]
// GET    /api/channels                     → ChannelView[]
// PUT    /api/channels/:id  ChannelInput   → ChannelView
// DELETE /api/channels/:id                 → { ok: true }
// GET    /api/plugins                      → PluginManifest[]
// PUT    /api/plugins/:id   { enabled: boolean, settings?: Record<string,string> } → PluginManifest
// GET    /api/memories                     → Memory[]
// POST   /api/memories      MemoryInput    → Memory
// PUT    /api/memories/:id  MemoryInput    → Memory
// DELETE /api/memories/:id                 → { ok: true }
// GET    /api/notices                      → Notice[]          (newest first, last 100)
// POST   /api/notices/read  { ids?: string[] } → { ok: true }  (all when ids omitted)
// GET    /api/push                         → { publicKey: string, devices: { endpoint, device, createdAt }[] }
// POST   /api/push          PushSubscriptionInput → { ok: true }
// DELETE /api/push          { endpoint }   → { ok: true }
// POST   /api/push/test                    → { sent: number }
// POST   /api/owner/link                   → { code: string, expiresAt: string }  (send `/link <code>` to the bot)
// DELETE /api/owner                        → Settings
// GET    /api/connector-presets            → ConnectorPreset[]
// GET    /api/connectors                   → ConnectorView[]
// PUT    /api/connectors/:id ConnectorInput → ConnectorView   (saves, connects, lists tools)
// DELETE /api/connectors/:id               → { ok: true }    (also revokes stored OAuth tokens locally)
// POST   /api/connectors/:id/refresh       → ConnectorView   (reconnect and re-list tools)
// POST   /api/connectors/:id/oauth         → { authorizationUrl: string }  (start OAuth; open it in a new tab)
// GET    /oauth/callback?code&state        → redirects to `/connect?connector=<id>` (no /api prefix; no bearer needed, state-verified)
// GET    /api/export                       → JSON attachment `z-export-<date>.json`: everything except secrets
//                                            (settings, routing, provider/channel/connector views, tasks, approvals,
//                                            briefings, memories, threads, notices)
// DELETE /api/threads                      → { deleted: number }   (all chat threads)
// DELETE /api/memories                     → { deleted: number }   (all memories)
// GET    /api/events                       → text/event-stream of LiveEvent
// POST   /hooks/:channelId                 → adapter defined (inbound platform webhooks)
//
// Auth: when Z_TOKEN is set, every /api route requires `Authorization: Bearer <Z_TOKEN>`
// (or `?token=` for EventSource). /hooks routes are verified by each adapter.

export const API_PREFIX = "/api";
