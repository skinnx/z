import { Collapsible as BaseCollapsible } from "@base-ui/react/collapsible";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/cn.ts";

const panelClass = "h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 data-starting-style:h-0 data-ending-style:h-0";
const triggerClass = "group inline-flex min-h-8 items-center gap-1 rounded-md pe-2 text-xs font-medium text-fg-muted hover:text-fg";
const chevron = <ChevronRight aria-hidden className="size-4 transition-transform group-data-panel-open:rotate-90 rtl:-scale-x-100" />;

/** A disclosure with a chevron; the panel animates its height. */
export function Disclosure({
  summary,
  children,
  defaultOpen,
  className,
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  return (
    <BaseCollapsible.Root defaultOpen={defaultOpen} className={className}>
      <BaseCollapsible.Trigger className={triggerClass}>
        {chevron}
        {summary}
      </BaseCollapsible.Trigger>
      <BaseCollapsible.Panel className={panelClass}>{children}</BaseCollapsible.Panel>
    </BaseCollapsible.Root>
  );
}

/** The same disclosure in parts, for when the trigger and the panel live apart (a card's footer and body). */
export const Collapsible = {
  Root: BaseCollapsible.Root,
  Trigger: ({ children, className }: { children: ReactNode; className?: string }) => (
    <BaseCollapsible.Trigger className={cn(triggerClass, className)}>
      {chevron}
      {children}
    </BaseCollapsible.Trigger>
  ),
  Panel: ({ children, className }: { children: ReactNode; className?: string }) => (
    <BaseCollapsible.Panel className={cn(panelClass, className)}>{children}</BaseCollapsible.Panel>
  ),
};
