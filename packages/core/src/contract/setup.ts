import type { Routing } from "./common.ts";
import type { ProviderKind } from "./providers.ts";
import type { ChannelKind } from "./channels.ts";
import type { ConnectorAuth } from "./connectors.ts";
import type { ServerText } from "./messages.ts";

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
  /** `chat_model`, `lanes`, `token`, `public_url`, `push`, `owner`, `master_key`, `channel:<id>`, `connector:<id>`, `codex:<provider id>`. */
  id: string;
  label: string;
  state: SetupState;
  detail: string;
  /** Where to fix it in the app; null when the fix is outside z (an environment variable). */
  fix: { label: string; path: string; labelMsg?: ServerText } | null;
  /** The owner confirms this one themselves (backing up the master key): button label for POST /api/setup/:id/ack. */
  ack?: string;
  /** `label`, `detail` and `ack` as message keys the app words in the owner's language (the English stays for API clients). */
  labelMsg?: ServerText;
  detailMsg?: ServerText;
  ackMsg?: ServerText;
};

export type SetupChecklist = {
  rows: SetupRow[];
  /** When the live checks (POST /api/setup/check) last ran; null when never. */
  checkedAt: string | null;
  /**
   * A model has answered z at least once (a live check passed, or a call used tokens). Until then the
   * app leads with setup; afterwards a failing chat model is a banner on Today, never a wall.
   */
  modelAnswered: boolean;
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

// Routes (HTTP API; overview in ../contract.ts):
// GET    /api/setup                        → SetupChecklist   (cached results only; no model calls)
// POST   /api/setup/check                  → SetupChecklist   (re-runs the live model tests with a short timeout, re-probes the rest)
// POST   /api/setup/:id/ack                → SetupChecklist   (rows with `ack` only)
// GET    /api/diagnostics                  → JSON attachment `z-diagnostics-<date>.json` (Diagnostics)

// ─── End setup checklist ────────────────────────────────────────────────────
