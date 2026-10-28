import { Dialog } from "@base-ui/react/dialog";
import { Form } from "@base-ui/react/form";
import { KeyRound } from "lucide-react";
import { useState } from "react";
import { authRequired, token } from "../api/client.ts";
import { queryClient } from "../api/query.ts";
import { useT } from "../i18n.ts";
import { Button } from "../ui/button.tsx";
import { backdropClass } from "../ui/dialog.tsx";
import { Field, Input } from "../ui/field.tsx";

/** Enter the server's Z_TOKEN; it is kept in this browser's localStorage. */
export function TokenForm({ onDone, submitLabel }: { onDone?: () => void; submitLabel: string }) {
  const t = useT();
  const [value, setValue] = useState("");
  return (
    <Form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!value.trim()) return;
        token.set(value.trim());
        authRequired.set(false);
        setValue("");
        void queryClient.invalidateQueries();
        onDone?.();
      }}
    >
      <Field label={t.tokenLabel}>
        <Input type="password" autoComplete="current-password" required autoFocus value={value} onValueChange={setValue} className="font-mono" />
      </Field>
      <Button type="submit" variant="primary">
        {submitLabel}
      </Button>
    </Form>
  );
}

/** Opens whenever the server answers 401. */
export function TokenDialog() {
  const t = useT();
  const open = authRequired.use();
  const hadToken = !!token.get();

  return (
    <Dialog.Root open={open} onOpenChange={(o) => authRequired.set(o)} disablePointerDismissal>
      <Dialog.Portal>
        <Dialog.Backdrop className={backdropClass} />
        <Dialog.Viewport className="fixed inset-0 z-50 grid place-items-center p-4">
          <Dialog.Popup className="w-full max-w-sm rounded-2xl border border-line bg-surface p-5 text-fg shadow-2xl">
            <div className="mb-4 flex items-center gap-3">
              <span className="grid size-10 place-items-center rounded-full bg-accent-soft text-accent-text">
                <KeyRound aria-hidden className="size-5" />
              </span>
              <div>
                <Dialog.Title className="font-semibold">{t.tokenTitle}</Dialog.Title>
                <Dialog.Description className="text-sm text-fg-muted">{hadToken ? t.tokenWrong : t.tokenHint}</Dialog.Description>
              </div>
            </div>
            <TokenForm submitLabel={t.tokenSave} />
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
