/**
 * Task queue, recurring schedules and the pause/resume cycles: approvals, `ask_person` questions,
 * review → resolve, failure fatigue, and crash recovery that never replays a side effect.
 */
import { createHash, randomUUID } from "node:crypto";
import { Cron } from "croner";
import {
  DEFAULT_WATCH_SCHEDULE,
  deriveTitle,
  MAX_CONSECUTIVE_FAILURES,
  MAX_FINGERPRINTS,
  MISSED_RUN_WINDOW_MS,
  pendingQuestion,
  runTask,
  runWatch,
  withAnswer,
  withApprovalResponses,
  type Approval,
  type ApprovalDecision,
  type PendingQuestion,
  type Task,
  type TaskEvent,
  type TaskInput,
} from "@z/core";
import type { ModelMessage } from "ai";
import type { z } from "zod";
import { approvalBody, buttonable, clip, notify, settleApproval, settleQuestion } from "./notify.ts";
import { planRecovery } from "./recovery.ts";
import type { Runtime } from "./runtime.ts";
import { nextRunAt } from "./schedule.ts";

const CONCURRENCY = 2;

export class ConflictError extends Error {}

/** Statuses a scheduled run may start from: not busy, not waiting on the owner, not paused. */
const RUNNABLE: Task["status"][] = ["scheduled", "done", "failed"];

export type Tasks = ReturnType<typeof createTasks>;

/** Whitespace-normalized hash of a run's result: recurring runs that repeat it stay quiet. */
export const resultHash = (text: string) => createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex");

/** `now`: the clock (tests pass a fake one for schedules and missed runs). */
export function createTasks(rt: Runtime, { now: clock = () => new Date() }: { now?: () => Date } = {}) {
  const { store, bus } = rt;
  const queue: string[] = [];
  const running = new Map<string, AbortController>();
  const jobs = new Map<string, Cron>();

  const timezone = () => store.settings.get().timezone;
  const now = () => clock().toISOString();
  const nextRun = (pattern: string) => nextRunAt(pattern, timezone(), clock());

  function emit(id: string): Task | null {
    const task = store.tasks.get(id);
    if (task) bus.emit({ type: "task", task });
    return task;
  }

  function update(id: string, patch: Parameters<typeof store.tasks.update>[1]): Task | null {
    store.tasks.update(id, patch);
    return emit(id);
  }

  const step = (id: string, text: string) => store.tasks.appendEvents(id, [{ type: "step", at: now(), text }]);
  const titleOf = (task: Task) => clip(store.tasks.get(task.id)?.title ?? task.title, 80);

  function enqueue(id: string) {
    if (!queue.includes(id) && !running.has(id)) queue.push(id);
    pump();
  }

  function pump() {
    while (running.size < CONCURRENCY && queue.length) void execute(queue.shift()!);
  }

  /** A run ended for good: forget its conversation and crash journal. */
  function endRun(id: string) {
    store.tasks.setMessages(id, null);
    store.tasks.clearCalls(id);
  }

  async function execute(id: string) {
    const task = store.tasks.get(id);
    if (!task || task.status !== "queued") return;
    const controller = new AbortController();
    running.set(id, controller);
    update(id, { status: "running", error: null });

    const onEvent = (event: TaskEvent) => {
      store.tasks.appendEvents(id, [event]);
      emit(id);
    };

    if (task.mode === "watch") return executeWatch(task, controller, onEvent);

    const live = () => !controller.signal.aborted && store.tasks.get(id) !== null;
    try {
      const outcome = await runTask(task, rt.ownerDeps(`task:${id.slice(0, 8)}`), {
        messages: store.tasks.messages(id),
        signal: controller.signal,
        onEvent,
        // Crash safety: the conversation after every step, and each write/external call before and after it runs.
        onMessages: (messages) => live() && store.tasks.setMessages(id, messages),
        onToolStart: (call) => live() && store.tasks.callStarted(id, call),
        onToolEnd: (call) => store.tasks.callFinished(id, call.toolCallId, call),
      });
      if (!live()) return;

      if (outcome.status === "waiting") {
        store.tasks.setMessages(id, outcome.messages);
        const events: TaskEvent[] = [];
        for (const request of outcome.approvals) {
          const approval: Approval = { id: randomUUID(), taskId: id, ...request, status: "pending", createdAt: now(), decidedAt: null };
          store.approvals.insert(approval);
          events.push({ type: "approval", at: approval.createdAt, approvalId: approval.id });
          bus.emit({ type: "approval", approval });
          const title = store.tasks.get(id)?.title ?? task.title;
          notify({ kind: "approval", title: `Approval needed · ${clip(title, 80)}`, body: approvalBody(approval), path: "/", approvalId: approval.id });
        }
        store.tasks.appendEvents(id, events);
        update(id, { status: "waiting" });
        return;
      }

      if (outcome.status === "needs_input") {
        store.tasks.setMessages(id, outcome.messages);
        ask(task, outcome.question);
        return;
      }

      endRun(id);
      if (outcome.status === "done") finish(task, { result: outcome.result, error: null }, "done", outcome.quiet);
      else finish(task, { error: outcome.error }, "failed");
    } catch (error) {
      endRun(id);
      finish(task, { error: error instanceof Error ? error.message : String(error) }, "failed");
    } finally {
      running.delete(id);
      pump();
    }
  }

  /** Pause on an `ask_person` question and tell the owner; simple choices become buttons. */
  function ask(task: Task, q: PendingQuestion) {
    const askedAt = now();
    store.tasks.setQuestion(task.id, { ...q, askedAt });
    step(task.id, `Asked: ${q.question}`);
    update(task.id, { status: "needs_input" });
    // Stored on the notice, so the app keeps its answer buttons; channels and push add buttons when they fit.
    notify({
      kind: "question",
      title: `Question · ${titleOf(task)}`,
      body: clip(q.question + (q.choices.length && !buttonable(q.choices) ? `\nChoices: ${q.choices.join(" / ")}` : ""), 1000),
      path: `/tasks?task=${task.id}`,
      question: { taskId: task.id, text: q.question, choices: q.choices },
    });
  }

  /** A watch check: look with read tools, decide, notify only on something new. */
  async function executeWatch(task: Task, controller: AbortController, onEvent: (event: TaskEvent) => void) {
    const id = task.id;
    try {
      const outcome = await runWatch(task, rt.ownerDeps(`watch:${id.slice(0, 8)}`), {
        seen: store.tasks.fingerprints(id),
        signal: controller.signal,
        onEvent,
      });
      if (controller.signal.aborted || !store.tasks.get(id)) return;
      if (outcome.status === "failed") return finish(task, { error: outcome.error }, "failed");

      const checkedAt = now();
      const { decision } = outcome;
      const previous = store.tasks.get(id)?.watch?.lastFinding ?? null;
      const lastFinding = decision.notify ? { title: decision.title, body: decision.body, at: checkedAt } : previous;
      store.tasks.recordWatch(id, { lastCheckAt: checkedAt, lastFinding }, outcome.fingerprints, MAX_FINGERPRINTS);
      if (decision.notify) notify({ kind: "watch", title: clip(decision.title, 120), body: clip(decision.body, 1000), path: `/tasks?task=${id}` });
      // The watch's own decision is its notice: no separate completion notice.
      finish(task, { ...(decision.notify ? { result: decision.body } : {}), error: null }, "done", true);
    } catch (error) {
      finish(task, { error: error instanceof Error ? error.message : String(error) }, "failed");
    } finally {
      running.delete(id);
      pump();
    }
  }

  /**
   * One-shot tasks go to `review` (or `failed`) and tell the owner. Recurring ones go back to `scheduled`:
   * a failure notifies only when it breaks a run of successes, and MAX_CONSECUTIVE_FAILURES in a row pause the task.
   * `quiet` (no_update, or a watch) suppresses the completion notice, and so does a result that repeats
   * the last successful run's (whitespace-normalized hash), unless this run ends a failure streak.
   */
  function finish(task: Task, patch: { result?: string; error: string | null }, status: "done" | "failed", quiet = false) {
    const path = `/tasks?task=${task.id}`;
    if (task.schedule) {
      if (status === "done") {
        const recovered = (store.tasks.get(task.id)?.failures ?? 0) > 0;
        update(task.id, { ...patch, status: "scheduled", failures: 0, nextRunAt: nextRun(task.schedule) });
        if (quiet || !patch.result) return;
        const hash = resultHash(patch.result);
        const repeated = hash === store.tasks.resultHash(task.id);
        store.tasks.setResultHash(task.id, hash);
        if (repeated && !recovered) return step(task.id, "Same result as the last run: no notice.");
        notify({ kind: "task", title: `Done · ${titleOf(task)}`, body: clip(patch.result, 300), path });
        return;
      }
      const failures = (store.tasks.get(task.id)?.failures ?? 0) + 1;
      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        update(task.id, { ...patch, status: "paused", failures, nextRunAt: null });
        step(task.id, `Paused after ${failures} failed runs in a row.`);
        notify({
          kind: "task",
          title: `Paused · ${titleOf(task)}`,
          body: clip(`Failed ${failures} runs in a row, so z stopped running it. Last error: ${patch.error ?? "unknown"}. Run it again once fixed.`, 400),
          path,
        });
        return;
      }
      update(task.id, { ...patch, status: "scheduled", failures, nextRunAt: nextRun(task.schedule) });
      if (failures === 1) notify({ kind: "task", title: `Failing · ${titleOf(task)}`, body: clip(patch.error || "", 300), path });
      return;
    }
    update(task.id, { ...patch, status: status === "done" ? "review" : "failed", nextRunAt: null });
    if (quiet && status === "done") return;
    notify({
      kind: "task",
      title: `${status === "done" ? "Ready for review" : "Failed"} · ${titleOf(task)}`,
      body: clip((status === "done" ? patch.result : patch.error) || "", 300),
      path,
    });
  }

  function schedule(task: Task) {
    jobs.get(task.id)?.stop();
    jobs.delete(task.id);
    if (!task.schedule || task.status === "cancelled") return;
    jobs.set(task.id, new Cron(task.schedule, { timezone: timezone(), protect: true }, () => fire(task.id)));
  }

  /** Scheduled runs skip tasks that are busy, wait for the owner (needs you) or are paused. */
  function fire(id: string) {
    const task = store.tasks.get(id);
    if (!task || !RUNNABLE.includes(task.status)) return;
    update(id, { status: "queued", nextRunAt: nextRun(task.schedule!) });
    enqueue(id);
  }

  function expireApprovals(taskId: string) {
    for (const approval of store.approvals.expireForTask(taskId)) {
      bus.emit({ type: "approval", approval });
      settleApproval(approval);
    }
  }

  /** Withdraw an open question (the run is reset): its notices and channel messages lose their buttons. */
  function withdrawQuestion(id: string) {
    if (!store.tasks.question(id)) return;
    store.tasks.setQuestion(id, null);
    settleQuestion(id, null);
  }

  function stop(id: string) {
    running.get(id)?.abort();
    running.delete(id);
    const i = queue.indexOf(id);
    if (i >= 0) queue.splice(i, 1);
    jobs.get(id)?.stop();
    jobs.delete(id);
    expireApprovals(id);
    withdrawQuestion(id);
    endRun(id);
  }

  /** Resume a paused conversation: back to the queue, or to the next question if one is still open. */
  function resume(task: Task, messages: ModelMessage[]) {
    store.tasks.setMessages(task.id, messages);
    const question = pendingQuestion(messages);
    if (question) return ask(task, question);
    update(task.id, { status: "queued" });
    enqueue(task.id);
  }

  /**
   * Startup: a recurring run that fell due while z was down runs once now (however many slots it
   * missed) when the policy is `once` and the miss is recent; otherwise it is skipped and noted.
   */
  function catchUp(task: Task) {
    if (!task.schedule || !task.nextRunAt || !RUNNABLE.includes(task.status)) return;
    const due = Date.parse(task.nextRunAt);
    const late = clock().getTime() - due;
    if (!(late > 0)) return;
    const policy = task.missedPolicy ?? "once";
    if (policy === "once" && late <= MISSED_RUN_WINDOW_MS) {
      step(task.id, `Missed the run due ${task.nextRunAt} while z was offline: running it once now.`);
      console.log(`[z:tasks] ${task.id.slice(0, 8)} missed its run at ${task.nextRunAt}: running once`);
      return fire(task.id);
    }
    const why = policy === "skip" ? "missed runs are skipped for this task" : "more than 24 hours ago";
    step(task.id, `Skipped the run due ${task.nextRunAt} while z was offline (${why}).`);
    console.log(`[z:tasks] ${task.id.slice(0, 8)} missed its run at ${task.nextRunAt}: skipped (${why})`);
    update(task.id, { nextRunAt: nextRun(task.schedule) });
  }

  /** Startup: decide what each task interrupted mid-run may do. */
  function recover(task: Task) {
    // Watches only read: redo the check.
    if (task.mode === "watch") {
      endRun(task.id);
      store.tasks.update(task.id, { status: "queued" });
      return;
    }
    const messages = store.tasks.messages(task.id) ?? [{ role: "user" as const, content: task.instructions }];
    const plan = planRecovery(messages, store.tasks.calls(task.id));
    if (plan.action === "resume") {
      store.tasks.setMessages(task.id, plan.messages);
      store.tasks.update(task.id, { status: "queued" });
      console.log(`[z:tasks] ${task.id.slice(0, 8)} resumes after restart`);
      return;
    }
    const summary = plan.calls.map((c) => c.summary).join("; ");
    const error = `z stopped mid-action: ${summary}. Check and run again if needed.`;
    endRun(task.id);
    step(task.id, error);
    update(task.id, { status: "interrupted", error, nextRunAt: null });
    console.log(`[z:tasks] ${task.id.slice(0, 8)} interrupted mid-action (${plan.calls.map((c) => c.tool).join(", ")}): not re-run`);
    notify({ kind: "task", title: `Interrupted · ${titleOf(task)}`, body: clip(error, 400), path: `/tasks?task=${task.id}` });
  }

  return {
    create(input: z.output<typeof TaskInput>): Task {
      const at = now();
      const watch = input.mode === "watch";
      // A watch always has a schedule, and checks once right away to show it works.
      const sched = input.schedule ?? (watch ? DEFAULT_WATCH_SCHEDULE : null);
      const task: Task = {
        id: randomUUID(),
        title: input.instructions.replace(/\s+/g, " ").trim().slice(0, 60),
        instructions: input.instructions,
        schedule: sched,
        tools: input.tools ?? null,
        lane: input.lane,
        mode: input.mode,
        ...(watch ? { watch: { lastCheckAt: null, lastFinding: null } } : {}),
        status: sched && !watch ? "scheduled" : "queued",
        missedPolicy: input.missedPolicy,
        result: null,
        error: null,
        events: [],
        nextRunAt: sched ? nextRun(sched) : null,
        createdAt: at,
        updatedAt: at,
        question: null,
        failures: 0,
      };
      store.tasks.insert(task);
      bus.emit({ type: "task", task });
      if (task.schedule) schedule(task);
      if (task.status === "queued") enqueue(task.id);

      void deriveTitle(task.instructions, rt.deps("title")).then((title) => {
        if (title !== task.title && store.tasks.get(task.id)) update(task.id, { title });
      });
      return task;
    },

    runNow(id: string): Task | null {
      const task = store.tasks.get(id);
      if (!task) return null;
      if (task.status === "running" || task.status === "queued") throw new ConflictError(`Task is already ${task.status}`);
      expireApprovals(id);
      withdrawQuestion(id);
      endRun(id);
      const queued = update(id, { status: "queued", error: null });
      enqueue(id);
      return queued;
    },

    cancel(id: string): Task | null {
      if (!store.tasks.get(id)) return null;
      stop(id);
      return update(id, { status: "cancelled", nextRunAt: null });
    },

    delete(id: string): boolean {
      stop(id);
      return store.tasks.delete(id);
    },

    /** The owner's answer to `ask_person` becomes the tool result and the run resumes. */
    answer(id: string, text: string): Task | null {
      const task = store.tasks.get(id);
      if (!task) return null;
      const question = store.tasks.question(id);
      const messages = store.tasks.messages(id);
      if (task.status !== "needs_input" || !question || !messages) throw new ConflictError(`Task is ${task.status}, not waiting for an answer`);
      store.tasks.setQuestion(id, null);
      settleQuestion(id, text);
      step(id, `Answered: ${text}`);
      resume(task, withAnswer(messages, question.toolCallId, text));
      return store.tasks.get(id);
    },

    /** Mark a finished (or interrupted) one-shot task resolved. */
    resolve(id: string): Task | null {
      const task = store.tasks.get(id);
      if (!task) return null;
      if (task.status !== "review" && task.status !== "interrupted") throw new ConflictError(`Task is ${task.status}, not ready for review`);
      endRun(id);
      return update(id, { status: "done" });
    },

    /** Record a decision; once every approval of the pause is decided, resume the loop. */
    decide(approvalId: string, decision: z.output<typeof ApprovalDecision>): Approval | null {
      const approval = store.approvals.get(approvalId);
      if (!approval) return null;
      if (approval.status !== "pending") throw new ConflictError(`Approval is already ${approval.status}`);

      const decided = store.approvals.decide(approvalId, decision.approve ? "approved" : "denied", decision.note ?? null);
      bus.emit({ type: "approval", approval: decided });
      settleApproval(decided);
      if (decision.remember) remember(decided, decision.approve);

      const task = store.tasks.get(approval.taskId);
      const messages = store.tasks.messages(approval.taskId);
      if (!task || task.status !== "waiting" || !messages) return decided;

      const open = unansweredApprovalIds(messages);
      const forPause = store.approvals.forTask(task.id).filter((a) => open.has(a.toolApprovalId));
      if (forPause.some((a) => a.status === "pending")) return decided;

      resume(
        task,
        withApprovalResponses(
          messages,
          forPause.map((a) => ({
            toolApprovalId: a.toolApprovalId,
            approved: a.status === "approved",
            reason: store.approvals.note(a.id) ?? undefined,
          })),
        ),
      );
      return decided;
    },

    /** Re-create cron jobs, e.g. after the timezone changed. */
    rescheduleAll() {
      for (const task of store.tasks.list()) {
        if (!task.schedule) continue;
        schedule(task);
        if (task.status === "scheduled") update(task.id, { nextRunAt: nextRun(task.schedule) });
      }
    },

    /**
     * Startup: tasks stopped mid-run resume or become `interrupted`; runs missed while z was down follow
     * the task's missedPolicy; then schedules and the queue.
     */
    start() {
      for (const task of store.tasks.byStatus("running")) recover(task);
      for (const task of store.tasks.list().reverse()) {
        if (task.schedule) {
          catchUp(task);
          schedule(task);
        }
        if (store.tasks.get(task.id)?.status === "queued") enqueue(task.id);
      }
    },

    stopAll() {
      for (const job of jobs.values()) job.stop();
      for (const controller of running.values()) controller.abort();
    },
  };

  /** "Remember" writes the approval policy. External tools never become always-allowed this way. */
  function remember(approval: Approval, approve: boolean) {
    if (approve && approval.risk === "external") return;
    const settings = store.settings.get();
    store.settings.set({ ...settings, approvals: { ...settings.approvals, [approval.tool]: approve ? "allow" : "deny" } });
  }
}

/** Approval ids requested in the conversation that have no response yet. */
function unansweredApprovalIds(messages: ModelMessage[]): Set<string> {
  const open = new Set<string>();
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "tool-approval-request") open.add(part.approvalId);
      if (part.type === "tool-approval-response") open.delete(part.approvalId);
    }
  }
  return open;
}
