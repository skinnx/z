import { useMutation, useQuery } from "@tanstack/react-query";
import type { Settings } from "@z/core";
import { api } from "./client.ts";
import { keys, queryClient } from "./query.ts";

/** `refetchInterval` polls, e.g. while waiting for the owner to pair. */
export function useSettings(refetchInterval?: number) {
  return useQuery({ queryKey: keys.settings, queryFn: () => api<Settings>("/settings"), ...(refetchInterval ? { refetchInterval } : {}) });
}

export function useSaveSettings() {
  return useMutation({
    mutationFn: (settings: Partial<Omit<Settings, "owner">>) => api<Settings>("/settings", { method: "PUT", body: settings }),
    onSuccess: (data) => queryClient.setQueryData(keys.settings, data),
  });
}
