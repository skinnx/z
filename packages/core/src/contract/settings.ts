import { z } from "zod";
import { ApprovalPolicy, ReviewerMode } from "./tools.ts";

// ─── Settings ───────────────────────────────────────────────────────────────

export const Settings = z.object({
  /** Name the bot answers to in channels, e.g. `z` for "@z is this true?". */
  handle: z.string().min(1).max(32).default("z"),
  timezone: z.string().default("UTC"),
  /** Cron for the daily briefing in `timezone`. */
  briefingCron: z.string().default("0 7 * * *"),
  persona: z.string().max(4000).default(""),
  approvals: ApprovalPolicy.default({}),
  /** The action reviewer (see "Approvals: preview, safety floor & action reviewer"). */
  reviewer: ReviewerMode.default("auto"),
  /** Use and update long-term memory. Off: nothing is recalled or remembered (stored memories are kept). */
  memory: z.boolean().default(true),
  /** Memories z writes itself wait as `unreviewed` until the owner confirms them. Off: they are `active` at once. */
  memoryReview: z.boolean().default(true),
  /**
   * Where z reaches its owner when away: approvals with buttons, watch hits, briefings.
   * Set by pairing (POST /api/owner/link, then send `/link <code>` to the bot). Read-only over PUT.
   */
  owner: z
    .object({ channelId: z.string(), threadId: z.string(), authorId: z.string(), label: z.string() })
    .nullable()
    .default(null),
});
export type Settings = z.output<typeof Settings>;

// Routes (HTTP API; overview in ../contract.ts):
// GET    /api/settings                     → Settings
// PUT    /api/settings      Settings       → Settings
