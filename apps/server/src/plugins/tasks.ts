/** Built-in task tools: start a watch from a conversation (the `/watch` skill). Server-provided: it needs z's task engine. */
import { definePlugin, defineTool, TaskInput, type ZPlugin } from "@z/core";
import { z } from "zod";
import { clip } from "../notify.ts";
import type { Tasks } from "../tasks.ts";

const EVERY = { hourly: "0 * * * *", "4h": "0 */4 * * *", daily: "0 8 * * *" } as const;

/** `engine` is read at call time: the plugin is registered before the task engine exists. */
export function tasksPlugin(engine: () => Tasks): ZPlugin {
  return definePlugin({
    id: "tasks",
    name: "Tasks",
    description: "Lets z start a watch for you from a conversation. Never available to channel bots.",
    tools: {
      watch: defineTool({
        description:
          "Start a watch: a standing check z runs on a schedule that notifies the user only when something new matches. " +
          "Use when the user wants to be told when something happens. The first check runs right away.",
        risk: "write",
        // Only adds a task to z, which the owner sees and can delete; runs without asking unless they say otherwise.
        defaultPolicy: "allow",
        ownerOnly: true,
        inputSchema: z.object({
          instructions: z
            .string()
            .min(1)
            .max(2000)
            .describe("What to look for and where, as one instruction, e.g. \"New releases of nodejs/node on GitHub\""),
          every: z.enum(["hourly", "4h", "daily"]).default("hourly").describe("How often to check"),
        }),
        summarize: ({ instructions, every }) => `Watch (${every}): ${clip(instructions, 100)}`,
        execute: async ({ instructions, every }) => {
          // A leading "/" would make the watch invoke a skill on every check.
          const text = instructions.replace(/^\s*\/+/, "").trim();
          const task = engine().create(TaskInput.parse({ instructions: text, mode: "watch", schedule: EVERY[every] }));
          return { ok: true, id: task.id, title: task.title, schedule: task.schedule, nextRunAt: task.nextRunAt, path: `/tasks?task=${task.id}` };
        },
      }),
    },
  });
}
