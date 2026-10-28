/**
 * Server text travels as English plus a message key (contract/messages.ts) the app words in the
 * owner's language: every notice kind z writes itself carries `titleMsg` / `bodyMsg`, and the English
 * stored next to them is exactly what the key says in English.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { collectBriefItems, english, MAX_CONSECUTIVE_FAILURES, type Notice, type ServerText } from "@z/core";
import { createBriefings } from "../src/briefings.ts";
import { approvalBodyMsg, approvalComplete, channelMessage, notify, pushPayload } from "../src/notify.ts";
import { loginVault } from "../src/plugins.ts";
import { memoryNotice } from "../src/plugins/memory.ts";
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
const recurring = { ...oneShot, schedule: "0 0 1 1 *" } as const;

/** The notice's keys, and a check that its stored English is the key's English. */
function keys(n: Notice | undefined) {
  assert.ok(n, "notice");
  if (n.titleMsg) assert.equal(n.title, english(n.titleMsg), "title is the key's English");
  if (n.bodyMsg) assert.equal(n.body, english(n.bodyMsg), "body is the key's English");
  return { title: n.titleMsg, body: n.bodyMsg };
}
const latest = (z: ReturnType<typeof setup>, pred: (n: Notice) => boolean) => z.store.notices.list().find(pred);

test("server text: review, failed and question notices carry keys and the task title as a param", async () => {
  const z = setup();
  z.model.push({ text: "All green." });
  const done = z.tasks.create(oneShot);
  await until(() => statusOf(z.store, done.id) === "review", "review");
  const review = keys(latest(z, (n) => n.status === "review"));
  assert.deepEqual(review.title, { key: "noticeReview", params: { title: done.title } });
  assert.equal(review.body, undefined, "the model's result stays as written");

  z.model.push({ call: "report_failure", input: { reason: "The feed is down" } });
  const failed = z.tasks.create({ ...oneShot, instructions: "Fetch the feed" });
  await until(() => statusOf(z.store, failed.id) === "failed", "failed");
  assert.deepEqual(keys(latest(z, (n) => n.status === "failed")).title, { key: "noticeFailed", params: { title: failed.title } });

  z.model.push({ call: "ask_person", input: { question: "Which channel?", choices: ["Email", "Slack"] } });
  const asking = z.tasks.create({ ...oneShot, instructions: "Ask Ana" });
  await until(() => statusOf(z.store, asking.id) === "needs_input", "needs_input");
  const question = keys(latest(z, (n) => n.kind === "question"));
  assert.deepEqual(question.title, { key: "noticeQuestion", params: { title: asking.title } });
  assert.deepEqual(question.body, { key: "noticeQuestionBody", params: { question: "Which channel?" } }, "button choices are not repeated in the body");
});

test("server text: approval notices name the task and say the action in plain words, never the tool id or JSON", async () => {
  const z = setup();
  z.store.settings.set({ ...z.store.settings.get(), approvals: { test_send: "ask" } });
  z.model.push({ call: "test_send", input: { to: "ana" } });
  const task = z.tasks.create(oneShot);
  await until(() => statusOf(z.store, task.id) === "waiting", "waiting");
  const notice = latest(z, (x) => x.kind === "approval")!;
  const n = keys(notice);
  const approval = z.store.approvals.forTask(task.id)[0]!;
  assert.deepEqual(n.title, { key: "noticeApproval", params: { title: task.title } });
  const reason = approval.reason ? { reason: approval.reason } : {};
  assert.deepEqual(n.body, { key: "noticeApprovalBody", params: { ...reason, action: "Send a message to ana", details: "To: ana" } });
  assert.ok(!notice.body.includes("test_send") && !notice.body.includes("{"), notice.body);
  assert.ok(approvalComplete(approval));
  assert.equal(pushPayload(notice, true).approvalId, approval.id);
});

test("server text: a tool with no summary or structured input gets a plain line and no Approve button outside the app", () => {
  const approval = {
    tool: "acme__create_record",
    summary: 'acme__create_record({"fields":{"a":1}})',
    reason: null,
    preview: { kind: "change" as const, fields: [{ label: "Name", value: "Q3" }, { label: "Fields", value: '{\n  "a": 1\n}' }], fullText: "" },
  };
  const body = approvalBodyMsg(approval);
  assert.deepEqual(body, {
    key: "noticeApprovalBody",
    params: { action: { key: "approvalUseTool", params: { tool: "Create record" } }, details: "Name: Q3", more: { key: "approvalMore" } },
  });
  const text = english(body);
  assert.ok(!text.includes("acme__") && !text.includes("{"), text);
  assert.equal(approvalComplete(approval), false);
  const notice: Notice = { id: "n", kind: "approval", title: "Approval needed · Q3", body: text, path: "/", approvalId: "a", read: false, createdAt: "" };
  const push = pushPayload(notice, false);
  assert.equal(push.truncated, true, "the device opens z instead of approving");
  assert.equal(channelMessage(notice, "", 4000, false).actions, undefined, "no Approve / Deny buttons on the channel");
});

test("server text: recurring done, failing and paused notices carry keys; paused has its failure count", async () => {
  const z = setup();
  const task = z.tasks.create(recurring);
  const run = async (reply: Parameters<typeof z.model.push>[0]) => {
    z.model.push(reply);
    const before = z.store.tasks.get(task.id)!.updatedAt;
    z.tasks.runNow(task.id);
    await until(() => {
      const t = z.store.tasks.get(task.id)!;
      return (t.status === "scheduled" || t.status === "paused") && z.model.pending() === 0 && t.updatedAt >= before;
    }, "the run to finish");
  };
  await run({ text: "All good" });
  assert.deepEqual(keys(latest(z, (n) => n.status === "done")).title, { key: "noticeDone", params: { title: task.title } });

  const fail = { call: "report_failure", input: { reason: "The feed is down" } } as const;
  for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) await run(fail);
  assert.deepEqual(keys(latest(z, (n) => n.status === "failed")).title, { key: "noticeFailing", params: { title: task.title } });
  const paused = keys(latest(z, (n) => n.status === "paused"));
  assert.deepEqual(paused.title, { key: "noticePaused", params: { title: task.title } });
  assert.deepEqual(paused.body, { key: "noticePausedBody", params: { failures: MAX_CONSECUTIVE_FAILURES, error: "The feed is down" } });
});

test("server text: an interrupted task's notice and error carry keys", async () => {
  const { dir, model, tools, store, tasks } = setup();
  tools.holdOpen();
  model.push({ call: "test_send", input: { to: "ana" } });
  const task = tasks.create(oneShot);
  await until(() => tools.executed.length === 1 && store.tasks.calls(task.id).length === 1, "the write tool to start");
  const restarted = boot(dir, [tools.plugin], scriptedModel().model);
  engines.push(restarted.tasks);
  restarted.tasks.start();
  tasks.stopAll();

  const t = restarted.store.tasks.get(task.id)!;
  const expected: ServerText = { key: "taskInterrupted", params: { summary: "Send a message to ana" } };
  assert.deepEqual(t.errorMsg, expected);
  assert.equal(t.error, english(expected));
  const n = keys(restarted.store.notices.list().find((x) => x.status === "interrupted"));
  assert.deepEqual(n.title, { key: "noticeInterrupted", params: { title: task.title } });
  assert.deepEqual(n.body, expected);

  // A later error without a key drops the old key.
  restarted.store.tasks.update(task.id, { error: "something else" });
  assert.equal(restarted.store.tasks.get(task.id)!.errorMsg, undefined);
});

test("server text: briefing notice and plain summary carry keys; open tasks are worded by status", async () => {
  const z = setup();
  const briefing = await createBriefings(z.rt).generate();
  assert.deepEqual(briefing.summaryMsg, { key: "briefNothingNew" });
  assert.deepEqual(z.store.briefings.latest()?.summaryMsg, { key: "briefNothingNew" }, "stored with the briefing");
  const n = keys(latest(z, (x) => x.kind === "briefing"));
  assert.deepEqual(n.title, { key: "noticeBriefing", params: { needsYou: 0, proposals: 0 } });
  assert.deepEqual(n.body, { key: "briefNothingNew" });

  const task = z.store.tasks.list()[0] ?? z.tasks.create({ ...recurring, instructions: "Check the feed" });
  const { items } = await collectBriefItems({ ...z.rt.ownerDeps("briefing"), tasks: [{ ...task, status: "scheduled" }, { ...task, id: "w", status: "needs_input" }], since: new Date(0) });
  assert.deepEqual(items.map((i) => i.textMsg), [
    { key: "briefTaskOpen", params: { title: task.title, status: "scheduled" } },
    { key: "briefTaskNeedsInput", params: { title: task.title } },
  ]);
  for (const i of items) assert.equal(i.text, english(i.textMsg!));
});

test("server text: memory and saved sign-in notices carry keys; watch findings stay as the model wrote them", async () => {
  const z = setup();
  z.store.memories.add("m1", "Prefers answers in Vietnamese", "agent", "unreviewed");
  const memory = memoryNotice(z.store)!;
  assert.deepEqual(memory.title, { key: "noticeMemory", params: { handle: z.store.settings.get().handle, count: 1 } });
  keys(notify(memory));

  assert.equal(await loginVault(z.store).login("https://example.com"), null);
  const login = keys(latest(z, (x) => x.path === "/?settings=security"));
  assert.deepEqual(login.title, { key: "noticeSaveLogin", params: { host: "example.com" } });
  assert.deepEqual(login.body, { key: "noticeSaveLoginBody", params: { origin: "https://example.com" } });

  const watch = notify({ kind: "watch", title: "Price dropped", body: "€12", path: "/tasks" });
  assert.equal(watch.titleMsg, undefined);
  assert.equal(watch.bodyMsg, undefined);
  assert.equal(z.store.notices.get(watch.id)?.title, "Price dropped");
});
