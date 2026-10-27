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
});
export type TaskInput = z.input<typeof TaskInput>;

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
  context?: { author: string; text: string; url?: string }[];
  receivedAt: string;
};

export type OutboundReply = { text: string; replyTo: string };

// ─── Plugins: the extension point ───────────────────────────────────────────

export type PluginManifest = {
  id: string;
  name: string;
  description: string;
  tools: { name: string; description: string; risk: Risk }[];
  /** Settings keys the plugin reads, shown as a form in the UI. */
  settings: { key: string; label: string; secret: boolean; required: boolean }[];
  briefing: boolean;
  enabled: boolean;
};

// ─── Live events (SSE on /api/events) ───────────────────────────────────────

export type LiveEvent =
  | { type: "task"; task: Task }
  | { type: "approval"; approval: Approval }
  | { type: "briefing"; briefing: Briefing }
  | { type: "channel"; channel: ChannelView };

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
// GET    /api/channels                     → ChannelView[]
// PUT    /api/channels/:id  ChannelInput   → ChannelView
// DELETE /api/channels/:id                 → { ok: true }
// GET    /api/plugins                      → PluginManifest[]
// PUT    /api/plugins/:id   { enabled: boolean, settings?: Record<string,string> } → PluginManifest
// GET    /api/events                       → text/event-stream of LiveEvent
// POST   /hooks/:channelId                 → adapter defined (inbound platform webhooks)
//
// Auth: when Z_TOKEN is set, every /api route requires `Authorization: Bearer <Z_TOKEN>`
// (or `?token=` for EventSource). /hooks routes are verified by each adapter.

export const API_PREFIX = "/api";
