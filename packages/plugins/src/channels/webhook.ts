import type { ChannelAdapter, InboundMessage } from "@z/core";
import { z } from "zod";
import { errorMessage, safeEqual } from "../util.ts";
import { config } from "./shared.ts";

const ContextEntry = z.union([
  z.string(),
  z.object({ author: z.string().optional(), text: z.string(), url: z.string().optional() }),
]);

export const WebhookBody = z.object({
  text: z.string().min(1).max(20_000),
  threadId: z.string().max(200).optional(),
  messageId: z.string().max(200).optional(),
  author: z.union([z.string(), z.object({ id: z.string().optional(), name: z.string() })]).optional(),
  context: z.union([ContextEntry, z.array(ContextEntry)]).optional(),
});

export function webhookToInbound(body: z.output<typeof WebhookBody>, channelId: string, now = new Date()): InboundMessage {
  const author =
    typeof body.author === "string"
      ? { id: body.author, name: body.author }
      : { id: body.author?.id ?? body.author?.name ?? "webhook", name: body.author?.name ?? "webhook" };
  const entries = body.context === undefined ? [] : Array.isArray(body.context) ? body.context : [body.context];
  const context = entries.map((c) =>
    typeof c === "string" ? { author: "unknown", text: c } : { author: c.author ?? "unknown", text: c.text, ...(c.url ? { url: c.url } : {}) },
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
    receivedAt: now.toISOString(),
  };
}

export const webhookAdapter: ChannelAdapter = {
  kind: "webhook",
  label: "Webhook (JSON)",
  config: [{ key: "secret", label: "Shared secret (sent as X-Z-Secret)", secret: true, required: true }],
  webhook: async (request, runtime) => {
    const secret = config(runtime, "secret");
    if (!secret) return Response.json({ error: "Channel has no secret configured" }, { status: 503 });
    if (request.method !== "POST") return Response.json({ error: "Use POST" }, { status: 405 });
    if (!safeEqual(request.headers.get("x-z-secret") ?? "", secret)) {
      return Response.json({ error: "Invalid X-Z-Secret" }, { status: 401 });
    }
    let body: z.output<typeof WebhookBody>;
    try {
      body = WebhookBody.parse(await request.json());
    } catch (error) {
      return Response.json({ error: `Invalid body: ${errorMessage(error)}` }, { status: 400 });
    }
    const message = webhookToInbound(body, runtime.channel.id);
    try {
      const reply = await runtime.dispatch(message);
      runtime.status("ok");
      return Response.json({ reply: reply?.text ?? null, threadId: message.threadId, messageId: message.messageId });
    } catch (error) {
      runtime.status("error", errorMessage(error));
      return Response.json({ error: "Bot failed to answer" }, { status: 500 });
    }
  },
};
