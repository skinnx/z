/**
 * Adapted from AI Elements `prompt-input` (https://elements.ai-sdk.dev/components/prompt-input).
 * Copyright 2023 Vercel, Inc. Licensed under Apache-2.0; see ./LICENSE and ./NOTICE.
 * Modified for z: the shadcn InputGroup is a styled container in z tokens, Radix Tooltip →
 * z's Tooltip (Base UI), Spinner → z's Spinner; the textarea is labelled, grows with its
 * content and never submits mid-composition (IME, e.g. Vietnamese Telex); submit labels come
 * from z's i18n. Attachments, screenshots, action menus and tabs are left out (z's chat takes
 * text); the command popover is z's skill slash menu (../skill-menu.tsx).
 */
import type { ChatStatus } from "ai";
import { ArrowUp, Square, X } from "lucide-react";
import type { ComponentProps, FormEvent, KeyboardEvent, ReactNode } from "react";
import { useRef } from "react";
import { useT } from "../../i18n.ts";
import { cn } from "../../lib/cn.ts";
import { Button } from "../../ui/button.tsx";
import { Spinner } from "../../ui/card.tsx";
import { Tooltip } from "../../ui/tooltip.tsx";

export type PromptInputMessage = { text: string };

export type PromptInputProps = Omit<ComponentProps<"form">, "onSubmit"> & {
  onSubmit: (message: PromptInputMessage, event: FormEvent<HTMLFormElement>) => void | Promise<void>;
};

/** The message box: a form whose textarea grows, with a footer for tools and the submit button. */
export const PromptInput = ({ className, onSubmit, children, ...props }: PromptInputProps) => (
  <form
    className={cn(
      "w-full overflow-hidden rounded-2xl border border-line bg-surface shadow-sm transition-colors has-[textarea:focus-visible]:border-accent has-[textarea:focus-visible]:outline-2 has-[textarea:focus-visible]:-outline-offset-1 has-[textarea:focus-visible]:outline-accent",
      className,
    )}
    onSubmit={(event) => {
      event.preventDefault();
      const text = String(new FormData(event.currentTarget).get("message") ?? "");
      void onSubmit({ text }, event);
    }}
    {...props}
  >
    {children}
  </form>
);

export const PromptInputBody = ({ className, ...props }: ComponentProps<"div">) => <div className={cn("flex flex-col", className)} {...props} />;

export type PromptInputTextareaProps = Omit<ComponentProps<"textarea">, "name"> & {
  /** Accessible name (the placeholder is not one). */
  label: string;
  /** Enter sends and Shift+Enter breaks the line (default), or ⌘/Ctrl+Enter sends. */
  submitOn?: "enter" | "mod-enter";
};

export const PromptInputTextarea = ({ label, submitOn = "enter", onKeyDown, onCompositionStart, onCompositionEnd, className, ...props }: PromptInputTextareaProps) => {
  const composing = useRef(false);
  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented || e.key !== "Enter") return;
    // IME composition (Vietnamese, CJK…) uses Enter to commit; Safari reports keyCode 229 after compositionend.
    if (composing.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
    const send = submitOn === "enter" ? !e.shiftKey : e.metaKey || e.ctrlKey;
    if (!send) return;
    e.preventDefault();
    const form = e.currentTarget.form;
    const submit = form?.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (submit?.disabled) return;
    form?.requestSubmit();
  };
  return (
    <textarea
      name="message"
      aria-label={label}
      rows={1}
      onCompositionStart={(e) => {
        composing.current = true;
        onCompositionStart?.(e);
      }}
      onCompositionEnd={(e) => {
        composing.current = false;
        onCompositionEnd?.(e);
      }}
      onKeyDown={handleKeyDown}
      className={cn(
        "block max-h-48 min-h-14 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-[0.9375rem] leading-6 outline-none [field-sizing:content] placeholder:text-fg-muted",
        className,
      )}
      {...props}
    />
  );
};

export const PromptInputHeader = ({ className, ...props }: ComponentProps<"div">) => <div className={cn("flex flex-wrap gap-1 px-3 pt-2", className)} {...props} />;

export const PromptInputFooter = ({ className, ...props }: ComponentProps<"div">) => (
  <div className={cn("flex items-center justify-between gap-2 p-1.5 ps-2", className)} {...props} />
);

export const PromptInputTools = ({ className, ...props }: ComponentProps<"div">) => <div className={cn("flex min-w-0 flex-1 flex-wrap items-center gap-1", className)} {...props} />;

export type PromptInputButtonProps = ComponentProps<typeof Button> & { tooltip?: ReactNode };

export const PromptInputButton = ({ variant = "ghost", size, tooltip, children, ...props }: PromptInputButtonProps) => {
  const button = (
    <Button variant={variant} size={size ?? "sm"} {...props}>
      {children}
    </Button>
  );
  return tooltip ? <Tooltip label={tooltip}>{button}</Tooltip> : button;
};

export type PromptInputSubmitProps = Omit<ComponentProps<typeof Button>, "type"> & {
  status?: ChatStatus;
  onStop?: () => void;
};

/** Send while idle; Stop while a reply is on its way (with `onStop`). */
export const PromptInputSubmit = ({ className, variant = "primary", size = "icon", status, onStop, onClick, children, disabled, ...props }: PromptInputSubmitProps) => {
  const t = useT();
  const generating = status === "submitted" || status === "streaming";
  const stopping = generating && !!onStop;
  const icon =
    status === "submitted" && !onStop ? <Spinner /> : generating ? <Square aria-hidden className="fill-current" /> : status === "error" ? <X aria-hidden /> : <ArrowUp aria-hidden />;
  return (
    <Button
      aria-label={children ? undefined : stopping ? t.stop : t.send}
      title={children ? undefined : stopping ? t.stop : t.send}
      className={cn("rounded-xl", className)}
      size={size}
      variant={stopping ? "secondary" : variant}
      type={stopping ? "button" : "submit"}
      disabled={stopping ? false : disabled}
      onClick={(e) => {
        if (stopping) {
          e.preventDefault();
          onStop?.();
          return;
        }
        onClick?.(e);
      }}
      {...props}
    >
      {children ?? icon}
    </Button>
  );
};
