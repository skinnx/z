/**
 * Adapted from AI Elements `message` (https://elements.ai-sdk.dev/components/message).
 * Copyright 2023 Vercel, Inc. Licensed under Apache-2.0; see ./LICENSE and ./NOTICE.
 * Modified for z: Radix Tooltip replaced by z's IconButton (Base UI Tooltip), z tokens,
 * Streamdown plugins loaded lazily (./streamdown-plugins.ts), branches left out.
 */
import type { UIMessage } from "ai";
import type { ComponentProps, HTMLAttributes, ReactNode } from "react";
import { memo } from "react";
import { Streamdown } from "streamdown";
import { cn } from "../../lib/cn.ts";
import { IconButton } from "../../ui/icon-button.tsx";
import { usePlugins } from "./streamdown-plugins.ts";

export type MessageProps = HTMLAttributes<HTMLDivElement> & { from: UIMessage["role"] };

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn("group flex w-full flex-col gap-2", from === "user" ? "is-user ms-auto max-w-[85%] items-end" : "is-assistant", className)}
    {...props}
  />
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({ className, ...props }: MessageContentProps) => (
  <div
    className={cn(
      "flex min-w-0 max-w-full flex-col gap-3 text-[0.9375rem] leading-relaxed break-words",
      "group-[.is-user]:w-fit group-[.is-user]:rounded-2xl group-[.is-user]:rounded-ee-md group-[.is-user]:bg-accent-soft group-[.is-user]:px-4 group-[.is-user]:py-2.5 group-[.is-user]:whitespace-pre-wrap",
      className,
    )}
    {...props}
  />
);

export type MessageActionsProps = ComponentProps<"div">;

export const MessageActions = ({ className, ...props }: MessageActionsProps) => (
  <div className={cn("-ms-2 flex items-center gap-0.5", className)} {...props} />
);

export type MessageActionProps = Omit<ComponentProps<typeof IconButton>, "label"> & {
  /** Tooltip and accessible name. */
  tooltip: string;
  children: ReactNode;
};

export const MessageAction = ({ tooltip, size = "icon-sm", className, ...props }: MessageActionProps) => (
  <IconButton label={tooltip} size={size} className={cn("text-fg-muted hover:text-fg", className)} {...props} />
);

export type MessageResponseProps = ComponentProps<typeof Streamdown> & { children: string };

/** Markdown for an assistant reply: streams safely, code is highlighted, math and diagrams render. */
export const MessageResponse = memo(
  ({ className, children, ...props }: MessageResponseProps) => {
    const plugins = usePlugins(children);
    return (
      <Streamdown className={cn("prose-z size-full min-w-0 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0", className)} plugins={plugins} {...props}>
        {children}
      </Streamdown>
    );
  },
  (prev, next) => prev.children === next.children && prev.isAnimating === next.isAnimating && prev.mode === next.mode,
);
MessageResponse.displayName = "MessageResponse";
