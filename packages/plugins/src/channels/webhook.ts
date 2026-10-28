import { RateLimitedError, type ChannelAdapter, type ChannelRuntime, type InboundMessage } from "@z/core";
import { z } from "zod";
import { errorMessage, hmacSha256Hex, safeEqual } from "../util.ts";
import { config, pressed, requestSignal, step } from "./shared.ts";

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

// ─── Signing: X-Z-Signature: v1=<hex HMAC-SHA256(secret, "<timestamp>.<delivery>.<raw body>")> ─

/** Signed requests older or newer than this are refused (replays past the receipt window). */
export const SIGNATURE_TOLERANCE_S = 300;
const MAX_BODY_BYTES = 512_000;
const DELIVERY_ID = /^[A-Za-z0-9._:-]{1,200}$/;

export function signature(secret: string, timestamp: string, delivery: string, body: string): string {
  return `v1=${hmacSha256Hex(secret, `${timestamp}.${delivery}.${body}`)}`;
}

/** Headers for a signed POST of `body` (outbound owner notices). Pass `delivery` to keep it stable across retries. */
export function signedHeaders(secret: string, body: string, now = Date.now(), delivery: string = crypto.randomUUID()): Record<string, string> {
  const timestamp = String(Math.floor(now / 1000));
  return { "x-z-timestamp": timestamp, "x-z-delivery": delivery, "x-z-signature": signature(secret, timestamp, delivery, body) };
}

/**
 * Check a request's signature over its raw body, before anything parses it. Legacy mode also
 * accepts the bare shared secret in X-Z-Secret when the request carries no signature.
 * Returns the delivery id (null for an unsigned legacy request without one), or an error.
 */
export function verify(
  headers: Headers,
  body: string,
  secret: string,
  legacy: boolean,
  now = Date.now(),
): { ok: true; delivery: string | null } | { ok: false; error: string } {
  const sig = headers.get("x-z-signature");
  const delivery = headers.get("x-z-delivery");
  if (delivery !== null && !DELIVERY_ID.test(delivery)) return { ok: false, error: "Invalid X-Z-Delivery" };
  if (sig === null) {
    if (!legacy) return { ok: false, error: "Missing X-Z-Signature" };
    return safeEqual(headers.get("x-z-secret") ?? "", secret) ? { ok: true, delivery } : { ok: false, error: "Invalid X-Z-Secret" };
  }
  const timestamp = headers.get("x-z-timestamp") ?? "";
  if (!delivery || !/^\d{1,12}$/.test(timestamp)) return { ok: false, error: "Signed requests need X-Z-Timestamp and X-Z-Delivery" };
  if (Math.abs(now / 1000 - Number(timestamp)) > SIGNATURE_TOLERANCE_S) return { ok: false, error: "Stale X-Z-Timestamp" };
  if (!safeEqual(sig.trim().toLowerCase(), signature(secret, timestamp, delivery, body))) return { ok: false, error: "Invalid X-Z-Signature" };
  return { ok: true, delivery };
}

/** A signed POST to the channel's notifyUrl; throws unless it answers 2xx. */
async function notifyPost(runtime: ChannelRuntime, payload: unknown, delivery: string) {
  const url = config(runtime, "notifyUrl");
  if (!url) throw new Error("notifyUrl is not configured");
  const secret = config(runtime, "secret");
  const body = JSON.stringify(payload);
  const res = await runtime.fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...signedHeaders(secret, body, Date.now(), delivery),
      ...(config(runtime, "legacySecret") === "on" ? { "x-z-secret": secret } : {}),
    },
    body,
    signal: requestSignal(),
  });
  await res.body?.cancel();
  if (!res.ok) throw new Error(`notifyUrl answered ${res.status}`);
}

export const webhookAdapter: ChannelAdapter = {
  kind: "webhook",
  label: "Webhook (JSON)",
  config: [
    { key: "secret", label: "Signing secret (HMAC-SHA256)", secret: true, required: true, generate: true },
    { key: "notifyUrl", label: "Notify URL (optional): receives signed owner notices as JSON POSTs" },
    { key: "legacySecret", label: "Legacy mode: also accept the bare secret in X-Z-Secret, unsigned", toggle: true, legacy: true },
  ],
  setup: async (runtime, hookUrl) => [
    step("webhook.secret", "Keep the signing secret in your integration", config(runtime, "secret") ? "done" : "error"),
    step("webhook.url", runtime.webhookUrl ? "POST signed JSON to this URL" : "POST signed JSON to this URL (this machine only)", runtime.webhookUrl ? "done" : "info", {
      value: hookUrl,
      ...(runtime.webhookUrl ? {} : { detail: "Set Z_PUBLIC_URL for a URL other machines can reach" }),
    }),
    step("webhook.notify", "Notify URL for owner notices (optional)", config(runtime, "notifyUrl") ? "done" : "info"),
    ...(config(runtime, "legacySecret") === "on"
      ? [step("webhook.legacy", "Sign requests, then turn off legacy mode", "todo")]
      : []),
  ],
  // `id` names the notice message (the same on every retry, and the X-Z-Delivery); a later
  // `notice.update` with the same `id` replaces its text and removes its actions.
  send: async (runtime, threadId, message) => {
    const id = message.id ?? crypto.randomUUID();
    await notifyPost(runtime, { type: "notice", id, threadId, text: message.text, actions: message.actions ?? [] }, id);
    return { ref: id };
  },
  edit: async (runtime, threadId, ref, text) => {
    await notifyPost(runtime, { type: "notice.update", id: ref, threadId, text, actions: [] }, `${ref}.update`);
  },
  webhook: async (request, runtime) => {
    const secret = config(runtime, "secret");
    if (!secret) return Response.json({ error: "Channel has no secret configured" }, { status: 503 });
    if (request.method !== "POST") return Response.json({ error: "Use POST" }, { status: 405 });
    if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
      return Response.json({ error: "Body too large" }, { status: 413 });
    }
    const text = await request.text();
    if (Buffer.byteLength(text) > MAX_BODY_BYTES) return Response.json({ error: "Body too large" }, { status: 413 });
    const verified = verify(request.headers, text, secret, config(runtime, "legacySecret") === "on");
    if (!verified.ok) {
      runtime.note?.("rejected", verified.error);
      return Response.json({ error: verified.error }, { status: 401 });
    }

    let action: z.output<typeof WebhookAction> | null;
    let body: z.output<typeof WebhookBody> | null = null;
    try {
      const raw: unknown = JSON.parse(text);
      action = raw && typeof raw === "object" && "action" in raw ? WebhookAction.parse(raw) : null;
      if (!action) body = WebhookBody.parse(raw);
    } catch (error) {
      return Response.json({ error: `Invalid body: ${errorMessage(error)}` }, { status: 400 });
    }
    const { delivery } = verified;
    if (delivery && !runtime.deliveries.claim(delivery)) return Response.json({ duplicate: true, delivery });

    if (action) {
      const { ack, final } = await pressed(runtime, action.action, { threadId: action.threadId, authorId: action.authorId });
      // A refused press may be retried (by the owner), so it doesn't use up the delivery id.
      if (!final && delivery) runtime.deliveries.release(delivery);
      return final ? Response.json({ ack }) : Response.json({ error: ack }, { status: 403 });
    }
    const message = webhookToInbound(body!, runtime.channel.id);
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
      // Nothing was answered: let the integration retry with the same delivery id.
      if (delivery) runtime.deliveries.release(delivery);
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
