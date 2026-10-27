import { useMutation, useQuery } from "@tanstack/react-query";
import type { UIMessage } from "ai";
import { api, ApiError } from "./client.ts";
import { keys, queryClient } from "./query.ts";

export type ThreadSummary = { id: string; title: string; updatedAt: string };
export type Thread = { id: string; title: string; messages: UIMessage[] };

export function useThreads() {
  return useQuery({ queryKey: keys.threads, queryFn: () => api<ThreadSummary[]>("/threads") });
}

/** A thread's messages; an unknown id is a new, empty thread. */
export function useThread(id: string, fetchFromServer = true) {
  return useQuery({
    queryKey: keys.thread(id),
    ...(fetchFromServer ? {} : { initialData: { id, title: "", messages: [] } satisfies Thread }),
    queryFn: async () => {
      try {
        return await api<Thread>(`/threads/${encodeURIComponent(id)}`);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return { id, title: "", messages: [] } satisfies Thread;
        throw e;
      }
    },
    staleTime: Infinity,
    gcTime: 0,
  });
}

export function useDeleteThread() {
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`/threads/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: (_, id) =>
      queryClient.setQueryData<ThreadSummary[]>(keys.threads, (list) => list?.filter((t) => t.id !== id)),
  });
}
