import type { BriefItem, Briefing, TaskStatus } from "@z/core";
import { Brain, Check, CircleAlert, Hand, KeyRound, Radar, RefreshCw, Sparkles, Sunrise, X } from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useBriefing, useGenerateBriefing } from "../api/briefing.ts";
import { useMemories } from "../api/memories.ts";
import { useNeedsYou } from "../api/needs.ts";
import { useMarkRead, useNotices } from "../api/notices.ts";
import { useProviders } from "../api/providers.ts";
import { useSettings } from "../api/settings.ts";
import { useSetup } from "../api/setup.ts";
import { useCreateTask, useTasks } from "../api/tasks.ts";
import { Source } from "../components/ai-elements/sources.tsx";
import { Composer } from "../components/composer.tsx";
import { NeedsYouBlock } from "../components/needs-you.tsx";
import { SetupChecklistView } from "../components/setup-checklist.tsx";
import { locale, useT, type Dict } from "../i18n.ts";
import { cn } from "../lib/cn.ts";
import { parseCron } from "../lib/cron.ts";
import { longDate, relativeTime } from "../lib/format.ts";
import { briefKindIcon } from "../lib/icons.tsx";
import { Button, buttonClass } from "../ui/button.tsx";
import { MemoryManager } from "../settings/panels/memories.tsx";
import { Card, Empty, Loading, Section, Spinner } from "../ui/card.tsx";
import { Disclosure } from "../ui/collapsible.tsx";
import { Page } from "../ui/page.tsx";
import { Dialog } from "../ui/dialog.tsx";
import { IconButton } from "../ui/icon-button.tsx";
import { notify, notifyError } from "../ui/toast.tsx";
import { serverText } from "../lib/server-text.ts";

/** Set when the owner chose to continue past the first-run checklist, for this tab session. */
const FIRST_RUN_KEY = "z.first-run-skipped";
/** BriefItem source of tasks the briefing proposes (core `PROPOSED_SOURCE`). */
const PROPOSED_SOURCE = "proposed";
/** BriefItem source of the owner's open tasks; core words their text in English. */
const TASKS_SOURCE = "tasks";
const TASK_SUFFIX = /^(.*) \((queued|running|waiting|needs_input|scheduled)\)$/s;
const TASK_PREFIX: [string, "status_waiting" | "status_needs_input"][] = [
  ["Waiting for your approval: ", "status_waiting"],
  ["Waiting for your answer: ", "status_needs_input"],
];

/** Task items read "Title (scheduled)" or "Waiting for your answer: Title": reword them in the owner's language. */
function briefText(item: BriefItem, t: Dict): string {
  if (item.textMsg) return serverText(item.text, item.textMsg);
  if (item.source !== TASKS_SOURCE) return item.text;
  const suffix = TASK_SUFFIX.exec(item.text);
  if (suffix) return `${suffix[1]} (${t[`status_${suffix[2] as TaskStatus}`].toLocaleLowerCase(locale.get())})`;
  for (const [prefix, key] of TASK_PREFIX) if (item.text.startsWith(prefix)) return `${t[key]}: ${item.text.slice(prefix.length)}`;
  return item.text;
}

/** Reason core gives items no model sorted (core `NOT_CHECKED`); shown in the UI language. */
const NOT_CHECKED = "Not checked: no model sorted this item.";

export default function Today() {
  const t = useT();
  const needs = useNeedsYou();
  const tasks = useTasks();
  const providers = useProviders();
  const setup = useSetup();
  const briefing = useBriefing();
  const memories = useMemories();
  const notices = useNotices();
  const [skipSetup, setSkipSetup] = useState(() => Boolean(sessionStorage.getItem(FIRST_RUN_KEY)));
  const composerRef = useRef<HTMLTextAreaElement>(null);

  // First run: until any model has answered, nothing works, so the checklist is the screen. Once one
  // has, or something waits on the owner, a failing chat model is a banner above the rest of Today.
  const chat = setup.data?.rows.find((r) => r.id === "chat_model");
  const firstRun = chat && chat.state !== "ready" && !setup.data?.modelAnswered && (!needs.loaded || needs.count === 0);
  if (firstRun && !skipSetup) {
    return (
      <Page title={t.nav_today} className="gap-4">
        <SetupChecklistView autoCheck />
        <p className="text-sm text-fg-muted">{t.setupFirstRun}</p>
        <div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              sessionStorage.setItem(FIRST_RUN_KEY, "1");
              setSkipSetup(true);
            }}
          >
            {t.continueAnyway}
          </Button>
        </div>
      </Page>
    );
  }
  const noProviders = providers.data?.length === 0;
  const settled = needs.settled && !briefing.isPending && !memories.isPending && !notices.isPending;
  const titles = new Map((tasks.data ?? []).map((x) => [x.id, x.title]));

  return (
    <Page title={t.nav_today}>
      {chat?.state === "needs_setup" && !noProviders && <ChatBanner detail={chat.detail} shown={serverText(chat.detail, chat.detailMsg)} fixPath={chat.fix?.path ?? "/models"} />}
      <Section label={t.delegate} hideLabel>
        {noProviders ? (
          <Empty icon={<KeyRound />} text={t.noModels}>
            <Link to="/models" className={buttonClass("primary")}>
              <KeyRound aria-hidden />
              {t.addProvider}
            </Link>
          </Empty>
        ) : (
          <>
            <Composer inputRef={composerRef} />
            <FocusOnCompose target={composerRef} />
          </>
        )}
      </Section>

      {/* Below the composer, so nothing that arrives moves it. Everything here waits for all of its
          data and then appears at once, in the loader's place: no block pushes another down. */}
      {settled ? (
        <div className="flex flex-col gap-8 motion-safe:animate-rise">
          <NeedsYouBlock needs={needs} titles={titles} />
          <MemoryReview />
          <WatchHits />
          <BriefingSection canGenerate={!noProviders} />
        </div>
      ) : (
        <Loading label={t.loading} className="h-32" />
      )}
    </Page>
  );
}

/**
 * `?compose` focuses the composer. Its own component: reading the URL here, not in Today, keeps
 * every other URL change (settings opening and closing over Today) from re-rendering the screen.
 */
function FocusOnCompose({ target }: { target: RefObject<HTMLTextAreaElement | null> }) {
  const [params, setParams] = useSearchParams();
  const compose = params.has("compose");
  useEffect(() => {
    if (compose) {
      target.current?.focus();
      setParams({}, { replace: true });
    }
  }, [compose, setParams, target]);
  return null;
}

/** One line while z has memories awaiting review; opens the memory manager in place. */
function MemoryReview() {
  const t = useT();
  const waiting = (useMemories().data ?? []).filter((m) => m.status === "unreviewed").length;
  if (waiting === 0) return null;
  return (
    <Card className="flex items-center gap-3 border-accent/40 py-2 ps-4 pe-2">
      <Brain aria-hidden className="size-4 shrink-0 text-accent-text" />
      <p className="min-w-0 flex-1 text-sm font-medium">{t.wantsToRemember(waiting)}</p>
      <Dialog.Root>
        <Dialog.Trigger render={<Button size="sm" />}>{t.review}</Dialog.Trigger>
        <Dialog.Content wide title={t.memories}>
          <MemoryManager />
        </Dialog.Content>
      </Dialog.Root>
    </Card>
  );
}

/** Dismissed for this tab session, per error: a different failure shows again. */
const CHAT_BANNER_KEY = "z.chat-banner-dismissed";
const readSession = (key: string) => {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
};

/** The chat model fails, but the rest of Today keeps working: say so, with the fix, without a wall. */
/** `detail`: the English, which keys the dismissal; `shown`: it in the app's language. */
function ChatBanner({ detail, shown, fixPath }: { detail: string; shown: string; fixPath: string }) {
  const t = useT();
  const [dismissed, setDismissed] = useState(() => readSession(CHAT_BANNER_KEY));
  if (dismissed === detail) return null;
  return (
    <div role="alert" className="flex items-start gap-3 rounded-(--radius-card) border border-danger/50 bg-danger-soft/40 py-2 ps-4 pe-2">
      <CircleAlert aria-hidden className="mt-1.5 size-4 shrink-0 text-danger" />
      <div className="min-w-0 flex-1 py-1">
        <p className="text-sm font-medium">{t.chatFailing}</p>
        <p className="mt-0.5 text-xs break-words text-fg-muted">{shown}</p>
      </div>
      <Link to={fixPath} className={buttonClass("primary", "sm", "shrink-0")}>
        <KeyRound aria-hidden />
        {t.fixModels}
      </Link>
      <IconButton
        label={t.dismiss}
        size="icon-sm"
        className="shrink-0"
        onClick={() => {
          try {
            sessionStorage.setItem(CHAT_BANNER_KEY, detail);
          } catch {
            // private mode: dismissed until reload
          }
          setDismissed(detail);
        }}
      >
        <X aria-hidden />
      </IconButton>
    </div>
  );
}

/** Unread findings from watch tasks: what changed while you were away. */
function WatchHits() {
  const t = useT();
  const navigate = useNavigate();
  const markRead = useMarkRead();
  const hits = (useNotices().data ?? []).filter((n) => n.kind === "watch" && !n.read);
  if (hits.length === 0) return null;

  return (
    <Section
      label={`${t.watchHits} (${hits.length})`}
      icon={<Radar aria-hidden className="text-accent-text" />}
      actions={
        hits.length > 1 && (
          <Button size="sm" variant="ghost" onClick={() => markRead.mutate(hits.map((h) => h.id))}>
            <Check aria-hidden />
            {t.dismissAll}
          </Button>
        )
      }
    >
      <ul aria-live="polite" className="flex flex-col gap-3">
        {hits.map((n) => (
          <li key={n.id}>
            <Card className="flex flex-col gap-3 border-accent/40 p-4">
              <div className="flex items-start gap-3">
                <Radar aria-hidden className="mt-0.5 size-4 shrink-0 text-accent-text" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium leading-snug break-words">{serverText(n.title, n.titleMsg)}</p>
                  {n.body && <p className="mt-1 line-clamp-4 text-sm leading-relaxed break-words text-fg-muted">{serverText(n.body, n.bodyMsg)}</p>}
                  <time dateTime={n.createdAt} className="mt-1 block text-xs text-fg-muted">
                    {relativeTime(n.createdAt)}
                  </time>
                </div>
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => markRead.mutate([n.id])}>
                  <Check aria-hidden />
                  {t.dismiss}
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    markRead.mutate([n.id]);
                    navigate(n.path);
                  }}
                >
                  {t.openWatch}
                </Button>
              </div>
            </Card>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** `canGenerate`: without a provider the only next step is adding one (the card above), so no second CTA here. */
function BriefingSection({ canGenerate }: { canGenerate: boolean }) {
  const t = useT();
  const briefing = useBriefing();
  const generate = useGenerateBriefing();
  const settings = useSettings();
  const cron = parseCron(settings.data?.briefingCron);
  // Until settings are in, the time isn't known (parseCron would say 09:00).
  const at = settings.data && cron.preset !== "custom" ? ` ${t.briefingAt(cron.time)}` : "";
  const run = () => generate.mutate(undefined, { onError: notifyError });

  const data = briefing.data;
  if (!data) {
    return (
      <Section label={t.briefing} icon={<Sunrise aria-hidden />}>
        <Empty icon={<Sunrise />} text={`${t.noBriefing}${at}`}>
          {canGenerate && (
            <Button variant="primary" onClick={run} disabled={generate.isPending}>
              {generate.isPending ? <Spinner /> : <Sparkles aria-hidden />}
              {t.generateBriefing}
            </Button>
          )}
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

/** What needs the owner first, with the reason; z's proposals; then everything that can wait, folded. */
function BriefingBody({ briefing }: { briefing: Briefing }) {
  const t = useT();
  const proposed = briefing.items.filter((i) => i.source === PROPOSED_SOURCE);
  const rest = briefing.items.filter((i) => i.source !== PROPOSED_SOURCE);
  const needs = rest.filter((i) => i.priority !== "can_wait");
  const canWait = rest.filter((i) => i.priority === "can_wait");

  return (
    <div className="flex flex-col gap-4">
      {briefing.summary && <p className="text-[1.0625rem] leading-relaxed text-pretty">{serverText(briefing.summary, briefing.summaryMsg)}</p>}
      <div className="@container grid gap-3">
        {needs.length > 0 ? (
          <Card className="overflow-hidden border-warn/40">
            <h3 className="flex items-center gap-1.5 border-b border-line bg-warn-soft/50 px-4 py-2 text-xs font-semibold">
              <Hand aria-hidden className="size-3.5 text-warn" />
              {t.needsYou} ({needs.length})
            </h3>
            <ul className="divide-y divide-line">
              {needs.map((item) => (
                <BriefRow key={item.id} item={item} />
              ))}
            </ul>
          </Card>
        ) : (
          rest.length > 0 && (
            <p className="flex items-center gap-2 text-sm text-fg-muted">
              <Check aria-hidden className="size-4" />
              {t.nothingNeedsYou}
            </p>
          )
        )}
        {proposed.length > 0 && (
          <Card className="overflow-hidden">
            <h3 className="flex items-center gap-1.5 border-b border-line bg-accent-soft/60 px-4 py-2 text-xs font-semibold text-accent-text">
              <Sparkles aria-hidden className="size-3.5" />
              {t.proposedTasks}
            </h3>
            <ul className="divide-y divide-line">
              {proposed.map((item) => (
                <BriefRow key={item.id} item={item} proposed />
              ))}
            </ul>
          </Card>
        )}
        {canWait.length > 0 && (
          <Disclosure summary={t.canWait(canWait.length)}>
            <Card className="mt-2 overflow-hidden">
              <ul className="divide-y divide-line">
                {canWait.map((item) => (
                  <BriefRow key={item.id} item={item} />
                ))}
              </ul>
            </Card>
          </Disclosure>
        )}
      </div>
      {briefing.couldNotCheck?.length ? (
        <section aria-label={t.couldNotCheck} className="flex flex-col gap-1 text-sm">
          <h3 className="flex items-center gap-1.5 text-xs font-semibold text-fg-muted">
            <CircleAlert aria-hidden className="size-3.5 text-warn" />
            {t.couldNotCheck}
          </h3>
          <ul className="flex flex-col gap-0.5 text-fg-muted">
            {briefing.couldNotCheck.map((c) => (
              <li key={c.source} className="break-words">
                <span className="font-mono text-xs text-fg">{c.source}</span> · {c.reason}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <p className="text-xs text-fg-muted">
        <time dateTime={briefing.createdAt}>{relativeTime(briefing.createdAt)}</time>
      </p>
    </div>
  );
}

function BriefRow({ item, proposed }: { item: BriefItem; proposed?: boolean }) {
  const t = useT();
  const create = useCreateTask();
  const Icon = briefKindIcon[item.kind];
  const reason = item.reasonMsg ? serverText(item.reason, item.reasonMsg) : item.reason === NOT_CHECKED ? t.notChecked : item.reason;
  return (
    <li className="flex flex-col gap-2 px-4 py-3 @lg:flex-row @lg:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <Icon role="img" aria-label={t[`kind_${item.kind}`]} className="mt-0.5 size-4 shrink-0 text-fg-muted" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="text-sm leading-relaxed break-words">{briefText(item, t)}</p>
          {!proposed && (
            <p className="text-xs leading-relaxed break-words text-fg-muted">
              <span>{item.source === TASKS_SOURCE ? t.group_tasks : item.source}</span>
              {reason && <> · {reason}</>}
            </p>
          )}
          {item.url && <Source href={item.url} className="text-xs" aria-label={`${briefText(item, t)} (${t.openLink})`} />}
        </div>
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
              { onSuccess: (task) => notify("success", t.taskQueued, task.title) },
            )
          }
        >
          <Sparkles aria-hidden className="text-accent-text" />
          <span className="min-w-0 whitespace-normal [overflow-wrap:anywhere]">
            <span className="sr-only">{t.delegateSuggestion}: </span>
            {item.suggestion}
          </span>
        </Button>
      )}
    </li>
  );
}
