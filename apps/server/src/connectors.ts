/**
 * Connector lifecycle: one MCP client per enabled connector, connected on save and at startup,
 * tool definitions cached in the row, reconnect with backoff, OAuth sign-in. Tools reach the
 * runtime as ActivePlugins (`connectorPlugin`), so every run applies z's usual policy to them.
 *
 * URLs and headers are secrets (some services embed the key in the URL): they never appear in
 * views, logs or status details. Targets are SSRF-checked on every request, including OAuth
 * discovery, unless Z_ALLOW_PRIVATE_MCP=1.
 */
import { timingSafeEqual } from "node:crypto";
import { auth, createMCPClient, UnauthorizedError, type MCPClient } from "@ai-sdk/mcp";
import {
  capText,
  connectorPlugin,
  describeError,
  describeTools,
  MAX_INSTRUCTIONS,
  type ActivePlugin,
  type ConnectorView,
  type McpCallResult,
  type McpToolDefinition,
  type OAuthStart,
} from "@z/core";
import { resolvePublicHost } from "@z/plugins";
import pkg from "../package.json" with { type: "json" };
import type { Bus } from "./bus.ts";
import type { Env } from "./env.ts";
import { createOAuthProvider, expiresAt, NeedsAuthError, readOAuth, refreshOAuth, revokeOAuth, writeOAuth, type RefreshOutcome } from "./oauth.ts";
import type { ConnectorCache, ConnectorRecord, Store } from "./store.ts";

const CONNECT_TIMEOUT = 15_000;
const LIST_TIMEOUT = 15_000;
const CALL_TIMEOUT = 120_000;
const MAX_TOOL_PAGES = 20;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 10 * 60_000;
/** Refresh this long before the access token expires. */
const REFRESH_AHEAD_MS = 2 * 60_000;
const REFRESH_MIN_DELAY_MS = 30_000;
/** setTimeout's ceiling is ~24.8 days; long-lived tokens are simply checked again daily. */
const REFRESH_MAX_DELAY_MS = 24 * 60 * 60_000;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type Connectors = ReturnType<typeof createConnectors>;

/** Thrown for problems the owner can fix (bad URL, private address, not an OAuth connector). */
export class ConnectorError extends Error {}

export function createConnectors(env: Env, store: Store, bus: Bus) {
  const clients = new Map<string, MCPClient>();
  const retries = new Map<string, { timer: NodeJS.Timeout | null; attempt: number }>();
  const refreshTimers = new Map<string, NodeJS.Timeout>();
  // One refresh in flight per connector: a rotating refresh token can only be spent once.
  const refreshing = new Map<string, Promise<RefreshOutcome>>();
  // Serializes connect/disconnect per connector so rapid edits don't race.
  const locks = new Map<string, Promise<void>>();

  const log = (id: string, text: string) => console.log(`[z:connector:${id}] ${text}`);

  /** Every request a connector makes (MCP and OAuth discovery) goes through this check. */
  async function assertTarget(url: URL) {
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new ConnectorError("Connector URLs must be http(s)");
    if (env.allowPrivateMcp) return;
    if (url.protocol !== "https:") throw new ConnectorError("Connector URLs must use https (set Z_ALLOW_PRIVATE_MCP=1 for MCP servers on your own network)");
    try {
      await resolvePublicHost(url.hostname);
    } catch {
      throw new ConnectorError(`${url.hostname} is a private or local address; set Z_ALLOW_PRIVATE_MCP=1 to allow MCP servers on your own network`);
    }
  }

  const guardedFetch: typeof fetch = async (input, init) => {
    await assertTarget(new URL(input instanceof Request ? input.url : String(input)));
    const res = await fetch(input, init);
    // @hono/node-server swaps the global Response, so `instanceof Response` fails on undici's and
    // @ai-sdk/mcp's OAuth error parsing prints "[object Response]". Error bodies are small: rewrap them.
    if (res.ok || res instanceof Response) return res;
    const foreign = res as Response; // the types don't know about the swap
    return new Response(await foreign.text(), { status: foreign.status, statusText: foreign.statusText, headers: foreign.headers });
  };

  /** Strip the URL (path and query can hold secrets) and header values from anything shown or logged. */
  function redact(record: ConnectorRecord, text: string): string {
    let out = text;
    const secrets = [record.url, ...Object.values(record.headers)].filter((s) => s.length >= 4);
    try {
      const u = new URL(record.url);
      if (u.pathname.length > 1) secrets.push(u.pathname + u.search);
      if (u.search) secrets.push(u.search.slice(1));
    } catch {}
    for (const secret of secrets.sort((a, b) => b.length - a.length)) out = out.split(secret).join(secret === record.url ? record.urlDisplay : "…");
    return capText(out, 500);
  }

  function view(record: ConnectorRecord): ConnectorView {
    const oauth = record.auth === "oauth" && record.hasOAuth ? readOAuth(store, record.id) : null;
    const tokens = oauth?.tokens;
    const expiry = oauth ? expiresAt(oauth) : null;
    return {
      id: record.id,
      label: record.label,
      transport: record.transport,
      auth: record.auth,
      enabled: record.enabled,
      public: record.public,
      risks: record.risks,
      urlDisplay: record.urlDisplay,
      headerKeys: Object.keys(record.headers),
      status: record.status,
      statusDetail: record.statusDetail,
      server: record.cache?.server ?? null,
      instructions: record.cache?.instructions ? capText(record.cache.instructions, MAX_INSTRUCTIONS) : null,
      tools: record.cache ? describeTools(record.id, record.cache.tools, record.risks) : [],
      oauth: tokens
        ? {
            connected: record.status === "connected",
            scope: tokens.scope ?? null,
            expiresAt: expiry ? new Date(expiry).toISOString() : null,
          }
        : null,
      signInPending: Boolean(oauth?.state && oauth.stateExpiresAt && oauth.stateExpiresAt > Date.now()),
      updatedAt: record.updatedAt,
    };
  }

  function setStatus(id: string, status: ConnectorView["status"], detail: string | null) {
    store.connectors.setStatus(id, status, detail);
    const record = store.connectors.get(id);
    if (record) bus.emit({ type: "connector", connector: view(record) });
  }

  /** Where the provider sends the browser back; fixed per pending sign-in. */
  const defaultRedirectUri = () => `${env.publicUrl ?? `http://localhost:${env.port}`}/oauth/callback`;

  function isUnauthorized(error: unknown): boolean {
    for (let e = error, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
      if (e instanceof UnauthorizedError || e instanceof NeedsAuthError) return true;
      if ((e as { statusCode?: number }).statusCode === 401) return true;
    }
    return false;
  }

  async function listDefinitions(client: MCPClient): Promise<McpToolDefinition[]> {
    const out: McpToolDefinition[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const result = await client.listTools({ ...(cursor ? { params: { cursor } } : {}), options: { timeout: LIST_TIMEOUT } });
      for (const t of result.tools) {
        out.push({
          name: t.name,
          ...(t.title ? { title: t.title } : {}),
          ...(t.description ? { description: t.description } : {}),
          inputSchema: t.inputSchema as Record<string, unknown>,
          ...(t.annotations ? { annotations: t.annotations } : {}),
        });
      }
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    return out;
  }

  async function disconnect(id: string) {
    const client = clients.get(id);
    clients.delete(id);
    await client?.close().catch(() => {});
  }

  function clearRetry(id: string, resetAttempts: boolean) {
    const retry = retries.get(id);
    if (retry?.timer) clearTimeout(retry.timer);
    if (resetAttempts) retries.delete(id);
    else if (retry) retry.timer = null;
  }

  function scheduleRetry(id: string): number {
    const attempt = retries.get(id)?.attempt ?? 0;
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempt) + Math.round(Math.random() * 1000);
    const timer = setTimeout(() => void sync(id, false), delay);
    timer.unref();
    retries.set(id, { timer, attempt: attempt + 1 });
    return delay;
  }

  function clearRefresh(id: string) {
    const timer = refreshTimers.get(id);
    if (timer) clearTimeout(timer);
    refreshTimers.delete(id);
  }

  function refresh(id: string): Promise<RefreshOutcome> {
    const inFlight = refreshing.get(id);
    if (inFlight) return inFlight;
    const next = refreshOAuth(store, id, guardedFetch).finally(() => refreshing.delete(id));
    refreshing.set(id, next);
    return next;
  }

  /**
   * Refresh and report: true when new tokens are stored. Otherwise the status says what happened:
   * needs_auth for a dead grant, or an error with a scheduled retry while the server is unreachable.
   */
  async function refreshForConnect(id: string): Promise<boolean> {
    const result = await refresh(id);
    if (result.outcome === "refreshed") {
      log(id, "sign-in refreshed");
      return true;
    }
    if (result.outcome === "needs_auth") {
      log(id, `needs auth: ${result.detail}`);
      setStatus(id, "needs_auth", result.detail);
      return false;
    }
    const delay = scheduleRetry(id);
    log(id, `${result.detail}; retrying in ${Math.round(delay / 1000)}s`);
    setStatus(id, "error", `${result.detail} · retrying in ${Math.round(delay / 1000)}s`);
    return false;
  }

  /** While connected, refresh ahead of expiry so the live client keeps working without a reconnect. */
  function scheduleRefresh(id: string, attempt = 0) {
    clearRefresh(id);
    const oauth = readOAuth(store, id);
    const expiry = expiresAt(oauth);
    if (!oauth.tokens?.refresh_token || !expiry) return;
    const due = attempt ? Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempt) : expiry - Date.now() - REFRESH_AHEAD_MS;
    const delay = Math.min(REFRESH_MAX_DELAY_MS, Math.max(REFRESH_MIN_DELAY_MS, due));
    const timer = setTimeout(() => {
      refreshTimers.delete(id);
      void withLock(id, async () => {
        if (!clients.has(id)) return;
        const left = expiresAt(readOAuth(store, id));
        if (!attempt && left && left - Date.now() > REFRESH_AHEAD_MS) return scheduleRefresh(id);
        const result = await refresh(id);
        if (result.outcome === "refreshed") return scheduleRefresh(id);
        if (result.outcome === "retry") {
          // The current token still works until it expires; a 401 after that reconnects.
          log(id, `${result.detail}; trying again later`);
          return scheduleRefresh(id, attempt + 1);
        }
        log(id, `needs auth: ${result.detail}`);
        await disconnect(id);
        setStatus(id, "needs_auth", result.detail);
      });
    }, delay);
    timer.unref();
    refreshTimers.set(id, timer);
  }

  async function connectNow(id: string) {
    await disconnect(id);
    clearRetry(id, false);
    clearRefresh(id);
    const record = store.connectors.get(id);
    if (!record) return;
    if (!record.enabled) return setStatus(id, "disabled", null);
    if (record.auth === "oauth") {
      const oauth = readOAuth(store, id);
      if (!oauth.tokens) return setStatus(id, "needs_auth", oauth.state ? "Waiting for sign-in" : "Sign in to connect");
      const expiry = expiresAt(oauth);
      if (oauth.tokens.refresh_token && expiry && expiry - Date.now() < REFRESH_AHEAD_MS && !(await refreshForConnect(id))) return;
    }
    setStatus(id, "connecting", null);
    // A 401 with a refresh token on file: refresh once and connect again.
    for (let refreshed = false; ; refreshed = true) {
      const outcome = await openClient(record);
      if (outcome !== "unauthorized") return;
      if (refreshed || record.auth !== "oauth" || !readOAuth(store, id).tokens?.refresh_token) {
        const detail =
          record.auth === "oauth"
            ? "Sign in again to connect"
            : record.auth === "headers"
              ? "The server rejected the credentials (HTTP 401): check the header values"
              : "The server requires sign-in: use OAuth or add an authorization header";
        log(id, `needs auth: ${detail}`);
        return setStatus(id, "needs_auth", detail);
      }
      if (!(await refreshForConnect(id))) return;
    }
  }

  /** Connect and list tools; every failure but a 401 is reported here. */
  async function openClient(record: ConnectorRecord): Promise<"connected" | "unauthorized" | "failed"> {
    const id = record.id;
    let client: MCPClient | undefined;
    try {
      await assertTarget(new URL(record.url));
      const oauth = readOAuth(store, id);
      client = await createMCPClient({
        transport: {
          type: record.transport,
          url: record.url,
          headers: record.headers,
          redirect: "error",
          fetch: guardedFetch,
          ...(record.auth === "oauth"
            ? { authProvider: createOAuthProvider(store, id, { redirectUri: oauth.clientRedirectUri ?? defaultRedirectUri(), interactive: false }) }
            : {}),
          onSessionExpired: () => {
            log(id, "session expired; reconnecting");
            void sync(id);
          },
        },
        clientName: "z",
        version: pkg.version,
        // Plain `initialize` first: many deployed servers reject the newer `server/discover` probe.
        protocolVersionDiscovery: false,
        initializationOptions: { timeout: CONNECT_TIMEOUT },
        onUncaughtError: (error) => log(id, `transport error: ${redact(record, describeError(error))}`),
      });
      const tools = await listDefinitions(client);
      const cache: ConnectorCache = {
        server: { name: client.serverInfo.name, version: client.serverInfo.version },
        instructions: client.instructions?.trim() || null,
        tools,
      };
      store.connectors.setCache(id, cache);
      clients.set(id, client);
      clearRetry(id, true);
      setStatus(id, "connected", null);
      if (record.auth === "oauth") scheduleRefresh(id);
      log(id, `connected to ${cache.server?.name ?? "server"} (${tools.length} tools)`);
      return "connected";
    } catch (error) {
      await client?.close().catch(() => {});
      if (isUnauthorized(error)) return "unauthorized";
      const message = error instanceof ConnectorError ? error.message : redact(record, describeError(error));
      if (error instanceof ConnectorError) {
        setStatus(id, "error", message);
        return "failed";
      }
      const delay = scheduleRetry(id);
      log(id, `connect failed: ${message}; retrying in ${Math.round(delay / 1000)}s`);
      setStatus(id, "error", `${message} · retrying in ${Math.round(delay / 1000)}s`);
      return "failed";
    }
  }

  function withLock(id: string, work: () => Promise<void>): Promise<void> {
    const next = (locks.get(id) ?? Promise.resolve()).then(work);
    locks.set(id, next.catch(() => {}));
    return next;
  }

  /** Reconnect (or disconnect) to match the stored row. `manual` resets the backoff. */
  function sync(id: string, manual = true): Promise<void> {
    if (manual) clearRetry(id, true);
    return withLock(id, () => connectNow(id));
  }

  async function call(id: string, name: string, args: Record<string, unknown>, signal: AbortSignal, retried = false): Promise<McpCallResult> {
    const client = clients.get(id);
    if (!client) throw new Error("This connector is not connected right now");
    try {
      return (await client.callTool({ name, arguments: args, options: { signal, timeout: CALL_TIMEOUT } })) as McpCallResult;
    } catch (error) {
      const record = store.connectors.get(id);
      if (isUnauthorized(error)) {
        await disconnect(id);
        // A 401 means the call never ran, so after a refresh and reconnect it is safe to send once more.
        if (record?.auth === "oauth" && !retried && readOAuth(store, id).tokens?.refresh_token) {
          await sync(id);
          if (clients.has(id)) return call(id, name, args, signal, true);
        } else {
          setStatus(id, "needs_auth", record?.auth === "oauth" ? "Sign in again to connect" : "The server rejected the credentials (HTTP 401)");
        }
      }
      throw record ? new Error(redact(record, describeError(error))) : error;
    }
  }

  /**
   * The OAuth connector whose pending state matches; the state is consumed either way. With
   * `onlyId` (a pasted callback) only that connector's state counts, and a mismatch consumes nothing.
   */
  function takeState(state: string, onlyId?: string): { record: ConnectorRecord; redirectUri: string } | { error: string; id?: string } {
    const given = Buffer.from(state);
    for (const record of store.connectors.list()) {
      if (record.auth !== "oauth" || !record.hasOAuth || (onlyId && record.id !== onlyId)) continue;
      const oauth = readOAuth(store, record.id);
      const expected = oauth.state ? Buffer.from(oauth.state) : null;
      if (!expected || expected.length !== given.length || !timingSafeEqual(expected, given)) continue;
      writeOAuth(store, record.id, { state: undefined, stateExpiresAt: undefined });
      if (!oauth.stateExpiresAt || oauth.stateExpiresAt < Date.now() || !oauth.redirectUri) {
        return { error: "The sign-in expired. Start it again.", id: record.id };
      }
      return { record, redirectUri: oauth.redirectUri };
    }
    return onlyId
      ? { error: "That address doesn't match this connector's pending sign-in (wrong, old or already used state). Paste the address from the latest sign-in, or start again.", id: onlyId }
      : { error: "Unknown or already used sign-in. Start it again." };
  }

  /** Verify state, exchange the code, connect. Shared by the browser callback and the pasted URL. */
  async function finish(
    params: { code?: string; state?: string; error?: string; errorDescription?: string; iss?: string },
    onlyId?: string,
  ): Promise<{ id?: string; error?: string }> {
    if (!params.state) return { ...(onlyId ? { id: onlyId } : {}), error: "Missing state" };
    const taken = takeState(params.state, onlyId);
    if ("error" in taken) return taken;
    const { record, redirectUri } = taken;
    if (params.error || !params.code) {
      writeOAuth(store, record.id, { verifier: undefined, redirectUri: undefined });
      setStatus(record.id, "needs_auth", "Sign-in was cancelled");
      return { id: record.id, error: params.errorDescription || params.error || "Missing code" };
    }
    const provider = createOAuthProvider(store, record.id, { redirectUri, interactive: true });
    try {
      await auth(provider, { serverUrl: record.url, authorizationCode: params.code, callbackState: params.state, callbackIssuer: params.iss, fetchFn: guardedFetch });
    } catch (error) {
      const message = redact(record, describeError(error));
      log(record.id, `code exchange failed: ${message}`);
      setStatus(record.id, "needs_auth", `Sign-in failed: ${message}`);
      return { id: record.id, error: `Sign-in failed: ${message}` };
    } finally {
      writeOAuth(store, record.id, { verifier: undefined, redirectUri: undefined });
    }
    log(record.id, "signed in");
    await sync(record.id);
    return { id: record.id };
  }

  /** Where the browser is sent after approving. */
  function redirectUriFor(origin: string): string {
    if (env.publicUrl) return `${env.publicUrl}/oauth/callback`;
    const url = new URL(origin);
    // OAuth 2.1 servers accept plain http only for loopback. Reached over a LAN or Tailscale
    // address, ask for a loopback redirect instead: that page won't load on the owner's device,
    // and they paste its address into z (completeOAuth).
    if (url.protocol === "http:" && !LOOPBACK.has(url.hostname)) return `http://localhost:${env.port}/oauth/callback`;
    return `${url.origin}/oauth/callback`;
  }

  return {
    view,
    sync,
    get: (id: string) => store.connectors.get(id),
    list: () => store.connectors.list().map(view),
    syncAll: () => Promise.all(store.connectors.list().map((c) => sync(c.id))),
    assertTarget: (url: string) => assertTarget(new URL(url)),

    /** Connected connectors as plugins, built from the current row so risk overrides apply at once. */
    active(): ActivePlugin[] {
      return [...clients.keys()].flatMap((id) => {
        const record = store.connectors.get(id);
        if (!record?.enabled || record.status !== "connected" || !record.cache) return [];
        return [
          connectorPlugin({
            id,
            label: record.label,
            public: record.public,
            instructions: record.cache.instructions,
            definitions: record.cache.tools,
            tools: describeTools(id, record.cache.tools, record.risks),
            call: (name, args, signal) => call(id, name, args, signal),
          }),
        ];
      });
    },

    async remove(id: string): Promise<boolean> {
      await (locks.get(id) ?? Promise.resolve());
      clearRetry(id, true);
      clearRefresh(id);
      await disconnect(id);
      const record = store.connectors.get(id);
      const oauth = record?.auth === "oauth" && record.hasOAuth ? readOAuth(store, id) : null;
      // Deleting the row drops the sealed tokens and client registration with it.
      const deleted = store.connectors.delete(id);
      // Then tell the authorization server, without holding up the delete.
      if (deleted && record && oauth?.tokens) {
        void revokeOAuth(oauth, guardedFetch).then(
          (n) => log(id, n ? `revoked ${n} token(s) at the authorization server` : "the authorization server offers no token revocation"),
          (error) => log(id, `token revocation failed (ignored): ${redact(record, describeError(error))}`),
        );
      }
      return deleted;
    },

    /** Start OAuth: discovery, dynamic client registration, PKCE. Returns the authorization URL. */
    async startOAuth(id: string, origin: string): Promise<OAuthStart> {
      const record = store.connectors.get(id);
      if (!record) throw new ConnectorError("Connector not found");
      if (record.auth !== "oauth") throw new ConnectorError("This connector does not use OAuth");
      await assertTarget(new URL(record.url));
      clearRefresh(id);
      const redirectUri = redirectUriFor(origin);
      const current = readOAuth(store, id);
      // A new grant replaces the tokens; a registration made for another redirect URI can't be reused.
      const sameClient = current.clientRedirectUri === redirectUri;
      store.connectors.setOAuth(
        id,
        sameClient ? { client: current.client, dynamic: current.dynamic, clientRedirectUri: current.clientRedirectUri, server: current.server } : null,
      );
      let authorizationUrl: URL | null = null;
      const provider = createOAuthProvider(store, id, { redirectUri, interactive: true, onRedirect: (url) => (authorizationUrl = url) });
      try {
        const result = await auth(provider, { serverUrl: record.url, fetchFn: guardedFetch });
        if (result !== "REDIRECT" || !authorizationUrl) throw new Error("the server did not ask for a sign-in");
      } catch (error) {
        if (error instanceof ConnectorError) throw error;
        throw new Error(`OAuth sign-in could not start: ${redact(record, describeError(error))}`);
      }
      // Refreshes ask for the same resource (RFC 8707) the grant was requested for.
      const resource = (authorizationUrl as URL).searchParams.get("resource");
      if (resource) writeOAuth(store, id, { resource });
      await disconnect(id);
      setStatus(id, "needs_auth", "Waiting for sign-in");
      log(id, `sign-in started (redirect ${redirectUri})`);
      return { authorizationUrl: (authorizationUrl as URL).href, redirectUri };
    },

    /** `GET /oauth/callback`: verify state, exchange the code, connect. Returns the app path to redirect to. */
    async finishOAuth(params: { code?: string; state?: string; error?: string; errorDescription?: string; iss?: string }): Promise<string> {
      const { id, error } = await finish(params);
      return `/connect?${new URLSearchParams({ ...(id ? { connector: id } : {}), ...(error ? { error } : {}) })}`;
    },

    /**
     * The paste fallback: the address the browser ended on after approving, for installs the
     * provider can't redirect back to. Same checks as the callback; the state must be `id`'s.
     */
    async completeOAuth(id: string, pasted: string): Promise<ConnectorView> {
      let url: URL;
      try {
        url = new URL(pasted.trim());
      } catch {
        throw new ConnectorError("Paste the whole address from the browser's address bar, starting with http");
      }
      const q = url.searchParams;
      if (!q.get("state")) throw new ConnectorError("That address has no state parameter: copy the whole address of the page the service sent you to");
      if (!q.get("code") && !q.get("error")) {
        throw new ConnectorError("That address has no code: approve the sign-in first, then copy the address of the page you land on");
      }
      const result = await finish(
        {
          code: q.get("code") ?? undefined,
          state: q.get("state") ?? undefined,
          error: q.get("error") ?? undefined,
          errorDescription: q.get("error_description") ?? undefined,
          iss: q.get("iss") ?? undefined,
        },
        id,
      );
      if (result.error) throw new ConnectorError(result.error);
      const record = store.connectors.get(id);
      if (!record) throw new ConnectorError("Connector not found");
      return view(record);
    },

    async stopAll() {
      for (const id of retries.keys()) clearRetry(id, true);
      for (const id of [...refreshTimers.keys()]) clearRefresh(id);
      await Promise.all([...clients.keys()].map(disconnect));
    },
  };
}
