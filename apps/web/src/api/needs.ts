/** Everything waiting on the owner, in order of urgency: one source for Today's block and the nav count. */
import type { Approval, Task } from "@z/core";
import { usePendingApprovals } from "./approvals.ts";
import { useTasks } from "./tasks.ts";

export type NeedsYou = {
  approvals: Approval[];
  questions: Task[];
  reviews: Task[];
  interrupted: Task[];
  /** Not waiting on the owner; shown as one "Working on" line. */
  working: Task[];
  /** What needs the owner: approvals, questions, reviews, interruptions. */
  count: number;
  /** Both lists have loaded at least once. */
  loaded: boolean;
};

const byNewest = (a: Task, b: Task) => b.updatedAt.localeCompare(a.updatedAt);

export function useNeedsYou(): NeedsYou {
  const approvalsQuery = usePendingApprovals();
  const tasksQuery = useTasks();
  const tasks = tasksQuery.data ?? [];
  const approvals = approvalsQuery.data ?? [];
  const pick = (...statuses: Task["status"][]) => tasks.filter((t) => statuses.includes(t.status)).sort(byNewest);
  const questions = pick("needs_input");
  const reviews = pick("review");
  const interrupted = pick("interrupted");
  return {
    approvals,
    questions,
    reviews,
    interrupted,
    working: pick("running", "queued"),
    count: approvals.length + questions.length + reviews.length + interrupted.length,
    loaded: approvalsQuery.data !== undefined && tasksQuery.data !== undefined,
  };
}
