/**
 * Adapted from AI Elements `conversation` (https://elements.ai-sdk.dev/components/conversation).
 * Copyright 2023 Vercel, Inc. Licensed under Apache-2.0; see ./LICENSE and ./NOTICE.
 * Modified for z: z's Button instead of shadcn's, z tokens and strings, instant scrolling under
 * prefers-reduced-motion, a thread opens at its latest message (no scroll animation), the log is not itself a live region (see ChatAnnouncer), no download.
 */
import { ArrowDown } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { useT } from "../../i18n.ts";
import { cn } from "../../lib/cn.ts";
import { Button } from "../../ui/button.tsx";

const reducedMotion = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export type ConversationProps = ComponentProps<typeof StickToBottom>;

/** The scrolling message area. It sticks to the bottom while a reply streams, until you scroll up. */
export const Conversation = ({ className, ...props }: ConversationProps) => {
  const motion = reducedMotion() ? "instant" : "smooth";
  // Opening a thread lands on its latest message: a smooth scroll through a long thread would keep
  // moving the content the reader is trying to look at.
  return <StickToBottom className={cn("relative min-h-0 flex-1 overflow-y-hidden", className)} initial="instant" resize={motion} {...props} />;
};

export type ConversationContentProps = ComponentProps<typeof StickToBottom.Content>;

export const ConversationContent = ({ className, ...props }: ConversationContentProps) => (
  <StickToBottom.Content className={cn("mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6", className)} {...props} />
);

export type ConversationEmptyStateProps = ComponentProps<"div"> & {
  description?: ReactNode;
  icon?: ReactNode;
};

/** What an empty conversation shows: one line and the ways to start (no title, per z's layout rule). */
export const ConversationEmptyState = ({ className, description, icon, children, ...props }: ConversationEmptyStateProps) => (
  <div className={cn("flex flex-col items-center justify-center gap-4 px-2 py-12 text-center", className)} {...props}>
    {icon && (
      <span aria-hidden className="grid size-12 place-items-center rounded-full bg-subtle text-fg-muted [&_svg]:size-6">
        {icon}
      </span>
    )}
    {description && <p className="max-w-md text-sm text-fg-muted">{description}</p>}
    {children}
  </div>
);

export type ConversationScrollButtonProps = Omit<ComponentProps<typeof Button>, "onClick">;

/** Appears once you scroll away from the latest message; takes you back. */
export const ConversationScrollButton = ({ className, ...props }: ConversationScrollButtonProps) => {
  const t = useT();
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  if (isAtBottom) return null;
  return (
    <Button
      aria-label={t.scrollToBottom}
      title={t.scrollToBottom}
      className={cn("absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full shadow-md", className)}
      onClick={() => void scrollToBottom(reducedMotion() ? "instant" : "smooth")}
      size="icon"
      variant="secondary"
      {...props}
    >
      <ArrowDown aria-hidden />
    </Button>
  );
};
