import { AlertDialog as BaseAlertDialog } from "@base-ui/react/alert-dialog";
import type { ReactElement, ReactNode } from "react";
import { useState } from "react";
import { useT } from "../i18n.ts";
import { Button } from "./button.tsx";
import { backdropClass } from "./dialog.tsx";

/** Destructive confirmation. `trigger` is the element that opens it. */
export function Confirm({
  trigger,
  title,
  description,
  confirmLabel,
  onConfirm,
}: {
  trigger: ReactElement;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel: ReactNode;
  onConfirm: () => Promise<unknown> | void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <BaseAlertDialog.Root open={open} onOpenChange={setOpen}>
      <BaseAlertDialog.Trigger render={trigger} />
      <BaseAlertDialog.Portal>
        {/* Confirms often open over a dialog (z-40/50): their own scrim and popup stack above it. */}
        <BaseAlertDialog.Backdrop className={backdropClass.replace("z-40", "z-50")} />
        <BaseAlertDialog.Viewport className="fixed inset-0 z-[60] grid place-items-center p-4">
          <BaseAlertDialog.Popup className="w-full max-w-sm rounded-2xl border border-line bg-surface p-5 text-fg shadow-2xl ring-1 ring-line-strong transition-[scale,opacity] duration-150 data-starting-style:scale-[0.98] data-starting-style:opacity-0 data-ending-style:scale-[0.98] data-ending-style:opacity-0">
            <BaseAlertDialog.Title className="text-base font-semibold">{title}</BaseAlertDialog.Title>
            <BaseAlertDialog.Description className="mt-1 text-sm text-fg-muted">
              {description ?? t.cannotUndo}
            </BaseAlertDialog.Description>
            <div className="mt-5 flex justify-end gap-2">
              <BaseAlertDialog.Close render={<Button />}>{t.cancel}</BaseAlertDialog.Close>
              <Button
                variant="danger"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await onConfirm();
                    setOpen(false);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {confirmLabel}
              </Button>
            </div>
          </BaseAlertDialog.Popup>
        </BaseAlertDialog.Viewport>
      </BaseAlertDialog.Portal>
    </BaseAlertDialog.Root>
  );
}
