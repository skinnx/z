/** The setup checklist (each row from a real check) and the diagnostics export. */
import { useMutation, useQuery } from "@tanstack/react-query";
import type { SetupChecklist } from "@z/core";
import { api } from "./client.ts";
import { downloadAttachment } from "./data.ts";
import { keys, queryClient } from "./query.ts";

/** Cached results only: the server never calls a model for this. Refetched whenever a screen shows it. */
export function useSetup() {
  return useQuery({ queryKey: keys.setup, queryFn: () => api<SetupChecklist>("/setup"), staleTime: 0 });
}

/** The live checks: a short real call to each lane's model, plus the public URL and failing connections. */
export function useCheckSetup() {
  return useMutation({
    mutationKey: ["setup", "check"],
    mutationFn: () => api<SetupChecklist>("/setup/check", { method: "POST" }),
    onSuccess: (list) => queryClient.setQueryData(keys.setup, list),
  });
}

export function useAckSetup() {
  return useMutation({
    mutationFn: (id: string) => api<SetupChecklist>(`/setup/${encodeURIComponent(id)}/ack`, { method: "POST" }),
    onSuccess: (list) => queryClient.setQueryData(keys.setup, list),
  });
}

/** The diagnostics JSON as text, for the clipboard. */
export function useCopyDiagnostics() {
  return useMutation({
    mutationFn: async () => {
      const data = await api<unknown>("/diagnostics");
      await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
    },
  });
}

export function useDownloadDiagnostics() {
  return useMutation({ mutationFn: () => downloadAttachment("/api/diagnostics", "z-diagnostics") });
}
