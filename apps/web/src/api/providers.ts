import { useMutation, useQuery } from "@tanstack/react-query";
import type { Lane, ModelRef, ProviderInput, ProviderView, Routing } from "@z/core";
import { api } from "./client.ts";
import { keys, queryClient, upsert } from "./query.ts";

export function useProviders() {
  return useQuery({ queryKey: keys.providers, queryFn: () => api<ProviderView[]>("/providers") });
}

export function useSaveProvider() {
  return useMutation({
    mutationFn: (input: ProviderInput) =>
      api<ProviderView>(`/providers/${encodeURIComponent(input.id)}`, { method: "PUT", body: input }),
    onSuccess: (p) => {
      queryClient.setQueryData<ProviderView[]>(keys.providers, (list) => upsert(list, p, false));
      void queryClient.invalidateQueries({ queryKey: keys.providerModels(p.id) });
    },
  });
}

export function useDeleteProvider() {
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`/providers/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: (_, id) => {
      queryClient.setQueryData<ProviderView[]>(keys.providers, (list) => list?.filter((p) => p.id !== id));
      void queryClient.invalidateQueries({ queryKey: keys.routing });
    },
  });
}

export type ProviderTest = { ok: boolean; model?: string; latencyMs?: number; error?: string };

export function useTestProvider() {
  return useMutation({
    mutationFn: (id: string) => api<ProviderTest>(`/providers/${encodeURIComponent(id)}/test`, { method: "POST" }),
  });
}

/** Live model list from the provider (when it supports listing). */
export function useProviderModels(id: string | null) {
  return useQuery({
    queryKey: keys.providerModels(id ?? ""),
    queryFn: () => api<{ models: string[] }>(`/providers/${encodeURIComponent(id ?? "")}/models`),
    enabled: !!id,
    staleTime: 10 * 60_000,
    retry: false,
    select: (d) => d.models,
  });
}

/** Every `providerId:model` ref from enabled providers' configured models. */
export function useModelRefs(): ModelRef[] {
  const { data } = useProviders();
  return (data ?? []).filter((p) => p.enabled).flatMap((p) => p.models.map((m) => `${p.id}:${m}`));
}

export function useRouting() {
  return useQuery({ queryKey: keys.routing, queryFn: () => api<Routing>("/routing") });
}

export function useSaveRouting() {
  return useMutation({
    mutationFn: (routing: Routing) => api<Routing>("/routing", { method: "PUT", body: routing }),
    onMutate: async (routing) => {
      await queryClient.cancelQueries({ queryKey: keys.routing });
      const previous = queryClient.getQueryData<Routing>(keys.routing);
      queryClient.setQueryData(keys.routing, routing);
      return { previous };
    },
    onError: (_e, _v, ctx) => queryClient.setQueryData(keys.routing, ctx?.previous),
    onSuccess: (data) => queryClient.setQueryData(keys.routing, data),
  });
}

export const LANES = ["chat", "agent", "briefing", "bot", "fast"] as const satisfies readonly Lane[];
