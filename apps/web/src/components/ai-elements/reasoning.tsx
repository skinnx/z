/**
 * Adapted from AI Elements `reasoning` (https://elements.ai-sdk.dev/components/reasoning).
 * Copyright 2023 Vercel, Inc. Licensed under Apache-2.0; see ./LICENSE and ./NOTICE.
 * Modified for z: Radix Collapsible replaced by z's Base UI Collapsible parts,
 * @radix-ui/react-use-controllable-state by a local hook, z strings (en/vi) and tokens,
 * lazy Streamdown plugins.
 */
import { Brain, ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import { useT } from "../../i18n.ts";
import { cn } from "../../lib/cn.ts";
import { CollapsiblePanel, CollapsibleRoot, CollapsibleTrigger } from "../../ui/collapsible.tsx";
import { Shimmer } from "./shimmer.tsx";
import { usePlugins } from "./streamdown-plugins.ts";
import { useControllableState } from "./use-controllable-state.ts";

type ReasoningContextValue = { isStreaming: boolean; isOpen: boolean; duration: number | undefined };

const ReasoningContext = createContext<ReasoningContextValue | null>(null);

export const useReasoning = () => {
  const context = useContext(ReasoningContext);
  if (!context) throw new Error("Reasoning components must be used within Reasoning");
  return context;
};

export type ReasoningProps = {
  isStreaming?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Seconds spent thinking, when known; otherwise measured while streaming. */
  duration?: number;
  className?: string;
  children: ReactNode;
};

const AUTO_CLOSE_DELAY = 1000;

/** The model's thinking: opens while it streams, closes once (after a beat) when it is done. */
export const Reasoning = memo(({ className, isStreaming = false, open, defaultOpen, onOpenChange, duration: durationProp, children }: ReasoningProps) => {
  const explicitlyClosed = defaultOpen === false;
  const [isOpen, setIsOpen] = useControllableState({ prop: open, defaultProp: defaultOpen ?? isStreaming, onChange: onOpenChange });
  const [measured, setMeasured] = useState<number | undefined>(undefined);
  const duration = durationProp ?? measured;
  const everStreamed = useRef(isStreaming);
  const startedAt = useRef<number | null>(null);
  const [autoClosed, setAutoClosed] = useState(false);

  useEffect(() => {
    if (isStreaming) {
      everStreamed.current = true;
      startedAt.current ??= Date.now();
    } else if (startedAt.current !== null) {
      setMeasured(Math.max(1, Math.ceil((Date.now() - startedAt.current) / 1000)));
      startedAt.current = null;
    }
  }, [isStreaming]);

  useEffect(() => {
    if (isStreaming && !isOpen && !explicitlyClosed) setIsOpen(true);
  }, [isStreaming, isOpen, setIsOpen, explicitlyClosed]);

  useEffect(() => {
    if (everStreamed.current && !isStreaming && isOpen && !autoClosed) {
      const timer = setTimeout(() => {
        setIsOpen(false);
        setAutoClosed(true);
      }, AUTO_CLOSE_DELAY);
      return () => clearTimeout(timer);
    }
  }, [isStreaming, isOpen, setIsOpen, autoClosed]);

  const value = useMemo(() => ({ duration, isOpen, isStreaming }), [duration, isOpen, isStreaming]);

  return (
    <ReasoningContext.Provider value={value}>
      <CollapsibleRoot open={isOpen} onOpenChange={setIsOpen} className={cn("not-prose", className)}>
        {children}
      </CollapsibleRoot>
    </ReasoningContext.Provider>
  );
});
Reasoning.displayName = "Reasoning";

export type ReasoningTriggerProps = {
  className?: string;
  children?: ReactNode;
  getThinkingMessage?: (isStreaming: boolean, duration?: number) => ReactNode;
};

export const ReasoningTrigger = memo(({ className, children, getThinkingMessage }: ReasoningTriggerProps) => {
  const t = useT();
  const { isStreaming, isOpen, duration } = useReasoning();
  const message =
    getThinkingMessage?.(isStreaming, duration) ??
    (isStreaming || duration === 0 ? (
      <Shimmer as="span" duration={1}>
        {t.thinking}
      </Shimmer>
    ) : (
      <span>{duration === undefined ? t.thoughtBriefly : t.thoughtFor(duration)}</span>
    ));

  return (
    <CollapsibleTrigger className={cn("flex min-h-8 items-center gap-2 rounded-md text-sm text-fg-muted transition-colors hover:text-fg", className)}>
      {children ?? (
        <>
          <Brain aria-hidden className="size-4" />
          {message}
          <ChevronDown aria-hidden className={cn("size-4 transition-transform motion-reduce:transition-none", isOpen && "rotate-180")} />
        </>
      )}
    </CollapsibleTrigger>
  );
});
ReasoningTrigger.displayName = "ReasoningTrigger";

export type ReasoningContentProps = { className?: string; children: string };

export const ReasoningContent = memo(({ className, children }: ReasoningContentProps) => {
  const plugins = usePlugins(children);
  return (
    <CollapsiblePanel>
      <div className={cn("prose-z mt-2 border-s-2 border-line ps-3 text-sm text-fg-muted", className)}>
        <Streamdown plugins={plugins}>{children}</Streamdown>
      </div>
    </CollapsiblePanel>
  );
});
ReasoningContent.displayName = "ReasoningContent";
