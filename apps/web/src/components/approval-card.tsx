import type { Approval } from "@z/core";
import { Check, ShieldCheck, X } from "lucide-react";
import { useDecide } from "../api/approvals.ts";
import { useT } from "../i18n.ts";
import { relativeTime, json } from "../lib/format.ts";
import { riskIcon, riskTone } from "../lib/icons.tsx";
import { cn } from "../lib/cn.ts";
import { Disclosure } from "../ui/collapsible.tsx";
import { notifyError } from "../ui/toast.tsx";
import { CodeBlock } from "./ai-elements/code-block.tsx";
import { Confirmation, ConfirmationAction, ConfirmationActions, ConfirmationRequest, ConfirmationTitle } from "./ai-elements/confirmation.tsx";

/** A task's tool call waiting on the owner: the AI Elements Confirmation, fed by z's approvals API. */
export function ApprovalCard({ approval }: { approval: Approval }) {
  const t = useT();
  const decide = useDecide();
  const Icon = riskIcon[approval.risk];
  const run = (approve: boolean, remember = false) =>
    decide.mutate({ id: approval.id, decision: { approve, remember } }, { onError: notifyError });
  const state = approval.status === "pending" ? "approval-requested" : approval.status === "denied" ? "output-denied" : "approval-responded";

  return (
    <Confirmation
      approval={{ id: approval.toolApprovalId, ...(approval.status === "pending" ? {} : { approved: approval.status === "approved" }) }}
      state={state}
      tone={approval.risk === "external" ? "danger" : "default"}
    >
      <div className="flex items-start gap-3">
        <span className={cn("grid size-10 shrink-0 place-items-center rounded-xl bg-subtle", riskTone[approval.risk])}>
          <Icon aria-hidden className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <ConfirmationTitle className="font-medium">{approval.summary}</ConfirmationTitle>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-fg-muted">
            <code className="font-mono">{approval.tool}</code>
            <span aria-hidden>·</span>
            <span className={riskTone[approval.risk]}>{t[`risk_${approval.risk}`]}</span>
            <span aria-hidden>·</span>
            <time dateTime={approval.createdAt}>{relativeTime(approval.createdAt)}</time>
          </p>
          <Disclosure summary={t.input} className="mt-1">
            <div className="mt-1 max-h-60 overflow-auto rounded-lg">
              <CodeBlock code={json(approval.input)} language="json" />
            </div>
          </Disclosure>
        </div>
      </div>
      <ConfirmationRequest>
        <ConfirmationActions>
          <ConfirmationAction size="md" variant="primary" onClick={() => run(true)} disabled={decide.isPending}>
            <Check aria-hidden />
            {t.approve}
          </ConfirmationAction>
          {approval.risk !== "external" && (
            <ConfirmationAction size="md" onClick={() => run(true, true)} disabled={decide.isPending}>
              <ShieldCheck aria-hidden />
              {t.alwaysAllow}
            </ConfirmationAction>
          )}
          <ConfirmationAction size="md" variant="danger" onClick={() => run(false)} disabled={decide.isPending}>
            <X aria-hidden />
            {t.deny}
          </ConfirmationAction>
        </ConfirmationActions>
      </ConfirmationRequest>
    </Confirmation>
  );
}
