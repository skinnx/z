import { RotateCw } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { useT, type Dict } from "../i18n.ts";
import { cn } from "../lib/cn.ts";
import { Button } from "./button.tsx";
import { ApiError } from "../api/client.ts";
import { serverText } from "../lib/server-text.ts";

export function Card({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("min-w-0 rounded-(--radius-card) border border-line bg-surface", className)} {...props} />;
}

/** The empty state is an invitation: an icon, one line, and the next action. */
export function Empty({ icon, text, children, className }: { icon: ReactNode; text: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center gap-3 rounded-(--radius-card) border border-dashed border-line-strong px-6 py-10 text-center", className)}>
      <span className="grid size-12 place-items-center rounded-full bg-subtle text-fg-muted [&_svg]:size-6" aria-hidden>
        {icon}
      </span>
      <p className="max-w-sm text-sm text-fg-muted">{text}</p>
      {children && <div className="flex flex-wrap justify-center gap-2">{children}</div>}
    </div>
  );
}

/** Section within a screen. The heading is visually quiet or hidden; landmarks stay. */
export function Section({
  label,
  icon,
  actions,
  children,
  className,
  hideLabel,
}: {
  label: string;
  icon?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  hideLabel?: boolean;
}) {
  const id = `sec-${label.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <section aria-labelledby={id} className={cn("flex flex-col gap-3", className)}>
      <div className={cn("flex min-h-8 items-center gap-2", hideLabel && !actions && "sr-only")}>
        <h2 id={id} className={cn("flex items-center gap-2 text-xs font-semibold tracking-wide text-fg-muted uppercase [&_svg]:size-4", hideLabel && "sr-only")}>
          {icon}
          {label}
        </h2>
        {actions && <div className="ms-auto flex items-center gap-1">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-4 animate-spin rounded-full border-2 border-current border-e-transparent motion-reduce:animate-none", className)}
    />
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line bg-subtle px-1.5 py-0.5 font-mono text-[0.6875rem] text-fg-muted">{children}</kbd>;
}

export function Badge({ children, tone = "neutral", className }: { children: ReactNode; tone?: "neutral" | "accent" | "ok" | "warn" | "danger"; className?: string }) {
  const tones = {
    neutral: "bg-subtle text-fg-muted",
    accent: "bg-accent-soft text-accent-text",
    ok: "bg-subtle text-ok",
    warn: "bg-warn-soft text-warn",
    danger: "bg-danger-soft text-danger",
  };
  return <span className={cn("inline-flex h-6 items-center gap-1 rounded-full px-2 text-xs font-medium [&_svg]:size-3.5", tones[tone], className)}>{children}</span>;
}

export function Loading({ label, className }: { label: string; className?: string }) {
  return (
    <div role="status" className={cn("grid h-40 place-items-center text-fg-muted", className)}>
      <Spinner />
      <span className="sr-only">{label}</span>
    </div>
  );
}

/** What to tell the owner about a failed request: an unreachable server reads as such, in their language. */
export function errorText(error: unknown, t: Dict): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "offline") return t.offline;
  return error instanceof ApiError ? serverText(message, error.msg) : message;
}

/** A failed load: what went wrong and one way forward. */
export function LoadError({ error, onRetry, retryLabel }: { error: unknown; onRetry: () => void; retryLabel?: string }) {
  const t = useT();
  return (
    <div role="alert" className="flex flex-col items-center gap-3 rounded-(--radius-card) border border-danger/40 bg-danger-soft px-6 py-8 text-center">
      <p className="max-w-md text-sm break-words text-danger">{errorText(error, t)}</p>
      <Button onClick={onRetry}>
        <RotateCw aria-hidden />
        {retryLabel ?? t.retry}
      </Button>
    </div>
  );
}
