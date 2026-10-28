import { Check } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useT } from "../i18n.ts";
import { cn } from "../lib/cn.ts";

/** A quiet "Saved" check that shows for a moment after an autosave lands. The live region is always present. */
export function SavedMark({ show, iconOnly, className }: { show: boolean; iconOnly?: boolean; className?: string }) {
  const t = useT();
  return (
    <span role="status" className={cn("inline-flex items-center gap-1 text-xs font-medium text-ok transition-opacity duration-300", show ? "opacity-100" : "opacity-0", className)}>
      {show && (
        <>
          <Check aria-hidden className="size-3.5" />
          <span className={cn(iconOnly && "sr-only")}>{t.saved}</span>
        </>
      )}
    </span>
  );
}

type Ids = { labelId: string; hintId: string | undefined };

/**
 * One setting: label (and an optional one-line hint) at the start, the control at the end.
 * `children` gets the ids to wire `aria-labelledby` / `aria-describedby` on the control.
 * `stack` puts the control under the label (text areas, lists).
 */
export function Row({
  label,
  hint,
  saved,
  stack,
  className,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  saved?: boolean;
  stack?: boolean;
  className?: string;
  children?: (ids: Ids) => ReactNode;
}) {
  const labelId = useId();
  const hintId = useId();
  const ids = { labelId, hintId: hint ? hintId : undefined };
  return (
    <div className={cn("flex gap-x-4 gap-y-2 py-3.5", stack ? "flex-col" : "flex-wrap items-center", className)}>
      <div className={cn("min-w-0", !stack && "flex-1 basis-48")}>
        <div className="flex items-center gap-2">
          <span id={labelId} className="text-sm font-medium">
            {label}
          </span>
          {saved !== undefined && <SavedMark show={saved} />}
        </div>
        {hint && (
          <p id={hintId} className="mt-0.5 text-xs text-fg-muted">
            {hint}
          </p>
        )}
      </div>
      {children && <div className={cn("flex min-w-0 items-center gap-2", !stack && "ms-auto shrink-0")}>{children(ids)}</div>}
    </div>
  );
}

/** Rows separated by hairlines, with an optional quiet group label. */
export function RowGroup({ label, children, className }: { label?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("not-first:mt-6", className)}>
      {label && <h3 className="mb-1 text-xs font-semibold tracking-wide text-fg-muted uppercase">{label}</h3>}
      <div className="divide-y divide-line">{children}</div>
    </section>
  );
}

/**
 * Local text that saves itself: `commit` runs 600 ms after the last keystroke, on blur, and on
 * unmount (closing the dialog mid-sentence keeps the text). Server updates flow in while untouched.
 */
export function useAutosaveText(value: string, commit: (next: string) => void, delay = 600) {
  const [draft, setDraft] = useState(value);
  const dirty = useRef(false);
  const latest = useRef({ draft: value, value, commit });
  latest.current = { draft, value, commit };
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (!dirty.current) setDraft(value);
  }, [value]);

  const flush = () => {
    clearTimeout(timer.current);
    if (!dirty.current) return;
    dirty.current = false;
    const { draft: d, value: v, commit: c } = latest.current;
    if (d !== v) c(d);
  };

  useEffect(() => () => flush(), []); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    draft,
    change(next: string) {
      setDraft(next);
      latest.current.draft = next;
      dirty.current = true;
      clearTimeout(timer.current);
      timer.current = setTimeout(flush, delay);
    },
    flush,
  };
}
