import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import type { ReactNode } from "react";
import { cn } from "../lib/cn.ts";

export type RadioCard<V extends string> = { value: V; title: ReactNode; meta?: ReactNode; icon?: ReactNode };

/** A grid of selectable cards with radio semantics (arrow keys move between them). */
export function RadioCards<V extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: V;
  onChange: (value: V) => void;
  options: RadioCard<V>[];
  label: string;
  className?: string;
}) {
  return (
    <RadioGroup
      aria-label={label}
      value={value}
      onValueChange={(v) => onChange(v as V)}
      className={cn("grid grid-cols-2 gap-2 sm:grid-cols-3", className)}
    >
      {options.map((o) => (
        <Radio.Root
          key={o.value}
          value={o.value}
          className={cn(
            "flex min-h-14 items-center gap-2.5 rounded-xl border border-line bg-surface px-3 py-2 text-start transition-colors",
            "hover:border-line-strong data-checked:border-accent data-checked:bg-accent-soft data-checked:ring-1 data-checked:ring-accent",
          )}
        >
          {o.icon}
          {/* Titles wrap rather than truncate: "OpenAI-compatible" and Vietnamese labels must stay readable. */}
          <span className="flex min-w-0 flex-col">
            <span className="text-sm leading-snug font-medium [overflow-wrap:anywhere]">{o.title}</span>
            {o.meta && <span className="text-xs leading-snug text-fg-muted [overflow-wrap:anywhere]">{o.meta}</span>}
          </span>
        </Radio.Root>
      ))}
    </RadioGroup>
  );
}
