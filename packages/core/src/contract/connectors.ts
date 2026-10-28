import { z } from "zod";
import { Risk } from "./common.ts";

// ─── Connectors: any MCP server as a data source (Composio, Zapier, Pipedream, self-hosted…) ─

export const ConnectorAuth = z.enum(["none", "headers", "oauth"]);
export type ConnectorAuth = z.infer<typeof ConnectorAuth>;

export const ConnectorInput = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
  label: z.string().min(1).max(64),
  /** Required when creating; omit on update to keep the stored URL. */
  url: z.url().optional(),
  transport: z.enum(["http", "sse"]).default("http"),
  auth: ConnectorAuth.default("none"),
  /** Static headers (e.g. `Authorization`, `x-api-key`). Write-only like provider keys; omit to keep, `{}` clears. */
  headers: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().default(true),
  /** Offer this connector's read tools to channel bots, which strangers reach. Off by default. */
  public: z.boolean().default(false),
  /** Per-tool risk override, keyed by the server's own tool name. Wins over the server's hints. */
  risks: z.record(z.string(), Risk).default({}),
});
export type ConnectorInput = z.input<typeof ConnectorInput>;

export type ConnectorTool = {
  /** The server's own tool name. */
  name: string;
  /** Name the model sees and approval policy keys use: `mcp_<connectorId>_<name>`, sanitised. */
  toolName: string;
  title: string | null;
  description: string;
  risk: Risk;
  /** `hint`: derived from the server's annotations (untrusted); `default`: no hints, treated as write; `user`: overridden. */
  riskSource: "hint" | "default" | "user";
};

export type ConnectorView = Omit<z.output<typeof ConnectorInput>, "headers" | "url"> & {
  /**
   * The URL with path and query hidden (`https://mcp.zapier.com/…`): some services embed
   * the secret in the URL, so the full URL is write-only like headers. PUT without `url` keeps it.
   */
  urlDisplay: string;
  /** Header names that have a stored value; values are never returned. */
  headerKeys: string[];
  status: "connected" | "connecting" | "needs_auth" | "error" | "disabled";
  statusDetail: string | null;
  server: { name: string; version: string } | null;
  /** Server-provided usage instructions, shown to the model with its tools. */
  instructions: string | null;
  tools: ConnectorTool[];
  /** Present when auth is `oauth` and a token is stored. */
  oauth: { connected: boolean; scope: string | null; expiresAt: string | null } | null;
  /** An OAuth sign-in was started and its callback hasn't arrived yet (it can be pasted instead). */
  signInPending: boolean;
  updatedAt: string;
};

/** Start of an OAuth sign-in. `redirectUri` is where the browser lands after approving. */
export type OAuthStart = { authorizationUrl: string; redirectUri: string };

/**
 * Finish a sign-in whose callback can't reach z (no Z_PUBLIC_URL, LAN or Tailscale installs): the
 * owner pastes the address the browser ended on. The state in it must be this connector's
 * pending one, and is single use like the real callback.
 */
export const OAuthCompleteInput = z.object({ url: z.string().trim().min(1).max(4096) });
export type OAuthCompleteInput = z.infer<typeof OAuthCompleteInput>;

/** A one-tap starting point in the UI. Static catalog shipped with z. */
export type ConnectorPreset = {
  id: string;
  label: string;
  /** May contain `{placeholders}` the user fills, e.g. `https://gitmcp.io/{owner}/{repo}`. */
  url: string;
  transport: "http" | "sse";
  auth: ConnectorAuth;
  /** For `headers` auth: the header to fill and how its value is built, e.g. `Authorization: Bearer {token}`. */
  header?: { name: string; template: string; label: string };
  docsUrl: string;
  /** Plain-language caveat shown before connecting, e.g. who holds the OAuth tokens. */
  note?: string;
  category: "docs" | "dev" | "work" | "aggregator";
};

// Routes (HTTP API; overview in ../contract.ts):
// GET    /api/connector-presets            → ConnectorPreset[]
// GET    /api/connectors                   → ConnectorView[]
// PUT    /api/connectors/:id ConnectorInput → ConnectorView   (saves, connects, lists tools)
// DELETE /api/connectors/:id               → { ok: true }    (drops stored OAuth tokens; revokes them at the
//                                            authorization server in the background, RFC 7009, best effort)
// POST   /api/connectors/:id/refresh       → ConnectorView   (reconnect and re-list tools)
// POST   /api/connectors/:id/oauth         → OAuthStart      (start OAuth; open authorizationUrl in a new tab)
// POST   /api/connectors/:id/oauth/complete OAuthCompleteInput → ConnectorView  (paste the callback URL;
//                                            400 { error } on a wrong/used/expired state or a rejected code)
// GET    /oauth/callback?code&state        → redirects to `/connect?connector=<id>` (no /api prefix; no bearer needed, state-verified)
