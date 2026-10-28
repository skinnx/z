/**
 * Adapted from AI Elements `task` (https://elements.ai-sdk.dev/components/task).
 * Copyright 2023 Vercel, Inc. Licensed under Apache-2.0; see ./LICENSE and ./NOTICE.
 * Modified for z: Radix Collapsible replaced by z's Base UI Collapsible parts, `icon` on the
 * trigger, z tokens.
 */
import { ChevronDown, Search } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/cn.ts";
import { CollapsiblePanel, CollapsibleRoot, CollapsibleTrigger } from "../../ui/collapsible.tsx";

export const TaskItemFile = ({ className, ...props }: ComponentProps<"div">) => (
  <div className={cn("inline-flex items-center gap-1 rounded-md border border-line bg-subtle px-1.5 py-0.5 font-mono text-xs text-fg", className)} {...props} />
);

export const TaskItem = ({ className, ...props }: ComponentProps<"div">) => <div className={cn("text-sm text-fg-muted", className)} {...props} />;

export const Task = ({ defaultOpen = true, className, children }: { defaultOpen?: boolean; className?: string; children: ReactNode }) => (
  <CollapsibleRoot defaultOpen={defaultOpen} className={cn("group/task", className)}>
    {children}
  </CollapsibleRoot>
);

export const TaskTrigger = ({ title, icon, className, children }: { title: ReactNode; icon?: ReactNode; className?: string; children?: ReactNode }) => (
  <CollapsibleTrigger className={cn("flex min-h-8 w-full items-center gap-2 rounded-md text-start text-sm text-fg-muted transition-colors hover:text-fg [&_svg]:size-4 [&_svg]:shrink-0", className)}>
    {children ?? (
      <>
        {icon ?? <Search aria-hidden />}
        <span className="min-w-0 truncate">{title}</span>
        <ChevronDown aria-hidden className="transition-transform motion-reduce:transition-none group-data-[open]/task:rotate-180" />
      </>
    )}
  </CollapsibleTrigger>
);

export const TaskContent = ({ className, children }: { className?: string; children: ReactNode }) => (
  <CollapsiblePanel>
    <div className={cn("mt-2 flex flex-col gap-2 border-s-2 border-line ps-4", className)}>{children}</div>
  </CollapsiblePanel>
);
