import type { LiveEvent } from "@z/core";

export type Bus = {
  emit: (event: LiveEvent) => void;
  subscribe: (listener: (event: LiveEvent) => void) => () => void;
};

export function createBus(): Bus {
  const listeners = new Set<(event: LiveEvent) => void>();
  return {
    emit: (event) => {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (error) {
          console.error("[z] live event listener failed", error);
        }
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
