import { useMutation, useQuery } from "@tanstack/react-query";
import type { Settings } from "@z/core";
import { api } from "./client.ts";
import { keys, queryClient } from "./query.ts";

export function useSettings() {
  return useQuery({ queryKey: keys.settings, queryFn: () => api<Settings>("/settings") });
}

export function useSaveSettings() {
  return useMutation({
    mutationFn: (settings: Settings) => api<Settings>("/settings", { method: "PUT", body: settings }),
    onSuccess: (data) => queryClient.setQueryData(keys.settings, data),
  });
}
