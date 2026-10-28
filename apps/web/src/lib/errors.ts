/**
 * The one place a failure's text becomes "what happened and what fixes it". Patterns come from what
 * real servers answer, as z's `describeError` passes them on (`<status> <provider message>`):
 *   OpenAI     401 Incorrect API key provided: sk-wrong****. You can find your API key at …
 *   Anthropic  401 invalid x-api-key
 *   Pollinations 404 Model "openai-large" isn't on the Classic API. Free models: …
 *   LLM7       400 Model 'x' is currently unavailable.
 *   z          Every model for this job is rate limited; retry in 30s: 429 … (402/429 from free tiers)
 *   z          No model is configured for this lane. Add a provider and set routing.
 *   browser    Failed to fetch / NetworkError when attempting to fetch resource / Load failed
 */
import type { ConnectorView, ModelRef, ProviderView } from "@z/core";
import { splitRef } from "./models.ts";

export type ErrorKind = "key" | "quota" | "model" | "no-model" | "offline" | "server" | "sign-in" | "unknown";

/** The message inside an error, a JSON `{ error }` body, or a plain string. */
export function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : error == null ? "" : String(error);
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      const body = JSON.parse(trimmed) as { error?: unknown; message?: unknown };
      const inner = typeof body.error === "string" ? body.error : typeof body.message === "string" ? body.message : null;
      if (inner) return inner;
    } catch {}
  }
  return trimmed;
}

const NO_MODEL = /no model is configured|no models? (?:configured|chosen|set)/i;
const NETWORK = /^offline$|failed to fetch|networkerror|network ?error|load failed|network request failed|err_internet_disconnected|err_connection_refused|econnrefused/i;
// Checked before the key patterns: "Every model … is rate limited: 401 …" is about the limit.
// Keyless tiers phrase limits their own way: Pollinations answers 402 FREE_LIMIT ("Free limit reached … Retry after 24s").
const QUOTA = /free.?limit|"status":\s*(?:402|429)\b|retry after \d+\s*s|^(?:402|429)\b|rate.?limit|quota|insufficient[_ ](?:quota|balance|credits?|funds)|out of credits|too many requests|payment required|queue full|credit balance|billing/i;
const MODEL = /^404\b.*model|model\b.*(?:not found|does not exist|doesn't exist|is not available|is currently unavailable|unavailable|isn't on|not supported|unknown|invalid)|unknown model|invalid model|no such model|model_not_found/i;
const KEY = /^(?:401|403)\b|incorrect api key|invalid (?:x-)?api[- _]?key|api[- _]?key (?:not valid|is invalid|expired)|invalid_api_key|authentication_error|unauthori[sz]ed|permission_denied|expired (?:api )?key|key (?:was )?revoked/i;
const SIGN_IN = /needs? (?:you to )?sign.?in|needs_auth|sign in again|reauthori[sz]e|invalid_grant|token (?:has )?expired/i;

/** What kind of failure this is, from its text (and, for network failures, whether the device is online). */
export function classifyError(error: unknown, online: boolean = typeof navigator === "undefined" || navigator.onLine !== false): ErrorKind {
  const status = error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : undefined;
  const text = errorMessage(error);
  if (status === 0 || NETWORK.test(text)) return online ? "server" : "offline";
  if (!text) return "unknown";
  if (NO_MODEL.test(text)) return "no-model";
  if (QUOTA.test(text)) return "quota";
  if (MODEL.test(text)) return "model";
  if (SIGN_IN.test(text)) return "sign-in";
  if (KEY.test(text)) return "key";
  return "unknown";
}

/**
 * What a connector's state asks of the owner, or null when it's fine. An OAuth source wants a sign-in;
 * a header-auth one the server rejected (needs_auth, "HTTP 401") wants its key fixed; other errors
 * read from their text, but never as "z's server is down" (the connector's server is a different one).
 */
export function connectorFailure(c: { status: ConnectorView["status"]; auth: ConnectorView["auth"]; enabled: boolean; oauth?: ConnectorView["oauth"]; statusDetail?: string | null }): ErrorKind | null {
  if (c.auth === "oauth" && (c.status === "needs_auth" || (c.enabled && !c.oauth?.connected))) return "sign-in";
  if (c.status === "needs_auth") return "key";
  if (c.status !== "error") return null;
  const kind = classifyError(c.statusDetail ?? "", true);
  return kind === "key" || kind === "sign-in" ? kind : "unknown";
}

/**
 * Which configured provider a model failure is about. Hints in the text win (each provider words its
 * own errors); otherwise the last model a chain tried, since a fallback chain throws the last error.
 */
export function providerForError(error: unknown, refs: (ModelRef | null | undefined)[], providers: ProviderView[]): ProviderView | null {
  const text = errorMessage(error);
  const ids = refs.filter((r): r is ModelRef => Boolean(r)).map((r) => splitRef(r).provider);
  const candidates = ids.map((id) => providers.find((p) => p.id === id)).filter((p): p is ProviderView => Boolean(p));
  const pool = candidates.length ? candidates : providers;
  const hinted =
    (/x-api-key|anthropic/i.test(text) && pool.find((p) => p.kind === "anthropic")) ||
    (/openai\.com/i.test(text) && pool.find((p) => p.kind === "openai")) ||
    (/pollinations/i.test(text) && pool.find((p) => p.baseURL?.includes("pollinations"))) ||
    (/llm7/i.test(text) && pool.find((p) => p.baseURL?.includes("llm7"))) ||
    (/googleapis|api key not valid/i.test(text) && pool.find((p) => p.kind === "google"));
  return hinted || candidates[candidates.length - 1] || null;
}
