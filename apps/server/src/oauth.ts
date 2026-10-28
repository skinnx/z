/**
 * OAuth for MCP connectors: an `OAuthClientProvider` whose state lives sealed in the connector row.
 * Discovery, dynamic client registration, PKCE and the code exchange are run by @ai-sdk/mcp's `auth()`.
 *
 * Only an interactive provider (the owner pressed "Sign in") may start a new authorization: it
 * stores the PKCE verifier and a single-use state that expires after 10 minutes. Background
 * connects use a non-interactive one, which never overwrites a pending sign-in and turns "needs a
 * new login" into NeedsAuthError.
 *
 * Token refresh is z's own (`refreshOAuth`), not the library's, which treats every refresh failure,
 * an unreachable server included, as "sign in again". The non-interactive provider hides the
 * refresh token from it; the connector refreshes ahead of expiry and on a 401:
 *
 *   token endpoint answers                         outcome     tokens    client registration
 *   200 with an access token                       refreshed   replaced  kept
 *   invalid_grant (or another OAuth error code)    needs_auth  dropped   kept
 *   invalid_client, unauthorized_client, bare 401  needs_auth  dropped   dropped: the next sign-in registers anew
 *   network error, timeout, 429, 5xx, garbage      retry       kept      kept (the connector backs off)
 *
 * Deleting a connector revokes its tokens at the authorization server (RFC 7009), best effort.
 */
import { randomBytes } from "node:crypto";
import type { OAuthAuthorizationServerInformation, OAuthClientInformation, OAuthClientProvider, OAuthTokens } from "@ai-sdk/mcp";
import type { Store } from "./store.ts";

export const STATE_TTL_MS = 10 * 60_000;

export type OAuthState = {
  tokens?: OAuthTokens;
  tokensSavedAt?: number;
  client?: OAuthClientInformation;
  /** Redirect URI the client was registered with. */
  clientRedirectUri?: string;
  dynamic?: boolean;
  server?: OAuthAuthorizationServerInformation;
  verifier?: string;
  state?: string;
  stateExpiresAt?: number;
  /** Redirect URI of the pending authorization; the code exchange must repeat it. */
  redirectUri?: string;
  /** RFC 8707 resource the grant was requested for; refreshes repeat it. */
  resource?: string;
};

export class NeedsAuthError extends Error {
  constructor() {
    super("Sign in again to connect");
    this.name = "NeedsAuthError";
  }
}

export function readOAuth(store: Store, id: string): OAuthState {
  return store.connectors.oauth<OAuthState>(id) ?? {};
}

export function writeOAuth(store: Store, id: string, patch: Partial<OAuthState>) {
  const next = { ...readOAuth(store, id), ...patch };
  for (const key of Object.keys(next) as (keyof OAuthState)[]) if (next[key] === undefined) delete next[key];
  store.connectors.setOAuth(id, Object.keys(next).length ? next : null);
}

export function createOAuthProvider(
  store: Store,
  id: string,
  options: { redirectUri: string; interactive: boolean; onRedirect?: (url: URL) => void },
): OAuthClientProvider {
  const read = () => readOAuth(store, id);
  const write = (patch: Partial<OAuthState>) => writeOAuth(store, id, patch);
  return {
    get redirectUrl() {
      return options.redirectUri;
    },
    get clientMetadata() {
      return {
        client_name: "z",
        redirect_uris: [options.redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      };
    },
    clientInformation: () => read().client,
    isClientInformationDynamicallyRegistered: () => Boolean(read().dynamic),
    saveClientInformation: (client) => write({ client, dynamic: true, clientRedirectUri: options.redirectUri }),
    authorizationServerInformation: () => read().server,
    saveAuthorizationServerInformation: (server) => write({ server }),
    tokens: () => {
      const tokens = read().tokens;
      if (!tokens || options.interactive) return tokens;
      // Without a refresh token the library goes straight to "sign in" (NeedsAuthError); z refreshes itself.
      const { refresh_token: _hidden, ...rest } = tokens;
      return rest;
    },
    saveTokens: (tokens) => write({ tokens, tokensSavedAt: Date.now() }),
    saveCodeVerifier: (verifier) => {
      if (options.interactive) write({ verifier });
    },
    codeVerifier: () => {
      const verifier = read().verifier;
      if (!verifier) throw new Error("No sign-in is pending for this connector");
      return verifier;
    },
    state: () => randomBytes(24).toString("base64url"),
    saveState: (state) => {
      if (options.interactive) write({ state, stateExpiresAt: Date.now() + STATE_TTL_MS, redirectUri: options.redirectUri });
    },
    storedState: () => read().state,
    redirectToAuthorization: (url) => {
      if (!options.interactive) throw new NeedsAuthError();
      options.onRedirect?.(url);
    },
    invalidateCredentials: (scope, context) => {
      if (scope === "all") store.connectors.setOAuth(id, null);
      else if (scope === "client") write({ client: undefined, dynamic: undefined, clientRedirectUri: undefined, server: undefined });
      else if (scope === "verifier") write({ verifier: undefined });
      // Only drop the generation that failed, not tokens a concurrent refresh just saved.
      else if (!context || read().tokens?.access_token === context.tokens.access_token) write({ tokens: undefined, tokensSavedAt: undefined });
    },
  };
}

export const REFRESH_TIMEOUT_MS = 15_000;
export const REVOKE_TIMEOUT_MS = 5_000;

export type RefreshOutcome =
  | { outcome: "refreshed" }
  /** The grant is gone: the owner signs in again. `dropped` says what was cleared from the row. */
  | { outcome: "needs_auth"; dropped: "nothing" | "tokens" | "client"; detail: string }
  /** The authorization server could not answer; nothing was changed. */
  | { outcome: "retry"; detail: string };

/** When the stored access token expires (ms since epoch), or null when the server didn't say. */
export function expiresAt(state: OAuthState): number | null {
  const seconds = state.tokens?.expires_in;
  return seconds && state.tokensSavedAt ? state.tokensSavedAt + seconds * 1000 : null;
}

type ClientInfo = OAuthClientInformation & { token_endpoint_auth_method?: string };

/** Client authentication for token and revocation requests (RFC 6749 §2.3), as registered. */
function authenticate(client: ClientInfo, headers: Headers, params: URLSearchParams) {
  const method = client.token_endpoint_auth_method ?? (client.client_secret ? "client_secret_basic" : "none");
  if (client.client_secret && method === "client_secret_basic") {
    const encode = (s: string) => encodeURIComponent(s).replace(/%20/g, "+");
    headers.set("authorization", `Basic ${Buffer.from(`${encode(client.client_id)}:${encode(client.client_secret)}`).toString("base64")}`);
    return;
  }
  params.set("client_id", client.client_id);
  if (client.client_secret && method === "client_secret_post") params.set("client_secret", client.client_secret);
}

function oauthErrorOf(text: string): { code: string; description: string } | null {
  try {
    const body = JSON.parse(text) as { error?: unknown; error_description?: unknown };
    if (typeof body.error !== "string") return null;
    return { code: body.error, description: typeof body.error_description === "string" ? body.error_description.slice(0, 200) : "" };
  } catch {
    return null;
  }
}

/**
 * Exchange the stored refresh token for new tokens and apply the outcome table above to the row.
 * Never logs or returns token values. Callers serialize per connector: refresh tokens may rotate.
 */
export async function refreshOAuth(store: Store, id: string, fetchFn: typeof fetch, timeoutMs = REFRESH_TIMEOUT_MS): Promise<RefreshOutcome> {
  const state = readOAuth(store, id);
  const tokens = state.tokens;
  const client = state.client as ClientInfo | undefined;
  const endpoint = tokens?.token_endpoint ?? state.server?.tokenEndpoint ?? client?.token_endpoint;
  if (!tokens?.refresh_token || !client || !endpoint) {
    return { outcome: "needs_auth", dropped: "nothing", detail: "The sign-in expired and the server gave no refresh token. Sign in again." };
  }
  const headers = new Headers({ "content-type": "application/x-www-form-urlencoded", accept: "application/json" });
  const params = new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token });
  authenticate(client, headers, params);
  if (state.resource) params.set("resource", state.resource);

  let res: Response;
  let text: string;
  try {
    res = await fetchFn(endpoint, { method: "POST", headers, body: params, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    text = await res.text();
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? "did not answer in time" : "unreachable";
    return { outcome: "retry", detail: `Could not refresh the sign-in: the authorization server is ${reason}` };
  }

  if (res.ok) {
    let next: Partial<OAuthTokens> | null = null;
    try {
      next = JSON.parse(text) as Partial<OAuthTokens>;
    } catch {}
    if (!next || typeof next.access_token !== "string" || !next.access_token) {
      return { outcome: "retry", detail: `Could not refresh the sign-in: the authorization server sent an unreadable answer (HTTP ${res.status})` };
    }
    // Keep the authorization-server pin the library checks, and the refresh token when it isn't rotated.
    const saved: OAuthTokens = {
      ...(tokens.issuer ? { issuer: tokens.issuer } : {}),
      ...(tokens.authorization_server ? { authorization_server: tokens.authorization_server } : {}),
      token_endpoint: endpoint,
      access_token: next.access_token,
      token_type: typeof next.token_type === "string" ? next.token_type : tokens.token_type,
      refresh_token: typeof next.refresh_token === "string" && next.refresh_token ? next.refresh_token : tokens.refresh_token,
      ...(typeof next.expires_in === "number" ? { expires_in: next.expires_in } : {}),
      ...(typeof next.scope === "string" ? { scope: next.scope } : tokens.scope ? { scope: tokens.scope } : {}),
      ...(typeof next.id_token === "string" ? { id_token: next.id_token } : {}),
    };
    writeOAuth(store, id, { tokens: saved, tokensSavedAt: Date.now() });
    return { outcome: "refreshed" };
  }

  const error = oauthErrorOf(text);
  if (res.status === 429 || res.status >= 500 || (!error && res.status !== 401)) {
    return { outcome: "retry", detail: `Could not refresh the sign-in: the authorization server answered HTTP ${res.status}` };
  }
  const why = error ? `${error.code}${error.description ? `: ${error.description}` : ""}` : `HTTP ${res.status}`;
  if (!error || error.code === "invalid_client" || error.code === "unauthorized_client") {
    // The registration itself is no longer accepted: the next sign-in registers a new client.
    writeOAuth(store, id, { tokens: undefined, tokensSavedAt: undefined, client: undefined, dynamic: undefined, clientRedirectUri: undefined });
    return { outcome: "needs_auth", dropped: "client", detail: `The server no longer accepts z's app registration (${why}). Sign in again.` };
  }
  writeOAuth(store, id, { tokens: undefined, tokensSavedAt: undefined });
  return { outcome: "needs_auth", dropped: "tokens", detail: `The sign-in expired or was revoked (${why}). Sign in again.` };
}

/** RFC 8414 and OpenID discovery URLs for an authorization server, most specific first. */
function metadataUrls(authorizationServerUrl: string): URL[] {
  const url = new URL(authorizationServerUrl);
  const path = url.pathname.replace(/\/+$/, "");
  const at = (p: string) => new URL(p, url.origin);
  return path
    ? [at(`/.well-known/oauth-authorization-server${path}`), at(`/.well-known/openid-configuration${path}`), at(`${path}/.well-known/openid-configuration`)]
    : [at("/.well-known/oauth-authorization-server"), at("/.well-known/openid-configuration")];
}

async function revocationEndpoint(authorizationServerUrl: string, fetchFn: typeof fetch, signal: AbortSignal): Promise<string | null> {
  for (const url of metadataUrls(authorizationServerUrl)) {
    const res = await fetchFn(url, { headers: { accept: "application/json" }, redirect: "error", signal });
    if (!res.ok) {
      await res.body?.cancel();
      continue;
    }
    const meta = (await res.json().catch(() => ({}))) as { revocation_endpoint?: unknown };
    return typeof meta.revocation_endpoint === "string" ? meta.revocation_endpoint : null;
  }
  return null;
}

/**
 * Revoke stored tokens (RFC 7009) at the authorization server, refresh token first since that
 * usually ends the whole grant. Takes the state read before the row was deleted. Resolves to how
 * many tokens the server accepted (0 when it has no revocation endpoint); rejects only for the
 * caller to log.
 */
export async function revokeOAuth(state: OAuthState, fetchFn: typeof fetch, timeoutMs = REVOKE_TIMEOUT_MS): Promise<number> {
  const tokens = state.tokens;
  const client = state.client as ClientInfo | undefined;
  const server = tokens?.authorization_server ?? state.server?.authorizationServerUrl ?? client?.authorization_server;
  if (!tokens || !client || !server) return 0;
  const signal = AbortSignal.timeout(timeoutMs);
  const endpoint = await revocationEndpoint(server, fetchFn, signal);
  if (!endpoint) return 0;
  const pending: [string, string][] = [];
  if (tokens.refresh_token) pending.push([tokens.refresh_token, "refresh_token"]);
  pending.push([tokens.access_token, "access_token"]);
  let revoked = 0;
  for (const [token, hint] of pending) {
    const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" });
    const params = new URLSearchParams({ token, token_type_hint: hint });
    authenticate(client, headers, params);
    const res = await fetchFn(endpoint, { method: "POST", headers, body: params, redirect: "error", signal });
    await res.body?.cancel();
    if (res.ok) revoked++;
  }
  return revoked;
}
