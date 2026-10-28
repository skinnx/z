import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import type { Memory } from "@z/core";
import { api } from "./client.ts";
import { keys, optimisticList, queryClient, upsert } from "./query.ts";

export function useMemories() {
  return useQuery({ queryKey: keys.memories, queryFn: () => api<Memory[]>("/memories") });
}

/** Server full-text search, best match first. Idle while `q` is blank. */
export function useMemorySearch(q: string) {
  return useQuery({
    queryKey: keys.memorySearch(q),
    queryFn: () => api<Memory[]>(`/memories?q=${encodeURIComponent(q)}`),
    enabled: q.length > 0,
    placeholderData: keepPreviousData,
  });
}

const put = (memory: Memory) => {
  queryClient.setQueryData<Memory[]>(keys.memories, (list) => upsert(list, memory));
  void queryClient.invalidateQueries({ queryKey: keys.memorySearch() });
};

export function useSaveMemory() {
  return useMutation({
    mutationFn: ({ id, text }: { id?: string; text: string }) =>
      id ? api<Memory>(`/memories/${encodeURIComponent(id)}`, { method: "PUT", body: { text } }) : api<Memory>("/memories", { body: { text } }),
    onSuccess: put,
  });
}

export function useConfirmMemory() {
  return useMutation({
    ...optimisticList<Memory, string>(keys.memories, (list, id) => list.map((m) => (m.id === id ? { ...m, status: "active" as const } : m))),
    mutationFn: (id: string) => api<Memory>(`/memories/${encodeURIComponent(id)}/confirm`, { method: "POST" }),
    onSuccess: put,
  });
}

export function usePinMemory() {
  return useMutation({
    ...optimisticList<Memory, { id: string; pinned: boolean }>(keys.memories, (list, { id, pinned }) => list.map((m) => (m.id === id ? { ...m, pinned } : m))),
    mutationFn: ({ id, pinned }: { id: string; pinned: boolean }) => api<Memory>(`/memories/${encodeURIComponent(id)}/pin`, { body: { pinned } }),
    onSuccess: put,
  });
}

export function useDeleteMemory() {
  return useMutation({
    ...optimisticList<Memory, string>(keys.memories, (list, id) => list.filter((m) => m.id !== id)),
    mutationFn: (id: string) => api<{ ok: true }>(`/memories/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: (_, id) => {
      queryClient.setQueryData<Memory[]>(keys.memories, (list) => list?.filter((m) => m.id !== id));
      void queryClient.invalidateQueries({ queryKey: keys.memorySearch() });
    },
  });
}

export function useDeleteAllMemories() {
  return useMutation({
    mutationFn: () => api<{ deleted: number }>("/memories", { method: "DELETE" }),
    onSuccess: () => {
      queryClient.setQueryData<Memory[]>(keys.memories, []);
      void queryClient.invalidateQueries({ queryKey: keys.memorySearch() });
    },
  });
}
