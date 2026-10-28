/** The one offline/error path: a bar while the server can't be reached, and the view for a screen that failed to load. */
import { CloudOff, RotateCw } from "lucide-react";
import { Component, type ReactNode } from "react";
import { useRouteError } from "react-router";
import { unreachable } from "../api/client.ts";
import { queryClient } from "../api/query.ts";
import { useT } from "../i18n.ts";
import { Button } from "../ui/button.tsx";
import { LoadError } from "../ui/card.tsx";

/** Shown above every screen while the z server can't be reached; it clears itself on the next answer. */
export function OfflineBar() {
  const t = useT();
  const down = unreachable.use();
  if (!down) return null;
  return (
    <div role="status" className="sticky top-0 z-20 flex items-center gap-3 border-b border-warn/40 bg-warn-soft px-4 py-2 text-sm text-fg">
      <CloudOff aria-hidden className="size-4 shrink-0 text-warn" />
      <p className="min-w-0 flex-1">{t.offline}</p>
      <Button size="sm" onClick={() => void queryClient.refetchQueries({ type: "active" })}>
        <RotateCw aria-hidden />
        {t.retry}
      </Button>
    </div>
  );
}

const CHUNK_ERROR = /dynamically imported module|Importing a module script failed|error loading dynamically imported|Loading (CSS )?chunk|Unable to preload CSS/i;
const RELOADED_KEY = "z.chunk-reloaded";

/** A screen's code failed to load (offline, or the app was updated and the old chunk is gone). */
export function isChunkError(error: unknown): boolean {
  return error instanceof Error && CHUNK_ERROR.test(error.message);
}

/**
 * After a redeploy the old chunks are gone: reload once to pick up the new build. Not when offline
 * (a reload would only lose the app shell), and never twice in a row.
 */
function reloadOnce(error: unknown): boolean {
  if (!isChunkError(error) || navigator.onLine === false) return false;
  try {
    const last = Number(sessionStorage.getItem(RELOADED_KEY) ?? 0);
    if (Date.now() - last < 30_000) return false;
    sessionStorage.setItem(RELOADED_KEY, String(Date.now()));
  } catch {
    return false;
  }
  location.reload();
  return true;
}

function FailedView({ error, className = "mx-auto w-full max-w-4xl px-4 py-6 md:px-8 md:py-10" }: { error: unknown; className?: string }) {
  const t = useT();
  const message = isChunkError(error) ? (navigator.onLine === false ? t.offline : t.screenFailed) : error;
  return (
    <div className={className}>
      <LoadError error={message} onRetry={() => location.reload()} retryLabel={t.reload} />
    </div>
  );
}

/** Route `errorElement`: renders inside the shell, so navigation keeps working. */
export function RouteError() {
  const error = useRouteError();
  if (reloadOnce(error)) return null;
  return <FailedView error={error} />;
}

/** The root's `errorElement`, for when the shell itself fails: the same view, centred on the page. */
export function RootError() {
  const error = useRouteError();
  if (reloadOnce(error)) return null;
  return <FailedView error={error} className="mx-auto grid min-h-dvh w-full max-w-xl place-items-center px-4" />;
}

/** For lazily loaded pieces outside the router's own boundaries (the settings panels). */
export class LoadBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  state: { error: unknown } = { error: null };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  componentDidCatch(error: unknown) {
    if (!isChunkError(error)) console.error(error);
  }
  render() {
    if (this.state.error === null) return this.props.children;
    if (reloadOnce(this.state.error)) return null;
    return <FailedView error={this.state.error} className="m-auto w-full max-w-md p-5" />;
  }
}
