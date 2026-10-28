/** The proactive agent: run a Task as a tool loop that pauses for approvals. */
import { generateText, stepCountIs, type ModelMessage } from "ai";
import { approvalPreview, reviewModel } from "./approvals.ts";
import type { ApprovalPreview, Risk, Routing, Settings, Skill, Task, TaskEvent } from "./contract.ts";
import { memoryPrompt, type MemoryRecall } from "./memory.ts";
import { baseInstructions, joinSections, memoryHint } from "./prompt.ts";
import { fitToContext, modelSummarizer } from "./context.ts";
import { describeError, laneConfigured, laneRefs, type ModelResolver } from "./providers.ts";
import { pendingQuestion, runSignals, runTools, runToolsHint, runToolsStop, type PendingQuestion } from "./run-tools.ts";
import { describeOffer, invokedSkill, narrowing, offerTools, pluginLabels, skillOnly, skillPrompt } from "./skills.ts";
import { buildTools, listTools, summarizeCall, toolNotes, type ActivePlugin, type ToolCallEnd, type ToolCallStart } from "./tools.ts";

export const MAX_AGENT_STEPS = 12;

export type AgentDeps = {
  models: ModelResolver;
  routing: Routing;
  settings: Settings;
  plugins: ActivePlugin[];
  /** The owner's long-term memories. Owner-facing runs only; never set for channel bots. */
  memories?: MemoryRecall;
  /** The owner's skills; a task whose instructions start with `/<name>` runs with that skill. */
  skills?: Skill[];
  log?: (text: string) => void;
};

/** What the server turns into an `Approval` record. */
export type ApprovalRequestInfo = {
  toolApprovalId: string;
  tool: string;
  risk: Risk;
  input: unknown;
  summary: string;
  preview: ApprovalPreview;
  /** Completes "Asking because …" when the safety floor or the reviewer asked. */
  reason: string | null;
};

export type RunOutcome =
  /** `quiet`: the agent called no_update, so no completion notice. */
  | { status: "done"; result: string; quiet: boolean; messages: ModelMessage[] }
  | { status: "waiting"; messages: ModelMessage[]; approvals: ApprovalRequestInfo[] }
  /** Paused on `ask_person`. */
  | { status: "needs_input"; messages: ModelMessage[]; question: PendingQuestion }
  | { status: "failed"; error: string; messages: ModelMessage[] };

export type RunTaskOptions = {
  /** Messages persisted by an earlier step or pause (with responses appended). Omit for a fresh run. */
  messages?: ModelMessage[] | null;
  signal?: AbortSignal;
  onEvent: (event: TaskEvent) => void;
  /** The whole conversation so far, after every step: persist it to resume after a crash. */
  onMessages?: (messages: ModelMessage[]) => void;
  /** Write/external calls only, synchronously before and after they execute: the crash journal. */
  onToolStart?: (call: ToolCallStart) => void;
  onToolEnd?: (call: ToolCallEnd) => void;
};

const at = () => new Date().toISOString();

export async function runTask(task: Task, deps: AgentDeps, opts: RunTaskOptions): Promise<RunOutcome> {
  const messages: ModelMessage[] = opts.messages?.length
    ? opts.messages
    : [{ role: "user", content: task.instructions }];

  const invoked = invokedSkill(task.instructions, deps.skills);
  const built = buildTools(deps.plugins, {
    policy: deps.settings.approvals,
    only: skillOnly(invoked?.skill, deps.plugins, task.tools),
    reviewer: {
      mode: deps.settings.reviewer,
      model: reviewModel(deps.models, deps.routing),
      onReview: (tool, verdict) =>
        opts.onEvent({ type: "step", at: at(), text: verdict.decision === "proceed" ? `Reviewer let ${tool} run: ${verdict.reason}` : `Asking before ${tool} because ${verdict.reason}` }),
    },
    log: deps.log,
    onCall: (call) => opts.onEvent({ type: "tool", at: at(), ...call }),
    onStart: (call) => call.risk !== "read" && opts.onToolStart?.(call),
    onEnd: (call) => call.risk !== "read" && opts.onToolEnd?.(call),
  });
  const zTools = runTools({ ask: true });
  const tools = { ...built.tools, ...zTools };
  const offer = offerTools(built, { request: invoked?.rest || task.instructions, skill: invoked?.skill, labels: pluginLabels(deps.plugins), enabled: listTools(deps.plugins).length });
  deps.log?.(describeOffer(offer));
  const narrow = narrowing(offer, { always: Object.keys(zTools), log: deps.log });
  const request = invoked?.rest || task.instructions;
  const instructions = joinSections(
    baseInstructions(
      deps.settings,
      new Date(),
      "You are working on a task the user delegated to you while they are away. " +
        "Use the available tools when they help. Some tools need the user's approval; " +
        "if a call is denied, adapt or explain what you could not do. " +
        "Finish with a concise report of what you did and found." +
        runToolsHint({ ask: true }) +
        memoryHint(built.tools),
    ),
    memoryPrompt(deps.memories, request),
    invoked && skillPrompt(invoked.skill),
    toolNotes(deps.plugins, built),
  );
  let stepInput: ModelMessage[] = messages;

  try {
    // A task resumed after approvals or answers carries its whole history; only what the model sees shrinks.
    // `messages` (the full history) is what gets persisted.
    const fit = await fitToContext(messages, {
      window: deps.models.contextWindow(laneRefs(deps.routing, task.lane)),
      instructions,
      summarize: laneConfigured(deps.routing, "fast") ? modelSummarizer(deps.models.forLane(deps.routing, "fast"), opts.signal) : undefined,
      log: deps.log,
    });
    const sent = fit.messages;
    const result = await generateText({
      model: deps.models.forLane(deps.routing, task.lane, {
        background: true,
        onCall: ({ ref, usage }) =>
          opts.onEvent({ type: "model", at: at(), model: ref, tokens: usage.inputTokens + usage.outputTokens }),
      }),
      instructions,
      messages: sent,
      tools,
      toolApproval: built.approval,
      prepareStep: () => ({ activeTools: narrow.activeTools() }),
      repairToolCall: narrow.repairToolCall,
      stopWhen: [stepCountIs(MAX_AGENT_STEPS), runToolsStop],
      abortSignal: opts.signal,
      maxRetries: 1,
      onStepStart: (step) => {
        // Earlier steps of this run follow the (possibly compacted) prefix the model was sent.
        stepInput = [...messages, ...step.messages.slice(sent.length)];
      },
      onStepEnd: (step) => {
        opts.onMessages?.([...stepInput, ...step.response.messages]);
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
        const summary = summarizeCall(info, name, req.toolCall.input);
        return {
          toolApprovalId: req.approvalId,
          tool: name,
          risk: info?.risk ?? "external",
          input: req.toolCall.input,
          summary,
          preview: approvalPreview(name, req.toolCall.input, { summary }),
          reason: req.reason?.trim() || null,
        } satisfies ApprovalRequestInfo;
      });

    if (approvals.length > 0) return { status: "waiting", messages: all, approvals };
    const question = pendingQuestion(all);
    if (question) return { status: "needs_input", messages: all, question };
    const signals = runSignals(all);
    if (signals.failure) return { status: "failed", error: signals.failure, messages: all };
    return { status: "done", result: result.text.trim() || "(finished without a written result)", quiet: signals.noUpdate, messages: all };
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
