/** Built-in long-term memory tools. Server-provided because they need z's own storage. */
import { randomUUID } from "node:crypto";
import { definePlugin, defineTool, rankMemories, type ZPlugin } from "@z/core";
import { z } from "zod";
import type { Store } from "../store.ts";

export function memoryPlugin(store: Store): ZPlugin {
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
          const memory = store.memories.add(randomUUID(), text.trim(), "agent");
          return { ok: true, id: memory.id };
        },
      }),
      recall: defineTool({
        description: "Search what you remember about the user. Leave the query empty for the most recent memories.",
        risk: "read",
        ownerOnly: true,
        inputSchema: z.object({ query: z.string().default(""), limit: z.number().int().min(1).max(20).default(8) }),
        execute: async ({ query, limit }) => ({
          memories: rankMemories(store.memories.list(), query)
            .slice(0, limit)
            .map((m) => ({ text: m.text, source: m.source, updatedAt: m.updatedAt })),
        }),
      }),
    },
  });
}
