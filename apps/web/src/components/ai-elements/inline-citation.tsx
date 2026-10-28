/**
 * Adapted from AI Elements `inline-citation` (https://elements.ai-sdk.dev/components/inline-citation).
 * Copyright 2023 Vercel, Inc. Licensed under Apache-2.0; see ./LICENSE and ./NOTICE.
 * Modified for z: Radix HoverCard replaced by z's Base UI PreviewCard, the embla Carousel by a
 * small local pager (prev/next + index), shadcn Badge by a z-styled link, z strings and tokens.
 */
import { ArrowLeft, ArrowRight } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { Children, createContext, useContext, useState } from "react";
import { useT } from "../../i18n.ts";
import { cn } from "../../lib/cn.ts";
import { PreviewCard } from "../../ui/preview-card.tsx";

export const InlineCitation = ({ className, ...props }: ComponentProps<"span">) => <span className={cn("group inline items-center gap-1", className)} {...props} />;

export const InlineCitationText = ({ className, ...props }: ComponentProps<"span">) => (
  <span className={cn("transition-colors group-hover:bg-accent-soft", className)} {...props} />
);

const hostname = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/**
 * The citation chip (first source's host, +N) and its preview card. The chip links to the first
 * source, so keyboard and touch users reach it without the hover card.
 */
export const InlineCitationCard = ({ sources, children, className }: { sources: string[]; children: ReactNode; className?: string }) => {
  const first = sources[0];
  if (!first) return null;
  return (
    <PreviewCard
      trigger={
        <a
          href={first}
          target="_blank"
          rel="noreferrer"
          className={cn("ms-1 inline-flex h-5 items-center rounded-full bg-subtle px-2 align-middle text-[0.6875rem] font-medium text-fg-muted no-underline hover:text-fg", className)}
        >
          {hostname(first)}
          {sources.length > 1 && ` +${sources.length - 1}`}
        </a>
      }
      className="p-0"
    >
      {children}
    </PreviewCard>
  );
};

type Pager = { index: number; count: number; go: (delta: number) => void };
const PagerContext = createContext<Pager>({ index: 0, count: 0, go: () => {} });

/** Pages through the sources one at a time. */
export const InlineCitationCarousel = ({ children, className }: { children: ReactNode; className?: string }) => {
  const items = Children.toArray(children);
  const header = items.filter((c) => (c as { type?: unknown }).type === InlineCitationCarouselHeader);
  const slides = items.filter((c) => (c as { type?: unknown }).type !== InlineCitationCarouselHeader);
  const [index, setIndex] = useState(0);
  const count = slides.length;
  const go = (delta: number) => setIndex((i) => (i + delta + count) % count);
  return (
    <PagerContext.Provider value={{ index, count, go }}>
      <div className={cn("w-full", className)}>
        {header}
        <div aria-live="polite">{slides[index]}</div>
      </div>
    </PagerContext.Provider>
  );
};

export const InlineCitationCarouselItem = ({ className, ...props }: ComponentProps<"div">) => (
  <div className={cn("flex w-full flex-col gap-2 p-3", className)} {...props} />
);

export const InlineCitationCarouselHeader = ({ className, ...props }: ComponentProps<"div">) => (
  <div className={cn("flex items-center justify-between gap-2 border-b border-line bg-subtle/60 px-2 py-1", className)} {...props} />
);

export const InlineCitationCarouselIndex = ({ className }: { className?: string }) => {
  const { index, count } = useContext(PagerContext);
  return <div className={cn("flex flex-1 items-center justify-center text-xs text-fg-muted tabular-nums", className)}>{`${index + 1}/${count}`}</div>;
};

const pagerButton = "grid size-8 shrink-0 place-items-center rounded-md text-fg-muted hover:bg-surface hover:text-fg disabled:opacity-40";

export const InlineCitationCarouselPrev = () => {
  const t = useT();
  const { go, count } = useContext(PagerContext);
  return (
    <button type="button" aria-label={t.citationPrev} className={pagerButton} disabled={count < 2} onClick={() => go(-1)}>
      <ArrowLeft aria-hidden className="size-4 rtl:-scale-x-100" />
    </button>
  );
};

export const InlineCitationCarouselNext = () => {
  const t = useT();
  const { go, count } = useContext(PagerContext);
  return (
    <button type="button" aria-label={t.citationNext} className={pagerButton} disabled={count < 2} onClick={() => go(1)}>
      <ArrowRight aria-hidden className="size-4 rtl:-scale-x-100" />
    </button>
  );
};

export const InlineCitationSource = ({
  title,
  url,
  description,
  className,
  children,
}: {
  title?: string;
  url?: string;
  description?: string;
  className?: string;
  children?: ReactNode;
}) => (
  <div className={cn("flex min-w-0 flex-col gap-1", className)}>
    {title && <h4 className="truncate text-sm leading-tight font-medium">{title}</h4>}
    {url && (
      <a href={url} target="_blank" rel="noreferrer" className="truncate text-xs break-all text-accent-text hover:underline">
        {url}
      </a>
    )}
    {description && <p className="line-clamp-3 text-sm leading-relaxed text-fg-muted">{description}</p>}
    {children}
  </div>
);

export const InlineCitationQuote = ({ className, ...props }: ComponentProps<"blockquote">) => (
  <blockquote className={cn("border-s-2 border-line ps-3 text-sm text-fg-muted italic", className)} {...props} />
);
