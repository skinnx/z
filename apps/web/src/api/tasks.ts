import { useMutation, useQuery } from "@tanstack/react-query";
import type { Task, TaskAnswer, TaskInput } from "@z/core";
import { api } from "./client.ts";
import { keys, queryClient, upsert } from "./query.ts";

export function useTasks() {
  return useQuery({ queryKey: keys.tasks, queryFn: () => api<Task[]>("/tasks") });
}

const put = (task: Task) => queryClient.setQueryData<Task[]>(keys.tasks, (list) => upsert(list, task));

export function useCreateTask() {
  return useMutation({
    mutationFn: (input: TaskInput) => api<Task>("/tasks", { body: input }),
    onSuccess: put,
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
