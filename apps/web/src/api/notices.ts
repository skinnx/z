import { useMutation, useQuery } from "@tanstack/react-query";
import type { Notice } from "@z/core";
import { api } from "./client.ts";
import { keys, queryClient } from "./query.ts";

export function useNotices() {
  return useQuery({ queryKey: keys.notices, queryFn: () => api<Notice[]>("/notices") });
}

/** Mark read optimistically; all unread when `ids` is omitted. */
export function useMarkRead() {
  return useMutation({
    mutationFn: (ids?: string[]) => api<{ ok: true }>("/notices/read", { body: ids ? { ids } : {} }),
    onMutate: (ids) =>
      queryClient.setQueryData<Notice[]>(keys.notices, (list) => list?.map((n) => (!ids || ids.includes(n.id) ? { ...n, read: true } : n))),
    onError: () => void queryClient.invalidateQueries({ queryKey: keys.notices }),
  });
}
