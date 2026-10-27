import { ScrollArea as BaseScrollArea } from "@base-ui/react/scroll-area";
import type { ReactNode, Ref } from "react";
import { cn } from "../lib/cn.ts";

export function ScrollArea({
  children,
  className,
  viewportClassName,
  viewportRef,
  label,
}: {
  children: ReactNode;
  className?: string;
  viewportClassName?: string;
  viewportRef?: Ref<HTMLDivElement>;
  label?: string;
}) {
  return (
    <BaseScrollArea.Root className={cn("relative min-h-0 overflow-hidden", className)}>
      <BaseScrollArea.Viewport
        ref={viewportRef}
        aria-label={label}
        className={cn("h-full overscroll-contain rounded-[inherit] focus-visible:outline-2 focus-visible:-outline-offset-2", viewportClassName)}
      >
        {children}
      </BaseScrollArea.Viewport>
      <BaseScrollArea.Scrollbar className="m-0.5 flex w-1.5 justify-center rounded-full opacity-0 transition-opacity data-hovering:opacity-100 data-scrolling:opacity-100">
        <BaseScrollArea.Thumb className="w-full rounded-full bg-line-strong" />
      </BaseScrollArea.Scrollbar>
    </BaseScrollArea.Root>
  );
}
