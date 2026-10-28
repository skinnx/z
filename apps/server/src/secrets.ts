/**
 * The secret registry: every secret the server decrypts or is handed (provider keys, channel and
 * connector secrets, OAuth tokens, saved sign-ins, the VAPID private key, Z_TOKEN, the master key)
 * registers its exact value here. Everything the process writes to stdout/stderr passes through
 * `redact`, which replaces each occurrence with `[secret:<last4>]`, so a key that ends up inside an
 * error message, a stack trace or a plugin's log line never reaches the terminal or a log file.
 * The last 200 lines (already redacted) stay in memory for diagnostics.
 * (Idea from nightly-labs/openbot's secret registry; re-implemented for z.)
 */

/** Shorter values are not registered: redacting "on" or a 4-digit id everywhere would ruin the logs, not protect anything. */
const MIN_LENGTH = 6;
/** JSON leaves (channel config, plugin settings, OAuth state) mix secrets with plain values; only longer ones count. */
const MIN_LEAF_LENGTH = 8;
/** Leaves of sealed JSON that are public by design (JWK public parts, OAuth metadata). */
const PUBLIC_KEYS = new Set(["kty", "crv", "x", "y", "ext", "key_ops", "alg", "use", "token_type", "scope", "expires_in", "server", "redirectUri", "clientRedirectUri", "redirect_uris", "client_name", "grant_types", "response_types", "token_endpoint_auth_method", "p256dh"]);
const LOG_LINES = 200;

export type LogLine = { at: string; stream: "stdout" | "stderr"; line: string };

const known = new Map<string, string>(); // value → replacement
let pattern: RegExp | null = null;
let dirty = false;
const lines: LogLine[] = [];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function add(value: string, last4: string) {
  if (value.length < MIN_LENGTH || known.has(value)) return;
  // The replacement lands inside JSON and log lines: keep it free of quotes, backslashes and controls.
  known.set(value, `[secret:${last4.replace(/[^\w.~+/=-]/g, "*")}]`);
  dirty = true;
}

/** Register a secret's exact value, plus the forms it travels in (after `Bearer `, URL-encoded, JSON-escaped). */
export function registerSecret(value: string | null | undefined, minLength = MIN_LENGTH) {
  if (typeof value !== "string") return;
  const v = value.trim();
  if (v.length < minLength) return;
  const label = v.slice(-4);
  add(v, label);
  const scheme = /^(?:bearer|basic|token|bot)\s+(\S+)$/i.exec(v);
  if (scheme?.[1]) add(scheme[1], scheme[1].slice(-4));
  const encoded = encodeURIComponent(v);
  if (encoded !== v) add(encoded, label);
  const escaped = JSON.stringify(v).slice(1, -1);
  if (escaped !== v) add(escaped, label);
}

/** Register every string leaf of a decrypted JSON value (skipping fields that are public by design). */
export function registerSecretsIn(value: unknown, key?: string) {
  if (key && PUBLIC_KEYS.has(key)) return;
  if (typeof value === "string") registerSecret(value, MIN_LEAF_LENGTH);
  else if (Array.isArray(value)) for (const item of value) registerSecretsIn(item);
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) registerSecretsIn(v, k);
}

/** Replace every registered secret in `text` with `[secret:<last4>]`. */
export function redact(text: string): string {
  if (known.size === 0) return text;
  if (dirty || !pattern) {
    // Longest first, so a secret that contains another is replaced whole.
    const values = [...known.keys()].sort((a, b) => b.length - a.length);
    pattern = new RegExp(values.map(escape).join("|"), "g");
    dirty = false;
  }
  return text.replace(pattern, (match) => known.get(match) ?? "[secret]");
}

/** Redact a JSON-able value (diagnostics, test assertions) by its serialized form. */
export function redactJson<T>(value: T): T {
  return JSON.parse(redact(JSON.stringify(value))) as T;
}

/** The last 200 log lines, redacted again with every secret known now (some register after they were logged). */
export function recentLogs(): LogLine[] {
  return lines.map((l) => ({ ...l, line: redact(l.line) }));
}

let installed = false;

/**
 * Route stdout and stderr through `redact`: console.*, the core `log` deps, uncaught-exception
 * traces and plugins all write there. Idempotent.
 */
export function installRedaction() {
  if (installed) return;
  installed = true;
  for (const name of ["stdout", "stderr"] as const) {
    const stream = process[name];
    const write = stream.write.bind(stream) as (...args: unknown[]) => boolean;
    let partial = "";
    stream.write = ((chunk: unknown, ...rest: unknown[]) => {
      const text = typeof chunk === "string" ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk).toString("utf8") : null;
      if (text === null) return write(chunk, ...rest);
      const clean = redact(text);
      // Keep whole lines for diagnostics; a write without a newline waits for the rest.
      const parts = (partial + clean).split("\n");
      partial = parts.pop() ?? "";
      if (partial.length > 4000) partial = partial.slice(0, 4000);
      const at = new Date().toISOString();
      for (const line of parts) {
        if (!line.trim()) continue;
        lines.push({ at, stream: name, line: line.length > 2000 ? `${line.slice(0, 2000)}…` : line });
        if (lines.length > LOG_LINES) lines.shift();
      }
      // Strings keep their encoding argument; bytes are re-encoded only when something was replaced.
      if (typeof chunk === "string") return write(clean, ...rest);
      if (clean === text) return write(chunk, ...rest);
      return write(clean, ...(typeof rest[0] === "string" ? rest.slice(1) : rest));
    }) as typeof stream.write;
  }
  // Node prints a crash straight to fd 2, around process.stderr: print it through console instead.
  process.on("uncaughtException", (error) => {
    console.error(error);
    process.exit(1);
  });
}
