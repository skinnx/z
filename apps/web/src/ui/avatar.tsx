import { Avatar as BaseAvatar } from "@base-ui/react/avatar";
import { cn } from "../lib/cn.ts";

/** Monogram badge (providers, plugins). */
export function Monogram({ text, className }: { text: string; className?: string }) {
  return (
    <BaseAvatar.Root className={cn("inline-flex size-10 shrink-0 select-none items-center justify-center rounded-xl border border-line bg-subtle text-sm font-semibold uppercase text-fg", className)}>
      <BaseAvatar.Fallback>{text.slice(0, 2)}</BaseAvatar.Fallback>
    </BaseAvatar.Root>
  );
}
