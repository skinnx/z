import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { Diagnostics, SetupChecklist, SetupRow } from "@z/core";
import { Hono } from "hono";
import type { Services } from "../src/app.ts";
import { createBriefings } from "../src/briefings.ts";
import { createBus } from "../src/bus.ts";
import { createChannels } from "../src/channels.ts";
import { createConnectors } from "../src/connectors.ts";
import { createSealer } from "../src/crypto.ts";
import { openDatabase } from "../src/db.ts";
import { loadEnv } from "../src/env.ts";
import { createPairing } from "../src/owner.ts";
import { createPluginRegistry } from "../src/plugins.ts";
import { createPush } from "../src/push.ts";
import { configRoutes } from "../src/routes/config.ts";
import { setupRoutes } from "../src/routes/setup.ts";
import { createRuntime } from "../src/runtime.ts";
import { redact, registerSecret } from "../src/secrets.ts";
import { createSetup } from "../src/setup.ts";
import { createStore } from "../src/store.ts";
import { createTasks } from "../src/tasks.ts";
import { cleanup, tempDir } from "./harness.ts";

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) cleanup(d);
  for (const name of ["Z_TOKEN", "Z_HOST", "Z_PUBLIC_URL"]) delete process.env[name];
});

/** The real server pieces over a temp data dir, with the setup and config routes mounted. */
function boot(envVars: Record<string, string> = {}) {
  const dir = tempDir();
  dirs.push(dir);
  process.env.Z_DATA_DIR = dir;
  for (const name of ["Z_TOKEN", "Z_HOST", "Z_PUBLIC_URL"]) delete process.env[name];
  Object.assign(process.env, envVars);
  const env = loadEnv();
  const store = createStore(openDatabase(env.dataDir), createSealer(env.masterKey));
  const bus = createBus();
  const connectors = createConnectors(env, store, bus);
  const rt = createRuntime(env, store, createPluginRegistry([], store), bus, connectors);
  const tasks = createTasks(rt);
  const pairing = createPairing();
  const push = createPush(rt);
  const channels = createChannels(rt, tasks, pairing);
  const setup = createSetup(rt, channels, connectors, push);
  const services: Services = { rt, tasks, briefings: createBriefings(rt), channels, push, pairing, connectors, setup };
  const app = new Hono();
  app.route("/api", configRoutes(services));
  app.route("/api", setupRoutes(services));
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`/api${path}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    });
    return { status: res.status, text: await res.text() };
  };
  return { dir, env, store, call };
}

/** A local OpenAI-compatible endpoint answering with `reply(authorization)`. */
async function fakeProvider(reply: (key: string) => { status: number; body: unknown; headers?: Record<string, string> }) {
  let calls = 0;
  const server = createServer((req, res) => {
    calls++;
    const key = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    req.resume();
    req.on("end", () => {
      const r = reply(key);
      res.writeHead(r.status, { "content-type": "application/json", ...r.headers });
      res.end(JSON.stringify(r.body));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { baseURL: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, calls: () => calls };
}

const pong = () => ({
  status: 200,
  body: {
    id: "c1",
    object: "chat.completion",
    created: 1,
    model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
  },
});
const badKey = (key: string) => ({ status: 401, body: { error: { message: `Incorrect API key provided: ${key}`, type: "invalid_request_error" } } });

const row = (list: SetupChecklist, id: string): SetupRow => {
  const r = list.rows.find((x) => x.id === id);
  assert.ok(r, `row ${id}`);
  return r;
};

async function addProvider(z: ReturnType<typeof boot>, baseURL: string, apiKey: string) {
  assert.equal((await z.call("PUT", "/providers/p1", { kind: "openai-compatible", label: "P1", baseURL, apiKey, models: ["m"] })).status, 200);
  assert.equal((await z.call("PUT", "/routing", { chat: ["p1:m"], agent: ["p1:m"], briefing: ["p1:m"] })).status, 200);
}

test("redaction: a provider key quoted back in an error never reaches stdout or stderr", () => {
  const dir = tempDir();
  dirs.push(dir);
  const key = "sk-proj-LEAKTEST-0123456789abcdefWXYZ";
  const child = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", join(import.meta.dirname, "fixtures/leak.ts"), dir, key], {
    encoding: "utf8",
    timeout: 30_000,
  });
  const output = child.stdout + child.stderr;
  assert.equal(child.status, 1, output); // the crash at the end
  assert.ok(output.includes("Incorrect API key provided"), output);
  assert.ok(output.includes("crash while using"), output);
  assert.ok(!output.includes(key), output);
  assert.ok(!output.includes("LEAKTEST-0123"), output);
  assert.ok(output.includes("[secret:WXYZ]"), output);
});

test("redaction: registered values in any of their encodings, longest first", () => {
  registerSecret("Bearer tok_abcdefghijklmnop");
  registerSecret("p@ss word/with?specials");
  assert.equal(redact("auth=Bearer tok_abcdefghijklmnop"), "auth=[secret:mnop]");
  assert.equal(redact("token tok_abcdefghijklmnop leaked"), "token [secret:mnop] leaked");
  assert.equal(redact(`url ?pw=${encodeURIComponent("p@ss word/with?specials")}`), "url ?pw=[secret:ials]");
  assert.equal(redact("short on"), "short on");
});

test("setup: a fresh install is honest about what is missing", async () => {
  const z = boot();
  const list = JSON.parse((await z.call("GET", "/setup")).text) as SetupChecklist;
  assert.equal(list.checkedAt, null);
  assert.equal(list.rows[0]!.id, "chat_model");
  assert.equal(row(list, "chat_model").state, "needs_setup");
  assert.deepEqual(row(list, "chat_model").fix, { label: "Add a provider", path: "/models" });
  assert.equal(row(list, "lanes").state, "needs_setup");
  // Loopback by default: no token needed.
  assert.equal(row(list, "token").state, "ready");
  assert.equal(row(list, "public_url").state, "optional");
  assert.equal(row(list, "push").state, "needs_setup");
  assert.equal(row(list, "owner").state, "optional");
  const master = row(list, "master_key");
  assert.equal(master.state, "needs_setup");
  assert.equal(master.ack, "I backed it up");

  const acked = JSON.parse((await z.call("POST", "/setup/master_key/ack")).text) as SetupChecklist;
  assert.equal(row(acked, "master_key").state, "ready");
  assert.equal((await z.call("POST", "/setup/token/ack")).status, 400);
});

test("setup: token row follows the bind address and token strength", async () => {
  const tokenRow = async (vars: Record<string, string>) => row(JSON.parse((await boot(vars).call("GET", "/setup")).text), "token");
  const exposed = await tokenRow({ Z_HOST: "0.0.0.0" });
  assert.equal(exposed.state, "ready");
  assert.match(exposed.detail, /generated a token in .*access\.token/);
  assert.equal((await tokenRow({ Z_TOKEN: "short" })).state, "needs_setup");
  assert.equal((await tokenRow({ Z_TOKEN: "0123456789abcdef0123456789abcdef" })).state, "ready");
  // Loopback, but a tunnel forwards a public address to it.
  assert.equal((await tokenRow({ Z_PUBLIC_URL: "https://z.example.com" })).state, "needs_setup");
});

test("setup: a chat model is ready only after it answered a live test", async () => {
  const z = boot();
  const provider = await fakeProvider(pong);
  await addProvider(z, provider.baseURL, "sk-good-key-1234567890");

  const before = JSON.parse((await z.call("GET", "/setup")).text) as SetupChecklist;
  assert.equal(row(before, "chat_model").state, "not_checked");
  assert.equal(provider.calls(), 0, "GET never calls a model");

  const after = JSON.parse((await z.call("POST", "/setup/check")).text) as SetupChecklist;
  assert.equal(row(after, "chat_model").state, "ready");
  assert.match(row(after, "chat_model").detail, /p1:m answered/);
  assert.equal(row(after, "lanes").state, "ready");
  assert.equal(provider.calls(), 1, "one call per model per check");
  assert.ok(after.checkedAt);

  // A new key makes the old result meaningless.
  await z.call("PUT", "/providers/p1", { kind: "openai-compatible", label: "P1", baseURL: provider.baseURL, apiKey: "sk-other-key-0987654321", models: ["m"] });
  assert.equal(row(JSON.parse((await z.call("GET", "/setup")).text), "chat_model").state, "not_checked");
});

test("setup: a rejected key is needs_setup with the provider's own error, minus the key", async () => {
  const z = boot();
  const key = "sk-bogus-SECRETVALUE-55aa66bb";
  const provider = await fakeProvider(badKey);
  await addProvider(z, provider.baseURL, key);
  const res = await z.call("POST", "/setup/check");
  assert.ok(!res.text.includes(key));
  assert.ok(!res.text.includes("SECRETVALUE"));
  const chat = row(JSON.parse(res.text), "chat_model");
  assert.equal(chat.state, "needs_setup");
  assert.match(chat.detail, /401 Incorrect API key provided: \[secret:66bb\]/);
  assert.deepEqual(chat.fix, { label: "Open models", path: "/models" });

  // The provider Test button records the same live result, and redacts it too.
  const tested = await z.call("POST", "/providers/p1/test");
  assert.ok(!tested.text.includes(key));
  assert.match(tested.text, /\[secret:66bb\]/);
});

test("setup: a rate limited provider is not_checked, not broken", async () => {
  const z = boot();
  const provider = await fakeProvider(() => ({ status: 429, body: { error: { message: "Rate limit exceeded: 1 request per 30s" } }, headers: { "retry-after": "30" } }));
  await addProvider(z, provider.baseURL, "sk-limited-1234567890");
  const chat = row(JSON.parse((await z.call("POST", "/setup/check")).text), "chat_model");
  assert.equal(chat.state, "not_checked");
  assert.match(chat.detail, /rate limited/);
  assert.match(chat.detail, /429/);
});

test("diagnostics: no secret or URL path of anything configured", async () => {
  const token = "ztoken-0123456789abcdef-DIAG";
  const z = boot({ Z_TOKEN: token });
  const key = "sk-diag-PROVIDERKEY-1234abcd";
  const provider = await fakeProvider(badKey);
  await addProvider(z, provider.baseURL, key);
  const channelSecret = "whsec-CHANNELSECRET-998877";
  z.store.channels.upsert({ id: "hook", kind: "webhook", label: "Hook", enabled: true, config: { secret: channelSecret }, always: false, lane: "bot", limits: { running: 4, waiting: 20, authorWaiting: 2, authorHourly: 10 } });
  const connectorUrl = "https://mcp.example.com/s/CONNECTORPATHSECRET/mcp";
  const headerValue = "Bearer hdr-CONNECTORHEADER-4455";
  z.store.connectors.upsert({ id: "mcp", label: "MCP", url: connectorUrl, transport: "http", auth: "headers", headers: { authorization: headerValue }, enabled: true, public: false, risks: {} });
  const password = "Hunter2-LOGINPASSWORD!";
  z.store.logins.save("l1", { origin: "https://shop.example.com", username: "ana@example.com", password });
  await z.call("POST", "/setup/check");

  const res = await z.call("GET", "/diagnostics");
  assert.equal(res.status, 200);
  const diag = JSON.parse(res.text) as Diagnostics;
  assert.equal(diag.server.authToken, true);
  assert.equal(diag.schemaVersion > 0, true);
  assert.equal(diag.providers[0]!.origin, new URL(provider.baseURL).origin);
  assert.equal(diag.connectors[0]!.origin, "https://mcp.example.com");
  assert.ok(diag.setup.rows.length > 5);
  for (const secret of [token, key, "PROVIDERKEY", channelSecret, "CONNECTORPATHSECRET", headerValue, "CONNECTORHEADER", password, z.env.masterKey.toString("base64"), z.env.masterKey.toString("hex")]) {
    assert.ok(!res.text.includes(secret), `diagnostics leaked ${secret}`);
    assert.ok(!(await z.call("GET", "/setup")).text.includes(secret), `setup leaked ${secret}`);
    assert.ok(!(await z.call("GET", "/providers")).text.includes(secret), `providers leaked ${secret}`);
  }
});
