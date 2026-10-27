/** Turn plugin tools into an AI SDK ToolSet with z's approval policy applied. */
import { tool, type ToolSet } from "ai";
import type { ApprovalPolicy, Risk } from "./contract.ts";
import type { ZPlugin, ZTool } from "./plugin.ts";

/** An enabled plugin together with its decrypted settings. */
export type ActivePlugin = { plugin: ZPlugin; settings: Record<string, string> };

export type ToolInfo = { name: string; pluginId: string; tool: ZTool; risk: Risk };

export type ToolCallReport = { tool: string; input: unknown; output?: unknown; error?: string };

export type BuildToolsOptions = {
  policy: ApprovalPolicy;
  /** Only expose these tool names (`plugin_tool`). */
  only?: string[] | null;
  /** Expose only read-risk tools, and never anything that would need approval. */
  readOnly?: boolean;
  /** Expose only tools marked `public` (no access to the owner's own data). */
  publicOnly?: boolean;
  log?: (text: string) => void;
  onCall?: (report: ToolCallReport) => void;
};

export type BuiltTools = {
  tools: ToolSet;
  /** Pass as `toolApproval` to generateText/streamText. */
  approval: Record<string, "user-approval" | "not-applicable">;
  info: Record<string, ToolInfo>;
};

export const toolName = (pluginId: string, name: string) => `${pluginId}_${name}`;

/** Whether a tool call must wait for the user, or `null` when the tool may not be exposed at all. */
export function approvalFor(name: string, risk: Risk, policy: ApprovalPolicy): boolean | null {
  const rule = policy[name];
  if (rule === "deny") return null;
  if (rule === "allow") return false;
  if (risk === "read") return rule === "ask";
  return true;
}

export function listTools(plugins: ActivePlugin[]): ToolInfo[] {
  return plugins.flatMap(({ plugin }) =>
    Object.entries(plugin.tools ?? {}).map(([name, t]) => ({
      name: toolName(plugin.id, name),
      pluginId: plugin.id,
      tool: t,
      risk: t.risk,
    })),
  );
}

export function buildTools(plugins: ActivePlugin[], options: BuildToolsOptions): BuiltTools {
  const out: BuiltTools = { tools: {}, approval: {}, info: {} };
  const settingsById = new Map(plugins.map((p) => [p.plugin.id, p.settings]));

  for (const info of listTools(plugins)) {
    if (options.only && !options.only.includes(info.name)) continue;
    const needsApproval = approvalFor(info.name, info.risk, options.policy);
    if (needsApproval === null) continue;
    if (options.readOnly && (info.risk !== "read" || needsApproval)) continue;
    if (options.publicOnly && !info.tool.public) continue;

    const settings = settingsById.get(info.pluginId) ?? {};
    const log = (text: string) => options.log?.(`[${info.name}] ${text}`);
    out.tools[info.name] = tool({
      description: info.tool.description,
      inputSchema: info.tool.inputSchema,
      execute: async (input: unknown, { abortSignal }) => {
        try {
          const output = await info.tool.execute(input, {
            settings,
            signal: abortSignal ?? new AbortController().signal,
            log,
            fetch,
          });
          options.onCall?.({ tool: info.name, input, output });
          return output as any;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          options.onCall?.({ tool: info.name, input, error: message });
          throw error;
        }
      },
    });
    out.approval[info.name] = needsApproval ? "user-approval" : "not-applicable";
    out.info[info.name] = info;
  }
  return out;
}

/** One line for the approval card. */
export function summarizeCall(info: ToolInfo | undefined, name: string, input: unknown): string {
  if (info?.tool.summarize) {
    try {
      return info.tool.summarize(input);
    } catch {}
  }
  const json = JSON.stringify(input) ?? "";
  return `${name}(${json.length > 120 ? `${json.slice(0, 117)}…` : json})`;
}
