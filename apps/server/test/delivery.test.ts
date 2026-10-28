/**
 * Durable delivery and recurring schedules: the notice outbox (retry, backoff, give-up, restart,
 * settled approvals and questions), recurring notice de-dup and the missed-run policy.
 * Deterministic: a fake clock drives due times; the model is scripted; only the network edge
 * (push service, owner channel platform) is replaced, except where the real Web Push sender is under test.
 */
import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, test } from "node:test";
import { DELIVERY_BACKOFF_MS, MAX_DELIVERY_ATTEMPTS, type Notice } from "@z/core";
import { notify, startDelivery } from "../src/notify.ts";
import type { Transports } from "../src/notify.ts";
import { createPush } from "../src/push.ts";
import { resultHash } from "../src/tasks.ts";
import { boot, cleanup, scriptedModel, statusOf, tempDir, testPlugin, until, type BootOptions } from "./harness.ts";

const dirs: string[] = [];
const engines: { stopAll: () => void }[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) e.stopAll();
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) cleanup(d);
});

/** A fake clock starting at `start`. */
function clock(start = "2026-03-02T08:30:00.000Z") {
  let t = Date.parse(start);
  return { now: () => new Date(t), advance: (ms: number) => void (t += ms), set: (iso: string) => void (t = Date.parse(iso)) };
}

/** The owner channel's platform: fails the first `failures` sends, then accepts; records sends and edits. */
function fakeChannel(failures = 0) {
  const sends: { message: Parameters<Transports["channels"]["send"]>[2] }[] = [];
  const edits: { ref: string; text: string }[] = [];
  let left = failures;
  const channels: Transports["channels"] = {
    noticeLimit: () => 4000,
    send: async (_id, _thread, message) => {
      sends.push({ message });
      if (left-- > 0) throw new Error("notifyUrl answered 500");
      return `msg-${sends.length}`;
    },
    edit: async (_id, _thread, ref, text) => {
      edits.push({ ref, text });
      return true;
    },
  };
  return { channels, sends, edits, failAlways: () => void (left = Number.POSITIVE_INFINITY), heal: () => void (left = 0) };
}

const noPush: Transports["push"] = { endpoints: () => [], deliver: async () => "sent" };

function setup(options: BootOptions & { dir?: string; model?: ReturnType<typeof scriptedModel> } = {}) {
  const dir = options.dir ?? tempDir();
  if (!options.dir) dirs.push(dir);
  const model = options.model ?? scriptedModel();
  const tools = testPlugin();
  const z = boot(dir, [tools.plugin], model.model, options);
  engines.push(z.tasks);
  return { dir, model, tools, ...z };
}

function pairOwner(store: ReturnType<typeof setup>["store"]) {
  store.settings.set({ ...store.settings.get(), owner: { channelId: "hook", threadId: "owner-thread", authorId: "me", label: "Me" } });
}

const channelDelivery = (store: ReturnType<typeof setup>["store"], notice: Notice) =>
  store.outbox.forNotice(notice.id).find((d) => d.target === "channel")!;

const oneShot = { instructions: "Tell Ana the build is green", lane: "agent", mode: "do", missedPolicy: "once" } as const;

// ─── Outbox: retry, backoff, give-up ───────────────────────────────────────

test("outbox: a failing owner channel is retried at 30s, 2m, 10m and delivered on the 4th attempt", async () => {
  const time = clock();
  const channel = fakeChannel(3);
  const z = setup({ now: time.now, transports: { push: noPush, channels: channel.channels } });
  pairOwner(z.store);

  const notice = notify({ kind: "task", title: "Done · report", body: "All green.", path: "/tasks" });
  await z.outbox.drain();
  let d = channelDelivery(z.store, notice);
  assert.deepEqual([d.status, d.attempts, d.lastError], ["pending", 1, "notifyUrl answered 500"]);

  for (const [i, wait] of DELIVERY_BACKOFF_MS.slice(0, 3).entries()) {
    assert.equal(Date.parse(d.nextAttemptAt!) - time.now().getTime(), wait, `backoff after attempt ${i + 1}`);
    time.advance(wait - 1);
    await z.outbox.runDue();
    assert.equal(channel.sends.length, i + 1, "not before it is due");
    time.advance(1);
    await z.outbox.runDue();
    d = channelDelivery(z.store, notice);
  }
  assert.equal(channel.sends.length, 4);
  assert.deepEqual([d.status, d.attempts, d.lastError, d.ref, d.nextAttemptAt], ["sent", 4, null, "msg-4", null]);
  assert.equal(channel.sends[3]!.message.id, d.id, "the same delivery id on every try");
  assert.equal(channel.sends[0]!.message.id, d.id);
});

test("outbox: gives up after MAX_DELIVERY_ATTEMPTS and marks the delivery failed", async () => {
  const time = clock();
  const channel = fakeChannel();
  channel.failAlways();
  const z = setup({ now: time.now, transports: { push: noPush, channels: channel.channels } });
  pairOwner(z.store);
  const notice = notify({ kind: "watch", title: "Price dropped", body: "€12", path: "/tasks" });
  await z.outbox.drain();
  for (const wait of DELIVERY_BACKOFF_MS) {
    time.advance(wait);
    await z.outbox.runDue();
  }
  const d = channelDelivery(z.store, notice);
  assert.deepEqual([d.status, d.attempts, d.nextAttemptAt], ["failed", MAX_DELIVERY_ATTEMPTS, null]);
  assert.equal(channel.sends.length, MAX_DELIVERY_ATTEMPTS);
  time.advance(24 * 3600_000);
  await z.outbox.runDue();
  assert.equal(channel.sends.length, MAX_DELIVERY_ATTEMPTS, "nothing after giving up");
});

test("outbox: a channel send slower than the lease is not sent again; its lease is renewed meanwhile", async () => {
  const time = clock();
  const sends: string[] = [];
  let releaseFirst!: () => void;
  const channels: Transports["channels"] = {
    noticeLimit: () => 4000,
    // The first send stalls (a 429 retry_after, a hung connection) past the 60 s lease.
    send: async (_id, _thread, message) => {
      const n = sends.push(message.text);
      if (n === 1) await new Promise<void>((r) => (releaseFirst = r));
      return `msg-${n}`;
    },
    edit: async () => true,
  };
  const z = setup({ now: time.now, transports: { push: noPush, channels } });
  pairOwner(z.store);

  const first = notify({ kind: "task", title: "Ready for review · report", body: "All green.", path: "/" });
  await until(() => sends.length === 1, "the first send to start");
  time.advance(61_000);
  notify({ kind: "task", title: "Ready for review · other", body: "x", path: "/" }); // runs every due delivery
  await until(() => sends.length === 2, "the second notice to send");
  const leased = channelDelivery(z.store, first);
  assert.equal(leased.status, "pending");
  assert.ok(Date.parse(leased.nextAttemptAt!) > time.now().getTime(), "the in-flight delivery's lease was renewed");
  await z.outbox.runDue();

  releaseFirst();
  await z.outbox.drain();
  assert.equal(sends.filter((s) => s.includes("report")).length, 1, "the slow notice is sent once");
  assert.deepEqual([channelDelivery(z.store, first).status, channelDelivery(z.store, first).ref], ["sent", "msg-1"]);
});

test("outbox: a restart mid-backoff resumes the waiting delivery when it is due", async () => {
  const time = clock();
  const before = fakeChannel(1);
  const z = setup({ now: time.now, transports: { push: noPush, channels: before.channels } });
  pairOwner(z.store);
  const notice = notify({ kind: "task", title: "Done · report", body: "All green.", path: "/tasks" });
  await z.outbox.drain();
  assert.equal(channelDelivery(z.store, notice).attempts, 1);
  z.outbox.stop();

  // A new process over the same data dir.
  const after = fakeChannel();
  const restarted = setup({ dir: z.dir, now: time.now, transports: { push: noPush, channels: after.channels } });
  await restarted.outbox.drain();
  assert.equal(after.sends.length, 0, "not due yet");
  time.advance(DELIVERY_BACKOFF_MS[0]);
  await restarted.outbox.runDue();
  const d = channelDelivery(restarted.store, notice);
  assert.deepEqual([d.status, d.attempts], ["sent", 2]);
  assert.equal(after.sends.length, 1);
});

// ─── Outbox: settled approvals and questions ───────────────────────────────

test("outbox: deciding an approval drops its waiting delivery; a sent one is edited to show the decision", async () => {
  const time = clock();
  const channel = fakeChannel(1);
  const z = setup({ now: time.now, transports: { push: noPush, channels: channel.channels } });
  pairOwner(z.store);
  z.store.settings.set({ ...z.store.settings.get(), approvals: { test_send: "ask" } });

  z.model.push({ call: "test_send", input: { to: "ana" } });
  const task = z.tasks.create(oneShot);
  await until(() => statusOf(z.store, task.id) === "waiting", "waiting");
  await z.outbox.drain();
  const notice = z.store.notices.list().find((n) => n.kind === "approval")!;
  assert.equal(channelDelivery(z.store, notice).status, "pending", "the first try failed");
  assert.deepEqual(
    channel.sends[0]!.message.actions?.map((a) => a.label),
    ["Approve", "Deny"],
  );

  const [approval] = z.store.approvals.forTask(task.id);
  z.model.push({ text: "Sent." });
  z.tasks.decide(approval!.id, { approve: true, remember: false });
  const d = channelDelivery(z.store, notice);
  assert.deepEqual([d.status, d.lastError], ["dropped", "settled before delivery"]);
  time.advance(DELIVERY_BACKOFF_MS[0]);
  await z.outbox.runDue();
  assert.equal(channel.sends.length, 1, "never sent after the decision");
  await until(() => statusOf(z.store, task.id) === "review", "review");

  // Second approval: delivered, then decided → the sent message loses its buttons.
  channel.heal();
  z.model.push({ call: "test_send", input: { to: "bo" } });
  const second = z.tasks.create(oneShot);
  await until(() => statusOf(z.store, second.id) === "waiting", "second waiting");
  await z.outbox.drain();
  const secondNotice = z.store.notices.list().find((n) => n.kind === "approval" && n.id !== notice.id)!;
  assert.equal(channelDelivery(z.store, secondNotice).status, "sent");
  z.model.push({ text: "Not sent." });
  z.tasks.decide(z.store.approvals.forTask(second.id)[0]!.id, { approve: false, remember: false });
  await until(() => channel.edits.length === 1, "the edit");
  assert.equal(channel.edits[0]!.ref, channelDelivery(z.store, secondNotice).ref);
  assert.match(channel.edits[0]!.text, /Denied\.$/);
});

test("questions: stored on the notice, offered on push and channel, and answering one place closes the others", async () => {
  const time = clock();
  const channel = fakeChannel();
  const pushed: unknown[] = [];
  const push: Transports["push"] = {
    endpoints: () => ["https://push.example/device-1"],
    deliver: async (_endpoint, payload) => {
      pushed.push(payload);
      throw new Error("push.example answered 503");
    },
  };
  const z = setup({ now: time.now, transports: { push, channels: channel.channels } });
  pairOwner(z.store);

  z.model.push({ call: "ask_person", input: { question: "Which channel?", choices: ["Email", "Slack"] }, id: "ask-1" });
  const task = z.tasks.create(oneShot);
  await until(() => statusOf(z.store, task.id) === "needs_input", "needs_input");
  await z.outbox.drain();

  // After a "reload" (a fresh read from the database) the notice still carries its question.
  const notice = z.store.notices.list().find((n) => n.kind === "question")!;
  assert.deepEqual(notice.question, { taskId: task.id, text: "Which channel?", choices: ["Email", "Slack"] });
  assert.deepEqual((pushed[0] as { question?: unknown }).question, { taskId: task.id, choices: ["Email", "Slack"] });
  assert.deepEqual(
    channel.sends[0]!.message.actions?.map((a) => a.id),
    [`answer:${task.id}:0`, `answer:${task.id}:1`],
  );
  const pushDelivery = z.store.outbox.forNotice(notice.id).find((d) => d.target === "push")!;
  assert.equal(pushDelivery.status, "pending", "push failed once and waits for a retry");

  z.model.push({ text: "Sent on Slack." });
  z.tasks.answer(task.id, "Slack");
  assert.equal(z.store.notices.get(notice.id)?.question?.answer, "Slack", "the in-app buttons go away");
  assert.equal(z.store.outbox.get(pushDelivery.id)?.status, "dropped");
  await until(() => channel.edits.length === 1, "the channel message edit");
  assert.match(channel.edits[0]!.text, /Answered: Slack$/);
  time.advance(DELIVERY_BACKOFF_MS[0]);
  await z.outbox.runDue();
  assert.equal(pushed.length, 1, "no push retry once answered");
  await until(() => statusOf(z.store, task.id) === "review", "review");
});

test("push: a 5xx is retried; 404/410 removes the subscription and drops the delivery", async () => {
  const statuses = [503, 410];
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.method ?? "");
    res.writeHead(statuses.shift() ?? 201).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(9007, "127.0.0.1", resolve));

  const time = clock();
  const z = setup({ now: time.now, transports: { channels: fakeChannel().channels } });
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const endpoint = "http://127.0.0.1:9007/push/device-1";
  z.store.push.upsert(endpoint, { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") }, "Test phone");
  // The real Web Push sender against a local push service.
  const outbox = startDelivery(z.rt, createPush(z.rt), fakeChannel().channels, { now: () => time.now().getTime(), timers: false });

  const notice = notify({ kind: "task", title: "Done", body: "ok", path: "/" });
  await outbox.drain();
  const [d] = z.store.outbox.forNotice(notice.id);
  assert.deepEqual([d!.status, d!.attempts, d!.lastError], ["pending", 1, "127.0.0.1:9007 answered 503"]);
  time.advance(DELIVERY_BACKOFF_MS[0]);
  await outbox.runDue();
  assert.deepEqual([z.store.outbox.get(d!.id)?.status, z.store.outbox.get(d!.id)?.lastError], ["dropped", "device unsubscribed"]);
  assert.deepEqual(z.store.push.list(), [], "the dead subscription is removed");
  assert.equal(hits.length, 2);
});

// ─── Recurring notices: de-dup ─────────────────────────────────────────────

async function runOnce(z: ReturnType<typeof setup>, id: string, reply: Parameters<ReturnType<typeof scriptedModel>["push"]>[0]) {
  z.model.push(reply);
  const runs = z.model.model.doGenerateCalls.length;
  z.tasks.runNow(id);
  await until(() => {
    const t = z.store.tasks.get(id)!;
    return t.status === "scheduled" && z.model.pending() === 0 && z.model.model.doGenerateCalls.length > runs;
  }, "the run to finish");
}

test("recurring do tasks notify only when the result changes, after a failure, and never on no_update", async () => {
  const z = setup();
  const task = z.tasks.create({ ...oneShot, schedule: "0 0 1 1 *" });
  const done = () => z.store.notices.list().filter((n) => n.title.startsWith("Done")).length;

  await runOnce(z, task.id, { text: "3 new issues: #1, #2, #3" });
  assert.equal(done(), 1, "the first result notifies");
  await runOnce(z, task.id, { text: "3 new issues:\n  #1, #2,   #3 " });
  assert.equal(done(), 1, "the same result (whitespace aside) stays quiet");
  assert.ok(z.store.tasks.get(task.id)!.events.some((e) => e.type === "step" && e.text === "Same result as the last run: no notice."));
  assert.equal(z.store.tasks.resultHash(task.id), resultHash("3 new issues: #1, #2, #3"));

  await runOnce(z, task.id, { text: "4 new issues: #1, #2, #3, #4" });
  assert.equal(done(), 2, "a changed result notifies");
  await runOnce(z, task.id, { call: "no_update", input: {} });
  assert.equal(done(), 2, "no_update stays quiet");

  await runOnce(z, task.id, { call: "report_failure", input: { reason: "The feed is down" } });
  assert.equal(z.store.notices.list().filter((n) => n.title.startsWith("Failing")).length, 1, "the first failure of a streak notifies");
  await runOnce(z, task.id, { text: "4 new issues: #1, #2, #3, #4" });
  assert.equal(done(), 3, "a success after a failure notifies even when the result is unchanged");
});

// ─── Missed runs ───────────────────────────────────────────────────────────

/** Hourly at :00 from 08:30 → first run due 09:00. The test then "restarts" at `restartAt`. */
async function missed(policy: "once" | "skip", restartAt: string) {
  const time = clock("2026-03-02T08:30:00.000Z");
  const z = setup({ now: time.now, transports: { push: noPush, channels: fakeChannel().channels } });
  const task = z.tasks.create({ ...oneShot, schedule: "0 * * * *", missedPolicy: policy });
  assert.equal(z.store.tasks.get(task.id)?.nextRunAt, "2026-03-02T09:00:00.000Z");
  z.tasks.stopAll();

  time.set(restartAt);
  const model = scriptedModel();
  const restarted = setup({ dir: z.dir, model, now: time.now, transports: { push: noPush, channels: fakeChannel().channels } });
  return { task, model, restarted, time };
}

test("missed runs: `once` runs a recent miss exactly once at startup, however many slots passed", async () => {
  const { task, model, restarted } = await missed("once", "2026-03-02T12:10:00.000Z");
  model.push({ text: "Checked." });
  restarted.tasks.start();
  await until(() => statusOf(restarted.store, task.id) === "scheduled" && model.pending() === 0, "the catch-up run");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(model.model.doGenerateCalls.length, 1, "one run for four missed slots");
  const t = restarted.store.tasks.get(task.id)!;
  assert.equal(t.nextRunAt, "2026-03-02T13:00:00.000Z");
  assert.ok(t.events.some((e) => e.type === "step" && e.text.startsWith("Missed the run due 2026-03-02T09:00:00.000Z")));
});

test("missed runs: `skip` and misses older than 24h are skipped and noted in the task events", async () => {
  const skip = await missed("skip", "2026-03-02T12:10:00.000Z");
  skip.restarted.tasks.start();
  let t = skip.restarted.store.tasks.get(skip.task.id)!;
  assert.equal(t.status, "scheduled");
  assert.equal(t.nextRunAt, "2026-03-02T13:00:00.000Z");
  assert.ok(t.events.some((e) => e.type === "step" && /Skipped the run due .*missed runs are skipped/.test(e.text)));
  skip.restarted.tasks.stopAll();

  const old = await missed("once", "2026-03-03T15:10:00.000Z");
  old.restarted.tasks.start();
  t = old.restarted.store.tasks.get(old.task.id)!;
  assert.equal(t.status, "scheduled");
  assert.equal(t.nextRunAt, "2026-03-03T16:00:00.000Z");
  assert.ok(t.events.some((e) => e.type === "step" && /Skipped the run due .*more than 24 hours ago/.test(e.text)));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(old.model.model.doGenerateCalls.length + skip.model.model.doGenerateCalls.length, 0, "nothing ran");
});
