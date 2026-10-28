# z

An open-source, self-hosted AI agent that brings your own keys.

- **Proactive** — a morning briefing with suggested next steps, tasks you delegate that keep running while you're away (once or on a schedule), standing *watches* that only speak up when something new matters, and long-term memory you can read and edit. It asks before it acts — and reaches you to ask, by push or in your own chat app.
- **Summonable** — mention it in Telegram, Slack, Discord, X or any webhook ("@z is this true?") and it researches, gives a verdict and links the sources it actually read.
- **BYOK, properly** — any provider (OpenAI, Anthropic, Google, xAI, OpenRouter, Ollama, any OpenAI-compatible endpoint). Keys are encrypted on your server and never sent back to the browser. Each job (chat, agent, briefing, bot, fast) has its own ordered fallback chain of models, with usage and an optional monthly budget per provider.
- **Extensible** — tools, briefing sources and channel adapters are plain TypeScript plugins.

## Compared with Claude Duet and the Grok bot

| | Claude Duet | Grok on X | z |
| --- | --- | --- | --- |
| Models | Claude only | Grok only | Any provider, per-job fallback chains, local models |
| Where it lives | Anthropic's app | X | Your server; web app is an installable PWA |
| Asking before acting | In the Duet app | — | Push notification with Approve/Deny, or buttons in your Telegram/Discord/Slack, per-tool policy |
| Proactive work | Morning summary, tasks | — | Briefing with suggestions and proposed tasks, scheduled tasks, watches with de-duplication |
| Memory | Built in | — | Built in, visible and editable, never exposed to channel bots |
| Browser | In its VM | — | Headless Chromium plugin; clicks/typing need approval; SSRF-guarded proxy |
| Sensitive data | Refuses card numbers | — | Blocks card numbers, IBANs, private keys and API keys from leaving via write/external tools |
| "Is this true?" | — | On X, with live search | On X, Telegram, Discord, Slack and webhooks; verdict + validated sources; provider-native search when your key has it |
| Extending it | — | — | TypeScript plugins: tools, briefing sources, channel adapters |

Measured, not claimed: `pnpm eval:factcheck` reported 75.9% verdict accuracy and a 100% citation rate on its 30 claims with keyless gpt-oss-20b (Pollinations), p50 16 s. Duet and Grok weren't run on the same set.

## Run

```sh
pnpm install
pnpm dev            # server on :8787, web on :5173
```

Open the web app, add a provider under **Models**, pick models for each lane, done.

No key yet? Two free, keyless OpenAI-compatible endpoints work out of the box (anonymous rate limits, fine for trying z):

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
| `Z_TOKEN` | unset | Require `Authorization: Bearer <token>` on `/api` — set it whenever the server is reachable by others |
| `Z_PUBLIC_URL` | unset | Public base URL, needed for webhook channels (Slack, Telegram webhook mode) and as the OAuth redirect for connectors |
| `Z_PLUGINS` | unset | Comma-separated module paths of extra plugins |
| `Z_VAPID_SUBJECT` | `Z_PUBLIC_URL` if https, else `mailto:z@localhost` | Contact push services see for Web Push (`mailto:` or `https:`) |
| `Z_ALLOW_PRIVATE_MCP` | unset | `1` lets connectors reach MCP servers on localhost, your LAN and plain `http` (blocked by default) |

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
- **OAuth** (Linear, Notion, Pipedream, any server that advertises it) uses discovery, dynamic client registration and PKCE; tokens are stored encrypted and refreshed automatically. The provider redirects back to `/oauth/callback`, so set `Z_PUBLIC_URL` in production; without it z uses the address you opened it on.
- **Network safety.** Connector requests (including OAuth discovery) must be `https` to public addresses; localhost, private ranges and cloud metadata are refused and redirects are not followed. Set `Z_ALLOW_PRIVATE_MCP=1` to use a self-hosted MCP server on your own network.
- **Aggregators hold your tokens.** Composio, Zapier and Pipedream keep the OAuth tokens for every app you connect through them and run the calls on their servers; Composio and Zapier bill per tool call (Zapier: two tasks per call). Connect the app's own MCP server instead when it has one.

## Fact checks

Reply to a post with "@z is this true?" and z researches before it answers: the routed model's own web search when its provider has one (Anthropic, OpenAI, Google, xAI incl. X search, OpenRouter's web plugin), the Web plugin's Tavily / Brave / SearXNG search when configured, and keyless Wikipedia, Wikidata and Hacker News lookups always. The reply leads with a verdict (True / False / Misleading / Unverified), says why in a sentence or two, and links sources — only pages a tool actually returned, rendered in each platform's style (one link on X, a sources line elsewhere, a `sources` array from the webhook). Images on the post go to vision models; models without vision answer without them and say so.

`pnpm eval:factcheck` runs the real bot path over `scripts/factcheck.jsonl` (30 labeled claims, some in Vietnamese) and prints accuracy, citation rate and p50/p95 latency. It defaults to keyless LLM7 `gpt-oss:20b`; see the script header for flags.

## Reach me

z asks wherever you are, not only in its own tab. Approvals, finished one-shot tasks and briefings become notices that are:

- **pushed to your devices** — install z (it is a PWA) and turn on *Settings → Reach me → Notifications on this device*. Approval notifications carry **Approve / Deny** buttons that work without opening the app.
- **sent to your owner channel** with buttons — in *Settings → Reach me*, choose **Pair a channel** and send the `/link 123456` it shows to your z bot on Telegram, Discord, Slack or a webhook (in Slack, start with the mention: `@z /link 123456`). Only the paired person can press the buttons. The webhook adapter POSTs notices to its *Notify URL* and takes button presses as `POST /hooks/:id {"action": "approve:<id>", "threadId", "authorId"}` with `X-Z-Secret`.

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
