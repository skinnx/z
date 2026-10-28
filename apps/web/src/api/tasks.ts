import { useMutation, useQuery } from "@tanstack/react-query";
import type { Task, TaskAnswer, TaskInput } from "@z/core";
import { notifyError } from "../ui/toast.tsx";
import { api } from "./client.ts";
import { keys, optimisticList, queryClient, upsert } from "./query.ts";

export function useTasks() {
  return useQuery({ queryKey: keys.tasks, queryFn: () => api<Task[]>("/tasks") });
}

const put = (task: Task) => queryClient.setQueryData<Task[]>(keys.tasks, (list) => upsert(list, task));

/** Ids of tasks shown before the server has them (a delegation in flight). */
export const isPendingTask = (task: Pick<Task, "id">) => task.id.startsWith(PENDING_PREFIX);
const PENDING_PREFIX = "pending:";

/** A delegation as it will look, until the server answers with the real task (its title comes later). */
function pendingTask(input: TaskInput): Task {
  const now = new Date().toISOString();
  const firstLine = input.instructions.trim().split("\n")[0] ?? "";
  return {
    id: `${PENDING_PREFIX}${crypto.randomUUID()}`,
    title: firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine,
    instructions: input.instructions,
    schedule: input.schedule ?? null,
    tools: input.tools ?? null,
    lane: input.lane ?? "agent",
    mode: input.mode ?? "do",
    status: input.schedule || input.mode === "watch" ? "scheduled" : "queued",
    result: null,
    error: null,
    events: [],
    nextRunAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** The task shows up at once (Today's "Working on", the task list); a failure takes it back out and toasts. */
export function useCreateTask() {
  return useMutation({
    mutationFn: (input: TaskInput) => api<Task>("/tasks", { body: input }),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: keys.tasks });
      const pending = pendingTask(input);
      queryClient.setQueryData<Task[]>(keys.tasks, (list) => (list ? [pending, ...list] : list));
      return { pendingId: pending.id };
    },
    onSuccess: (task, _input, ctx) => queryClient.setQueryData<Task[]>(keys.tasks, (list) => upsert(list?.filter((x) => x.id !== ctx.pendingId), task)),
    onError: (error, _input, ctx) => {
      queryClient.setQueryData<Task[]>(keys.tasks, (list) => list?.filter((x) => x.id !== ctx?.pendingId));
      notifyError(error);
    },
  });
}

export function useTaskAction() {
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: "run" | "cancel" | "resolve" }) =>
      api<Task>(`/tasks/${encodeURIComponent(id)}/${action}`, { method: "POST" }),
    onSuccess: put,
  });
}

export function useAnswerTask() {
  return useMutation({
    mutationFn: ({ id, text }: { id: string; text: string }) =>
      api<Task>(`/tasks/${encodeURIComponent(id)}/answer`, { body: { text } satisfies TaskAnswer }),
    onSuccess: put,
  });
}

export function useDeleteTask() {
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`/tasks/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: (_, id) => queryClient.setQueryData<Task[]>(keys.tasks, (list) => list?.filter((t) => t.id !== id)),
  });
}
