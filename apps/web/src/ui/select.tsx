import { Select as BaseSelect } from "@base-ui/react/select";
import { Check, ChevronsUpDown } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { controlClass } from "./field.tsx";
import { itemClass, popupClass } from "./popup.ts";

export type SelectOption<V extends string> = { value: V; label: string; icon?: ReactNode };

export function Select<V extends string>({
  value,
  onChange,
  options,
  id,
  className,
  "aria-label": ariaLabel,
  disabled,
}: {
  value: V;
  onChange: (value: V) => void;
  options: SelectOption<V>[];
  id?: string;
  className?: string;
  "aria-label"?: string;
  disabled?: boolean;
}) {
  const current = options.find((o) => o.value === value);
  return (
    <BaseSelect.Root
      items={options}
      value={value}
      disabled={disabled}
      onValueChange={(v) => {
        if (v !== null) onChange(v as V);
      }}
    >
      <BaseSelect.Trigger
        id={id}
        aria-label={ariaLabel}
        className={cn(controlClass, "flex h-10 items-center justify-between gap-2 text-start", className)}
      >
        <span className="flex min-w-0 items-center gap-2 truncate [&_svg]:size-4 [&_svg]:text-fg-muted">
          {current?.icon}
          <BaseSelect.Value />
        </span>
        <BaseSelect.Icon>
          <ChevronsUpDown aria-hidden className="size-4 text-fg-muted" />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner sideOffset={4} alignItemWithTrigger={false} className="z-50">
          <BaseSelect.Popup className={popupClass}>
            <BaseSelect.List className="max-h-[min(20rem,var(--available-height))] overflow-y-auto p-1">
              {options.map((o) => (
                <BaseSelect.Item key={o.value} value={o.value} className={cn(itemClass, "pe-8")}>
                  <span className="text-fg-muted">{o.icon}</span>
                  <BaseSelect.ItemText>{o.label}</BaseSelect.ItemText>
                  <BaseSelect.ItemIndicator className="ms-auto">
                    <Check aria-hidden />
                  </BaseSelect.ItemIndicator>
                </BaseSelect.Item>
              ))}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
