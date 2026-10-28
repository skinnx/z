# HTTP API

This page lets you drive z from scripts and other apps: every route, how to authenticate, the request and response types, the two event streams and the error format, followed by a walkthrough you can paste into a terminal.

The source of truth is [`packages/core/src/contract.ts`](../packages/core/src/contract.ts). Every type named below is defined there, and the route list at the bottom of that file is what this page expands. Zod schemas (`ProviderInput`, `TaskInput`, …) validate request bodies; plain types (`ProviderView`, `Task`, …) describe responses.

## Basics

- **Base URL:** the server, e.g. `http://localhost:8787`. JSON in and out unless noted.
- **Auth:** when z has a token (`Z_TOKEN`, or the generated `access.token` when it listens beyond loopback), every `/api/*` route, `/api/health` included, needs `Authorization: Bearer <token>`. EventSource can't set headers, so `?token=<token>` works too. On loopback without `Z_TOKEN` there is no auth. `/hooks/:channelId` and `/oauth/callback` are outside `/api` and have their own checks ([security](security.md#who-can-reach-what)).
- **Write-only secrets:** provider `apiKey`, channel `config`, connector `url` and `headers`, plugin settings and login passwords are accepted but never returned. Omit a field on update to keep the stored value; an empty string clears it (for connector headers, `{}` clears them all).
- **Ids in the URL:** for `PUT /api/providers/:id`, `/channels/:id` and `/connectors/:id` the id comes from the path (`^[a-z0-9][a-z0-9-]{0,31}$`). A body `id` that differs is a 400. `PUT` creates or updates.

### Errors

Every error is `{ "error": string }` with a 4xx or 5xx status:

| Status | When | Example |
| --- | --- | --- |
| 400 | Body is not JSON, or fails validation: the first issue, prefixed with its path | `{"error":"chat: Invalid input: expected array, received string"}` |
| 401 | Missing or wrong token | `{"error":"Unauthorized"}` |
| 404 | Unknown route or id | `{"error":"Not found"}`, `{"error":"Task not found"}` |
| 409 | State conflict | `{"error":"Approval is already approved"}`, `Task is already running`, a saved sign-in for that origin already exists |
| 500 | Unexpected failure (details only in the server log) | `{"error":"Internal server error"}` |
| 502 | An upstream refused | `GET /api/providers/:id/models`, `POST /api/connectors/:id/oauth` |

## Routes

### Health, settings, models

| Route | Body | Response |
| --- | --- | --- |
| `GET /api/health` | | `{ ok: true, version }` |
| `GET /api/settings` | | `Settings` |
| `PUT /api/settings` | partial `Settings` | `Settings`. Top-level fields are merged into the stored settings; nested objects such as `approvals` are replaced whole. `owner` is read-only (set by pairing). Bad `timezone` or `briefingCron` is a 400 |
| `GET /api/providers` | | `ProviderView[]` |
| `PUT /api/providers/:id` | `ProviderInput` | `ProviderView`. `openai-compatible` needs `baseURL`; `command` is only for `codex-cli`, which stores no key, URL or headers |
| `DELETE /api/providers/:id` | | `{ ok: true }` |
| `POST /api/providers/:id/test` | | `ProviderTestResult` `{ ok, model?, latencyMs?, error?, rateLimited?, timedOut?, account? }`, one live call, errors redacted; `account` is the Codex sign-in for `codex-cli` |
| `GET /api/providers/:id/models` | | `{ models: string[] }` from the provider where supported |
| `GET /api/routing` | | `Routing`: lanes `chat`, `agent`, `briefing`, `bot`, `fast`, each an ordered list of `ModelRef` (`providerId:modelId`) |
| `PUT /api/routing` | partial `Routing` | `Routing` (given lanes replace stored ones) |
| `GET /api/plugins` | | `PluginManifest[]` |
| `PUT /api/plugins/:id` | `{ enabled: boolean, settings?: Record<string,string> }` | `PluginManifest`. Settings merge per key |
| `GET /api/adapters` | | `AdapterManifest[]` |

### Chat

| Route | Body | Response |
| --- | --- | --- |
| `POST /api/chat` | `{ id, messages: UIMessage[], model?: ModelRef }` | AI SDK UI message stream ([below](#chat-stream)); the thread is saved under `id` when the reply finishes |
| `GET /api/threads` | | `{ id, title, updatedAt }[]` |
| `GET /api/threads/:id` | | `{ id, title, messages: UIMessage[] }` |
| `DELETE /api/threads/:id` | | `{ ok: true }` |
| `DELETE /api/threads` | | `{ deleted: number }` |

`model` overrides the `chat` lane for one request. Tool approvals in chat travel inside the message stream (a tool part in state `approval-requested`), and the client answers by sending the messages back with an approval response (the AI SDK's `addToolApprovalResponse`). They do not appear under `/api/approvals`.

### Tasks, approvals, briefing

| Route | Body | Response |
| --- | --- | --- |
| `GET /api/tasks` | | `Task[]`, newest first |
| `POST /api/tasks` | `TaskInput` | `201 Task`. `schedule` is a cron in `Settings.timezone`; `mode: "watch"` without one checks hourly. `missedPolicy` (`once`, the default, or `skip`) decides whether a run missed while z was down runs once at startup |
| `POST /api/tasks/:id/run` | | `Task`, run now (409 if already queued or running) |
| `POST /api/tasks/:id/cancel` | | `Task` |
| `POST /api/tasks/:id/answer` | `TaskAnswer` `{ text }` | `Task`. `needs_input` → resumes; the answer becomes the `ask_person` result |
| `POST /api/tasks/:id/resolve` | | `Task`. `review` or `interrupted` → `done` |
| `DELETE /api/tasks/:id` | | `{ ok: true }` |
| `GET /api/approvals?status=` | | `Approval[]`; `status` is `pending`, `approved`, `denied` or `expired` |
| `POST /api/approvals/:id` | `ApprovalDecision` `{ approve, remember?, note? }` | `Approval`. When every approval of the pause is decided, the task resumes. `remember` writes the tool's policy (never `allow` for `external` tools) |
| `GET /api/briefing` | | `Briefing \| null`, the latest |
| `POST /api/briefing` | | `Briefing`, generated now (concurrent calls share one) |

`Task.status` moves through `queued` → `running` → one of `waiting` (an approval), `needs_input` (a question), `review` (a one-shot finished), `failed`, or `scheduled` (recurring, idle). Also possible: `interrupted` (stopped mid-action by a restart), `paused` (a recurring task failed `MAX_CONSECUTIVE_FAILURES` = 10 runs in a row), `cancelled` and `done`. `Task.events` is the log: `step`, `tool`, `approval` and `model` entries.

### Memory

| Route | Body | Response |
| --- | --- | --- |
| `GET /api/memories?status=&q=` | | `Memory[]`, newest first; with `q`, full-text search, best match first |
| `POST /api/memories` | `MemoryInput` `{ text, pinned? }` | `201 Memory`, `active` |
| `PUT /api/memories/:id` | `MemoryInput` | `Memory`; editing an `unreviewed` one confirms it |
| `POST /api/memories/:id/confirm` | | `Memory`, `unreviewed` → `active` |
| `POST /api/memories/:id/pin` | `{ pinned: boolean }` | `Memory` |
| `DELETE /api/memories/:id` | | `{ ok: true }` |
| `DELETE /api/memories` | | `{ deleted: number }` |

### Skills

| Route | Body | Response |
| --- | --- | --- |
| `GET /api/skills` | | `Skill[]`, by name |
| `POST /api/skills` | `SkillInput` `{ name, description, instructions, tools? }` | `201 Skill`; 409 when the name is taken |
| `PUT /api/skills/:id` | `SkillInput` | `Skill` |
| `DELETE /api/skills/:id` | | `{ ok: true }` |

A chat message or task whose text starts with `/<name>` runs with that skill. `tools` are names or globs (`web_*`, `mcp_<connector>_*`) that narrow what the run is offered; they never grant a tool the approval policy hides.

### Reach: notices, push, owner pairing

| Route | Body | Response |
| --- | --- | --- |
| `GET /api/notices` | | `Notice[]`, newest first, last 100 |
| `POST /api/notices/read` | `{ ids?: string[] }` | `{ ok: true }`; all when `ids` is omitted |
| `GET /api/push` | | `{ publicKey, devices: { endpoint, device, createdAt }[] }` |
| `POST /api/push` | `PushSubscriptionInput` | `{ ok: true }`; `endpoint` must be https |
| `DELETE /api/push` | `{ endpoint }` | `{ ok: true }` |
| `POST /api/push/test` | | `{ sent: number }` |
| `POST /api/owner/link` | | `{ code, expiresAt }`. Send `/link <code>` to the bot within 10 minutes |
| `DELETE /api/owner` | | `Settings` with `owner: null` |

### Channels

| Route | Body | Response |
| --- | --- | --- |
| `GET /api/channels` | | `ChannelView[]` |
| `PUT /api/channels/:id` | `ChannelInput` | `ChannelView`; `config` keys merge (empty string removes one); omitted `limits` keep the stored ones |
| `DELETE /api/channels/:id` | | `{ ok: true }` |
| `GET /api/channels/:id/activity` | | `ChannelActivity[]`, newest first: the last 20 inbound events with their outcome (`answered`, `silent`, `ignored`, `limited`, `error`, `rejected`), a 120-character preview of the message and reply (none for ignored or rejected ones), verdict and time taken. Repeated ignored or rejected events fold into one entry with a `count`. Stored sealed, deleted with the channel |
| `GET /api/channels/:id/setup` | | `ChannelSetupStep[]`: the platform's next steps, checked live (token, bot name, scopes, webhook registration), ending with whether a first message arrived |
| `POST /api/channels/:id/test` | `{ text }` | `ChannelTestResult` `{ status, ms, reply, verdict, sources, error }`: webhook channels only; z signs the message with the channel's secret and runs it through `/hooks/:id`, so it counts against the channel's limits like any caller |
| `POST /hooks/:channelId` | adapter-defined | adapter-defined; for `webhook` channels see [security](security.md#webhook-signing) and the [README](../README.md#webhooks) |

### Connectors

| Route | Body | Response |
| --- | --- | --- |
| `GET /api/connector-presets` | | `ConnectorPreset[]` |
| `GET /api/connectors` | | `ConnectorView[]` |
| `PUT /api/connectors/:id` | `ConnectorInput` | `ConnectorView`; saves, connects and lists tools. `url` is required when creating |
| `DELETE /api/connectors/:id` | | `{ ok: true }`; revokes OAuth tokens in the background |
| `POST /api/connectors/:id/refresh` | | `ConnectorView` |
| `POST /api/connectors/:id/oauth` | | `OAuthStart` `{ authorizationUrl, redirectUri }` |
| `POST /api/connectors/:id/oauth/complete` | `OAuthCompleteInput` `{ url }` | `ConnectorView`; 400 on a wrong, used or expired state |
| `GET /oauth/callback?code&state` | | redirect to `/connect?connector=<id>` (no bearer; the state is the check) |

See [connectors](connectors.md).

### Saved sign-ins

| Route | Body | Response |
| --- | --- | --- |
| `GET /api/logins` | | `LoginView[]` (no passwords or TOTP secrets) |
| `POST /api/logins` | `LoginInput` | `201 LoginView`; 409 when the origin has one |
| `PUT /api/logins/:id` | `LoginUpdate` | `LoginView` |
| `DELETE /api/logins/:id` | | `{ ok: true }` |

### Setup, diagnostics, export, events

| Route | Body | Response |
| --- | --- | --- |
| `GET /api/setup` | | `SetupChecklist` from cached results (no model calls) |
| `POST /api/setup/check` | | `SetupChecklist` after live checks |
| `POST /api/setup/:id/ack` | | `SetupChecklist`; only rows with `ack` (the master key backup) |
| `GET /api/diagnostics` | | `Diagnostics` as attachment `z-diagnostics-<date>.json`, no secrets |
| `GET /api/export` | | attachment `z-export-<date>.json`: settings, routing, provider/channel/connector views, tasks, approvals, briefings, memories, skills, threads, notices; no secrets |
| `GET /api/events` | | `text/event-stream` of `LiveEvent` ([below](#live-events)) |

## Event streams

### Live events

`GET /api/events` is a standard SSE stream:

```
event: ready
data: {}

data: {"type":"channel","channel":{"id":"my-hook","kind":"webhook", …}}

event: ping
data: 
```

- One `ready` event when the stream opens.
- Unnamed (`message`) events whose `data` is one `LiveEvent`: `{ type: "task", task }`, `{ type: "approval", approval }`, `{ type: "briefing", briefing }`, `{ type: "channel", channel }`, `{ type: "channelActivity", channelId }` (refetch that channel's activity), `{ type: "notice", notice }` or `{ type: "connector", connector }`. Each carries the whole object after the change.
- A `ping` event after 15 seconds without events, to keep proxies from closing the stream.

There is no replay: events sent while you were disconnected are gone, so re-read the lists you care about after reconnecting.

### Chat stream

`POST /api/chat` answers with the AI SDK's UI message stream (SSE, one JSON chunk per `data:` line, ending with `data: [DONE]`), which `useChat` consumes directly. Chunks seen in a real reply:

```
data: {"type":"start","messageId":"8mRae7wZOMoHVbJy"}
data: {"type":"start-step"}
data: {"type":"reasoning-start","id":"reasoning-0"}
data: {"type":"reasoning-delta","id":"reasoning-0","delta":"The"}
…
data: {"type":"reasoning-end","id":"reasoning-0"}
data: {"type":"text-start","id":"txt-0"}
data: {"type":"text-delta","id":"txt-0","delta":"Ready"}
data: {"type":"text-delta","id":"txt-0","delta":"."}
data: {"type":"text-end","id":"txt-0"}
data: {"type":"finish-step"}
data: {"type":"finish","finishReason":"stop"}
data: [DONE]
```

Tool calls add tool chunks, and sources come from providers with built-in search. When the prompt was compacted to fit the model's context window, z adds a `data-context` chunk whose `data` is a `ContextReport` `{ summarized, trimmed, tokensBefore, tokensAfter }`. The stored thread is never shortened.

## Walkthrough

This adds a free keyless model, routes it, runs a task through the reviewer, then a task that asks a question and waits for an approval, and finally chats. It uses the keyless Pollinations endpoint (`openai-fast`), which allows about one reply per 30 seconds per IP and **sees everything you send** ([security](security.md#free-keyless-providers)). z waits once when a model says "retry after", so the steps below just take a while. You need `curl`, `jq` and `openssl`.

Start a server with a token:

```sh
Z_TOKEN=$(openssl rand -hex 32)
echo "$Z_TOKEN"
Z_TOKEN=$Z_TOKEN pnpm --filter @z/server start
```

In another terminal (set `Z_TOKEN` to the value printed above):

```sh
Z=http://localhost:8787
AUTH="Authorization: Bearer $Z_TOKEN"
JSON='content-type: application/json'
curl -s $Z/api/health; echo
curl -s -H "$AUTH" $Z/api/health; echo
```

```
{"error":"Unauthorized"}
{"ok":true,"version":"0.1.0"}
```

### 1. Add a provider and test it

```sh
curl -s -X PUT $Z/api/providers/pollinations -H "$AUTH" -H "$JSON" \
  -d '{"kind":"openai-compatible","label":"Pollinations","baseURL":"https://text.pollinations.ai/openai","models":["openai-fast"]}'; echo
curl -s -X POST $Z/api/providers/pollinations/test -H "$AUTH"; echo
```

```
{"id":"pollinations","kind":"openai-compatible","label":"Pollinations","baseURL":"https://text.pollinations.ai/openai","models":["openai-fast"],"enabled":true,"hasKey":false,"keyHint":null,"usage":{"monthUsd":0,"monthTokens":0}}
{"ok":true,"model":"openai-fast","latencyMs":312}
```

For a provider with a key, add `"apiKey":"…"`. It is stored sealed, and only `hasKey` and `keyHint` come back.

### 2. Route the lanes

```sh
curl -s -X PUT $Z/api/routing -H "$AUTH" -H "$JSON" \
  -d '{"chat":["pollinations:openai-fast"],"agent":["pollinations:openai-fast"]}'; echo
```

```
{"chat":["pollinations:openai-fast"],"agent":["pollinations:openai-fast"],"briefing":[],"bot":[],"fast":[]}
```

With `fast` empty, the reviewer and task titles use the `agent` lane.

### 3. A task the reviewer lets through

Set the built-in `memory_remember` tool (normally Allow) to Ask, then ask for exactly that action:

```sh
curl -s -X PUT $Z/api/settings -H "$AUTH" -H "$JSON" -d '{"approvals":{"memory_remember":"ask"}}' | jq -c '{approvals, reviewer}'
TASK=$(curl -s -X POST $Z/api/tasks -H "$AUTH" -H "$JSON" \
  -d '{"instructions":"Remember that I prefer metric units, using memory_remember.","tools":["memory_remember"]}' | jq -r .id)
until curl -s -H "$AUTH" $Z/api/tasks | jq -e --arg id "$TASK" '.[] | select(.id == $id) | .status | IN("queued","running") | not' >/dev/null; do sleep 2; done
curl -s -H "$AUTH" $Z/api/tasks | jq --arg id "$TASK" '.[] | select(.id == $id) | {status, result, steps: [.events[] | select(.type == "step") | .text]}'
```

```json
{"approvals":{"memory_remember":"ask"},"reviewer":"auto"}
{
  "status": "review",
  "result": "Got it—I’ve noted that you prefer metric units.",
  "steps": [
    "Reviewer let memory_remember run: Owner explicitly asked to remember preference",
    "Got it—I’ve noted that you prefer metric units."
  ]
}
```

The reviewer read your instruction, found that you asked for exactly this action, and let the call run without an approval. `review` means the one-shot task finished and waits for you to look at it. If the model writes no closing report, `result` is `(finished without a written result)`; one of the runs got that.

### 4. A question, then an approval

Turn the reviewer off so a `write` tool set to Ask always waits for you, and start a task that has to ask first:

```sh
curl -s -X PUT $Z/api/settings -H "$AUTH" -H "$JSON" -d '{"reviewer":"off"}' | jq -c '{reviewer, approvals}'
TASK=$(curl -s -X POST $Z/api/tasks -H "$AUTH" -H "$JSON" \
  -d '{"instructions":"Ask me with ask_person whether I want temperatures in Celsius or Fahrenheit (choices: Celsius, Fahrenheit). Then save my answer with memory_remember.","tools":["memory_remember"]}' | jq -r .id)
wait_task() {
  until curl -s -H "$AUTH" $Z/api/tasks | jq -e --arg id "$1" '.[] | select(.id == $id) | .status | IN("queued","running") | not' >/dev/null; do sleep 2; done
  curl -s -H "$AUTH" $Z/api/tasks | jq --arg id "$1" '.[] | select(.id == $id) | {status, question, result, error}'
}
wait_task $TASK
```

```json
{"reviewer":"off","approvals":{"memory_remember":"ask"}}
{
  "status": "needs_input",
  "question": {
    "question": "Do you prefer temperatures in Celsius or Fahrenheit?",
    "choices": ["Celsius", "Fahrenheit"],
    "askedAt": "2026-10-28T03:37:59.814Z"
  },
  "result": null,
  "error": null
}
```

Answer it. The run resumes and stops at the approval:

```sh
curl -s -X POST $Z/api/tasks/$TASK/answer -H "$AUTH" -H "$JSON" -d '{"text":"Celsius"}' | jq -c '{status}'
wait_task $TASK
curl -s -H "$AUTH" "$Z/api/approvals?status=pending" | jq '.[] | {id, tool, risk, summary, reason, preview: .preview.fullText}'
```

```json
{"status":"running"}
{
  "status": "waiting",
  "question": null,
  "result": null,
  "error": null
}
{
  "id": "53eba0b2-264c-4112-8ef4-6ce2d66c385b",
  "tool": "memory_remember",
  "risk": "write",
  "summary": "Remember \"Prefers temperatures in Celsius\"",
  "reason": null,
  "preview": "Remember \"Prefers temperatures in Celsius\"\n\nPrefers temperatures in Celsius"
}
```

`reason` is null because this is a plain policy ask. A safety-floor or reviewer ask says why.

### 5. Approve, then read the answer

```sh
APPROVAL=$(curl -s -H "$AUTH" "$Z/api/approvals?status=pending" | jq -r --arg id "$TASK" '.[] | select(.taskId == $id) | .id')
curl -s -X POST $Z/api/approvals/$APPROVAL -H "$AUTH" -H "$JSON" -d '{"approve":true}' | jq -c '{status, decidedAt}'
curl -s -X POST $Z/api/approvals/$APPROVAL -H "$AUTH" -H "$JSON" -d '{"approve":true}'; echo
wait_task $TASK
curl -s -X POST $Z/api/tasks/$TASK/resolve -H "$AUTH" | jq -c '{status}'
curl -s -H "$AUTH" "$Z/api/memories?status=unreviewed" | jq -c '.[] | {id, text, status}'
```

```
{"status":"approved","decidedAt":"2026-10-28T03:38:08.109Z"}
{"error":"Approval is already approved"}
{
  "status": "review",
  "question": null,
  "result": "✅ Asked you for temperature preference and recorded your choice.  \nYou prefer **Celsius**.",
  "error": null
}
{"status":"done"}
{"id":"16b307bd-d3e6-49b9-bbbb-cbbd9e03f9c0","text":"Prefers temperatures in Celsius","status":"unreviewed"}
{"id":"271ad2d2-b647-432f-a0f1-c207b30d8f38","text":"Prefers metric units","status":"unreviewed"}
```

The second decision is a `409`. Memories z writes itself wait as `unreviewed` (`Settings.memoryReview`) and are not used until you confirm them with `POST /api/memories/:id/confirm`.

### 6. Chat

```sh
curl -sN -X POST $Z/api/chat -H "$AUTH" -H "$JSON" -d '{
  "id": "thread-1",
  "messages": [{"id": "m1", "role": "user", "parts": [{"type": "text", "text": "Reply with one word: ready?"}]}]
}'
curl -s -H "$AUTH" $Z/api/threads | jq -c
```

The stream is shown [above](#chat-stream). The thread is saved:

```json
[{"id":"thread-1","title":"Reply with one word: ready?","updatedAt":"2026-10-28T03:39:03.304Z"}]
```

To continue the conversation, send the whole `messages` array again with the assistant's reply and your next message, under the same `id`.

### 7. Watch live events

```sh
curl -sN "$Z/api/events?token=$Z_TOKEN"
```

Leave it running while you make changes from another terminal. Each change arrives as a `data:` line ([Live events](#live-events)).

---

Steps 1–6 were run as one script on 2026-10-28 against z 0.1.0 (the server on another port, the token read from a file). The outputs are from that run, except the chat chunks, which come from an earlier identical run. Step 7 was run with a webhook channel being saved meanwhile. A free model's wording, and whether the reviewer proceeds, will differ from run to run.
