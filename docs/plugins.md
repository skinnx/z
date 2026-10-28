# Write a plugin

This page shows how to add tools the agent can call, briefing sources and channel adapters to z as a TypeScript plugin, load it into a server and test it. The API lives in [`packages/core/src/plugin.ts`](../packages/core/src/plugin.ts). The built-in plugins in [`packages/plugins/src`](../packages/plugins/src) are complete examples.

## The shape of a plugin

A plugin is a plain object (`ZPlugin`), wrapped in `definePlugin` for types:

| Field | |
| --- | --- |
| `id`, `name`, `description` | `id` prefixes every tool name: tool `append` of plugin `notes` is `notes_append` in approvals, policies and task `tools` lists. Ids must be unique across loaded plugins |
| `settings` | `SettingField[]`: `{ key, label, secret?, required?, toggle?, multiline? }` (`multiline` is a list, one entry per line, shown as a text area). The web app renders them as a form (**Plugins**), and they are stored sealed with the master key. A plugin with a missing `required` setting provides no tools or briefing |
| `tools` | `Record<string, ZTool>`, built with `defineTool` |
| `briefing` | `(ctx: BriefingContext) => Promise<BriefSourceItem[]>` |
| `adapters` | `ChannelAdapter[]` |
| `instructions` | Usage notes shown to the model whenever this plugin's tools are offered |
| `enabledByDefault` | Enabled on first run. Defaults to true when no setting is required |

## Tools

```ts
defineTool({
  description: "…",          // what the model reads
  risk: "read" | "write" | "external",
  inputSchema: z.object({ … }),  // zod, or the AI SDK's jsonSchema()
  execute: async (input, ctx) => output,
  summarize?: (input) => string,           // one line for the approval card
  toModelOutput?: ({ output }) => …,       // what the model sees instead of the raw output
  public?: boolean,                        // reads only public knowledge: may be offered to bots
  ownerOnly?: boolean,                     // never offered to bots
  defaultPolicy?: "ask" | "allow",         // policy until the owner picks one
})
```

### Risk and approvals

| Risk | Use it for | Default |
| --- | --- | --- |
| `read` | Searching, fetching, reading a feed | Runs |
| `write` | Changing something the owner owns: a draft, a local file, z's own state | Asks (the reviewer may let it run when the owner asked for exactly this) |
| `external` | Anything others see or that leaves the machine: sending, posting, paying, deleting | Always asks, whatever the policy |

Pick the highest risk that applies. The risk decides more than the approval: watches and bots only get `read` tools, and the sensitive-data guard (card numbers, IBANs, keys) blocks inputs to `write` and `external` tools. See [security](security.md#approvals) for the whole pipeline.

- `defaultPolicy: "allow"` suits `write` tools that only change z itself; the built-in `memory_remember` uses it. It is ignored for `external` tools.
- `public: true` means the tool reads only public knowledge and may be offered to channel bots, which strangers reach. Only `read` tools are ever offered there. Don't mark a tool public if it reads anything of the owner's.
- `ownerOnly: true` keeps a tool away from bots even if it is also marked public.

### `summarize` and `toModelOutput`

`summarize(input)` is the one-line title of the approval card, such as `Add the note "TODO book the dentist"`. If it is missing or throws, z shows `tool({…json…})`. Below it, the card always shows the full structured preview of the input.

`toModelOutput({ output })` changes what the model sees, not what is stored in the task log. Return an AI SDK tool output, such as `{ type: "text", value }`, or `{ type: "content", value: [...] }` to hand an image to a vision model (the browser's `screenshot` and MCP connector tools do this).

### `ToolContext`

`execute(input, ctx)` receives:

| | |
| --- | --- |
| `ctx.settings` | This plugin's settings, already decrypted |
| `ctx.signal` | Aborted when the run is cancelled or times out; pass it to `fetch` |
| `ctx.log(text)` | Server log line prefixed with the tool name. Registered secrets are redacted |
| `ctx.fetch` | The global `fetch`. It is **not** SSRF-guarded: if a model or a stranger can choose the URL, check it yourself (the web plugin's `fetchPublic` in `packages/plugins/src/util.ts` shows how) |
| `ctx.vault` | Saved sign-ins. Only the built-in browser plugin gets it |

Throw to fail a call; the model sees the error message. Return JSON-serialisable output, because it is stored in the task log.

## Briefing sources

`briefing(ctx)` runs when the daily briefing is generated (on `Settings.briefingCron` or `POST /api/briefing`). `ctx` has `settings`, `log`, `fetch`, `since` (the last briefing, or 24 hours ago) and `timezone`. Return `BriefSourceItem[]`:

```ts
{ id, source, kind: "headline" | "todo" | "followup" | "metric", text, url?, suggestion?, signals? }
```

z prefixes `id` with the plugin id. `suggestion` is an instruction the owner can turn into a task with one tap. If the source throws, the briefing lists it under "could not check" instead of failing.

z then triages every item into a `BriefItem` with `priority` (`needs_you` or `can_wait`), a one-line `reason` and `decidedBy` (`rule` or `model`). Set `signals` (`BriefSignals`) only for facts the source knows for certain: `promotional`, `bot`, `ciPassed`, `read`, `closed`, `delegated`. Each one settles the item as `can_wait` with no model call. There is deliberately no "urgent" signal. The model, on the `briefing` lane, reads everything else as data, never as instructions. Without a model, unsettled items show as `needs_you`, "Not checked", and the summary is a plain count.

## Channel adapters

A channel adapter connects a chat platform to the bot. Its `kind` must be one of `ChannelKind` in [`contract.ts`](../packages/core/src/contract.ts) (`webhook`, `telegram`, `discord`, `slack`, `x`). A new platform means adding a kind there first. The server uses the first enabled plugin that provides a kind, so the built-in **Channels** plugin wins unless you disable it.

```ts
type ChannelAdapter = {
  kind: ChannelKind;
  label: string;
  config: SettingField[];            // the channel form; values are sealed, `toggle` fields store "on"
  webhook?: (request: Request, runtime: ChannelRuntime) => Promise<Response>; // POST /hooks/:channelId
  start?: (runtime: ChannelRuntime) => Promise<() => void | Promise<void>>;   // long-lived connection; returns stop
  send?: (runtime, threadId, { text, actions?, id? }) => Promise<void | { ref: string }>; // owner notices
  edit?: (runtime, threadId, ref, text) => Promise<void>;                     // replace a sent notice, drop its buttons
  noticeLimit?: number;              // longest text `send` delivers whole with buttons
};
```

An adapter with only `webhook` is a *webhook* adapter: it needs `Z_PUBLIC_URL`, and `runtime.webhookUrl` is null without it. One with `start` connects out (polling, a gateway) and may also accept webhooks.

`ChannelRuntime` is what the server hands the adapter:

| | |
| --- | --- |
| `channel` | The channel's settings, `config` decrypted |
| `handle` | The name the bot answers to (`Settings.handle`) |
| `webhookUrl` | `$Z_PUBLIC_URL/hooks/<channelId>` or null |
| `dispatch(message)` | Run the bot on one `InboundMessage`; resolves to an `OutboundReply` or null when it won't answer. The server applies the channel's limits and handles `/link <code>` pairing before any model call. Set `addressed` when the bot was mentioned or replied to |
| `act(actionId, from)` | Pass on a button press (`approve:<id>`, `deny:<id>`, `answer:<taskId>:<n>`). The server checks `from` is the paired owner. Resolves to a short ack once the action is final; rejects with a message to show when refused, and then the buttons should stay |
| `state.get(key)` / `state.set(key, value)` | A small per-channel store that survives restarts, for cursors, offsets and rotated tokens. Values are sealed. Telegram keeps its update `offset` here, X its `sinceId` and refreshed tokens |
| `deliveries.claim(id)` / `release(id)` | Replay protection: `claim` returns false for an id seen in the last 7 days; `release` forgets one so a failed delivery can be retried |
| `status(state, detail?)` | `ok`, `error` or `idle`, shown on the channel |
| `log`, `fetch` | As in tools |

`send` delivers owner notices (approvals, questions, watch hits) to the paired thread. `actions` are buttons with opaque ids; send them back through `runtime.act` when pressed. Delivery is retried on failure, and `id` is the same on every retry of one delivery, so use it for idempotency where the platform allows. Resolve to `{ ref }` (the platform's message id) and implement `edit`, and z will rewrite the message without buttons once the approval is decided or the question answered elsewhere. Set `noticeLimit` to the platform's message length: z only offers **Approve** when the complete approval preview fits, otherwise the message says "Open z to review".

Read [`channels/webhook.ts`](../packages/plugins/src/channels/webhook.ts) for a webhook adapter with signing, deliveries, `send` and `edit`, and [`channels/telegram.ts`](../packages/plugins/src/channels/telegram.ts) for `start`, `state` and buttons.

## Load a plugin

`Z_PLUGINS` takes a comma-separated list of module specifiers. Paths starting with `.` or `/` are resolved against the server's working directory, which is `apps/server` under `pnpm --filter` and in Docker. Each module must default-export the plugin. Loading errors are logged and skip that plugin; the server still starts.

The server runs TypeScript through tsx. A plugin file imports `@z/core` and `zod`, so it must sit where Node can resolve those packages: anywhere under `apps/server/`. The example below lives in `apps/server/local-plugins/`; add that folder to `.git/info/exclude` if you keep it out of version control.

```sh
Z_PLUGINS=./local-plugins/notes.ts pnpm --filter @z/server start
```

```
[z] loaded plugin notes from ./local-plugins/notes.ts
[z] listening on http://127.0.0.1:8787 (serving web app)
[z] data dir /…/.data; 9 plugin(s); auth off
```

In Docker, mount the file into the app and set the variable:

```sh
docker run -d --name z -p 8787:8787 -v z-data:/data \
  -v "$PWD/notes.ts":/app/apps/server/local-plugins/notes.ts:ro \
  -e Z_PLUGINS=./local-plugins/notes.ts z
```

## Example: notes

A plugin that keeps notes in a local file. It has a `read` tool, a `write` tool with a summary, a briefing source and a required setting.

`apps/server/local-plugins/notes.ts`:

```ts
import { appendFile, readFile } from "node:fs/promises";
import { definePlugin, defineTool, type BriefSourceItem } from "@z/core";
import { z } from "zod";

type Note = { at: string; text: string };

/** One note per line: `2026-10-28T09:15:00.000Z<TAB>text`. A missing file means no notes yet. */
async function readNotes(path: string): Promise<Note[]> {
  const raw = await readFile(path, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [at = "", ...rest] = line.split("\t");
      return { at, text: rest.join("\t") };
    });
}

export default definePlugin({
  id: "notes",
  name: "Notes",
  description: "Keep short notes in a local file; TODO notes show up in the briefing.",
  settings: [{ key: "path", label: "Notes file (absolute path)", required: true }],
  tools: {
    list: defineTool({
      description: "List the most recent notes, newest last.",
      risk: "read",
      inputSchema: z.object({ limit: z.number().int().min(1).max(50).default(20) }),
      execute: async ({ limit }, ctx) => ({ notes: (await readNotes(ctx.settings.path!)).slice(-limit) }),
      // The model reads plain lines instead of JSON.
      toModelOutput: ({ output }) => ({
        type: "text",
        value: output.notes.map((n) => `${n.at.slice(0, 10)}: ${n.text}`).join("\n") || "(no notes)",
      }),
    }),
    append: defineTool({
      description: "Add one note. Start it with TODO to have it in the next briefing.",
      risk: "write",
      inputSchema: z.object({ text: z.string().min(1).max(500) }),
      summarize: ({ text }) => `Add the note "${text}"`,
      execute: async ({ text }, ctx) => {
        const at = new Date().toISOString();
        await appendFile(ctx.settings.path!, `${at}\t${text.replace(/\s+/g, " ").trim()}\n`);
        ctx.log(`added a note (${text.length} characters)`);
        return { ok: true, at };
      },
    }),
  },
  briefing: async (ctx) => {
    const notes = await readNotes(ctx.settings.path!);
    return notes
      .filter((n) => /^TODO\b/i.test(n.text) && new Date(n.at) > ctx.since)
      .map((n, i): BriefSourceItem => ({ id: `${n.at}:${i}`, source: "notes", kind: "todo", text: n.text.replace(/^TODO:?\s*/i, "") }));
  },
});
```

`ctx.settings.path!` is safe: a plugin whose required setting is missing provides no tools or briefing at all.

### Call it against a running server

Start the server with `Z_PLUGINS` as above. The plugin is listed but disabled until its required setting is filled in:

```sh
Z=http://localhost:8787
curl -s $Z/api/plugins | jq -c '.[] | select(.id == "notes") | {enabled, tools}'
```

```json
{"enabled":false,"tools":[{"name":"list","description":"List the most recent notes, newest last.","risk":"read"},{"name":"append","description":"Add one note. Start it with TODO to have it in the next briefing.","risk":"write"}]}
```

Enable it and set the file, add a TODO by hand, and generate a briefing. The briefing source runs without any model:

```sh
NOTES=$PWD/notes.txt
curl -s -X PUT $Z/api/plugins/notes -H 'content-type: application/json' \
  -d "{\"enabled\": true, \"settings\": {\"path\": \"$NOTES\"}}" | jq -c '{enabled, briefing}'
printf '%s\tTODO renew the TLS certificate\n' "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" >> "$NOTES"
curl -s -X POST $Z/api/briefing | jq -c '{summary, items}'
```

```json
{"enabled":true,"briefing":true}
{"summary":"1 item since your last briefing: 1 from notes.","items":[{"id":"notes:2026-10-28T03:33:54.000Z:0","source":"notes","kind":"todo","text":"renew the TLS certificate","priority":"needs_you","reason":"Not checked: no model sorted this item.","decidedBy":"rule"}]}
```

Now have the agent call the `write` tool. This needs a model on the `agent` lane; the [API walkthrough](api.md#walkthrough) shows how to add one. Restricting the task to `notes_append` keeps the run small:

```sh
curl -s -X POST $Z/api/tasks -H 'content-type: application/json' \
  -d '{"instructions":"Add the note \"TODO book the dentist\" with notes_append, then report what you did.","tools":["notes_append"]}' | jq -r .id
```

`notes_append` is a `write` tool on Ask, so the reviewer decides first. In the run shown, the reviewer, on the slow keyless model, timed out and failed closed, so the run stopped at an approval. In a second run it saw that the instruction asked for exactly this note and let the call run without one.

```sh
curl -s "$Z/api/approvals?status=pending" | jq '.[] | {id, tool, summary, reason, preview: .preview.fullText}'
```

```json
{
  "id": "1e4e0af2-09ac-4186-aa9e-393b373f263e",
  "tool": "notes_append",
  "summary": "Add the note \"TODO book the dentist\"",
  "reason": "the safety check took too long.",
  "preview": "Add the note \"TODO book the dentist\"\n\nTODO book the dentist"
}
```

Approve it. The task resumes, the tool runs, and the task waits for review:

```sh
curl -s -X POST $Z/api/approvals/1e4e0af2-09ac-4186-aa9e-393b373f263e -H 'content-type: application/json' -d '{"approve":true}' | jq -c '{status}'
cat "$NOTES"
```

```
{"status":"approved"}
2026-10-28T03:15:17.000Z	TODO renew the TLS certificate
2026-10-28T03:16:00.731Z	TODO book the dentist
```

The server log shows the tool's `ctx.log` line: `[z:task:8b168cfd] [notes_append] added a note (21 characters)`.

## Test a plugin

Tools are plain functions, so the fastest test calls `execute` with a hand-made `ToolContext`. Put this next to the plugin as `apps/server/local-plugins/notes.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ToolContext } from "@z/core";
import notes from "./notes.ts";

const ctx = (path: string): ToolContext => ({
  settings: { path },
  signal: new AbortController().signal,
  log: () => {},
  fetch,
});

test("append, list and briefing", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "notes-")), "notes.txt");
  const { append, list } = notes.tools!;
  assert.equal(append!.risk, "write");
  assert.equal(append!.summarize!({ text: "TODO call Ann" }), 'Add the note "TODO call Ann"');

  await append!.execute({ text: "TODO call Ann" }, ctx(path));
  await append!.execute({ text: "bought milk" }, ctx(path));

  const output = await list!.execute({ limit: 20 }, ctx(path));
  assert.equal((output as { notes: unknown[] }).notes.length, 2);
  assert.match(JSON.stringify(list!.toModelOutput!({ output })), /call Ann/);

  const items = await notes.briefing!({ ...ctx(path), since: new Date(0), timezone: "UTC" });
  assert.deepEqual(items.map((i) => i.text), ["call Ann"]);
});
```

```sh
cd apps/server
node --test --disable-warning=ExperimentalWarning local-plugins/notes.test.ts
```

```
# tests 1
# pass 1
# fail 0
```

To typecheck the plugin with the repo's settings, give the folder a `tsconfig.json` with `{ "extends": "../tsconfig.json", "compilerOptions": { "noEmit": true }, "include": ["."] }` and run `./node_modules/.bin/tsc -p local-plugins` from `apps/server`.

To test the full loop (approvals, pauses, the task log) without a real model, `apps/server/test/harness.ts` runs the real store, plugins and task engine with the AI SDK's mock model. `apps/server/test/tasks.test.ts` shows how to script model replies and tool calls.

---

Every command on this page was run on 2026-10-28 against z 0.1.0 (on another port, with the notes file in a scratch directory). The `docker run` with the mounted plugin was also run, and logged `loaded plugin notes`.
