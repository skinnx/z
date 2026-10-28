// ─── Delivery & missed runs: durable notice outbox, recurring de-dup, catch-up ─
// One block for how notices reach the owner reliably and what a recurring task does after downtime.

/**
 * Every notice gets one delivery per target (each Web Push device, the paired owner channel), stored
 * before anything is sent. A failed attempt is retried after DELIVERY_BACKOFF_MS[attempt - 1]; after
 * MAX_DELIVERY_ATTEMPTS it is `failed`. Waiting deliveries resume after a restart.
 * - dropped: no longer worth sending: its approval was decided, its question answered, the push
 *            device is gone (404/410) or the owner channel changed.
 * Once an approval is decided or a question answered anywhere, sent channel messages are edited to
 * show the outcome (without buttons) where the adapter can edit.
 */
export type DeliveryStatus = "pending" | "sent" | "failed" | "dropped";
export const DELIVERY_BACKOFF_MS = [30_000, 120_000, 600_000, 3_600_000, 21_600_000] as const;
export const MAX_DELIVERY_ATTEMPTS = 6;

export type NoticeDelivery = {
  id: string;
  noticeId: string;
  target: "push" | "channel";
  status: DeliveryStatus;
  attempts: number;
  /** When the next attempt is due (pending only). */
  nextAttemptAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * A recurring task's run that fell while z was down. `once` (default): run it once at startup
 * (never once per missed slot) when the miss is at most MISSED_RUN_WINDOW_MS old; older misses, and
 * every miss under `skip`, are skipped with a step in the task's events.
 */
export type MissedPolicy = "once" | "skip";
export const MISSED_RUN_WINDOW_MS = 24 * 3600_000;

// Recurring `do` tasks notify on success only when the run did not call `no_update` and its result
// (whitespace-normalized, compared by hash) differs from the last successful run's, or the run ends a
// failure streak. The first failure of a streak always notifies (see "Task engine").

// ─── End delivery & missed runs ─────────────────────────────────────────────
