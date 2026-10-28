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
  /** Context window in tokens per model id, overriding z's built-in table (e.g. a local model's `num_ctx`). */
  contextWindows: z.record(z.string(), z.number().int().min(1024)).optional(),
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

/**
 * Sent as a `data-context` chat part when the prompt was compacted to fit the model's window.
 * The stored conversation is untouched; only what the model saw shrank.
 */
export type ContextReport = {
  /** The oldest turns went to the model as one summary. */
  summarized: boolean;
  /** Old tool results cut to an excerpt. */
  trimmed: number;
  tokensBefore: number;
  tokensAfter: number;
};

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
  | "cancelled"
  | TaskLifecycleStatus; // needs_input | review | interrupted | paused: see "Task engine" below

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
  /** A run missed while the server was down: see MissedPolicy under "Delivery & missed runs". */
  missedPolicy: z.enum(["once", "skip"]).default("once"),
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
  /** Recurring tasks: what a run missed while z was down does (absent on old rows: "once"). */
  missedPolicy?: MissedPolicy;
} & TaskLifecycleFields;

// ─── Briefing: the morning summary ──────────────────────────────────────────

/** An item as a briefing source gathers it, before triage. */
export type BriefSourceItem = {
  id: string;
  /** Source plugin id, e.g. `rss`, `github`, `tasks`. */
  source: string;
  kind: "headline" | "todo" | "followup" | "metric";
  text: string;
  url?: string;
  /** Suggested follow-up the user can turn into a task with one tap. */
  suggestion?: string;
  /** Facts the source knows for certain; triage rules may act on them, only ever to say "can wait". */
  signals?: BriefSignals;
};

/**
 * What a source knows about an item without reading it. Each one, when set, settles the item as
 * "can wait" with no model call; anything a source is unsure of stays unset and the model reads the
 * item. There is deliberately no "urgent" signal: what needs the user does not share keywords.
 */
export type BriefSignals = {
  /** The source itself files it as a newsletter or promotion (a mail provider's Promotions tab). List headers alone are not enough: a security report through a mailing list carries them too. */
  promotional?: boolean;
  /** Opened by an automated account (`dependabot[bot]`) for routine upkeep. Not set for alerts or failures, which bots and `noreply` senders send too. */
  bot?: boolean;
  /** An automated check that passed. Failures are left to the model. */
  ciPassed?: boolean;
  /** The user has already seen it. */
  read?: boolean;
  /** The thread is closed or merged. */
  closed?: boolean;
  /** z is already working on it (a queued, running or scheduled task). */
  delegated?: boolean;
};

/** Whether an item needs the user today. */
export type BriefPriority = "needs_you" | "can_wait";

/** Cap on `BriefItem.reason`. */
export const BRIEF_REASON_MAX = 140;

export type BriefItem = BriefSourceItem & {
  priority: BriefPriority;
  /** One line a person would accept, at most `BRIEF_REASON_MAX` characters. */
  reason: string;
  /** `rule`: settled by a signal, or not checked (no model, or the model left it out; always `needs_you`). */
  decidedBy: "rule" | "model";
};

export type Briefing = {
  id: string;
  /** Local date, YYYY-MM-DD. */
  date: string;
  summary: string;
  items: BriefItem[];
  /** Plugin briefing sources that threw (see "Task engine" below); shown at the bottom. */
  couldNotCheck?: CouldNotCheck[];
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
  /** Memories z writes itself wait as `unreviewed` until the owner confirms them. Off: they are `active` at once. */
  memoryReview: z.boolean().default(true),
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

// ─── Channel limits: anyone in a group chat can spend the owner's BYOK budget ─
/**
 * Caps on bot runs, checked before any model call. Over a cap the author gets one short
 * "busy, try again in N min" reply (no model call), then silence until they are under it again.
 * The paired owner is exempt.
 */
export const ChannelLimits = z.object({
  /** Answers running at once in this channel. */
  running: z.number().int().min(1).max(50).default(4),
  /** Messages queued behind them; past this, new ones get the busy reply. */
  waiting: z.number().int().min(0).max(500).default(20),
  /** One author's messages in flight (queued or running). */
  authorWaiting: z.number().int().min(1).max(50).default(2),
  /** One author's accepted messages per rolling hour. */
  authorHourly: z.number().int().min(1).max(1000).default(10),
});
export type ChannelLimits = z.output<typeof ChannelLimits>;
// ─── End channel limits ─────────────────────────────────────────────────────

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
  /** Omit to keep the stored limits (the defaults for a new channel). */
  limits: ChannelLimits.prefault({}),
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
  /** Fields for ChannelInput.config, rendered as a form. A `toggle` field is on when its value is `on`. */
  config: { key: string; label: string; secret: boolean; required: boolean; toggle?: boolean }[];
  /** Whether the platform calls us (needs Z_PUBLIC_URL) or we connect out. */
  mode: "webhook" | "connect";
};

// ─── Live events (SSE on /api/events) ───────────────────────────────────────

// ─── Memory: what z knows about its owner ───────────────────────────────────

export const MemoryInput = z.object({ text: z.string().min(1).max(2000), pinned: z.boolean().optional() });
/**
 * `unreviewed`: z remembered it while `Settings.memoryReview` is on; never used in prompts or recall
 * until the owner confirms (or edits) it. `active`: used.
 */
export const MemoryStatus = z.enum(["unreviewed", "active"]);
export type MemoryStatus = z.infer<typeof MemoryStatus>;
export type Memory = {
  id: string;
  text: string;
  /** `user` when written in the UI, `agent` when z remembered it via a tool. */
  source: "user" | "agent";
  status: MemoryStatus;
  /** Active pinned memories are in every owner prompt; the rest are picked by relevance. */
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
};

// ─── Notices: what z tells its owner, delivered in-app, by Web Push and to the owner channel ─

export type Notice = {
  id: string;
  /** `memory`: z has memories awaiting review (batched, at most one an hour). `question`: a task asks the owner. */
  kind: "approval" | "watch" | "task" | "briefing" | "memory" | "question";
  title: string;
  body: string;
  /** App path to open, e.g. `/tasks?id=…`. */
  path: string;
  /** Present for approvals: lets push and channels offer Approve / Deny. */
  approvalId?: string;
  /** Present for `question`: simple choices become buttons on push and channels. */
  question?: NoticeQuestion;
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
  /** An OAuth sign-in was started and its callback hasn't arrived yet (it can be pasted instead). */
  signInPending: boolean;
  updatedAt: string;
};

/** Start of an OAuth sign-in. `redirectUri` is where the browser lands after approving. */
export type OAuthStart = { authorizationUrl: string; redirectUri: string };

/**
 * Finish a sign-in whose callback can't reach z (no Z_PUBLIC_URL, LAN or Tailscale installs): the
 * owner pastes the address the browser ended on. The state in it must be this connector's
 * pending one, and is single use like the real callback.
 */
export const OAuthCompleteInput = z.object({ url: z.string().trim().min(1).max(4096) });
export type OAuthCompleteInput = z.infer<typeof OAuthCompleteInput>;

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

// ─── Saved sign-ins: logins the browser fills itself, so the model never sees a password ─
// (Idea from CopilotKit OpenDuet's password vault, MIT; re-implemented for z.)

/** `https://host[:port]`, exactly; plain http only for localhost. */
export const LoginOrigin = z
  .string()
  .trim()
  .refine((raw) => {
    try {
      const url = new URL(raw);
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      return url.origin === raw.replace(/\/$/, "").toLowerCase() && (url.protocol === "https:" || (url.protocol === "http:" && local));
    } catch {
      return false;
    }
  }, "must be an origin like https://example.com (plain http only for localhost)")
  .transform((raw) => new URL(raw).origin);

/** Base32 TOTP secret as sites show it under "can't scan the code?"; spaces are ignored. */
const TotpSecret = z
  .string()
  .transform((s) => s.replace(/[\s-]/g, "").toUpperCase())
  .refine((s) => s === "" || /^[A-Z2-7]{16,}=*$/.test(s), "must be a base32 secret (letters A–Z and digits 2–7)");

/** One login per origin. Everything but the origin is sealed at rest and write-only over the API. */
export const LoginInput = z.object({
  origin: LoginOrigin,
  username: z.string().trim().min(1).max(256),
  password: z.string().min(1).max(1024),
  /** For sites that ask for a 6-digit authenticator code after the password. */
  totpSecret: TotpSecret.optional(),
});
export type LoginInput = z.input<typeof LoginInput>;

/** Omit `password` or `totpSecret` to keep the stored one; an empty `totpSecret` removes it. */
export const LoginUpdate = LoginInput.extend({ password: LoginInput.shape.password.optional() });
export type LoginUpdate = z.input<typeof LoginUpdate>;

export type LoginView = {
  id: string;
  origin: string;
  username: string;
  hasTotp: boolean;
  updatedAt: string;
  /** When the browser last filled it. */
  lastUsedAt: string | null;
};

// ─── End saved sign-ins ─────────────────────────────────────────────────────

export type LiveEvent =
  | { type: "task"; task: Task }
  | { type: "approval"; approval: Approval }
  | { type: "briefing"; briefing: Briefing }
  | { type: "channel"; channel: ChannelView }
  | { type: "notice"; notice: Notice }
  | { type: "connector"; connector: ConnectorView };

// ─── Task engine: crash safety, failure reporting, questions & review ───────
// One block for the task lifecycle; referenced by TaskStatus, Task, Briefing and Notice above.

/**
 * - needs_input: paused on the agent's `ask_person` question; POST /api/tasks/:id/answer resumes it.
 * - review:      a one-shot task finished ("Ready for review"); POST /api/tasks/:id/resolve → `done`.
 * - interrupted: z stopped mid-action (a write/external call started without a recorded result).
 *                Never re-run automatically; the owner checks and runs it again.
 * - paused:      a recurring task failed MAX_CONSECUTIVE_FAILURES runs in a row; run it to resume.
 */
export type TaskLifecycleStatus = "needs_input" | "review" | "interrupted" | "paused";

/** Consecutive failed runs after which a recurring task is paused. */
export const MAX_CONSECUTIVE_FAILURES = 10;

/** What the agent asked the owner via `ask_person`. */
export type TaskQuestion = { question: string; choices: string[]; askedAt: string };

export type TaskLifecycleFields = {
  /** Present while `needs_input`. */
  question?: TaskQuestion | null;
  /** Recurring tasks: failed runs in a row (0 after a success). */
  failures?: number;
};

export const TaskAnswer = z.object({ text: z.string().trim().min(1).max(4000) });
export type TaskAnswer = z.input<typeof TaskAnswer>;

/**
 * A notice for a question: answer buttons in the app, on push and on the owner channel. Stored with
 * the notice, so the buttons survive a reload; `answer` is set once it was answered anywhere
 * (`""` when the question was withdrawn: the task was run again, cancelled or deleted).
 */
export type NoticeQuestion = { taskId: string; text: string; choices: string[]; answer?: string };

/** A plugin briefing source that failed. */
export type CouldNotCheck = { source: string; reason: string };

// Routes (also listed under HTTP API):
// POST   /api/tasks/:id/answer  TaskAnswer → Task   (needs_input → queued; the answer becomes the tool result)
// POST   /api/tasks/:id/resolve            → Task   (review | interrupted → done)

// ─── End task engine ────────────────────────────────────────────────────────

// ─── Setup checklist & diagnostics ──────────────────────────────────────────
// Ready means it was seen working (a model answered, a channel connected), never just "configured".
// (Idea from CopilotKit OpenDuet's setup checks, MIT; re-implemented for z.)

/**
 * - ready:       checked and working
 * - needs_setup: missing, or checked and failing (`detail` carries the real error)
 * - not_checked: configured but not tested yet, or the check was inconclusive (rate limited, timed out)
 * - optional:    not needed for what is set up now
 */
export type SetupState = "ready" | "needs_setup" | "not_checked" | "optional";

export type SetupRow = {
  /** `chat_model`, `lanes`, `token`, `public_url`, `push`, `owner`, `master_key`, `channel:<id>`, `connector:<id>`. */
  id: string;
  label: string;
  state: SetupState;
  detail: string;
  /** Where to fix it in the app; null when the fix is outside z (an environment variable). */
  fix: { label: string; path: string } | null;
  /** The owner confirms this one themselves (backing up the master key): button label for POST /api/setup/:id/ack. */
  ack?: string;
};

export type SetupChecklist = {
  rows: SetupRow[];
  /** When the live checks (POST /api/setup/check) last ran; null when never. */
  checkedAt: string | null;
};

/** A cached live model test, per model ref. */
export type ModelCheck = { ok: boolean; error?: string; rateLimited?: boolean; timedOut?: boolean; latencyMs?: number; at: string };

/** What "Copy diagnostics" hands to whoever helps: no secrets, no URLs beyond their origin. */
export type Diagnostics = {
  generatedAt: string;
  version: string;
  runtime: { node: string; sqlite: string; os: string; arch: string; uptimeSeconds: number };
  schemaVersion: number;
  server: { authToken: boolean; publicOrigin: string | null; bind: string; plugins: number };
  setup: SetupChecklist;
  providers: { id: string; kind: ProviderKind; enabled: boolean; origin: string | null; hasKey: boolean; models: number }[];
  modelChecks: Record<string, ModelCheck>;
  routing: Routing;
  channels: { id: string; kind: ChannelKind; enabled: boolean; status: string; statusDetail: string | null; lastEventAt: string | null }[];
  connectors: { id: string; origin: string; auth: ConnectorAuth; enabled: boolean; status: string; statusDetail: string | null; tools: number }[];
  tasks: Record<string, number>;
  /** The last 200 server log lines, secrets already replaced by `[secret:<last4>]`. */
  logs: { at: string; stream: "stdout" | "stderr"; line: string }[];
};

// Routes (also listed under HTTP API):
// GET    /api/setup                        → SetupChecklist   (cached results only; no model calls)
// POST   /api/setup/check                  → SetupChecklist   (re-runs the live model tests with a short timeout, re-probes the rest)
// POST   /api/setup/:id/ack                → SetupChecklist   (rows with `ack` only)
// GET    /api/diagnostics                  → JSON attachment `z-diagnostics-<date>.json` (Diagnostics)

// ─── End setup checklist ────────────────────────────────────────────────────
// ─── Skills: reusable instructions the owner invokes with /name ─────────────
// Adapted from CopilotKit/OpenDuet (MIT), `openbot/examples/openduet/skills.yaml`: a skill adds no
// capability. Its `tools` only narrow what a run is offered; the approval policy still decides.

/** The slug typed after `/`. */
export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const MAX_SKILL_INSTRUCTIONS = 8000;

export const SkillInput = z.object({
  name: z.string().regex(SKILL_NAME, "lowercase letters, digits and dashes"),
  description: z.string().trim().min(1).max(200),
  instructions: z.string().trim().min(1).max(MAX_SKILL_INSTRUCTIONS),
  /**
   * Tool names (`web_search`) or globs (`mcp_<connector>_*`, `web_*`). Empty: the run's usual tools.
   * Naming a tool grants nothing: it is intersected with what the approval policy exposes.
   */
  tools: z.array(z.string().regex(/^[A-Za-z0-9_*-]{1,80}$/)).max(64).default([]),
});
export type SkillInput = z.input<typeof SkillInput>;

export type Skill = z.output<typeof SkillInput> & { id: string; createdAt: string; updatedAt: string };

// Routes (also listed under HTTP API):
// GET    /api/skills                       → Skill[]   (by name)
// POST   /api/skills        SkillInput     → Skill     (409 when the name is taken)
// PUT    /api/skills/:id    SkillInput     → Skill
// DELETE /api/skills/:id                   → { ok: true }
// A chat message or task whose text starts with `/<name>` runs with that skill.

// ─── End skills ─────────────────────────────────────────────────────────────
// ─── Delivery & missed runs: durable notice outbox, recurring de-dup, catch-up ─
// One block for how notices reach the owner reliably and what a recurring task does after downtime.

/**
 * Every notice gets one delivery per target (each Web Push device, the paired owner channel), stored
 * before anything is sent. A failed attempt is retried after DELIVERY_BACKOFF_MS[attempt - 1]; after
 * MAX_DELIVERY_ATTEMPTS it is `failed`. Waiting deliveries resume after a restart.
 * - dropped: no longer worth sending: its approval was decided, its question answered, the push
 *            device is gone (404/410) or the owner channel changed.
 * Once an approval is decided or a question answered anywhere, sent channel messages are edited to
 * show the outcome (without buttons) where the adapter can edit.
 */
export type DeliveryStatus = "pending" | "sent" | "failed" | "dropped";
export const DELIVERY_BACKOFF_MS = [30_000, 120_000, 600_000, 3_600_000, 21_600_000] as const;
export const MAX_DELIVERY_ATTEMPTS = 6;

export type NoticeDelivery = {
  id: string;
  noticeId: string;
  target: "push" | "channel";
  status: DeliveryStatus;
  attempts: number;
  /** When the next attempt is due (pending only). */
  nextAttemptAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * A recurring task's run that fell while z was down. `once` (default): run it once at startup
 * (never once per missed slot) when the miss is at most MISSED_RUN_WINDOW_MS old; older misses, and
 * every miss under `skip`, are skipped with a step in the task's events.
 */
export type MissedPolicy = "once" | "skip";
export const MISSED_RUN_WINDOW_MS = 24 * 3600_000;

// Recurring `do` tasks notify on success only when the run did not call `no_update` and its result
// (whitespace-normalized, compared by hash) differs from the last successful run's, or the run ends a
// failure streak. The first failure of a streak always notifies (see "Task engine").

// ─── End delivery & missed runs ─────────────────────────────────────────────

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
//                                            A `data-context` part (ContextReport) says when the prompt was compacted.
// GET    /api/threads                      → { id, title, updatedAt }[]
// GET    /api/threads/:id                  → { id, title, messages: UIMessage[] }
// DELETE /api/threads/:id                  → { ok: true }
// GET    /api/tasks                        → Task[]           (newest first)
// POST   /api/tasks         TaskInput      → Task
// POST   /api/tasks/:id/run                → Task             (run now)
// POST   /api/tasks/:id/cancel             → Task
// POST   /api/tasks/:id/answer  TaskAnswer → Task             (see "Task engine")
// POST   /api/tasks/:id/resolve            → Task             (see "Task engine")
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
// GET    /api/memories?status=&q=          → Memory[]  (newest first; with `q`, full-text search, best match first)
// POST   /api/memories      MemoryInput    → Memory    (owner-written: active)
// PUT    /api/memories/:id  MemoryInput    → Memory    (editing an unreviewed memory confirms it)
// POST   /api/memories/:id/confirm         → Memory    (unreviewed → active)
// POST   /api/memories/:id/pin { pinned: boolean } → Memory
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
// DELETE /api/connectors/:id               → { ok: true }    (drops stored OAuth tokens; revokes them at the
//                                            authorization server in the background, RFC 7009, best effort)
// POST   /api/connectors/:id/refresh       → ConnectorView   (reconnect and re-list tools)
// POST   /api/connectors/:id/oauth         → OAuthStart      (start OAuth; open authorizationUrl in a new tab)
// POST   /api/connectors/:id/oauth/complete OAuthCompleteInput → ConnectorView  (paste the callback URL;
//                                            400 { error } on a wrong/used/expired state or a rejected code)
// GET    /oauth/callback?code&state        → redirects to `/connect?connector=<id>` (no /api prefix; no bearer needed, state-verified)
// GET    /api/export                       → JSON attachment `z-export-<date>.json`: everything except secrets
//                                            (settings, routing, provider/channel/connector views, tasks, approvals,
//                                            briefings, memories, skills, threads, notices)
// DELETE /api/threads                      → { deleted: number }   (all chat threads)
// DELETE /api/memories                     → { deleted: number }   (all memories)
// GET    /api/logins                       → LoginView[]      (saved sign-ins; passwords and TOTP secrets never leave)
// POST   /api/logins        LoginInput     → LoginView        (409 when the origin already has one)
// PUT    /api/logins/:id    LoginUpdate    → LoginView
// DELETE /api/logins/:id                   → { ok: true }
// GET    /api/setup                        → SetupChecklist   (see "Setup checklist")
// POST   /api/setup/check                  → SetupChecklist
// POST   /api/setup/:id/ack                → SetupChecklist
// GET    /api/diagnostics                  → JSON attachment Diagnostics (no secrets)
// GET    /api/skills                       → Skill[]          (see "Skills")
// POST   /api/skills        SkillInput     → Skill
// PUT    /api/skills/:id    SkillInput     → Skill
// DELETE /api/skills/:id                   → { ok: true }
// GET    /api/events                       → text/event-stream of LiveEvent
// POST   /hooks/:channelId                 → adapter defined (inbound platform webhooks)
//   webhook kind: X-Z-Timestamp (unix s), X-Z-Delivery (unique id), X-Z-Signature `v1=<hex HMAC-SHA256(secret,
//   "<timestamp>.<delivery>.<raw body>")>`; 401 when unsigned, stale (>5 min) or tampered. A delivery id seen in
//   the last 7 days → 200 { duplicate: true }, nothing re-run. Bare X-Z-Secret only with config `legacySecret: "on"`.
//   Owner notices POSTed to `notifyUrl` carry the same three headers.
//
// Auth: when Z_TOKEN is set, every /api route requires `Authorization: Bearer <Z_TOKEN>`
// (or `?token=` for EventSource). /hooks routes are verified by each adapter.

export const API_PREFIX = "/api";
