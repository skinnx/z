/**
 * Keep what goes to the model inside its context window. The caller keeps the full history;
 * only the prompt shrinks: old tool results first, then the oldest turns become one summary.
 */
import { generateText, type LanguageModel, type ModelMessage } from "ai";
import type { ContextReport } from "./contract.ts";

/** Used when no pattern matches a model id: small enough for most local and hosted models. */
export const DEFAULT_CONTEXT_WINDOW = 32_000;

/** First match wins, tested against the id without any `vendor/` prefix (OpenRouter style). */
const WINDOWS: [RegExp, number][] = [
  [/^claude/, 200_000],
  [/^gpt-oss/, 128_000],
  [/^gpt-4\.1/, 1_000_000],
  [/^gpt-5/, 400_000],
  [/^gpt-/, 128_000],
  [/^gemini/, 1_000_000],
  [/^grok-4/, 256_000],
  [/^grok/, 131_072],
  [/^codestral/, 256_000],
  [/^(mistral|ministral|magistral|devstral)/, 128_000],
  [/^llama/, 128_000],
  [/^qwen/, 32_768],
  [/^deepseek/, 64_000],
];

/** Context window in tokens for a model id; a provider's `contextWindows` entry wins. */
export function contextWindowFor(modelId: string, overrides?: Record<string, number>): number {
  const override = overrides?.[modelId];
  if (override) return override;
  const id = modelId.toLowerCase().split("/").pop()!;
  return WINDOWS.find(([pattern]) => pattern.test(id))?.[1] ?? DEFAULT_CONTEXT_WINDOW;
}

const CHARS_PER_TOKEN = 3.5;
/** Rough cost of one image or file, which providers bill far below their byte size. */
const FILE_CHARS = 1500 * CHARS_PER_TOKEN;

export const estimateTokens = (text: string) => Math.ceil(text.length / CHARS_PER_TOKEN);

function messageChars(m: ModelMessage): number {
  if (typeof m.content === "string") return m.content.length;
  let n = 0;
  for (const part of m.content) {
    switch (part.type) {
      case "text":
      case "reasoning":
        n += part.text.length;
        break;
      case "tool-call":
        n += part.toolName.length + JSON.stringify(part.input ?? null).length;
        break;
      case "tool-result":
        n += part.toolName.length + outputText(part.output).length;
        break;
      default:
        n += part.type === "file" || (part.type as string) === "image" ? FILE_CHARS : 40;
    }
  }
  return n;
}

export const messagesTokens = (messages: ModelMessage[]) =>
  Math.ceil(messages.reduce((n, m) => n + messageChars(m), 0) / CHARS_PER_TOKEN);

type ToolOutput = Extract<Exclude<ModelMessage["content"], string>[number], { type: "tool-result" }>["output"];

function outputText(output: ToolOutput): string {
  switch (output.type) {
    case "text":
    case "error-text":
      return output.value;
    case "json":
    case "error-json":
      return JSON.stringify(output.value ?? null);
    case "execution-denied":
      return output.reason ?? "";
    case "content":
      return output.value.map((v) => (v.type === "text" ? v.text : "")).join("\n");
    default:
      return "";
  }
}

const TOOL_RESULT_KEEP = 3;
const TOOL_RESULT_MAX = 1500;

function excerpt(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = Math.floor(max * 0.3);
  return `${text.slice(0, head)}\n…[trimmed ${text.length - head - tail} chars]…\n${text.slice(-tail)}`;
}

/** Replace tool results older than the latest few with a head/tail excerpt when they are long. */
export function shrinkToolResults(messages: ModelMessage[]): { messages: ModelMessage[]; trimmed: number } {
  let seen = 0;
  let trimmed = 0;
  const out = [...messages];
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]!;
    if (m.role !== "tool") continue;
    let changed = false;
    const content = m.content.map((part) => {
      if (part.type !== "tool-result") return part;
      if (++seen <= TOOL_RESULT_KEEP) return part;
      const text = outputText(part.output);
      if (text.length <= TOOL_RESULT_MAX) return part;
      changed = true;
      trimmed++;
      return { ...part, output: { type: "text" as const, value: excerpt(text, TOOL_RESULT_MAX) } };
    });
    if (changed) out[i] = { ...m, content };
  }
  return { messages: out, trimmed };
}

/** A summary of `messages[0, upTo)` (system messages and the latest user message excepted). */
export type ContextSummary = { text: string; upTo: number };

export type Summarize = (input: { previous: string | null; messages: ModelMessage[] }) => Promise<string>;

export type FitOptions = {
  /** The model's context window in tokens (`contextWindowFor`, or the resolver's `contextWindow`). */
  window: number;
  /** Tokens kept free for the answer. */
  reserve?: number;
  /** Instructions sent alongside, counted when no measured size is given. */
  instructions?: string;
  /** Provider-reported `inputTokens` of the last call, which sent the first `count` of these messages. */
  measured?: { tokens: number; count: number };
  /** A cached summary from an earlier fit over the same history. */
  summary?: ContextSummary | null;
  /** Turns old messages into a short summary; without it, only tool results shrink. */
  summarize?: Summarize;
  log?: (text: string) => void;
};

export type FitResult = {
  messages: ModelMessage[];
  /** Set when something was trimmed or summarised: what the UI shows. */
  report: ContextReport | null;
  /** Set when a new summary was made; the caller stores it for the next fit. */
  summary: ContextSummary | null;
};

/** Compact once the prompt passes this share of the window. */
const COMPACT_AT = 0.8;
/** After summarising, the verbatim tail stays within this share of the window. */
const KEEP_RECENT = 0.4;
const DEFAULT_RESERVE = 4096;

export const SUMMARY_PREFIX = "Earlier in this conversation (summary):";

/**
 * Fit messages into the window: (1) shrink old tool results; (2) if still over ~80%, summarise the
 * oldest turns into one message, reusing `summary` when it still fits. System messages, the latest
 * user message and any tool call or approval whose pair is not complete are never summarised away.
 */
export async function fitToContext(messages: ModelMessage[], opts: FitOptions): Promise<FitResult> {
  const limit = Math.min(opts.window * COMPACT_AT, opts.window - (opts.reserve ?? DEFAULT_RESERVE));
  const overhead = opts.measured
    ? opts.measured.tokens - messagesTokens(messages.slice(0, opts.measured.count))
    : estimateTokens(opts.instructions ?? "");
  const tokens = (ms: ModelMessage[]) => Math.max(0, overhead) + messagesTokens(ms);

  const tokensBefore = tokens(messages);
  if (tokensBefore <= limit) return { messages, report: null, summary: null };

  const shrunk = shrinkToolResults(messages);
  const done = (out: ModelMessage[], summarized: boolean, summary: ContextSummary | null): FitResult => ({
    messages: out,
    report: { summarized, trimmed: shrunk.trimmed, tokensBefore, tokensAfter: tokens(out) },
    summary,
  });
  if (tokens(shrunk.messages) <= limit || !opts.summarize) return done(shrunk.messages, false, null);

  const { cuts, protectFrom, lastUser } = boundaries(shrunk.messages);
  const build = (text: string, upTo: number) => [
    ...shrunk.messages.slice(0, upTo).filter((m, i) => m.role === "system" || i === lastUser),
    { role: "user" as const, content: `${SUMMARY_PREFIX}\n${text}` },
    ...shrunk.messages.slice(upTo),
  ];

  // A cached summary that still sits on a valid cut and fits needs no model call.
  const cached = opts.summary;
  const cacheUsable = cached && cuts.has(cached.upTo) && cached.upTo <= protectFrom;
  if (cacheUsable) {
    const out = build(cached.text, cached.upTo);
    if (tokens(out) <= limit) return done(out, true, null);
  }

  // Keep the longest recent tail within KEEP_RECENT of the window; cut no earlier than the cache.
  const keep = opts.window * KEEP_RECENT;
  const from = cacheUsable ? cached.upTo : 0;
  let upTo = -1;
  for (const k of [...cuts].sort((a, b) => a - b)) {
    if (k <= from || k > protectFrom) continue;
    upTo = k;
    if (tokens(shrunk.messages.slice(k)) <= keep) break;
  }
  if (upTo < 0) return done(cacheUsable ? build(cached.text, cached.upTo) : shrunk.messages, Boolean(cacheUsable), null);

  const head = shrunk.messages.slice(from, upTo).filter((m, i) => m.role !== "system" && from + i !== lastUser);
  try {
    const text = (await opts.summarize({ previous: cacheUsable ? cached.text : null, messages: head })).trim();
    if (!text) throw new Error("empty summary");
    const summary = { text: text.slice(0, SUMMARY_MAX), upTo };
    return done(build(summary.text, upTo), true, summary);
  } catch (error) {
    opts.log?.(`context summary failed: ${error instanceof Error ? error.message : String(error)}`);
    return done(cacheUsable ? build(cached.text, cached.upTo) : shrunk.messages, Boolean(cacheUsable), null);
  }
}

/**
 * Where history may be cut: never between a tool call, its approval and its result, never past
 * an unanswered call or the last message. Index k means messages[0, k) go into the summary.
 */
function boundaries(messages: ModelMessage[]) {
  const span = new Map<string, [number, number]>();
  const approvalCall = new Map<string, string>();
  const answered = new Set<string>();
  const mark = (id: string, i: number) => {
    const s = span.get(id);
    span.set(id, s ? [s[0], i] : [i, i]);
  };
  messages.forEach((m, i) => {
    if (typeof m.content === "string") return;
    for (const part of m.content) {
      if (part.type === "tool-call") mark(part.toolCallId, i);
      else if (part.type === "tool-result") (mark(part.toolCallId, i), answered.add(part.toolCallId));
      else if (part.type === "tool-approval-request") (approvalCall.set(part.approvalId, part.toolCallId), mark(part.toolCallId, i));
      else if (part.type === "tool-approval-response") {
        const call = approvalCall.get(part.approvalId);
        if (call) mark(call, i);
      }
    }
  });

  // The latest user message is kept even when it falls before the cut (a task's instructions).
  const lastUser = messages.findLastIndex((m) => m.role === "user");
  // At least the last message stays verbatim, and an unanswered call with everything after it.
  let protectFrom = messages.length - 1;
  for (const [id, [first]] of span) if (!answered.has(id)) protectFrom = Math.min(protectFrom, first);

  const spans = [...span.values()];
  const cuts = new Set<number>();
  for (let k = 1; k < messages.length; k++) {
    if (messages[k]!.role === "tool" || messages[k]!.role === "system") continue;
    if (spans.some(([a, b]) => a < k && k <= b)) continue;
    cuts.add(k);
  }
  return { cuts, protectFrom, lastUser };
}

const SUMMARY_MAX = 1500;
const TRANSCRIPT_MESSAGE_MAX = 2000;
const TRANSCRIPT_MAX = 60_000;

function transcript(messages: ModelMessage[]): string {
  const lines = messages.map((m) => {
    if (typeof m.content === "string") return `${m.role}: ${excerpt(m.content, TRANSCRIPT_MESSAGE_MAX)}`;
    const text = m.content
      .map((part) => {
        if (part.type === "text") return part.text;
        if (part.type === "tool-call") return `[called ${part.toolName} ${JSON.stringify(part.input ?? null).slice(0, 300)}]`;
        if (part.type === "tool-result") return `[${part.toolName} returned] ${outputText(part.output)}`;
        if (part.type === "tool-approval-response") return `[approval ${part.approved ? "granted" : "denied"}]`;
        return "";
      })
      .filter(Boolean)
      .join("\n");
    return `${m.role}: ${excerpt(text, TRANSCRIPT_MESSAGE_MAX)}`;
  });
  return excerpt(lines.join("\n\n"), TRANSCRIPT_MAX);
}

/** A `Summarize` backed by a model, normally the `fast` lane. */
export function modelSummarizer(model: LanguageModel, signal?: AbortSignal): Summarize {
  return async ({ previous, messages }) => {
    const { text } = await generateText({
      model,
      instructions:
        "You compress a conversation between a user and an AI assistant so the assistant can continue it without the original. " +
        "Write plain prose or short bullet lines, at most 1,200 characters. Keep, in order: what the user asked for and told the assistant " +
        "(names, numbers, dates, preferences, decisions, verbatim codes or identifiers), what the assistant did and found (tools used, key results, URLs), " +
        "and anything still open. Drop pleasantries and raw page text. Reply with the summary only.",
      prompt: [previous ? `Summary so far:\n${previous}\n\nThen:` : "Conversation:", transcript(messages)].join("\n"),
      // Room for reasoning models to think first; the summary itself is capped to SUMMARY_MAX.
      maxOutputTokens: 1500,
      maxRetries: 1,
      abortSignal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
    });
    return text;
  };
}

/**
 * `prepareStep` for multi-step tool loops: refits once tool results pile up within a run, sizing
 * each step from the provider-reported `inputTokens` of the step before. Summaries made here
 * cover in-loop messages only, so they are not returned for caching.
 */
export function fitEachStep(opts: Omit<FitOptions, "measured" | "summary"> & { onReport?: (report: ContextReport) => void }) {
  let sent = 0;
  return async ({ steps, messages }: { steps: { usage: { inputTokens: number | undefined } }[]; messages: ModelMessage[] }) => {
    const measuredTokens = steps.at(-1)?.usage.inputTokens;
    if (steps.length === 0 || !measuredTokens) {
      sent = messages.length;
      return undefined;
    }
    const fit = await fitToContext(messages, { ...opts, measured: { tokens: measuredTokens, count: sent } });
    sent = fit.messages.length;
    if (!fit.report) return undefined;
    opts.onReport?.(fit.report);
    return { messages: fit.messages };
  };
}
