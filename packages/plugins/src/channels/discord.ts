import type { ChannelAdapter, ChannelRuntime, InboundMessage, OutboundReply } from "@z/core";
import { backoff, errorMessage, mentionsHandle, sleep, truncate } from "../util.ts";
import { config, pressed, shouldDispatch, untilAuthorized, type Action } from "./shared.ts";

const API = "https://discord.com/api/v10";
const GATEWAY = "wss://gateway.discord.gg";
const INTENTS = (1 << 9) | (1 << 12) | (1 << 15); // GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT

/** Close codes after which reconnecting cannot help (bad token, disallowed intents…). */
const FATAL_CLOSE: Record<number, string> = {
  4004: "Authentication failed: check the bot token",
  4010: "Invalid shard",
  4011: "Sharding required",
  4012: "Invalid API version",
  4013: "Invalid intents",
  4014: "Disallowed intents: enable MESSAGE CONTENT INTENT in the Discord developer portal",
};
/** Close codes after which the session cannot be resumed and a fresh Identify is needed. */
const NEW_SESSION_CLOSE = new Set([4007, 4009]);

type DUser = { id: string; username: string; global_name?: string | null; bot?: boolean };
export type DMessage = {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: DUser;
  content: string;
  timestamp: string;
  mentions?: DUser[];
  referenced_message?: DMessage | null;
};

/** INTERACTION_CREATE payload (the fields z reads). Type 3 is a message component, e.g. a button. */
export type DInteraction = {
  id: string;
  token: string;
  type: number;
  channel_id?: string;
  member?: { user: DUser };
  user?: DUser;
  data?: { custom_id?: string; component_type?: number };
  message?: { id: string; content: string };
};

/** Pure mapping from a button press; null for any other interaction. */
export function discordAction(i: DInteraction) {
  const user = i.member?.user ?? i.user;
  if (i.type !== 3 || !i.data?.custom_id || !i.channel_id || !user) return null;
  return {
    interactionId: i.id,
    token: i.token,
    actionId: i.data.custom_id,
    from: { threadId: i.channel_id, authorId: user.id },
    text: i.message?.content ?? "",
  };
}

/** Actions as one action row of buttons (Discord allows five per row). */
export function discordComponents(actions: Action[]) {
  const style = { primary: 1, danger: 4 } as const;
  return [
    {
      type: 1,
      components: actions.slice(0, 5).map((a) => ({ type: 2, style: a.style ? style[a.style] : 2, label: a.label, custom_id: a.id })),
    },
  ];
}

/**
 * The interaction response: a final outcome replaces the message (buttons removed, type 7);
 * a refusal is an ephemeral reply only the presser sees (type 4, flag 64).
 */
export function discordInteractionResponse(text: string, ack: string, final: boolean) {
  return final
    ? { type: 7, data: { content: truncate(`${text}\n\n${ack}`, 2000), components: [] } }
    : { type: 4, data: { content: truncate(ack, 2000), flags: 64 } };
}

function name(user: DUser): string {
  return user.global_name || user.username;
}

function messageUrl(m: DMessage, guildId?: string): string {
  return `https://discord.com/channels/${m.guild_id ?? guildId ?? "@me"}/${m.channel_id}/${m.id}`;
}

/** Pure mapping from a MESSAGE_CREATE payload; null when it should be ignored. */
export function discordToInbound(
  m: DMessage,
  opts: { channelId: string; botUserId: string; handle: string },
): InboundMessage | null {
  if (m.author.id === opts.botUserId || m.author.bot || !m.content) return null;
  const ref = m.referenced_message;
  const mentioned =
    (m.mentions ?? []).some((u) => u.id === opts.botUserId) || new RegExp(`<@!?${opts.botUserId}>`).test(m.content);
  const addressed = mentioned || ref?.author.id === opts.botUserId || !m.guild_id || mentionsHandle(m.content, opts.handle);
  return {
    channelId: opts.channelId,
    threadId: m.channel_id,
    messageId: m.id,
    author: { id: m.author.id, name: name(m.author) },
    text: m.content.replace(new RegExp(`<@!?${opts.botUserId}>`, "g"), `@${opts.handle}`),
    addressed,
    ...(ref?.content ? { context: [{ author: name(ref.author), text: ref.content, url: messageUrl(ref, m.guild_id) }] } : {}),
    receivedAt: m.timestamp,
  };
}

async function postReply(runtime: ChannelRuntime, m: DMessage, reply: OutboundReply): Promise<void> {
  await postMessage(runtime, m.channel_id, {
    content: truncate(reply.text, 2000),
    message_reference: { message_id: reply.replyTo || m.id, fail_if_not_exists: false },
    // Never let model output ping @everyone/roles; still notify the person we reply to.
    allowed_mentions: { parse: [], replied_user: true },
  });
}

async function postMessage(runtime: ChannelRuntime, channelId: string, payload: unknown): Promise<void> {
  const body = JSON.stringify(payload);
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await runtime.fetch(`${API}/channels/${channelId}/messages`, {
      method: "POST",
      headers: { authorization: `Bot ${config(runtime, "botToken")}`, "content-type": "application/json" },
      body,
    });
    if (res.ok) return;
    if (res.status === 429) {
      const { retry_after } = (await res.json().catch(() => ({ retry_after: 1 }))) as { retry_after: number };
      await sleep(Math.ceil(retry_after * 1000));
      continue;
    }
    const detail = ((await res.json().catch(() => ({}))) as { message?: string }).message ?? res.statusText;
    throw new Error(`Discord POST message: ${res.status} ${detail}`);
  }
  throw new Error("Discord POST message: rate limited");
}

async function onInteraction(runtime: ChannelRuntime, interaction: DInteraction): Promise<void> {
  const action = discordAction(interaction);
  if (!action) return;
  const { ack, final } = await pressed(runtime, action.actionId, action.from);
  // Must be answered within 3 seconds; the token itself authorizes the callback.
  const res = await runtime.fetch(`${API}/interactions/${action.interactionId}/${action.token}/callback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(discordInteractionResponse(action.text, ack, final)),
  });
  if (!res.ok) throw new Error(`Discord interaction callback: ${res.status}`);
}

async function checkToken(runtime: ChannelRuntime, signal: AbortSignal): Promise<void> {
  const res = await runtime.fetch(`${API}/users/@me`, {
    headers: { authorization: `Bot ${config(runtime, "botToken")}` },
    signal,
  });
  if (res.ok) return;
  const detail = ((await res.json().catch(() => ({}))) as { message?: string }).message ?? res.statusText;
  throw new Error(res.status === 401 ? `Discord rejected the bot token (${detail})` : `Discord GET /users/@me: ${res.status} ${detail}`);
}

type Session = { id: string; resumeUrl: string };
type Closed = { code: number; reason: string; ready: boolean };

export const discordAdapter: ChannelAdapter = {
  kind: "discord",
  label: "Discord",
  config: [{ key: "botToken", label: "Bot token", secret: true, required: true }],
  send: async (runtime, threadId, message) => {
    await postMessage(runtime, threadId, {
      content: truncate(message.text, 2000),
      allowed_mentions: { parse: [] },
      ...(message.actions?.length ? { components: discordComponents(message.actions) } : {}),
    });
  },
  start: async (runtime) => {
    const token = config(runtime, "botToken");
    if (!token) {
      runtime.status("error", "botToken is required");
      return () => {};
    }
    const controller = new AbortController();
    const { signal } = controller;
    let socket: WebSocket | null = null;
    let session: Session | null = null;
    let seq: number | null = null;
    let botUserId = "";

    const onMessage = (m: DMessage) => {
      const message = discordToInbound(m, { channelId: runtime.channel.id, botUserId, handle: runtime.handle });
      if (!message || !shouldDispatch(message, runtime)) return;
      runtime
        .dispatch(message)
        .then((reply) => reply && postReply(runtime, m, reply))
        .catch((error) => runtime.log(`discord: ${errorMessage(error)}`));
    };

    const connect = () =>
      new Promise<Closed>((resolve) => {
        const base = new URL(session?.resumeUrl ?? GATEWAY);
        base.searchParams.set("v", "10");
        base.searchParams.set("encoding", "json");
        const ws = new WebSocket(base);
        socket = ws;
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        let firstBeat: ReturnType<typeof setTimeout> | undefined;
        let acked = true;
        let ready = false;
        const send = (op: number, d: unknown) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op, d }));
        };
        const beat = () => {
          // No ACK since the last beat: the connection is a zombie. 4000 keeps the session resumable.
          if (!acked) return ws.close(4000, "heartbeat timeout");
          acked = false;
          send(1, seq);
        };

        ws.addEventListener("message", (event) => {
          let packet: { op: number; d: any; s: number | null; t: string | null };
          try {
            packet = JSON.parse(String(event.data));
          } catch {
            return;
          }
          if (packet.s !== null && packet.s !== undefined) seq = packet.s;
          switch (packet.op) {
            case 10: {
              const interval = packet.d.heartbeat_interval as number;
              firstBeat = setTimeout(() => {
                beat();
                heartbeat = setInterval(beat, interval);
              }, interval * Math.random());
              if (session) send(6, { token, session_id: session.id, seq });
              else send(2, { token, intents: INTENTS, properties: { os: process.platform, browser: "z", device: "z" } });
              break;
            }
            case 11:
              acked = true;
              break;
            case 1:
              send(1, seq);
              break;
            case 7:
              ws.close(4000, "reconnect requested");
              break;
            case 9:
              // d=false: the session is gone and we must identify from scratch.
              if (!packet.d) session = null;
              ws.close(4000, "invalid session");
              break;
            case 0:
              if (packet.t === "READY") {
                botUserId = packet.d.user.id;
                session = { id: packet.d.session_id, resumeUrl: packet.d.resume_gateway_url };
                ready = true;
                runtime.status("ok", `Connected as ${packet.d.user.username}`);
              } else if (packet.t === "RESUMED") {
                ready = true;
                runtime.status("ok", "Resumed");
              } else if (packet.t === "MESSAGE_CREATE") {
                onMessage(packet.d as DMessage);
              } else if (packet.t === "INTERACTION_CREATE") {
                onInteraction(runtime, packet.d as DInteraction).catch((error) => runtime.log(`discord: ${errorMessage(error)}`));
              }
              break;
          }
        });
        ws.addEventListener("close", (event) => {
          clearTimeout(firstBeat);
          clearInterval(heartbeat);
          resolve({ code: event.code, reason: event.reason, ready });
        });
        // An "error" event is always followed by "close", which drives reconnection.
        ws.addEventListener("error", () => {});
      });

    const auth = await untilAuthorized(runtime, () => checkToken(runtime, signal), signal);
    void (async () => {
      if (!(await auth.ready)) return;
      let attempt = 0;
      while (!signal.aborted) {
        const closed = await connect();
        if (signal.aborted) break;
        const fatal = FATAL_CLOSE[closed.code];
        if (fatal) {
          // Usually fixed in the developer portal without touching z, so keep retrying, slowly.
          session = null;
          runtime.status("error", fatal);
          await sleep(backoff(++attempt + 4, 300_000), signal);
          continue;
        }
        if (NEW_SESSION_CLOSE.has(closed.code)) session = null;
        attempt = closed.ready ? 0 : attempt + 1;
        const detail = `Disconnected (${closed.code}${closed.reason ? `: ${closed.reason}` : ""}), reconnecting`;
        runtime.status(closed.ready ? "idle" : "error", detail);
        await sleep(backoff(attempt), signal);
      }
    })();

    return () => {
      controller.abort();
      socket?.close(1000, "stopped");
    };
  },
};
