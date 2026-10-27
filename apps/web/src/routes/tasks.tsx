import type { Task, TaskEvent, TaskStatus } from "@z/core";
import { Ban, Bot, Cpu, Footprints, ListChecks, Play, Plus, ShieldAlert, SquarePen, Trash2, Wrench } from "lucide-react";
import { Streamdown } from "streamdown";
import { useSearchParams } from "react-router";
import { useEffect, useState } from "react";
import { useDeleteTask, useTaskAction, useTasks } from "../api/tasks.ts";
import { Composer } from "../components/composer.tsx";
import { useT, type Dict } from "../i18n.ts";
import { compact, dateTime, json, relativeTime, time } from "../lib/format.ts";
import { parseCron } from "../lib/cron.ts";
import { StatusIcon } from "../lib/icons.tsx";
import { Confirm } from "../ui/alert-dialog.tsx";
import { Button } from "../ui/button.tsx";
import { Badge, Card, Empty, Loading, LoadError } from "../ui/card.tsx";
import { Disclosure } from "../ui/collapsible.tsx";
import { Dialog } from "../ui/dialog.tsx";
import { Drawer } from "../ui/drawer.tsx";
import { TabList, TabPanel, TabsRoot } from "../ui/tabs.tsx";
import { notifyError } from "../ui/toast.tsx";

type Tab = "active" | "scheduled" | "done";
const TAB_OF: Record<TaskStatus, Tab> = {
  queued: "active",
  running: "active",
  waiting: "active",
  scheduled: "scheduled",
  done: "done",
  failed: "done",
  cancelled: "done",
};

export function scheduleText(schedule: string | null, t: Dict): string | null {
  if (!schedule) return null;
  const c = parseCron(schedule);
  if (c.preset === "daily") return `${t.sched_daily} ${t.at} ${c.time}`;
  if (c.preset === "weekdays") return `${t.sched_weekdays} ${t.at} ${c.time}`;
  return schedule;
}

export default function Tasks() {
  const t = useT();
  const tasks = useTasks();
  const [params, setParams] = useSearchParams();
  const [composeOpen, setComposeOpen] = useState(false);
  const openId = params.get("task");
  const list = tasks.data ?? [];
  const open = list.find((x) => x.id === openId) ?? null;
  const by = (tab: Tab) => list.filter((x) => TAB_OF[x.status] === tab);
  const active = by("active");
  const [tab, setTab] = useState<Tab | null>(null);
  const initialTab: Tab = open ? TAB_OF[open.status] : active.length || !list.length ? "active" : by("scheduled").length ? "scheduled" : "done";
  // Pick the tab once data is in, then keep the user's choice (remounting would drop focus).
  useEffect(() => {
    if (tasks.data && tab === null) setTab(initialTab);
  }, [tasks.data, tab, initialTab]);
  useEffect(() => {
    if (open) setTab(TAB_OF[open.status]);
    // only when a different task is opened (e.g. from the command menu)
  }, [openId]);

  const select = (id: string | null) => setParams(id ? { task: id } : {}, { replace: !id });

  const newTask = (
    <Button variant="primary" onClick={() => setComposeOpen(true)}>
      <Plus aria-hidden />
      {t.newTask}
    </Button>
  );

  const empty: Record<Tab, string> = { active: t.noActive, scheduled: t.noScheduled, done: t.noDone };

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 md:px-8 md:py-10">
      <h1 className="sr-only">{t.nav_tasks}</h1>
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
                  { value: "active", label: t.tab_active, count: active.length },
                  { value: "scheduled", label: t.tab_scheduled, count: by("scheduled").length },
                  { value: "done", label: t.tab_done },
                ]}
              />
            </div>
            <div className="mb-1.5 hidden sm:block">{newTask}</div>
          </div>
          {(["active", "scheduled", "done"] as const).map((tab) => {
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
                      {items.map((task) => (
                        <TaskRow key={task.id} task={task} onOpen={() => select(task.id)} />
                      ))}
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
              <span className="truncate">{open.title}</span>
            </>
          )
        }
      >
        {open && <TaskDetail task={open} onDeleted={() => select(null)} />}
      </Drawer>
    </div>
  );
}

function TaskRow({ task, onOpen }: { task: Task; onOpen: () => void }) {
  const t = useT();
  const sched = scheduleText(task.schedule, t);
  return (
    <li>
      <button type="button" onClick={onOpen} className="flex min-h-16 w-full items-center gap-3 px-4 py-3 text-start hover:bg-subtle/60">
        <StatusIcon status={task.status} t={t} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{task.title}</span>
          <span className="mt-0.5 block truncate text-xs text-fg-muted">
            {task.status === "failed" && task.error ? (
              <span className="text-danger">{task.error}</span>
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
      </button>
    </li>
  );
}

function TaskDetail({ task, onDeleted }: { task: Task; onDeleted: () => void }) {
  const t = useT();
  const action = useTaskAction();
  const remove = useDeleteTask();
  const live = task.status === "queued" || task.status === "running" || task.status === "waiting";
  const sched = scheduleText(task.schedule, t);

  return (
    <div className="flex flex-col gap-6 p-4">
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={action.isPending || task.status === "running"} onClick={() => action.mutate({ id: task.id, action: "run" }, { onError: notifyError })}>
          <Play aria-hidden />
          {t.runNow}
        </Button>
        {(live || task.status === "scheduled") && (
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
            <dd className="text-end font-mono text-xs leading-5">{sched}</dd>
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
          {task.error}
        </div>
      )}

      {task.result && (
        <section aria-label={t.result} className="prose-z">
          <Streamdown mode="static">{task.result}</Streamdown>
        </section>
      )}

      {task.events.length > 0 && (
        <section aria-label={t.timeline}>
          <h3 className="mb-3 text-xs font-semibold tracking-wide text-fg-muted uppercase">{t.timeline}</h3>
          <ol className="relative flex flex-col gap-3 border-s border-line ps-5">
            {task.events.map((e, i) => (
              <TimelineItem key={i} event={e} />
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

const eventIcon = { step: Footprints, tool: Wrench, approval: ShieldAlert, model: Cpu } as const;

function TimelineItem({ event }: { event: TaskEvent }) {
  const t = useT();
  const Icon = eventIcon[event.type] ?? Bot;
  return (
    <li className="relative text-sm">
      <span className="absolute -start-[1.9rem] top-0 grid size-5 place-items-center rounded-full border border-line bg-surface text-fg-muted">
        <Icon aria-hidden className="size-3" />
      </span>
      <div className="flex items-baseline gap-2">
        <div className="min-w-0 flex-1 break-words">
          {event.type === "step" && <span className="leading-relaxed">{event.text}</span>}
          {event.type === "tool" && (
            <>
              <code className="font-mono text-xs">{event.tool}</code>
              {event.error && <p className="mt-1 text-xs text-danger">{event.error}</p>}
              <Disclosure summary={t.showDetails}>
                <pre className="mt-1 max-h-48 overflow-auto rounded-lg bg-subtle p-2 font-mono text-xs">
                  {json({ input: event.input, ...(event.output !== undefined ? { output: event.output } : {}) })}
                </pre>
              </Disclosure>
            </>
          )}
          {event.type === "approval" && <span className="text-warn">{t.status_waiting}</span>}
          {event.type === "model" && (
            <span className="text-fg-muted">
              <code className="font-mono text-xs text-fg">{event.model}</code> · {t.tokens(compact(event.tokens))}
            </span>
          )}
        </div>
        <time dateTime={event.at} className="shrink-0 text-xs text-fg-muted tabular-nums">
          {time(event.at)}
        </time>
      </div>
    </li>
  );
}
