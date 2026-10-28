/**
 * OAuth hygiene for MCP connectors: the refresh outcome table, revocation on delete, and the
 * pasted-callback state checks. A local HTTP server plays the MCP server's authorization server.
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { after, afterEach, before, test } from "node:test";
import { createBus } from "../src/bus.ts";
import { ConnectorError, createConnectors } from "../src/connectors.ts";
import { createSealer } from "../src/crypto.ts";
import { openDatabase } from "../src/db.ts";
import { loadEnv } from "../src/env.ts";
import { readOAuth, refreshOAuth, writeOAuth, type OAuthState } from "../src/oauth.ts";
import { createStore } from "../src/store.ts";
import { cleanup, tempDir } from "./harness.ts";

const PORT = 9043;
const BASE = `http://127.0.0.1:${PORT}`;

type Seen = { method: string; path: string; headers: IncomingMessage["headers"]; body: URLSearchParams };
type Reply = { status: number; body?: unknown; raw?: string } | "hang";

/** The fixture authorization server: RFC 9728/8414 metadata, registration, a scriptable token and revocation endpoint. */
const fixture = {
  seen: [] as Seen[],
  token: [] as Reply[],
  revoke: [] as Reply[],
  hanging: [] as ServerResponse[],
};
let server: Server;

function send(res: ServerResponse, reply: Reply) {
  if (reply === "hang") return void fixture.hanging.push(res);
  res.writeHead(reply.status, { "content-type": "application/json" });
  res.end(reply.raw ?? JSON.stringify(reply.body ?? {}));
}

before(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    const path = new URL(req.url ?? "/", BASE).pathname;
    fixture.seen.push({ method: req.method ?? "GET", path, headers: req.headers, body: new URLSearchParams(text) });
    if (path.startsWith("/.well-known/oauth-protected-resource")) {
      return send(res, { status: 200, body: { resource: `${BASE}/mcp`, authorization_servers: [BASE] } });
    }
    if (path === "/.well-known/oauth-authorization-server") {
      return send(res, {
        status: 200,
        body: {
          issuer: BASE,
          authorization_endpoint: `${BASE}/authorize`,
          token_endpoint: `${BASE}/token`,
          registration_endpoint: `${BASE}/register`,
          revocation_endpoint: `${BASE}/revoke`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        },
      });
    }
    if (path === "/register") return send(res, { status: 201, body: { ...JSON.parse(text), client_id: "registered-client" } });
    if (path === "/token") return send(res, fixture.token.shift() ?? { status: 500, body: { error: "server_error" } });
    if (path === "/revoke") return send(res, fixture.revoke.shift() ?? { status: 200 });
    send(res, { status: 404, body: { error: "not_found" } });
  });
  await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve));
});

after(async () => {
  for (const res of fixture.hanging.splice(0)) res.destroy();
  await new Promise((resolve) => server.close(resolve));
});

const dirs: string[] = [];
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  for (const d of dirs.splice(0)) cleanup(d);
  fixture.seen.length = 0;
  fixture.token.length = 0;
  fixture.revoke.length = 0;
  for (const res of fixture.hanging.splice(0)) res.destroy();
});

function setup() {
  const dir = tempDir();
  dirs.push(dir);
  process.env.Z_DATA_DIR = dir;
  process.env.Z_ALLOW_PRIVATE_MCP = "1";
  process.env.PORT = String(PORT);
  const env = loadEnv();
  const store = createStore(openDatabase(env.dataDir), createSealer(env.masterKey));
  const connectors = createConnectors(env, store, createBus());
  stops.push(() => connectors.stopAll());
  return { store, connectors };
}

function addConnector(store: ReturnType<typeof setup>["store"], id: string, oauth?: OAuthState) {
  store.connectors.upsert({ id, label: id, url: `${BASE}/mcp`, transport: "http", auth: "oauth", headers: {}, enabled: true, public: false, risks: {} });
  if (oauth) store.connectors.setOAuth(id, oauth);
}

/** A signed-in connector whose access token is about to expire. */
const signedIn = (overrides: Partial<OAuthState> = {}): OAuthState => ({
  tokens: {
    access_token: "access-1",
    refresh_token: "refresh-1",
    token_type: "Bearer",
    expires_in: 3600,
    issuer: BASE,
    authorization_server: BASE,
    token_endpoint: `${BASE}/token`,
  },
  tokensSavedAt: Date.now() - 3590_000,
  client: { client_id: "registered-client" },
  dynamic: true,
  clientRedirectUri: `http://localhost:${PORT}/oauth/callback`,
  server: { issuer: BASE, authorizationServerUrl: BASE, tokenEndpoint: `${BASE}/token` },
  resource: `${BASE}/mcp`,
  ...overrides,
});

const tokenRequests = () => fixture.seen.filter((s) => s.path === "/token");

// ─── Refresh outcome table ───────────────────────────────────────────────────

test("refresh: 200 stores the new access token, keeps an unrotated refresh token and the AS pin", async () => {
  const { store } = setup();
  addConnector(store, "c", signedIn());
  fixture.token.push({ status: 200, body: { access_token: "access-2", token_type: "Bearer", expires_in: 7200 } });
  assert.deepEqual(await refreshOAuth(store, "c", fetch), { outcome: "refreshed" });
  const [req] = tokenRequests();
  assert.equal(req?.body.get("grant_type"), "refresh_token");
  assert.equal(req?.body.get("refresh_token"), "refresh-1");
  assert.equal(req?.body.get("client_id"), "registered-client");
  assert.equal(req?.body.get("resource"), `${BASE}/mcp`);
  const state = readOAuth(store, "c");
  assert.equal(state.tokens?.access_token, "access-2");
  assert.equal(state.tokens?.refresh_token, "refresh-1");
  assert.equal(state.tokens?.token_endpoint, `${BASE}/token`);
  assert.equal(state.tokens?.authorization_server, BASE);
  assert.ok(state.tokensSavedAt && Date.now() - state.tokensSavedAt < 5000);
});

test("refresh: a rotated refresh token replaces the old one", async () => {
  const { store } = setup();
  addConnector(store, "c", signedIn());
  fixture.token.push({ status: 200, body: { access_token: "access-2", refresh_token: "refresh-2", token_type: "Bearer" } });
  assert.equal((await refreshOAuth(store, "c", fetch)).outcome, "refreshed");
  assert.equal(readOAuth(store, "c").tokens?.refresh_token, "refresh-2");
});

test("refresh: invalid_grant drops the tokens and keeps the client registration", async () => {
  const { store } = setup();
  addConnector(store, "c", signedIn());
  fixture.token.push({ status: 400, body: { error: "invalid_grant", error_description: "refresh token revoked" } });
  const result = await refreshOAuth(store, "c", fetch);
  assert.equal(result.outcome, "needs_auth");
  assert.equal(result.outcome === "needs_auth" && result.dropped, "tokens");
  assert.match(result.outcome === "needs_auth" ? result.detail : "", /invalid_grant: refresh token revoked/);
  const state = readOAuth(store, "c");
  assert.equal(state.tokens, undefined);
  assert.equal(state.client?.client_id, "registered-client");
});

test("refresh: invalid_client (and a bare 401) drop the client registration too", async () => {
  for (const reply of [
    { status: 401, body: { error: "invalid_client" } },
    { status: 400, body: { error: "unauthorized_client" } },
    { status: 401, raw: "nope" },
  ]) {
    const { store } = setup();
    addConnector(store, "c", signedIn());
    fixture.token.push(reply);
    const result = await refreshOAuth(store, "c", fetch);
    assert.equal(result.outcome === "needs_auth" && result.dropped, "client", JSON.stringify(reply));
    const state = readOAuth(store, "c");
    assert.equal(state.tokens, undefined);
    assert.equal(state.client, undefined);
    assert.equal(state.dynamic, undefined);
  }
});

test("refresh: 5xx, 429, garbage and an unreachable server keep everything and say retry", async () => {
  for (const reply of [{ status: 503, raw: "down" }, { status: 502, body: { error: "server_error" } }, { status: 429, raw: "" }, { status: 200, raw: "<html>" }, { status: 404, raw: "gone" }]) {
    const { store } = setup();
    addConnector(store, "c", signedIn());
    fixture.token.push(reply);
    const result = await refreshOAuth(store, "c", fetch);
    assert.equal(result.outcome, "retry", JSON.stringify(reply));
    assert.deepEqual(readOAuth(store, "c").tokens, signedIn().tokens);
  }
  const { store } = setup();
  addConnector(store, "c", signedIn({ tokens: { ...signedIn().tokens!, token_endpoint: "http://127.0.0.1:9044/token" } }));
  const result = await refreshOAuth(store, "c", fetch);
  assert.equal(result.outcome, "retry");
  assert.match(result.outcome === "retry" ? result.detail : "", /unreachable/);
  assert.equal(readOAuth(store, "c").tokens?.refresh_token, "refresh-1");
});

test("refresh: a hanging token endpoint times out as retry", async () => {
  const { store } = setup();
  addConnector(store, "c", signedIn());
  fixture.token.push("hang");
  const result = await refreshOAuth(store, "c", fetch, 300);
  assert.equal(result.outcome, "retry");
  assert.match(result.outcome === "retry" ? result.detail : "", /in time/);
});

test("refresh: no refresh token → needs_auth without touching the row", async () => {
  const { store } = setup();
  const { refresh_token: _, ...tokens } = signedIn().tokens!;
  addConnector(store, "c", signedIn({ tokens }));
  const result = await refreshOAuth(store, "c", fetch);
  assert.equal(result.outcome === "needs_auth" && result.dropped, "nothing");
  assert.equal(tokenRequests().length, 0);
  assert.equal(readOAuth(store, "c").tokens?.access_token, "access-1");
});

test("connect: an expiring token is refreshed first; a down server is retried with tokens kept", async () => {
  const { store, connectors } = setup();
  addConnector(store, "c", signedIn());
  fixture.token.push({ status: 503, raw: "down" });
  await connectors.sync("c");
  const record = connectors.get("c")!;
  assert.equal(record.status, "error");
  assert.match(record.statusDetail ?? "", /Could not refresh the sign-in.*retrying in \d+s/);
  assert.equal(readOAuth(store, "c").tokens?.refresh_token, "refresh-1");
});

test("connect: invalid_grant on the pre-connect refresh → needs_auth with a clear message", async () => {
  const { store, connectors } = setup();
  addConnector(store, "c", signedIn());
  fixture.token.push({ status: 400, body: { error: "invalid_grant" } });
  await connectors.sync("c");
  const record = connectors.get("c")!;
  assert.equal(record.status, "needs_auth");
  assert.match(record.statusDetail ?? "", /expired or was revoked.*Sign in again/);
  assert.equal(connectors.view(record).oauth, null);
});

// ─── Revocation on delete ────────────────────────────────────────────────────

test("delete: revokes refresh then access token at the revocation endpoint", async () => {
  const { store, connectors } = setup();
  addConnector(store, "c", signedIn());
  assert.equal(await connectors.remove("c"), true);
  assert.ok(!connectors.get("c"));
  const deadline = Date.now() + 3000;
  while (fixture.seen.filter((s) => s.path === "/revoke").length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  const revokes = fixture.seen.filter((s) => s.path === "/revoke");
  assert.deepEqual(
    revokes.map((r) => [r.body.get("token"), r.body.get("token_type_hint"), r.body.get("client_id")]),
    [
      ["refresh-1", "refresh_token", "registered-client"],
      ["access-1", "access_token", "registered-client"],
    ],
  );
});

test("delete: a hanging revocation endpoint never holds up the delete", async () => {
  const { store, connectors } = setup();
  addConnector(store, "c", signedIn());
  fixture.revoke.push("hang");
  const started = Date.now();
  assert.equal(await connectors.remove("c"), true);
  assert.ok(Date.now() - started < 1000, "delete returned promptly");
  assert.ok(!connectors.get("c"));
  // The revocation really was left hanging in the background.
  const deadline = Date.now() + 3000;
  while (!fixture.hanging.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.equal(fixture.hanging.length, 1);
});

// ─── Pasted callback ─────────────────────────────────────────────────────────

async function startSignIn(connectors: ReturnType<typeof setup>["connectors"], id: string) {
  const start = await connectors.startOAuth(id, `http://localhost:${PORT}`);
  const authorize = new URL(start.authorizationUrl);
  return { ...start, state: authorize.searchParams.get("state")! };
}

test("paste: the real state with a bogus code reaches the token endpoint, fails clearly, and is single use", async () => {
  const { store, connectors } = setup();
  addConnector(store, "c");
  const { state, redirectUri } = await startSignIn(connectors, "c");
  assert.equal(redirectUri, `http://localhost:${PORT}/oauth/callback`);
  assert.equal(connectors.view(connectors.get("c")!).signInPending, true);
  assert.equal(readOAuth(store, "c").resource, `${BASE}/mcp`);

  fixture.token.push({ status: 400, body: { error: "invalid_grant", error_description: "authorization code is invalid" } });
  const pasted = `${redirectUri}?code=bogus&state=${state}`;
  await assert.rejects(connectors.completeOAuth("c", pasted), (e: Error) => e instanceof ConnectorError && /Sign-in failed: .*authorization code is invalid/.test(e.message));
  const [exchange] = tokenRequests();
  assert.equal(exchange?.body.get("grant_type"), "authorization_code");
  assert.equal(exchange?.body.get("code"), "bogus");
  assert.equal(exchange?.body.get("redirect_uri"), redirectUri);
  const record = connectors.get("c")!;
  assert.equal(record.status, "needs_auth");
  assert.match(record.statusDetail ?? "", /Sign-in failed/);
  assert.equal(connectors.view(record).signInPending, false);

  await assert.rejects(connectors.completeOAuth("c", pasted), /already used/);
  assert.equal(tokenRequests().length, 1, "a used state never reaches the token endpoint again");
});

test("paste: a wrong state is rejected locally and leaves the pending sign-in usable", async () => {
  const { store, connectors } = setup();
  addConnector(store, "c");
  const { state, redirectUri } = await startSignIn(connectors, "c");
  await assert.rejects(connectors.completeOAuth("c", `${redirectUri}?code=x&state=not-${state}`), /doesn't match this connector's pending sign-in/);
  assert.equal(tokenRequests().length, 0);
  assert.equal(readOAuth(store, "c").state, state);
  assert.equal(connectors.view(connectors.get("c")!).signInPending, true);
});

test("paste: addresses without a code or state, or that aren't URLs, are refused before any state check", async () => {
  const { store, connectors } = setup();
  addConnector(store, "c");
  const { state, authorizationUrl } = await startSignIn(connectors, "c");
  await assert.rejects(connectors.completeOAuth("c", "code=x"), /whole address/);
  await assert.rejects(connectors.completeOAuth("c", `http://localhost:${PORT}/oauth/callback?code=x`), /no state/);
  // The authorization URL itself carries the state but no code: it must not consume the sign-in.
  await assert.rejects(connectors.completeOAuth("c", authorizationUrl), /no code/);
  assert.equal(readOAuth(store, "c").state, state);
});

test("paste: another connector's state doesn't complete this one, nor get consumed", async () => {
  const { store, connectors } = setup();
  addConnector(store, "a");
  addConnector(store, "b");
  const a = await startSignIn(connectors, "a");
  await startSignIn(connectors, "b");
  await assert.rejects(connectors.completeOAuth("b", `${a.redirectUri}?code=x&state=${a.state}`), /doesn't match this connector's pending sign-in/);
  assert.equal(readOAuth(store, "a").state, a.state);
  assert.equal(tokenRequests().length, 0);
});

test("paste: an expired state is refused and consumed", async () => {
  const { store, connectors } = setup();
  addConnector(store, "c");
  const { state, redirectUri } = await startSignIn(connectors, "c");
  writeOAuth(store, "c", { stateExpiresAt: Date.now() - 1 });
  await assert.rejects(connectors.completeOAuth("c", `${redirectUri}?code=x&state=${state}`), /expired/);
  assert.equal(readOAuth(store, "c").state, undefined);
  assert.equal(tokenRequests().length, 0);
});

test("paste: the provider's error in the pasted address cancels the sign-in", async () => {
  const { store, connectors } = setup();
  addConnector(store, "c");
  const { state, redirectUri } = await startSignIn(connectors, "c");
  await assert.rejects(connectors.completeOAuth("c", `${redirectUri}?error=access_denied&error_description=User+said+no&state=${state}`), /User said no/);
  assert.equal(connectors.get("c")!.statusDetail, "Sign-in was cancelled");
});
