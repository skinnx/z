import { NumberField as BaseNumberField } from "@base-ui/react/number-field";
import { Minus, Plus } from "lucide-react";
import { cn } from "../lib/cn.ts";
import { controlClass } from "./field.tsx";

export function NumberField({
  value,
  onChange,
  id,
  min = 0,
  step = 1,
  format,
  placeholder,
  decrementLabel,
  incrementLabel,
}: {
  value: number | null;
  onChange: (value: number | null) => void;
  id?: string;
  min?: number;
  step?: number;
  format?: Intl.NumberFormatOptions;
  placeholder?: string;
  decrementLabel: string;
  incrementLabel: string;
}) {
  const btn = "flex w-10 items-center justify-center text-fg-muted hover:bg-subtle hover:text-fg [&_svg]:size-4";
  return (
    <BaseNumberField.Root id={id} value={value} onValueChange={(v) => onChange(v)} min={min} step={step} format={format}>
      <BaseNumberField.Group className={cn(controlClass, "flex h-10 items-stretch overflow-hidden px-0 focus-within:border-accent focus-within:outline-2 focus-within:-outline-offset-1 focus-within:outline-accent")}>
        <BaseNumberField.Decrement aria-label={decrementLabel} className={cn(btn, "border-e border-line")}>
          <Minus aria-hidden />
        </BaseNumberField.Decrement>
        <BaseNumberField.Input placeholder={placeholder} className="min-w-0 flex-1 bg-transparent text-center tabular-nums outline-none placeholder:text-fg-muted" />
        <BaseNumberField.Increment aria-label={incrementLabel} className={cn(btn, "border-s border-line")}>
          <Plus aria-hidden />
        </BaseNumberField.Increment>
      </BaseNumberField.Group>
    </BaseNumberField.Root>
  );
}
