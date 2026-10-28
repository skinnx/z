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
} from "@z/core";
import { resolvePublicHost } from "@z/plugins";
import pkg from "../package.json" with { type: "json" };
import type { Bus } from "./bus.ts";
import type { Env } from "./env.ts";
import { createOAuthProvider, NeedsAuthError, readOAuth, writeOAuth } from "./oauth.ts";
import type { ConnectorCache, ConnectorRecord, Store } from "./store.ts";

const CONNECT_TIMEOUT = 15_000;
const LIST_TIMEOUT = 15_000;
const CALL_TIMEOUT = 120_000;
const MAX_TOOL_PAGES = 20;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 10 * 60_000;

export type Connectors = ReturnType<typeof createConnectors>;

/** Thrown for problems the owner can fix (bad URL, private address, not an OAuth connector). */
export class ConnectorError extends Error {}

export function createConnectors(env: Env, store: Store, bus: Bus) {
  const clients = new Map<string, MCPClient>();
  const retries = new Map<string, { timer: NodeJS.Timeout | null; attempt: number }>();
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
            expiresAt: tokens.expires_in && oauth.tokensSavedAt ? new Date(oauth.tokensSavedAt + tokens.expires_in * 1000).toISOString() : null,
          }
        : null,
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

  async function connectNow(id: string) {
    await disconnect(id);
    clearRetry(id, false);
    const record = store.connectors.get(id);
    if (!record) return;
    if (!record.enabled) return setStatus(id, "disabled", null);
    if (record.auth === "oauth" && !readOAuth(store, id).tokens) return setStatus(id, "needs_auth", "Sign in to connect");
    setStatus(id, "connecting", null);

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
      log(id, `connected to ${cache.server?.name ?? "server"} (${tools.length} tools)`);
    } catch (error) {
      await client?.close().catch(() => {});
      if (isUnauthorized(error)) {
        const detail =
          record.auth === "oauth"
            ? "Sign in again to connect"
            : record.auth === "headers"
              ? "The server rejected the credentials (HTTP 401): check the header values"
              : "The server requires sign-in: use OAuth or add an authorization header";
        log(id, `needs auth: ${detail}`);
        return setStatus(id, "needs_auth", detail);
      }
      const message = error instanceof ConnectorError ? error.message : redact(record, describeError(error));
      if (error instanceof ConnectorError) return setStatus(id, "error", message);
      const delay = scheduleRetry(id);
      log(id, `connect failed: ${message}; retrying in ${Math.round(delay / 1000)}s`);
      setStatus(id, "error", `${message} · retrying in ${Math.round(delay / 1000)}s`);
    }
  }

  /** Reconnect (or disconnect) to match the stored row. `manual` resets the backoff. */
  function sync(id: string, manual = true): Promise<void> {
    if (manual) clearRetry(id, true);
    const next = (locks.get(id) ?? Promise.resolve()).then(() => connectNow(id));
    locks.set(id, next.catch(() => {}));
    return next;
  }

  async function call(id: string, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<McpCallResult> {
    const client = clients.get(id);
    if (!client) throw new Error("This connector is not connected right now");
    try {
      return (await client.callTool({ name, arguments: args, options: { signal, timeout: CALL_TIMEOUT } })) as McpCallResult;
    } catch (error) {
      const record = store.connectors.get(id);
      if (isUnauthorized(error)) {
        await disconnect(id);
        setStatus(id, "needs_auth", record?.auth === "oauth" ? "Sign in again to connect" : "The server rejected the credentials (HTTP 401)");
      }
      throw record ? new Error(redact(record, describeError(error))) : error;
    }
  }

  /** The OAuth connector whose pending state matches; the state is consumed either way. */
  function takeState(state: string): { record: ConnectorRecord; redirectUri: string } | { error: string; id?: string } {
    const given = Buffer.from(state);
    for (const record of store.connectors.list()) {
      if (record.auth !== "oauth" || !record.hasOAuth) continue;
      const oauth = readOAuth(store, record.id);
      const expected = oauth.state ? Buffer.from(oauth.state) : null;
      if (!expected || expected.length !== given.length || !timingSafeEqual(expected, given)) continue;
      writeOAuth(store, record.id, { state: undefined, stateExpiresAt: undefined });
      if (!oauth.stateExpiresAt || oauth.stateExpiresAt < Date.now() || !oauth.redirectUri) {
        return { error: "The sign-in expired. Start it again.", id: record.id };
      }
      return { record, redirectUri: oauth.redirectUri };
    }
    return { error: "Unknown or already used sign-in. Start it again." };
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
      await disconnect(id);
      // Deleting the row drops the sealed tokens and client registration with it.
      return store.connectors.delete(id);
    },

    /** Start OAuth: discovery, dynamic client registration, PKCE. Returns the authorization URL. */
    async startOAuth(id: string, origin: string): Promise<string> {
      const record = store.connectors.get(id);
      if (!record) throw new ConnectorError("Connector not found");
      if (record.auth !== "oauth") throw new ConnectorError("This connector does not use OAuth");
      await assertTarget(new URL(record.url));
      const redirectUri = `${env.publicUrl ?? origin}/oauth/callback`;
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
      await disconnect(id);
      setStatus(id, "needs_auth", "Waiting for sign-in");
      log(id, `sign-in started (redirect ${redirectUri})`);
      return (authorizationUrl as URL).href;
    },

    /** `GET /oauth/callback`: verify state, exchange the code, connect. Returns the app path to redirect to. */
    async finishOAuth(params: { code?: string; state?: string; error?: string; errorDescription?: string; iss?: string }): Promise<string> {
      const back = (id: string | undefined, error?: string) => {
        const query = new URLSearchParams({ ...(id ? { connector: id } : {}), ...(error ? { error } : {}) });
        return `/connect?${query}`;
      };
      if (!params.state) return back(undefined, "Missing state");
      const taken = takeState(params.state);
      if ("error" in taken) return back(taken.id, taken.error);
      const { record, redirectUri } = taken;
      if (params.error || !params.code) {
        writeOAuth(store, record.id, { verifier: undefined, redirectUri: undefined });
        setStatus(record.id, "needs_auth", "Sign-in was cancelled");
        return back(record.id, params.errorDescription || params.error || "Missing code");
      }
      const provider = createOAuthProvider(store, record.id, { redirectUri, interactive: true });
      try {
        await auth(provider, { serverUrl: record.url, authorizationCode: params.code, callbackState: params.state, callbackIssuer: params.iss, fetchFn: guardedFetch });
      } catch (error) {
        const message = redact(record, describeError(error));
        log(record.id, `code exchange failed: ${message}`);
        setStatus(record.id, "needs_auth", `Sign-in failed: ${message}`);
        return back(record.id, `Sign-in failed: ${message}`);
      } finally {
        writeOAuth(store, record.id, { verifier: undefined, redirectUri: undefined });
      }
      log(record.id, "signed in");
      await sync(record.id);
      return back(record.id);
    },

    async stopAll() {
      for (const id of retries.keys()) clearRetry(id, true);
      await Promise.all([...clients.keys()].map(disconnect));
    },
  };
}
