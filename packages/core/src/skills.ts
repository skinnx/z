/**
 * Skills and tool narrowing: which tools a run is offered.
 *
 * Adapted from CopilotKit/OpenDuet (MIT): skills that carry the tools they need
 * (`openbot/examples/openduet/skills.yaml`) and "Which tools a run is offered" in
 * `openbot/docs/architecture.md`: a model picks the right tool reliably out of about ten and
 * unreliably out of thirty, so a run with many connector tools is offered only the ones its request
 * needs. z matches lexically instead of asking a model, and widens to the whole catalogue once when
 * the model asks for a tool it was not offered.
 *
 * Narrowing decides only what the model sees. It never adds a tool: everything offered comes out of
 * `buildTools`, which already applied the owner's approval policy (a denied tool is never built).
 */
import { NoSuchToolError, type ToolCallRepairFunction, type ToolSet } from "ai";
import type { Skill, SkillInput } from "./contract.ts";
import { listTools, type ActivePlugin, type BuiltTools } from "./tools.ts";

/** Connector tools offered to a run without a skill, at most. */
export const NARROW_LIMIT = 24;

// ─── Skills ─────────────────────────────────────────────────────────────────

/** Seeded once, on a fresh install. Ordinary skills: the owner may edit or delete them. */
export const STARTER_SKILLS: Required<SkillInput>[] = [
  {
    name: "factcheck",
    description: "Check a claim and give a verdict with the sources behind it.",
    instructions: [
      "Fact-check the claim the user gives (if none, the latest claim in this conversation).",
      "Split it into the statements that can be checked. Look each one up with your tools: web search when it is available; Wikipedia and Wikidata for people, places, organisations, numbers and dates; Hacker News for tech news. Open the most relevant pages with fetch_page before relying on them.",
      "Answer in this shape:",
      "Verdict: True, False, Misleading or Unverified",
      "Then two or three sentences on why, naming what is right and what is wrong.",
      "Sources: each URL you actually used, one per line.",
      "Prefer primary and recent sources. Say Unverified rather than guess when sources are missing or disagree. Never cite a URL you did not open or get from a tool.",
    ].join("\n"),
    tools: ["web_search", "web_fetch_page", "web_wikipedia", "web_wikidata", "web_hacker_news"],
  },
  {
    name: "summarize-url",
    description: "Read a web page and summarise it.",
    instructions: [
      "Summarise the page at the URL the user gives. Open it with fetch_page; if there is no URL, ask for one.",
      "Reply with a one-line gist, then three to six bullets with the key points, names and numbers, then anything a reader should keep in mind (how old it is, who wrote it and why, whether the text was cut off).",
      "Use only what is on the page; do not add facts from elsewhere. End with the URL.",
    ].join("\n"),
    tools: ["web_fetch_page"],
  },
  {
    name: "watch",
    description: "Turn a request into a watch that tells you when something new matches.",
    instructions: [
      "Turn the user's request into a watch: a standing check that runs on a schedule and tells them only when something new matches.",
      "Rewrite the request as one clear instruction that says what to look for and where (for example \"New releases of nodejs/node on GitHub\").",
      "Pick how often to check from what they said: hourly by default, every 4 hours or daily for things that change slowly.",
      "Call tasks_watch once. Then confirm in one sentence what is watched and how often. Do not check the sources yourself now: the watch checks once right away.",
    ].join("\n"),
    tools: ["tasks_watch"],
  },
];

/** `/name rest…` at the start of a message, when `name` is one of `skills`. */
export function invokedSkill(text: string, skills: readonly Skill[] | undefined): { skill: Skill; rest: string } | null {
  const match = /^\s*\/([a-z0-9][a-z0-9-]*)(?=\s|$)\s*([\s\S]*)$/.exec(text);
  if (!match || !skills?.length) return null;
  const skill = skills.find((s) => s.name === match[1]);
  return skill ? { skill, rest: match[2]!.trim() } : null;
}

const globRe = (pattern: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);

/** The names in `available` a skill's tool patterns (names or `*` globs) select, in `available` order. */
export function expandToolPatterns(patterns: readonly string[], available: readonly string[]): string[] {
  const res = patterns.map(globRe);
  return available.filter((name) => res.some((re) => re.test(name)));
}

/**
 * The `only` list for a run with `skill`: its patterns expanded over the enabled tools, intersected with
 * the run's own restriction. A skill without tools keeps the run's usual set (`only` unchanged).
 */
export function skillOnly(skill: Skill | null | undefined, plugins: ActivePlugin[], only?: string[] | null): string[] | null {
  if (!skill?.tools.length) return only ?? null;
  const names = expandToolPatterns(skill.tools, listTools(plugins).map((t) => t.name));
  return only ? names.filter((n) => only.includes(n)) : names;
}

/** Connector display names by plugin id, so "…in Linear" scores Linear's tools. */
export const pluginLabels = (plugins: ActivePlugin[]): Record<string, string> =>
  Object.fromEntries(plugins.map(({ plugin }) => [plugin.id, plugin.name]));

/** The prompt section for an invoked skill. Owner-written, so these are the user's own instructions. */
export function skillPrompt(skill: Skill): string {
  return `The user invoked their skill /${skill.name} (${skill.description}). Follow its instructions for this request:\n${skill.instructions}`;
}

// ─── Lexical scoring ────────────────────────────────────────────────────────

const STOP = new Set(
  ("a an and are as at be but by can do does for from get give has have how i if in into is it its me my of on or our " +
    "please show tell that the their them then there these this to us use using was we what when where which who why " +
    "will with you your all any about new now some just also make let like want need one")
    .split(" "),
);

/** Crude suffix stripping, applied the same way to requests and tools. */
function stem(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  if (w.length > 4 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

/** Lowercased, stemmed word set; splits snake_case, kebab-case and camelCase. */
export function terms(text: string): Set<string> {
  const out = new Set<string>();
  const words = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u);
  for (const word of words) {
    if (word.length < 2 || STOP.has(word)) continue;
    out.add(stem(word));
  }
  return out;
}

export type ToolCandidate = { name: string; pluginId: string; description: string; label?: string };
export type ScoredTool = { name: string; score: number };

/**
 * Rank connector tools against a request: matching words in the tool's own name count 3×, in its
 * description 1×, each weighted by how rare the word is in the catalogue; naming the connector
 * itself ("…in Linear") adds a little to all its tools. Deterministic: ties go by name.
 */
export function rankTools(request: string, candidates: readonly ToolCandidate[]): ScoredTool[] {
  const want = terms(request);
  if (want.size === 0) return [];
  const docs = candidates.map((c) => {
    const own = c.name.startsWith(`${c.pluginId}_`) ? c.name.slice(c.pluginId.length + 1) : c.name;
    return {
      name: c.name,
      own: terms(own),
      description: terms(c.description.slice(0, 600)),
      source: terms(`${c.pluginId.replace(/^mcp_/, "")} ${c.label ?? ""}`),
    };
  });
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set([...d.own, ...d.description])) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = (t: string) => Math.log(1 + docs.length / (1 + (df.get(t) ?? 0)));

  return docs
    .map((d) => {
      let score = 0;
      for (const t of want) {
        if (d.own.has(t)) score += 3 * idf(t);
        else if (d.description.has(t)) score += idf(t);
        if (d.source.has(t)) score += 1.5;
      }
      return { name: d.name, score: Math.round(score * 1000) / 1000 };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

// ─── What a run is offered ──────────────────────────────────────────────────

export type ToolOffer = {
  /** Tool names the model sees first. */
  offered: string[];
  /** Everything built for the run (what the approval policy exposes): the fallback. */
  catalogue: string[];
  /** Whether `offered` is a strict subset that may widen once. */
  narrowed: boolean;
  /** For the log: why this set. */
  reason: string;
};

const isConnectorTool = (built: BuiltTools, name: string) => built.info[name]?.pluginId.startsWith("mcp_") ?? false;

/**
 * Without a skill: every built-in tool, plus the connector tools that best match the request
 * (top `limit`) and any the conversation already used. With at most `limit` connector tools,
 * everything is offered. `skill`: the run's tools were already restricted to the skill's.
 */
export function offerTools(
  built: BuiltTools,
  opts: {
    request: string;
    skill?: Skill | null;
    used?: readonly string[];
    limit?: number;
    labels?: Record<string, string>;
    /** Tools enabled before a skill restricted the run, for the log. */
    enabled?: number;
  },
): ToolOffer {
  const catalogue = Object.keys(built.tools);
  const limit = opts.limit ?? NARROW_LIMIT;
  if (opts.skill) {
    return { offered: catalogue, catalogue, narrowed: false, reason: `skill /${opts.skill.name} (its tools only${opts.enabled ? `, of ${opts.enabled} enabled` : ""})` };
  }
  const connector = catalogue.filter((n) => isConnectorTool(built, n));
  if (connector.length <= limit) {
    return { offered: catalogue, catalogue, narrowed: false, reason: `all tools (${connector.length} connector tools ≤ ${limit})` };
  }
  const ranked = rankTools(
    opts.request,
    connector.map((name) => {
      const info = built.info[name]!;
      return { name, pluginId: info.pluginId, description: info.tool.description, label: opts.labels?.[info.pluginId] };
    }),
  ).slice(0, limit);
  const picked = new Set([...ranked.map((r) => r.name), ...(opts.used ?? []).filter((n) => connector.includes(n))]);
  const offered = catalogue.filter((n) => !isConnectorTool(built, n) || picked.has(n));
  return {
    offered,
    catalogue,
    narrowed: true,
    reason: `narrowed: ${picked.size} of ${connector.length} connector tools match the request${
      ranked.length ? ` (best: ${ranked.slice(0, 3).map((r) => `${r.name} ${r.score}`).join(", ")})` : ""
    }`,
  };
}

export function describeOffer(offer: ToolOffer): string {
  return `tools: offered ${offer.offered.length} of ${offer.catalogue.length}, ${offer.reason}: ${offer.offered.join(", ") || "(none)"}`;
}

/**
 * The AI SDK side of an offer: `activeTools` for every step through `prepareStep`, and a
 * `repairToolCall` that notices a call to a tool that exists but was not offered and widens the
 * next step to the whole catalogue, once. The rejected call still reaches the model as an error,
 * so it simply calls again. `always` (z's run tools) is offered on every step.
 */
export function narrowing(offer: ToolOffer, opts: { always?: readonly string[]; log?: (text: string) => void } = {}) {
  let widened = false;
  const always = opts.always ?? [];
  const catalogue = new Set(offer.catalogue);
  const activeTools = () => [...(widened ? offer.catalogue : offer.offered), ...always];
  const repairToolCall: ToolCallRepairFunction<ToolSet> = async ({ toolCall, error }) => {
    if (offer.narrowed && !widened && NoSuchToolError.isInstance(error) && catalogue.has(toolCall.toolName)) {
      widened = true;
      opts.log?.(`tools: the model asked for ${toolCall.toolName}, which was not offered; offering all ${offer.catalogue.length} for the next step`);
    }
    return null;
  };
  return { activeTools, repairToolCall, widened: () => widened };
}
