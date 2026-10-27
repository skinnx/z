import { Switch as BaseSwitch } from "@base-ui/react/switch";
import { cn } from "../lib/cn.ts";

export function Switch({ className, ...props }: Omit<BaseSwitch.Root.Props, "className"> & { className?: string }) {
  return (
    <BaseSwitch.Root
      className={cn(
        "relative inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full border border-control bg-subtle p-0.5 transition-colors",
        "data-checked:border-accent data-checked:bg-accent data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <BaseSwitch.Thumb className="block size-[1.125rem] rounded-full bg-surface shadow-sm ring-1 ring-black/10 transition-transform duration-150 data-checked:translate-x-4 rtl:data-checked:-translate-x-4 dark:bg-fg data-checked:dark:bg-accent-fg" />
    </BaseSwitch.Root>
  );
}

/** A switch with its visible label and optional hint, all clickable. */
export function SwitchRow({
  label,
  hint,
  ...props
}: Omit<BaseSwitch.Root.Props, "className"> & { label: string; hint?: string }) {
  return (
    <label className="flex min-h-10 cursor-pointer items-center justify-between gap-4">
      <span className="flex flex-col">
        <span className="text-sm font-medium">{label}</span>
        {hint && <span className="text-xs text-fg-muted">{hint}</span>}
      </span>
      <Switch {...props} />
    </label>
  );
}
