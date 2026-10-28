/** X adapter: OAuth2 user-token renewal with a refresh token, against a scripted X API. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChannelRuntime } from "@z/core";
import { xApi, xAuth } from "../../../packages/plugins/src/channels/x.ts";

type Call = { url: string; auth: string | null; body: URLSearchParams | null };

/** A runtime whose fetch answers like X: `/oauth2/token` from `tokens`, the API by bearer token. */
function runtime(config: Record<string, string>, tokens: Response[], valid: Set<string>) {
  const calls: Call[] = [];
  const state = new Map<string, string>();
  const logs: string[] = [];
  const rt = {
    channel: { id: "x1", kind: "x", label: "X", enabled: true, config, always: false, lane: "bot", limits: {} },
    state: { get: (k: string) => state.get(k) ?? null, set: (k: string, v: string) => void state.set(k, v) },
    log: (text: string) => void logs.push(text),
    status: () => {},
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({ url, auth: headers.get("authorization"), body: init?.body instanceof URLSearchParams ? init.body : null });
      if (url.endsWith("/oauth2/token")) return tokens.shift() ?? new Response("{}", { status: 500 });
      const bearer = headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      return valid.has(bearer)
        ? Response.json({ data: { id: "1", username: "zbot", name: "z" } })
        : Response.json({ title: "Unauthorized", detail: "Unauthorized" }, { status: 401 });
    }) as typeof fetch,
  } as unknown as ChannelRuntime;
  return { rt, calls, state, logs };
}

const token = (body: Record<string, unknown>, status = 200) => Response.json(body, { status });

test("x: a 401 renews the access token with the refresh token, stores the rotated pair, and retries once", async () => {
  const { rt, calls, state, logs } = runtime(
    { bearerToken: "old-access", refreshToken: "seed-refresh", clientId: "client-1" },
    [token({ access_token: "new-access", refresh_token: "rotated-refresh", expires_in: 7200, token_type: "bearer" })],
    new Set(["new-access"]),
  );
  const { data } = await xApi<{ data: { username: string } }>(rt, "/users/me");
  assert.equal(data.data.username, "zbot");
  assert.deepEqual(
    calls.map((c) => [c.url.replace("https://api.x.com/2", ""), c.auth]),
    [
      ["/users/me", "Bearer old-access"],
      ["/oauth2/token", null],
      ["/users/me", "Bearer new-access"],
    ],
  );
  const refresh = calls[1]!.body!;
  assert.equal(refresh.get("grant_type"), "refresh_token");
  assert.equal(refresh.get("refresh_token"), "seed-refresh");
  assert.equal(refresh.get("client_id"), "client-1");
  assert.equal(state.get("oauth:refresh"), "rotated-refresh");
  assert.ok(Number(state.get("oauth:expiresAt")) > Date.now() + 7000_000);
  assert.ok(logs.every((l) => !/access|refresh-/.test(l.replace("access token renewed", ""))), "no token values in logs");
});

test("x: renews ahead of expiry, sends the rotated refresh token, and authenticates confidential clients with Basic", async () => {
  const { rt, calls, state } = runtime(
    { refreshToken: "seed-refresh", clientId: "client-1", clientSecret: "s3cret" },
    [
      token({ access_token: "a1", refresh_token: "r1", expires_in: 60 }),
      token({ access_token: "a2", refresh_token: "r2", expires_in: 7200 }),
    ],
    new Set(["a1", "a2"]),
  );
  assert.equal(await xAuth(rt).token(), "a1"); // no access token yet: refresh first
  assert.equal(await xAuth(rt).token(), "a2"); // a1 expires within the margin
  const [first, second] = calls.filter((c) => c.url.endsWith("/oauth2/token"));
  assert.equal(first!.body!.get("refresh_token"), "seed-refresh");
  assert.equal(second!.body!.get("refresh_token"), "r1");
  assert.equal(first!.auth, `Basic ${Buffer.from("client-1:s3cret").toString("base64")}`);
  assert.equal(state.get("oauth:refresh"), "r2");
});

test("x: a rejected refresh token is a clear 401 without token values; X being down is retryable", async () => {
  const dead = runtime(
    { bearerToken: "old-access", refreshToken: "seed-refresh", clientId: "client-1" },
    [token({ error: "invalid_request", error_description: "Value passed for the token was invalid." }, 400)],
    new Set(),
  );
  await assert.rejects(xApi(dead.rt, "/users/me"), (e: Error & { status?: number }) => {
    assert.equal(e.status, 401);
    assert.match(e.message, /X rejected the refresh token \(invalid_request: Value passed for the token was invalid\.\)/);
    assert.doesNotMatch(e.message, /seed-refresh|old-access/);
    return true;
  });

  const down = runtime({ bearerToken: "old-access", refreshToken: "seed-refresh", clientId: "client-1" }, [new Response("oops", { status: 503 })], new Set());
  await assert.rejects(xApi(down.rt, "/users/me"), (e: Error & { status?: number }) => e.status === 503 && /retrying/.test(e.message));
  assert.equal(down.state.get("oauth:refresh"), "", "the stored refresh token is untouched");
});

test("x: a new refresh token in the settings starts over from it", async () => {
  const shared = runtime({ refreshToken: "seed-1", clientId: "client-1" }, [token({ access_token: "a1", refresh_token: "r1" })], new Set(["a1"]));
  await xAuth(shared.rt).token();
  assert.equal(shared.state.get("oauth:refresh"), "r1");
  // Same stored state, a fresh runtime with a different configured refresh token (the owner pasted a new one).
  const next = { ...shared.rt, channel: { ...shared.rt.channel, config: { refreshToken: "seed-2", clientId: "client-1" } } } as ChannelRuntime;
  assert.equal(next.state.get("oauth:refresh"), "r1");
  xAuth(next);
  assert.equal(shared.state.get("oauth:refresh"), "");
  assert.equal(shared.state.get("oauth:access"), "");
});

test("x: without a refresh token the 401 says how to renew", async () => {
  const { rt, calls } = runtime({ bearerToken: "expired" }, [], new Set());
  await assert.rejects(xApi(rt, "/users/me"), /expire after 2 hours.*add a refresh token and client id/);
  assert.equal(calls.length, 1, "no refresh attempted");
});
