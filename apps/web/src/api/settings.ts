import { queryOptions, useMutation, useQuery } from "@tanstack/react-query";
import type { Settings } from "@z/core";
import { useEffect, useRef, useState } from "react";
import { notifyError } from "../ui/toast.tsx";
import { api } from "./client.ts";
import { keys, queryClient } from "./query.ts";

/** `refetchInterval` polls, e.g. while waiting for the owner to pair. */
export const settingsQuery = queryOptions({ queryKey: keys.settings, queryFn: () => api<Settings>("/settings") });

export function useSettings(refetchInterval?: number) {
  return useQuery({ ...settingsQuery, ...(refetchInterval ? { refetchInterval } : {}) });
}

const selectApprovals = (s: Settings) => s.approvals;

/** Just the per-tool approval choices: re-renders when they change, not on every other setting. */
export function useApprovalPolicies() {
  return useQuery({ ...settingsQuery, select: selectApprovals }).data;
}

export type SettingsPatch = Partial<Omit<Settings, "owner">>;
const saveKey = ["settings", "save"] as const;

/**
 * Save part of the settings right away: the cache shows it at once, a failure puts back only the
 * fields this patch touched and toasts. `saved` stays true for 1.5 s after the server confirms.
 */
export function useSaveSetting() {
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const mutation = useMutation({
    mutationKey: saveKey,
    mutationFn: (patch: SettingsPatch) => api<Settings>("/settings", { method: "PUT", body: patch }),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: keys.settings });
      const previous = queryClient.getQueryData<Settings>(keys.settings);
      if (previous) queryClient.setQueryData<Settings>(keys.settings, { ...previous, ...patch });
      return { previous };
    },
    onError: (error, patch, ctx) => {
      const previous = ctx?.previous;
      if (previous) {
        const undo = Object.fromEntries(Object.keys(patch).map((k) => [k, previous[k as keyof Settings]]));
        queryClient.setQueryData<Settings>(keys.settings, (cur) => (cur ? { ...cur, ...undo } : previous));
      }
      notifyError(error);
    },
    onSuccess: (data) => {
      // A later save still in flight wins: don't flash its optimistic value back.
      if (queryClient.isMutating({ mutationKey: saveKey }) <= 1) queryClient.setQueryData(keys.settings, data);
      setSaved(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setSaved(false), 1500);
    },
  });
  return { save: mutation.mutate, saved, pending: mutation.isPending };
}
