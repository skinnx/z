/**
 * The delivery hub. Every Notice is stored, streamed to open apps, pushed to registered devices
 * and sent to the paired owner channel (with Approve / Deny buttons for approvals).
 *
 *   notify({ kind: "watch", title: "Price dropped", body: "…", path: "/tasks?task=…" });
 *
 * Approve only what you can see: an approval's body is its complete preview, and push or channel
 * messages carry an Approve button only when all of it fits the medium. Otherwise they say
 * "Open z to review" and approve nothing.
 */
import { randomUUID } from "node:crypto";
import { describeError, previewFits, type Approval, type Notice } from "@z/core";
import type { Channels } from "./channels.ts";
import type { Push, PushPayload } from "./push.ts";
import type { Runtime } from "./runtime.ts";

export type NoticeInput = Omit<Notice, "id" | "read" | "createdAt">;

/** What the service worker shows; longer bodies are cut, so an approval that needs more opens the app. */
export const PUSH_BODY_MAX = 600;
const OPEN_TO_REVIEW = "Too long to approve here. Open z to review it.";

let hub: { rt: Runtime; push: Push; channels: Channels } | null = null;

/** Wire the hub once at startup, before anything can raise a notice. */
export function startDelivery(rt: Runtime, push: Push, channels: Channels) {
  hub = { rt, push, channels };
}

/** Persist and fan out a notice. Delivery happens in the background; failures are logged. */
export function notify(input: NoticeInput): Notice {
  if (!hub) throw new Error("notify() called before startDelivery()");
  const notice: Notice = { id: randomUUID(), ...input, read: false, createdAt: new Date().toISOString() };
  hub.rt.store.notices.insert(notice);
  hub.rt.bus.emit({ type: "notice", notice });
  void deliver(hub, notice);
  return notice;
}

/** An approval notice's body: why it asks, then the whole preview. */
export function approvalBody(approval: Pick<Approval, "reason" | "preview">): string {
  return [approval.reason ? `Asking because ${approval.reason}` : "", approval.preview.fullText].filter(Boolean).join("\n\n");
}

/** The push payload: Approve / Deny only when the complete body fits; otherwise marked truncated. */
export function pushPayload({ id, kind, title, body, path, approvalId }: Notice): PushPayload {
  if (!approvalId) return { id, kind, title, body: clip(body, PUSH_BODY_MAX), path };
  if (previewFits(body, PUSH_BODY_MAX)) return { id, kind, title, body, path, approvalId };
  return { id, kind, title, body: `${clip(body, PUSH_BODY_MAX - OPEN_TO_REVIEW.length - 2)}\n\n${OPEN_TO_REVIEW}`, path, approvalId, truncated: true };
}

/** The owner-channel message: buttons only when title, complete body and link fit `limit`. */
export function channelMessage({ title, body, approvalId }: Notice, link: string, limit: number): Parameters<Channels["send"]>[2] {
  const text = `${title}\n${body}${link}`;
  if (!approvalId) return { text };
  if (previewFits(text, limit)) {
    return {
      text,
      actions: [
        { id: `approve:${approvalId}`, label: "Approve", style: "primary" },
        { id: `deny:${approvalId}`, label: "Deny", style: "danger" },
      ],
    };
  }
  const room = Math.max(80, limit - title.length - link.length - OPEN_TO_REVIEW.length - 8);
  return { text: `${title}\n${clip(body, room)}\n\n${OPEN_TO_REVIEW}${link}` };
}

async function deliver({ rt, push, channels }: NonNullable<typeof hub>, notice: Notice) {
  const jobs: Promise<unknown>[] = [push.send(pushPayload(notice))];

  const owner = rt.store.settings.get().owner;
  if (owner) {
    const link = rt.env.publicUrl ? `\n${rt.env.publicUrl}${notice.path}` : "";
    jobs.push(channels.send(owner.channelId, owner.threadId, channelMessage(notice, link, channels.noticeLimit(owner.channelId))));
  }

  for (const result of await Promise.allSettled(jobs)) {
    if (result.status === "rejected") console.error(`[z:notify] ${notice.kind} notice: ${describeError(result.reason)}`);
  }
}

export const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
