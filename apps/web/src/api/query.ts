import { QueryClient, type QueryKey } from "@tanstack/react-query";
import { notifyError } from "../ui/toast.tsx";
import { ApiError } from "./client.ts";

export const queryClient = new QueryClient({
  defaultOptions: {
    // Always ask the server: when it (or the network) is down the request fails as "offline" and the
    // screen says so, instead of pausing in a spinner until the browser reports it is back online.
    mutations: { networkMode: "always" },
    queries: {
      networkMode: "always",
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
  channelActivity: (id: string) => ["channels", id, "activity"] as const,
  channelSetup: (id: string) => ["channels", id, "setup"] as const,
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

/**
 * Mutation options that show the change at once: `apply` rewrites the cached list before the request
 * goes out; a failure puts the list back, says why in a toast and refetches what the server has.
 * The callbacks live on the mutation, so they run even if the component that started it is gone.
 */
export function optimisticList<T, V>(key: QueryKey, apply: (list: T[], vars: V) => T[]) {
  return {
    onMutate: async (vars: V) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<T[]>(key);
      if (previous) queryClient.setQueryData<T[]>(key, apply(previous, vars));
      return { previous };
    },
    onError: (error: unknown, _vars: V, ctx: { previous?: T[] } | undefined) => {
      if (ctx?.previous) queryClient.setQueryData(key, ctx.previous);
      notifyError(error);
      void queryClient.invalidateQueries({ queryKey: key });
    },
  };
}

/** Insert or replace an item in a cached list, by id. */
export function upsert<T extends { id: string }>(list: T[] | undefined, item: T, prepend = true): T[] {
  if (!list) return [item];
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return prepend ? [item, ...list] : [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}
