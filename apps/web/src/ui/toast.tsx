import { Toast as BaseToast } from "@base-ui/react/toast";
import { CircleAlert, CircleCheck, Radar, ShieldAlert, X } from "lucide-react";
import type { ReactNode } from "react";
import { ApiError } from "../api/client.ts";
import { t } from "../i18n.ts";
import { cn } from "../lib/cn.ts";
import { buttonClass } from "./button.tsx";
import { errorText } from "./card.tsx";

/** One manager for the whole app, usable outside React (live events, mutations). */
export const toastManager = BaseToast.createToastManager();

type Kind = "success" | "error" | "approval" | "watch";

export function notify(
  kind: Kind,
  title: ReactNode,
  description?: ReactNode,
  action?: { label: string; onClick: () => void },
) {
  toastManager.add({
    type: kind,
    title,
    description,
    priority: kind === "success" ? "low" : "high",
    timeout: kind === "approval" || kind === "watch" ? 10_000 : 5_000,
    actionProps: action ? { children: action.label, onClick: action.onClick } : undefined,
  });
}

export function notifyError(error: unknown) {
  // The server can't be reached: the offline bar already says so, with Retry.
  if (error instanceof ApiError && error.status === 0) return;
  notify("error", t().error, errorText(error, t()));
}

const icons: Record<Kind, ReactNode> = {
  success: <CircleCheck aria-hidden className="size-5 text-ok" />,
  error: <CircleAlert aria-hidden className="size-5 text-danger" />,
  approval: <ShieldAlert aria-hidden className="size-5 text-warn" />,
  watch: <Radar aria-hidden className="size-5 text-accent-text" />,
};

function ToastList() {
  const { toasts } = BaseToast.useToastManager();
  return toasts.map((toast) => (
    <BaseToast.Root
      key={toast.id}
      toast={toast}
      className={cn(
        "pointer-events-auto relative w-full rounded-xl border border-line bg-surface text-fg shadow-xl",
        "[transform:translateX(var(--toast-swipe-movement-x))_translateY(var(--toast-swipe-movement-y))] transition-[transform,opacity] duration-300",
        "data-starting-style:translate-y-4 data-starting-style:opacity-0 data-ending-style:opacity-0 data-limited:hidden",
      )}
    >
      <BaseToast.Content className="flex items-start gap-3 p-3 pe-2">
        <span className="mt-0.5">{icons[(toast.type as Kind | undefined) ?? "success"]}</span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <BaseToast.Title className="text-sm font-semibold" />
          <BaseToast.Description className="text-sm break-words text-fg-muted" />
          {toast.actionProps && <BaseToast.Action className={buttonClass("secondary", "sm", "mt-2 self-start")} />}
        </div>
        <BaseToast.Close aria-label={t().close} className={buttonClass("ghost", "icon-sm")}>
          <X aria-hidden />
        </BaseToast.Close>
      </BaseToast.Content>
    </BaseToast.Root>
  ));
}

export function Toaster({ children }: { children: ReactNode }) {
  return (
    <BaseToast.Provider toastManager={toastManager} limit={4}>
      {children}
      <BaseToast.Portal>
        <BaseToast.Viewport className="pointer-events-none fixed inset-x-4 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-[60] flex flex-col-reverse gap-2 md:inset-x-auto md:end-6 md:bottom-6 md:w-96">
          <ToastList />
        </BaseToast.Viewport>
      </BaseToast.Portal>
    </BaseToast.Provider>
  );
}
