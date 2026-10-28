/** A failure, said plainly, with the one action that fixes it (see lib/errors.ts for the mapping). */
import type { Lane } from "@z/core";
import { CircleAlert, CloudOff, Cpu, KeyRound, LogIn, RotateCw, ServerCrash } from "lucide-react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { queryClient } from "../api/query.ts";
import { useT, type Dict } from "../i18n.ts";
import { cn } from "../lib/cn.ts";
import { classifyError, errorMessage, type ErrorKind } from "../lib/errors.ts";
import { Button } from "../ui/button.tsx";
import { Spinner } from "../ui/card.tsx";

type Action = { label: string; icon: ReactNode; run: () => void; primary?: boolean };

export type ErrorFixProps = {
  error: unknown;
  /** When the caller already knows what failed (a connector's status), instead of reading the text. */
  kind?: ErrorKind;
  /** The model provider the failure is about, for "Fix key" and the wording. */
  provider?: { id: string; label: string } | null;
  /** The connector the failure is about, for "Sign in". */
  source?: string;
  /** Which routing lane "Try another model" / "Pick a model" opens when `onPickModel` is not given. */
  lane?: Lane;
  onRetry?: () => void;
  onPickModel?: () => void;
  onFixKey?: () => void;
  onSignIn?: () => void;
  pending?: boolean;
  /** `box`: its own alert card; `inline`: a few lines inside a card (provider test, connector status). */
  variant?: "box" | "inline";
  className?: string;
};

export function explain(kind: ErrorKind, t: Dict, who: string, source: string): { title: string; hint: string | null } {
  switch (kind) {
    case "key":
      return { title: t.fix_key(who), hint: t.fix_keyHint };
    case "quota":
      return { title: t.fix_quota(who), hint: t.fix_quotaHint };
    case "model":
      return { title: t.fix_model(who), hint: t.fix_modelHint };
    case "no-model":
      return { title: t.fix_noModel, hint: t.fix_noModelHint };
    case "offline":
      return { title: t.fix_offline, hint: t.fix_offlineHint };
    case "server":
      return { title: t.fix_server, hint: t.fix_serverHint };
    case "sign-in":
      return { title: t.fix_signIn(source), hint: t.fix_signInHint };
    default:
      return { title: t.fix_unknown, hint: null };
  }
}

const kindIcon: Record<ErrorKind, typeof CircleAlert> = {
  key: KeyRound,
  quota: CircleAlert,
  model: Cpu,
  "no-model": Cpu,
  offline: CloudOff,
  server: ServerCrash,
  "sign-in": LogIn,
  unknown: CircleAlert,
};

export function ErrorFix({ error, kind: known, provider, source, lane = "chat", onRetry, onPickModel, onFixKey, onSignIn, pending, variant = "box", className }: ErrorFixProps) {
  const t = useT();
  const navigate = useNavigate();
  const kind = known ?? classifyError(error);
  const detail = errorMessage(error);
  const who = provider?.label ?? t.theProvider;
  const { title, hint } = explain(kind, t, who, source ?? t.theProvider);
  const pickModel = onPickModel ?? (() => navigate(`/models?lane=${lane}`));
  const retry = onRetry ?? (() => void queryClient.refetchQueries({ type: "active" }));

  const actions: Action[] = [];
  const retryAction: Action = { label: t.retry, icon: <RotateCw aria-hidden />, run: retry };
  if (kind === "key") actions.push({ label: t.act_fixKey, icon: <KeyRound aria-hidden />, primary: true, run: onFixKey ?? (() => navigate(provider ? `/models?edit=${encodeURIComponent(provider.id)}` : "/models")) });
  else if (kind === "quota") {
    actions.push({ label: t.act_otherModel, icon: <Cpu aria-hidden />, primary: true, run: pickModel });
    if (onRetry) actions.push(retryAction);
  } else if (kind === "model" || kind === "no-model") actions.push({ label: t.act_pickModel, icon: <Cpu aria-hidden />, primary: true, run: pickModel });
  else if (kind === "sign-in" && onSignIn) actions.push({ label: t.act_signIn, icon: <LogIn aria-hidden />, primary: true, run: onSignIn });
  else if (kind === "offline" || kind === "server") actions.push({ ...retryAction, primary: true });
  else if (onRetry) actions.push(retryAction);

  const Icon = kindIcon[kind];
  // Nothing better to say than the failure itself: it becomes the title.
  const plain = kind === "unknown" && detail;
  const showDetail = !plain && detail && detail !== "offline" && kind !== "offline";

  return (
    <div
      role="alert"
      data-error-kind={kind}
      className={cn(
        "flex gap-3 text-sm",
        variant === "box" ? "flex-wrap items-start rounded-xl border border-danger/40 bg-danger-soft p-3" : "flex-col items-stretch gap-2 text-xs",
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-2">
        <Icon aria-hidden className={cn("mt-0.5 shrink-0 text-danger", variant === "box" ? "size-4" : "size-3.5")} />
        <div className="min-w-0 flex-1 break-words">
          <p className="font-medium text-danger">{plain ? detail : title}</p>
          {hint && <p className="text-fg">{hint}</p>}
          {showDetail && (
            <p className="mt-0.5 line-clamp-2 font-mono text-[0.6875rem] text-fg-muted" title={detail}>
              {detail}
            </p>
          )}
        </div>
      </div>
      {actions.length > 0 && (
        <div className={cn("flex shrink-0 flex-wrap gap-1.5", variant === "inline" && "ps-5.5")}>
          {actions.map((a) => (
            <Button key={a.label} size="sm" variant={a.primary ? "primary" : "secondary"} disabled={pending} onClick={a.run}>
              {pending && a.primary ? <Spinner /> : a.icon}
              {a.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
