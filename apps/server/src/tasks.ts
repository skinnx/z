/** Task queue, recurring schedules and the approval pause/resume cycle. */
import { randomUUID } from "node:crypto";
import { Cron } from "croner";
import {
  deriveTitle,
  runTask,
  withApprovalResponses,
  type Approval,
  type ApprovalDecision,
  type Task,
  type TaskEvent,
  type TaskInput,
} from "@z/core";
import type { ModelMessage } from "ai";
import type { z } from "zod";
import { clip, notify } from "./notify.ts";
import type { Runtime } from "./runtime.ts";
import { nextRunAt } from "./schedule.ts";

const CONCURRENCY = 2;

export class ConflictError extends Error {}

export type Tasks = ReturnType<typeof createTasks>;

export function createTasks(rt: Runtime) {
  const { store, bus } = rt;
  const queue: string[] = [];
  const running = new Map<string, AbortController>();
  const jobs = new Map<string, Cron>();

  const timezone = () => store.settings.get().timezone;

  function emit(id: string): Task | null {
    const task = store.tasks.get(id);
    if (task) bus.emit({ type: "task", task });
    return task;
  }

  function update(id: string, patch: Parameters<typeof store.tasks.update>[1]): Task | null {
    store.tasks.update(id, patch);
    return emit(id);
  }

  function enqueue(id: string) {
    if (!queue.includes(id) && !running.has(id)) queue.push(id);
    pump();
  }

  function pump() {
    while (running.size < CONCURRENCY && queue.length) void execute(queue.shift()!);
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

    try {
      const outcome = await runTask(task, rt.deps(`task:${id.slice(0, 8)}`), {
        messages: store.tasks.messages(id),
        signal: controller.signal,
        onEvent,
      });
      if (controller.signal.aborted || !store.tasks.get(id)) return;

      if (outcome.status === "waiting") {
        store.tasks.setMessages(id, outcome.messages);
        const events: TaskEvent[] = [];
        for (const request of outcome.approvals) {
          const approval: Approval = {
            id: randomUUID(),
            taskId: id,
            ...request,
            status: "pending",
            createdAt: new Date().toISOString(),
            decidedAt: null,
          };
          store.approvals.insert(approval);
          events.push({ type: "approval", at: approval.createdAt, approvalId: approval.id });
          bus.emit({ type: "approval", approval });
          const title = store.tasks.get(id)?.title ?? task.title;
          notify({ kind: "approval", title: `Approval needed · ${clip(title, 80)}`, body: approval.summary, path: "/", approvalId: approval.id });
        }
        store.tasks.appendEvents(id, events);
        update(id, { status: "waiting" });
        return;
      }

      store.tasks.setMessages(id, null);
      if (outcome.status === "done") finish(task, { result: outcome.result, error: null }, "done");
      else finish(task, { error: outcome.error }, "failed");
    } catch (error) {
      store.tasks.setMessages(id, null);
      finish(task, { error: error instanceof Error ? error.message : String(error) }, "failed");
    } finally {
      running.delete(id);
      pump();
    }
  }

  /** One-shot tasks end and tell the owner; recurring ones go back to `scheduled`. */
  function finish(task: Task, patch: { result?: string; error: string | null }, status: "done" | "failed") {
    if (task.schedule) {
      update(task.id, { ...patch, status: "scheduled", nextRunAt: nextRunAt(task.schedule, timezone()) });
      return;
    }
    const done = update(task.id, { ...patch, status, nextRunAt: null });
    notify({
      kind: "task",
      title: `${status === "done" ? "Done" : "Failed"} · ${clip(done?.title ?? task.title, 80)}`,
      body: clip((status === "done" ? patch.result : patch.error) || "", 300),
      path: `/tasks?task=${task.id}`,
    });
  }

  function schedule(task: Task) {
    jobs.get(task.id)?.stop();
    jobs.delete(task.id);
    if (!task.schedule || task.status === "cancelled") return;
    jobs.set(task.id, new Cron(task.schedule, { timezone: timezone(), protect: true }, () => fire(task.id)));
  }

  function fire(id: string) {
    const task = store.tasks.get(id);
    if (!task || !["scheduled", "done", "failed"].includes(task.status)) return;
    update(id, { status: "queued", nextRunAt: nextRunAt(task.schedule!, timezone()) });
    enqueue(id);
  }

  function expireApprovals(taskId: string) {
    for (const approval of store.approvals.expireForTask(taskId)) bus.emit({ type: "approval", approval });
  }

  function stop(id: string) {
    running.get(id)?.abort();
    running.delete(id);
    const i = queue.indexOf(id);
    if (i >= 0) queue.splice(i, 1);
    jobs.get(id)?.stop();
    jobs.delete(id);
    expireApprovals(id);
    store.tasks.setMessages(id, null);
  }

  return {
    create(input: z.output<typeof TaskInput>): Task {
      const at = new Date().toISOString();
      const task: Task = {
        id: randomUUID(),
        title: input.instructions.replace(/\s+/g, " ").trim().slice(0, 60),
        instructions: input.instructions,
        schedule: input.schedule ?? null,
        tools: input.tools ?? null,
        lane: input.lane,
        status: input.schedule ? "scheduled" : "queued",
        result: null,
        error: null,
        events: [],
        nextRunAt: input.schedule ? nextRunAt(input.schedule, timezone()) : null,
        createdAt: at,
        updatedAt: at,
      };
      store.tasks.insert(task);
      bus.emit({ type: "task", task });
      if (task.schedule) schedule(task);
      else enqueue(task.id);

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
      store.tasks.setMessages(id, null);
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

    /** Record a decision; once every approval of the pause is decided, resume the loop. */
    decide(approvalId: string, decision: z.output<typeof ApprovalDecision>): Approval | null {
      const approval = store.approvals.get(approvalId);
      if (!approval) return null;
      if (approval.status !== "pending") throw new ConflictError(`Approval is already ${approval.status}`);

      const decided = store.approvals.decide(approvalId, decision.approve ? "approved" : "denied", decision.note ?? null);
      bus.emit({ type: "approval", approval: decided });
      if (decision.remember) remember(decided, decision.approve);

      const task = store.tasks.get(approval.taskId);
      const messages = store.tasks.messages(approval.taskId);
      if (!task || task.status !== "waiting" || !messages) return decided;

      const open = unansweredApprovalIds(messages);
      const forPause = store.approvals.forTask(task.id).filter((a) => open.has(a.toolApprovalId));
      if (forPause.some((a) => a.status === "pending")) return decided;

      store.tasks.setMessages(
        task.id,
        withApprovalResponses(
          messages,
          forPause.map((a) => ({
            toolApprovalId: a.toolApprovalId,
            approved: a.status === "approved",
            reason: store.approvals.note(a.id) ?? undefined,
          })),
        ),
      );
      update(task.id, { status: "queued" });
      enqueue(task.id);
      return decided;
    },

    /** Re-create cron jobs, e.g. after the timezone changed. */
    rescheduleAll() {
      for (const task of store.tasks.list()) {
        if (!task.schedule) continue;
        schedule(task);
        if (task.status === "scheduled") update(task.id, { nextRunAt: nextRunAt(task.schedule, timezone()) });
      }
    },

    /** Startup: tasks interrupted mid-run go back to the queue. */
    start() {
      for (const task of store.tasks.byStatus("running")) store.tasks.update(task.id, { status: "queued" });
      for (const task of store.tasks.list().reverse()) {
        if (task.schedule) schedule(task);
        if (task.status === "queued") enqueue(task.id);
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
