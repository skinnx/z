import { Popover as BasePopover } from "@base-ui/react/popover";
import type { ReactElement, ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { popupClass } from "./popup.ts";

/** Anchored panel with a (visually hidden) title, for small lists like the notice inbox. */
export function Popover({
  trigger,
  title,
  children,
  open,
  onOpenChange,
  side = "bottom",
  align = "start",
  className,
}: {
  trigger: ReactElement;
  title: string;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  side?: "top" | "bottom" | "inline-end" | "inline-start";
  align?: "start" | "center" | "end";
  className?: string;
}) {
  return (
    <BasePopover.Root open={open} onOpenChange={onOpenChange}>
      <BasePopover.Trigger render={trigger} />
      <BasePopover.Portal>
        <BasePopover.Positioner side={side} align={align} sideOffset={8} collisionPadding={12} className="z-50">
          <BasePopover.Popup className={cn(popupClass, "flex max-h-[min(32rem,var(--available-height))] w-96 flex-col outline-none", className)}>
            <BasePopover.Title className="sr-only">{title}</BasePopover.Title>
            {children}
          </BasePopover.Popup>
        </BasePopover.Positioner>
      </BasePopover.Portal>
    </BasePopover.Root>
  );
}
