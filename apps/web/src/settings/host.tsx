/** Mounted once in the shell: the settings dialog (drawer on phones) and its keyboard shortcut. */
import { Dialog } from "@base-ui/react/dialog";
import { Drawer } from "@base-ui/react/drawer";
import { useMediaQuery } from "@base-ui/react/unstable-use-media-query";
import { lazy, Suspense, useEffect, useId, useRef } from "react";
import { useT } from "../i18n.ts";
import { backdropClass } from "../ui/dialog.tsx";
import { Loading } from "../ui/card.tsx";
import { settingsOpener, useSettingsRoute } from "./route.ts";

const SettingsBody = lazy(() => import("./body.tsx"));

const PHONE_QUERY = "(max-width: 639px)";

export function SettingsHost() {
  const t = useT();
  const route = useSettingsRoute();
  const phone = useMediaQuery(PHONE_QUERY, { noSsr: true });
  const titleId = useId();
  const popup = useRef<HTMLDivElement>(null);
  const routeRef = useRef(route);
  routeRef.current = route;

  // Fetch the panels while idle so the first open has no spinner.
  useEffect(() => {
    const id = setTimeout(() => void import("./body.tsx"), 1500);
    return () => clearTimeout(id);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key === ",") {
        e.preventDefault();
        const r = routeRef.current;
        if (r.isOpen) r.close();
        else r.open();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onOpenChange = (open: boolean) => {
    if (!open) route.close();
  };
  // The popup takes focus first; the body then hands it to the active tab once the tab list has
  // registered its items (focusing a tab earlier breaks arrow-key navigation). Touch doesn't move focus.
  const initialFocus = (type: string) => (type === "touch" ? false : (popup.current ?? true));
  const finalFocus = () => settingsOpener() ?? true;

  const body = (
    <Suspense fallback={<Loading label={t.loading} className="h-full" />}>
      <SettingsBody phone={phone} titleId={titleId} />
    </Suspense>
  );

  if (phone) {
    return (
      <Drawer.Root open={route.isOpen} onOpenChange={onOpenChange} swipeDirection="down">
        <Drawer.Portal>
          <Drawer.Backdrop className="fixed inset-0 z-40 bg-black/40 opacity-[calc(1-var(--drawer-swipe-progress,0))] transition-opacity duration-300 data-swiping:duration-0 data-starting-style:opacity-0 data-ending-style:opacity-0" />
          <Drawer.Viewport className="fixed inset-0 z-50 flex items-end">
            <Drawer.Popup
              ref={popup}
              aria-labelledby={titleId}
              initialFocus={initialFocus}
              finalFocus={finalFocus}
              className="flex h-[calc(100dvh-env(safe-area-inset-top)-0.5rem)] w-full flex-col overflow-hidden rounded-t-2xl border-t border-line bg-surface text-fg shadow-2xl outline-none [transform:translateY(var(--drawer-swipe-movement-y,0))] transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] data-swiping:select-none data-swiping:duration-0 data-starting-style:[transform:translateY(100%)] data-ending-style:[transform:translateY(100%)]"
            >
              {body}
            </Drawer.Popup>
          </Drawer.Viewport>
        </Drawer.Portal>
      </Drawer.Root>
    );
  }

  return (
    <Dialog.Root open={route.isOpen} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className={backdropClass} />
        <Dialog.Viewport className="fixed inset-0 z-50 grid place-items-center p-4">
          <Dialog.Popup
            ref={popup}
            aria-labelledby={titleId}
            initialFocus={initialFocus}
            finalFocus={finalFocus}
            className="flex h-[40rem] max-h-[90vh] w-[55rem] max-w-full overflow-hidden rounded-2xl border border-line bg-surface text-fg shadow-2xl outline-none transition-[scale,opacity] duration-150 data-starting-style:scale-[0.98] data-starting-style:opacity-0 data-ending-style:scale-[0.98] data-ending-style:opacity-0"
          >
            {body}
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
