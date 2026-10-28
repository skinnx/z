import { z } from "zod";
import type { Lane } from "./common.ts";

// ─── BYOK: providers & model routing ────────────────────────────────────────

export const ProviderKind = z.enum([
  "openai",
  "anthropic",
  "google",
  "xai",
  "openrouter",
  "ollama",
  "openai-compatible",
  "codex-cli", // see "Codex CLI provider" below
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
  /** `codex-cli` only: absolute path to the `codex` binary (see "Codex CLI provider" below). */
  command: z.string().max(1024).regex(/^(\/|[A-Za-z]:[\\/])/, "must be an absolute path").optional(),
});
export type ProviderInput = z.input<typeof ProviderInput>;

// ─── Codex CLI provider ─────────────────────────────────────────────────────
// `codex-cli` runs z on the owner's ChatGPT plan through the official Codex CLI installed and signed
// in (`codex login`) on the server's machine. z talks only to `codex app-server` (JSON-RPC over stdio),
// which owns sign-in; z never reads or forwards Codex credentials. No API key, no base URL.
// - `command`: the `codex` binary; default `codex` on PATH, else the one shipped with z (@openai/codex).
// - `models`: optional; empty uses Codex's default model. Model refs look like `codex:<model id>`.
// z's tools are offered to Codex as dynamic tools, so every call still passes z's sensitive-data
// guard, safety floor, policy, reviewer and approvals; Codex's own shell, file, MCP and web tools are
// turned off, its sandbox is read-only, and any approval it asks for is declined.
// Claude subscriptions are deliberately not supported: Anthropic forbids third-party use of them.

/** Who Codex is signed in as, from `account/read`. `plan` is the ChatGPT plan (`plus`, `pro`, …). */
export type CodexAccount =
  | { signedIn: false }
  | { signedIn: true; method: "chatgpt"; email: string | null; plan: string | null }
  | { signedIn: true; method: "apiKey" | "other" };

export const CODEX_NOT_SIGNED_IN = "Codex CLI is not signed in — run `codex login` on this server's machine";

/** POST /api/providers/:id/test. `account`: codex-cli only. `rateLimited`/`timedOut`: inconclusive. */
export type ProviderTestResult = {
  ok: boolean;
  model?: string;
  latencyMs?: number;
  error?: string;
  rateLimited?: boolean;
  timedOut?: boolean;
  account?: CodexAccount;
};
// ─── End Codex CLI provider ─────────────────────────────────────────────────

/** A provider as returned to clients. Keys never leave the server. */
export type ProviderView = Omit<z.output<typeof ProviderInput>, "apiKey"> & {
  hasKey: boolean;
  /** Last four characters of the key, for recognition only. */
  keyHint: string | null;
  usage: { monthUsd: number; monthTokens: number };
};

/**
 * PUT /api/providers/:id?check=1: saved first, then checked live with a short timeout. With no models
 * the server lists the provider's and keeps a main and a quick one. When the check answered (or was
 * only rate limited or slow), every empty lane gets this provider's models; `filledLanes` says which.
 * A rejected key still saves: `check` carries the error so the form can show it.
 */
export type ProviderSaveResult = ProviderView & { check?: ProviderTestResult; filledLanes?: Lane[] };

// Routes (HTTP API; overview in ../contract.ts):
// GET    /api/providers                    → ProviderView[]
// PUT    /api/providers/:id ProviderInput  → ProviderView (`?check=1`: ProviderSaveResult, see above)
// DELETE /api/providers/:id                → { ok: true }
// POST   /api/providers/:id/test           → ProviderTestResult (codex-cli: with `account`, the sign-in state)
// GET    /api/providers/:id/models         → { models: string[] }   (live list from the provider when supported)
// GET    /api/routing                      → Routing
// PUT    /api/routing       Routing        → Routing
