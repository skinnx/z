# z

An open-source, self-hosted AI agent that brings your own keys.

- **Proactive** — a morning briefing with suggested next steps, tasks you delegate that keep running while you're away (once or on a schedule), standing *watches* that only speak up when something new matters, and long-term memory you can read and edit. It asks before it acts — and reaches you to ask, by push or in your own chat app.
- **Summonable** — mention it in Telegram, Slack, Discord, X or any webhook ("@z is this true?") and it researches, gives a verdict and links the sources it actually read.
- **BYOK, properly** — any provider (OpenAI, Anthropic, Google, xAI, OpenRouter, Ollama, any OpenAI-compatible endpoint). Keys are encrypted on your server and never sent back to the browser. Each job (chat, agent, briefing, bot, fast) has its own ordered fallback chain of models, with usage and an optional monthly budget per provider.
- **Extensible** — tools, briefing sources and channel adapters are plain TypeScript plugins.

## What z adds over Claude Duet and the Grok bot

Duet and Grok are closed, single-vendor products; the rows below describe z, not a scorecard of theirs.

- **Any model, your keys:** per-job fallback chains across providers, local models included. Nothing is sent to us; there is no "us".
- **Asks where you are:** push notifications with Approve/Deny, or buttons in your own Telegram/Discord/Slack — and only when the whole action fits on screen; otherwise "open z to review".
- **Checks before it acts:** a fixed safety floor for payments and credentials, your per-tool policy, then a reviewer model that fails closed; outgoing card numbers, IBANs and keys are blocked outright.
- **Proactive without noise:** a briefing that separates what needs you from what can wait, scheduled tasks that report failures once, watches that only speak up when something is new, tasks that stop and ask you a question.
- **"@z is this true?" anywhere:** X, Telegram, Discord, Slack or a webhook, answering with a verdict and sources it actually read.
- **Memory you control:** visible, editable, pinnable; what z learns waits for your review; channel bots never see it.
- **Open and extensible:** MIT, self-hosted, TypeScript plugins, MCP connectors (Composio, Zapier, Pipedream, GitHub, Linear, Notion, your own).

`pnpm eval:factcheck` (30 labelled claims) and `pnpm eval:triage` measure the bot and the briefing on your own model. The one fact-check run recorded so far — keyless gpt-oss-20b via Pollinations — scored 75.9% verdict accuracy with sources on every answer; treat a single run on 30 items as a smoke test, not a benchmark.

## Run

```sh
pnpm install
pnpm dev            # server on :8787, web on :5173
```

Open the web app, add a provider under **Models**, pick models for each lane, done.

No key yet? Two free, keyless OpenAI-compatible endpoints work for a first try. They are third-party services with anonymous, per-IP rate limits, and **they see everything you send them** — don't use them for private mail, tasks or memories. For private use, bring a key or run a local model (Ollama, LM Studio).

| Provider | Base URL | Models with tool calling |
| --- | --- | --- |
| LLM7 | `https://api.llm7.io/v1` | `gpt-oss:20b`, `nemotron-3-nano:30b`, `codestral-latest` |
| Pollinations | `https://text.pollinations.ai/openai` | `openai-fast` |

Production:

```sh
pnpm --filter @z/web build
pnpm --filter @z/server start   # serves the built web app on :8787
```

or `docker build -t z . && docker run -p 8787:8787 -v z-data:/data z`.

### Configuration

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8787` | |
| `Z_DATA_DIR` | `./.data` | SQLite database and generated master key |
| `Z_MASTER_KEY` | generated into `Z_DATA_DIR/master.key` | 32-byte key (hex or base64) encrypting provider keys and channel secrets |
| `Z_HOST` | `127.0.0.1` | Interface to listen on. The Docker image sets `0.0.0.0` |
| `Z_TOKEN` | unset | Bearer token for `/api`. When `Z_HOST` is not loopback and this is unset, z generates one into `Z_DATA_DIR/access.token` instead of running open |
| `Z_PUBLIC_URL` | unset | Public base URL, needed for webhook channels (Slack, Telegram webhook mode) and as the OAuth redirect for connectors |
| `Z_PLUGINS` | unset | Comma-separated module paths of extra plugins |
| `Z_VAPID_SUBJECT` | `Z_PUBLIC_URL` if https, else `mailto:z@localhost` | Contact push services see for Web Push (`mailto:` or `https:`) |
| `Z_ALLOW_PRIVATE_MCP` | unset | `1` lets connectors reach MCP servers on localhost, your LAN and plain `http` (blocked by default) |
| `Z_ALLOW_PRIVATE_BROWSER` | unset | `1` lets the Browser plugin open localhost and your LAN (a self-hosted app, a local test login page); blocked by default |

## Layout

```
packages/core      shared contract (contract.ts), plugin API (plugin.ts), agent/bot/briefing/chat runtime
packages/plugins   built-in plugins: web, browser, rss, github, clock, channel adapters
apps/server        Hono + node:sqlite: API, scheduler, secrets vault, channel runtime
apps/web           React 19 + Base UI + Tailwind v4 + lucide
```

`packages/core/src/contract.ts` is the single source of truth for every type and route that crosses a boundary.

## Approvals

Every tool declares a risk:

| Risk | Examples | Default |
| --- | --- | --- |
| `read` | search, fetch a page, read a feed | runs |
| `write` | create a draft, change a local file | asks |
| `external` | post publicly, send a message, open an issue | always asks |

Change the policy per tool under **Settings**. Bots answering in channels only ever get `read` tools that are marked `public` (web search and reference lookups, never your notifications, feeds or browser), so strangers can't make z act on your behalf or read your data.

## Connectors

A connector plugs any [MCP](https://modelcontextprotocol.io) server into z as a data source: its tools join chat, tasks, watches and (if you allow it) the bot, under the same approval policy, sensitive-data guard and task log as plugin tools. No vendor is required; presets are only starting points:

| | Presets |
| --- | --- |
| Docs | DeepWiki, Context7, Cloudflare Docs, GitMCP (`https://gitmcp.io/{owner}/{repo}`) |
| Dev | Hugging Face, GitHub (personal access token), Custom (any Streamable HTTP or SSE server) |
| Work | Linear, Notion (OAuth) |
| Aggregators | Composio, Zapier (connection token), Pipedream (OAuth) |

Each tool gets a risk from the server's annotations, which are hints from a third party: `readOnlyHint` → `read`, `destructiveHint` or `openWorldHint` → `external`, other hints → `write`, no hints at all → `write` (so it asks). Override any tool's risk per connector. Tools are named `mcp_<connector>_<tool>` in approvals and policies. Only connectors you mark **public** offer their `read` tools to the bot.

- **URLs and headers are secrets.** They are stored encrypted and never returned or logged (the app shows `https://host/…`), since services like Zapier put the key in the URL.
- **OAuth** (Linear, Notion, Pipedream, any server that advertises it) uses discovery, dynamic client registration and PKCE; tokens are stored encrypted and refreshed ahead of expiry. The provider redirects back to `/oauth/callback`, so set `Z_PUBLIC_URL` in production; without it z uses the address you opened it on, or `http://localhost:<port>` when that is plain http on a LAN or Tailscale address (providers only accept http for localhost). When the browser then lands on a page that doesn't load, paste its address into the connector's *Browser didn't come back?* box: the state in it is checked and single use, like the real callback.
- **When a sign-in ends.** A refresh rejected with `invalid_grant` drops the tokens (sign in again); `invalid_client` also drops z's app registration, so the next sign-in registers anew; an unreachable server or a 5xx keeps everything and retries with backoff. Deleting a connector revokes its tokens at the provider (RFC 7009) in the background.
- **Network safety.** Connector requests (including OAuth discovery) must be `https` to public addresses; localhost, private ranges and cloud metadata are refused and redirects are not followed. Set `Z_ALLOW_PRIVATE_MCP=1` to use a self-hosted MCP server on your own network.
- **Saved sign-ins.** Settings → Security keeps logins (origin, username, password, optional authenticator secret), sealed with the master key and never returned by the API. `browser_sign_in` fills them into the page through Playwright only when the page's origin exactly matches (re-checked before each fill and after redirects; plain `http` only for localhost), submits, and enters a TOTP code when asked. The model only gets `{ signedIn, url, title, note }`.
- **Aggregators hold your tokens.** Composio, Zapier and Pipedream keep the OAuth tokens for every app you connect through them and run the calls on their servers; Composio and Zapier bill per tool call (Zapier: two tasks per call). Connect the app's own MCP server instead when it has one.

## Fact checks

Reply to a post with "@z is this true?" and z researches before it answers: the routed model's own web search when its provider has one (Anthropic, OpenAI, Google, xAI incl. X search, OpenRouter's web plugin), the Web plugin's Tavily / Brave / SearXNG search when configured, and keyless Wikipedia, Wikidata and Hacker News lookups always. The reply leads with a verdict (True / False / Misleading / Unverified), says why in a sentence or two, and links sources — only pages a tool actually returned, rendered in each platform's style (one link on X, a sources line elsewhere, a `sources` array from the webhook). Images on the post go to vision models; models without vision answer without them and say so.

`pnpm eval:factcheck` runs the real bot path over `scripts/factcheck.jsonl` (30 labeled claims, some in Vietnamese) and prints accuracy, citation rate and p50/p95 latency. It defaults to keyless LLM7 `gpt-oss:20b`; see the script header for flags.

## Reach me

z asks wherever you are, not only in its own tab. Approvals, finished one-shot tasks and briefings become notices that are:

- **pushed to your devices** — install z (it is a PWA) and turn on *Settings → Reach me → Notifications on this device*. Approval notifications carry **Approve / Deny** buttons that work without opening the app.
- **sent to your owner channel** with buttons — in *Settings → Reach me*, choose **Pair a channel** and send the `/link 123456` it shows to your z bot on Telegram, Discord, Slack or a webhook (in Slack, start with the mention: `@z /link 123456`). Only the paired person can press the buttons. The webhook adapter POSTs notices to its *Notify URL* as `{"type": "notice", "id", "threadId", "text", "actions"}` and takes button presses as `POST /hooks/:id {"action": "approve:<id>", "threadId", "authorId"}`, signed like any webhook call (below).

A task's question (`ask_person`) keeps its choices as buttons in the app's inbox, on the notification (up to two choices, plus *Open*) and in the owner channel. Answer it in any of those places and the others close: the inbox buttons go away, and Telegram, Slack and Discord messages are edited to show the answer (decided approvals likewise show *Approved* or *Denied*). The webhook adapter gets a `{"type": "notice.update", "id", "text", "actions": []}` for the notice with that `id`.

**Delivery is durable.** Each notice is stored with one delivery per device and one for the owner channel before anything is sent. A failed try (the channel is down, the notify URL answers 5xx, a push service errors) is retried after 30 s, 2 min, 10 min, 1 h and 6 h; after 6 tries it is marked failed and logged. Waiting deliveries survive a restart. Deliveries for an approval that was already decided, or a question already answered, are dropped instead of sent. A device whose push subscription is gone (404/410) is removed. Every try of one delivery carries the same `X-Z-Delivery` id, so a receiver can de-duplicate.

**Recurring tasks stay quiet when nothing changed.** A recurring task notifies on success only when the run didn't call `no_update` and its result differs from the last successful run's (compared after collapsing whitespace) — or when it ends a failure streak. The first failure of a streak always notifies; 10 in a row pause the task. If z was down when a run was due, it runs the task **once** at startup (not once per missed slot) when the miss is under 24 hours old, and otherwise skips it with a note in the task's log. Create the task with `"missedPolicy": "skip"` to always skip missed runs.

## Webhooks

A webhook channel answers `POST /hooks/:id` with JSON `{ "text", "author"?, "threadId"?, "messageId"?, "context"?, "images"? }` → `{ reply, verdict, sources, threadId, messageId }`. Every request is signed with the channel's secret:

| Header | Value |
| --- | --- |
| `X-Z-Timestamp` | Unix time in seconds; more than 5 minutes off is refused |
| `X-Z-Delivery` | A unique id per delivery (a UUID); `[A-Za-z0-9._:-]`, up to 200 characters |
| `X-Z-Signature` | `v1=` + hex HMAC-SHA256(secret, `<timestamp>.<delivery>.<raw body>`) |

z checks the signature over the raw bytes before parsing anything, in constant time; a bad, missing or stale signature is a `401` and nothing runs. A delivery id seen in the last 7 days answers `200 {"duplicate": true}` without running again, so retries are safe (a delivery that failed with a 5xx is forgotten and can be retried). Owner notices z POSTs to the *Notify URL* carry the same three headers; verify them the same way:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(secret, headers, rawBody) {
  const ts = headers["x-z-timestamp"], id = headers["x-z-delivery"];
  const expected = Buffer.from("v1=" + createHmac("sha256", secret).update(`${ts}.${id}.${rawBody}`).digest("hex"));
  const got = Buffer.from(headers["x-z-signature"] ?? "");
  return Math.abs(Date.now() / 1000 - Number(ts)) <= 300 && got.length === expected.length && timingSafeEqual(got, expected);
}
```

```sh
body='{"text":"is this true? the Eiffel Tower is in Berlin","author":"ann"}'
ts=$(date +%s); id=$(uuidgen)
sig=$(printf '%s' "$ts.$id.$body" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')
curl -X POST "$Z_PUBLIC_URL/hooks/my-hook" -H 'content-type: application/json' \
  -H "X-Z-Timestamp: $ts" -H "X-Z-Delivery: $id" -H "X-Z-Signature: v1=$sig" -d "$body"
```

Channels created before signing keep working in *legacy mode* (a bare `X-Z-Secret: <secret>` header, unsigned); it is off for new channels — turn it off in the channel's settings once your integration signs.

**Limits.** Anyone who can reach a bot can spend your keys, so each channel caps it: by default 4 answers at once with 20 waiting, and per person 2 in flight and 10 an hour (send `author` from webhooks, or every caller counts as one person). Over a cap the person gets one "busy, try again in N min" reply, with no model call, then silence until they are under it again. Your paired owner account is never capped. Change the numbers under *Limits* in the channel's settings.

## Browser

The **Browser** plugin gives the agent a real headless Chromium (JavaScript, logins, forms) through [playwright-core](https://playwright.dev), an optional dependency:

```sh
pnpm install                       # includes playwright-core unless optional deps are skipped
npx playwright install chromium    # or set "Chrome/Chromium executable path" in the plugin settings
```

Without it the plugin shows as unavailable with these instructions. To drive a Chrome you already run, start it with `--remote-debugging-port=9222` and set the CDP URL; z opens its own isolated context there and only disconnects when done.

| Tool | Risk | |
| --- | --- | --- |
| `open`, `read` | `read` | Page text with numbered elements (`[12] button "Sign in"`); `read` can scope to a selector or element, or `find` lines |
| `screenshot` | `read` | Viewport PNG, handed to vision models |
| `click`, `type`, `select` | `write` | Approval cards name the element and site: `Click "Place order" on shop.example.com` |
| `submit` | `external` | Type (optionally) and press Enter — sends data to the site |

All browser traffic goes through a local guard proxy that applies `fetch_page`'s SSRF rules to every navigation, redirect hop, subresource and WebSocket, so pages can't reach localhost, your LAN or cloud metadata. Password fields are masked in snapshots and approval cards. The browser starts on first use and closes after 5 idle minutes.

## Writing a plugin

```ts
import { definePlugin, defineTool } from "@z/core";
import { z } from "zod";

export default definePlugin({
  id: "notes",
  name: "Notes",
  description: "Append to a notes service.",
  settings: [{ key: "token", label: "API token", secret: true, required: true }],
  tools: {
    append: defineTool({
      description: "Append a line to today's note",
      risk: "write",
      inputSchema: z.object({ text: z.string() }),
      summarize: ({ text }) => `Append "${text}" to today's note`,
      execute: async ({ text }, ctx) => {
        const res = await ctx.fetch("https://notes.example/api/today", {
          method: "POST",
          headers: { authorization: `Bearer ${ctx.settings.token}` },
          body: JSON.stringify({ text }),
        });
        return { ok: res.ok };
      },
    }),
  },
  // briefing: async (ctx) => [...BriefItem],
  // adapters: [...ChannelAdapter],
});
```

Load it with `Z_PLUGINS=./notes.ts pnpm --filter @z/server start`. Its settings form and approval controls appear in the web app automatically. See `packages/plugins/src` for complete examples, including channel adapters.

## License

MIT
