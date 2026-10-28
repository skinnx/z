import { Button as BaseButton } from "@base-ui/react/button";
import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import { useT } from "../i18n.ts";
import { cn } from "../lib/cn.ts";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "icon" | "icon-sm";

const variants: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-fg hover:bg-accent-hover border-transparent",
  secondary: "bg-surface text-fg border-line hover:bg-subtle hover:border-line-strong",
  ghost: "bg-transparent text-fg border-transparent hover:bg-subtle",
  danger: "bg-surface text-danger border-line hover:bg-danger-soft hover:border-danger",
};

const sizes: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-sm gap-1.5",
  md: "h-10 px-4 text-sm gap-2",
  icon: "size-10 justify-center",
  "icon-sm": "size-8 justify-center",
};

export function buttonClass(variant: ButtonVariant = "secondary", size: ButtonSize = "md", extra?: string) {
  return cn(
    "inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-lg border font-medium",
    "transition-colors duration-150 [&_svg]:size-4 [&_svg]:shrink-0",
    "data-disabled:pointer-events-none data-disabled:opacity-50 disabled:opacity-50",
    variants[variant],
    sizes[size],
    extra,
  );
}

type Props = Omit<BaseButton.Props, "className"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
};

export function Button({ variant, size, className, type = "button", ...props }: Props) {
  return <BaseButton type={type} className={buttonClass(variant, size, className)} {...props} />;
}

/** A link styled as a quiet button that opens another site in a new tab, and says so to screen readers. */
export function ExternalLinkButton({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  const t = useT();
  return (
    <a href={href} target="_blank" rel="noreferrer" className={buttonClass("ghost", "md", cn("text-accent-text hover:bg-accent-soft", className))}>
      {children}
      <ExternalLink aria-hidden className="size-3.5!" />
      <span className="sr-only">({t.opensNewTab})</span>
    </a>
  );
}

/** A whole list row that is one button (inside a Card's divided list); its focus ring is drawn inside. */
export function RowButton({ className, type = "button", ...props }: Omit<BaseButton.Props, "className"> & { className?: string }) {
  return (
    <BaseButton
      type={type}
      className={cn(
        "flex min-h-16 w-full items-center gap-3 px-4 py-3 text-start transition-colors hover:bg-subtle/60",
        "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
        className,
      )}
      {...props}
    />
  );
}

/** A tappable card: a whole tile that is one button (galleries, pickers). */
export function Tile({ className, type = "button", ...props }: Omit<BaseButton.Props, "className"> & { className?: string }) {
  return (
    <BaseButton
      type={type}
      className={cn(
        "flex min-h-14 w-full min-w-0 items-center gap-3 rounded-xl border border-line bg-surface px-3 py-2.5 text-start transition-colors",
        "hover:border-line-strong hover:bg-subtle active:bg-subtle data-disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
