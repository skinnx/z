/**
 * Tools z itself offers task and watch runs (not plugin tools):
 * - report_failure({reason}): the run failed even if the loop completes.
 * - no_update(): the run is done and there is nothing worth telling the owner.
 * - ask_person({question, choices?}): no `execute`, so the AI SDK loop stops on the call and the task
 *   waits (`needs_input`) until the owner's answer is appended as the tool result.
 * Their effect is read back from the conversation, so it survives approval pauses and restarts.
 */
import { hasToolCall, tool, type ModelMessage, type ToolSet } from "ai";
import { z } from "zod";

export const REPORT_FAILURE = "report_failure";
export const NO_UPDATE = "no_update";
export const ASK_PERSON = "ask_person";

const MAX_CHOICES = 6;

export function runTools(opts: { ask: boolean }): ToolSet {
  return {
    [REPORT_FAILURE]: tool({
      description:
        "Report that this run failed: what was asked could not be done (a source is down, data is missing, an action was refused). " +
        "The run is marked failed with your reason even though you finish normally.",
      inputSchema: z.object({ reason: z.string().min(1).max(500).describe("One sentence the user can act on") }),
      execute: async () => ({ ok: true, note: "Recorded. Stop now." }),
    }),
    [NO_UPDATE]: tool({
      description: "Call when the run is complete and there is nothing new worth telling the user. No notification is sent.",
      inputSchema: z.object({}),
      execute: async () => ({ ok: true, note: "Recorded. Stop now." }),
    }),
    ...(opts.ask
      ? {
          [ASK_PERSON]: tool({
            description:
              "Ask the user a question when you cannot continue without their decision or information. The task pauses until they answer; " +
              "the answer comes back as this tool's result. Offer short `choices` when the answer is one of a few options.",
            inputSchema: z.object({
              question: z.string().min(1).max(1000),
              choices: z.array(z.string().min(1).max(80)).max(MAX_CHOICES).optional(),
            }),
          }),
        }
      : {}),
  };
}

/** Stop the loop right after report_failure / no_update instead of spending another model call. */
export const runToolsStop = hasToolCall(REPORT_FAILURE, NO_UPDATE);

/** Prompt lines explaining the run tools. */
export function runToolsHint(opts: { ask: boolean }): string {
  return (
    ` If you cannot do what was asked, call ${REPORT_FAILURE} with the reason. If the run found nothing worth reporting, call ${NO_UPDATE}.` +
    (opts.ask ? ` If you need the user's decision or information to continue, call ${ASK_PERSON} instead of guessing.` : "")
  );
}

type Call = { toolCallId: string; toolName: string; input: unknown };

function toolCalls(messages: ModelMessage[]): Call[] {
  const out: Call[] = [];
  for (const m of messages) {
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    for (const part of m.content) if (part.type === "tool-call") out.push(part);
  }
  return out;
}

function resultIds(messages: ModelMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.role !== "tool") continue;
    for (const part of m.content) if (part.type === "tool-result") ids.add(part.toolCallId);
  }
  return ids;
}

/** What the run tools said in this conversation. */
export function runSignals(messages: ModelMessage[]): { failure: string | null; noUpdate: boolean } {
  let failure: string | null = null;
  let noUpdate = false;
  for (const call of toolCalls(messages)) {
    if (call.toolName === REPORT_FAILURE) failure = String((call.input as { reason?: unknown })?.reason ?? "").trim() || "Reported as failed";
    if (call.toolName === NO_UPDATE) noUpdate = true;
  }
  return { failure, noUpdate };
}

export type PendingQuestion = { toolCallId: string; question: string; choices: string[] };

/** The `ask_person` call still waiting for an answer, if any. */
export function pendingQuestion(messages: ModelMessage[]): PendingQuestion | null {
  const answered = resultIds(messages);
  const call = toolCalls(messages).find((c) => c.toolName === ASK_PERSON && !answered.has(c.toolCallId));
  if (!call) return null;
  const input = (call.input ?? {}) as { question?: unknown; choices?: unknown };
  const choices = Array.isArray(input.choices) ? input.choices.map(String).filter(Boolean).slice(0, MAX_CHOICES) : [];
  return { toolCallId: call.toolCallId, question: String(input.question ?? "").trim() || "(no question text)", choices };
}

/**
 * Append the owner's answer as the `ask_person` tool result. It joins a trailing tool message (results of the
 * same step, or approval responses), so the AI SDK sees every result and approval of that step together.
 */
export function withAnswer(messages: ModelMessage[], toolCallId: string, answer: string): ModelMessage[] {
  const result = { type: "tool-result" as const, toolCallId, toolName: ASK_PERSON, output: { type: "text" as const, value: answer } };
  const last = messages.at(-1);
  if (last?.role === "tool") return [...messages.slice(0, -1), { ...last, content: [...last.content, result] }];
  return [...messages, { role: "tool", content: [result] }];
}
