import { z } from "zod";
import { Lane, type ModelRef } from "./common.ts";
import type { MissedPolicy } from "./delivery.ts";
import type { ServerText } from "./messages.ts";

// ─── Tasks: the proactive agent ─────────────────────────────────────────────

export type TaskStatus =
  | "queued"
  | "running"
  | "waiting" // blocked on an approval
  | "scheduled" // recurring, idle until next run
  | "done"
  | "failed"
  | "cancelled"
  | TaskLifecycleStatus; // needs_input | review | interrupted | paused: see "Task engine" below

export const TaskInput = z.object({
  instructions: z.string().min(1).max(8000),
  /** Cron expression for recurring work; omit for one-shot. */
  schedule: z.string().max(120).optional(),
  /** Restrict to these tool names; omit for every enabled tool. */
  tools: z.array(z.string()).optional(),
  lane: Lane.default("agent"),
  /**
   * `do` runs the instructions. `watch` is a standing check ("tell me when …"):
   * it runs on `schedule` and only raises a Notice when something new matters.
   */
  mode: z.enum(["do", "watch"]).default("do"),
  /** A run missed while the server was down: see MissedPolicy under "Delivery & missed runs". */
  missedPolicy: z.enum(["once", "skip"]).default("once"),
});
export type TaskInput = z.input<typeof TaskInput>;

/** Watches without a schedule check hourly. */
export const DEFAULT_WATCH_SCHEDULE = "0 * * * *";

export type TaskEvent =
  | { type: "step"; at: string; text: string }
  | { type: "tool"; at: string; tool: string; input: unknown; output?: unknown; error?: string }
  | { type: "approval"; at: string; approvalId: string }
  | { type: "model"; at: string; model: ModelRef; tokens: number };

export type Task = {
  id: string;
  /** Short title the agent derives from the instructions. */
  title: string;
  instructions: string;
  schedule: string | null;
  tools: string[] | null;
  lane: Lane;
  mode?: "do" | "watch";
  /** Watch tasks only: when it last checked and the last thing it reported. */
  watch?: { lastCheckAt: string | null; lastFinding: { title: string; body: string; at: string } | null };
  status: TaskStatus;
  result: string | null;
  error: string | null;
  /** `error` in words the client translates, when z wrote it itself (an interrupted run). */
  errorMsg?: ServerText | null;
  events: TaskEvent[];
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Recurring tasks: what a run missed while z was down does (absent on old rows: "once"). */
  missedPolicy?: MissedPolicy;
} & TaskLifecycleFields;

// Routes (HTTP API; overview in ../contract.ts):
// GET    /api/tasks                        → Task[]           (newest first)
// POST   /api/tasks         TaskInput      → Task
// POST   /api/tasks/:id/run                → Task             (run now)
// POST   /api/tasks/:id/cancel             → Task
// POST   /api/tasks/:id/answer  TaskAnswer → Task             (see "Task engine")
// POST   /api/tasks/:id/resolve            → Task             (see "Task engine")
// DELETE /api/tasks/:id                    → { ok: true }

// ─── Task engine: crash safety, failure reporting, questions & review ───────
// One block for the task lifecycle; referenced by TaskStatus and Task above, and by Briefing and Notice.

/**
 * - needs_input: paused on the agent's `ask_person` question; POST /api/tasks/:id/answer resumes it.
 * - review:      a one-shot task finished ("Ready for review"); POST /api/tasks/:id/resolve → `done`.
 * - interrupted: z stopped mid-action (a write/external call started without a recorded result).
 *                Never re-run automatically; the owner checks and runs it again.
 * - paused:      a recurring task failed MAX_CONSECUTIVE_FAILURES runs in a row; run it to resume.
 */
export type TaskLifecycleStatus = "needs_input" | "review" | "interrupted" | "paused";

/** Consecutive failed runs after which a recurring task is paused. */
export const MAX_CONSECUTIVE_FAILURES = 10;

/** What the agent asked the owner via `ask_person`. */
export type TaskQuestion = { question: string; choices: string[]; askedAt: string };

export type TaskLifecycleFields = {
  /** Present while `needs_input`. */
  question?: TaskQuestion | null;
  /** Recurring tasks: failed runs in a row (0 after a success). */
  failures?: number;
};

export const TaskAnswer = z.object({ text: z.string().trim().min(1).max(4000) });
export type TaskAnswer = z.input<typeof TaskAnswer>;

/**
 * A notice for a question: answer buttons in the app, on push and on the owner channel. Stored with
 * the notice, so the buttons survive a reload; `answer` is set once it was answered anywhere
 * (`""` when the question was withdrawn: the task was run again, cancelled or deleted).
 */
export type NoticeQuestion = { taskId: string; text: string; choices: string[]; answer?: string };

/** A plugin briefing source that failed. */
export type CouldNotCheck = { source: string; reason: string };

// Routes (also listed under HTTP API):
// POST   /api/tasks/:id/answer  TaskAnswer → Task   (needs_input → queued; the answer becomes the tool result)
// POST   /api/tasks/:id/resolve            → Task   (review | interrupted → done)

// ─── End task engine ────────────────────────────────────────────────────────
