import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { useRef, type ReactNode } from "react";
import { useT } from "../i18n.ts";
import { cn } from "../lib/cn.ts";
import { Button } from "./button.tsx";

export const DialogRoot = BaseDialog.Root;
export const DialogTrigger = BaseDialog.Trigger;
export const DialogClose = BaseDialog.Close;

export const backdropClass =
  "fixed inset-0 z-40 bg-black/40 transition-opacity duration-150 data-starting-style:opacity-0 data-ending-style:opacity-0 supports-[-webkit-touch-callout:none]:absolute";

/** Centered modal with a visible title row and close button. */
export function DialogContent({
  title,
  children,
  className,
  wide,
}: {
  title: ReactNode;
  children: ReactNode;
  className?: string;
  wide?: boolean;
}) {
  const t = useT();
  const body = useRef<HTMLDivElement>(null);
  return (
    <BaseDialog.Portal>
      <BaseDialog.Backdrop className={backdropClass} />
      <BaseDialog.Viewport className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto sm:items-start sm:p-4 sm:pt-[8vh]">
        <BaseDialog.Popup
          // Start on the first field rather than the close button (but don't pop the keyboard on touch).
          initialFocus={(type) =>
            type === "touch"
              ? true
              : (body.current?.querySelector<HTMLElement>(
                  '[role="radio"][aria-checked="true"], input:not([type="hidden"]):not([aria-hidden="true"]):not([disabled]), textarea, select',
                ) ?? true)
          }
          className={cn(
            "relative flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-line bg-surface text-fg shadow-2xl sm:rounded-2xl",
            wide ? "sm:max-w-2xl" : "sm:max-w-lg",
            "transition-[translate,opacity,scale] duration-200 ease-out data-starting-style:translate-y-4 data-starting-style:opacity-0 data-ending-style:translate-y-4 data-ending-style:opacity-0 sm:data-starting-style:translate-y-0 sm:data-starting-style:scale-[0.98] sm:data-ending-style:translate-y-0 sm:data-ending-style:scale-[0.98]",
            className,
          )}
        >
          <div className="flex items-center gap-2 border-b border-line px-4 py-2 ps-5">
            <BaseDialog.Title className="flex min-w-0 flex-1 items-center gap-2 text-base font-semibold">{title}</BaseDialog.Title>
            <BaseDialog.Close render={<Button variant="ghost" size="icon" aria-label={t.close} />}>
              <X aria-hidden />
            </BaseDialog.Close>
          </div>
          <div ref={body} className="overflow-y-auto p-5">
            {children}
          </div>
        </BaseDialog.Popup>
      </BaseDialog.Viewport>
    </BaseDialog.Portal>
  );
}

export const Dialog = { Root: DialogRoot, Trigger: DialogTrigger, Close: DialogClose, Content: DialogContent };
