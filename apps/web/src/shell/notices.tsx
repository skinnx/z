import type { Notice } from "@z/core";
import { Bell, CheckCheck } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { useMarkRead, useNotices } from "../api/notices.ts";
import { useAnswerTask } from "../api/tasks.ts";
import { useT } from "../i18n.ts";
import { cn } from "../lib/cn.ts";
import { relativeTime } from "../lib/format.ts";
import { NoticeIcon, noticeTitle } from "../lib/icons.tsx";
import { Button } from "../ui/button.tsx";
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
  const notices = useNotices().data ?? [];
  const markRead = useMarkRead();
  const open = useOpenNotice(onDone);
  const unread = notices.some((n) => !n.read);

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
                    {n.body && <span className="mt-0.5 line-clamp-2 text-xs leading-relaxed break-words text-fg-muted">{n.body}</span>}
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
                <NoticeChoices notice={n} />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** A question notice's choices, until it is answered here, on push or on the owner channel. */
function NoticeChoices({ notice }: { notice: Notice }) {
  const answer = useAnswerTask();
  const markRead = useMarkRead();
  const q = notice.question;
  if (!q || q.answer !== undefined || q.choices.length === 0) return null;
  return (
    <div role="group" aria-label={q.text} className="flex flex-wrap gap-2 px-3 pb-3 ps-10">
      {q.choices.map((choice) => (
        <Button
          key={choice}
          size="sm"
          disabled={answer.isPending}
          onClick={() =>
            answer.mutate(
              { id: q.taskId, text: choice },
              { onSuccess: () => !notice.read && markRead.mutate([notice.id]), onError: notifyError },
            )
          }
        >
          {choice}
        </Button>
      ))}
    </div>
  );
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
