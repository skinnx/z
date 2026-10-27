# z

An open-source, self-hosted AI agent that brings your own keys.

- **Proactive** — a morning briefing, tasks you delegate that keep running while you're away (once or on a schedule), and it asks before it acts.
- **Summonable** — mention it in Telegram, Slack, Discord, X or any webhook ("@z is this true?") and it answers with the thread's context.
- **BYOK, properly** — any provider (OpenAI, Anthropic, Google, xAI, OpenRouter, Ollama, any OpenAI-compatible endpoint). Keys are encrypted on your server and never sent back to the browser. Each job (chat, agent, briefing, bot, fast) has its own ordered fallback chain of models, with usage and an optional monthly budget per provider.
- **Extensible** — tools, briefing sources and channel adapters are plain TypeScript plugins.

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
| `Z_PUBLIC_URL` | unset | Public base URL, needed for webhook channels (Slack, Telegram webhook mode) |
| `Z_PLUGINS` | unset | Comma-separated module paths of extra plugins |
| `Z_VAPID_SUBJECT` | `Z_PUBLIC_URL` if https, else `mailto:z@localhost` | Contact push services see for Web Push (`mailto:` or `https:`) |

## Layout

```
packages/core      shared contract (contract.ts), plugin API (plugin.ts), agent/bot/briefing/chat runtime
packages/plugins   built-in plugins: web, rss, github, clock, channel adapters
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

Change the policy per tool under **Settings**. Bots answering in channels only ever get `read` tools, so strangers can't make z act on your behalf.

### Reach me

z asks wherever you are, not only in its own tab. Approvals, finished one-shot tasks and briefings become notices that are:

- **pushed to your devices** — install z (it is a PWA) and turn on *Settings → Reach me → Notifications on this device*. Approval notifications carry **Approve / Deny** buttons that work without opening the app.
- **sent to your owner channel** with buttons — in *Settings → Reach me*, choose **Pair a channel** and send the `/link 123456` it shows to your z bot on Telegram, Discord, Slack or a webhook (in Slack, start with the mention: `@z /link 123456`). Only the paired person can press the buttons. The webhook adapter POSTs notices to its *Notify URL* and takes button presses as `POST /hooks/:id {"action": "approve:<id>", "threadId", "authorId"}` with `X-Z-Secret`.

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
