/**
 * Static markdown (a task's result, a watch finding) through Streamdown, loaded only when one is shown:
 * the renderer and its parser are about 480 KB, which a screen that lists tasks should not wait for.
 * Until it arrives the text shows as written.
 */
import { lazy, Suspense } from "react";

const load = () => import("streamdown");
let loading: Promise<unknown> | null = null;

/** Start loading the renderer (on hover or focus of something that will show markdown). */
export function preloadMarkdown() {
  loading ??= load().catch(() => (loading = null));
}

const Streamdown = lazy(() => load().then((m) => ({ default: m.Streamdown })));

export function Markdown({ children }: { children: string }) {
  return (
    <Suspense fallback={<div className="whitespace-pre-wrap">{children}</div>}>
      <Streamdown mode="static">{children}</Streamdown>
    </Suspense>
  );
}
