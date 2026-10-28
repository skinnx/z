/**
 * Adapted from AI Elements `chain-of-thought` (https://elements.ai-sdk.dev/components/chain-of-thought).
 * Copyright 2023 Vercel, Inc. Licensed under Apache-2.0; see ./LICENSE and ./NOTICE.
 * Modified for z: one Base UI Collapsible spans header and content (so the trigger controls the
 * panel it opens, for assistive tech) instead of two Radix ones sharing state; local
 * controllable-state hook; steps are list items with an optional trailing `meta` (time);
 * z tokens; search results use z's Badge.
 */
import type { LucideIcon } from "lucide-react";
import { Brain, ChevronDown, Dot } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { memo } from "react";
import { cn } from "../../lib/cn.ts";
import { Badge } from "../../ui/card.tsx";
import { CollapsiblePanel, CollapsibleRoot, CollapsibleTrigger } from "../../ui/collapsible.tsx";
import { useControllableState } from "./use-controllable-state.ts";

export type ChainOfThoughtProps = {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  children: ReactNode;
};

export const ChainOfThought = memo(({ className, open, defaultOpen = false, onOpenChange, children }: ChainOfThoughtProps) => {
  const [isOpen, setIsOpen] = useControllableState({ prop: open, defaultProp: defaultOpen, onChange: onOpenChange });
  return (
    <CollapsibleRoot open={isOpen} onOpenChange={setIsOpen} className={cn("group/cot not-prose w-full", className)}>
      {children}
    </CollapsibleRoot>
  );
});
ChainOfThought.displayName = "ChainOfThought";

export const ChainOfThoughtHeader = memo(({ className, children, icon }: { className?: string; children?: ReactNode; icon?: ReactNode }) => (
  <CollapsibleTrigger
    className={cn("flex min-h-8 w-full items-center gap-2 rounded-md text-sm text-fg-muted transition-colors hover:text-fg [&_svg]:size-4 [&_svg]:shrink-0", className)}
  >
    {icon ?? <Brain aria-hidden />}
    <span className="flex-1 text-start">{children}</span>
    <ChevronDown aria-hidden className="transition-transform motion-reduce:transition-none group-data-[open]/cot:rotate-180" />
  </CollapsibleTrigger>
));
ChainOfThoughtHeader.displayName = "ChainOfThoughtHeader";

export const ChainOfThoughtContent = memo(({ className, children }: { className?: string; children: ReactNode }) => (
  <CollapsiblePanel>
    <ol className={cn("mt-3 flex flex-col", className)}>{children}</ol>
  </CollapsiblePanel>
));
ChainOfThoughtContent.displayName = "ChainOfThoughtContent";

export type ChainOfThoughtStepProps = Omit<ComponentProps<"li">, "children"> & {
  icon?: LucideIcon;
  label: ReactNode;
  description?: ReactNode;
  /** Trailing detail on the label row (e.g. a time). */
  meta?: ReactNode;
  status?: "complete" | "active" | "pending";
  children?: ReactNode;
};

const stepStatus = { active: "text-fg", complete: "text-fg-muted", pending: "text-fg-muted/60" };

export const ChainOfThoughtStep = memo(({ className, icon: Icon = Dot, label, description, meta, status = "complete", children, ...props }: ChainOfThoughtStepProps) => (
  <li className={cn("group/step flex gap-3 text-sm", stepStatus[status], className)} {...props}>
    <div className="relative flex flex-col items-center">
      <span className={cn("grid size-6 shrink-0 place-items-center rounded-full border border-line bg-surface", status === "active" && "border-accent text-accent-text")}>
        <Icon aria-hidden className="size-3.5" />
      </span>
      <span aria-hidden className="w-px flex-1 bg-line group-last/step:hidden" />
    </div>
    <div className="min-w-0 flex-1 pb-4 group-last/step:pb-0">
      <div className="flex min-h-6 items-baseline gap-2">
        <div className="min-w-0 flex-1 leading-relaxed break-words text-fg">{label}</div>
        {meta && <div className="shrink-0 text-xs text-fg-muted tabular-nums">{meta}</div>}
      </div>
      {description && <div className="text-xs text-fg-muted">{description}</div>}
      {children && <div className="mt-1.5">{children}</div>}
    </div>
  </li>
));
ChainOfThoughtStep.displayName = "ChainOfThoughtStep";

export const ChainOfThoughtSearchResults = memo(({ className, ...props }: ComponentProps<"div">) => (
  <div className={cn("flex flex-wrap items-center gap-2", className)} {...props} />
));
ChainOfThoughtSearchResults.displayName = "ChainOfThoughtSearchResults";

export const ChainOfThoughtSearchResult = memo(({ className, children }: { className?: string; children: ReactNode }) => (
  <Badge className={cn("font-normal", className)}>{children}</Badge>
));
ChainOfThoughtSearchResult.displayName = "ChainOfThoughtSearchResult";
