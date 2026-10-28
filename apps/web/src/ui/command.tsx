import { Autocomplete } from "@base-ui/react/autocomplete";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { Search } from "lucide-react";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { useT } from "../i18n.ts";
import { cn } from "../lib/cn.ts";
import { backdropClass } from "./dialog.tsx";
import { itemClass } from "./popup.ts";
import { ScrollArea } from "./scroll-area.tsx";

/**
 * A searchable command list (the "Command"/cmdk of other kits), built on Base UI Autocomplete
 * rendered inline: arrow keys move, Enter picks, typing filters.
 */
export function Command<Item>({
  items,
  itemToStringValue,
  children,
}: {
  items: readonly Item[] | readonly { value: string; items: readonly Item[] }[];
  itemToStringValue: (item: Item) => string;
  children: ReactNode;
}) {
  return (
    <Autocomplete.Root open inline items={items as Item[]} autoHighlight="always" keepHighlight itemToStringValue={itemToStringValue}>
      {children}
    </Autocomplete.Root>
  );
}

export function CommandInput({ className, ...props }: Omit<Autocomplete.Input.Props, "className"> & { className?: string }) {
  return (
    <div className="flex items-center gap-3 border-b border-line px-4">
      <Search aria-hidden className="size-4 shrink-0 text-fg-muted" />
      <Autocomplete.Input className={cn("h-12 w-full bg-transparent text-[0.9375rem] outline-none placeholder:text-fg-muted", className)} {...props} />
    </div>
  );
}

export function CommandList<Group>({ children, className }: { children: (group: Group) => ReactNode; className?: string }) {
  return (
    <ScrollArea className="min-h-0 flex-1">
      <Autocomplete.List className={cn("p-2", className)}>{children}</Autocomplete.List>
    </ScrollArea>
  );
}

export function CommandEmpty({ children }: { children: ReactNode }) {
  return <Autocomplete.Empty className="px-4 py-8 text-center text-sm text-fg-muted empty:hidden">{children}</Autocomplete.Empty>;
}

export function CommandGroup<Item>({
  heading,
  items,
  children,
}: {
  heading: ReactNode;
  items: readonly Item[];
  children: (item: Item) => ReactNode;
}) {
  return (
    <Autocomplete.Group items={items as Item[]} className="not-last:mb-2">
      <Autocomplete.GroupLabel className="px-2.5 pt-1 pb-1.5 text-xs font-semibold tracking-wide text-fg-muted">{heading}</Autocomplete.GroupLabel>
      <Autocomplete.Collection>{children}</Autocomplete.Collection>
    </Autocomplete.Group>
  );
}

export function CommandItem({ className, ...props }: Omit<ComponentProps<typeof Autocomplete.Item>, "className"> & { className?: string }) {
  return <Autocomplete.Item className={cn(itemClass, className)} {...props} />;
}

/** A command list in a modal dialog, opened by `trigger` or controlled with `open`. */
export function CommandDialog({
  trigger,
  label,
  open,
  onOpenChange,
  children,
  className,
}: {
  trigger?: ReactElement;
  label: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
  className?: string;
}) {
  const t = useT();
  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger && <BaseDialog.Trigger render={trigger} />}
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className={backdropClass} />
        <BaseDialog.Viewport className="fixed inset-0 z-50 flex items-start justify-center px-2 pt-[12vh]">
          <BaseDialog.Popup
            aria-label={label}
            className={cn(
              "flex max-h-[min(32rem,80dvh)] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-line bg-surface text-fg shadow-2xl transition-[scale,opacity] duration-150 motion-reduce:transition-none data-starting-style:scale-[0.98] data-starting-style:opacity-0 data-ending-style:scale-[0.98] data-ending-style:opacity-0",
              className,
            )}
          >
            <BaseDialog.Title className="sr-only">{label}</BaseDialog.Title>
            {children}
            <BaseDialog.Close className="sr-only">{t.close}</BaseDialog.Close>
          </BaseDialog.Popup>
        </BaseDialog.Viewport>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
