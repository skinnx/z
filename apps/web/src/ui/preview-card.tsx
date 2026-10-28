import { PreviewCard as BasePreviewCard } from "@base-ui/react/preview-card";
import type { ReactElement, ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { popupClass } from "./popup.ts";

/**
 * A card previewing what a link points at, on hover or keyboard focus (the "HoverCard" of other kits).
 * Its content is supplementary: whatever it shows must also be reachable another way.
 */
export function PreviewCard({
  trigger,
  children,
  side = "bottom",
  align = "center",
  delay = 200,
  className,
}: {
  trigger: ReactElement;
  children: ReactNode;
  side?: "top" | "bottom" | "inline-start" | "inline-end";
  align?: "start" | "center" | "end";
  delay?: number;
  className?: string;
}) {
  return (
    <BasePreviewCard.Root>
      <BasePreviewCard.Trigger delay={delay} closeDelay={150} render={trigger} />
      <BasePreviewCard.Portal>
        <BasePreviewCard.Positioner side={side} align={align} sideOffset={6} collisionPadding={12} className="z-50">
          <BasePreviewCard.Popup className={cn(popupClass, "w-80 min-w-0 outline-none", className)}>{children}</BasePreviewCard.Popup>
        </BasePreviewCard.Positioner>
      </BasePreviewCard.Portal>
    </BasePreviewCard.Root>
  );
}
