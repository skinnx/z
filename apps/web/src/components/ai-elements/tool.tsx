/**
 * Adapted from AI Elements `tool` (https://elements.ai-sdk.dev/components/tool).
 * Copyright 2023 Vercel, Inc. Licensed under Apache-2.0; see ./LICENSE and ./NOTICE.
 * Modified for z: Radix Collapsible replaced by z's Base UI Collapsible parts, shadcn Badge by
 * z's Badge, status labels from z's i18n (en/vi), z tokens.
 */
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import { getToolName } from "ai";
import { CheckCircle, ChevronDown, Circle, Clock, ShieldQuestion, Wrench, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import { isValidElement } from "react";
import { useT, type Dict } from "../../i18n.ts";
import { cn } from "../../lib/cn.ts";
import { Badge } from "../../ui/card.tsx";
import { CollapsiblePanel, CollapsibleRoot, CollapsibleTrigger, type CollapsibleRootProps } from "../../ui/collapsible.tsx";
import { CodeBlock } from "./code-block.tsx";

export type ToolPart = ToolUIPart | DynamicToolUIPart;
type State = ToolPart["state"];

export type ToolProps = Omit<CollapsibleRootProps, "className"> & { className?: string; state?: State };

export const Tool = ({ className, state, ...props }: ToolProps) => (
  <CollapsibleRoot
    className={cn(
      "group/tool not-prose w-full rounded-xl border bg-surface",
      state === "approval-requested" ? "border-warn/60" : state === "output-error" ? "border-danger/40" : "border-line",
      className,
    )}
    {...props}
  />
);

const statusLabel = (t: Dict): Record<State, string> => ({
  "input-streaming": t.toolPending,
  "input-available": t.toolRunning,
  "approval-requested": t.toolAwaiting,
  "approval-responded": t.toolResponded,
  "output-available": t.toolDone,
  "output-error": t.toolError,
  "output-denied": t.toolDenied,
});

const statusIcon: Record<State, ReactNode> = {
  "input-streaming": <Circle aria-hidden className="text-fg-muted" />,
  "input-available": <Clock aria-hidden className="motion-safe:animate-pulse" />,
  "approval-requested": <ShieldQuestion aria-hidden className="text-warn" />,
  "approval-responded": <CheckCircle aria-hidden className="text-accent-text" />,
  "output-available": <CheckCircle aria-hidden className="text-ok" />,
  "output-error": <XCircle aria-hidden className="text-danger" />,
  "output-denied": <XCircle aria-hidden className="text-fg-muted" />,
};

const statusTone: Partial<Record<State, "warn" | "danger" | "ok">> = { "approval-requested": "warn", "output-error": "danger" };

export function ToolStatusBadge({ state }: { state: State }) {
  const t = useT();
  return (
    <Badge tone={statusTone[state] ?? "neutral"} className="shrink-0">
      {statusIcon[state]}
      {statusLabel(t)[state]}
    </Badge>
  );
}

export type ToolHeaderProps = { part: ToolPart; title?: string; className?: string };

export const ToolHeader = ({ part, title, className }: ToolHeaderProps) => (
  <CollapsibleTrigger className={cn("flex min-h-11 w-full items-center gap-2 rounded-xl px-3 py-2 text-start", className)}>
    <Wrench aria-hidden className="size-4 shrink-0 text-fg-muted" />
    <code className="min-w-0 flex-1 truncate font-mono text-xs">{title ?? getToolName(part)}</code>
    <ToolStatusBadge state={part.state} />
    <ChevronDown aria-hidden className="size-4 shrink-0 text-fg-muted transition-transform motion-reduce:transition-none group-data-[open]/tool:rotate-180" />
  </CollapsibleTrigger>
);

export const ToolContent = ({ className, children }: { className?: string; children: ReactNode }) => (
  <CollapsiblePanel>
    <div className={cn("flex flex-col gap-3 border-t border-line p-3", className)}>{children}</div>
  </CollapsiblePanel>
);

const heading = "text-xs font-medium tracking-wide text-fg-muted uppercase";

export const ToolInput = ({ input, className }: { input: ToolPart["input"]; className?: string }) => {
  const t = useT();
  if (input === undefined) return null;
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <h4 className={heading}>{t.toolParameters}</h4>
      <CodeBlock code={JSON.stringify(input, null, 2) ?? ""} language="json" />
    </div>
  );
};

export const ToolOutput = ({ output, errorText, className }: { output: ToolPart["output"]; errorText: ToolPart["errorText"]; className?: string }) => {
  const t = useT();
  if (!(output || errorText)) return null;
  let body: ReactNode = null;
  if (isValidElement(output)) body = output;
  else if (typeof output === "string") body = <CodeBlock code={output} language="text" />;
  else if (output !== undefined) body = <CodeBlock code={JSON.stringify(output, null, 2) ?? ""} language="json" />;
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <h4 className={heading}>{errorText ? t.toolErrorLabel : t.toolResult}</h4>
      {errorText && <p className="rounded-lg bg-danger-soft p-2 text-xs break-words text-danger">{errorText}</p>}
      {body && <div className="max-h-72 overflow-auto rounded-lg">{body}</div>}
    </div>
  );
};
