import type { BriefItem, Briefing } from "@z/core";
import { ArrowUpRight, KeyRound, RefreshCw, ShieldAlert, Sparkles, Sunrise } from "lucide-react";
import { useEffect, useRef } from "react";
import { Link, Navigate, useSearchParams } from "react-router";
import { usePendingApprovals } from "../api/approvals.ts";
import { useBriefing, useGenerateBriefing } from "../api/briefing.ts";
import { useProviders } from "../api/providers.ts";
import { useSettings } from "../api/settings.ts";
import { useCreateTask } from "../api/tasks.ts";
import { ApprovalCard } from "../components/approval-card.tsx";
import { Composer } from "../components/composer.tsx";
import { useT } from "../i18n.ts";
import { cn } from "../lib/cn.ts";
import { parseCron } from "../lib/cron.ts";
import { longDate, relativeTime } from "../lib/format.ts";
import { briefKindIcon } from "../lib/icons.tsx";
import { Button, buttonClass } from "../ui/button.tsx";
import { Card, Empty, Section, Spinner } from "../ui/card.tsx";
import { IconButton } from "../ui/icon-button.tsx";
import { notify, notifyError } from "../ui/toast.tsx";

const FIRST_RUN_KEY = "z.first-run-redirected";

export default function Today() {
  const t = useT();
  const approvals = usePendingApprovals();
  const providers = useProviders();
  const [params, setParams] = useSearchParams();
  const composerRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (params.has("compose")) {
      composerRef.current?.focus();
      setParams({}, { replace: true });
    }
  }, [params, setParams]);

  // First run: without a provider nothing works, so the models screen comes first (once).
  if (providers.data && providers.data.length === 0 && !sessionStorage.getItem(FIRST_RUN_KEY)) {
    sessionStorage.setItem(FIRST_RUN_KEY, "1");
    return <Navigate to="/models" replace />;
  }
  const noProviders = providers.data?.length === 0;
  const pending = approvals.data ?? [];

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-6 md:px-8 md:py-10">
      <h1 className="sr-only">{t.nav_today}</h1>

      {pending.length > 0 && (
        <Section label={`${t.approvals} (${pending.length})`} icon={<ShieldAlert aria-hidden className="text-warn" />}>
          <div aria-live="polite" className="flex flex-col gap-3">
            {pending.map((a) => (
              <ApprovalCard key={a.id} approval={a} />
            ))}
          </div>
        </Section>
      )}

      <Section label={t.delegate} hideLabel>
        {noProviders ? (
          <Empty icon={<KeyRound />} text={t.noModels}>
            <Link to="/models" className={buttonClass("primary")}>
              <KeyRound aria-hidden />
              {t.addProvider}
            </Link>
          </Empty>
        ) : (
          <Composer inputRef={composerRef} />
        )}
      </Section>

      <BriefingSection />
    </div>
  );
}

function BriefingSection() {
  const t = useT();
  const briefing = useBriefing();
  const generate = useGenerateBriefing();
  const settings = useSettings();
  const cron = parseCron(settings.data?.briefingCron);
  const run = () => generate.mutate(undefined, { onError: notifyError });

  if (briefing.isPending) {
    return (
      <div role="status" className="grid h-32 place-items-center text-fg-muted">
        <Spinner />
        <span className="sr-only">{t.loading}</span>
      </div>
    );
  }

  const data = briefing.data;
  if (!data) {
    return (
      <Section label={t.briefing} icon={<Sunrise aria-hidden />}>
        <Empty icon={<Sunrise />} text={cron.preset === "custom" ? t.noBriefing : `${t.noBriefing} ${t.briefingAt(cron.time)}`}>
          <Button variant="primary" onClick={run} disabled={generate.isPending}>
            {generate.isPending ? <Spinner /> : <Sparkles aria-hidden />}
            {t.generateBriefing}
          </Button>
        </Empty>
      </Section>
    );
  }

  return (
    <Section
      label={`${t.briefing} · ${longDate(data.date)}`}
      icon={<Sunrise aria-hidden />}
      actions={
        <IconButton label={t.regenerate} size="icon-sm" onClick={run} disabled={generate.isPending}>
          <RefreshCw aria-hidden className={cn(generate.isPending && "motion-safe:animate-spin")} />
        </IconButton>
      }
    >
      <BriefingBody briefing={data} />
    </Section>
  );
}

function BriefingBody({ briefing }: { briefing: Briefing }) {
  const groups = new Map<string, BriefItem[]>();
  for (const item of briefing.items) groups.set(item.source, [...(groups.get(item.source) ?? []), item]);

  return (
    <div className="flex flex-col gap-4">
      {briefing.summary && <p className="text-[1.0625rem] leading-relaxed text-pretty">{briefing.summary}</p>}
      <div className="@container grid gap-3">
        {[...groups].map(([source, items]) => (
          <Card key={source} className="overflow-hidden">
            <h3 className="border-b border-line bg-subtle/60 px-4 py-2 font-mono text-xs font-medium text-fg-muted">{source}</h3>
            <ul className="divide-y divide-line">
              {items.map((item) => (
                <BriefRow key={item.id} item={item} />
              ))}
            </ul>
          </Card>
        ))}
      </div>
      <p className="text-xs text-fg-muted">
        <time dateTime={briefing.createdAt}>{relativeTime(briefing.createdAt)}</time>
      </p>
    </div>
  );
}

function BriefRow({ item }: { item: BriefItem }) {
  const t = useT();
  const create = useCreateTask();
  const Icon = briefKindIcon[item.kind];
  return (
    <li className="flex flex-col gap-2 px-4 py-3 @lg:flex-row @lg:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <Icon role="img" aria-label={t[`kind_${item.kind}`]} className="mt-0.5 size-4 shrink-0 text-fg-muted" />
        <p className="min-w-0 flex-1 text-sm leading-relaxed break-words">
          {item.url ? (
            <a href={item.url} target="_blank" rel="noreferrer" className="hover:underline">
              {item.text}
              <ArrowUpRight aria-hidden className="ms-0.5 inline size-3.5 text-fg-muted" />
              <span className="sr-only">({t.openLink})</span>
            </a>
          ) : (
            item.text
          )}
        </p>
      </div>
      {item.suggestion && (
        <Button
          size="sm"
          variant="secondary"
          className="ms-7 h-auto min-h-8 max-w-full justify-start py-1.5 text-start whitespace-normal @lg:ms-0 @lg:max-w-72"
          disabled={create.isPending || create.isSuccess}
          onClick={() =>
            create.mutate(
              { instructions: item.suggestion! },
              { onSuccess: (task) => notify("success", t.taskQueued, task.title), onError: notifyError },
            )
          }
        >
          <Sparkles aria-hidden className="text-accent-text" />
          <span>
            <span className="sr-only">{t.delegateSuggestion}: </span>
            {item.suggestion}
          </span>
        </Button>
      )}
    </li>
  );
}
