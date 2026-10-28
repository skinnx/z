/**
 * Speculative work (prefetching chunks the user may need later) waits until the page has loaded and the
 * browser is idle, and is skipped on slow or data-saving connections, where it would compete with what the
 * user is waiting for. Prefetch on hover/focus/touch is not speculative and doesn't go through here.
 */
type Connection = { saveData?: boolean; effectiveType?: string };

export function constrainedNetwork(): boolean {
  const connection = (navigator as Navigator & { connection?: Connection }).connection;
  return Boolean(connection?.saveData || (connection?.effectiveType && /(^|-)(2g|3g)$/.test(connection.effectiveType)));
}

/** Run `task` once the page is loaded and idle; returns a cancel function. Never runs on constrained networks. */
export function whenIdle(task: () => void, timeout = 4000): () => void {
  if (constrainedNetwork()) return () => {};
  let cancelled = false;
  let idleId: number | undefined;
  const schedule = () => {
    if (cancelled) return;
    const run = () => !cancelled && task();
    // Safari has no requestIdleCallback.
    idleId = typeof requestIdleCallback === "function" ? requestIdleCallback(run, { timeout }) : window.setTimeout(run, 1000);
  };
  if (document.readyState === "complete") schedule();
  else window.addEventListener("load", schedule, { once: true });
  return () => {
    cancelled = true;
    window.removeEventListener("load", schedule);
    if (idleId === undefined) return;
    if (typeof cancelIdleCallback === "function") cancelIdleCallback(idleId);
    else window.clearTimeout(idleId);
  };
}
