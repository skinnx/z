import { queryOptions, useMutation, useQuery } from "@tanstack/react-query";
import type { Briefing } from "@z/core";
import { api } from "./client.ts";
import { keys, queryClient } from "./query.ts";

export const briefingQuery = queryOptions({ queryKey: keys.briefing, queryFn: () => api<Briefing | null>("/briefing") });

export function useBriefing() {
  return useQuery(briefingQuery);
}

export function useGenerateBriefing() {
  return useMutation({
    mutationFn: () => api<Briefing>("/briefing", { method: "POST" }),
    onSuccess: (b) => queryClient.setQueryData(keys.briefing, b),
  });
}
