/**
 * Crash recovery for a task found `running` at startup. Side effects are never replayed:
 * - a write/external call that started without a recorded result → `interrupt` (the owner decides);
 * - otherwise → `resume` from the persisted conversation. Calls whose result is journaled but whose
 *   step never reached the persisted messages are written back in, so the model sees them done
 *   instead of calling them again. Read-only progress after the last step is simply redone.
 */
import type { ModelMessage } from "ai";
import type { TaskCall } from "./store.ts";

export type Recovery = { action: "resume"; messages: ModelMessage[] } | { action: "interrupt"; calls: TaskCall[] };

export function planRecovery(messages: ModelMessage[], calls: TaskCall[]): Recovery {
  const unfinished = calls.filter((c) => !c.finishedAt);
  if (unfinished.length) return { action: "interrupt", calls: unfinished };

  const called = new Set<string>();
  const answered = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant" && typeof m.content !== "string") {
      for (const part of m.content) if (part.type === "tool-call") called.add(part.toolCallId);
    }
    if (m.role === "tool") for (const part of m.content) if (part.type === "tool-result") answered.add(part.toolCallId);
  }
  const missing = calls.filter((c) => !answered.has(c.toolCallId));
  if (!missing.length) return { action: "resume", messages };

  let out = [...messages];
  // Calls already in the conversation (approved before the crash): their results join the trailing
  // tool message next to the approval responses, which is where the AI SDK looks for them.
  const known = missing.filter((c) => called.has(c.toolCallId));
  if (known.length) {
    const last = out.at(-1);
    out =
      last?.role === "tool"
        ? [...out.slice(0, -1), { ...last, content: [...last.content, ...known.map(resultPart)] }]
        : [...out, { role: "tool", content: known.map(resultPart) }];
  }
  const fresh = missing.filter((c) => !called.has(c.toolCallId));
  if (fresh.length) {
    out = [
      ...out,
      { role: "assistant", content: fresh.map((c) => ({ type: "tool-call" as const, toolCallId: c.toolCallId, toolName: c.tool, input: c.input })) },
      { role: "tool", content: fresh.map(resultPart) },
    ];
  }
  return { action: "resume", messages: out };
}

function resultPart(c: TaskCall) {
  return {
    type: "tool-result" as const,
    toolCallId: c.toolCallId,
    toolName: c.tool,
    output: c.error ? { type: "error-text" as const, value: c.error } : { type: "json" as const, value: (c.output ?? null) as any },
  };
}
