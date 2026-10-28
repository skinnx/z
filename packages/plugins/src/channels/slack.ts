import type { ChannelAdapter, ChannelRuntime, InboundMessage } from "@z/core";
import { decodeEntities, errorMessage, hmacSha256Hex, mentionsHandle, safeEqual, truncate } from "../util.ts";
import { checked, config, imageDataUrl, pressed, requestSignal, shouldDispatch, step, withSources, type Action } from "./shared.ts";

/** Bot token scopes z needs, and ones it uses when present (private channels, group DMs, images). */
export const SLACK_SCOPES = ["app_mentions:read", "chat:write", "channels:history", "im:history"];
export const SLACK_EXTRA_SCOPES = ["groups:history", "mpim:history", "files:read"];

/** auth.test, plus the token's scopes from the `x-oauth-scopes` header Slack sends with every Web API answer. */
async function slackIdentity(runtime: ChannelRuntime) {
  const res = await runtime.fetch("https://slack.com/api/auth.test", {
    method: "POST",
    headers: { authorization: `Bearer ${config(runtime, "botToken")}` },
    signal: requestSignal(),
  });
  const data = (await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))) as {
    ok: boolean;
    error?: string;
    user?: string;
    team?: string;
    url?: string;
  };
  if (!data.ok) throw new Error(`Slack auth.test: ${data.error}`);
  const scopes = (res.headers.get("x-oauth-scopes") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return { user: data.user ?? "z", team: data.team ?? "", scopes };
}

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
  files?: SlackFile[];
};

type SlackFile = { mimetype?: string; url_private?: string };

/** Slack files need the bot token (files:read) to download, so images become data URLs here. */
async function slackImages(runtime: ChannelRuntime, files: SlackFile[] | undefined): Promise<string[]> {
  const urls = (files ?? []).filter((f) => f.mimetype?.startsWith("image/") && f.url_private).map((f) => f.url_private!);
  const images = await Promise.all(
    urls.slice(0, 4).map((url) => imageDataUrl(runtime, url, { authorization: `Bearer ${config(runtime, "botToken")}` })),
  );
  return images.filter((i): i is string => i !== null);
}

/** Interactivity payload for a Block Kit button press (the fields z reads). */
export type SlackBlockActions = {
  type: string;
  user?: { id: string };
  channel?: { id: string };
  container?: { channel_id?: string; message_ts?: string; thread_ts?: string };
  message?: { ts: string; thread_ts?: string; text?: string };
  response_url?: string;
  actions?: { action_id: string; value?: string }[];
};

/** Pure mapping from an interactivity payload; null unless it is a button press z can answer. */
export function slackAction(payload: SlackBlockActions) {
  const action = payload.actions?.[0];
  const channel = payload.channel?.id ?? payload.container?.channel_id;
  const ts = payload.message?.thread_ts ?? payload.message?.ts ?? payload.container?.message_ts;
  if (payload.type !== "block_actions" || !action || !payload.user || !channel || !ts) return null;
  // response_url is the only way back; only ever post to Slack's own host.
  if (!payload.response_url?.startsWith("https://hooks.slack.com/")) return null;
  return {
    actionId: action.value ?? action.action_id,
    from: { threadId: `${channel}:${ts}`, authorId: payload.user.id },
    responseUrl: payload.response_url,
    text: payload.message?.text ?? "",
  };
}

/** Interactivity requests are form-encoded: `payload=<JSON>`. */
export function parseSlackForm(raw: string): SlackBlockActions | null {
  try {
    const json = new URLSearchParams(raw).get("payload");
    return json ? (JSON.parse(json) as SlackBlockActions) : null;
  } catch {
    return null;
  }
}

const escapeMrkdwn = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Text plus a row of buttons. `text` stays as the notification fallback. */
export function slackBlocks(text: string, actions: Action[]) {
  return [
    { type: "section", text: { type: "mrkdwn", text: escapeMrkdwn(truncate(text, 2900)) } },
    {
      type: "actions",
      elements: actions.map((a) => ({
        type: "button",
        text: { type: "plain_text", text: a.label },
        action_id: a.id,
        value: a.id,
        ...(a.style ? { style: a.style } : {}),
      })),
    },
  ];
}

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
    signal: requestSignal(),
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
      const { messages } = await slackApi<{ messages: { user?: string; text?: string; ts: string; files?: SlackFile[] }[] }>(
        runtime,
        "conversations.replies",
        { channel: event.channel, ts: event.thread_ts, limit: 1, inclusive: true },
        true,
      );
      const parent = messages[0];
      const images = await slackImages(runtime, parent?.files);
      if (parent?.text || images.length) {
        message.context = [
          {
            author: parent!.user ?? "unknown",
            text: slackToPlain(parent!.text ?? "", botId, runtime.handle),
            ...(images.length ? { images } : {}),
          },
        ];
      }
    } catch (error) {
      runtime.log(`slack: could not load thread parent: ${errorMessage(error)}`);
    }
  }
  const images = await slackImages(runtime, event.files);
  if (images.length) message.images = images;
  const reply = await runtime.dispatch(message);
  if (!reply) return;
  await slackApi(runtime, "chat.postMessage", {
    channel: event.channel,
    thread_ts: event.thread_ts ?? event.ts,
    text: withSources(reply, 3900, (s) => `<${s.url.replace(/\|/g, "%7C")}|${escapeMrkdwn(s.title).replace(/\|/g, "/")}>`, escapeMrkdwn),
    unfurl_links: false,
  });
}

export const slackAdapter: ChannelAdapter = {
  kind: "slack",
  label: "Slack",
  config: [
    { key: "botToken", label: "Bot token (xoxb-…)", secret: true, required: true },
    { key: "signingSecret", label: "Signing secret", secret: true, required: true },
  ],
  // Owner notices go to the conversation itself (top level), not into the pairing thread.
  // With buttons the text goes in one section block (3000 characters, after mrkdwn escaping).
  noticeLimit: 2900,
  send: async (runtime, threadId, message) => {
    const [channel] = threadId.split(":");
    const sent = await slackApi<{ ts: string }>(runtime, "chat.postMessage", {
      channel,
      text: truncate(message.text, 3900),
      ...(message.actions?.length ? { blocks: slackBlocks(message.text, message.actions) } : {}),
    });
    return { ref: sent.ts };
  },
  edit: async (runtime, threadId, ref, text) => {
    const [channel] = threadId.split(":");
    await slackApi(runtime, "chat.update", { channel, ts: ref, text: truncate(text, 3900), blocks: [] });
  },
  setup: async (runtime, hookUrl) => {
    const apps = "https://api.slack.com/apps";
    if (!config(runtime, "botToken")) return [step("slack.token", "Paste the Bot User OAuth Token (xoxb-…)", "error", { link: apps })];
    const me = await checked(() => slackIdentity(runtime));
    const steps = [
      me.ok
        ? step("slack.token", "Bot token", "done", { detail: `@${me.value.user}${me.value.team ? ` · ${me.value.team}` : ""}` })
        : step("slack.token", "Bot token", "error", { detail: me.error, link: apps }),
    ];
    const missing = me.ok && me.value.scopes.length ? SLACK_SCOPES.filter((s) => !me.value.scopes.includes(s)) : [];
    steps.push(
      step("slack.scopes", "Bot token scopes (OAuth & Permissions), then reinstall the app", !me.ok ? "todo" : missing.length ? "todo" : "done", {
        value: [...SLACK_SCOPES, ...SLACK_EXTRA_SCOPES].join(", "),
        ...(missing.length ? { detail: `Missing: ${missing.join(", ")}` } : {}),
        link: apps,
      }),
    );
    if (!config(runtime, "signingSecret")) steps.push(step("slack.signing", "Paste the app's Signing Secret (Basic Information)", "error", { link: apps }));
    const events = `Bot events: app_mention, message.im${runtime.channel.always ? ", message.channels, message.groups" : ""}`;
    steps.push(
      step("slack.events", "Event Subscriptions → Request URL", !runtime.webhookUrl ? "error" : runtime.state.get("eventsAt") ? "done" : "todo", {
        value: hookUrl,
        detail: runtime.webhookUrl ? events : `Needs Z_PUBLIC_URL: Slack can't reach this machine. ${events}`,
        link: apps,
      }),
      step("slack.interactivity", "Interactivity → Request URL (same URL, for Approve/Deny buttons)", "info", { value: hookUrl, link: apps }),
      step("slack.invite", `Invite the bot to a channel: /invite @${me.ok ? me.value.user : "z"}`, "info"),
    );
    return steps;
  },
  webhook: async (request, runtime) => {
    const raw = await request.text();
    const ok = verifySlackSignature(
      config(runtime, "signingSecret"),
      request.headers.get("x-slack-request-timestamp"),
      request.headers.get("x-slack-signature"),
      raw,
    );
    if (!ok) {
      runtime.note?.("rejected", "Invalid Slack signature");
      return new Response("Invalid signature", { status: 401 });
    }
    // For the setup checklist: Slack has reached the Events URL at least once.
    if (!runtime.state.get("eventsAt")) runtime.state.set("eventsAt", new Date().toISOString());
    if (request.headers.get("content-type")?.includes("application/x-www-form-urlencoded")) {
      const action = slackAction(parseSlackForm(raw) ?? { type: "" });
      if (!action) return new Response("", { status: 200 });
      // Ack within 3 seconds; the outcome goes back through response_url.
      void (async () => {
        const { ack, final } = await pressed(runtime, action.actionId, action.from);
        const res = await runtime.fetch(action.responseUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            final
              ? { replace_original: true, text: truncate(`${action.text}\n\n${ack}`, 3900) }
              : { replace_original: false, response_type: "ephemeral", text: ack },
          ),
          signal: requestSignal(),
        });
        if (!res.ok) throw new Error(`Slack response_url: ${res.status}`);
      })().catch((error) => runtime.log(`slack: ${errorMessage(error)}`));
      return new Response("", { status: 200 });
    }
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
