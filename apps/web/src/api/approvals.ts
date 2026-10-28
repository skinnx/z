import { useMutation, useQuery } from "@tanstack/react-query";
import type { Approval, ApprovalDecision, Notice } from "@z/core";
import { api } from "./client.ts";
import { keys, optimisticList, queryClient } from "./query.ts";

export function usePendingApprovals() {
  return useQuery({
    queryKey: keys.approvals,
    queryFn: () => api<Approval[]>("/approvals?status=pending"),
  });
}

/** The card leaves at once; a failure brings it back with a toast (decided elsewhere: the refetch shows it). */
export function useDecide() {
  return useMutation({
    ...optimisticList<Approval, { id: string }>(keys.approvals, (list, { id }) => list.filter((x) => x.id !== id)),
    mutationFn: ({ id, decision }: { id: string; decision: ApprovalDecision }) =>
      api<Approval>(`/approvals/${encodeURIComponent(id)}`, { body: decision }),
    onSuccess: (a, { decision }) => {
      queryClient.setQueryData<Approval[]>(keys.approvals, (list) => list?.filter((x) => x.id !== a.id));
      // Its notices show the outcome and stop counting as unread (the server streams the same).
      queryClient.setQueryData<Notice[]>(keys.notices, (list) =>
        list?.map((n) => (n.approvalId === a.id ? { ...n, approvalStatus: a.status, read: true } : n)),
      );
      if (decision.remember) void queryClient.invalidateQueries({ queryKey: keys.settings });
      void queryClient.invalidateQueries({ queryKey: keys.tasks });
    },
  });
}
