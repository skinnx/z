/**
 * The delivery hub. Every Notice is stored, streamed to open apps, pushed to registered devices
 * and sent to the paired owner channel (with Approve / Deny buttons for approvals).
 *
 *   notify({ kind: "watch", title: "Price dropped", body: "…", path: "/tasks?task=…" });
 */
import { randomUUID } from "node:crypto";
import { describeError, type Notice } from "@z/core";
import type { Channels } from "./channels.ts";
import type { Push } from "./push.ts";
import type { Runtime } from "./runtime.ts";

export type NoticeInput = Omit<Notice, "id" | "read" | "createdAt">;

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

async function deliver({ rt, push, channels }: NonNullable<typeof hub>, notice: Notice) {
  const { id, kind, title, body, path, approvalId } = notice;
  const jobs: Promise<unknown>[] = [push.send({ id, kind, title, body: clip(body, 600), path, ...(approvalId ? { approvalId } : {}) })];

  const owner = rt.store.settings.get().owner;
  if (owner) {
    const link = rt.env.publicUrl ? `\n${rt.env.publicUrl}${path}` : "";
    jobs.push(
      channels.send(owner.channelId, owner.threadId, {
        text: `${title}\n${body}${link}`,
        ...(approvalId
          ? {
              actions: [
                { id: `approve:${approvalId}`, label: "Approve", style: "primary" as const },
                { id: `deny:${approvalId}`, label: "Deny", style: "danger" as const },
              ],
            }
          : {}),
      }),
    );
  }

  for (const result of await Promise.allSettled(jobs)) {
    if (result.status === "rejected") console.error(`[z:notify] ${kind} notice: ${describeError(result.reason)}`);
  }
}

export const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
