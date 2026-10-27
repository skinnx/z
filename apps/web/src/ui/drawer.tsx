import { Drawer as BaseDrawer } from "@base-ui/react/drawer";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useT } from "../i18n.ts";
import { cn } from "../lib/cn.ts";
import { Button } from "./button.tsx";

/** Side panel sliding in from the inline end; swipe to dismiss on touch. */
export function Drawer({
  open,
  onOpenChange,
  title,
  actions,
  children,
  side = "right",
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  side?: "right" | "left";
  className?: string;
}) {
  const t = useT();
  const right = side === "right";
  return (
    <BaseDrawer.Root open={open} onOpenChange={onOpenChange} swipeDirection={side}>
      <BaseDrawer.Portal>
        <BaseDrawer.Backdrop className="fixed inset-0 z-40 bg-black/40 opacity-[calc(1-var(--drawer-swipe-progress,0))] transition-opacity duration-300 data-swiping:duration-0 data-starting-style:opacity-0 data-ending-style:opacity-0" />
        <BaseDrawer.Viewport className={cn("fixed inset-0 z-50 flex items-stretch", right ? "justify-end" : "justify-start")}>
          <BaseDrawer.Popup
            className={cn(
              "flex h-full w-full flex-col bg-surface text-fg outline-none",
              right ? "border-s border-line sm:max-w-md" : "border-e border-line max-w-80",
              "[transform:translateX(var(--drawer-swipe-movement-x,0))] transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] data-swiping:select-none data-swiping:duration-0",
              right
                ? "data-starting-style:[transform:translateX(100%)] data-ending-style:[transform:translateX(100%)]"
                : "data-starting-style:[transform:translateX(-100%)] data-ending-style:[transform:translateX(-100%)]",
              className,
            )}
          >
            <div className="flex items-center gap-2 border-b border-line px-4 py-2">
              <BaseDrawer.Title className="flex min-w-0 flex-1 items-center gap-2 font-semibold">{title}</BaseDrawer.Title>
              {actions}
              <BaseDrawer.Close render={<Button variant="ghost" size="icon" aria-label={t.close} />}>
                <X aria-hidden />
              </BaseDrawer.Close>
            </div>
            <BaseDrawer.Content className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</BaseDrawer.Content>
          </BaseDrawer.Popup>
        </BaseDrawer.Viewport>
      </BaseDrawer.Portal>
    </BaseDrawer.Root>
  );
}
