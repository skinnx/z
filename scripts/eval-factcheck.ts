/**
 * Fact-check eval: runs the real bot path (core `answerMessage` with the built-in plugins and a
 * real model) over the labeled claims in scripts/factcheck.jsonl and reports accuracy, citation
 * rate and latency.
 *
 *   pnpm eval:factcheck                                   # LLM7 gpt-oss:20b, keyless
 *   pnpm eval:factcheck --model codestral-latest --limit 10
 *   pnpm eval:factcheck --base-url https://text.pollinations.ai/openai --model openai-fast
 *   EVAL_KIND=anthropic EVAL_API_KEY=… pnpm eval:factcheck --model claude-…
 *
 * Flags (or env): --kind (EVAL_KIND, default openai-compatible), --base-url (EVAL_BASE_URL),
 * --model (EVAL_MODEL), EVAL_API_KEY, --only id1,id2, --limit N, --delay ms between items
 * (default 2000), --min-interval ms between model calls (e.g. 31000 for Pollinations), --out results.json.
 * Rate-limit and quota rejections (429/402) count as infra errors, apart from wrong answers.
 * Web search backends are picked up from TAVILY_API_KEY, BRAVE_API_KEY or SEARXNG_URL.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  answerMessage,
  createModelResolver,
  describeError,
  ProviderKind,
  ChannelLimits,
  Settings,
  type ActivePlugin,
  type InboundMessage,
  type ProviderConfig,
  type Verdict,
  type ZPlugin,
} from "../packages/core/src/index.ts";
import { builtinPlugins } from "../packages/plugins/src/index.ts";

type Item = {
  id: string;
  domain: string;
  lang: string;
  post: { author: string; text: string };
  question: string;
  expected: Verdict;
};

const { values: flags } = parseArgs({
  options: {
    kind: { type: "string" },
    "base-url": { type: "string" },
    model: { type: "string" },
    only: { type: "string" },
    limit: { type: "string" },
    delay: { type: "string" },
    out: { type: "string" },
    "min-interval": { type: "string" },
  },
});

const kind = ProviderKind.parse(flags.kind ?? process.env.EVAL_KIND ?? "openai-compatible");
const baseURL = flags["base-url"] ?? process.env.EVAL_BASE_URL ?? (kind === "openai-compatible" ? "https://api.llm7.io/v1" : undefined);
const model = flags.model ?? process.env.EVAL_MODEL ?? "gpt-oss:20b";
const delayMs = Number(flags.delay ?? 2000);

/**
 * Keyless tiers publish per-IP request rates (Pollinations: one reply per 30 s). `--min-interval`
 * spaces calls to the model endpoint at least that far apart so the eval stays inside the limit;
 * time spent waiting for the interval is the harness's, not the bot's, and is left out of latency.
 */
const paceMs = Number(flags["min-interval"] ?? 0);
let paceWaitMs = 0;
let lastModelCall = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (paceMs && baseURL && url.startsWith(baseURL)) {
    const wait = lastModelCall + paceMs - Date.now();
    if (wait > 0) {
      paceWaitMs += wait;
      await new Promise((r) => setTimeout(r, wait));
    }
    lastModelCall = Date.now();
  }
  return realFetch(input, init);
};

const provider: ProviderConfig = {
  id: "eval",
  kind,
  label: "Eval",
  ...(baseURL ? { baseURL } : {}),
  apiKey: process.env.EVAL_API_KEY || null,
  models: [model],
  enabled: true,
};
/** Prompt tokens of each model call for the current item (keyless tiers cap request size). */
let callTokens: number[] = [];
const models = createModelResolver({ providers: () => [provider], onUsage: (u) => callTokens.push(u.inputTokens) });

// Same selection as the server: enabled-by-default plugins whose required settings are present.
const webSettings: Record<string, string> = {};
if (process.env.TAVILY_API_KEY) webSettings.tavilyApiKey = process.env.TAVILY_API_KEY;
if (process.env.BRAVE_API_KEY) webSettings.braveApiKey = process.env.BRAVE_API_KEY;
if (process.env.SEARXNG_URL) webSettings.searxngUrl = process.env.SEARXNG_URL;

/** Count tool calls per item without changing what the tools do. */
let toolCalls: string[] = [];
/** Tool calls that failed because a source was rate limiting or unavailable (the bot never saw evidence). */
let sourceOutages = 0;
const OUTAGE = /rate limit|HTTP (429|503)|unavailable/i;
const counted = (plugin: ZPlugin): ZPlugin => ({
  ...plugin,
  tools: Object.fromEntries(
    Object.entries(plugin.tools ?? {}).map(([name, t]) => [
      name,
      {
        ...t,
        execute: async (input: unknown, ctx) => {
          toolCalls.push(`${plugin.id}_${name}`);
          try {
            return await t.execute(input, ctx);
          } catch (error) {
            if (OUTAGE.test(describeError(error))) sourceOutages++;
            throw error;
          }
        },
      },
    ]),
  ),
});
const plugins: ActivePlugin[] = builtinPlugins
  .map((plugin) => ({ plugin: counted(plugin), settings: plugin.id === "web" ? webSettings : {} }))
  .filter(({ plugin, settings }) => (plugin.enabledByDefault ?? true) && !(plugin.settings ?? []).some((f) => f.required && !settings[f.key]));

let items = readFileSync(new URL("./factcheck.jsonl", import.meta.url), "utf8")
  .split("\n")
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line) as Item);
if (flags.only) items = items.filter((i) => flags.only!.split(",").includes(i.id));
if (flags.limit) items = items.slice(0, Number(flags.limit));

console.log(`fact-check eval: ${items.length} claims · ${kind} ${baseURL ?? ""} ${model}`);
const botTools = plugins.flatMap((p) => Object.entries(p.plugin.tools ?? {}).filter(([, t]) => t.risk === "read" && t.public).map(([t]) => `${p.plugin.id}_${t}`));
console.log(`bot tools: ${botTools.join(", ")}\n`);

type Row = {
  id: string;
  expected: Verdict;
  verdict: Verdict | null;
  ok: boolean;
  ms: number;
  sources: number;
  tools: string[];
  tokens: number[];
  text: string;
  urls: string[];
  retries: number;
  error?: string;
};
const rows: Row[] = [];

type Attempt = Omit<Row, "id" | "expected" | "ok" | "retries">;

/** 429/402 and exhausted fallback chains: the provider refused, the bot never got to answer. */
const isInfra = (r: { error?: string }) => Boolean(r.error && /\b(429|402)\b|rate limit|quota|free limit|eval pacing/i.test(r.error));

async function run(item: Item): Promise<Attempt> {
  const message: InboundMessage = {
    channelId: "eval",
    threadId: item.id,
    messageId: item.id,
    author: { id: "eval", name: "tester" },
    text: item.question,
    addressed: true,
    context: [{ author: item.post.author, text: item.post.text }],
    receivedAt: new Date().toISOString(),
  };
  toolCalls = [];
  sourceOutages = 0;
  callTokens = [];
  paceWaitMs = 0;
  const started = Date.now();
  try {
    const answer = await answerMessage(message, {
      models,
      routing: { chat: [], agent: [], briefing: [], fast: [], bot: [`eval:${model}`] },
      settings: Settings.parse({}),
      plugins,
      channel: { id: "eval", kind: "webhook", label: "Fact-check eval", enabled: true, always: false, lane: "bot", limits: ChannelLimits.parse({}) },
      memory: [],
    });
    const sources = answer?.reply.sources ?? [];
    // Every lookup hit a rate-limited or down source: the bot had nothing to judge on, so this is infra.
    const blind = toolCalls.length > 0 && sourceOutages === toolCalls.length && sources.length === 0;
    return {
      ...(blind && { error: `every source was rate limited or unavailable (${sourceOutages} lookups)` }),
      verdict: answer?.reply.verdict ?? null,
      ms: Date.now() - started - paceWaitMs,
      sources: sources.length,
      tools: toolCalls,
      tokens: callTokens,
      text: answer?.reply.text ?? "",
      urls: sources.map((s) => s.url),
    };
  } catch (error) {
    // The bot's own timeout keeps running while the harness holds calls back for --min-interval.
    const paced = paceWaitMs > 0 && /timeout|aborted/i.test(describeError(error)) ? ` (after ${Math.round(paceWaitMs / 1000)}s of eval pacing)` : "";
    return { verdict: null, ms: Date.now() - started - paceWaitMs, sources: 0, tools: toolCalls, tokens: callTokens, text: "", urls: [], error: describeError(error) + paced };
  }
}

for (const [n, item] of items.entries()) {
  if (n > 0) await new Promise((r) => setTimeout(r, delayMs));
  let attempt = await run(item);
  let retries = 0;
  // Keyless tiers answer bursts with "retry after N seconds"; wait it out (latency is per attempt).
  for (let wait; retries < 2 && (wait = Number(/retry (?:after|in) (\d+) ?s/i.exec(attempt.error ?? "")?.[1])) && wait <= 180; retries++) {
    console.log(`     rate limited, retrying in ${wait}s`);
    await new Promise((r) => setTimeout(r, (wait + 2) * 1000));
    attempt = await run(item);
  }
  const row: Row = { id: item.id, expected: item.expected, ok: attempt.verdict === item.expected, retries, ...attempt };
  rows.push(row);
  const mark = row.error ? (isInfra(row) ? "INFR" : "ERR ") : row.ok ? "ok  " : "MISS";
  console.log(
    `${mark} ${item.id.padEnd(20)} expected ${item.expected.padEnd(10)} got ${String(row.verdict).padEnd(10)} ${(row.ms / 1000).toFixed(1).padStart(5)}s  sources ${row.sources}  tools [${row.tools.join(" ")}]  prompt tokens [${row.tokens.join(" ")}]`,
  );
  console.log(`     ${row.error ?? row.text.replace(/\s+/g, " ").slice(0, 240)}${row.urls.length ? `\n     ${row.urls.join("  ")}` : ""}`);
}

// Accuracy, citations and latency are over the items the bot could attempt; infra errors are reported apart.
const infra = rows.filter(isInfra);
const scored = rows.filter((r) => !isInfra(r));
const pct = (n: number) => `${((100 * n) / Math.max(1, scored.length)).toFixed(1)}%`;
const sorted = scored.map((r) => r.ms).sort((a, b) => a - b);
const quantile = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;
const correct = scored.filter((r) => r.ok).length;
const cited = scored.filter((r) => r.sources > 0).length;

console.log("\nconfusion (expected → got):");
for (const expected of ["true", "false", "misleading"] as const) {
  const of = scored.filter((r) => r.expected === expected);
  const counts = new Map<string, number>();
  for (const r of of) counts.set(String(r.verdict), (counts.get(String(r.verdict)) ?? 0) + 1);
  console.log(`  ${expected.padEnd(10)} ${[...counts].map(([k, v]) => `${k}:${v}`).join("  ")}`);
}
console.log(`\naccuracy       ${correct}/${scored.length} (${pct(correct)})`);
console.log(`citation rate  ${cited}/${scored.length} (${pct(cited)})`);
console.log(`latency        p50 ${(quantile(0.5) / 1000).toFixed(1)}s · p95 ${(quantile(0.95) / 1000).toFixed(1)}s`);
console.log(`infra errors   ${infra.length} (rate limit, quota or pacing timeout; not scored)${infra.length ? `: ${infra.map((r) => r.id).join(", ")}` : ""}`);
console.log(`other errors   ${scored.filter((r) => r.error).length}${paceMs ? ` · paced ${paceMs / 1000}s between model calls (excluded from latency)` : ""} · item retries ${rows.reduce((n, r) => n + r.retries, 0)}`);
if (flags.out) writeFileSync(flags.out, JSON.stringify({ kind, baseURL, model, rows }, null, 2));
