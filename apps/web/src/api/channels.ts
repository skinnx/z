import { queryOptions, useMutation, useQuery } from "@tanstack/react-query";
import type { AdapterManifest, ChannelActivity, ChannelInput, ChannelSetupStep, ChannelTestResult, ChannelView } from "@z/core";
import { api } from "./client.ts";
import { keys, queryClient, upsert } from "./query.ts";

export const adaptersQuery = queryOptions({ queryKey: keys.adapters, queryFn: () => api<AdapterManifest[]>("/adapters"), staleTime: Infinity });

export function useAdapters() {
  return useQuery(adaptersQuery);
}

export const channelsQuery = queryOptions({ queryKey: keys.channels, queryFn: () => api<ChannelView[]>("/channels") });

export function useChannels() {
  return useQuery(channelsQuery);
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

/** The channel's activity log; refreshed by `channelActivity` live events. */
export function useChannelActivity(id: string) {
  return useQuery({ queryKey: keys.channelActivity(id), queryFn: () => api<ChannelActivity[]>(`/channels/${encodeURIComponent(id)}/activity`) });
}

/** The platform's next steps, checked live; re-checked every 15 s while shown. */
export function useChannelSetup(id: string) {
  return useQuery({
    queryKey: keys.channelSetup(id),
    queryFn: () => api<ChannelSetupStep[]>(`/channels/${encodeURIComponent(id)}/setup`),
    refetchInterval: 15_000,
  });
}

/** "Send a test": the server signs the message and runs it through the channel's webhook. */
export function useTestChannel(id: string) {
  return useMutation({
    mutationFn: (text: string) => api<ChannelTestResult>(`/channels/${encodeURIComponent(id)}/test`, { method: "POST", body: { text } }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: keys.channelActivity(id) });
      void queryClient.invalidateQueries({ queryKey: keys.channelSetup(id) });
    },
  });
}
