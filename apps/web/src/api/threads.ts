import { queryOptions, useMutation, useQuery } from "@tanstack/react-query";
import type { UIMessage } from "ai";
import { api, ApiError } from "./client.ts";
import { keys, queryClient } from "./query.ts";

export type ThreadSummary = { id: string; title: string; updatedAt: string };
export type Thread = { id: string; title: string; messages: UIMessage[] };

export const threadsQuery = queryOptions({ queryKey: keys.threads, queryFn: () => api<ThreadSummary[]>("/threads") });

export function useThreads() {
  return useQuery(threadsQuery);
}

async function fetchThread(id: string): Promise<Thread> {
  try {
    return await api<Thread>(`/threads/${encodeURIComponent(id)}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return { id, title: "", messages: [] } satisfies Thread;
    throw e;
  }
}

/**
 * Threads requested before their screen mounts (on navigation, while the chat chunk loads). The
 * thread query keeps nothing once unmounted (`gcTime: 0`), so an early answer waits here for the
 * next fetch of that thread to take it, and is dropped if nothing does soon.
 */
const early = new Map<string, Promise<Thread>>();
const EARLY_MS = 10_000;

export function prefetchThread(id: string) {
  if (early.has(id) || queryClient.getQueryState(keys.thread(id))) return;
  const promise = fetchThread(id);
  promise.catch(() => {});
  early.set(id, promise);
  setTimeout(() => early.get(id) === promise && early.delete(id), EARLY_MS);
}

/** A thread's messages; an unknown id is a new, empty thread. */
export function useThread(id: string, fetchFromServer = true) {
  return useQuery({
    queryKey: keys.thread(id),
    ...(fetchFromServer ? {} : { initialData: { id, title: "", messages: [] } satisfies Thread }),
    queryFn: () => {
      const pending = early.get(id);
      early.delete(id);
      return pending ?? fetchThread(id);
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

export function useDeleteAllThreads() {
  return useMutation({
    mutationFn: () => api<{ deleted: number }>("/threads", { method: "DELETE" }),
    onSuccess: () => {
      queryClient.setQueryData<ThreadSummary[]>(keys.threads, []);
      // An open chat refetches and comes back empty.
      void queryClient.invalidateQueries({ queryKey: ["thread"] });
    },
  });
}
