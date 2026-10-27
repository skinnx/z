import type { ChannelAdapter, ChannelRuntime, InboundMessage } from "@z/core";
import { decodeEntities, errorMessage, hmacSha256Hex, mentionsHandle, safeEqual, truncate } from "../util.ts";
import { config, shouldDispatch } from "./shared.ts";

export type SlackEvent = {
  type: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  channel: string;
  channel_type?: string;
  event_ts?: string;
};

/** Verify `X-Slack-Signature` (v0 scheme): HMAC-SHA256 over `v0:{timestamp}:{raw body}`, 5-minute window. */
export function verifySlackSignature(
  signingSecret: string,
  timestamp: string | null,
  signature: string | null,
  rawBody: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (!signingSecret || !timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > 300) return false;
  return safeEqual(`v0=${hmacSha256Hex(signingSecret, `v0:${timestamp}:${rawBody}`)}`, signature);
}

/** Slack mrkdwn → plain text: `<@U1>` mentions, `<url|label>` links, escaped `&<>`. */
export function slackToPlain(text: string, botUserId: string, handle: string): string {
  return decodeEntities(
    text
      .replace(new RegExp(`<@${botUserId}(\\|[^>]*)?>`, "g"), `@${handle}`)
      .replace(/<@(\w+)(?:\|([^>]*))?>/g, (_, id: string, name?: string) => `@${name || id}`)
      .replace(/<#\w+\|([^>]*)>/g, "#$1")
      .replace(/<!(here|channel|everyone)[^>]*>/g, "@$1")
      .replace(/<([^|>]+)\|([^>]+)>/g, "$2 ($1)")
      .replace(/<([^>]+)>/g, "$1"),
  );
}

/**
 * Pure mapping from an Events API event; null when it should be ignored.
 * `app_mention` covers channel mentions; plain `message` events (if subscribed) cover DMs and `always` channels.
 */
export function slackToInbound(
  event: SlackEvent,
  opts: { channelId: string; botUserId: string; handle: string },
): InboundMessage | null {
  if (event.type !== "app_mention" && event.type !== "message") return null;
  if (event.subtype && event.subtype !== "file_share" && event.subtype !== "thread_broadcast") return null;
  if (event.bot_id || !event.user || event.user === opts.botUserId || !event.text) return null;
  const mentionTag = `<@${opts.botUserId}`;
  const isDm = event.channel_type === "im";
  // The same mention also arrives as app_mention; handle it there only.
  if (event.type === "message" && !isDm && event.text.includes(mentionTag)) return null;
  const text = slackToPlain(event.text, opts.botUserId, opts.handle);
  const threadTs = event.thread_ts ?? event.ts;
  return {
    channelId: opts.channelId,
    threadId: `${event.channel}:${threadTs}`,
    messageId: event.ts,
    author: { id: event.user, name: event.user },
    text,
    addressed: event.type === "app_mention" || isDm || mentionsHandle(text, opts.handle),
    receivedAt: new Date(Number(event.ts) * 1000).toISOString(),
  };
}

async function slackApi<T>(runtime: ChannelRuntime, method: string, params: Record<string, unknown>, get = false) {
  const token = config(runtime, "botToken");
  const url = new URL(`https://slack.com/api/${method}`);
  if (get) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await runtime.fetch(url, {
    method: get ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, ...(get ? {} : { "content-type": "application/json; charset=utf-8" }) },
    ...(get ? {} : { body: JSON.stringify(params) }),
  });
  const data = (await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))) as T & {
    ok: boolean;
    error?: string;
  };
  if (!data.ok) throw new Error(`Slack ${method}: ${data.error}`);
  return data;
}

const botIds = new Map<string, Promise<string>>();

function botUserId(runtime: ChannelRuntime, fromPayload: string | undefined): Promise<string> {
  if (fromPayload) return Promise.resolve(fromPayload);
  let id = botIds.get(runtime.channel.id);
  if (!id) {
    id = slackApi<{ user_id: string }>(runtime, "auth.test", {}).then((r) => r.user_id);
    id.catch(() => botIds.delete(runtime.channel.id));
    botIds.set(runtime.channel.id, id);
  }
  return id;
}

async function respond(runtime: ChannelRuntime, event: SlackEvent, message: InboundMessage, botId: string) {
  // In a thread, "is this true?" refers to the thread's parent message.
  if (event.thread_ts && event.thread_ts !== event.ts) {
    try {
      const { messages } = await slackApi<{ messages: { user?: string; text?: string; ts: string }[] }>(
        runtime,
        "conversations.replies",
        { channel: event.channel, ts: event.thread_ts, limit: 1, inclusive: true },
        true,
      );
      const parent = messages[0];
      if (parent?.text) {
        message.context = [{ author: parent.user ?? "unknown", text: slackToPlain(parent.text, botId, runtime.handle) }];
      }
    } catch (error) {
      runtime.log(`slack: could not load thread parent: ${errorMessage(error)}`);
    }
  }
  const reply = await runtime.dispatch(message);
  if (!reply) return;
  await slackApi(runtime, "chat.postMessage", {
    channel: event.channel,
    thread_ts: event.thread_ts ?? event.ts,
    text: truncate(reply.text, 3900),
  });
}

export const slackAdapter: ChannelAdapter = {
  kind: "slack",
  label: "Slack",
  config: [
    { key: "botToken", label: "Bot token (xoxb-…)", secret: true, required: true },
    { key: "signingSecret", label: "Signing secret", secret: true, required: true },
  ],
  webhook: async (request, runtime) => {
    const raw = await request.text();
    const ok = verifySlackSignature(
      config(runtime, "signingSecret"),
      request.headers.get("x-slack-request-timestamp"),
      request.headers.get("x-slack-signature"),
      raw,
    );
    if (!ok) return new Response("Invalid signature", { status: 401 });
    let payload: { type: string; challenge?: string; event?: SlackEvent; authorizations?: { user_id?: string }[] };
    try {
      payload = JSON.parse(raw);
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    if (payload.type === "url_verification") return Response.json({ challenge: payload.challenge });
    runtime.status("ok");
    // A retry means an earlier delivery already reached us (we ack before answering).
    if (request.headers.get("x-slack-retry-num") || payload.type !== "event_callback" || !payload.event) {
      return new Response("", { status: 200 });
    }
    const event = payload.event;
    // Slack expects an ack within 3 seconds, so the answer is produced after responding.
    void (async () => {
      const botId = await botUserId(runtime, payload.authorizations?.[0]?.user_id);
      const message = slackToInbound(event, { channelId: runtime.channel.id, botUserId: botId, handle: runtime.handle });
      if (message && shouldDispatch(message, runtime)) await respond(runtime, event, message, botId);
    })().catch((error) => {
      runtime.log(`slack: ${errorMessage(error)}`);
      runtime.status("error", errorMessage(error));
    });
    return new Response("", { status: 200 });
  },
};
