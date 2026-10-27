import { RateLimitedError, type ChannelAdapter, type InboundMessage } from "@z/core";
import { z } from "zod";
import { errorMessage, safeEqual } from "../util.ts";
import { config, pressed } from "./shared.ts";

/** Public http(s) image URLs; the server downloads them for the model. */
const Images = z.array(z.url({ protocol: /^https?$/ })).max(4).optional();

const ContextEntry = z.union([
  z.string(),
  z.object({ author: z.string().optional(), text: z.string(), url: z.string().optional(), images: Images }),
]);

export const WebhookBody = z.object({
  text: z.string().min(1).max(20_000),
  threadId: z.string().max(200).optional(),
  messageId: z.string().max(200).optional(),
  author: z.union([z.string(), z.object({ id: z.string().optional(), name: z.string() })]).optional(),
  context: z.union([ContextEntry, z.array(ContextEntry)]).optional(),
  images: Images,
});

/** A button press relayed by the integration: `{ action, threadId, authorId }`. */
export const WebhookAction = z.object({
  action: z.string().min(1).max(200),
  threadId: z.string().max(200),
  authorId: z.string().max(200),
});

export function webhookToInbound(body: z.output<typeof WebhookBody>, channelId: string, now = new Date()): InboundMessage {
  const author =
    typeof body.author === "string"
      ? { id: body.author, name: body.author }
      : { id: body.author?.id ?? body.author?.name ?? "webhook", name: body.author?.name ?? "webhook" };
  const entries = body.context === undefined ? [] : Array.isArray(body.context) ? body.context : [body.context];
  const context = entries.map((c) =>
    typeof c === "string"
      ? { author: "unknown", text: c }
      : { author: c.author ?? "unknown", text: c.text, ...(c.url ? { url: c.url } : {}), ...(c.images?.length ? { images: c.images } : {}) },
  );
  const messageId = body.messageId ?? crypto.randomUUID();
  return {
    channelId,
    threadId: body.threadId ?? messageId,
    messageId,
    author,
    text: body.text,
    // Calling the webhook is itself an explicit request to the bot.
    addressed: true,
    ...(context.length ? { context } : {}),
    ...(body.images?.length ? { images: body.images } : {}),
    receivedAt: now.toISOString(),
  };
}

export const webhookAdapter: ChannelAdapter = {
  kind: "webhook",
  label: "Webhook (JSON)",
  config: [
    { key: "secret", label: "Shared secret (sent as X-Z-Secret)", secret: true, required: true },
    { key: "notifyUrl", label: "Notify URL (optional): receives owner notices as JSON POSTs" },
  ],
  send: async (runtime, threadId, message) => {
    const url = config(runtime, "notifyUrl");
    if (!url) throw new Error("notifyUrl is not configured");
    const res = await runtime.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-z-secret": config(runtime, "secret") },
      body: JSON.stringify({ type: "notice", threadId, text: message.text, actions: message.actions ?? [] }),
      signal: AbortSignal.timeout(15_000),
    });
    await res.body?.cancel();
    if (!res.ok) throw new Error(`notifyUrl answered ${res.status}`);
  },
  webhook: async (request, runtime) => {
    const secret = config(runtime, "secret");
    if (!secret) return Response.json({ error: "Channel has no secret configured" }, { status: 503 });
    if (request.method !== "POST") return Response.json({ error: "Use POST" }, { status: 405 });
    if (!safeEqual(request.headers.get("x-z-secret") ?? "", secret)) {
      return Response.json({ error: "Invalid X-Z-Secret" }, { status: 401 });
    }
    let raw: unknown;
    let body: z.output<typeof WebhookBody>;
    try {
      raw = await request.json();
      const action = raw && typeof raw === "object" && "action" in raw ? WebhookAction.parse(raw) : null;
      if (action) {
        const { ack, final } = await pressed(runtime, action.action, { threadId: action.threadId, authorId: action.authorId });
        return final ? Response.json({ ack }) : Response.json({ error: ack }, { status: 403 });
      }
      body = WebhookBody.parse(raw);
    } catch (error) {
      return Response.json({ error: `Invalid body: ${errorMessage(error)}` }, { status: 400 });
    }
    const message = webhookToInbound(body, runtime.channel.id);
    try {
      const reply = await runtime.dispatch(message);
      runtime.status("ok");
      return Response.json({
        reply: reply?.text ?? null,
        verdict: reply?.verdict ?? null,
        sources: reply?.sources ?? [],
        threadId: message.threadId,
        messageId: message.messageId,
      });
    } catch (error) {
      runtime.status("error", errorMessage(error));
      if (error instanceof RateLimitedError) {
        const seconds = Math.max(1, Math.ceil(error.retryAfterMs / 1000));
        return Response.json(
          { error: "Every model is rate limited right now", retryAfter: seconds },
          { status: 503, headers: { "retry-after": String(seconds) } },
        );
      }
      return Response.json({ error: "Bot failed to answer" }, { status: 500 });
    }
  },
};
