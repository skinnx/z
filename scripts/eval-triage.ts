/**
 * Briefing triage eval: runs core `triageBriefItems` (rules, then one model call per batch) over the
 * labelled items in scripts/triage.jsonl and reports precision, recall and F1 for "needs you", the
 * confusion matrix, every disagreement with its reason, and latency.
 *
 * Method adapted from OpenDuet's triage eval (CopilotKit/OpenDuet `evals/triage/`, MIT): invented
 * items with hand labels and a reason each, including the cases that go wrong in practice. Recall
 * matters most: a missed failed deploy costs more than one extra line. Never tune by special-casing
 * items; the set is a regression check for rules, prompt and model, not proof of accuracy.
 *
 *   pnpm eval:triage                                   # LLM7 gpt-oss:20b, keyless, all items in one call
 *   pnpm eval:triage --rules-only                      # no model calls
 *   pnpm eval:triage --base-url https://text.pollinations.ai/openai --model openai-fast --min-interval 31000 --batch 15
 *   EVAL_KIND=anthropic EVAL_API_KEY=… pnpm eval:triage --model claude-…
 *
 * Pollinations caps replies at 1500 tokens, about 14 verdicts from its reasoning model, hence --batch 15.
 *
 * Flags (or env): --kind (EVAL_KIND, default openai-compatible), --base-url (EVAL_BASE_URL), --model
 * (EVAL_MODEL), EVAL_API_KEY, --batch N items per model call (default: all in one), --min-interval ms
 * between model calls, --out file (default scripts/results/triage-<model>.json; "-" to skip).
 * Items the model left unsorted show as needs_you, as in the product, and are counted apart.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  createModelResolver,
  ProviderKind,
  ruleVerdict,
  Settings,
  triageBriefItems,
  NOT_CHECKED,
  type BriefItem,
  type BriefPriority,
  type BriefSourceItem,
  type ProviderConfig,
} from "../packages/core/src/index.ts";

type Labelled = BriefSourceItem & { label: BriefPriority; why: string };

const { values: flags } = parseArgs({
  options: {
    kind: { type: "string" },
    "base-url": { type: "string" },
    model: { type: "string" },
    batch: { type: "string" },
    out: { type: "string" },
    "min-interval": { type: "string" },
    "rules-only": { type: "boolean" },
  },
});

const rulesOnly = Boolean(flags["rules-only"]);
const kind = ProviderKind.parse(flags.kind ?? process.env.EVAL_KIND ?? "openai-compatible");
const baseURL = flags["base-url"] ?? process.env.EVAL_BASE_URL ?? (kind === "openai-compatible" ? "https://api.llm7.io/v1" : undefined);
const model = flags.model ?? process.env.EVAL_MODEL ?? "gpt-oss:20b";

// The owner the set was written for, and the morning it was written for.
const settings = Settings.parse({
  timezone: "Asia/Ho_Chi_Minh",
  persona:
    "I'm Lan Nguyen (GitHub @lan-ng), maintainer of lan-ng/tidepool, an open-source tide prediction library published to npm with a classic token from GitHub Actions. Its docs site is tidepool.dev. I live in Hanoi and co-organize the JavaScript Hanoi meetup.",
});
const NOW = new Date("2026-10-28T07:00:00+07:00");

/** Keyless tiers publish per-IP request rates; space calls out (the wait is left out of latency). */
const paceMs = Number(flags["min-interval"] ?? 0);
let paceWaitMs = 0;
const replies: string[] = [];
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
  const res = await realFetch(input, init);
  // Keep what the model said, so a reply that did not parse can be read afterwards.
  if (baseURL && url.startsWith(baseURL)) res.clone().text().then((body) => replies.push(body.slice(0, 20_000)), () => {});
  return res;
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
const tokens: { input: number; output: number }[] = [];
const models = createModelResolver({ providers: () => [provider], onUsage: (u) => tokens.push({ input: u.inputTokens, output: u.outputTokens }) });

const set = readFileSync(new URL("./triage.jsonl", import.meta.url), "utf8")
  .split("\n")
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line) as Labelled);
const count = (label: BriefPriority) => set.filter((i) => i.label === label).length;
console.log(
  `triage eval: ${set.length} items (${count("needs_you")} needs_you, ${count("can_wait")} can_wait) · ${rulesOnly ? "rules only" : `${kind} ${baseURL ?? ""} ${model}`}\n`,
);

const asSource = ({ label: _l, why: _w, ...item }: Labelled): BriefSourceItem => item;
const batchSize = Number(flags.batch ?? set.length);
const logs: string[] = [];
const calls: { items: number; ms: number }[] = [];
const results: (BriefItem | null)[] = [];

if (rulesOnly) {
  for (const item of set) {
    const verdict = ruleVerdict(item);
    results.push(verdict ? { ...asSource(item), ...verdict } : null);
  }
} else {
  // Batches are cut from the items the rules leave, exactly as the product does in one call.
  const open = set.filter((i) => !ruleVerdict(i));
  const sorted = new Map<string, BriefItem>();
  for (const item of set) {
    const verdict = ruleVerdict(item);
    if (verdict) sorted.set(item.id, { ...asSource(item), ...verdict });
  }
  for (let start = 0; start < open.length; start += batchSize) {
    const batch = open.slice(start, start + batchSize);
    let out: BriefItem[] = [];
    // A refusal that names a short wait ("retry after 10s") is waited out, at most twice.
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = logs.length;
      paceWaitMs = 0;
      const started = Date.now();
      out = await triageBriefItems(batch.map(asSource), {
        model: models.forLane({ chat: [], agent: [], bot: [], fast: [], briefing: [`eval:${model}`] }, "briefing"),
        settings,
        now: NOW,
        batchSize,
        timeoutMs: 300_000,
        log: (text) => (logs.push(text), console.log(`     ${text.slice(0, 300)}`)),
      });
      calls.push({ items: batch.length, ms: Date.now() - started - paceWaitMs });
      const wait = Number(/retry (?:after|in) (\d+) ?s/i.exec(logs.slice(before).join(" "))?.[1]);
      if (out.some((i) => i.decidedBy === "model") || !wait || wait > 180) break;
      console.log(`     rate limited, retrying in ${wait + 2}s`);
      await new Promise((r) => setTimeout(r, (wait + 2) * 1000));
    }
    for (const item of out) sorted.set(item.id, item);
  }
  for (const item of set) results.push(sorted.get(item.id) ?? null);
}

type Row = { id: string; label: BriefPriority; why: string; got: BriefPriority | null; decidedBy: string | null; reason: string; text: string };
const rows: Row[] = set.map((item, i) => {
  const r = results[i];
  return { id: item.id, label: item.label, why: item.why, got: r?.priority ?? null, decidedBy: r?.decidedBy ?? null, reason: r?.reason ?? "", text: item.text };
});

const unchecked = rows.filter((r) => r.reason === NOT_CHECKED);
const decided = rows.filter((r) => r.got);
const tp = decided.filter((r) => r.label === "needs_you" && r.got === "needs_you").length;
const fp = decided.filter((r) => r.label === "can_wait" && r.got === "needs_you").length;
const fn = decided.filter((r) => r.label === "needs_you" && r.got === "can_wait").length;
const tn = decided.filter((r) => r.label === "can_wait" && r.got === "can_wait").length;
const ratio = (n: number, d: number) => (d ? n / d : null);
const precision = ratio(tp, tp + fp);
const recall = ratio(tp, tp + fn);
const f1 = precision !== null && recall !== null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : null;
const pct = (x: number | null) => (x === null ? "n/a" : `${(100 * x).toFixed(1)}%`);
const byRule = rows.filter((r) => r.decidedBy === "rule" && r.reason !== NOT_CHECKED);
const ruleWrong = byRule.filter((r) => r.label !== "can_wait");
/** The model on its own: only the items it actually decided. */
const byModel = rows.filter((r) => r.decidedBy === "model");
const mTp = byModel.filter((r) => r.label === "needs_you" && r.got === "needs_you").length;
const mFp = byModel.filter((r) => r.label === "can_wait" && r.got === "needs_you").length;
const mFn = byModel.filter((r) => r.label === "needs_you" && r.got === "can_wait").length;
const modelOnly = { decided: byModel.length, precision: ratio(mTp, mTp + mFp), recall: ratio(mTp, mTp + mFn), tp: mTp, fp: mFp, fn: mFn };

const mark = (r: Row) => (!r.got ? "  -  " : r.got === r.label ? "ok   " : r.label === "needs_you" ? "MISS " : "EXTRA");
for (const r of rows) {
  console.log(`${mark(r)} ${r.id.padEnd(26)} label ${r.label.padEnd(9)} got ${String(r.got).padEnd(9)} by ${String(r.decidedBy).padEnd(5)} ${r.reason}`);
}
const wrong = decided.filter((r) => r.got !== r.label);
console.log(`\nfailures (${wrong.length}):`);
for (const r of wrong) console.log(`  ${r.id}: labelled ${r.label}, got ${r.got} by ${r.decidedBy}: "${r.reason}"\n    label's reason: ${r.why}\n    item: ${r.text}`);

const msSorted = calls.map((c) => c.ms).sort((a, b) => a - b);
const latency = calls.length
  ? `${calls.length} model call${calls.length === 1 ? "" : "s"}, ${calls.map((c) => `${c.items} items in ${(c.ms / 1000).toFixed(1)}s`).join(", ")} · ${(msSorted.reduce((a, b) => a + b, 0) / Math.max(1, calls.reduce((n, c) => n + c.items, 0))).toFixed(0)} ms per item`
  : "no model calls";
console.log(`
confusion (label → got)      needs_you  can_wait
  needs_you                  ${String(tp).padStart(9)} ${String(fn).padStart(9)}
  can_wait                   ${String(fp).padStart(9)} ${String(tn).padStart(9)}

precision (needs_you)  ${pct(precision)}  (${tp} of ${tp + fp} flagged really needed her)
recall    (needs_you)  ${pct(recall)}  (${tp} of ${tp + fn} that needed her were flagged)
F1        (needs_you)  ${pct(f1)}
accuracy               ${pct(ratio(tp + tn, decided.length))} of ${decided.length} decided
decided by rules       ${byRule.length} of ${set.length}, ${ruleWrong.length} wrong
decided by the model   ${byModel.length}: precision ${pct(modelOnly.precision)} (${mTp}/${mTp + mFp}), recall ${pct(modelOnly.recall)} (${mTp}/${mTp + mFn}) on those alone
not checked            ${unchecked.length} (shown as needs_you; the model failed or skipped them)${rulesOnly ? ` · ${rows.length - decided.length} left for the model` : ""}
latency                ${latency}${paceMs ? ` · paced ${paceMs / 1000}s between calls (excluded)` : ""}
tokens                 ${tokens.map((t) => `${t.input} in / ${t.output} out`).join(", ") || "-"}`);

// The provider refused (rate limit, quota): the model never got to answer, so this is no snapshot of it.
const infra = !rulesOnly && tokens.length === 0 && rows.every((r) => r.decidedBy !== "model") && logs.some((l) => /\b(429|402)\b|rate limit|quota|at its limit|retry after/i.test(l));
if (infra) {
  console.log("\ninfra: the provider refused every call (rate limit or quota); not scored, no results written.");
  process.exitCode = 2;
} else if (flags.out !== "-") {
  const name = rulesOnly ? "rules-only" : model.replace(/[^\w.-]+/g, "-");
  const out = flags.out ?? new URL(`./results/triage-${name}.json`, import.meta.url).pathname;
  mkdirSync(new URL("./results/", import.meta.url), { recursive: true });
  writeFileSync(
    out,
    JSON.stringify(
      {
        ranAt: new Date().toISOString(),
        kind: rulesOnly ? null : kind,
        baseURL: rulesOnly ? null : (baseURL ?? null),
        model: rulesOnly ? null : model,
        items: set.length,
        metrics: { precision, recall, f1, tp, fp, fn, tn, byRule: byRule.length, ruleWrong: ruleWrong.length, notChecked: unchecked.length, modelOnly },
        calls,
        tokens,
        logs,
        replies,
        rows,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`\nwrote ${out}`);
}
