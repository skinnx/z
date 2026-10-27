import type { ChannelAdapter, ChannelRuntime, InboundMessage, OutboundReply } from "@z/core";
import { backoff, errorMessage, mentionsHandle, safeEqual, sha256Hex, sleep, truncate } from "../util.ts";
import { config, pressed, shouldDispatch, untilAuthorized, type Action } from "./shared.ts";

type TgUser = { id: number; is_bot: boolean; first_name: string; last_name?: string; username?: string };
type TgEntity = { type: string; offset: number; length: number; user?: TgUser };
type TgChat = { id: number; type: "private" | "group" | "supergroup" | "channel"; username?: string };
export type TgMessage = {
  message_id: number;
  message_thread_id?: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
  caption?: string;
  entities?: TgEntity[];
  caption_entities?: TgEntity[];
  reply_to_message?: TgMessage;
  /** Part of the replied-to message the user explicitly quoted. */
  quote?: { text: string };
};
export type TgCallbackQuery = { id: string; from: TgUser; message?: TgMessage; data?: string };
export type TgUpdate = { update_id: number; message?: TgMessage; callback_query?: TgCallbackQuery };
export type TgBot = { id: number; username: string };

function displayName(user: TgUser | undefined): string {
  if (!user) return "unknown";
  return [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username || String(user.id);
}

const threadOf = (m: TgMessage) => (m.message_thread_id ? `${m.chat.id}:${m.message_thread_id}` : String(m.chat.id));

function messageUrl(m: TgMessage): string | undefined {
  return m.chat.username ? `https://t.me/${m.chat.username}/${m.message_id}` : undefined;
}

/** Pure mapping from a Telegram update to an InboundMessage; null when it should be ignored. */
export function telegramToInbound(
  update: TgUpdate,
  opts: { channelId: string; bot: TgBot; handle: string },
): InboundMessage | null {
  const m = update.message;
  if (!m || !m.from || m.from.is_bot) return null;
  const raw = m.text ?? m.caption;
  if (!raw) return null;
  const entities = (m.text ? m.entities : m.caption_entities) ?? [];
  // Entity offsets are in UTF-16 code units, which is what String#slice uses.
  const botMention = `@${opts.bot.username}`.toLowerCase();
  const mentioned = entities.some(
    (e) =>
      (e.type === "mention" && raw.slice(e.offset, e.offset + e.length).toLowerCase() === botMention) ||
      (e.type === "text_mention" && e.user?.id === opts.bot.id),
  );
  const repliedToBot = m.reply_to_message?.from?.id === opts.bot.id;
  const addressed = m.chat.type === "private" || mentioned || repliedToBot || mentionsHandle(raw, opts.handle);
  const text = raw.replace(new RegExp(`@${opts.bot.username}\\b`, "gi"), `@${opts.handle}`);
  const parent = m.reply_to_message;
  const parentText = m.quote?.text ?? parent?.text ?? parent?.caption;
  const url = parent && messageUrl(parent);
  return {
    channelId: opts.channelId,
    threadId: threadOf(m),
    messageId: String(m.message_id),
    author: { id: String(m.from.id), name: displayName(m.from) },
    text,
    addressed,
    ...(parent && parentText ? { context: [{ author: displayName(parent.from), text: parentText, ...(url ? { url } : {}) }] } : {}),
    receivedAt: new Date(m.date * 1000).toISOString(),
  };
}

/** Pure mapping from an inline-button press (`callback_query`); null when it carries no action. */
export function telegramAction(update: TgUpdate) {
  const q = update.callback_query;
  if (!q?.data || !q.message || q.from.is_bot) return null;
  return {
    queryId: q.id,
    actionId: q.data,
    from: { threadId: threadOf(q.message), authorId: String(q.from.id) },
    chatId: q.message.chat.id,
    messageId: q.message.message_id,
    text: q.message.text ?? "",
  };
}

/** Actions as an inline keyboard, one row. `callback_data` is capped at 64 bytes by Telegram. */
export function telegramKeyboard(actions: Action[]) {
  return { inline_keyboard: [actions.map((a) => ({ text: a.label, callback_data: a.id }))] };
}

// ─── Bot API ────────────────────────────────────────────────────────────────

async function call<T>(runtime: ChannelRuntime, method: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const token = config(runtime, "botToken");
  if (!token) throw new Error("botToken is not configured");
  let res: Response;
  try {
    // The token is part of the URL by protocol design; keep it out of error messages.
    res = await runtime.fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    throw new Error(`Telegram ${method}: ${errorMessage(error).replaceAll(token, "***")}`);
  }
  const data = (await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }))) as {
    ok: boolean;
    result?: T;
    description?: string;
    error_code?: number;
  };
  if (!data.ok) {
    let detail = String(data.description).replaceAll(token, "***");
    if (data.error_code === 401 || data.error_code === 404) detail = `bot token rejected (${detail})`;
    throw Object.assign(new Error(`Telegram ${method}: ${detail}`), { code: data.error_code });
  }
  return data.result as T;
}

const ALLOWED_UPDATES = ["message", "callback_query"];

const bots = new Map<string, Promise<TgBot>>();

function getBot(runtime: ChannelRuntime): Promise<TgBot> {
  const key = sha256Hex(config(runtime, "botToken"));
  let bot = bots.get(key);
  if (!bot) {
    bot = call<{ id: number; username: string }>(runtime, "getMe", {}).then(({ id, username }) => ({ id, username }));
    bot.catch(() => bots.delete(key));
    bots.set(key, bot);
  }
  return bot;
}

/**
 * Telegram echoes `secret_token` back in X-Telegram-Bot-Api-Secret-Token. When the user set none,
 * derive one from the bot token so webhook mode is never unauthenticated.
 */
function webhookSecret(runtime: ChannelRuntime): string {
  return config(runtime, "webhookSecret") || sha256Hex(`z-telegram-webhook:${config(runtime, "botToken")}`);
}

async function handleUpdate(runtime: ChannelRuntime, update: TgUpdate): Promise<void> {
  const action = telegramAction(update);
  if (action) return handleAction(runtime, action);
  const bot = await getBot(runtime);
  const message = telegramToInbound(update, { channelId: runtime.channel.id, bot, handle: runtime.handle });
  if (!message || !shouldDispatch(message, runtime)) return;
  const reply = await runtime.dispatch(message);
  if (reply) await sendReply(runtime, update.message!, reply);
}

async function handleAction(runtime: ChannelRuntime, action: NonNullable<ReturnType<typeof telegramAction>>) {
  const { ack, final } = await pressed(runtime, action.actionId, action.from);
  await call(runtime, "answerCallbackQuery", { callback_query_id: action.queryId, text: truncate(ack, 200), show_alert: !final });
  // Without reply_markup the keyboard is removed, so the outcome replaces the buttons.
  if (final) {
    await call(runtime, "editMessageText", {
      chat_id: action.chatId,
      message_id: action.messageId,
      text: truncate(`${action.text}\n\n${ack}`, 4096),
    });
  }
}

async function sendReply(runtime: ChannelRuntime, m: TgMessage, reply: OutboundReply): Promise<void> {
  await call(runtime, "sendMessage", {
    chat_id: m.chat.id,
    text: truncate(reply.text, 4096),
    ...(m.message_thread_id ? { message_thread_id: m.message_thread_id } : {}),
    // reply_parameters supersedes the older reply_to_message_id (Bot API 7.0).
    reply_parameters: { message_id: Number(reply.replyTo) || m.message_id, allow_sending_without_reply: true },
  });
}

function processInBackground(runtime: ChannelRuntime, update: TgUpdate): void {
  handleUpdate(runtime, update).catch((error) => {
    runtime.log(`telegram: ${errorMessage(error)}`);
    runtime.status("error", errorMessage(error));
  });
}

async function poll(runtime: ChannelRuntime, signal: AbortSignal): Promise<void> {
  // Persisted so a restart neither replays nor skips updates Telegram is still holding.
  let offset = Number(runtime.state.get("offset")) || 0;
  let attempt = 0;
  // getUpdates returns 409 while a webhook is registered.
  while (!signal.aborted) {
    try {
      await call(runtime, "deleteWebhook", { drop_pending_updates: false }, signal);
      break;
    } catch (error) {
      if (signal.aborted) return;
      runtime.status("error", errorMessage(error));
      await sleep(backoff(attempt++), signal);
    }
  }
  attempt = 0;
  let healthy = false;
  while (!signal.aborted) {
    try {
      const updates = await call<TgUpdate[]>(
        runtime,
        "getUpdates",
        { offset, timeout: 30, allowed_updates: ALLOWED_UPDATES },
        signal,
      );
      if (!healthy) runtime.status("ok", "Long polling");
      healthy = true;
      attempt = 0;
      for (const update of updates) {
        offset = update.update_id + 1;
        processInBackground(runtime, update);
      }
      if (updates.length) runtime.state.set("offset", String(offset));
    } catch (error) {
      if (signal.aborted) return;
      healthy = false;
      runtime.status("error", errorMessage(error));
      await sleep(backoff(attempt++), signal);
    }
  }
}

async function registerWebhook(runtime: ChannelRuntime, url: string, signal: AbortSignal): Promise<void> {
  for (let attempt = 0; !signal.aborted; attempt++) {
    try {
      const bot = await getBot(runtime);
      await call(runtime, "setWebhook", { url, secret_token: webhookSecret(runtime), allowed_updates: ALLOWED_UPDATES }, signal);
      runtime.status("ok", `Webhook set for @${bot.username}`);
      return;
    } catch (error) {
      if (signal.aborted) return;
      runtime.status("error", errorMessage(error));
      await sleep(backoff(attempt, 300_000), signal);
    }
  }
}

export const telegramAdapter: ChannelAdapter = {
  kind: "telegram",
  label: "Telegram",
  config: [
    { key: "botToken", label: "Bot token (from @BotFather)", secret: true, required: true },
    { key: "webhookSecret", label: "Webhook secret (optional)", secret: true },
  ],
  send: async (runtime, threadId, message) => {
    const [chatId, topic] = threadId.split(":");
    await call(runtime, "sendMessage", {
      chat_id: chatId,
      ...(topic ? { message_thread_id: Number(topic) } : {}),
      text: truncate(message.text, 4096),
      ...(message.actions?.length ? { reply_markup: telegramKeyboard(message.actions) } : {}),
    });
  },
  webhook: async (request, runtime) => {
    if (!config(runtime, "botToken")) return new Response("Not configured", { status: 503 });
    if (!safeEqual(request.headers.get("x-telegram-bot-api-secret-token") ?? "", webhookSecret(runtime))) {
      return new Response("Forbidden", { status: 401 });
    }
    const update = (await request.json().catch(() => null)) as TgUpdate | null;
    if (!update || typeof update.update_id !== "number") return new Response("Bad request", { status: 400 });
    // Answer immediately: Telegram redelivers on slow or failed responses.
    processInBackground(runtime, update);
    return new Response("ok");
  },
  start: async (runtime) => {
    const controller = new AbortController();
    if (!config(runtime, "botToken")) {
      runtime.status("error", "botToken is required");
      return () => {};
    }
    const { signal } = controller;
    const auth = await untilAuthorized(runtime, () => getBot(runtime), signal);
    void auth.ready.then((ok) => {
      if (!ok) return;
      if (runtime.webhookUrl) return registerWebhook(runtime, runtime.webhookUrl, signal);
      return poll(runtime, signal);
    });
    return () => controller.abort();
  },
};
