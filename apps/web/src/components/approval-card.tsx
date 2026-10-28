import type { Approval, ApprovalPreview } from "@z/core";
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
          {approval.reason && <p className="mt-2 text-sm text-warn">{t.askingBecause(approval.reason)}</p>}
          <ApprovalPreviewView preview={approval.preview} />
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

/** Everything the approval acts on, nothing cut: short fields inline, long ones (the body) as scrollable text. */
function ApprovalPreviewView({ preview }: { preview: ApprovalPreview }) {
  if (!preview.fields.length) return null;
  const long = (value: string) => value.includes("\n") || value.length > 80;
  return (
    <dl className="mt-3 flex flex-col gap-2 rounded-lg bg-subtle p-3 text-sm">
      {preview.fields.map((field, i) => (
        <div key={i} className={long(field.value) ? "flex flex-col gap-1" : "flex flex-wrap items-baseline gap-x-2"}>
          <dt className="text-xs font-medium text-fg-muted">{field.label}</dt>
          <dd className={cn("min-w-0 break-words", long(field.value) && "max-h-80 overflow-auto whitespace-pre-wrap")}>{field.value}</dd>
        </div>
      ))}
    </dl>
  );
}
