import { useMutation, useQuery } from "@tanstack/react-query";
import type { Lane, ModelRef, ProviderInput, ProviderSaveResult, ProviderTestResult, ProviderView, Routing } from "@z/core";
import { createSignal } from "../lib/store.ts";
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

/** The last live check per provider (on save or Test), so cards and the form say "Key rejected" until one passes. */
const lastChecks = createSignal<Record<string, ProviderTestResult>>({});
const rememberCheck = (id: string, check: ProviderTestResult) => lastChecks.set({ ...lastChecks.get(), [id]: check });

export function useProviderCheck(id: string | null): ProviderTestResult | undefined {
  const all = lastChecks.use();
  return id ? all[id] : undefined;
}

/** A definite "no" (bad key, unknown model), as opposed to rate limited or slow. */
export const checkFailed = (c: ProviderTestResult | undefined) => Boolean(c && !c.ok && !c.rateLimited && !c.timedOut);

/**
 * Save and check live: the server tests the key with a short timeout, picks models when none are
 * listed and fills every empty lane when the provider answered (or was only rate limited).
 */
export function useSaveCheckedProvider() {
  return useMutation({
    mutationFn: (input: ProviderInput) =>
      api<ProviderSaveResult>(`/providers/${encodeURIComponent(input.id)}?check=1`, { method: "PUT", body: input }),
    onSuccess: (p) => {
      const { check: _check, filledLanes: _filled, ...view } = p;
      queryClient.setQueryData<ProviderView[]>(keys.providers, (list) => upsert(list, view, false));
      if (p.check) rememberCheck(p.id, p.check);
      void queryClient.invalidateQueries({ queryKey: keys.providerModels(p.id) });
      void queryClient.invalidateQueries({ queryKey: keys.routing });
      void queryClient.invalidateQueries({ queryKey: keys.setup });
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

export type ProviderTest = ProviderTestResult;

export function useTestProvider() {
  return useMutation({
    mutationFn: (id: string) => api<ProviderTest>(`/providers/${encodeURIComponent(id)}/test`, { method: "POST" }),
    onSuccess: (result, id) => rememberCheck(id, result),
    // A test is a live check: the setup checklist reflects it.
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.setup }),
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
