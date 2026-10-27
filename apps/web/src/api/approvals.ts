import { useMutation, useQuery } from "@tanstack/react-query";
import type { Approval, ApprovalDecision } from "@z/core";
import { api } from "./client.ts";
import { keys, queryClient } from "./query.ts";

export function usePendingApprovals() {
  return useQuery({
    queryKey: keys.approvals,
    queryFn: () => api<Approval[]>("/approvals?status=pending"),
  });
}

export function useDecide() {
  return useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: ApprovalDecision }) =>
      api<Approval>(`/approvals/${encodeURIComponent(id)}`, { body: decision }),
    onSuccess: (a, { decision }) => {
      queryClient.setQueryData<Approval[]>(keys.approvals, (list) => list?.filter((x) => x.id !== a.id));
      if (decision.remember) void queryClient.invalidateQueries({ queryKey: keys.settings });
      void queryClient.invalidateQueries({ queryKey: keys.tasks });
    },
  });
}
