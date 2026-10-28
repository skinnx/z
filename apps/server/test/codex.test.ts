import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { closeCodexServers, CODEX_NOT_SIGNED_IN, codexAccount, createLanguageModel, listModels, testProvider, type ProviderConfig } from "@z/core";
import { generateText, streamText } from "ai";
import { createChannels } from "../src/channels.ts";
import { createConnectors } from "../src/connectors.ts";
import { createPairing } from "../src/owner.ts";
import { createPush } from "../src/push.ts";
import { createSetup } from "../src/setup.ts";
import { boot, cleanup, statusOf, tempDir, testPlugin, until } from "./harness.ts";

const FAKE = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));
const scratch = tempDir("z-codex-test-");
const LOG = join(scratch, "fake-codex.log");
process.env.FAKE_CODEX_LOG = LOG;

const provider = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({ id: "codex", kind: "codex-cli", label: "Codex", models: [], enabled: true, apiKey: null, command: FAKE, ...over });
const model = () => createLanguageModel(provider(), "gpt-fake");
/** What z sent the fake app-server, and its answers to the fake's requests. */
const sent = (): any[] => (existsSync(LOG) ? readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const sentMethod = (method: string) => sent().filter((e) => e.method === method);

const dirs: string[] = [];
const engines: { stopAll: () => void }[] = [];
beforeEach(() => writeFileSync(LOG, ""));
afterEach(() => {
  for (const e of engines.splice(0)) e.stopAll();
  for (const d of dirs.splice(0)) cleanup(d);
  delete process.env.FAKE_CODEX_SIGNED_OUT;
  closeCodexServers();
});
after(() => cleanup(scratch));

test("codex: streams reasoning and text deltas from a locked-down, ephemeral thread", async () => {
  const result = streamText({ model: model(), instructions: "You are z.", prompt: "stream please", maxRetries: 0 });
  const parts: { type: string; text?: string }[] = [];
  for await (const part of result.fullStream) parts.push(part as { type: string; text?: string });
  const deltas = parts.filter((p) => p.type === "text-delta");
  assert.ok(deltas.length > 1, "text arrives in several deltas");
  assert.equal(await result.text, "Hello from Codex");
  assert.equal(await result.reasoningText, "Thinking");
  assert.equal((await result.totalUsage).inputTokens, 10);

  const [start] = sentMethod("thread/start");
  assert.equal(start.params.sandbox, "read-only");
  assert.equal(start.params.approvalPolicy, "untrusted");
  assert.equal(start.params.ephemeral, true);
  assert.equal(start.params.baseInstructions, "You are z.");
  assert.equal(start.params.model, "gpt-fake");
  // Codex's own tools are switched off at launch, whatever ~/.codex/config.toml says.
  const { argv, env } = sent().find((e) => e.argv);
  for (const flag of ["features.shell_tool=false", "features.unified_exec=false", 'web_search="disabled"', "mcp_servers={}"]) assert.ok(argv.includes(flag), flag);
  assert.ok(!env.some((k: string) => k.startsWith("Z_")), "z's own settings and secrets stay out of the Codex process");
});

test("codex: earlier turns go in as injected history, the latest message as the turn", async () => {
  const { text } = await generateText({
    model: model(),
    messages: [
      { role: "user", content: "My name is Ana" },
      { role: "assistant", content: "Hi Ana" },
      { role: "user", content: "what is my name" },
    ],
    maxRetries: 0,
  });
  assert.equal(text, "echo: what is my name");
  const [inject] = sentMethod("thread/inject_items");
  assert.deepEqual(
    inject.params.items.map((i: any) => [i.role, i.content[0].text]),
    [
      ["user", "My name is Ana"],
      ["assistant", "Hi Ana"],
    ],
  );
});

test("codex: a Codex tool call runs through z's approval — the turn pauses, then resumes with the result", async () => {
  const dir = tempDir();
  dirs.push(dir);
  const tools = testPlugin();
  const z = boot(dir, [tools.plugin], model() as never);
  engines.push(z.tasks);
  z.store.settings.set({ ...z.store.settings.get(), approvals: { test_send: "ask" } });

  const task = z.tasks.create({ instructions: "tool: message bob", lane: "agent", mode: "do", missedPolicy: "once" });
  await until(() => statusOf(z.store, task.id) === "waiting", "waiting on approval");
  assert.equal(tools.executed.length, 0, "nothing runs before the owner approves");
  assert.ok(!sent().some((e) => e.toolAnswer), "Codex is still waiting for the result");
  const [approval] = z.store.approvals.forTask(task.id);
  assert.equal(approval!.tool, "test_send");
  assert.deepEqual(approval!.input, { to: "bob" });
  // The dynamic tool Codex called is the one z built (with z's name and schema).
  const [start] = sentMethod("thread/start");
  assert.ok(start.params.dynamicTools.some((t: any) => t.name === "test_send" && t.inputSchema.properties.to));

  z.tasks.decide(approval!.id, { approve: true, remember: false });
  await until(() => statusOf(z.store, task.id) === "review", "review");
  assert.deepEqual(tools.executed, [{ to: "bob" }]);
  const answer = sent().find((e) => e.toolAnswer).toolAnswer;
  assert.equal(answer.success, true);
  assert.equal(answer.contentItems[0].text, JSON.stringify({ sent: true }));
  assert.match(z.store.tasks.get(task.id)!.result ?? "", /Tool said: \{"sent":true\} \(ok\)/);
  // The same Codex turn carried on: one thread, one turn.
  assert.equal(sentMethod("turn/start").length, 1);
});

test("codex: a denied call tells Codex it was not allowed, and nothing runs", async () => {
  const dir = tempDir();
  dirs.push(dir);
  const tools = testPlugin();
  const z = boot(dir, [tools.plugin], model() as never);
  engines.push(z.tasks);
  z.store.settings.set({ ...z.store.settings.get(), approvals: { test_send: "ask" } });
  const task = z.tasks.create({ instructions: "tool: message bob", lane: "agent", mode: "do", missedPolicy: "once" });
  await until(() => statusOf(z.store, task.id) === "waiting", "waiting on approval");
  z.tasks.decide(z.store.approvals.forTask(task.id)[0]!.id, { approve: false, remember: false });
  await until(() => Boolean(sent().find((e) => e.toolAnswer)), "Codex hears the denial");
  const answer = sent().find((e) => e.toolAnswer).toolAnswer;
  assert.equal(answer.success, false);
  assert.match(answer.contentItems[0].text, /did not allow/);
  assert.equal(tools.executed.length, 0);
});

test("codex: an approval that outlives its Codex turn replays the call and its result into a new thread", async () => {
  const dir = tempDir();
  dirs.push(dir);
  const tools = testPlugin();
  const z = boot(dir, [tools.plugin], model() as never);
  engines.push(z.tasks);
  z.store.settings.set({ ...z.store.settings.get(), approvals: { test_send: "ask" } });
  const task = z.tasks.create({ instructions: "tool: message bob", lane: "agent", mode: "do", missedPolicy: "once" });
  await until(() => statusOf(z.store, task.id) === "waiting", "waiting on approval");
  closeCodexServers(); // the paused turn is gone (z or Codex restarted)
  writeFileSync(LOG, "");
  z.tasks.decide(z.store.approvals.forTask(task.id)[0]!.id, { approve: true, remember: false });
  await until(() => statusOf(z.store, task.id) === "review", "review");
  assert.deepEqual(tools.executed, [{ to: "bob" }]);
  const items = sentMethod("thread/inject_items")[0].params.items;
  assert.deepEqual(
    items.map((i: any) => i.type),
    ["message", "function_call", "function_call_output"],
  );
  assert.equal(items[2].output, JSON.stringify({ sent: true }));
  assert.match(z.store.tasks.get(task.id)!.result ?? "", /Continue from the tool results above/);
});

test("codex: a built-in tool attempt is declined; one that runs anyway stops the turn", async () => {
  const { text } = await generateText({ model: model(), prompt: "builtin: delete my files", maxRetries: 0 });
  assert.equal(text, "The command was declined.");
  assert.equal(sent().find((e) => e.approvalAnswer).approvalAnswer.decision, "decline");

  await assert.rejects(generateText({ model: model(), prompt: "ran-anyway", maxRetries: 0 }), /built-in commandExecution tool, which z does not allow/);
  await until(() => sentMethod("turn/interrupt").length === 1, "the turn is interrupted");
});

test("codex: not signed in — the provider test, the model and the setup checklist say to run `codex login`", async () => {
  process.env.FAKE_CODEX_SIGNED_OUT = "1";
  const result = await testProvider(provider());
  assert.deepEqual(result, { ok: false, error: CODEX_NOT_SIGNED_IN, account: { signedIn: false } });
  await assert.rejects(generateText({ model: model(), prompt: "hi", maxRetries: 0 }), (e: Error) => e.message === CODEX_NOT_SIGNED_IN);
  assert.equal(sentMethod("thread/start").length, 0, "no thread is started without a sign-in");

  const dir = tempDir();
  dirs.push(dir);
  const z = boot(dir, [], model() as never);
  engines.push(z.tasks);
  z.store.providers.upsert({ id: "codex", kind: "codex-cli", label: "Codex", models: ["gpt-fake"], enabled: true, command: FAKE }, undefined);
  const setup = createSetup(z.rt, createChannels(z.rt, z.tasks, createPairing()), createConnectors(z.rt.env, z.store, z.rt.bus), createPush(z.rt));
  assert.equal(setup.checklist().rows.find((r) => r.id === "codex:codex")?.state, "not_checked");
  const row = (await setup.check()).rows.find((r) => r.id === "codex:codex")!;
  assert.equal(row.state, "needs_setup");
  assert.match(row.detail, /not signed in — run `codex login`/);
});

test("codex: signed in — the test reports the ChatGPT plan; models list the default first", async () => {
  const result = await testProvider(provider());
  assert.equal(result.ok, true);
  assert.equal(result.model, "gpt-fake");
  assert.deepEqual(result.account, { signedIn: true, method: "chatgpt", email: "owner@example.com", plan: "plus" });
  assert.deepEqual(await listModels(provider()), ["gpt-fake", "gpt-fake-mini"]);
});

// The real CLI shipped with z (@openai/codex), with an empty CODEX_HOME: it starts, the handshake
// works, and it reports that nobody is signed in. (z never reads CODEX_HOME itself.)
const bundled = (() => {
  try {
    const require = createRequire(import.meta.url);
    return require.resolve("@openai/codex/bin/codex.js", { paths: [fileURLToPath(new URL("../../../packages/core", import.meta.url))] });
  } catch {
    return null;
  }
})();
test("codex: the real Codex CLI starts, answers the handshake and reports not signed in", { skip: !bundled && "@openai/codex not installed", timeout: 60_000 }, async () => {
  const home = tempDir("z-codex-home-");
  dirs.push(home);
  process.env.CODEX_HOME = home;
  try {
    const real = provider({ command: bundled! });
    assert.deepEqual(await codexAccount(real), { signedIn: false });
    const result = await testProvider(real);
    assert.equal(result.error, CODEX_NOT_SIGNED_IN);
    assert.ok((await listModels(real)).length > 0, "the real CLI lists its models without a sign-in");
  } finally {
    delete process.env.CODEX_HOME;
  }
});
