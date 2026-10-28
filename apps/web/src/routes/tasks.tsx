import type { Task, TaskEvent, TaskStatus } from "@z/core";
import { Ban, Bot, CircleCheck, Cpu, Footprints, ListChecks, Play, Plus, Radar, ShieldAlert, SquarePen, Trash2, Wrench } from "lucide-react";
import { Streamdown } from "streamdown";
import { useSearchParams } from "react-router";
import { useEffect, useState } from "react";
import { useSettings } from "../api/settings.ts";
import { useDeleteTask, useTaskAction, useTasks } from "../api/tasks.ts";
import { ChainOfThought, ChainOfThoughtContent, ChainOfThoughtHeader, ChainOfThoughtStep } from "../components/ai-elements/chain-of-thought.tsx";
import { CodeBlock } from "../components/ai-elements/code-block.tsx";
import { Task as TaskDisclosure, TaskContent, TaskItem, TaskTrigger } from "../components/ai-elements/task.tsx";
import { Composer } from "../components/composer.tsx";
import { TaskQuestion } from "../components/task-question.tsx";
import { useT, type Dict } from "../i18n.ts";
import { compact, dateTime, json, relativeTime, time } from "../lib/format.ts";
import { parseCron } from "../lib/cron.ts";
import { StatusIcon } from "../lib/icons.tsx";
import { Confirm } from "../ui/alert-dialog.tsx";
import { Button, RowButton } from "../ui/button.tsx";
import { Badge, Card, Empty, Loading, LoadError } from "../ui/card.tsx";
import { Page } from "../ui/page.tsx";
import { Dialog } from "../ui/dialog.tsx";
import { Drawer } from "../ui/drawer.tsx";
import { TabList, TabPanel, TabsRoot } from "../ui/tabs.tsx";
import { notifyError } from "../ui/toast.tsx";
import { serverText } from "../lib/server-text.ts";

type Tab = "needs" | "active" | "scheduled" | "watch" | "done";
const TAB_OF: Record<TaskStatus, Tab> = {
  waiting: "needs",
  needs_input: "needs",
  review: "needs",
  interrupted: "needs",
  queued: "active",
  running: "active",
  scheduled: "scheduled",
  paused: "scheduled",
  done: "done",
  failed: "done",
  cancelled: "done",
};

/** What waits on the owner comes first; otherwise watches live in their own tab whatever their status. */
const tabOf = (task: Task): Tab => (TAB_OF[task.status] === "needs" ? "needs" : task.mode === "watch" ? "watch" : TAB_OF[task.status]);

export function scheduleText(schedule: string | null, t: Dict): string | null {
  if (!schedule) return null;
  const c = parseCron(schedule);
  if (c.preset === "daily") return `${t.sched_daily} ${t.at} ${c.time}`;
  if (c.preset === "weekdays") return `${t.sched_weekdays} ${t.at} ${c.time}`;
  if (schedule.trim() === "0 * * * *") return t.every_hourly;
  if (schedule.trim() === "0 */4 * * *") return t.every_4h;
  return schedule;
}

export default function Tasks() {
  const t = useT();
  const tasks = useTasks();
  useSettings(); // run times are shown in the configured timezone (lib/format): re-render once it is known
  const [params, setParams] = useSearchParams();
  const [composeOpen, setComposeOpen] = useState(false);
  const openId = params.get("task");
  const list = tasks.data ?? [];
  const open = list.find((x) => x.id === openId) ?? null;
  const by = (tab: Tab) => list.filter((x) => tabOf(x) === tab);
  const active = by("active");
  const needs = by("needs");
  const [tab, setTab] = useState<Tab | null>(null);
  const initialTab: Tab = open
    ? tabOf(open)
    : needs.length
      ? "needs"
      : active.length || !list.length
      ? "active"
      : by("scheduled").length
        ? "scheduled"
        : by("watch").length
          ? "watch"
          : "done";
  // Pick the tab once data is in, then keep the user's choice (remounting would drop focus).
  useEffect(() => {
    if (tasks.data && tab === null) setTab(initialTab);
  }, [tasks.data, tab, initialTab]);
  useEffect(() => {
    if (open) setTab(tabOf(open));
    // only when a different task is opened (e.g. from the command menu)
  }, [openId]);

  const select = (id: string | null) => setParams(id ? { task: id } : {}, { replace: !id });

  const newTask = (
    <Button variant="primary" onClick={() => setComposeOpen(true)}>
      <Plus aria-hidden />
      {t.newTask}
    </Button>
  );

  const empty: Record<Tab, string> = { needs: t.noNeeds, active: t.noActive, scheduled: t.noScheduled, watch: t.noWatches, done: t.noDone };

  return (
    <Page title={t.nav_tasks}>
      {tasks.isPending ? (
        <Loading label={t.loading} />
      ) : tasks.error && !tasks.data ? (
        <LoadError error={tasks.error} onRetry={() => void tasks.refetch()} retryLabel={t.retry} />
      ) : (
        <TabsRoot value={tab ?? initialTab} onValueChange={(v) => setTab(v as Tab)}>
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1 overflow-x-auto">
              <TabList
                label={t.nav_tasks}
                tabs={[
                  { value: "needs", label: t.tab_needs, count: needs.length },
                  { value: "active", label: t.tab_active, count: active.length },
                  { value: "scheduled", label: t.tab_scheduled, count: by("scheduled").length },
                  { value: "watch", label: t.tab_watch, count: by("watch").length, icon: <Radar aria-hidden /> },
                  { value: "done", label: t.tab_done },
                ]}
              />
            </div>
            <div className="mb-1.5 hidden sm:block">{newTask}</div>
          </div>
          {(["needs", "active", "scheduled", "watch", "done"] as const).map((tab) => {
            const items = by(tab);
            return (
              <TabPanel key={tab} value={tab} className="pt-4">
                {items.length === 0 ? (
                  <Empty icon={<ListChecks />} text={empty[tab]}>
                    {newTask}
                  </Empty>
                ) : (
                  <Card>
                    <ul className="divide-y divide-line">
                      {items.map((task) =>
                        task.mode === "watch" ? (
                          <WatchRow key={task.id} task={task} onOpen={() => select(task.id)} />
                        ) : (
                          <TaskRow key={task.id} task={task} onOpen={() => select(task.id)} />
                        ),
                      )}
                    </ul>
                  </Card>
                )}
              </TabPanel>
            );
          })}
        </TabsRoot>
      )}

      <div className="fixed end-4 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-20 sm:hidden">
        <Button variant="primary" size="icon" aria-label={t.newTask} onClick={() => setComposeOpen(true)} className="size-14 rounded-2xl shadow-lg">
          <SquarePen aria-hidden className="size-6!" />
        </Button>
      </div>

      <Dialog.Root open={composeOpen} onOpenChange={setComposeOpen}>
        <Dialog.Content title={t.newTask} wide>
          <Composer autoFocus onDone={() => setComposeOpen(false)} />
        </Dialog.Content>
      </Dialog.Root>

      <Drawer
        open={!!open}
        onOpenChange={(o) => !o && select(null)}
        title={
          open && (
            <>
              <StatusIcon status={open.status} t={t} />
              <span className="truncate" title={open.title}>
                {open.title}
              </span>
            </>
          )
        }
      >
        {open && <TaskDetail task={open} onDeleted={() => select(null)} />}
      </Drawer>
    </Page>
  );
}

function TaskRow({ task, onOpen }: { task: Task; onOpen: () => void }) {
  const t = useT();
  const sched = scheduleText(task.schedule, t);
  return (
    <li>
      <RowButton onClick={onOpen}>
        <StatusIcon status={task.status} t={t} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium" title={task.title}>
            {task.title}
          </span>
          <span className="mt-0.5 block truncate text-xs text-fg-muted">
            {task.status === "needs_input" && task.question ? (
              <span className="text-warn">{task.question.question}</span>
            ) : (task.status === "failed" || task.status === "interrupted" || task.status === "paused") && task.error ? (
              <span className="text-danger">{serverText(task.error, task.errorMsg)}</span>
            ) : (
              [t[`status_${task.status}`], sched].filter(Boolean).join(" · ")
            )}
          </span>
        </span>
        <span className="shrink-0 text-end text-xs text-fg-muted">
          {task.nextRunAt ? (
            <time dateTime={task.nextRunAt}>{t.nextRun(relativeTime(task.nextRunAt))}</time>
          ) : (
            <time dateTime={task.updatedAt}>{relativeTime(task.updatedAt)}</time>
          )}
        </span>
      </RowButton>
    </li>
  );
}

/** A watch: when it last looked and what it last found. */
function WatchRow({ task, onOpen }: { task: Task; onOpen: () => void }) {
  const t = useT();
  const finding = task.watch?.lastFinding ?? null;
  const checked = task.watch?.lastCheckAt ?? null;
  const busy = task.status === "running" || task.status === "queued";
  return (
    <li>
      <RowButton onClick={onOpen}>
        {busy || task.status === "cancelled" ? (
          <StatusIcon status={task.status} t={t} />
        ) : (
          <Radar role="img" aria-label={t.sched_watch} className={task.error ? "size-5 shrink-0 text-danger" : "size-5 shrink-0 text-accent-text"} />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium" title={task.title}>
            {task.title}
          </span>
          <span className="mt-0.5 block truncate text-xs text-fg-muted">
            {task.error ? (
              <span className="text-danger">{serverText(task.error, task.errorMsg)}</span>
            ) : finding ? (
              <>
                <span className="text-fg">{finding.title}</span> · <time dateTime={finding.at}>{relativeTime(finding.at)}</time>
              </>
            ) : (
              t.noFindingYet
            )}
          </span>
        </span>
        <span className="shrink-0 text-end text-xs text-fg-muted">
          {busy ? (
            t.checkingNow
          ) : checked ? (
            <time dateTime={checked}>{t.checked(relativeTime(checked))}</time>
          ) : (
            scheduleText(task.schedule, t)
          )}
        </span>
      </RowButton>
    </li>
  );
}

function TaskDetail({ task, onDeleted }: { task: Task; onDeleted: () => void }) {
  const t = useT();
  const action = useTaskAction();
  const remove = useDeleteTask();
  const live = ["queued", "running", "waiting", "needs_input"].includes(task.status);
  const sched = scheduleText(task.schedule, t);

  return (
    <div className="flex flex-col gap-6 p-4">
      <TaskQuestion task={task} />
      <div className="flex flex-wrap gap-2">
        {(task.status === "review" || task.status === "interrupted") && (
          <Button variant="primary" disabled={action.isPending} onClick={() => action.mutate({ id: task.id, action: "resolve" }, { onError: notifyError })}>
            <CircleCheck aria-hidden />
            {t.markResolved}
          </Button>
        )}
        <Button
          variant={task.status === "review" || task.status === "interrupted" ? "secondary" : "primary"}
          disabled={action.isPending || task.status === "running"}
          onClick={() => action.mutate({ id: task.id, action: "run" }, { onError: notifyError })}
        >
          <Play aria-hidden />
          {t.runNow}
        </Button>
        {(live || task.status === "scheduled" || task.status === "paused") && (
          <Button disabled={action.isPending} onClick={() => action.mutate({ id: task.id, action: "cancel" }, { onError: notifyError })}>
            <Ban aria-hidden />
            {t.cancelTask}
          </Button>
        )}
        <Confirm
          trigger={
            <Button variant="danger" className="ms-auto">
              <Trash2 aria-hidden />
              {t.delete}
            </Button>
          }
          title={t.deleteTaskConfirm}
          confirmLabel={t.deleteTask}
          onConfirm={() => remove.mutateAsync(task.id).then(onDeleted, notifyError)}
        />
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-fg-muted">{t[`status_${task.status}`]}</dt>
        <dd className="text-end text-fg-muted">
          <time dateTime={task.updatedAt}>{t.updated(relativeTime(task.updatedAt))}</time>
        </dd>
        {sched && (
          <>
            <dt className="text-fg-muted">{t.schedule}</dt>
            <dd className="text-end">{sched}</dd>
          </>
        )}
        {task.nextRunAt && (
          <>
            <dt className="text-fg-muted">{t.nextRun("").trim()}</dt>
            <dd className="text-end">
              <time dateTime={task.nextRunAt}>{dateTime(task.nextRunAt)}</time>
            </dd>
          </>
        )}
        {task.mode === "watch" && (
          <>
            <dt className="text-fg-muted">{t.lastCheck}</dt>
            <dd className="text-end">{task.watch?.lastCheckAt ? <time dateTime={task.watch.lastCheckAt}>{dateTime(task.watch.lastCheckAt)}</time> : "—"}</dd>
          </>
        )}
        <dt className="text-fg-muted">{t.lane}</dt>
        <dd className="text-end">
          <Badge>{t[`lane_${task.lane}`]}</Badge>
        </dd>
        {task.tools && (
          <>
            <dt className="text-fg-muted">{t.tools}</dt>
            <dd className="flex flex-wrap justify-end gap-1">
              {task.tools.map((tool) => (
                <code key={tool} className="rounded bg-subtle px-1.5 py-0.5 font-mono text-xs">
                  {tool}
                </code>
              ))}
            </dd>
          </>
        )}
      </dl>

      <blockquote className="rounded-xl border border-line bg-subtle/50 p-3 text-sm leading-relaxed whitespace-pre-wrap">{task.instructions}</blockquote>

      {task.error && (
        <div role="alert" className="rounded-xl border border-danger/40 bg-danger-soft p-3 text-sm break-words text-danger">
          {serverText(task.error, task.errorMsg)}
        </div>
      )}

      {task.mode === "watch" && task.watch?.lastFinding ? (
        <section aria-label={t.lastFinding} className="flex flex-col gap-1 rounded-xl border border-accent/40 bg-accent-soft/40 p-3">
          <h3 className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-accent-text uppercase">
            <Radar aria-hidden className="size-3.5" />
            {t.lastFinding} · <time dateTime={task.watch.lastFinding.at}>{relativeTime(task.watch.lastFinding.at)}</time>
          </h3>
          <p className="font-medium break-words">{task.watch.lastFinding.title}</p>
          <div className="prose-z text-sm">
            <Streamdown mode="static">{task.watch.lastFinding.body}</Streamdown>
          </div>
        </section>
      ) : (
        task.result && (
          <section aria-label={t.result} className="prose-z">
            <Streamdown mode="static">{task.result}</Streamdown>
          </section>
        )
      )}

      {task.events.length > 0 && (
        <section aria-label={t.timeline}>
          <ChainOfThought defaultOpen>
            <ChainOfThoughtHeader icon={<ListChecks aria-hidden />}>
              <span className="text-xs font-semibold tracking-wide uppercase">{t.timeline}</span>
              <span className="ms-2 text-xs text-fg-muted tabular-nums">{task.events.length}</span>
            </ChainOfThoughtHeader>
            <ChainOfThoughtContent>
              {task.events.map((e, i) => (
                <TimelineStep key={i} event={e} active={task.status === "running" && i === task.events.length - 1} />
              ))}
            </ChainOfThoughtContent>
          </ChainOfThought>
        </section>
      )}
    </div>
  );
}

const eventIcon = { step: Footprints, tool: Wrench, approval: ShieldAlert, model: Cpu } as const;

function TimelineStep({ event, active }: { event: TaskEvent; active: boolean }) {
  const t = useT();
  const meta = <time dateTime={event.at}>{time(event.at)}</time>;
  const status = active ? "active" : "complete";
  const icon = eventIcon[event.type] ?? Bot;
  if (event.type === "tool") {
    return (
      <ChainOfThoughtStep icon={icon} status={status} meta={meta} label={<code className="font-mono text-xs">{event.tool}</code>} description={event.error && <span className="text-danger">{event.error}</span>}>
        <TaskDisclosure defaultOpen={false}>
          <TaskTrigger title={t.showDetails} icon={<Wrench aria-hidden />} />
          <TaskContent>
            <TaskItem>
              <CodeBlock code={json({ input: event.input, ...(event.output !== undefined ? { output: event.output } : {}) })} language="json" />
            </TaskItem>
          </TaskContent>
        </TaskDisclosure>
      </ChainOfThoughtStep>
    );
  }
  const label =
    event.type === "step" ? (
      event.text
    ) : event.type === "approval" ? (
      <span className="text-warn">{t.status_waiting}</span>
    ) : (
      <span className="text-fg-muted">
        <code className="font-mono text-xs text-fg">{event.model}</code> · {t.tokens(compact(event.tokens))}
      </span>
    );
  return <ChainOfThoughtStep icon={icon} status={status} meta={meta} label={label} />;
}
