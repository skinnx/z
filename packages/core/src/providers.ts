/**
 * BYOK model access: build language models from user-configured providers,
 * chain them into per-lane fallbacks, list models live and account usage.
 */
import { anthropic, createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI, google } from "@ai-sdk/google";
import { createOpenAI, openai } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  APICallError,
  LoadAPIKeyError,
  NoSuchModelError,
  type LanguageModelV4,
  type LanguageModelV4Content,
  type LanguageModelV4StreamPart,
  type LanguageModelV4Usage,
} from "@ai-sdk/provider";
import { createXai, xai } from "@ai-sdk/xai";
import { generateText, type ToolSet } from "ai";
import type { z } from "zod";
import type { Lane, ModelRef, ProviderInput, ProviderKind, Routing } from "./contract.ts";

/** A stored provider with its key decrypted, as core needs it. */
export type ProviderConfig = Omit<z.output<typeof ProviderInput>, "apiKey"> & { apiKey: string | null };

export type UsageReport = {
  providerId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  /** Rough estimate; see `estimateCostUsd`. */
  costUsd: number;
};

const DEFAULT_BASE_URL: Partial<Record<ProviderKind, string>> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
  xai: "https://api.x.ai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  ollama: "http://localhost:11434/v1",
};

export function baseURLFor(p: Pick<ProviderConfig, "kind" | "baseURL">): string {
  if (p.kind === "openai-compatible") {
    if (!p.baseURL) throw new Error("openai-compatible providers need a baseURL");
    return trimSlash(p.baseURL);
  }
  const url = trimSlash(p.baseURL ?? DEFAULT_BASE_URL[p.kind]!);
  // Ollama's OpenAI-compatible API lives under /v1; accept the bare server URL too.
  return p.kind === "ollama" && !url.endsWith("/v1") ? `${url}/v1` : url;
}

const trimSlash = (url: string) => url.replace(/\/+$/, "");

export type ModelOptions = {
  /**
   * Turn on search that runs inside the provider's API where it is a request option rather than
   * a tool (OpenRouter's web plugin). Tool-based native search comes from `nativeSearchTools`.
   */
  webSearch?: boolean;
};

export function createLanguageModel(p: ProviderConfig, modelId: string, opts: ModelOptions = {}): LanguageModelV4 {
  const baseURL = baseURLFor(p);
  const apiKey = p.apiKey ?? undefined;
  const headers = p.headers;
  switch (p.kind) {
    case "openai":
      return createOpenAI({ baseURL, apiKey, headers })(modelId);
    case "anthropic":
      return createAnthropic({ baseURL, apiKey, headers })(modelId);
    case "google":
      return createGoogleGenerativeAI({ baseURL, apiKey, headers })(modelId);
    case "xai":
      return createXai({ baseURL, apiKey, headers })(modelId);
    case "openrouter":
      if (opts.webSearch) return openRouterWithWebSearch(p.id, baseURL, apiKey, headers, modelId);
      return createOpenAICompatible({ name: p.id, baseURL, apiKey, headers, includeUsage: true }).chatModel(modelId);
    case "ollama":
    case "openai-compatible":
      return createOpenAICompatible({ name: p.id, baseURL, apiKey, headers, includeUsage: true }).chatModel(modelId);
  }
}

/**
 * OpenRouter's `web` plugin searches before the model answers and returns `url_citation`
 * annotations, which openai-compatible does not map; they are surfaced here as source parts.
 * Only the first request of a tool loop searches (later ones already carry tool results).
 * Unverified without an OpenRouter key: shapes follow OpenRouter's web search docs.
 */
function openRouterWithWebSearch(
  name: string,
  baseURL: string,
  apiKey: string | undefined,
  headers: Record<string, string> | undefined,
  modelId: string,
): LanguageModelV4 {
  const model = createOpenAICompatible({
    name,
    baseURL,
    apiKey,
    headers,
    includeUsage: true,
    transformRequestBody: (args) =>
      (args.messages as { role: string }[] | undefined)?.some((m) => m.role === "tool")
        ? args
        : { ...args, plugins: [{ id: "web", max_results: 5 }] },
  }).chatModel(modelId);
  return {
    specificationVersion: "v4",
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,
    doGenerate: async (options) => {
      const result = await model.doGenerate(options);
      type Body = { choices?: { message?: { annotations?: { type: string; url_citation?: { url: string; title?: string } }[] } }[] };
      const annotations = (result.response?.body as Body | undefined)?.choices?.[0]?.message?.annotations ?? [];
      const citations = annotations.flatMap((a, i): LanguageModelV4Content[] =>
        a.type === "url_citation" && a.url_citation?.url
          ? [{ type: "source", sourceType: "url", id: `openrouter-${i}`, url: a.url_citation.url, ...(a.url_citation.title ? { title: a.url_citation.title } : {}) }]
          : [],
      );
      return citations.length ? { ...result, content: [...result.content, ...citations] } : result;
    },
    doStream: (options) => model.doStream(options),
  };
}

/**
 * Provider-executed web search for a provider kind, as AI SDK tools. Keys differ per provider so a
 * chain mixing providers can carry all of them; each provider drops the others' tools with a warning.
 * Read-only by nature: searching and page reads happen on the provider's side.
 * Unverified without keys: built from the provider packages' typings.
 */
export function nativeSearchTools(kind: ProviderKind): ToolSet {
  switch (kind) {
    case "anthropic":
      return { anthropic_web_search: anthropic.tools.webSearch_20250305({ maxUses: 3 }) };
    case "openai":
      // Needs the Responses API, which is what `createOpenAI()(id)` returns.
      return { openai_web_search: openai.tools.webSearch({ searchContextSize: "low" }) };
    case "google":
      // Gemini before 3 can't combine it with function tools; the provider then keeps only search.
      return { google_search: google.tools.googleSearch({}) };
    case "xai":
      // Grok's own grounding: the web and X posts.
      return { xai_web_search: xai.tools.webSearch(), xai_x_search: xai.tools.xSearch() };
    default:
      return {};
  }
}

export function parseModelRef(ref: ModelRef): { providerId: string; modelId: string } {
  const i = ref.indexOf(":");
  if (i < 1) throw new Error(`Invalid model ref "${ref}"`);
  return { providerId: ref.slice(0, i), modelId: ref.slice(i + 1) };
}

/**
 * Very rough cost estimate used only for soft budgets: $1 per million input
 * tokens and $4 per million output tokens; local models are free.
 */
export function estimateCostUsd(kind: ProviderKind, inputTokens: number, outputTokens: number): number {
  if (kind === "ollama") return 0;
  return (inputTokens * 1 + outputTokens * 4) / 1_000_000;
}

/** Errors that mean "this model can't serve right now", so the next in the chain should try. */
export function isFallbackError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return false;
  if (APICallError.isInstance(error)) {
    const s = error.statusCode;
    if (s === undefined || [401, 402, 403, 404, 408, 409, 429].includes(s) || s >= 500) return true;
    // Google and xAI report bad keys and unknown models as 400.
    return s === 400 && /api[ _-]?key|auth|credential|permission|not found|does not exist|unknown model/i.test(error.message);
  }
  if (LoadAPIKeyError.isInstance(error) || NoSuchModelError.isInstance(error)) return true;
  if (error instanceof ModelUnavailableError) return true;
  // Network failures from fetch surface as TypeError ("fetch failed").
  return error instanceof TypeError;
}

export class ModelUnavailableError extends Error {
  override name = "ModelUnavailableError";
}

export type ModelCall = { ref: ModelRef; usage: UsageReport };

export type ChainOptions = ModelOptions & {
  /** Background work (agent, briefing) respects provider budgets. */
  background?: boolean;
  /** Called after every successful model call with the ref that served it. */
  onCall?: (call: ModelCall) => void;
};

export type ModelResolverDeps = {
  providers: () => ProviderConfig[];
  onUsage?: (usage: UsageReport) => void;
  /** Month-to-date estimated spend for a provider, for budget checks. */
  monthUsd?: (providerId: string) => number;
};

export type ModelResolver = ReturnType<typeof createModelResolver>;

export function createModelResolver(deps: ModelResolverDeps) {
  function provider(providerId: string): ProviderConfig {
    const p = deps.providers().find((x) => x.id === providerId);
    if (!p) throw new ModelUnavailableError(`Unknown provider "${providerId}"`);
    if (!p.enabled) throw new ModelUnavailableError(`Provider "${providerId}" is disabled`);
    return p;
  }

  function resolveModel(ref: ModelRef): LanguageModelV4 {
    const { providerId, modelId } = parseModelRef(ref);
    return createLanguageModel(provider(providerId), modelId);
  }

  function checkBudget(p: ProviderConfig) {
    if (p.monthlyBudgetUsd === undefined || !deps.monthUsd) return;
    if (deps.monthUsd(p.id) >= p.monthlyBudgetUsd) {
      throw new ModelUnavailableError(`Provider "${p.id}" is over its monthly budget`);
    }
  }

  function report(p: ProviderConfig, modelId: string, ref: ModelRef, usage: LanguageModelV4Usage, opts: ChainOptions) {
    const inputTokens = usage.inputTokens.total ?? 0;
    const outputTokens = usage.outputTokens.total ?? 0;
    const u: UsageReport = {
      providerId: p.id,
      modelId,
      inputTokens,
      outputTokens,
      costUsd: estimateCostUsd(p.kind, inputTokens, outputTokens),
    };
    deps.onUsage?.(u);
    opts.onCall?.({ ref, usage: u });
  }

  /**
   * One LanguageModel that tries each ref in order. Streams fall back only
   * when the call fails before the stream starts.
   */
  function chain(refs: ModelRef[], opts: ChainOptions = {}): LanguageModelV4 {
    if (refs.length === 0) throw new NoModelConfiguredError();
    const first = parseModelRef(refs[0]!);

    async function attempt<T>(run: (model: LanguageModelV4, p: ProviderConfig, modelId: string, ref: ModelRef) => Promise<T>) {
      let lastError: unknown;
      for (const ref of refs) {
        try {
          const { providerId, modelId } = parseModelRef(ref);
          const p = provider(providerId);
          if (opts.background) checkBudget(p);
          return await run(createLanguageModel(p, modelId, opts), p, modelId, ref);
        } catch (error) {
          lastError = error;
          if (!isFallbackError(error)) throw error;
        }
      }
      throw lastError;
    }

    return {
      specificationVersion: "v4",
      provider: first.providerId,
      modelId: first.modelId,
      supportedUrls: {},
      doGenerate: (options) =>
        attempt(async (model, p, modelId, ref) => {
          const result = await model.doGenerate(options);
          report(p, modelId, ref, result.usage, opts);
          return result;
        }),
      doStream: (options) =>
        attempt(async (model, p, modelId, ref) => {
          const result = await model.doStream(options);
          const tap = new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
            transform(part, controller) {
              if (part.type === "finish") report(p, modelId, ref, part.usage, opts);
              controller.enqueue(part);
            },
          });
          return { ...result, stream: result.stream.pipeThrough(tap) };
        }),
    };
  }

  const laneRefs = (routing: Routing, lane: Lane): ModelRef[] =>
    routing[lane]?.length ? routing[lane]! : lane === "fast" ? (routing.agent ?? []) : [];

  /** The fallback chain for a lane; `fast` falls back to `agent` when empty. */
  function forLane(routing: Routing, lane: Lane, opts: ChainOptions = {}): LanguageModelV4 {
    return chain(laneRefs(routing, lane), opts);
  }

  /** Native search tools for every enabled provider in a lane's chain that has one. */
  function searchTools(routing: Routing, lane: Lane): ToolSet {
    const tools: ToolSet = {};
    for (const ref of laneRefs(routing, lane)) {
      const p = deps.providers().find((x) => x.id === parseModelRef(ref).providerId);
      if (p?.enabled) Object.assign(tools, nativeSearchTools(p.kind));
    }
    return tools;
  }

  return { resolveModel, chain, forLane, searchTools };
}

export class NoModelConfiguredError extends Error {
  override name = "NoModelConfiguredError";
  constructor() {
    super("No model is configured for this lane. Add a provider and set routing.");
  }
}

/** Whether a lane (or its fallback) has at least one model. */
export function laneConfigured(routing: Routing, lane: Lane): boolean {
  return Boolean(routing[lane]?.length || (lane === "fast" && routing.agent?.length));
}

// ─── Live model listing ─────────────────────────────────────────────────────

export async function listModels(p: ProviderConfig, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const base = baseURLFor(p);
  const headers: Record<string, string> = { ...p.headers };
  let url: string;
  let pick: (body: any) => string[];

  switch (p.kind) {
    case "anthropic":
      url = `${base}/models?limit=1000`;
      if (p.apiKey) headers["x-api-key"] = p.apiKey;
      headers["anthropic-version"] = "2023-06-01";
      pick = (b) => b.data.map((m: { id: string }) => m.id);
      break;
    case "google":
      url = `${base}/models?pageSize=1000`;
      if (p.apiKey) headers["x-goog-api-key"] = p.apiKey;
      pick = (b) =>
        b.models
          .filter((m: { supportedGenerationMethods?: string[] }) => m.supportedGenerationMethods?.includes("generateContent") ?? true)
          .map((m: { name: string }) => m.name.replace(/^models\//, ""));
      break;
    case "ollama":
      url = `${base.replace(/\/v1$/, "")}/api/tags`;
      pick = (b) => b.models.map((m: { name: string }) => m.name);
      break;
    default:
      url = `${base}/models`;
      if (p.apiKey) headers.authorization = `Bearer ${p.apiKey}`;
      pick = (b) => b.data.map((m: { id: string }) => m.id);
  }

  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await errorText(res)}`);
  return [...new Set(pick(await res.json()))].sort();
}

async function errorText(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const body = JSON.parse(text);
    const message = body?.error?.message ?? body?.error ?? body?.message;
    if (typeof message === "string") return message.slice(0, 300);
  } catch {}
  return text.slice(0, 300);
}

export type ProviderTestResult = { ok: boolean; model?: string; latencyMs?: number; error?: string };

/** Send a tiny prompt to the provider's first configured model (or first listed one). */
export async function testProvider(p: ProviderConfig, fetchImpl: typeof fetch = fetch): Promise<ProviderTestResult> {
  let modelId = p.models[0];
  try {
    if (!modelId) modelId = (await listModels(p, fetchImpl))[0];
    if (!modelId) return { ok: false, error: "No models configured or listed for this provider" };
    const started = Date.now();
    await generateText({
      model: createLanguageModel(p, modelId),
      prompt: "Reply with the single word: pong",
      maxOutputTokens: 16,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(30_000),
    });
    return { ok: true, model: modelId, latencyMs: Date.now() - started };
  } catch (error) {
    return { ok: false, ...(modelId ? { model: modelId } : {}), error: describeError(error) };
  }
}

/** A short, key-free description of a provider error. */
export function describeError(error: unknown): string {
  if (APICallError.isInstance(error)) {
    const status = error.statusCode ? `${error.statusCode} ` : "";
    return `${status}${error.message}`.slice(0, 300);
  }
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    const detail = cause instanceof Error ? `: ${cause.message}` : "";
    return `${error.message}${detail}`.slice(0, 300);
  }
  return String(error).slice(0, 300);
}
