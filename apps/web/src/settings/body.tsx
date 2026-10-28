/**
 * The settings surface: a vertical tab list beside the active panel on wide screens; on phones the
 * same tabs are a list that drills into one section, with a back button. One tree for both.
 */
import { Tabs } from "@base-ui/react/tabs";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useEffect, useRef, useState, type ComponentType } from "react";
import { useT } from "../i18n.ts";
import { cn } from "../lib/cn.ts";
import { Button } from "../ui/button.tsx";
import { ScrollArea } from "../ui/scroll-area.tsx";
import { ApprovalsPanel } from "./panels/approvals.tsx";
import { DataPanel } from "./panels/data.tsx";
import { GeneralPanel } from "./panels/general.tsx";
import { NotificationsPanel } from "./panels/notifications.tsx";
import { PersonalizationPanel } from "./panels/personalization.tsx";
import { ReachPanel } from "./panels/reach.tsx";
import { SecurityPanel } from "./panels/security.tsx";
import { SetupPanel } from "./panels/setup.tsx";
import { SourcesPanel } from "./panels/sources.tsx";
import { SECTIONS, sectionIcon, sectionLabel, useSettingsRoute, type SectionId } from "./route.ts";

const panels: Record<SectionId, ComponentType> = {
  setup: SetupPanel,
  general: GeneralPanel,
  personalization: PersonalizationPanel,
  notifications: NotificationsPanel,
  reach: ReachPanel,
  sources: SourcesPanel,
  approvals: ApprovalsPanel,
  data: DataPanel,
  security: SecurityPanel,
};

export default function SettingsBody({ phone, titleId }: { phone: boolean; titleId: string }) {
  const t = useT();
  const route = useSettingsRoute();
  // Phones show the list until a section is picked; wide screens always show one.
  // Local first, URL after: keyboard moves between tabs without waiting for the navigation.
  const [selected, setSelected] = useState<SectionId | null>(route.section);
  useEffect(() => setSelected(route.section), [route.section]);
  const drilled = !phone || selected !== null;
  const active: SectionId = selected ?? SECTIONS[0];
  const root = useRef<HTMLDivElement>(null);
  const last = useRef<SectionId | null>(null);

  // Phones: focus the heading after drilling in, and the section's row after coming back.
  useEffect(() => {
    if (!phone) return;
    if (route.section) root.current?.querySelector<HTMLElement>("[data-settings-back]")?.focus({ preventScroll: true });
    else if (last.current) root.current?.querySelector<HTMLElement>(`[role="tab"][data-value="${last.current}"]`)?.focus({ preventScroll: true });
    last.current = route.section;
  }, [phone, route.section]);

  // Desktop: start on the active tab so arrow keys work at once. Waits a frame, until the tab list
  // has indexed its tabs, and only takes focus from the popup itself.
  useEffect(() => {
    if (phone) return;
    const id = requestAnimationFrame(() => {
      const el = document.activeElement;
      if (el instanceof HTMLElement && el.getAttribute("role") === "dialog" && el.contains(root.current))
        root.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (id: SectionId) => {
    setSelected(id);
    if (id !== route.section) route.open(id);
  };

  const close = (
    <Button variant="ghost" size="icon" aria-label={t.close} onClick={route.close} className="ms-auto">
      <X aria-hidden />
    </Button>
  );

  return (
    <Tabs.Root
      ref={root}
      orientation="vertical"
      value={active}
      onValueChange={(v) => pick(v as SectionId)}
      className="flex min-h-0 w-full flex-1"
    >
      <div
        hidden={phone && drilled}
        className={cn("flex min-h-0 flex-col", phone ? "w-full" : "w-56 shrink-0 border-e border-line bg-bg")}
      >
        {phone && (
          <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line ps-5 pe-2">
            <h2 id={drilled ? undefined : titleId} className="text-base font-semibold">
              {t.nav_settings}
            </h2>
            {close}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <Tabs.List
            aria-label={t.nav_settings}
            activateOnFocus={!phone}
            className={cn("flex flex-col", phone ? "gap-0 py-1" : "gap-0.5 p-2")}
          >
            {SECTIONS.map((id) => {
              const Icon = sectionIcon[id];
              return (
                <Tabs.Tab
                  key={id}
                  value={id}
                  data-value={id}
                  // Tapping the already-selected tab on a phone still drills in.
                  onClick={() => phone && pick(id)}
                  className={cn(
                    "flex w-full items-center gap-3 text-start text-sm font-medium outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent [&_svg]:size-[1.125rem] [&_svg]:shrink-0",
                    phone
                      ? "h-14 border-b border-line px-5 text-[0.9375rem] last:border-b-0 active:bg-subtle"
                      : "h-9 rounded-lg px-2.5 text-fg-muted hover:bg-subtle hover:text-fg data-active:bg-surface data-active:text-fg data-active:shadow-sm data-active:ring-1 data-active:ring-line",
                  )}
                >
                  <Icon aria-hidden className={phone ? "text-fg-muted" : undefined} />
                  <span className="min-w-0 flex-1 truncate">{sectionLabel(t, id)}</span>
                  {phone && <ChevronRight aria-hidden className="text-fg-muted rtl:-scale-x-100" />}
                </Tabs.Tab>
              );
            })}
          </Tabs.List>
        </div>
      </div>

      <div hidden={!drilled} className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex h-14 shrink-0 items-center gap-1 border-b border-line ps-5 pe-2 max-sm:ps-1">
          {phone && (
            <Button variant="ghost" size="icon" aria-label={t.allSettings} data-settings-back onClick={() => {
                setSelected(null);
                route.open();
              }}>
              <ChevronLeft aria-hidden className="rtl:-scale-x-100" />
            </Button>
          )}
          <h2 id={drilled ? titleId : undefined} className="min-w-0 truncate text-base font-semibold">
            {sectionLabel(t, active)}
          </h2>
          {close}
        </div>
        <ScrollArea className="flex-1" label={sectionLabel(t, active)}>
          {SECTIONS.map((id) => {
            const Panel = panels[id];
            return (
              <Tabs.Panel
                key={id}
                value={id}
                className={cn("px-5 pt-2 pb-8 outline-none", phone && "motion-safe:animate-[settings-in_200ms_ease-out]")}
              >
                <Panel />
              </Tabs.Panel>
            );
          })}
        </ScrollArea>
      </div>
    </Tabs.Root>
  );
}
