import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { collectBriefItems, definePlugin, MAX_CONSECUTIVE_FAILURES, MAX_FINGERPRINTS } from "@z/core";
import type { ModelMessage } from "ai";
import { z as zod } from "zod";
import { planRecovery } from "../src/recovery.ts";
import type { TaskCall } from "../src/store.ts";
import { boot, cleanup, scriptedModel, statusOf, tempDir, testPlugin, until } from "./harness.ts";

const dirs: string[] = [];
const engines: { stopAll: () => void }[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) e.stopAll();
  for (const d of dirs.splice(0)) cleanup(d);
});

function setup() {
  const dir = tempDir();
  dirs.push(dir);
  const model = scriptedModel();
  const tools = testPlugin();
  const z = boot(dir, [tools.plugin], model.model);
  engines.push(z.tasks);
  return { dir, model, tools, ...z };
}

const oneShot = { instructions: "Tell Ana the build is green", lane: "agent", mode: "do", missedPolicy: "once" } as const;
/** Yearly: never fires during a test; runs come from runNow. */
const recurring = { ...oneShot, schedule: "0 0 1 1 *" } as const;
const noticesOf = (store: ReturnType<typeof setup>["store"]) => store.notices.list();

// ─── Crash recovery: the decision ──────────────────────────────────────────

const call = (id: string, finished: boolean, output: unknown = { sent: true }): TaskCall => ({
  toolCallId: id,
  tool: "test_send",
  risk: "write",
  input: { to: "ana" },
  summary: "Send a message to ana",
  output: finished ? output : null,
  error: null,
  startedAt: "2026-01-01T00:00:00Z",
  finishedAt: finished ? "2026-01-01T00:00:01Z" : null,
});
const base: ModelMessage[] = [{ role: "user", content: "Tell Ana" }];

test("recovery: a started write call without a recorded result interrupts", () => {
  const plan = planRecovery(base, [call("a", true), call("b", false)]);
  assert.equal(plan.action, "interrupt");
  assert.deepEqual(plan.action === "interrupt" && plan.calls.map((c) => c.toolCallId), ["b"]);
});

test("recovery: no write calls, or all already in the conversation → resume unchanged", () => {
  assert.deepEqual(planRecovery(base, []), { action: "resume", messages: base });
  const persisted: ModelMessage[] = [
    ...base,
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "a", toolName: "test_send", input: { to: "ana" } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "a", toolName: "test_send", output: { type: "json", value: { sent: true } } }] },
  ];
  assert.deepEqual(planRecovery(persisted, [call("a", true)]), { action: "resume", messages: persisted });
});

test("recovery: a finished call whose step was never persisted is written back, not redone", () => {
  const plan = planRecovery(base, [call("a", true)]);
  assert.equal(plan.action, "resume");
  const messages = plan.action === "resume" ? plan.messages : [];
  assert.equal(messages.length, 3);
  assert.deepEqual(messages[1], { role: "assistant", content: [{ type: "tool-call", toolCallId: "a", toolName: "test_send", input: { to: "ana" } }] });
  assert.deepEqual(messages[2], {
    role: "tool",
    content: [{ type: "tool-result", toolCallId: "a", toolName: "test_send", output: { type: "json", value: { sent: true } } }],
  });
});

test("recovery: an approved call that finished joins the approval responses", () => {
  const paused: ModelMessage[] = [
    ...base,
    {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "a", toolName: "test_send", input: { to: "ana" } },
        { type: "tool-approval-request", approvalId: "ap1", toolCallId: "a" },
      ],
    },
    { role: "tool", content: [{ type: "tool-approval-response", approvalId: "ap1", approved: true }] },
  ];
  const plan = planRecovery(paused, [call("a", true)]);
  assert.equal(plan.action, "resume");
  const last = plan.action === "resume" ? plan.messages.at(-1) : null;
  assert.equal(plan.action === "resume" && plan.messages.length, paused.length);
  assert.deepEqual(
    last?.role === "tool" && last.content.map((p) => p.type),
    ["tool-approval-response", "tool-result"],
  );
});

// ─── Crash recovery: the engine across a restart ───────────────────────────

test("crash during a write tool: restart marks the task interrupted and never re-runs the tool", async () => {
  const { dir, model, tools, store, tasks } = setup();
  tools.holdOpen();
  model.push({ call: "test_send", input: { to: "ana" } });
  const task = tasks.create(oneShot);
  await until(() => tools.executed.length === 1 && store.tasks.calls(task.id).length === 1, "the write tool to start");
  assert.equal(statusOf(store, task.id), "running");

  // "kill -9": a new engine boots over the same data dir while the old one is frozen mid-tool,
  // then the old one is torn down without writing anything (its run is aborted, as if the process died).
  const after = scriptedModel();
  const restarted = boot(dir, [tools.plugin], after.model);
  engines.push(restarted.tasks);
  restarted.tasks.start();
  tasks.stopAll();

  const t = restarted.store.tasks.get(task.id)!;
  assert.equal(t.status, "interrupted");
  assert.match(t.error ?? "", /^z stopped mid-action: Send a message to ana\. Check and run again if needed/);
  assert.ok(noticesOf(restarted.store).some((n) => n.title.startsWith("Interrupted") && n.body.includes("Send a message to ana")));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(statusOf(restarted.store, task.id), "interrupted", "not queued again");
  assert.equal(tools.executed.length, 1, "the write tool ran once");
  assert.equal(after.pending(), 0);

  // The owner can acknowledge it.
  assert.equal(restarted.tasks.resolve(task.id)?.status, "done");
});

test("crash after a write tool finished: restart resumes from persisted messages without repeating it", async () => {
  const { dir, model, tools, store, tasks } = setup();
  model.push({ call: "test_send", input: { to: "ana" }, id: "send-1" }, "hang");
  const task = tasks.create(oneShot);
  await until(() => model.pending() === 0 && store.tasks.messages(task.id)?.length === 3, "step 1 to be persisted");
  assert.equal(tools.executed.length, 1);
  assert.equal(store.tasks.calls(task.id)[0]?.finishedAt !== null, true);

  const after = scriptedModel();
  after.push({ text: "Told Ana." });
  const restarted = boot(dir, [tools.plugin], after.model);
  engines.push(restarted.tasks);
  restarted.tasks.start();
  await until(() => statusOf(restarted.store, task.id) === "review", "the resumed run to finish");

  assert.equal(tools.executed.length, 1, "the write tool was not called again");
  const prompt = JSON.stringify(after.model.doGenerateCalls[0]?.prompt);
  assert.ok(prompt.includes("send-1"), "the resumed model call saw the earlier tool result");
  assert.equal(restarted.store.tasks.get(task.id)?.result, "Told Ana.");
  assert.deepEqual(restarted.store.tasks.calls(task.id), [], "journal cleared once the run ended");
});

// ─── Review → resolve ──────────────────────────────────────────────────────

test("one-shot tasks land in review with a notice; resolve marks them done", async () => {
  const { model, store, tasks } = setup();
  model.push({ text: "All green." });
  const task = tasks.create(oneShot);
  await until(() => statusOf(store, task.id) === "review", "review");
  assert.ok(noticesOf(store).some((n) => n.title.startsWith("Ready for review")));
  assert.throws(() => tasks.answer(task.id, "x"), /not waiting for an answer/);
  assert.equal(tasks.resolve(task.id)?.status, "done");
  assert.ok(
    noticesOf(store).filter((n) => n.path === `/tasks?task=${task.id}`).every((n) => n.read),
    "resolving reads the task's notices",
  );
  assert.throws(() => tasks.resolve(task.id), /not ready for review/);
});

test("approvals still pause and resume: the approved write runs once, then review", async () => {
  const { model, tools, store, tasks } = setup();
  store.settings.set({ ...store.settings.get(), approvals: { test_send: "ask" } });
  model.push({ call: "test_send", input: { to: "ana" } });
  const task = tasks.create(oneShot);
  await until(() => statusOf(store, task.id) === "waiting", "waiting");
  assert.equal(tools.executed.length, 0);
  const [approval] = store.approvals.forTask(task.id);
  model.push({ text: "Sent." });
  tasks.decide(approval!.id, { approve: true, remember: false });
  await until(() => statusOf(store, task.id) === "review", "review");
  assert.equal(tools.executed.length, 1);
});

// ─── ask_person ────────────────────────────────────────────────────────────

test("ask_person pauses as needs_input, the answer becomes the tool result, and the run resumes into review", async () => {
  const { model, store, tasks } = setup();
  model.push({ call: "ask_person", input: { question: "Which channel?", choices: ["Email", "Slack"] }, id: "ask-1" });
  const task = tasks.create(oneShot);
  await until(() => statusOf(store, task.id) === "needs_input", "needs_input");

  const paused = store.tasks.get(task.id)!;
  assert.equal(paused.question?.question, "Which channel?");
  assert.deepEqual(paused.question?.choices, ["Email", "Slack"]);
  const notice = noticesOf(store).find((n) => n.kind === "question");
  assert.ok(notice && notice.body.includes("Which channel?"));

  model.push({ text: "Sent on Slack." });
  assert.ok(["queued", "running"].includes(tasks.answer(task.id, "Slack")!.status));
  await until(() => statusOf(store, task.id) === "review", "review after the answer");

  const resumedPrompt = JSON.stringify(model.model.doGenerateCalls.at(-1)?.prompt);
  assert.ok(resumedPrompt.includes("ask-1") && resumedPrompt.includes("Slack"), "the answer was sent as the ask_person result");
  const done = store.tasks.get(task.id)!;
  assert.equal(done.result, "Sent on Slack.");
  assert.equal(done.question, null);
  assert.ok(done.events.some((e) => e.type === "step" && e.text === "Answered: Slack"));
  assert.equal(tasks.resolve(task.id)?.status, "done");
});

// ─── Recurring failures ────────────────────────────────────────────────────

async function runOnce(z: ReturnType<typeof setup>, id: string, reply: Parameters<typeof z.model.push>[0]) {
  z.model.push(reply);
  const before = z.store.tasks.get(id)!.updatedAt;
  z.tasks.runNow(id);
  await until(() => {
    const t = z.store.tasks.get(id)!;
    return (t.status === "scheduled" || t.status === "paused") && z.model.pending() === 0 && t.updatedAt >= before;
  }, "the run to finish");
}

test("recurring failures notify once per streak; MAX_CONSECUTIVE_FAILURES pause the task", async () => {
  const z = setup();
  const task = z.tasks.create(recurring);
  const failing = () => noticesOf(z.store).filter((n) => n.title.startsWith("Failing")).length;
  const fail = { call: "report_failure", input: { reason: "The feed is down" } } as const;

  await runOnce(z, task.id, fail);
  assert.equal(z.store.tasks.get(task.id)?.failures, 1);
  assert.equal(z.store.tasks.get(task.id)?.error, "The feed is down", "report_failure marks the run failed");
  assert.equal(failing(), 1);
  await runOnce(z, task.id, fail);
  assert.equal(failing(), 1, "no notice for the second failure in a row");

  await runOnce(z, task.id, { text: "All good" });
  assert.equal(z.store.tasks.get(task.id)?.failures, 0);
  assert.ok(noticesOf(z.store).some((n) => n.title.startsWith("Done")));

  await runOnce(z, task.id, { call: "no_update", input: {} });
  assert.equal(noticesOf(z.store).filter((n) => n.title.startsWith("Done")).length, 1, "no_update suppresses the completion notice");

  for (let i = 1; i <= MAX_CONSECUTIVE_FAILURES; i++) {
    await runOnce(z, task.id, fail);
    if (i === 1) assert.equal(failing(), 2, "first failure after a success notifies again");
  }
  assert.equal(failing(), 2);
  const paused = z.store.tasks.get(task.id)!;
  assert.equal(paused.status, "paused");
  assert.equal(paused.failures, MAX_CONSECUTIVE_FAILURES);
  assert.ok(noticesOf(z.store).some((n) => n.title.startsWith("Paused")));
});

// ─── Briefing ──────────────────────────────────────────────────────────────

test("briefing: a plugin source that throws is listed under couldNotCheck", async () => {
  const z = setup();
  const deps = z.rt.ownerDeps("briefing");
  const { items, couldNotCheck } = await collectBriefItems({ ...deps, tasks: [], since: new Date(0) });
  assert.deepEqual(items, []);
  assert.deepEqual(couldNotCheck, [{ source: "test", reason: "feed is down" }]);
});

// ─── Cancel and Run now ────────────────────────────────────────────────────

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

test("cancel: a cancelled run slow to unwind leaves the next run's controller, so a second cancel stops it", async () => {
  const gates: (() => void)[] = [];
  let looks = 0;
  const sent: unknown[] = [];
  const plugin = definePlugin({
    id: "slow",
    name: "Slow",
    description: "",
    tools: {
      look: {
        description: "Look something up (ignores abort)",
        risk: "read",
        inputSchema: zod.object({}),
        execute: async () => {
          looks++;
          await new Promise<void>((r) => gates.push(r));
          return { ok: true };
        },
      },
      send: {
        description: "Send a message",
        risk: "write",
        defaultPolicy: "allow",
        inputSchema: zod.object({ to: zod.string() }),
        execute: async (input: unknown) => {
          sent.push(input);
          return { sent: true };
        },
      },
    },
  });
  const dir = tempDir();
  dirs.push(dir);
  const model = scriptedModel();
  const z = boot(dir, [plugin], model.model);
  engines.push(z.tasks);

  model.push({ call: "slow_look", input: {} });
  const task = z.tasks.create(oneShot);
  await until(() => looks === 1, "run 1 inside the slow tool");
  z.tasks.cancel(task.id);
  model.push({ call: "slow_look", input: {} }, { call: "slow_send", input: { to: "ana" } }, { text: "Sent to Ana." });
  z.tasks.runNow(task.id);
  await until(() => looks === 2, "run 2 inside the slow tool");
  gates[0]!(); // run 1 unwinds now, while run 2 is in flight
  await tick();
  z.tasks.cancel(task.id); // the owner cancels run 2
  gates[1]!();
  await tick(200);
  assert.equal(statusOf(z.store, task.id), "cancelled");
  assert.deepEqual(sent, [], "the cancelled run never reached its write tool");
});

test("cancel then Run now on a recurring task keeps its cron job armed", async () => {
  const z = setup();
  const task = z.tasks.create(recurring);
  assert.ok(z.tasks.nextFire(task.id));
  z.tasks.cancel(task.id);
  assert.equal(z.tasks.nextFire(task.id), null, "cancel stops the job");

  await runOnce(z, task.id, { text: "All good" });
  const t = z.store.tasks.get(task.id)!;
  assert.equal(t.status, "scheduled");
  assert.equal(z.tasks.nextFire(task.id)?.toISOString(), t.nextRunAt, "a job stands behind the shown next run");
});

// ─── Watch de-duplication ──────────────────────────────────────────────────

test("watch: an unchanged item notifies once, however many other URLs later checks observe", async () => {
  const ITEM = "https://status.example.com/incidents/42";
  let check = 0;
  const plugin = definePlugin({
    id: "page",
    name: "Page",
    description: "",
    tools: {
      read: {
        description: "Read the status page",
        risk: "read",
        public: true,
        inputSchema: zod.object({}),
        // The incident stays; 300 tracking links per load change every time.
        execute: async () => ({ text: `Incident 42 ${ITEM}\n` + Array.from({ length: 300 }, (_, i) => `https://ads.example.net/c/${check}-${i}`).join("\n") }),
      },
    },
  });
  const dir = tempDir();
  dirs.push(dir);
  const model = scriptedModel();
  const z = boot(dir, [plugin], model.model);
  engines.push(z.tasks);
  const queueCheck = () =>
    model.push(
      { call: "page_read", input: {} },
      { text: `Incident 42 — ${ITEM}` },
      { text: JSON.stringify({ notify: true, title: "Incident 42", body: `Incident 42 ${ITEM}`, fingerprint: ITEM }) },
    );
  const watchNotices = () => z.store.notices.list().filter((n) => n.kind === "watch").length;

  queueCheck();
  const task = z.tasks.create({ instructions: "Tell me about incidents on status.example.com", lane: "agent", mode: "watch", missedPolicy: "once" });
  const counts: number[] = [];
  for (check = 0; check < 6; check++) {
    if (check > 0) {
      queueCheck();
      z.tasks.runNow(task.id);
    }
    await until(() => statusOf(z.store, task.id) === "scheduled" && model.pending() === 0, `check ${check}`);
    counts.push(watchNotices());
  }
  assert.deepEqual(counts, [1, 1, 1, 1, 1, 1]);
  const seen = z.store.tasks.fingerprints(task.id);
  assert.ok(seen.length <= MAX_FINGERPRINTS);
  assert.equal(seen.at(-1), ITEM, "the item seen again is the most recently seen");
});
