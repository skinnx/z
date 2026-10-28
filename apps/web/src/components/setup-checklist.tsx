/**
 * The setup checklist: one row per real check, each with its fix. Settings → Setup shows it as rows;
 * Today shows it as the whole screen until a chat model has answered.
 */
import type { SetupChecklist, SetupRow, SetupState } from "@z/core";
import { ArrowUpRight, Check, CircleAlert, CircleCheck, CircleDashed, CircleMinus, RefreshCw } from "lucide-react";
import { useEffect } from "react";
import { useProviders } from "../api/providers.ts";
import { useAckSetup, useCheckSetup, useSetup } from "../api/setup.ts";
import { useT } from "../i18n.ts";
import { cn } from "../lib/cn.ts";
import { relativeTime } from "../lib/format.ts";
import { isSection, useSettingsRoute } from "../settings/route.ts";
import { Button } from "../ui/button.tsx";
import { LoadError, Loading, Spinner } from "../ui/card.tsx";
import { Row } from "../ui/row.tsx";
import { notifyError } from "../ui/toast.tsx";

const stateIcon: Record<SetupState, { icon: typeof CircleCheck; className: string }> = {
  ready: { icon: CircleCheck, className: "text-ok" },
  needs_setup: { icon: CircleAlert, className: "text-warn" },
  not_checked: { icon: CircleDashed, className: "text-fg-muted" },
  optional: { icon: CircleMinus, className: "text-fg-muted" },
};

/** Ready and optional rows need nothing; the rest count against the summary. */
export const setupCounts = (list: SetupChecklist) => ({
  ready: list.rows.filter((r) => r.state === "ready").length,
  total: list.rows.filter((r) => r.state !== "optional").length,
});

/** Run the live checks once per page load when the chat model was never tested (e.g. right after adding it). */
let autoChecked = false;

export function SetupChecklistView({ autoCheck = false, className }: { autoCheck?: boolean; className?: string }) {
  const t = useT();
  const setup = useSetup();
  const check = useCheckSetup();
  // With no provider there is nothing to check yet: the row's own fix ("Add a provider") leads instead.
  const nothingToCheck = useProviders().data?.length === 0;
  const chat = setup.data?.rows.find((r) => r.id === "chat_model");
  const untested = chat?.state === "not_checked" && chat.detail.endsWith("send it a test message.");

  useEffect(() => {
    if (autoCheck && untested && !autoChecked) {
      autoChecked = true;
      check.mutate(undefined, { onError: notifyError });
    }
  }, [autoCheck, untested]); // eslint-disable-line react-hooks/exhaustive-deps

  if (setup.isPending) return <Loading label={t.loading} />;
  if (setup.isError) return <LoadError error={setup.error} onRetry={() => void setup.refetch()} retryLabel={t.retry} />;

  const list = setup.data;
  const { ready, total } = setupCounts(list);
  const busy = check.isPending;

  return (
    <div className={cn("flex flex-col", className)}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3.5">
        {!nothingToCheck && (
          <Button variant="primary" size="sm" onClick={() => check.mutate(undefined, { onError: notifyError })} disabled={busy} aria-busy={busy || undefined}>
            {busy ? <Spinner /> : <RefreshCw aria-hidden />}
            {busy ? t.checking : t.checkAgain}
          </Button>
        )}
        <p aria-live="polite" className="min-w-0 text-sm text-fg-muted">
          <span className="font-medium text-fg">{t.setupSummary(ready, total)}</span>
          {" · "}
          {list.checkedAt ? <time dateTime={list.checkedAt}>{t.setupCheckedAt(relativeTime(list.checkedAt))}</time> : t.setupNeverChecked}
        </p>
      </div>
      <ul className="divide-y divide-line border-t border-line">
        {list.rows.map((row) => (
          <li key={row.id}>
            <SetupItem row={row} lead={nothingToCheck && row.id === "chat_model"} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** `lead`: this row's fix is the screen's primary action. */
function SetupItem({ row, lead = false }: { row: SetupRow; lead?: boolean }) {
  const t = useT();
  const route = useSettingsRoute();
  const ack = useAckSetup();
  const { icon: Icon, className } = stateIcon[row.state];

  const go = (path: string) => {
    const section = new URLSearchParams(path.split("?")[1] ?? "").get("settings");
    if (path.startsWith("/?settings=") && isSection(section)) route.open(section);
    else route.leave(path);
  };

  return (
    <Row
      label={
        <span className="flex items-center gap-2">
          <Icon role="img" aria-label={t[`setup_${row.state}`]} className={cn("size-4 shrink-0", className)} />
          {row.label}
        </span>
      }
      hint={<span className="block ps-6 break-words [overflow-wrap:anywhere]">{row.detail}</span>}
    >
      {row.ack || row.fix
        ? ({ labelId }) => (
            <>
              {row.ack && (
                <Button size="sm" aria-describedby={labelId} disabled={ack.isPending} onClick={() => ack.mutate(row.id, { onError: notifyError })}>
                  {ack.isPending ? <Spinner /> : <Check aria-hidden />}
                  {row.ack}
                </Button>
              )}
              {row.fix && (
                <Button size="sm" variant={lead ? "primary" : row.state === "needs_setup" ? "secondary" : "ghost"} aria-describedby={labelId} onClick={() => go(row.fix!.path)}>
                  {row.fix.label}
                  <ArrowUpRight aria-hidden className="rtl:-scale-x-100" />
                </Button>
              )}
            </>
          )
        : undefined}
    </Row>
  );
}
