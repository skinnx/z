import type { CouldNotCheck } from "./tasks.ts";

// ─── Briefing: the morning summary ──────────────────────────────────────────

/** An item as a briefing source gathers it, before triage. */
export type BriefSourceItem = {
  id: string;
  /** Source plugin id, e.g. `rss`, `github`, `tasks`. */
  source: string;
  kind: "headline" | "todo" | "followup" | "metric";
  text: string;
  url?: string;
  /** Suggested follow-up the user can turn into a task with one tap. */
  suggestion?: string;
  /** Facts the source knows for certain; triage rules may act on them, only ever to say "can wait". */
  signals?: BriefSignals;
};

/**
 * What a source knows about an item without reading it. Each one, when set, settles the item as
 * "can wait" with no model call; anything a source is unsure of stays unset and the model reads the
 * item. There is deliberately no "urgent" signal: what needs the user does not share keywords.
 */
export type BriefSignals = {
  /** The source itself files it as a newsletter or promotion (a mail provider's Promotions tab). List headers alone are not enough: a security report through a mailing list carries them too. */
  promotional?: boolean;
  /** Opened by an automated account (`dependabot[bot]`) for routine upkeep. Not set for alerts or failures, which bots and `noreply` senders send too. */
  bot?: boolean;
  /** An automated check that passed. Failures are left to the model. */
  ciPassed?: boolean;
  /** The user has already seen it. */
  read?: boolean;
  /** The thread is closed or merged. */
  closed?: boolean;
  /** z is already working on it (a queued, running or scheduled task). */
  delegated?: boolean;
};

/** Whether an item needs the user today. */
export type BriefPriority = "needs_you" | "can_wait";

/** Cap on `BriefItem.reason`. */
export const BRIEF_REASON_MAX = 140;

export type BriefItem = BriefSourceItem & {
  priority: BriefPriority;
  /** One line a person would accept, at most `BRIEF_REASON_MAX` characters. */
  reason: string;
  /** `rule`: settled by a signal, or not checked (no model, or the model left it out; always `needs_you`). */
  decidedBy: "rule" | "model";
};

export type Briefing = {
  id: string;
  /** Local date, YYYY-MM-DD. */
  date: string;
  summary: string;
  items: BriefItem[];
  /** Plugin briefing sources that threw (see "Task engine" in tasks.ts); shown at the bottom. */
  couldNotCheck?: CouldNotCheck[];
  createdAt: string;
};

// Routes (HTTP API; overview in ../contract.ts):
// GET    /api/briefing                     → Briefing | null  (latest)
// POST   /api/briefing                     → Briefing         (generate now)
