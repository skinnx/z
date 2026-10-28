import { z } from "zod";

// ─── Memory: what z knows about its owner ───────────────────────────────────

export const MemoryInput = z.object({ text: z.string().min(1).max(2000), pinned: z.boolean().optional() });
/**
 * `unreviewed`: z remembered it while `Settings.memoryReview` is on; never used in prompts or recall
 * until the owner confirms (or edits) it. `active`: used.
 */
export const MemoryStatus = z.enum(["unreviewed", "active"]);
export type MemoryStatus = z.infer<typeof MemoryStatus>;
export type Memory = {
  id: string;
  text: string;
  /** `user` when written in the UI, `agent` when z remembered it via a tool. */
  source: "user" | "agent";
  status: MemoryStatus;
  /** Active pinned memories are in every owner prompt; the rest are picked by relevance. */
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
};

// Routes (HTTP API; overview in ../contract.ts):
// GET    /api/memories?status=&q=          → Memory[]  (newest first; with `q`, full-text search, best match first)
// POST   /api/memories      MemoryInput    → Memory    (owner-written: active)
// PUT    /api/memories/:id  MemoryInput    → Memory    (editing an unreviewed memory confirms it)
// POST   /api/memories/:id/confirm         → Memory    (unreviewed → active)
// POST   /api/memories/:id/pin { pinned: boolean } → Memory
// DELETE /api/memories/:id                 → { ok: true }
// DELETE /api/memories                     → { deleted: number }   (all memories)
