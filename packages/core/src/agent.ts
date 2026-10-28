/** The proactive agent: run a Task as a tool loop that pauses for approvals. */
import { generateText, stepCountIs, type ModelMessage } from "ai";
import type { Memory, Risk, Routing, Settings, Task, TaskEvent } from "./contract.ts";
import { memoryPrompt } from "./memory.ts";
import { baseInstructions, joinSections, memoryHint } from "./prompt.ts";
import { describeError, laneConfigured, type ModelResolver } from "./providers.ts";
import { buildTools, summarizeCall, toolNotes, type ActivePlugin } from "./tools.ts";

export const MAX_AGENT_STEPS = 12;

export type AgentDeps = {
  models: ModelResolver;
  routing: Routing;
  settings: Settings;
  plugins: ActivePlugin[];
  /** The owner's long-term memories. Owner-facing runs only; never set for channel bots. */
  memories?: Memory[];
  log?: (text: string) => void;
};

/** What the server turns into an `Approval` record. */
export type ApprovalRequestInfo = {
  toolApprovalId: string;
  tool: string;
  risk: Risk;
  input: unknown;
  summary: string;
};

export type RunOutcome =
  | { status: "done"; result: string; messages: ModelMessage[] }
  | { status: "waiting"; messages: ModelMessage[]; approvals: ApprovalRequestInfo[] }
  | { status: "failed"; error: string; messages: ModelMessage[] };

export type RunTaskOptions = {
  /** Messages persisted at the last approval pause, with responses appended. Omit for a fresh run. */
  messages?: ModelMessage[] | null;
  signal?: AbortSignal;
  onEvent: (event: TaskEvent) => void;
};

const at = () => new Date().toISOString();

export async function runTask(task: Task, deps: AgentDeps, opts: RunTaskOptions): Promise<RunOutcome> {
  const messages: ModelMessage[] = opts.messages?.length
    ? opts.messages
    : [{ role: "user", content: task.instructions }];

  const built = buildTools(deps.plugins, {
    policy: deps.settings.approvals,
    only: task.tools,
    log: deps.log,
    onCall: (call) => opts.onEvent({ type: "tool", at: at(), ...call }),
  });

  try {
    const result = await generateText({
      model: deps.models.forLane(deps.routing, task.lane, {
        background: true,
        onCall: ({ ref, usage }) =>
          opts.onEvent({ type: "model", at: at(), model: ref, tokens: usage.inputTokens + usage.outputTokens }),
      }),
      instructions: joinSections(
        baseInstructions(
          deps.settings,
          new Date(),
          "You are working on a task the user delegated to you while they are away. " +
            "Use the available tools when they help. Some tools need the user's approval; " +
            "if a call is denied, adapt or explain what you could not do. " +
            "Finish with a concise report of what you did and found." +
            memoryHint(built.tools),
        ),
        memoryPrompt(deps.memories, task.instructions),
        toolNotes(deps.plugins, built),
      ),
      messages,
      tools: built.tools,
      toolApproval: built.approval,
      stopWhen: stepCountIs(MAX_AGENT_STEPS),
      abortSignal: opts.signal,
      maxRetries: 1,
      onStepEnd: (step) => {
        const text = step.text.trim();
        if (text) opts.onEvent({ type: "step", at: at(), text });
      },
    });

    const all = [...messages, ...result.responseMessages];
    const approvals = result.content
      .filter((part) => part.type === "tool-approval-request" && !part.isAutomatic)
      .map((part) => {
        const req = part as Extract<typeof part, { type: "tool-approval-request" }>;
        const name = req.toolCall.toolName;
        const info = built.info[name];
        return {
          toolApprovalId: req.approvalId,
          tool: name,
          risk: info?.risk ?? "external",
          input: req.toolCall.input,
          summary: summarizeCall(info, name, req.toolCall.input),
        } satisfies ApprovalRequestInfo;
      });

    if (approvals.length > 0) return { status: "waiting", messages: all, approvals };
    return { status: "done", result: result.text.trim() || "(finished without a written result)", messages: all };
  } catch (error) {
    if (opts.signal?.aborted) return { status: "failed", error: "Cancelled", messages };
    return { status: "failed", error: describeError(error), messages };
  }
}

export type ApprovalDecisionInfo = { toolApprovalId: string; approved: boolean; reason?: string };

/** Append the native tool-approval-response message that resumes the loop. */
export function withApprovalResponses(messages: ModelMessage[], decisions: ApprovalDecisionInfo[]): ModelMessage[] {
  return [
    ...messages,
    {
      role: "tool",
      content: decisions.map((d) => ({
        type: "tool-approval-response" as const,
        approvalId: d.toolApprovalId,
        approved: d.approved,
        ...(d.reason ? { reason: d.reason } : {}),
      })),
    },
  ];
}

/** Short task title from the `fast` lane, then `agent`, then the instructions themselves. */
export async function deriveTitle(instructions: string, deps: Pick<AgentDeps, "models" | "routing">): Promise<string> {
  const fallback = truncate(instructions.replace(/\s+/g, " ").trim(), 60);
  if (!laneConfigured(deps.routing, "fast") && !laneConfigured(deps.routing, "agent")) return fallback;
  try {
    const refs = [...(deps.routing.fast ?? []), ...(deps.routing.agent ?? [])];
    const { text } = await generateText({
      model: deps.models.chain(refs, { background: true }),
      instructions: "Write a short title (at most 6 words) for the task below. Reply with the title only, no quotes.",
      prompt: instructions.slice(0, 2000),
      maxOutputTokens: 24,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(20_000),
    });
    const title = text.split("\n")[0]!.replace(/^["'#*\s]+|["'*\s.]+$/g, "");
    return title ? truncate(title, 80) : fallback;
  } catch {
    return fallback;
  }
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
