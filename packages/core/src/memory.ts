/** Long-term memory: the prompt block owner-facing runs get. Ranking itself lives in the server's full-text index. */
import type { Memory } from "./contract.ts";

/** Budget for pinned memories, which are in every owner prompt (newest first when over). */
export const PINNED_PROMPT_CHARS = 2000;
/** Budget for the unpinned memories picked by relevance to the request. */
export const MEMORY_PROMPT_CHARS = 1500;

/**
 * Active memories for one request: every pinned one, then unpinned ones best match for `query` first.
 * Never includes unreviewed memories. Owner-facing runs only.
 */
export type MemoryRecall = (query: string) => Memory[];

const STOP = new Set(
  "the a an and or but of to in on at for with from by is are was were be been it this that these those i me my you your we our they them their he she his her what which who when where how why do does did can could should would will just about into over than then there here not no yes please some any all".split(
    " ",
  ),
);

/** The words in `text` worth searching for: lowercased, accents and stop words dropped. */
export function memoryTerms(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length > 1 && !STOP.has(w)),
    ),
  ];
}

/** Lines of `memories`, in order, within `budget` characters. */
function fit(memories: Memory[], budget: number): string[] {
  const lines: string[] = [];
  let used = 0;
  for (const m of memories) {
    const line = `- ${m.text.replace(/\s+/g, " ").trim()}`;
    if (used + line.length + 1 > budget) {
      if (lines.length === 0) lines.push(line.slice(0, budget - 1) + "…");
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines;
}

/** Pinned memories, then the ones worth knowing for `query`, each within its budget; null when there are none. */
export function memoryPrompt(recall: MemoryRecall | undefined, query: string): string | null {
  const memories = recall?.(query).filter((m) => m.status === "active") ?? [];
  if (memories.length === 0) return null;
  const pinned = memories.filter((m) => m.pinned).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const lines = [...fit(pinned, PINNED_PROMPT_CHARS), ...fit(memories.filter((m) => !m.pinned), MEMORY_PROMPT_CHARS)];
  return [
    "What you remember about the user (from earlier conversations; may be outdated, and the user's current words win):",
    ...lines,
  ].join("\n");
}
