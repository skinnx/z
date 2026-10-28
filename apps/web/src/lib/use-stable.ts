import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * A callback whose identity never changes but which always runs the latest closure, so memoised
 * children that receive it don't re-render when the parent does. Call it from events, not render.
 */
export function useStable<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const latest = useRef(fn);
  useLayoutEffect(() => {
    latest.current = fn;
  });
  return useCallback((...args: A) => latest.current(...args), []);
}
