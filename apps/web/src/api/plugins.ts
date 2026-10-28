import { useMutation, useQuery } from "@tanstack/react-query";
import type { PluginManifest } from "@z/core";
import { api } from "./client.ts";
import { keys, optimisticList, queryClient, upsert } from "./query.ts";

export function usePlugins() {
  return useQuery({ queryKey: keys.plugins, queryFn: () => api<PluginManifest[]>("/plugins") });
}

/** Shown at once (the switch flips); rolled back with a toast on failure. */
export function useSavePlugin() {
  return useMutation({
    ...optimisticList<PluginManifest, { id: string; enabled: boolean }>(keys.plugins, (list, { id, enabled }) =>
      list.map((p) => (p.id === id ? { ...p, enabled } : p)),
    ),
    mutationFn: ({ id, enabled, settings }: { id: string; enabled: boolean; settings?: Record<string, string> }) =>
      api<PluginManifest>(`/plugins/${encodeURIComponent(id)}`, { method: "PUT", body: { enabled, settings } }),
    onSuccess: (p) => queryClient.setQueryData<PluginManifest[]>(keys.plugins, (list) => upsert(list, p, false)),
  });
}
