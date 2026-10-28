/** Built-in long-term memory tools. Server-provided because they need z's own storage. */
import { randomUUID } from "node:crypto";
import { definePlugin, defineTool, say, type ZPlugin } from "@z/core";
import { z } from "zod";
import { clip, notify, type NoticeInput } from "../notify.ts";
import type { Store } from "../store.ts";

/** Where the owner reviews memories: Settings → Personalization with the memories dialog open. */
export const MEMORY_REVIEW_PATH = "/?settings=personalization&memories=review";
/** At most one "wants to remember" notice an hour. */
const NOTICE_EVERY_MS = 60 * 60_000;
/** Lets the memories of one conversation land together before telling the owner. */
const NOTICE_DELAY_MS = 60_000;

/**
 * Batches the review notice for memories z wrote itself. Holding agent-formed memories until the person
 * confirms them is an idea from CopilotKit/OpenDuet (MIT), `openbot/server/src/memory/store.ts`.
 */
function reviewNotices(store: Store) {
  let timer: NodeJS.Timeout | null = null;
  const send = () => {
    timer = null;
    const notice = memoryNotice(store);
    if (!notice) return;
    store.kv.set("memory.noticedAt", new Date().toISOString());
    notify(notice);
  };
  return () => {
    if (timer) return;
    const last = Date.parse(store.kv.get<string>("memory.noticedAt") ?? "") || 0;
    timer = setTimeout(send, Math.max(NOTICE_DELAY_MS, last + NOTICE_EVERY_MS - Date.now()));
    timer.unref();
  };
}

/** The "wants to remember" notice for the memories waiting for review, or null when none wait. */
export function memoryNotice(store: Store): NoticeInput | null {
  const waiting = store.memories.list({ status: "unreviewed" });
  if (waiting.length === 0) return null;
  return {
    kind: "memory",
    title: say("noticeMemory", { handle: store.settings.get().handle, count: waiting.length }),
    body: waiting
      .slice(0, 5)
      .map((m) => `• ${clip(m.text, 120)}`)
      .join("\n"),
    path: MEMORY_REVIEW_PATH,
  };
}

export function memoryPlugin(store: Store): ZPlugin {
  const askReview = reviewNotices(store);
  return definePlugin({
    id: "memory",
    name: "Memory",
    description: "Lets z remember lasting facts and preferences about you, and recall them later. Never available to channel bots.",
    tools: {
      remember: defineTool({
        description:
          "Save a lasting fact or preference about the user (e.g. 'Prefers answers in Vietnamese', 'Works on the z repo'). One fact per call, written as a short sentence. Never store secrets.",
        risk: "write",
        // Only changes z's own memory, so it runs without asking unless the user says otherwise.
        defaultPolicy: "allow",
        ownerOnly: true,
        inputSchema: z.object({ text: z.string().min(1).max(2000) }),
        summarize: ({ text }) => `Remember "${text.length > 80 ? `${text.slice(0, 79)}…` : text}"`,
        execute: async ({ text }) => {
          const review = store.settings.get().memoryReview;
          const memory = store.memories.add(randomUUID(), text.trim(), "agent", review ? "unreviewed" : "active");
          if (memory.status === "active") return { ok: true, id: memory.id };
          askReview();
          // Said so the model doesn't act as if it will use this right away.
          return { ok: true, id: memory.id, note: "Saved for the user to review. It is used once they confirm it." };
        },
      }),
      recall: defineTool({
        description: "Search what you remember about the user. Leave the query empty for the most recent memories.",
        risk: "read",
        ownerOnly: true,
        inputSchema: z.object({ query: z.string().default(""), limit: z.number().int().min(1).max(20).default(8) }),
        // Active memories only: unreviewed ones wait for the owner.
        execute: async ({ query, limit }) => ({
          memories: (query.trim() ? store.memories.search(query, { status: "active" }, limit) : store.memories.list({ status: "active" }, limit)).map(
            (m) => ({ text: m.text, source: m.source, pinned: m.pinned, updatedAt: m.updatedAt }),
          ),
        }),
      }),
    },
  });
}
