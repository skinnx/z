import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./client.ts";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
    },
  },
});

export const keys = {
  settings: ["settings"] as const,
  providers: ["providers"] as const,
  providerModels: (id: string) => ["providers", id, "models"] as const,
  routing: ["routing"] as const,
  tasks: ["tasks"] as const,
  approvals: ["approvals", "pending"] as const,
  briefing: ["briefing"] as const,
  adapters: ["adapters"] as const,
  channels: ["channels"] as const,
  plugins: ["plugins"] as const,
  push: ["push"] as const,
  pushHere: ["push", "here"] as const,
  threads: ["threads"] as const,
  notices: ["notices"] as const,
  memories: ["memories"] as const,
  skills: ["skills"] as const,
  /** Without `q`: every search, for invalidation. */
  memorySearch: (q?: string) => (q === undefined ? (["memories", "search"] as const) : (["memories", "search", q] as const)),
  connectors: ["connectors"] as const,
  connectorPresets: ["connector-presets"] as const,
  setup: ["setup"] as const,
  thread: (id: string) => ["thread", id] as const,
};

/** Insert or replace an item in a cached list, by id. */
export function upsert<T extends { id: string }>(list: T[] | undefined, item: T, prepend = true): T[] {
  if (!list) return [item];
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return prepend ? [item, ...list] : [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}
