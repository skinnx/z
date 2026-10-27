import { useMutation, useQuery } from "@tanstack/react-query";
import type { AdapterManifest, ChannelInput, ChannelView } from "@z/core";
import { api } from "./client.ts";
import { keys, queryClient, upsert } from "./query.ts";

export function useAdapters() {
  return useQuery({ queryKey: keys.adapters, queryFn: () => api<AdapterManifest[]>("/adapters"), staleTime: Infinity });
}

export function useChannels() {
  return useQuery({ queryKey: keys.channels, queryFn: () => api<ChannelView[]>("/channels") });
}

export function useSaveChannel() {
  return useMutation({
    mutationFn: (input: ChannelInput) =>
      api<ChannelView>(`/channels/${encodeURIComponent(input.id)}`, { method: "PUT", body: input }),
    onSuccess: (c) => queryClient.setQueryData<ChannelView[]>(keys.channels, (list) => upsert(list, c, false)),
  });
}

export function useDeleteChannel() {
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`/channels/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: (_, id) =>
      queryClient.setQueryData<ChannelView[]>(keys.channels, (list) => list?.filter((c) => c.id !== id)),
  });
}
