# Security

This page tells you who can reach what in a z install, what is protected and how, and where the limits are, so you can decide how to expose it. To report a vulnerability, see [Reporting](#reporting-a-vulnerability).

## Who can reach what

| Who | How | What they get |
| --- | --- | --- |
| **You, the owner** | The web app and `/api/*`, with the bearer token whenever z listens beyond loopback | Everything: settings, providers, tasks, approvals, memories, chats |
| **Your paired channel account** | Buttons and `/link` in Telegram, Discord, Slack or the webhook | Approve or deny approvals and answer task questions. The server checks the press came from the paired author in the paired channel |
| **Strangers** | Messages to a bot channel (`/hooks/:id`, or what a connect-mode adapter receives) | The bot: an answer built with public read tools only. No memory, no approvals, no write tools |
| **Pages, feeds, tool results, MCP servers** | Text that flows into a model's context | Nothing directly. z treats all of it as untrusted input: it can shape what a model proposes, and the approval pipeline below decides what runs |

### The API token

- On loopback (`Z_HOST` defaults to `127.0.0.1`) the API runs without a token: only processes on this machine can reach it.
- On any other host, z requires a token. It uses `Z_TOKEN`, or generates 24 random bytes into `Z_DATA_DIR/access.token` (mode 0600). The log names the file, never the token.
- Every `/api` route, `/api/health` included, checks `Authorization: Bearer <token>` (or `?token=` for EventSource) in constant time. A miss is `401 {"error":"Unauthorized"}`.
- Not under the token: `POST /hooks/:channelId`, which each adapter verifies with the platform's own scheme, and `GET /oauth/callback`, where the single-use OAuth state is the check. The built web app's static files are public too; they contain no data.

The token is one shared secret with full access. Treat it like a password, and put TLS in front of anything that leaves your machine ([deploy](deploy.md#behind-a-reverse-proxy)).

## What is encrypted at rest

Secrets are sealed with AES-256-GCM (`v1.<iv>.<tag>.<ciphertext>`, random 12-byte IV) using the **master key**: `Z_MASTER_KEY` (32 bytes, hex or base64) or `master.key` in the data directory, generated on first run with mode 0600.

Sealed:

- provider API keys
- channel config (bot tokens, signing secrets) and channel state values (cursors, rotated X refresh tokens)
- connector URLs, header values and OAuth state (tokens, client registration, PKCE verifier)
- plugin settings
- saved sign-ins (username, password, TOTP secret)
- Web Push subscription keys and the server's VAPID key pair

Stored in plaintext in `z.db`: settings and the approval policy, tasks and their logs, approvals (including tool inputs), briefings, memories, chat threads, bot thread history, notices. Anyone who can read the data directory can read these. Anyone who has both the database and the master key can read everything.

The API never returns a secret. Views carry `hasKey` and the last four characters (`keyHint`), the config and header *keys* that have a value, and connector URLs reduced to `https://host/…`. Saved sign-ins are only handed to the built-in browser plugin, which types them into the page itself; the model gets `{ signedIn, url, title, note }`.

Losing the master key makes every sealed value unreadable; see [backups](deploy.md#backups).

## Approvals

Every tool declares a risk: `read`, `write` or `external` ([plugins](plugins.md#risk-and-approvals)). Reads run without asking unless you set them to Ask; a read set to Deny is never offered. A call to a `write` or `external` tool passes these checks, in this order:

1. **Sensitive-data guard.** If the tool input contains a payment card number (issuer prefix and Luhn check), an IBAN (mod-97 check), a PEM private key or a common API key format (`sk-…`, GitHub `ghp_…`/`github_pat_…`, Slack `xox…`, AWS `AKIA…`, Google `AIza…`), the call is refused outright: `blocked: contains a card number`. No approval is asked, since approving would not make it safe.
2. **Safety floor.** Calls whose tool name, description, summary or arguments mention credentials (passwords, 2FA codes, API keys, tokens), security or sharing settings, payments, or deleting an account always go to you, whatever your policy says and whatever the reviewer would decide. The card names the reason ("Asking because it pays, buys or moves money…").
3. **Per-tool policy** (**Settings → Approvals**, `Settings.approvals`): `allow`, `ask` or `deny`. Deny removes the tool from every run. `external` tools always ask: a stored `allow` is ignored for them, and *Remember* on an approval never turns one into allow.
4. **Reviewer** (`Settings.reviewer`, `auto` by default), for `write` tools only. A model on the `fast` lane (or `agent` when `fast` is empty) reads the conversation, with your messages marked as yours and every tool result fenced as untrusted, and decides whether you explicitly asked for this exact action on this exact target. With `auto` it may run a `write` tool set to Ask that you clearly asked for, and it can send a tool you set to Allow back to you. It **fails closed**: no model, an error, an 8-second timeout or an unparseable answer all become "ask". In a real run against a slow free model the card said *Asking because the safety check took too long.*

What waits for you is a full preview: recipients, subject and body first, then every other argument, nothing cut, with values of keys that look like secrets masked. Push notifications and channel messages carry **Approve** only when that whole preview fits the medium. Otherwise they say "Open z to review", and **Deny** is always offered.

Unattended runs are narrower. Watches only get `read` tools that need no approval. The briefing calls plugin briefing sources and no tools. If z restarts in the middle of a `write` or `external` call, that task is marked `interrupted` and never replayed.

## Bots and strangers

Anyone who can message a bot can make z spend your model budget and make it read the web. So the bot path is built separately:

- It only gets tools that are `read`, open under your policy, and marked `public`: web search, page fetch, Wikipedia, Wikidata and Hacker News, plus the `read` tools of connectors you marked **public**, and the routed provider's own web search. Plugin tools marked `ownerOnly` (memory, saved sign-ins) are never offered, even if also marked public. The bot runtime re-checks this list and throws if anything else slips in.
- It never sees your long-term memory: the bot's dependencies have no memory field, and the memory tools are owner-only. It remembers the last 20 turns of the platform thread it answers in, and nothing else.
- It cannot ask for approvals and has no write tools, so nothing a stranger says can make z act for you.
- Sources in replies are only URLs a tool actually returned. URLs the model made up are dropped.
- **Limits** (per channel, before any model call): by default 4 answers at once with 20 waiting, and per author 2 in flight and 10 an hour. Over a cap the author gets one "busy, try again in N min" reply, then silence. The paired owner is never capped.
- **Pairing** uses a 6-digit code that is valid for 10 minutes and works once. Five wrong guesses void it. A code posted on a channel that can't carry private messages (X) is voided at once.

## Webhook signing

A webhook channel only runs signed requests:

```
X-Z-Timestamp: <unix seconds>
X-Z-Delivery:  <unique id, [A-Za-z0-9._:-], up to 200 chars>
X-Z-Signature: v1=<hex HMAC-SHA256(secret, "<timestamp>.<delivery>.<raw body>")>
```

The signature is checked over the raw bytes before parsing, in constant time. A missing, stale (more than 5 minutes off) or wrong signature gets `401` and nothing runs. Bodies over 512,000 bytes are refused. A delivery id seen in the last 7 days gets `200 {"duplicate": true}` without running again. A delivery that failed with a 5xx is released so the same id can be retried. Owner notices that z POSTs to the channel's *Notify URL* carry the same three headers. A verifier and a signed `curl` are in the [README](../README.md#webhooks). Running that `curl` three times with one delivery id gave one answer and two `{"duplicate":true}` replies, an unsigned request got `401 Missing X-Z-Signature`, and a reused signature with a new delivery id got `401 Invalid X-Z-Signature`.

Channels created before signing keep *legacy mode* (a bare `X-Z-Secret` header). Turn it off once your integration signs.

Other adapters verify their platform's scheme. Slack checks `X-Slack-Signature` (HMAC-SHA256 over `v0:<timestamp>:<body>`, 5-minute window). Telegram in webhook mode checks `X-Telegram-Bot-Api-Secret-Token`, which is derived from the bot token when you set no secret.

## Network guards (SSRF)

z fetches URLs that models and strangers can influence, so outbound requests are checked:

- **`fetch_page`** (web plugin) only fetches http(s) URLs whose host resolves to public addresses. Localhost, `.local`/`.internal` names, RFC 1918 and CGNAT ranges, link-local and cloud metadata (169.254.0.0/16), IPv6 ULA and link-local, and IPv4-mapped forms of these are all refused. Every redirect hop is re-checked, up to 5. DNS is resolved by the check and again by `fetch`, so a fast DNS-rebinding attacker could still race it.
- **Browser plugin.** Chromium is forced through a local guard proxy that applies the same rules to every navigation, redirect hop, subresource, worker request and WebSocket. The proxy connects to the address it checked, so rebinding can't swap it. `Z_ALLOW_PRIVATE_BROWSER=1` lifts the private-address rule.
- **Connectors.** Every MCP request, OAuth discovery included, must be https to a public address, and redirects are refused. `Z_ALLOW_PRIVATE_MCP=1` allows localhost, the LAN and plain http for your own MCP servers.
- **Web Push** endpoints must be https.

Plugins are not sandboxed. A plugin loaded with `Z_PLUGINS` runs inside the server process, with its decrypted settings and unrestricted `fetch`. Only load code you trust.

## Logs and diagnostics

Every secret the server decrypts or is given registers with a redaction filter that wraps stdout and stderr before anything else runs. That covers provider keys, channel and connector secrets, OAuth tokens, saved sign-ins, the VAPID key, `Z_TOKEN` and the master key, including their `Bearer `, URL-encoded and JSON-escaped forms. Each occurrence is printed as `[secret:<last4>]`, whether it appears in an error, a stack trace or a plugin's log line. Values shorter than 6 characters are not registered.

**Settings → Setup → Copy diagnostics** (`GET /api/diagnostics`) contains the last 200 log lines, redacted again, plus provider and connector origins only, and is run through the redactor once more before it is sent. Provider test errors are redacted too, because some providers quote the key back.

## Free keyless providers

The keyless endpoints suggested for a first try (LLM7, Pollinations) are third-party services with anonymous, per-IP rate limits. **They see everything z sends the model**: your messages, the persona, the memories recalled for owner runs, tool results (pages, feeds, connector data) and the tool definitions. Don't use them for private mail, tasks or memories. For private use, bring your own API key for a provider whose terms you accept.

## Codex CLI provider

The `codex-cli` provider runs the Codex CLI as a child process on the server. Codex keeps its own sign-in, and z never reads it. The process gets no `Z_*` environment variables and none whose names look like keys, tokens, secrets or passwords. Codex's own shell, file, MCP and web tools are off, its sandbox is read-only in an empty directory, and every approval it asks for is declined, so it can only act through z's tools and z's approvals. Everything z sends the model goes to OpenAI under your ChatGPT account. OpenAI hasn't published terms for third-party apps using ChatGPT plans. See [architecture](architecture.md#codex-cli).

## Reporting a vulnerability

Please report it privately through [GitHub security advisories](https://github.com/skinnx/z/security/advisories/new), not in a public issue. See [SECURITY.md](../SECURITY.md).
