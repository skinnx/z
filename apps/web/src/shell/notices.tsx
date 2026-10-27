import type { Notice } from "@z/core";
import { Bell, CheckCheck } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { useMarkRead, useNotices } from "../api/notices.ts";
import { useT } from "../i18n.ts";
import { cn } from "../lib/cn.ts";
import { relativeTime } from "../lib/format.ts";
import { noticeKindIcon } from "../lib/icons.tsx";
import { Button } from "../ui/button.tsx";
import { Drawer } from "../ui/drawer.tsx";
import { Popover } from "../ui/popover.tsx";

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
            const Icon = noticeKindIcon[n.kind];
            return (
              <li key={n.id}>
                <button type="button" onClick={() => open(n)} className="flex w-full items-start gap-3 px-3 py-3 text-start hover:bg-subtle/70 focus-visible:bg-subtle focus-visible:outline-none">
                  <Icon role="img" aria-label={t[`notice_${n.kind}`]} className={cn("mt-0.5 size-4 shrink-0", n.read ? "text-fg-muted" : "text-accent-text")} />
                  <span className="min-w-0 flex-1">
                    <span className={cn("block text-sm leading-snug break-words", !n.read && "font-semibold")}>{n.title}</span>
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
              </li>
            );
          })}
        </ul>
      )}
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
        <Button variant="ghost" size="icon" aria-label={count ? `${t.notices}: ${t.unreadCount(count)}` : t.notices} className="relative text-fg-muted">
          <Bell aria-hidden />
          <CountBadge count={count} className="absolute end-1 top-1" />
        </Button>
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
