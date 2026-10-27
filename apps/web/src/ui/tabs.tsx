import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import type { ReactNode } from "react";
import { cn } from "../lib/cn.ts";

export const TabsRoot = BaseTabs.Root;
export const TabPanel = ({ className, ...props }: Omit<BaseTabs.Panel.Props, "className"> & { className?: string }) => (
  <BaseTabs.Panel className={cn("outline-none", className)} {...props} />
);

export function TabList({ tabs, label }: { tabs: { value: string; label: ReactNode; count?: number; icon?: ReactNode }[]; label: string }) {
  return (
    <BaseTabs.List aria-label={label} className="relative flex gap-1 border-b border-line">
      {tabs.map((tab) => (
        <BaseTabs.Tab
          key={tab.value}
          value={tab.value}
          className="flex h-11 items-center gap-2 px-3 text-sm font-medium text-fg-muted outline-none hover:text-fg data-active:text-fg focus-visible:rounded-md focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent [&_svg]:size-4"
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
