import { Field as BaseField } from "@base-ui/react/field";
import { Input as BaseInput } from "@base-ui/react/input";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/cn.ts";

export const controlClass = cn(
  "w-full min-w-0 rounded-lg border border-control bg-surface px-3 text-[0.9375rem] text-fg",
  "placeholder:font-sans placeholder:text-fg-muted hover:border-fg/60",
  "focus-visible:border-accent focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-accent",
  "data-invalid:border-danger disabled:opacity-60",
);

/** Label + control + description/error, wired for accessibility by Base UI Field. */
export function Field({
  label,
  description,
  error,
  children,
  className,
  name,
  srOnlyLabel,
}: {
  label: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
  name?: string;
  srOnlyLabel?: boolean;
}) {
  return (
    <BaseField.Root name={name} invalid={!!error} className={cn("flex flex-col gap-1.5", className)}>
      <BaseField.Label className={cn("text-sm font-medium text-fg", srOnlyLabel && "sr-only")}>{label}</BaseField.Label>
      {children}
      {description && <BaseField.Description className="text-xs text-fg-muted">{description}</BaseField.Description>}
      {error && <BaseField.Error match className="text-xs text-danger">{error}</BaseField.Error>}
    </BaseField.Root>
  );
}

export function Input({ className, ...props }: Omit<BaseInput.Props, "className"> & { className?: string }) {
  return <BaseInput className={cn(controlClass, "h-10", className)} {...props} />;
}

/** Multi-line control; Field.Control renders the textarea so labels still link up. */
export function Textarea({ className, ...props }: Omit<ComponentProps<"textarea">, "className"> & { className?: string }) {
  return (
    <BaseField.Control
      render={<textarea />}
      className={cn(controlClass, "min-h-24 resize-y py-2 leading-relaxed", className)}
      {...(props as Record<string, unknown>)}
    />
  );
}

