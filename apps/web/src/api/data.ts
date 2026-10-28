/** Data controls: export, and whether the server is locked with a token. */
import { useMutation, useQuery } from "@tanstack/react-query";
import { ApiError, authHeaders } from "./client.ts";

/** Downloads `GET /api/export` (bearer included) as the file the server names. `onProgress` gets bytes received. */
export function useExportData(onProgress?: (bytes: number) => void) {
  return useMutation({
    mutationFn: async () => {
      let res: Response;
      try {
        res = await fetch("/api/export", { headers: authHeaders() });
      } catch {
        throw new ApiError(0, "offline");
      }
      if (!res.ok) throw new ApiError(res.status, `${res.status} ${res.statusText}`);
      const disposition = res.headers.get("content-disposition") ?? "";
      const name = /filename="?([^";]+)"?/.exec(disposition)?.[1] ?? `z-export-${new Date().toISOString().slice(0, 10)}.json`;
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      let bytes = 0;
      const reader = res.body?.getReader();
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          bytes += value.byteLength;
          onProgress?.(bytes);
        }
      }
      const blob = new Blob(chunks, { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      return { name, bytes: blob.size };
    },
  });
}

/** Asks the server without credentials: a 401 means it was started with Z_TOKEN. */
export function useTokenRequired() {
  return useQuery({
    queryKey: ["auth-probe"],
    staleTime: Infinity,
    retry: false,
    queryFn: async () => {
      let res: Response;
      try {
        res = await fetch("/api/health");
      } catch {
        throw new ApiError(0, "offline");
      }
      if (res.status === 401) return true;
      if (!res.ok) throw new ApiError(res.status, `${res.status} ${res.statusText}`);
      return false;
    },
  });
}
