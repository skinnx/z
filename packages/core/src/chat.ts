/** Streaming chat for the web UI, using the AI SDK's native tool-approval flow. */
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateId,
  getToolName,
  isToolUIPart,
  stepCountIs,
  streamText,
  type UIMessage,
} from "ai";
import { reviewModel } from "./approvals.ts";
import { fitEachStep, fitToContext, modelSummarizer, type ContextSummary } from "./context.ts";
import type { ContextReport, ModelRef, Routing, Settings, Skill } from "./contract.ts";
import { memoryPrompt, type MemoryRecall } from "./memory.ts";
import { baseInstructions, joinSections, memoryHint } from "./prompt.ts";
import { describeError, laneConfigured, laneRefs, type ModelResolver } from "./providers.ts";
import { describeOffer, invokedSkill, narrowing, offerTools, pluginLabels, skillOnly, skillPrompt } from "./skills.ts";
import { buildTools, listTools, toolNotes, type ActivePlugin } from "./tools.ts";

export type ChatDeps = {
  models: ModelResolver;
  routing: Routing;
  settings: Settings;
  plugins: ActivePlugin[];
  /** The owner's long-term memories; the most relevant to the latest message go into the prompt. */
  memories?: MemoryRecall;
  /** The owner's skills; a message starting with `/<name>` runs with that skill's instructions and tools. */
  skills?: Skill[];
  log?: (text: string) => void;
};

export type ChatRequest = {
  messages: UIMessage[];
  /** Overrides the `chat` lane for this request. */
  model?: ModelRef;
  signal?: AbortSignal;
  /** The thread's cached summary of its oldest turns, from an earlier `onSummary`. */
  summary?: ContextSummary | null;
  /** Called when the oldest turns were summarised anew, to cache it with the thread. */
  onSummary?: (summary: ContextSummary) => void;
  /** Called with the full conversation once the response finishes. */
  onFinish?: (messages: UIMessage[]) => void | Promise<void>;
};

export async function streamChat(request: ChatRequest, deps: ChatDeps): Promise<Response> {
  const refs = request.model ? [request.model] : laneRefs(deps.routing, "chat");
  const model = deps.models.chain(refs);
  const window = deps.models.contextWindow(refs);
  const latest = lastUserText(request.messages);
  const invoked = invokedSkill(latest, deps.skills);
  const built = buildTools(deps.plugins, {
    policy: deps.settings.approvals,
    only: skillOnly(invoked?.skill, deps.plugins),
    reviewer: { mode: deps.settings.reviewer, model: reviewModel(deps.models, deps.routing) },
    log: deps.log,
  });
  const offer = offerTools(built, {
    request: recentUserText(request.messages),
    skill: invoked?.skill,
    used: usedTools(request.messages),
    labels: pluginLabels(deps.plugins),
    enabled: listTools(deps.plugins).length,
  });
  deps.log?.(describeOffer(offer));
  const narrow = narrowing(offer, { log: deps.log });
  const instructions = joinSections(
    baseInstructions(
      deps.settings,
      new Date(),
      "You are chatting with the user directly. Use tools when they help; tools that change things wait for the user's approval in the UI." +
        memoryHint(built.tools),
    ),
    memoryPrompt(deps.memories, invoked?.rest || latest),
    invoked && skillPrompt(invoked.skill),
    toolNotes(deps.plugins, built),
  );
  // Summaries come from the fast lane (or its `agent` fallback); without one, only old tool results shrink.
  const summarize = laneConfigured(deps.routing, "fast")
    ? modelSummarizer(deps.models.forLane(deps.routing, "fast"), request.signal)
    : undefined;

  const stream = createUIMessageStream({
    originalMessages: request.messages,
    generateId,
    onEnd: ({ messages }) => request.onFinish?.(messages),
    onError: describeError,
    execute: async ({ writer }) => {
      const report = (data: ContextReport) => writer.write({ type: "data-context", data });
      const fit = await fitToContext(
        await convertToModelMessages(request.messages, { tools: built.tools, ignoreIncompleteToolCalls: true }),
        { window, instructions, summary: request.summary, summarize, log: deps.log },
      );
      if (fit.summary) request.onSummary?.(fit.summary);
      if (fit.report) report(fit.report);
      const fitStep = fitEachStep({ window, summarize, log: deps.log, onReport: report });

      const result = streamText({
        model,
        instructions,
        messages: fit.messages,
        tools: built.tools,
        toolApproval: built.approval,
        stopWhen: stepCountIs(8),
        // Each step: compact the context if needed, and offer the narrowed tools (or, after a miss, all of them).
        prepareStep: async (step) => ({ ...(await fitStep(step)), activeTools: narrow.activeTools() }),
        repairToolCall: narrow.repairToolCall,
        abortSignal: request.signal,
      });
      // Providers with built-in search (OpenAI/xAI web search, Perplexity…) cite sources; the UI shows them.
      writer.merge(result.toUIMessageStream({ onError: describeError, sendSources: true }));
    },
  });

  return createUIMessageStreamResponse({ stream });
}

const textOf = (m: UIMessage) => m.parts.map((p) => (p.type === "text" ? p.text : "")).join(" ");

function lastUserText(messages: UIMessage[]): string {
  const last = messages.findLast((m) => m.role === "user");
  return last ? textOf(last) : "";
}

/** The last two user messages: a follow-up ("and in Linear?") keeps what it refers to. */
function recentUserText(messages: UIMessage[]): string {
  return messages
    .filter((m) => m.role === "user")
    .slice(-2)
    .map(textOf)
    .join("\n");
}

/** Tools this conversation already called stay offered. */
function usedTools(messages: UIMessage[]): string[] {
  return [...new Set(messages.flatMap((m) => m.parts.filter(isToolUIPart).map((p) => getToolName(p))))];
}
