/** Reaching the owner: Web Push on this device, and owner-channel pairing. */
import { useMutation, useQuery } from "@tanstack/react-query";
import type { Settings } from "@z/core";
import { swSupported } from "../lib/pwa.ts";
import { api } from "./client.ts";
import { keys, queryClient } from "./query.ts";

export type PushDevice = { endpoint: string; device: string; createdAt: string };
type PushState = { publicKey: string; devices: PushDevice[] };

/** What this browser can do, and the endpoint it is subscribed with (if any). */
export type ThisDevice =
  | { support: "none"; ios: boolean }
  | { support: "ok"; permission: NotificationPermission; endpoint: string | null };

export function usePush() {
  return useQuery({ queryKey: keys.push, queryFn: () => api<PushState>("/push") });
}

export function useThisDevice() {
  return useQuery({
    queryKey: keys.pushHere,
    staleTime: Infinity,
    queryFn: async (): Promise<ThisDevice> => {
      const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
      if (!swSupported || !("PushManager" in window) || !("Notification" in window)) return { support: "none", ios };
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      return { support: "ok", permission: Notification.permission, endpoint: subscription?.endpoint ?? null };
    },
  });
}

const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: keys.push }), queryClient.invalidateQueries({ queryKey: keys.pushHere })]);

/** Must run from a user gesture: it may show the browser's permission prompt. */
export function useEnablePush() {
  return useMutation({
    mutationFn: async (publicKey: string) => {
      if ((await Notification.requestPermission()) !== "granted") throw new Error("blocked");
      const registration = await navigator.serviceWorker.ready;
      const key = fromBase64Url(publicKey);
      let subscription = await registration.pushManager.getSubscription();
      // A subscription made for an older server key cannot receive our pushes.
      if (subscription && !sameKey(subscription.options.applicationServerKey, key)) {
        await subscription.unsubscribe();
        subscription = null;
      }
      subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      const { keys: subKeys } = subscription.toJSON();
      await api("/push", { body: { endpoint: subscription.endpoint, keys: subKeys, device: deviceName() } });
    },
    onSettled: refresh,
  });
}

export function useDisablePush() {
  return useMutation({
    mutationFn: async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      if (!subscription) return;
      await api("/push", { method: "DELETE", body: { endpoint: subscription.endpoint } });
      await subscription.unsubscribe();
    },
    onSettled: refresh,
  });
}

export function useRemoveDevice() {
  return useMutation({
    mutationFn: (endpoint: string) => api("/push", { method: "DELETE", body: { endpoint } }),
    onSettled: refresh,
  });
}

export function useTestPush() {
  return useMutation({ mutationFn: () => api<{ sent: number }>("/push/test", { method: "POST" }) });
}

export function useLinkOwner() {
  return useMutation({ mutationFn: () => api<{ code: string; expiresAt: string }>("/owner/link", { method: "POST" }) });
}

export function useUnpair() {
  return useMutation({
    mutationFn: () => api<Settings>("/owner", { method: "DELETE" }),
    onSuccess: (data) => queryClient.setQueryData(keys.settings, data),
  });
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function sameKey(a: ArrayBuffer | null, b: Uint8Array): boolean {
  if (!a || a.byteLength !== b.byteLength) return false;
  const bytes = new Uint8Array(a);
  return bytes.every((v, i) => v === b[i]);
}

/** e.g. "Chrome · Android": enough to tell devices apart in the list. */
function deviceName(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Android/.test(ua)
    ? "Android"
    : /iPhone|iPad|iPod/.test(ua)
      ? "iOS"
      : /Mac OS X/.test(ua)
        ? "macOS"
        : /Windows/.test(ua)
          ? "Windows"
          : /Linux|CrOS/.test(ua)
            ? "Linux"
            : "";
  return os ? `${browser} · ${os}` : browser;
}
