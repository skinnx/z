import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup as BaseToggleGroup } from "@base-ui/react/toggle-group";
import type { ReactNode } from "react";
import { cn } from "../lib/cn.ts";

export type Option<V extends string> = { value: V; label: ReactNode; icon?: ReactNode; ariaLabel?: string };

/** Single-choice segmented control. */
export function Segmented<V extends string>({
  value,
  onChange,
  options,
  label,
  size = "md",
  className,
}: {
  value: V;
  onChange: (value: V) => void;
  options: Option<V>[];
  label: string;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <BaseToggleGroup
      aria-label={label}
      value={[value]}
      onValueChange={(v) => {
        const next = v[0];
        if (next !== undefined) onChange(next as V);
      }}
      // Segments never shrink under their label (they used to overlap); short of room, they wrap.
      className={cn("inline-flex max-w-full flex-wrap gap-0.5 rounded-lg border border-line bg-subtle p-0.5", className)}
    >
      {options.map((o) => (
        <Toggle
          key={o.value}
          value={o.value}
          aria-label={o.ariaLabel}
          className={cn(
            "inline-flex flex-1 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 font-medium text-fg-muted transition-colors [&_svg]:size-4 [&_svg]:shrink-0",
            size === "sm" ? "h-7 text-xs" : "h-8 text-sm",
            "hover:text-fg data-pressed:bg-surface data-pressed:text-fg data-pressed:shadow-sm data-pressed:ring-1 data-pressed:ring-line",
          )}
        >
          {o.icon}
          {o.label}
        </Toggle>
      ))}
    </BaseToggleGroup>
  );
}
