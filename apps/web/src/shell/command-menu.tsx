import { Autocomplete } from "@base-ui/react/autocomplete";
import { Dialog } from "@base-ui/react/dialog";
import {
  KeyRound,
  Languages,
  MessageSquarePlus,
  RadioTower,
  Search,
  SquarePen,
  SunMoon,
  Sunrise,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo } from "react";
import { useNavigate } from "react-router";
import { useGenerateBriefing } from "../api/briefing.ts";
import { useTasks } from "../api/tasks.ts";
import { useThreads } from "../api/threads.ts";
import { locale, useT } from "../i18n.ts";
import { createSignal } from "../lib/store.ts";
import { StatusIcon } from "../lib/icons.tsx";
import { toggleTheme } from "../lib/theme.ts";
import { Kbd } from "../ui/card.tsx";
import { backdropClass } from "../ui/dialog.tsx";
import { itemClass } from "../ui/popup.ts";
import { notifyError } from "../ui/toast.tsx";
import { ScrollArea } from "../ui/scroll-area.tsx";
import { NAV } from "./nav.ts";

export const commandMenuOpen = createSignal(false);

type Item = { value: string; label: string; icon: React.ReactNode; hint?: string; run: () => void };
type Group = { value: string; items: Item[] };

const icon = (Icon: LucideIcon) => <Icon aria-hidden className="text-fg-muted" />;

export function CommandMenu() {
  const t = useT();
  const open = commandMenuOpen.use();
  const navigate = useNavigate();
  const tasks = useTasks();
  const threads = useThreads();
  const briefing = useGenerateBriefing();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        commandMenuOpen.set(!commandMenuOpen.get());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const groups = useMemo<Group[]>(() => {
    const go: Item[] = NAV.map((n) => ({
      value: `go:${n.to}`,
      label: t[n.label],
      icon: icon(n.icon),
      run: () => navigate(n.to),
    }));
    const actions: Item[] = [
      { value: "do:task", label: t.newTask, icon: icon(SquarePen), run: () => navigate("/?compose") },
      { value: "do:chat", label: t.newChat, icon: icon(MessageSquarePlus), run: () => navigate("/chat") },
      { value: "do:provider", label: t.addProvider, icon: icon(KeyRound), run: () => navigate("/models?add") },
      { value: "do:channel", label: t.addChannel, icon: icon(RadioTower), run: () => navigate("/channels?add") },
      {
        value: "do:briefing",
        label: t.generateBriefing,
        icon: icon(Sunrise),
        run: () => {
          navigate("/");
          briefing.mutate(undefined, { onError: notifyError });
        },
      },
      { value: "do:theme", label: t.toggleTheme, icon: icon(SunMoon), run: toggleTheme },
      {
        value: "do:lang",
        label: t.switchLanguage,
        icon: icon(Languages),
        run: () => locale.set(locale.get() === "vi" ? "en" : "vi"),
      },
    ];
    const recentTasks: Item[] = (tasks.data ?? []).slice(0, 8).map((task) => ({
      value: `task:${task.id}`,
      label: task.title,
      hint: t[`status_${task.status}`],
      icon: <StatusIcon status={task.status} t={t} className="size-4" />,
      run: () => navigate(`/tasks?task=${encodeURIComponent(task.id)}`),
    }));
    const recentThreads: Item[] = (threads.data ?? []).slice(0, 6).map((th) => ({
      value: `thread:${th.id}`,
      label: th.title || th.id,
      icon: icon(MessageSquarePlus),
      run: () => navigate(`/chat/${encodeURIComponent(th.id)}`),
    }));
    return [
      { value: t.group_do, items: actions },
      { value: t.group_go, items: go },
      { value: t.group_tasks, items: recentTasks },
      { value: t.group_threads, items: recentThreads },
    ].filter((g) => g.items.length > 0);
  }, [t, navigate, tasks.data, threads.data, briefing]);

  return (
    <Dialog.Root open={open} onOpenChange={(o) => commandMenuOpen.set(o)}>
      <Dialog.Portal>
        <Dialog.Backdrop className={backdropClass} />
        <Dialog.Viewport className="fixed inset-0 z-50 flex items-start justify-center px-2 pt-[12vh]">
          <Dialog.Popup
            aria-label={t.commandMenu}
            className="flex max-h-[min(32rem,80dvh)] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-line bg-surface text-fg shadow-2xl transition-[scale,opacity] duration-150 data-starting-style:scale-[0.98] data-starting-style:opacity-0 data-ending-style:scale-[0.98] data-ending-style:opacity-0"
          >
            <Autocomplete.Root open inline items={groups} autoHighlight="always" keepHighlight itemToStringValue={(i: Item) => i.label}>
              <div className="flex items-center gap-3 border-b border-line px-4">
                <Search aria-hidden className="size-5 shrink-0 text-fg-muted" />
                <Autocomplete.Input
                  aria-label={t.commandMenu}
                  placeholder={t.searchCommands}
                  className="h-14 w-full bg-transparent text-base outline-none placeholder:text-fg-muted"
                />
                <Kbd>Esc</Kbd>
              </div>
              <Dialog.Close className="sr-only">{t.close}</Dialog.Close>
              <ScrollArea className="flex-1">
                <Autocomplete.Empty className="px-4 py-8 text-center text-sm text-fg-muted empty:hidden">{t.noResults}</Autocomplete.Empty>
                <Autocomplete.List className="p-2">
                  {(group: Group) => (
                    <Autocomplete.Group key={group.value} items={group.items} className="not-last:mb-2">
                      <Autocomplete.GroupLabel className="px-2.5 pt-1 pb-1.5 text-xs font-semibold tracking-wide text-fg-muted uppercase">
                        {group.value}
                      </Autocomplete.GroupLabel>
                      <Autocomplete.Collection>
                        {(item: Item) => (
                          <Autocomplete.Item
                            key={item.value}
                            value={item}
                            onClick={() => {
                              commandMenuOpen.set(false);
                              item.run();
                            }}
                            className={itemClass}
                          >
                            {item.icon}
                            <span className="min-w-0 flex-1 truncate">{item.label}</span>
                            {item.hint && <span className="text-xs text-fg-muted">{item.hint}</span>}
                          </Autocomplete.Item>
                        )}
                      </Autocomplete.Collection>
                    </Autocomplete.Group>
                  )}
                </Autocomplete.List>
              </ScrollArea>
              <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-2 text-xs text-fg-muted">
                <Kbd>↑↓</Kbd>
                <Kbd>Enter</Kbd>
                <span>{t.enterToRun}</span>
              </div>
            </Autocomplete.Root>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
