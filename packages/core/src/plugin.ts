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
import type { Schema } from "ai";
import type { z } from "zod";
import type {
  BriefSourceItem,
  ChannelInput,
  ChannelKind,
  InboundMessage,
  OutboundReply,
  Risk,
} from "./contract.ts";

/** `toggle`: an on/off switch in the channel form, stored as `on` (adapter config only). */
export type SettingField = { key: string; label: string; secret?: boolean; required?: boolean; toggle?: boolean };

export type ToolContext = {
  /** This plugin's settings, already decrypted. */
  settings: Record<string, string>;
  signal: AbortSignal;
  log: (text: string) => void;
  fetch: typeof fetch;
  /**
   * Saved sign-ins (Settings → Security). The server hands this to the built-in browser plugin only,
   * so no other plugin can read logins; the browser fills them into the page itself.
   */
  vault?: LoginVault;
};

export type LoginVault = {
  /** The login saved for exactly `origin`, or null (the owner is then asked to save one). */
  login: (origin: string) => Promise<{ username: string; password: string; totp?: string } | null>;
  /** Just the username saved for `origin`, for approval cards. */
  username: (origin: string) => string | null;
};

export type ZTool<I = any, O = unknown> = {
  description: string;
  risk: Risk;
  /**
   * Reads only public knowledge (web search, reference lookups), never the owner's own data.
   * The summonable bot answers strangers, so it only gets read tools marked public.
   */
  public?: boolean;
  /** A zod schema, or a JSON schema via the AI SDK's `jsonSchema()` (MCP connector tools). */
  inputSchema: z.ZodType<I> | Schema<I>;
  /** One line shown on the approval card, e.g. `Post "…" to #general`. */
  summarize?: (input: I) => string;
  /**
   * Policy until the user picks one. `allow` suits write tools that only change z itself
   * (e.g. its own memory); it is ignored for `external` tools, which always ask.
   */
  defaultPolicy?: "ask" | "allow";
  /** Never offered to channel bots, which strangers can reach (e.g. tools over the owner's memory). */
  ownerOnly?: boolean;
  execute: (input: I, ctx: ToolContext) => Promise<O>;
  /** What the model sees instead of the raw output, e.g. an image part for vision models (AI SDK `toModelOutput`). */
  toModelOutput?(options: { output: O }): unknown;
};

export type BriefingContext = Omit<ToolContext, "signal"> & { since: Date; timezone: string };
export type BriefingSource = (ctx: BriefingContext) => Promise<BriefSourceItem[]>;

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
   * The server checks `from` is the paired owner. Resolves to a short ack once the action is
   * final (show it and drop the buttons); rejects with a message to show when it was refused
   * (e.g. not the owner), in which case the buttons stay for the owner.
   */
  act: (actionId: string, from: { threadId: string; authorId: string }) => Promise<string>;
  /** Small per-channel key/value store that survives restarts (cursors, ids). */
  state: {
    get: (key: string) => string | null;
    set: (key: string, value: string) => void;
  };
  /**
   * Inbound delivery receipts, kept 7 days. `claim` records an id and returns false when it was
   * already seen (a retry or replay); `release` forgets it so a failed delivery can be retried.
   */
  deliveries: {
    claim: (deliveryId: string) => boolean;
    release: (deliveryId: string) => void;
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
  /**
   * Longest `text` that `send` delivers whole when it carries actions. Approve buttons are only
   * offered when the complete approval preview fits. Omit when the platform has no practical limit.
   */
  noticeLimit?: number;
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
  /** Usage notes shown to the model whenever this plugin's tools are offered (e.g. an MCP server's instructions). */
  instructions?: string;
  /** Enabled on first run. Defaults to true when the plugin needs no settings. */
  enabledByDefault?: boolean;
};

/** The 6-digit code of an owner pairing command (`/link 123456`, `/link@zbot 123456`, `@z /link 123456`), or null. */
export function linkCode(text: string): string | null {
  return /(?:^|\s)\/link(?:@\w+)?\s+(\d{6})\s*$/.exec(text)?.[1] ?? null;
}

export const definePlugin = (plugin: ZPlugin): ZPlugin => plugin;
export const defineTool = <I, O>(tool: ZTool<I, O>): ZTool<I, O> => tool;
