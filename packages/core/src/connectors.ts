/**
 * Connectors: any MCP server as a data source. The server owns transports and credentials;
 * this module holds the preset catalog, the risk mapping and the adapter that turns a connected
 * MCP server into an ActivePlugin, so its tools get the same approval policy, bot filtering,
 * sensitive-data guard and call reporting as plugin tools.
 */
import { jsonSchema } from "ai";
import type { ConnectorPreset, ConnectorTool, Risk } from "./contract.ts";
import type { ZPlugin, ZTool } from "./plugin.ts";
import type { ActivePlugin } from "./tools.ts";

/** What z keeps of a server's `tools/list` entry. */
export type McpToolDefinition = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
};

/** The subset of an MCP `tools/call` result z reads. */
export type McpCallResult = {
  content?: { type: string; text?: string; data?: string; mimeType?: string; uri?: string; name?: string; resource?: { uri: string; text?: string; blob?: string; mimeType?: string } }[];
  structuredContent?: unknown;
  toolResult?: unknown;
  isError?: boolean;
};

/** A live connector as the server hands it to the runtime. */
export type ConnectedConnector = {
  id: string;
  label: string;
  public: boolean;
  instructions: string | null;
  tools: ConnectorTool[];
  definitions: McpToolDefinition[];
  call: (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<McpCallResult>;
};

export const MAX_TOOL_TEXT = 8000;
export const MAX_INSTRUCTIONS = 1000;
const MAX_DESCRIPTION = 2000;
const MAX_TOOL_NAME = 64;

const TOKEN_CUSTODY =
  "holds the OAuth tokens for every app you connect through it and runs the calls on its servers";

/** Static catalog; URLs and auth schemes checked against each vendor's docs and live endpoints (Oct 2026). */
export const PRESETS: ConnectorPreset[] = [
  {
    id: "deepwiki",
    label: "DeepWiki",
    url: "https://mcp.deepwiki.com/mcp",
    transport: "http",
    auth: "none",
    docsUrl: "https://docs.devin.ai/work-with-devin/deepwiki-mcp",
    category: "docs",
  },
  {
    id: "context7",
    label: "Context7",
    url: "https://mcp.context7.com/mcp",
    transport: "http",
    auth: "none",
    header: { name: "Authorization", template: "Bearer {token}", label: "API key (optional, raises rate limits)" },
    docsUrl: "https://github.com/upstash/context7",
    category: "docs",
  },
  {
    id: "cloudflare-docs",
    label: "Cloudflare Docs",
    url: "https://docs.mcp.cloudflare.com/mcp",
    transport: "http",
    auth: "none",
    docsUrl: "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/",
    category: "docs",
  },
  {
    id: "gitmcp",
    label: "GitMCP",
    url: "https://gitmcp.io/{owner}/{repo}",
    transport: "http",
    auth: "none",
    docsUrl: "https://gitmcp.io",
    category: "docs",
  },
  {
    id: "huggingface",
    label: "Hugging Face",
    url: "https://huggingface.co/mcp",
    transport: "http",
    auth: "none",
    header: { name: "Authorization", template: "Bearer {token}", label: "Access token (optional, uses your Hub settings)" },
    docsUrl: "https://huggingface.co/docs/hub/hf-mcp-server",
    category: "dev",
  },
  {
    id: "github",
    label: "GitHub",
    url: "https://api.githubcopilot.com/mcp/",
    transport: "http",
    auth: "headers",
    header: { name: "Authorization", template: "Bearer {token}", label: "Personal access token" },
    docsUrl: "https://github.com/github/github-mcp-server",
    category: "dev",
  },
  {
    id: "linear",
    label: "Linear",
    url: "https://mcp.linear.app/mcp",
    transport: "http",
    auth: "oauth",
    docsUrl: "https://linear.app/docs/mcp",
    category: "work",
  },
  {
    id: "notion",
    label: "Notion",
    url: "https://mcp.notion.com/mcp",
    transport: "http",
    auth: "oauth",
    docsUrl: "https://developers.notion.com/docs/mcp",
    category: "work",
  },
  {
    id: "composio",
    label: "Composio",
    url: "https://connect.composio.dev/mcp",
    transport: "http",
    auth: "headers",
    header: { name: "x-consumer-api-key", template: "{key}", label: "Consumer API key (ck_…)" },
    docsUrl: "https://docs.composio.dev/mcp/overview",
    note: `Composio ${TOKEN_CUSTODY}, and bills per tool call on your Composio plan.`,
    category: "aggregator",
  },
  {
    id: "zapier",
    label: "Zapier",
    url: "https://mcp.zapier.com/api/v1/connect",
    transport: "http",
    auth: "headers",
    header: { name: "Authorization", template: "Bearer {token}", label: "Connection token" },
    docsUrl: "https://docs.zapier.com/mcp/get-started/connect/other",
    note:
      `Zapier ${TOKEN_CUSTODY}; each tool call uses two tasks of your Zapier plan. ` +
      "The connection token (or a server URL that contains it) can run every tool you enabled: z stores it encrypted.",
    category: "aggregator",
  },
  {
    id: "pipedream",
    label: "Pipedream",
    url: "https://mcp.pipedream.net/v2",
    transport: "http",
    auth: "oauth",
    docsUrl: "https://pipedream.com/docs/connect/mcp/users",
    note: `Pipedream ${TOKEN_CUSTODY}.`,
    category: "aggregator",
  },
  {
    id: "custom",
    label: "Custom MCP server",
    url: "",
    transport: "http",
    auth: "none",
    docsUrl: "https://modelcontextprotocol.io/docs/learn/server-concepts",
    note: "Any Streamable HTTP or SSE MCP server. Servers on your own network need Z_ALLOW_PRIVATE_MCP=1 on the z server.",
    category: "dev",
  },
];

/**
 * Risk from the server's annotations (untrusted hints), unless the user overrode it.
 * Read-only wins; destructive or open-world tools act outside z; no hints at all means write.
 */
export function riskFor(
  annotations: McpToolDefinition["annotations"],
  override: Risk | undefined,
): Pick<ConnectorTool, "risk" | "riskSource"> {
  if (override) return { risk: override, riskSource: "user" };
  const a = annotations ?? {};
  if (a.readOnlyHint === undefined && a.destructiveHint === undefined && a.openWorldHint === undefined) {
    return { risk: "write", riskSource: "default" };
  }
  if (a.readOnlyHint) return { risk: "read", riskSource: "hint" };
  if (a.destructiveHint || a.openWorldHint) return { risk: "external", riskSource: "hint" };
  return { risk: "write", riskSource: "hint" };
}

/** FNV-1a, enough to keep truncated names apart. */
function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export const connectorPluginId = (connectorId: string) => `mcp_${connectorId}`;

/** `mcp_<connectorId>_<name>` limited to `[a-zA-Z0-9_-]` and 64 characters, unique within `taken`. */
export function connectorToolName(connectorId: string, name: string, taken: Set<string>): string {
  const full = `${connectorPluginId(connectorId)}_${name}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  const suffixed = (base: string) => `${base.slice(0, MAX_TOOL_NAME - 9)}_${shortHash(name)}`;
  let candidate = full.length > MAX_TOOL_NAME ? suffixed(full) : full;
  if (taken.has(candidate)) candidate = suffixed(full);
  for (let n = 2; taken.has(candidate); n++) candidate = `${suffixed(full).slice(0, MAX_TOOL_NAME - 3)}_${n}`;
  taken.add(candidate);
  return candidate;
}

/** The tool list shown in ConnectorView, in the server's order. */
export function describeTools(connectorId: string, definitions: McpToolDefinition[], risks: Record<string, Risk>): ConnectorTool[] {
  const taken = new Set<string>();
  return definitions.map((d) => ({
    name: d.name,
    toolName: connectorToolName(connectorId, d.name, taken),
    title: d.title ?? d.annotations?.title ?? null,
    description: d.description ?? "",
    ...riskFor(d.annotations, risks[d.name]),
  }));
}

export function capText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… [truncated ${text.length - max} characters]` : text;
}

type ToolOutput = { text: string; images: { mediaType: string; data: string }[] };

/** Text the model (and the task log) sees, plus images for vision models. */
export function readCallResult(result: McpCallResult): ToolOutput {
  const parts: string[] = [];
  const images: ToolOutput["images"] = [];
  for (const c of result.content ?? []) {
    if (c.type === "text" && typeof c.text === "string") parts.push(c.text);
    else if (c.type === "image" && c.data) images.push({ mediaType: c.mimeType ?? "image/png", data: c.data });
    else if (c.type === "resource" && c.resource) {
      parts.push(c.resource.text !== undefined ? `[${c.resource.uri}]\n${c.resource.text}` : `[${c.resource.uri}: ${c.resource.mimeType ?? "binary"} content]`);
    } else if (c.type === "resource_link" && c.uri) parts.push(`${c.name ?? "link"}: ${c.uri}`);
  }
  if (!parts.length && result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
  if (!parts.length && result.toolResult !== undefined) parts.push(JSON.stringify(result.toolResult));
  if (images.length) parts.push(`(${images.length} image(s) attached)`);
  return { text: capText(parts.join("\n\n"), MAX_TOOL_TEXT), images };
}

function connectorTool(connector: ConnectedConnector, definition: McpToolDefinition, info: ConnectorTool): ZTool {
  const label = info.title ?? definition.name;
  return {
    description: capText(definition.description || label, MAX_DESCRIPTION),
    risk: info.risk,
    // Bots answer strangers: only read tools of connectors the owner marked public.
    public: connector.public && info.risk === "read",
    inputSchema: jsonSchema({ type: "object", properties: {}, ...definition.inputSchema } as any),
    summarize: (input) => {
      const json = JSON.stringify(input) ?? "";
      return `${connector.label} · ${label} ${json.length > 160 ? `${json.slice(0, 157)}…` : json}`;
    },
    execute: async (input, ctx) => {
      const result = await connector.call(definition.name, (input ?? {}) as Record<string, unknown>, ctx.signal);
      const output = readCallResult(result);
      if (result.isError) throw new Error(output.text || `${definition.name} failed`);
      // Persisted tool events get the text, not base64 images.
      return { ...output, toJSON: () => ({ text: output.text }) };
    },
    toModelOutput: ({ output }: { output: ToolOutput }) =>
      output.images.length
        ? {
            type: "content" as const,
            value: [
              { type: "text" as const, text: output.text },
              ...output.images.map((i) => ({ type: "file" as const, mediaType: i.mediaType, data: { type: "data" as const, data: i.data } })),
            ],
          }
        : { type: "text" as const, value: output.text },
  };
}

/** A connected connector as a plugin (`mcp_<id>`), so agent, chat, watch and bot need no special cases. */
export function connectorPlugin(connector: ConnectedConnector): ActivePlugin {
  const pluginId = connectorPluginId(connector.id);
  const byName = new Map(connector.definitions.map((d) => [d.name, d]));
  const tools: Record<string, ZTool> = {};
  for (const info of connector.tools) {
    const definition = byName.get(info.name);
    // buildTools names tools `<pluginId>_<key>`, so the key is the toolName without the prefix.
    if (definition) tools[info.toolName.slice(pluginId.length + 1)] = connectorTool(connector, definition, info);
  }
  const plugin: ZPlugin = {
    id: pluginId,
    name: connector.label,
    description: `MCP connector ${connector.label}`,
    tools,
    ...(connector.instructions ? { instructions: capText(connector.instructions, MAX_INSTRUCTIONS) } : {}),
  };
  return { plugin, settings: {} };
}
