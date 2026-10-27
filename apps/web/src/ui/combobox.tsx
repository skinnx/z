import { Combobox as BaseCombobox } from "@base-ui/react/combobox";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { useState } from "react";
import { cn } from "../lib/cn.ts";
import { controlClass } from "./field.tsx";
import { itemClass, popupClass } from "./popup.ts";

type Common = {
  items: readonly string[];
  placeholder?: string;
  id?: string;
  "aria-label"?: string;
  emptyText: string;
  className?: string;
  /** Show a monospace label (model ids, cron, tz). */
  mono?: boolean;
  /** Allow choosing the typed text when it isn't in the list. */
  allowCustom?: boolean;
  disabled?: boolean;
};

/** Filterable single choice over plain strings. */
export function Combobox({
  value,
  onChange,
  ...rest
}: Common & { value: string | null; onChange: (value: string | null) => void }) {
  return <ComboboxImpl {...rest} value={value} onChange={onChange} />;
}

/** Same control used as an "add" field: it clears itself after each pick. */
export function ComboboxAdd({ onAdd, ...rest }: Common & { onAdd: (value: string) => void }) {
  const [key, setKey] = useState(0);
  return (
    <ComboboxImpl
      key={key}
      {...rest}
      value={null}
      leading={<Plus aria-hidden className="size-4 text-fg-muted" />}
      onChange={(v) => {
        if (v) onAdd(v);
        setKey((k) => k + 1);
      }}
    />
  );
}

function ComboboxImpl({
  items,
  value,
  onChange,
  placeholder,
  id,
  "aria-label": ariaLabel,
  emptyText,
  className,
  mono,
  allowCustom,
  disabled,
  leading,
}: Common & { value: string | null; onChange: (value: string | null) => void; leading?: React.ReactNode }) {
  const [query, setQuery] = useState("");
  const custom = allowCustom && query.trim() && !items.includes(query.trim()) ? query.trim() : null;
  const list = custom ? [...items, custom] : items;
  return (
    <BaseCombobox.Root
      items={list}
      value={value}
      onValueChange={(v) => onChange(v)}
      onInputValueChange={setQuery}
      limit={200}
      disabled={disabled}
      autoHighlight
    >
      <BaseCombobox.InputGroup
        className={cn(controlClass, "relative flex h-10 items-center gap-2 px-0 ps-3 focus-within:border-accent focus-within:outline-2 focus-within:-outline-offset-1 focus-within:outline-accent", className)}
      >
        {leading}
        <BaseCombobox.Input
          id={id}
          aria-label={ariaLabel}
          placeholder={placeholder}
          className={cn("h-full min-w-0 flex-1 bg-transparent text-[0.9375rem] outline-none placeholder:font-sans placeholder:text-[0.9375rem] placeholder:text-fg-muted", mono && "font-mono text-sm")}
        />
        <BaseCombobox.Trigger aria-label={ariaLabel} className="flex h-full w-9 items-center justify-center text-fg-muted hover:text-fg">
          <ChevronsUpDown aria-hidden className="size-4" />
        </BaseCombobox.Trigger>
      </BaseCombobox.InputGroup>
      <BaseCombobox.Portal>
        <BaseCombobox.Positioner sideOffset={4} className="z-50">
          <BaseCombobox.Popup className={cn(popupClass, "w-[var(--anchor-width)]")}>
            <BaseCombobox.Empty className="px-3 py-3 text-sm text-fg-muted empty:hidden">{emptyText}</BaseCombobox.Empty>
            <BaseCombobox.List className="max-h-[min(22rem,var(--available-height))] overflow-y-auto p-1 empty:hidden">
              {(item: string) => (
                <BaseCombobox.Item key={item} value={item} className={cn(itemClass, mono && "font-mono text-[0.8125rem]")}>
                  {item === custom ? <Plus aria-hidden className="text-fg-muted" /> : null}
                  <span className="min-w-0 flex-1 truncate">{item}</span>
                  <BaseCombobox.ItemIndicator>
                    <Check aria-hidden />
                  </BaseCombobox.ItemIndicator>
                </BaseCombobox.Item>
              )}
            </BaseCombobox.List>
          </BaseCombobox.Popup>
        </BaseCombobox.Positioner>
      </BaseCombobox.Portal>
    </BaseCombobox.Root>
  );
}
