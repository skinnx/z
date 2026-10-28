/**
 * Adapted from AI Elements `confirmation` (https://elements.ai-sdk.dev/components/confirmation).
 * Copyright 2023 Vercel, Inc. Licensed under Apache-2.0; see ./LICENSE and ./NOTICE.
 * Modified for z: the shadcn Alert is a labelled group in z tokens, z's Button, the action
 * row wraps on narrow screens, and `tone` marks external (always-ask) actions.
 */
import type { ToolUIPart } from "ai";
import type { ComponentProps, ReactNode } from "react";
import { createContext, useContext, useId, useMemo } from "react";
import { cn } from "../../lib/cn.ts";
import { Button } from "../../ui/button.tsx";

export type ToolUIPartApproval = { id: string; approved?: boolean; reason?: string } | undefined;

type ConfirmationContextValue = { approval: ToolUIPartApproval; state: ToolUIPart["state"]; titleId: string };

const ConfirmationContext = createContext<ConfirmationContextValue | null>(null);

const useConfirmation = () => {
  const context = useContext(ConfirmationContext);
  if (!context) throw new Error("Confirmation components must be used within Confirmation");
  return context;
};

export type ConfirmationProps = ComponentProps<"div"> & {
  approval?: ToolUIPartApproval;
  state: ToolUIPart["state"];
  tone?: "default" | "danger";
};

/** Asks before a tool runs, then remembers the answer in place. Renders nothing before approval is involved. */
export const Confirmation = ({ className, approval, state, tone = "default", ...props }: ConfirmationProps) => {
  const titleId = useId();
  const value = useMemo(() => ({ approval, state, titleId }), [approval, state, titleId]);
  if (!approval || state === "input-streaming" || state === "input-available") return null;
  const asking = state === "approval-requested";
  return (
    <ConfirmationContext.Provider value={value}>
      <div
        role="group"
        aria-labelledby={titleId}
        className={cn(
          "@container flex flex-col gap-3 rounded-xl border p-3 text-sm",
          asking ? (tone === "danger" ? "border-danger/50 bg-danger-soft/40" : "border-warn/50 bg-warn-soft/50") : "border-line bg-subtle/40",
          className,
        )}
        {...props}
      />
    </ConfirmationContext.Provider>
  );
};

export const ConfirmationTitle = ({ className, ...props }: ComponentProps<"div">) => {
  const { titleId } = useConfirmation();
  return <div id={titleId} className={cn("min-w-0 leading-snug break-words", className)} {...props} />;
};

/** Shown only while the answer is pending. */
export const ConfirmationRequest = ({ children }: { children?: ReactNode }) => {
  const { state } = useConfirmation();
  return state === "approval-requested" ? children : null;
};

const answered = (state: ToolUIPart["state"]) => state === "approval-responded" || state === "output-denied" || state === "output-available" || state === "output-error";

export const ConfirmationAccepted = ({ children }: { children?: ReactNode }) => {
  const { approval, state } = useConfirmation();
  return approval?.approved === true && answered(state) ? children : null;
};

export const ConfirmationRejected = ({ children }: { children?: ReactNode }) => {
  const { approval, state } = useConfirmation();
  return approval?.approved === false && answered(state) ? children : null;
};

export const ConfirmationActions = ({ className, ...props }: ComponentProps<"div">) => {
  const { state } = useConfirmation();
  if (state !== "approval-requested") return null;
  return <div className={cn("flex flex-wrap gap-2 @md:justify-end [&>*]:flex-1 @md:[&>*]:flex-none", className)} {...props} />;
};

export const ConfirmationAction = ({ size = "sm", ...props }: ComponentProps<typeof Button>) => <Button size={size} {...props} />;
