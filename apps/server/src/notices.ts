/** Notices: everything z tells its owner goes through `notify()`. */
import { randomUUID } from "node:crypto";
import type { Notice } from "@z/core";
import type { Bus } from "./bus.ts";
import type { Store } from "./store.ts";

export type NoticeInput = Omit<Notice, "id" | "read" | "createdAt">;

export type Notifier = ReturnType<typeof createNotifier>;

export function createNotifier(store: Store, bus: Bus) {
  /**
   * The single place a notice is raised: stored for the in-app inbox and broadcast live.
   * Out-of-app delivery (Web Push, the owner's channel) hooks in here.
   */
  function notify(input: NoticeInput): Notice {
    const notice: Notice = {
      id: randomUUID(),
      ...input,
      title: clip(input.title, 160),
      body: clip(input.body, 2000),
      read: false,
      createdAt: new Date().toISOString(),
    };
    store.notices.insert(notice);
    bus.emit({ type: "notice", notice });
    return notice;
  }

  function markRead(ids?: string[]) {
    for (const notice of store.notices.markRead(ids)) bus.emit({ type: "notice", notice });
  }

  return { notify, markRead };
}

const clip = (s: string, n: number) => {
  const flat = s.trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};
