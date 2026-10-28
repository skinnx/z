import type { Notice } from "@z/core";
import { Bell, Check, CheckCheck, Clock, Send, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useDecide } from "../api/approvals.ts";
import { useMarkRead, useNotices } from "../api/notices.ts";
import { keys, queryClient } from "../api/query.ts";
import { useAnswerTask } from "../api/tasks.ts";
import { useT } from "../i18n.ts";
import { cn } from "../lib/cn.ts";
import { relativeTime } from "../lib/format.ts";
import { NoticeIcon, noticeTitle } from "../lib/icons.tsx";
import { useServerText } from "../lib/server-text.ts";
import { Button } from "../ui/button.tsx";
import { Badge } from "../ui/card.tsx";
import { Field, Input } from "../ui/field.tsx";
import { IconButton } from "../ui/icon-button.tsx";
import { Drawer } from "../ui/drawer.tsx";
import { Popover } from "../ui/popover.tsx";
import { notifyError } from "../ui/toast.tsx";

export function useUnreadCount(): number {
  return useNotices().data?.filter((n) => !n.read).length ?? 0;
}

/** Opening a notice goes to its screen and marks it read. */
function useOpenNotice(onDone: () => void) {
  const navigate = useNavigate();
  const markRead = useMarkRead();
  return (n: Notice) => {
    if (!n.read) markRead.mutate([n.id]);
    onDone();
    navigate(n.path);
  };
}

function NoticeList({ onDone, titled }: { onDone: () => void; titled?: boolean }) {
  const t = useT();
  const st = useServerText();
  const notices = useNotices().data ?? [];
  const markRead = useMarkRead();
  const open = useOpenNotice(onDone);
  const unread = notices.some((n) => !n.read);
  // Handled elsewhere (decided, answered) but still unread, e.g. from before z marked them: read them.
  const handled = notices
    .filter((n) => !n.read && ((n.approvalStatus && n.approvalStatus !== "pending") || n.question?.answer !== undefined))
    .map((n) => n.id)
    .join(",");
  useEffect(() => {
    if (handled) markRead.mutate(handled.split(","));
  }, [handled]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-1.5">
        <span className="text-xs font-semibold tracking-wide text-fg-muted uppercase">{titled ? "" : t.notices}</span>
        <Button size="sm" variant="ghost" disabled={!unread} onClick={() => markRead.mutate(undefined)}>
          <CheckCheck aria-hidden />
          {t.markAllRead}
        </Button>
      </div>
      {notices.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-fg-muted">{t.noNotices}</p>
      ) : (
        <ul className="min-h-0 flex-1 divide-y divide-line overflow-y-auto overscroll-contain">
          {notices.map((n) => {
            return (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => open(n)}
                  className="flex w-full items-start gap-3 px-3 py-3 text-start hover:bg-subtle/70 focus-visible:bg-subtle focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                >
                  <NoticeIcon notice={n} t={t} className="mt-0.5 size-4" />
                  <span className="min-w-0 flex-1">
                    <span className={cn("block text-sm leading-snug break-words", !n.read && "font-semibold")}>{noticeTitle(n, t)}</span>
                    {n.body && (
                      <span
                        className={cn(
                          "mt-0.5 text-xs leading-relaxed break-words text-fg-muted",
                          // Approve only what you can see: a pending approval's preview is shown whole.
                          n.approvalStatus === "pending" ? "block max-h-48 overflow-y-auto whitespace-pre-wrap" : "line-clamp-2",
                        )}
                      >
                        {st(n.body, n.bodyMsg)}
                      </span>
                    )}
                    <time dateTime={n.createdAt} className="mt-1 block text-[0.6875rem] text-fg-muted">
                      {relativeTime(n.createdAt)}
                    </time>
                  </span>
                  {!n.read && (
                    <span className="mt-1.5 size-2 shrink-0 rounded-full bg-accent">
                      <span className="sr-only">{t.unread}</span>
                    </span>
                  )}
                </button>
                <NoticeActions notice={n} />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** A decided approval's notice says how it ended, wherever it was decided. */
function ApprovalOutcome({ status }: { status: "approved" | "denied" | "expired" }) {
  const t = useT();
  const [Icon, tone, label] =
    status === "approved" ? [Check, "ok", t.approved] : status === "denied" ? [X, "danger", t.denied] : [Clock, "neutral", t.expired];
  return (
    <div className="px-3 pb-3 ps-10">
      <Badge tone={tone as "ok" | "danger" | "neutral"}>
        <Icon aria-hidden />
        {label}
      </Badge>
    </div>
  );
}

/** Approve or deny in place; the full preview is the notice body, shown uncut above the buttons. */
function NoticeApproval({ notice }: { notice: Notice }) {
  const t = useT();
  const decide = useDecide();
  const run = (approve: boolean) =>
    decide.mutate(
      { id: notice.approvalId!, decision: { approve } },
      {
        onError: (error) => {
          notifyError(error);
          // Decided elsewhere a moment ago: show what happened.
          void queryClient.invalidateQueries({ queryKey: keys.notices });
          void queryClient.invalidateQueries({ queryKey: keys.approvals });
        },
      },
    );
  return (
    <div role="group" aria-label={noticeTitle(notice, t)} className="flex flex-wrap gap-2 px-3 pb-3 ps-10">
      <Button size="sm" variant="primary" disabled={decide.isPending} onClick={() => run(true)}>
        <Check aria-hidden />
        {t.approve}
      </Button>
      <Button size="sm" variant="danger" disabled={decide.isPending} onClick={() => run(false)}>
        <X aria-hidden />
        {t.deny}
      </Button>
    </div>
  );
}

/** A question notice: its choices and a short answer box, until it is answered anywhere. */
function NoticeQuestionForm({ notice }: { notice: Notice }) {
  const t = useT();
  const answer = useAnswerTask();
  const [text, setText] = useState("");
  const q = notice.question!;
  const send = (value: string) => value.trim() && answer.mutate({ id: q.taskId, text: value.trim() }, { onError: notifyError });
  return (
    <div role="group" aria-label={q.text} className="flex flex-col gap-2 px-3 pb-3 ps-10">
      {q.choices.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {q.choices.map((choice) => (
            <Button key={choice} size="sm" disabled={answer.isPending} onClick={() => send(choice)}>
              {choice}
            </Button>
          ))}
        </div>
      )}
      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
      >
        <Field label={t.answerLabel} srOnlyLabel className="min-w-0 flex-1">
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={t.answerPlaceholder} maxLength={4000} />
        </Field>
        <IconButton type="submit" label={t.sendAnswer} variant="primary" disabled={answer.isPending || !text.trim()}>
          <Send aria-hidden />
        </IconButton>
      </form>
    </div>
  );
}

/** What can be done on a notice right in the list: decide an approval, answer a question, or see the outcome. */
function NoticeActions({ notice }: { notice: Notice }) {
  if (notice.approvalId && notice.approvalStatus) {
    return notice.approvalStatus === "pending" ? <NoticeApproval notice={notice} /> : <ApprovalOutcome status={notice.approvalStatus} />;
  }
  if (notice.question && notice.question.answer === undefined) return <NoticeQuestionForm notice={notice} />;
  return null;
}

function CountBadge({ count, className }: { count: number; className?: string }) {
  if (!count) return null;
  return (
    <span aria-hidden className={cn("grid h-4 min-w-4 place-items-center rounded-full bg-accent px-1 text-[0.625rem] font-semibold tabular-nums text-accent-fg", className)}>
      {count > 99 ? "99+" : count}
    </span>
  );
}

/** Sidebar bell: a popover inbox. */
export function NoticeBell() {
  const t = useT();
  const count = useUnreadCount();
  const [open, setOpen] = useState(false);
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      title={t.notices}
      side="bottom"
      align="start"
      trigger={
        <IconButton label={count ? `${t.notices}: ${t.unreadCount(count)}` : t.notices} className="relative text-fg-muted">
          <Bell aria-hidden />
          <CountBadge count={count} className="absolute end-1 top-1" />
        </IconButton>
      }
    >
      <NoticeList onDone={() => setOpen(false)} />
    </Popover>
  );
}

/** Mobile tab-bar bell: a full-height drawer inbox. */
export function NoticeTab({ className }: { className?: string }) {
  const t = useT();
  const count = useUnreadCount();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className}>
        <span className="relative">
          <Bell aria-hidden className="size-6" />
          <CountBadge count={count} className="absolute -end-1.5 -top-1" />
        </span>
        {t.inbox}
        {count > 0 && <span className="sr-only">{t.unreadCount(count)}</span>}
      </button>
      <Drawer open={open} onOpenChange={setOpen} title={t.notices}>
        <NoticeList titled onDone={() => setOpen(false)} />
      </Drawer>
    </>
  );
}
