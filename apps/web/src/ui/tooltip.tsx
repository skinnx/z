import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import type { ReactElement, ReactNode } from "react";

export const TooltipProvider = BaseTooltip.Provider;

/** Wrap an icon-only control: the label is both its tooltip and accessible name. */
export function Tooltip({ label, children, side = "top" }: { label: ReactNode; children: ReactElement; side?: "top" | "bottom" | "left" | "right" | "inline-end" | "inline-start" }) {
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={children} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner side={side} sideOffset={6} className="z-50">
          <BaseTooltip.Popup className="rounded-md bg-fg px-2 py-1 text-xs font-medium text-bg transition-opacity duration-100 data-starting-style:opacity-0 data-ending-style:opacity-0">
            {label}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}
