/**
 * Adapted from AI Elements `suggestion` (https://elements.ai-sdk.dev/components/suggestion).
 * Copyright 2023 Vercel, Inc. Licensed under Apache-2.0; see ./LICENSE and ./NOTICE.
 * Modified for z: z's Button; chips wrap instead of scrolling sideways (no ScrollArea), so all
 * of them stay visible and reachable at 390 px; the list is a labelled group.
 */
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/cn.ts";
import { Button } from "../../ui/button.tsx";

export const Suggestions = ({ className, label, children }: { className?: string; label: string; children: ReactNode }) => (
  <div role="group" aria-label={label} className={cn("flex flex-wrap items-center justify-center gap-2", className)}>
    {children}
  </div>
);

export type SuggestionProps = Omit<ComponentProps<typeof Button>, "onClick" | "children"> & {
  suggestion: string;
  onClick?: (suggestion: string) => void;
  children?: ReactNode;
};

export const Suggestion = ({ suggestion, onClick, className, variant = "secondary", size = "sm", children, ...props }: SuggestionProps) => (
  <Button className={cn("h-auto min-h-9 rounded-full px-4 py-1.5 whitespace-normal", className)} onClick={() => onClick?.(suggestion)} size={size} variant={variant} {...props}>
    {children ?? suggestion}
  </Button>
);
