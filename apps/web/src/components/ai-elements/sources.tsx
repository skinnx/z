/**
 * Adapted from AI Elements `sources` (https://elements.ai-sdk.dev/components/sources).
 * Copyright 2023 Vercel, Inc. Licensed under Apache-2.0; see ./LICENSE and ./NOTICE.
 * Modified for z: Radix Collapsible replaced by z's Base UI Collapsible parts, z strings and
 * tokens, `Source` shows the host and works on its own (briefing links).
 */
import { BookOpen, ChevronDown } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { useT } from "../../i18n.ts";
import { cn } from "../../lib/cn.ts";
import { CollapsiblePanel, CollapsibleRoot, CollapsibleTrigger } from "../../ui/collapsible.tsx";

export const Sources = ({ className, children, defaultOpen }: { className?: string; children: ReactNode; defaultOpen?: boolean }) => (
  <CollapsibleRoot defaultOpen={defaultOpen} className={cn("group/sources not-prose text-xs text-accent-text", className)}>
    {children}
  </CollapsibleRoot>
);

export const SourcesTrigger = ({ count, className, children }: { count: number; className?: string; children?: ReactNode }) => {
  const t = useT();
  return (
    <CollapsibleTrigger className={cn("flex min-h-8 items-center gap-1.5 rounded-md font-medium hover:underline", className)}>
      {children ?? (
        <>
          <span>{t.usedSources(count)}</span>
          <ChevronDown aria-hidden className="size-4 transition-transform motion-reduce:transition-none group-data-[open]/sources:rotate-180" />
        </>
      )}
    </CollapsibleTrigger>
  );
};

export const SourcesContent = ({ className, children }: { className?: string; children: ReactNode }) => (
  <CollapsiblePanel>
    <ul className={cn("mt-1 flex w-fit max-w-full flex-col gap-1.5", className)}>{children}</ul>
  </CollapsiblePanel>
);

const host = (href?: string) => {
  try {
    return href ? new URL(href).hostname.replace(/^www\./, "") : "";
  } catch {
    return "";
  }
};

export type SourceProps = ComponentProps<"a">;

/** A link to where something came from: book icon, title, and the site it lives on. */
export const Source = ({ href, title, children, className, ...props }: SourceProps) => {
  const t = useT();
  return (
    <a href={href} rel="noreferrer" target="_blank" className={cn("inline-flex min-w-0 max-w-full items-center gap-2 text-accent-text hover:underline", className)} {...props}>
      {children ?? (
        <>
          <BookOpen aria-hidden className="size-4 shrink-0" />
          <span className="truncate font-medium">{title || host(href) || href}</span>
          {title && host(href) && <span className="shrink-0 text-fg-muted">{host(href)}</span>}
        </>
      )}
      <span className="sr-only">({t.openLink})</span>
    </a>
  );
};
