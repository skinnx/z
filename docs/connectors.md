# Connectors

This page shows how to plug an MCP server into z: pick a preset or a custom server, authenticate, check and override each tool's risk, trim large servers, and decide what the bot may use. Connectors live under **Connect** in the web app and `/api/connectors` in the [API](api.md#connectors).

A connector is a [Model Context Protocol](https://modelcontextprotocol.io) server reached over Streamable HTTP (`transport: "http"`, the default) or SSE (`"sse"`). Once connected, its tools join chat, tasks and watches as `mcp_<connector>_<tool>`, under the same approval policy, sensitive-data guard and task log as plugin tools. The server's own usage instructions are shown to the model as tool documentation, never as your instructions.

## Presets

`GET /api/connector-presets` returns the catalog the app shows. Presets are only starting points; any MCP server works.

| Preset | URL | Auth |
| --- | --- | --- |
| DeepWiki | `https://mcp.deepwiki.com/mcp` | none |
| Context7 | `https://mcp.context7.com/mcp` | none (optional `Authorization: Bearer` key raises rate limits) |
| Cloudflare Docs | `https://docs.mcp.cloudflare.com/mcp` | none |
| GitMCP | `https://gitmcp.io/{owner}/{repo}` | none |
| Hugging Face | `https://huggingface.co/mcp` | none (optional access token) |
| GitHub | `https://api.githubcopilot.com/mcp/` | headers: `Authorization: Bearer <personal access token>` |
| Linear | `https://mcp.linear.app/mcp` | OAuth |
| Notion | `https://mcp.notion.com/mcp` | OAuth |
| Composio | `https://connect.composio.dev/mcp` | headers: `x-consumer-api-key` |
| Zapier | `https://mcp.zapier.com/api/v1/connect` | headers: `Authorization: Bearer <connection token>` |
| Pipedream | `https://mcp.pipedream.net/v2` | OAuth |
| Custom | any | any |

**Aggregators hold your tokens.** Composio, Zapier and Pipedream keep the OAuth tokens of every app you connect through them and run the calls on their servers. Composio and Zapier bill per call (Zapier: two tasks per call). When an app has its own MCP server, connect that instead.

## Add one

```sh
curl -s -X PUT $Z/api/connectors/deepwiki -H "$AUTH" -H 'content-type: application/json' \
  -d '{"label":"DeepWiki","url":"https://mcp.deepwiki.com/mcp"}' \
  | jq '{status, statusDetail, urlDisplay, server, tools: [.tools[] | {name, toolName, risk, riskSource}]}'
```

```json
{
  "status": "connected",
  "statusDetail": null,
  "urlDisplay": "https://mcp.deepwiki.com/…",
  "server": { "name": "DeepWiki", "version": "2.14.3" },
  "tools": [
    { "name": "ask_wiki_question", "toolName": "mcp_deepwiki_ask_wiki_question", "risk": "write", "riskSource": "default" },
    { "name": "read_wiki_contents", "toolName": "mcp_deepwiki_read_wiki_contents", "risk": "write", "riskSource": "default" },
    { "name": "read_wiki_structure", "toolName": "mcp_deepwiki_read_wiki_structure", "risk": "write", "riskSource": "default" }
  ]
}
```

`$Z` is your server and `$AUTH` the `Authorization: Bearer …` header, as in the [API walkthrough](api.md#walkthrough). Saving connects at once and lists the tools, which are cached so names survive restarts. A failed connection retries with backoff (5 s doubling, up to 10 min). `POST /api/connectors/:id/refresh` reconnects and lists the tools again.

**URLs and headers are secrets.** Some services put the key in the URL, so the URL is write-only: views show `https://host/…`, header *names* only (`headerKeys`), and logs and status details have both stripped. On update, omit `url` to keep it. For `headers`, omit them to keep, send `{}` to clear, or send one key with an empty value to remove that header.

## Auth modes

| `auth` | Use for |
| --- | --- |
| `none` | Public servers |
| `headers` | A static key or token: `"headers": {"Authorization": "Bearer …"}` |
| `oauth` | Servers that advertise OAuth (Linear, Notion, Pipedream, your own) |

A 401 with `none` or `headers` sets `needs_auth` with a hint ("use OAuth or add an authorization header", "check the header values"). Changing the URL or the auth mode drops stored OAuth tokens and client registration, because they belong to one server.

## OAuth

z runs discovery, dynamic client registration and PKCE itself; you do not register an app. Tokens are sealed in the connector row and refreshed 2 minutes before they expire.

1. Save the connector with `"auth": "oauth"`. It shows `needs_auth`, "Sign in to connect".
2. `POST /api/connectors/:id/oauth` (the **Sign in** button) returns `{ authorizationUrl, redirectUri }`. Open the URL and approve.
3. The provider sends the browser to `redirectUri`, which is `GET /oauth/callback?code&state`. z checks the state (single use, expires after 10 minutes), exchanges the code, connects, and redirects to `/connect?connector=<id>`.

Which redirect URI z asks for:

| Situation | `redirectUri` |
| --- | --- |
| `Z_PUBLIC_URL` set | `$Z_PUBLIC_URL/oauth/callback` |
| Opened on `https://…` or on `http://localhost` | That origin + `/oauth/callback` |
| Opened on plain http at a LAN or Tailscale address | `http://localhost:<PORT>/oauth/callback`, because providers only accept plain http for localhost |

Behind a TLS proxy z sees plain http and does not read `X-Forwarded-Proto`, so set `Z_PUBLIC_URL` there ([deploy](deploy.md#behind-a-reverse-proxy)).

**Paste fallback.** When the callback can't reach z (the localhost case above, or a phone), the browser ends on a page that doesn't load. Copy its full address and paste it into *Browser didn't come back?*, or send it yourself:

```sh
curl -s -X POST $Z/api/connectors/linear/oauth/complete -H "$AUTH" -H 'content-type: application/json' \
  -d '{"url":"http://localhost:8787/oauth/callback?code=…&state=…"}'
```

It runs the same checks as the callback, and the state must be that connector's pending one. A wrong, used or expired state is a `400`:

```json
{"error":"That address doesn't match this connector's pending sign-in (wrong, old or already used state). Paste the address from the latest sign-in, or start again."}
```

**When a sign-in ends.** A refresh answered with `invalid_grant` drops the tokens, and you sign in again. `invalid_client`, `unauthorized_client` or a bare 401 also drops z's client registration, so the next sign-in registers anew. Network errors, timeouts, 429 and 5xx keep everything and retry with backoff. Deleting a connector revokes its tokens at the authorization server (RFC 7009) in the background, best effort.

## Risk mapping

Each tool gets a [risk](plugins.md#risk-and-approvals) from the server's annotations. These are hints from a third party:

| Annotations | Risk | `riskSource` |
| --- | --- | --- |
| `readOnlyHint: true` | `read` | `hint` |
| `destructiveHint` or `openWorldHint` true (and not read-only) | `external` | `hint` |
| Other hints | `write` | `hint` |
| No hints at all | `write`, so it asks | `default` |
| Your override | whatever you set | `user` |

DeepWiki publishes no hints, so all three tools come in as `write`. They only read public documentation, so override them by the server's own tool names:

```sh
curl -s -X PUT $Z/api/connectors/deepwiki -H "$AUTH" -H 'content-type: application/json' \
  -d '{"label":"DeepWiki","public":true,"risks":{"ask_wiki_question":"read","read_wiki_contents":"read","read_wiki_structure":"read"}}' \
  | jq -c '{status, public, tools: [.tools[] | {toolName, risk, riskSource}]}'
```

```json
{"status":"connected","public":true,"tools":[{"toolName":"mcp_deepwiki_ask_wiki_question","risk":"read","riskSource":"user"},{"toolName":"mcp_deepwiki_read_wiki_contents","risk":"read","riskSource":"user"},{"toolName":"mcp_deepwiki_read_wiki_structure","risk":"read","riskSource":"user"}]}
```

Only lower a risk when you know what a tool does. An override applies everywhere, including to the bot (below).

## Trim big servers

Aggregators can expose hundreds of tools, and every tool offered costs prompt tokens. z already offers a run at most 24 connector tools, picked by matching words in the request; a [skill](api.md#skills) can name the tools it needs instead. A tool whose policy is **Deny** is never offered to any run, which is the way to remove tools for good. Set it in the connector's tool list in the app, or in `Settings.approvals` under its `mcp_…` name:

```sh
curl -s -X PUT $Z/api/settings -H "$AUTH" -H 'content-type: application/json' \
  -d '{"approvals":{"mcp_deepwiki_read_wiki_contents":"deny"}}' | jq -c .approvals
```

```json
{"mcp_deepwiki_read_wiki_contents":"deny"}
```

`PUT /api/settings` merges top-level fields, but `approvals` is replaced as a whole. Send the full map, or you drop your other per-tool choices. The app does this for you.

## Public connectors and the bot

Channel bots answer strangers, so they only ever get tools that are `read` and open under your policy. A connector's tools are offered to the bot only when you mark the connector **public** (`"public": true`, off by default), and then only its `read` tools. Mark a connector public only if its read tools reach nothing of yours: documentation servers yes, your Notion or GitHub no.

## Network safety

Every connector request, OAuth discovery and token calls included, must be `https` to a public address. Localhost, private ranges and cloud metadata are refused, and redirects are not followed:

```json
{"error":"Connector URLs must use https (set Z_ALLOW_PRIVATE_MCP=1 for MCP servers on your own network)"}
```

Start z with `Z_ALLOW_PRIVATE_MCP=1` to use an MCP server on your own network or plain http.

---

The commands on this page were run on 2026-10-28 against z 0.1.0, except the paste-fallback `curl` with a real code (a wrong state was sent instead, with the response shown) and an OAuth sign-in through a provider.
