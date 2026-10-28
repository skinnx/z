import { Menu as BaseMenu } from "@base-ui/react/menu";
import type { ReactElement, ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { itemClass, popupClass } from "./popup.ts";

export function Menu({
  trigger,
  children,
  side = "bottom",
  align = "end",
}: {
  trigger: ReactElement;
  children: ReactNode;
  side?: "top" | "bottom";
  align?: "start" | "center" | "end";
}) {
  return (
    <BaseMenu.Root>
      <BaseMenu.Trigger render={trigger} />
      <BaseMenu.Portal>
        <BaseMenu.Positioner side={side} align={align} sideOffset={6} className="z-50">
          <BaseMenu.Popup className={cn(popupClass, "min-w-48 p-1")}>{children}</BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  );
}

/**
 * One menu for a long list's rows: render it once with a handle, and give each row a
 * `MenuTrigger` with that handle and its own payload. Mounting a full menu per row is what makes
 * lists of hundreds slow to open; a trigger alone is cheap.
 */
export const createMenuHandle = BaseMenu.createHandle;
export type MenuHandle<P> = BaseMenu.Handle<P>;

export function SharedMenu<P>({
  handle,
  children,
  side = "bottom",
  align = "end",
}: {
  handle: MenuHandle<P>;
  /** The items for the row whose trigger opened it. */
  children: (payload: P) => ReactNode;
  side?: "top" | "bottom";
  align?: "start" | "center" | "end";
}) {
  return (
    <BaseMenu.Root handle={handle}>
      {({ payload }) => (
        <BaseMenu.Portal>
          <BaseMenu.Positioner side={side} align={align} sideOffset={6} className="z-50">
            <BaseMenu.Popup className={cn(popupClass, "min-w-48 p-1")}>{payload !== undefined && children(payload)}</BaseMenu.Popup>
          </BaseMenu.Positioner>
        </BaseMenu.Portal>
      )}
    </BaseMenu.Root>
  );
}

/** A row's trigger for a `SharedMenu`. */
export function MenuTrigger<P>({ handle, payload, trigger }: { handle: MenuHandle<P>; payload: P; trigger: ReactElement }) {
  return <BaseMenu.Trigger handle={handle} payload={payload} render={trigger} />;
}

export function MenuItem({ icon, children, onClick, render, danger }: { icon?: ReactNode; children: ReactNode; onClick?: () => void; render?: ReactElement; danger?: boolean }) {
  return (
    <BaseMenu.Item onClick={onClick} render={render} className={cn(itemClass, danger && "text-danger")}>
      {icon}
      {children}
    </BaseMenu.Item>
  );
}

export function MenuLinkItem({ icon, children, render }: { icon?: ReactNode; children: ReactNode; render: ReactElement }) {
  return (
    <BaseMenu.LinkItem render={render} className={itemClass}>
      {icon}
      {children}
    </BaseMenu.LinkItem>
  );
}

export const MenuSeparator = () => <BaseMenu.Separator className="my-1 h-px bg-line" />;
