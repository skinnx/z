/** Service worker registration, and the bits of page state the worker needs (src/sw.js). */
import { token } from "../api/client.ts";
import { locale } from "../i18n.ts";

/** The worker only exists in builds (vite.config.ts emits it). */
export const swSupported = import.meta.env.PROD && typeof navigator !== "undefined" && "serviceWorker" in navigator;

/** Mirror a value into IndexedDB `z/kv`, where the worker reads the token for Approve / Deny. */
function idbSet(key: string, value: string | null) {
  try {
    const open = indexedDB.open("z", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("kv");
    open.onsuccess = () => {
      const store = open.result.transaction("kv", "readwrite").objectStore("kv");
      if (value) store.put(value, key);
      else store.delete(key);
    };
  } catch {}
}

/** Register the worker; `navigate` handles a notification click while the app is open. */
export function startPwa(navigate: (path: string) => void) {
  if (!swSupported) return;
  // Its install downloads the whole app: let the first screen have the connection first.
  const register = () => void navigator.serviceWorker.register("/sw.js").catch((error) => console.error("[z] service worker", error));
  const idle = () => ("requestIdleCallback" in window ? requestIdleCallback(register, { timeout: 5000 }) : setTimeout(register, 1000));
  if (navigator.serviceWorker.controller || document.readyState === "complete") register();
  else window.addEventListener("load", idle, { once: true });
  navigator.serviceWorker.addEventListener("message", (event: MessageEvent<{ type?: string; path?: string }>) => {
    if (event.data?.type === "navigate" && event.data.path?.startsWith("/")) navigate(event.data.path);
  });
  const sync = () => {
    idbSet("token", token.get() || null);
    idbSet("lang", locale.get());
  };
  sync();
  token.subscribe(sync);
  locale.subscribe(sync);
}
