import type { Approval } from "@z/core";
import { Check, ShieldCheck, X } from "lucide-react";
import { useDecide } from "../api/approvals.ts";
import { useT } from "../i18n.ts";
import { relativeTime, json } from "../lib/format.ts";
import { riskIcon, riskTone } from "../lib/icons.tsx";
import { cn } from "../lib/cn.ts";
import { Button } from "../ui/button.tsx";
import { Disclosure } from "../ui/collapsible.tsx";
import { notifyError } from "../ui/toast.tsx";

export function ApprovalCard({ approval }: { approval: Approval }) {
  const t = useT();
  const decide = useDecide();
  const Icon = riskIcon[approval.risk];
  const run = (approve: boolean, remember = false) =>
    decide.mutate({ id: approval.id, decision: { approve, remember } }, { onError: notifyError });

  return (
    <article
      aria-label={approval.summary}
      className={cn(
        "@container rounded-(--radius-card) border bg-surface p-4",
        approval.risk === "external" ? "border-danger/50" : "border-line",
      )}
    >
      <div className="flex items-start gap-3">
        <span className={cn("grid size-10 shrink-0 place-items-center rounded-xl bg-subtle", riskTone[approval.risk])}>
          <Icon aria-hidden className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-medium leading-snug break-words">{approval.summary}</p>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-fg-muted">
            <code className="font-mono">{approval.tool}</code>
            <span aria-hidden>·</span>
            <span className={riskTone[approval.risk]}>{t[`risk_${approval.risk}`]}</span>
            <span aria-hidden>·</span>
            <time dateTime={approval.createdAt}>{relativeTime(approval.createdAt)}</time>
          </p>
          <Disclosure summary={t.input} className="mt-1">
            <pre className="mt-1 max-h-60 overflow-auto rounded-lg bg-subtle p-3 font-mono text-xs leading-relaxed">{json(approval.input)}</pre>
          </Disclosure>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2 @md:justify-end">
        <Button variant="primary" onClick={() => run(true)} disabled={decide.isPending} className="flex-1 @md:flex-none">
          <Check aria-hidden />
          {t.approve}
        </Button>
        {approval.risk !== "external" && (
          <Button onClick={() => run(true, true)} disabled={decide.isPending} className="flex-1 @md:flex-none">
            <ShieldCheck aria-hidden />
            {t.alwaysAllow}
          </Button>
        )}
        <Button variant="danger" onClick={() => run(false)} disabled={decide.isPending} className="flex-1 @md:flex-none">
          <X aria-hidden />
          {t.deny}
        </Button>
      </div>
    </article>
  );
}
