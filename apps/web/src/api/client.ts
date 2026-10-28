import { createSignal, createStored } from "../lib/store.ts";
import { isServerText, type ServerText } from "@z/core/messages";

/** Optional bearer token for servers started with Z_TOKEN. */
export const token = createStored<string>("z.token", () => "", (v): v is string => v.length > 0);

/** Set when the server answered 401; the token dialog listens to it. */
export const authRequired = createSignal(false);

/**
 * True while the z server can't be reached: the last request failed to connect, the live stream
 * dropped, or the browser is offline. Any answer from the server clears it. The shell shows one bar for it.
 */
export const unreachable = createSignal(typeof navigator !== "undefined" && navigator.onLine === false);
/** The device itself has no network (as opposed to the z server being down). */
export const deviceOffline = createSignal(typeof navigator !== "undefined" && navigator.onLine === false);
if (typeof window !== "undefined") {
  window.addEventListener("offline", () => {
    deviceOffline.set(true);
    unreachable.set(true);
  });
  window.addEventListener("online", () => deviceOffline.set(false));
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The server's `errorMsg`: the same error as a message key, worded by `errorText`. */
    readonly msg?: ServerText,
  ) {
    super(message);
  }
}

export function authHeaders(): Record<string, string> {
  const tok = token.get();
  return tok ? { Authorization: `Bearer ${tok}` } : {};
}

/** Typed JSON fetch against the z server. Throws ApiError on non-2xx. */
export async function api<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: {
        ...authHeaders(),
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.signal,
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    unreachable.set(true);
    throw new ApiError(0, "offline");
  }
  unreachable.set(false);
  if (res.status === 401) authRequired.set(true);
  const text = await res.text();
  const data: unknown = text ? safeJson(text) : null;
  if (!res.ok) {
    const message =
      data && typeof data === "object" && "error" in data && typeof data.error === "string"
        ? data.error
        : `${res.status} ${res.statusText}`;
    const msg = data && typeof data === "object" && "errorMsg" in data && isServerText(data.errorMsg) ? data.errorMsg : undefined;
    throw new ApiError(res.status, message, msg);
  }
  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** URL for EventSource, which cannot send headers. */
export function eventsUrl(): string {
  const tok = token.get();
  return tok ? `/api/events?token=${encodeURIComponent(tok)}` : "/api/events";
}
