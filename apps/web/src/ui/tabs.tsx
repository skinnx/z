import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import type { ReactNode } from "react";
import { cn } from "../lib/cn.ts";

/**
 * Focus rings for tabs and their (focusable) panels, drawn inside so scroll containers don't clip them.
 * No `outline-none` here: in Tailwind v4 it sets the outline style to none, which `outline-2` alone can't undo.
 */
export const tabFocusClass = "focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-accent";

export const TabsRoot = BaseTabs.Root;
export const TabPanel = ({ className, ...props }: Omit<BaseTabs.Panel.Props, "className"> & { className?: string }) => (
  <BaseTabs.Panel className={cn("rounded-md", tabFocusClass, className)} {...props} />
);

export function TabList({ tabs, label }: { tabs: { value: string; label: ReactNode; count?: number; icon?: ReactNode }[]; label: string }) {
  return (
    <BaseTabs.List aria-label={label} className="relative flex gap-1 border-b border-line">
      {tabs.map((tab) => (
        <BaseTabs.Tab
          key={tab.value}
          value={tab.value}
          className={cn(
            "flex h-11 shrink-0 items-center gap-2 px-3 text-sm font-medium whitespace-nowrap text-fg-muted hover:text-fg data-active:text-fg focus-visible:rounded-md [&_svg]:size-4",
            tabFocusClass,
          )}
        >
          {tab.icon}
          {tab.label}
          {tab.count !== undefined && tab.count > 0 && (
            <span className="min-w-5 rounded-full bg-subtle px-1.5 text-center text-xs tabular-nums text-fg">{tab.count}</span>
          )}
        </BaseTabs.Tab>
      ))}
      <BaseTabs.Indicator className="absolute bottom-[-1px] left-0 h-0.5 w-(--active-tab-width) translate-x-(--active-tab-left) rounded-full bg-accent transition-[translate,width] duration-200" />
    </BaseTabs.List>
  );
}
