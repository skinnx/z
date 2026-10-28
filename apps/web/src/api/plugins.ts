import { queryOptions, useMutation, useQuery } from "@tanstack/react-query";
import type { PluginManifest } from "@z/core";
import { api } from "./client.ts";
import { keys, queryClient, upsert } from "./query.ts";

export const pluginsQuery = queryOptions({ queryKey: keys.plugins, queryFn: () => api<PluginManifest[]>("/plugins") });

export function usePlugins() {
  return useQuery(pluginsQuery);
}

export function useSavePlugin() {
  return useMutation({
    mutationFn: ({ id, enabled, settings }: { id: string; enabled: boolean; settings?: Record<string, string> }) =>
      api<PluginManifest>(`/plugins/${encodeURIComponent(id)}`, { method: "PUT", body: { enabled, settings } }),
    onSuccess: (p) => queryClient.setQueryData<PluginManifest[]>(keys.plugins, (list) => upsert(list, p, false)),
  });
}
