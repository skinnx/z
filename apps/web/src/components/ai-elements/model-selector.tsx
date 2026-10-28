/**
 * Adapted from AI Elements `model-selector` (https://elements.ai-sdk.dev/components/model-selector).
 * Copyright 2023 Vercel, Inc. Licensed under Apache-2.0; see ./LICENSE and ./NOTICE.
 * Modified for z: Radix Dialog + cmdk Command replaced by z's CommandDialog (Base UI Dialog +
 * Autocomplete); the parts are fed with typed groups. Provider logos from models.dev are left
 * out (a self-hosted app should not call a third party to draw a logo); z's Monogram stands in.
 */
import { Check } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { cn } from "../../lib/cn.ts";
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "../../ui/command.tsx";

export type ModelSelectorItemData = { value: string; label: string; hint?: string; icon?: ReactNode };
export type ModelSelectorGroupData = { value: string; label: ReactNode; items: ModelSelectorItemData[] };

export const ModelSelector = ({
  open,
  onOpenChange,
  trigger,
  title,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactElement;
  title: string;
  children: ReactNode;
}) => (
  <CommandDialog open={open} onOpenChange={onOpenChange} trigger={trigger} label={title}>
    {children}
  </CommandDialog>
);

/** The searchable list inside the selector. */
export const ModelSelectorContent = ({ groups, children }: { groups: ModelSelectorGroupData[]; children: ReactNode }) => (
  <Command items={groups} itemToStringValue={(i: ModelSelectorItemData) => `${i.label} ${i.value}`}>
    {children}
  </Command>
);

export const ModelSelectorInput = CommandInput;
export const ModelSelectorEmpty = CommandEmpty;

export const ModelSelectorList = ({ children }: { children: (group: ModelSelectorGroupData) => ReactNode }) => <CommandList<ModelSelectorGroupData>>{children}</CommandList>;

export const ModelSelectorGroup = ({ group, children }: { group: ModelSelectorGroupData; children: (item: ModelSelectorItemData) => ReactNode }) => (
  <CommandGroup heading={group.label} items={group.items}>
    {children}
  </CommandGroup>
);

export const ModelSelectorItem = ({
  item,
  selected,
  onSelect,
  className,
}: {
  item: ModelSelectorItemData;
  selected?: boolean;
  onSelect: (value: string) => void;
  className?: string;
}) => (
  <CommandItem value={item} onClick={() => onSelect(item.value)} className={cn(selected && "font-medium", className)}>
    {item.icon}
    <ModelSelectorName>{item.label}</ModelSelectorName>
    {item.hint && <span className="shrink-0 text-xs text-fg-muted">{item.hint}</span>}
    {selected && <Check aria-hidden className="text-accent-text" />}
  </CommandItem>
);

export const ModelSelectorName = ({ className, ...props }: React.ComponentProps<"span">) => <span className={cn("min-w-0 flex-1 truncate text-start", className)} {...props} />;
