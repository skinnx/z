import { useMutation, useQuery } from "@tanstack/react-query";
import type { Memory } from "@z/core";
import { api } from "./client.ts";
import { keys, queryClient, upsert } from "./query.ts";

export function useMemories() {
  return useQuery({ queryKey: keys.memories, queryFn: () => api<Memory[]>("/memories") });
}

const put = (memory: Memory) => queryClient.setQueryData<Memory[]>(keys.memories, (list) => upsert(list, memory));

export function useSaveMemory() {
  return useMutation({
    mutationFn: ({ id, text }: { id?: string; text: string }) =>
      id ? api<Memory>(`/memories/${encodeURIComponent(id)}`, { method: "PUT", body: { text } }) : api<Memory>("/memories", { body: { text } }),
    onSuccess: put,
  });
}

export function useDeleteMemory() {
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`/memories/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: (_, id) => queryClient.setQueryData<Memory[]>(keys.memories, (list) => list?.filter((m) => m.id !== id)),
  });
}

export function useDeleteAllMemories() {
  return useMutation({
    mutationFn: () => api<{ deleted: number }>("/memories", { method: "DELETE" }),
    onSuccess: () => queryClient.setQueryData<Memory[]>(keys.memories, []),
  });
}
