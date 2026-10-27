/**
 * Plugin authoring API. A plugin is a plain object: tools the agent can call,
 * an optional briefing source, and optional channel adapters.
 *
 *   export default definePlugin({
 *     id: "weather",
 *     name: "Weather",
 *     description: "Current conditions and forecasts.",
 *     tools: {
 *       forecast: defineTool({
 *         description: "Forecast for a city",
 *         risk: "read",
 *         inputSchema: z.object({ city: z.string() }),
 *         execute: async ({ city }, ctx) => (await ctx.fetch(`…${city}`)).json(),
 *       }),
 *     },
 *   });
 */
import type { z } from "zod";
import type {
  BriefItem,
  ChannelInput,
  ChannelKind,
  InboundMessage,
  OutboundReply,
  Risk,
} from "./contract.ts";

export type SettingField = { key: string; label: string; secret?: boolean; required?: boolean };

export type ToolContext = {
  /** This plugin's settings, already decrypted. */
  settings: Record<string, string>;
  signal: AbortSignal;
  log: (text: string) => void;
  fetch: typeof fetch;
};

export type ZTool<I = any, O = unknown> = {
  description: string;
  risk: Risk;
  inputSchema: z.ZodType<I>;
  /** One line shown on the approval card, e.g. `Post "…" to #general`. */
  summarize?: (input: I) => string;
  execute: (input: I, ctx: ToolContext) => Promise<O>;
};

export type BriefingContext = Omit<ToolContext, "signal"> & { since: Date; timezone: string };
export type BriefingSource = (ctx: BriefingContext) => Promise<BriefItem[]>;

export type ChannelRuntime = {
  channel: z.output<typeof ChannelInput>;
  /** The name the bot answers to (Settings.handle). */
  handle: string;
  /** Public URL of `/hooks/:channelId`, or null when Z_PUBLIC_URL is unset. */
  webhookUrl: string | null;
  /** Run the bot for one message; resolves to null when it decides not to answer. */
  dispatch: (message: InboundMessage) => Promise<OutboundReply | null>;
  /**
   * Handle a button press (e.g. Telegram callback, Discord component, Slack action).
   * The server checks `from` is the paired owner. Resolves to a short ack to show.
   */
  act: (actionId: string, from: { threadId: string; authorId: string }) => Promise<string>;
  /** Small per-channel key/value store that survives restarts (cursors, ids). */
  state: {
    get: (key: string) => string | null;
    set: (key: string, value: string) => void;
  };
  /** Report health to the UI. */
  status: (status: "ok" | "error" | "idle", detail?: string) => void;
  log: (text: string) => void;
  fetch: typeof fetch;
};

export type ChannelAdapter = {
  kind: ChannelKind;
  label: string;
  config: SettingField[];
  /** Handle `POST /hooks/:channelId`. */
  webhook?: (request: Request, runtime: ChannelRuntime) => Promise<Response>;
  /**
   * Send an unprompted message to a thread (owner notices). `actions` become
   * buttons where the platform supports them; ids are opaque and go back via `runtime.act`.
   */
  send?: (
    runtime: ChannelRuntime,
    threadId: string,
    message: { text: string; actions?: { id: string; label: string; style?: "primary" | "danger" }[] },
  ) => Promise<void>;
  /** Start a long-lived connection (polling, gateway). Returns a stop function. */
  start?: (runtime: ChannelRuntime) => Promise<() => void | Promise<void>>;
};

export type ZPlugin = {
  id: string;
  name: string;
  description: string;
  settings?: SettingField[];
  tools?: Record<string, ZTool>;
  briefing?: BriefingSource;
  adapters?: ChannelAdapter[];
  /** Enabled on first run. Defaults to true when the plugin needs no settings. */
  enabledByDefault?: boolean;
};

export const definePlugin = (plugin: ZPlugin): ZPlugin => plugin;
export const defineTool = <I, O>(tool: ZTool<I, O>): ZTool<I, O> => tool;
