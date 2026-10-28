import { z } from "zod";
import { Lane } from "./common.ts";
import type { ServerText } from "./messages.ts";

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
  /** Public URL the platform should call, when the adapter uses webhooks (needs Z_PUBLIC_URL). */
  webhookUrl: string | null;
  /** The same `/hooks/:id` on the server's own address: works from this machine, not for platforms. */
  localWebhookUrl: string | null;
  lastEventAt: string | null;
  status: "ok" | "error" | "idle";
  statusDetail: string | null;
  /** The same in words the client translates (see contract/messages.ts); null/absent for plugin, adapter or platform text. */
  statusDetailMsg?: ServerText | null;
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

// ─── Channel activity: what reached the bot and what it did (owner only) ────
/**
 * `answered` replied · `silent` addressed but nothing to say · `ignored` not addressed to the bot ·
 * `limited` over a ChannelLimits cap · `error` the bot failed · `rejected` refused before reading
 * (bad signature or secret).
 */
export type ChannelOutcome = "answered" | "silent" | "ignored" | "limited" | "error" | "rejected";
/** One inbound event. Kept per channel (sealed), newest {@link CHANNEL_ACTIVITY_MAX}, deleted with the channel. */
export type ChannelActivity = {
  at: string;
  outcome: ChannelOutcome;
  /** Display name; null when nothing was read (rejected) or the message wasn't for the bot (ignored). */
  author: string | null;
  /** First {@link CHANNEL_PREVIEW_CHARS} characters of the message; null for ignored and rejected. */
  preview: string | null;
  /** First {@link CHANNEL_PREVIEW_CHARS} characters of the reply. */
  reply: string | null;
  verdict: Verdict | null;
  /** How many sources the reply linked. */
  sources: number;
  /** Time from receipt to reply. */
  ms: number | null;
  /** Refusal reason or error text (English or the platform's wording). */
  detail: string | null;
  /** `detail` as a message key when z worded it itself (contract/messages.ts). */
  detailMsg?: ServerText | null;
  /** Repeats of this ignored/rejected event folded into one entry (1 = just this one). */
  count: number;
};
export const CHANNEL_ACTIVITY_MAX = 20;
export const CHANNEL_PREVIEW_CHARS = 120;

// ─── Channel setup: the platform's next steps, checked live by the adapter ──
export type ChannelSetupStep = {
  /** Stable id, e.g. `slack.events`; the web words the ones it knows and falls back to `label`. */
  id: string;
  /** English fallback wording. */
  label: string;
  /** `info` is a step z cannot check. */
  status: "done" | "todo" | "error" | "info";
  /** Something to paste into the platform (a URL, a scope list). */
  value?: string;
  /** What the platform said: bot name, missing scopes, an error. Not translated. */
  detail?: string;
  /** Where on the platform to do it. */
  link?: string;
};

/** `POST /api/channels/:id/test`: z signs a message with the channel's secret and posts it to its own hook. */
export const ChannelTestInput = z.object({
  text: z.string().trim().min(1).max(2000),
});
export type ChannelTestResult = {
  /** HTTP status the hook answered. */
  status: number;
  ms: number;
  reply: string | null;
  verdict: Verdict | null;
  sources: Source[];
  error: string | null;
  /** `error` as a message key when z worded it itself. */
  errorMsg?: ServerText | null;
};

// Routes (HTTP API; overview in ../contract.ts):
// GET    /api/channels                     → ChannelView[]
// GET    /api/channels/:id/activity        → ChannelActivity[] (newest first)
// GET    /api/channels/:id/setup           → ChannelSetupStep[] (asks the platform live; a few seconds at most)
// POST   /api/channels/:id/test  ChannelTestInput → ChannelTestResult (webhook kind; signed like any caller)
// PUT    /api/channels/:id  ChannelInput   → ChannelView
// DELETE /api/channels/:id                 → { ok: true }
// POST   /hooks/:channelId                 → adapter defined (inbound platform webhooks)
//   webhook kind: X-Z-Timestamp (unix s), X-Z-Delivery (unique id), X-Z-Signature `v1=<hex HMAC-SHA256(secret,
//   "<timestamp>.<delivery>.<raw body>")>`; 401 when unsigned, stale (>5 min) or tampered. A delivery id seen in
//   the last 7 days → 200 { duplicate: true }, nothing re-run. Bare X-Z-Secret only with config `legacySecret: "on"`.
//   Owner notices POSTed to `notifyUrl` carry the same three headers.
