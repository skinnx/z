import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import type { ReactElement, ReactNode } from "react";

export const TooltipProvider = BaseTooltip.Provider;

type Side = "top" | "bottom" | "left" | "right" | "inline-end" | "inline-start";

/** For long lists: one `SharedTooltip` per list, and each row's `Tooltip` given its handle. */
export const createTooltipHandle = (): TooltipHandle => BaseTooltip.createHandle<ReactNode>();
export type TooltipHandle = BaseTooltip.Handle<ReactNode>;

export function SharedTooltip({ handle, side = "top" }: { handle: TooltipHandle; side?: Side }) {
  return (
    <BaseTooltip.Root handle={handle}>
      {({ payload }) => (
        <BaseTooltip.Portal>
          <BaseTooltip.Positioner side={side} sideOffset={6} className="z-50">
            <BaseTooltip.Popup className={popupClass}>{payload}</BaseTooltip.Popup>
          </BaseTooltip.Positioner>
        </BaseTooltip.Portal>
      )}
    </BaseTooltip.Root>
  );
}

const popupClass = "rounded-md bg-fg px-2 py-1 text-xs font-medium text-bg transition-opacity duration-100 data-starting-style:opacity-0 data-ending-style:opacity-0";

/**
 * Wrap an icon-only control: the label is both its tooltip and accessible name. With `handle`
 * the tooltip is a list's `SharedTooltip` and only the trigger lives here.
 */
export function Tooltip({ label, children, side = "top", handle }: { label: ReactNode; children: ReactElement; side?: Side; handle?: TooltipHandle }) {
  if (handle) return <BaseTooltip.Trigger handle={handle} payload={label} render={children} />;
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={children} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner side={side} sideOffset={6} className="z-50">
          <BaseTooltip.Popup className={popupClass}>{label}</BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}
