/** Streaming chat for the web UI, using the AI SDK's native tool-approval flow. */
import { convertToModelMessages, generateId, stepCountIs, streamText, type UIMessage } from "ai";
import type { Memory, ModelRef, Routing, Settings } from "./contract.ts";
import { memoryPrompt } from "./memory.ts";
import { baseInstructions, joinSections, memoryHint } from "./prompt.ts";
import { describeError, type ModelResolver } from "./providers.ts";
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
  /** Called with the full conversation once the response finishes. */
  onFinish?: (messages: UIMessage[]) => void | Promise<void>;
};

export async function streamChat(request: ChatRequest, deps: ChatDeps): Promise<Response> {
  const model = request.model ? deps.models.chain([request.model]) : deps.models.forLane(deps.routing, "chat");
  const built = buildTools(deps.plugins, { policy: deps.settings.approvals, log: deps.log });

  const result = streamText({
    model,
    instructions: joinSections(
      baseInstructions(
        deps.settings,
        new Date(),
        "You are chatting with the user directly. Use tools when they help; tools that change things wait for the user's approval in the UI." +
          memoryHint(built.tools),
      ),
      memoryPrompt(deps.memories, lastUserText(request.messages)),
      toolNotes(deps.plugins, built),
    ),
    messages: await convertToModelMessages(request.messages, { tools: built.tools, ignoreIncompleteToolCalls: true }),
    tools: built.tools,
    toolApproval: built.approval,
    stopWhen: stepCountIs(8),
    abortSignal: request.signal,
  });

  return result.toUIMessageStreamResponse({
    originalMessages: request.messages,
    generateMessageId: generateId,
    // Providers with built-in search (Perplexity, OpenAI/xAI web search…) cite sources; the UI shows them.
    sendSources: true,
    onEnd: ({ messages }) => request.onFinish?.(messages),
    onError: describeError,
  });
}

function lastUserText(messages: UIMessage[]): string {
  const last = messages.findLast((m) => m.role === "user");
  return last?.parts.map((p) => (p.type === "text" ? p.text : "")).join(" ") ?? "";
}
