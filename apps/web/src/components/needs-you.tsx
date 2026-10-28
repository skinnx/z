import type { Task } from "@z/core";
import { Check, Hand } from "lucide-react";
import { Link } from "react-router";
import type { NeedsYou } from "../api/needs.ts";
import { useTaskAction } from "../api/tasks.ts";
import { useT } from "../i18n.ts";
import { cn } from "../lib/cn.ts";
import { StatusIcon } from "../lib/icons.tsx";
import { Button, buttonClass } from "../ui/button.tsx";
import { Card, Section, Spinner } from "../ui/card.tsx";
import { notify, notifyError } from "../ui/toast.tsx";
import { ApprovalCard } from "./approval-card.tsx";
import { TaskQuestion } from "./task-question.tsx";
import { serverText } from "../lib/server-text.ts";

const taskPath = (id: string) => `/tasks?task=${id}`;
const WORKING_SHOWN = 3;

/** Markdown read as plain text, for a short preview of a result. */
const plain = (md: string) =>
  md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/gm, "")
    .replace(/(\*\*|__|\*|_|`)(.+?)\1/g, "$2")
    .replace(/\n{2,}/g, "\n")
    .trim();

/**
 * One block for everything waiting on the owner, most urgent first: approvals, questions (answered
 * inline), results to review, interrupted runs; then one quiet "Working on" line. Renders nothing
 * when there is nothing.
 */
export function NeedsYouBlock({ needs, titles }: { needs: NeedsYou; titles: Map<string, string> }) {
  const t = useT();
  if (needs.count === 0 && needs.working.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      {needs.count > 0 && (
        <Section label={`${t.needsYou} (${needs.count})`} icon={<Hand aria-hidden className="text-warn" />}>
          <ul aria-live="polite" className="flex flex-col gap-3">
            {needs.approvals.map((a) => (
              <li key={a.id}>
                <ApprovalCard approval={a} taskTitle={titles.get(a.taskId)} />
              </li>
            ))}
            {needs.questions.map((task) => (
              <li key={task.id}>
                <Card className="flex flex-col gap-3 p-4">
                  <TaskHeading task={task} />
                  <TaskQuestion task={task} />
                </Card>
              </li>
            ))}
            {needs.reviews.map((task) => (
              <li key={task.id}>
                <ResolveCard task={task} preview={task.result ? plain(task.result) : ""} />
              </li>
            ))}
            {needs.interrupted.map((task) => (
              <li key={task.id}>
                <ResolveCard task={task} preview={task.error ? serverText(task.error, task.errorMsg) : ""} danger />
              </li>
            ))}
          </ul>
        </Section>
      )}
      {needs.working.length > 0 && <WorkingOn tasks={needs.working} />}
    </div>
  );
}

function TaskHeading({ task }: { task: Task }) {
  const t = useT();
  return (
    <Link to={taskPath(task.id)} className="flex items-start gap-3 rounded-md hover:underline">
      <StatusIcon status={task.status} t={t} className="mt-0.5 size-4" />
      <span className="min-w-0 flex-1">
        <span className="block font-medium leading-snug break-words">{task.title}</span>
        <span className={cn("mt-0.5 block text-xs", task.status === "interrupted" ? "text-danger" : "text-fg-muted")}>{t[`status_${task.status}`]}</span>
      </span>
    </Link>
  );
}

/** A finished (or interrupted) run: what it produced, and Resolve right here. */
function ResolveCard({ task, preview, danger }: { task: Task; preview: string; danger?: boolean }) {
  const t = useT();
  const action = useTaskAction();
  const resolve = () =>
    action.mutate({ id: task.id, action: "resolve" }, { onSuccess: () => notify("success", t.resolvedToast, task.title), onError: notifyError });
  return (
    <Card className="flex flex-col gap-3 p-4">
      <TaskHeading task={task} />
      {preview && (
        <p className={cn("ms-7 line-clamp-3 text-sm leading-relaxed whitespace-pre-line break-words", danger ? "text-danger" : "text-fg")}>{preview}</p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Link to={taskPath(task.id)} className={buttonClass("ghost", "sm")}>
          {t.open}
          <span className="sr-only">: {task.title}</span>
        </Link>
        <Button size="sm" variant="primary" onClick={resolve} disabled={action.isPending}>
          {action.isPending ? <Spinner /> : <Check aria-hidden />}
          {t.markResolved}
          <span className="sr-only">: {task.title}</span>
        </Button>
      </div>
    </Card>
  );
}

/** Running and queued work, compact: it needs nothing yet, but Today shows that z is on it. */
function WorkingOn({ tasks }: { tasks: Task[] }) {
  const t = useT();
  const shown = tasks.slice(0, WORKING_SHOWN);
  const more = tasks.length - shown.length;
  return (
    <p role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-sm text-fg-muted">
      <Spinner className="text-accent-text" />
      <span className="font-medium text-fg">{t.workingOn}:</span>
      {shown.map((task, i) => (
        <span key={task.id} className="min-w-0 break-words">
          <Link to={taskPath(task.id)} className="underline-offset-2 hover:text-fg hover:underline">
            {task.title}
          </Link>
          {i < shown.length - 1 && <span aria-hidden>,</span>}
        </span>
      ))}
      {more > 0 && (
        <Link to="/tasks" className="underline-offset-2 hover:text-fg hover:underline">
          {t.moreTasks(more)}
        </Link>
      )}
    </p>
  );
}
