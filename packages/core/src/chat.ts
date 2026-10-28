/** Streaming chat for the web UI, using the AI SDK's native tool-approval flow. */
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateId,
  stepCountIs,
  streamText,
  type UIMessage,
} from "ai";
import { fitEachStep, fitToContext, modelSummarizer, type ContextSummary } from "./context.ts";
import type { ContextReport, Memory, ModelRef, Routing, Settings } from "./contract.ts";
import { memoryPrompt } from "./memory.ts";
import { baseInstructions, joinSections, memoryHint } from "./prompt.ts";
import { describeError, laneConfigured, laneRefs, type ModelResolver } from "./providers.ts";
import { buildTools, toolNotes, type ActivePlugin } from "./tools.ts";

export type ChatDeps = {
  models: ModelResolver;
  routing: Routing;
  settings: Settings;
  plugins: ActivePlugin[];
  /** The owner's long-term memories; the most relevant to the latest message go into the prompt. */
  memories?: Memory[];
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
  const built = buildTools(deps.plugins, { policy: deps.settings.approvals, log: deps.log });
  const instructions = joinSections(
    baseInstructions(
      deps.settings,
      new Date(),
      "You are chatting with the user directly. Use tools when they help; tools that change things wait for the user's approval in the UI." +
        memoryHint(built.tools),
    ),
    memoryPrompt(deps.memories, lastUserText(request.messages)),
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

      const result = streamText({
        model,
        instructions,
        messages: fit.messages,
        tools: built.tools,
        toolApproval: built.approval,
        stopWhen: stepCountIs(8),
        prepareStep: fitEachStep({ window, summarize, log: deps.log, onReport: report }),
        abortSignal: request.signal,
      });
      // Providers with built-in search (OpenAI/xAI web search, Perplexity…) cite sources; the UI shows them.
      writer.merge(result.toUIMessageStream({ onError: describeError, sendSources: true }));
    },
  });

  return createUIMessageStreamResponse({ stream });
}

function lastUserText(messages: UIMessage[]): string {
  const last = messages.findLast((m) => m.role === "user");
  return last?.parts.map((p) => (p.type === "text" ? p.text : "")).join(" ") ?? "";
}
