import { useSyncExternalStore } from "react";

/** A tiny localStorage-backed value with React subscription. */
export function createStored<T extends string>(key: string, fallback: () => T, valid: (v: string) => v is T) {
  const listeners = new Set<() => void>();
  let value: T = read();

  function read(): T {
    try {
      const v = localStorage.getItem(key);
      if (v !== null && valid(v)) return v;
    } catch {}
    return fallback();
  }

  const store = {
    get: () => value,
    set(next: T | null) {
      value = next ?? fallback();
      try {
        if (next === null) localStorage.removeItem(key);
        else localStorage.setItem(key, next);
      } catch {}
      listeners.forEach((l) => l());
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    use(): T {
      return useSyncExternalStore(store.subscribe, store.get);
    },
  };
  return store;
}

/** An in-memory value with React subscription. */
export function createSignal<T>(initial: T) {
  const listeners = new Set<() => void>();
  let value = initial;
  const signal = {
    get: () => value,
    set(next: T) {
      if (Object.is(next, value)) return;
      value = next;
      listeners.forEach((l) => l());
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    use(): T {
      return useSyncExternalStore(signal.subscribe, signal.get);
    },
  };
  return signal;
}
