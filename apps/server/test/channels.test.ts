/**
 * Channel setup UX on the server: "Send a test" signs through the real webhook path, the activity
 * log records outcomes without keeping more than a preview, and it goes with the channel.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { CHANNEL_PREVIEW_CHARS } from "@z/core";
import { builtinPlugins } from "@z/plugins";
import { createChannels } from "../src/channels.ts";
import { createPairing } from "../src/owner.ts";
import { boot, cleanup, scriptedModel, tempDir } from "./harness.ts";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
});

function setup() {
  const dir = tempDir();
  dirs.push(dir);
  const scripted = scriptedModel();
  const { rt, store, tasks } = boot(dir, builtinPlugins, scripted.model);
  const channels = createChannels(rt, tasks, createPairing());
  store.channels.upsert({
    id: "hook",
    kind: "webhook",
    label: "Hook",
    enabled: true,
    config: { secret: "s3cret" },
    always: false,
    lane: "bot",
    limits: { running: 4, waiting: 20, authorWaiting: 2, authorHourly: 10 },
  });
  return { rt, store, channels, scripted };
}

test("channels: Send a test is signed like a real caller, and the activity log keeps outcomes, not bodies", async () => {
  const { store, channels, scripted } = setup();
  scripted.push({ text: "False: the Eiffel Tower is in Paris." }, { text: "False: the Eiffel Tower is in Paris." });
  const long = `is this true? ${"the Eiffel Tower is in Berlin ".repeat(20)}`;

  const result = await channels.test("hook", long);
  assert.ok(result);
  assert.equal(result.status, 200, result.error ?? "");
  assert.match(result.reply ?? "", /Eiffel/);

  // A bad signature never reaches the bot, and is logged without anything of the request.
  const bad = await channels.hook(
    "hook",
    new Request("http://local/hooks/hook", {
      method: "POST",
      headers: { "x-z-timestamp": String(Math.floor(Date.now() / 1000)), "x-z-delivery": "d1", "x-z-signature": "v1=00" },
      body: JSON.stringify({ text: "private words" }),
    }),
  );
  assert.equal(bad.status, 401);
  await channels.hook("hook", new Request("http://local/hooks/hook", { method: "POST", body: "{}" }));

  const log = channels.activity("hook")!;
  assert.deepEqual(
    log.map((a) => a.outcome),
    ["rejected", "rejected", "answered"],
  );
  const [missing, invalid, answered] = log;
  assert.equal(invalid!.detail, "Invalid X-Z-Signature");
  assert.equal(invalid!.preview, null);
  assert.equal(missing!.detail, "Missing X-Z-Signature");
  assert.equal(answered!.author, "Test from z");
  assert.ok(answered!.preview!.length <= CHANNEL_PREVIEW_CHARS);
  assert.ok(answered!.reply!.startsWith("False"));
  assert.ok(answered!.ms! >= 0);
  assert.ok(!JSON.stringify(log).includes("private words"));

  // The same refusal again folds into one entry.
  await channels.hook("hook", new Request("http://local/hooks/hook", { method: "POST", body: "{}" }));
  assert.equal(channels.activity("hook")![0]!.count, 2);

  // Setup steps end with the first message, which has now arrived.
  const steps = (await channels.setup("hook"))!;
  const local = channels.view(store.channels.get("hook")!).localWebhookUrl;
  assert.match(local ?? "", /^http:\/\/127\.0\.0\.1:\d+\/hooks\/hook$/);
  assert.equal(steps.find((s) => s.id === "webhook.url")?.value, local);
  assert.equal(steps.at(-1)?.id, "first");
  assert.equal(steps.at(-1)?.status, "done");

  // Deleting the channel deletes its log.
  assert.ok(await channels.remove("hook"));
  assert.equal(channels.activity("hook"), null);
  assert.equal(store.channelState.get("hook", "z:activity"), null);
});

test("channels: the test route refuses channels that are not webhooks or have no secret", async () => {
  const { store, channels } = setup();
  store.channels.upsert({ ...store.channels.get("hook")!, config: {} });
  await assert.rejects(channels.test("hook", "hi"), /no signing secret/);
  assert.equal(await channels.test("nope", "hi"), null);
});
