/** Long-term memory: keyword + recency ranking and the prompt block owner-facing runs get. */
import type { Memory } from "./contract.ts";

/** Budget for memories injected into one prompt. */
export const MEMORY_PROMPT_CHARS = 1500;

const STOP = new Set(
  "the a an and or but of to in on at for with from by is are was were be been it this that these those i me my you your we our they them their he she his her what which who when where how why do does did can could should would will just about into over than then there here not no yes please some any all".split(
    " ",
  ),
);

function terms(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 1 && !STOP.has(w)),
  );
}

/**
 * Most relevant first: shared terms with the query (prefix matches count half),
 * ties and query-less calls broken by recency.
 */
export function rankMemories(memories: Memory[], query: string): Memory[] {
  const q = [...terms(query)];
  const newest = memories.reduce((max, m) => Math.max(max, Date.parse(m.updatedAt) || 0), 0);
  const scored = memories.map((m) => {
    const words = terms(m.text);
    let hits = 0;
    for (const term of q) {
      if (words.has(term)) hits += 1;
      else if (term.length >= 4 && [...words].some((w) => w.startsWith(term) || term.startsWith(w))) hits += 0.5;
    }
    const ageDays = Math.max(0, (newest - (Date.parse(m.updatedAt) || 0)) / 86_400_000);
    const recency = 1 / (1 + ageDays / 30);
    return { m, score: hits * 2 + recency };
  });
  return scored.sort((a, b) => b.score - a.score).map((s) => s.m);
}

/** The memories worth knowing for `query`, within `MEMORY_PROMPT_CHARS`; null when there are none. */
export function memoryPrompt(memories: Memory[] | undefined, query: string): string | null {
  if (!memories?.length) return null;
  const lines: string[] = [];
  let used = 0;
  for (const m of rankMemories(memories, query)) {
    const line = `- ${m.text.replace(/\s+/g, " ").trim()}`;
    if (used + line.length + 1 > MEMORY_PROMPT_CHARS) {
      if (lines.length === 0) lines.push(line.slice(0, MEMORY_PROMPT_CHARS - 1) + "…");
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return [
    "What you remember about the user (from earlier conversations; may be outdated, and the user's current words win):",
    ...lines,
  ].join("\n");
}
