/**
 * Adapted from AI Elements `shimmer` (https://elements.ai-sdk.dev/components/shimmer).
 * Copyright 2023 Vercel, Inc. Licensed under Apache-2.0; see ./LICENSE and ./NOTICE.
 * Modified for z: a CSS keyframe animation (app.css `animate-shimmer`) instead of `motion`,
 * stopped under prefers-reduced-motion; z tokens.
 */
import type { CSSProperties, ElementType } from "react";
import { memo } from "react";
import { cn } from "../../lib/cn.ts";

export type TextShimmerProps = {
  children: string;
  as?: ElementType;
  className?: string;
  /** Seconds per sweep. */
  duration?: number;
  /** Highlight width per character, in px. */
  spread?: number;
};

const ShimmerComponent = ({ children, as: Component = "p", className, duration = 2, spread = 2 }: TextShimmerProps) => (
  <Component
    className={cn(
      "relative inline-block bg-[length:250%_100%,auto] bg-clip-text text-transparent [background-repeat:no-repeat,padding-box]",
      "animate-shimmer motion-reduce:animate-none motion-reduce:bg-none motion-reduce:text-fg-muted",
      className,
    )}
    style={
      {
        "--spread": `${children.length * spread}px`,
        "--shimmer-duration": `${duration}s`,
        backgroundImage:
          "linear-gradient(90deg, #0000 calc(50% - var(--spread)), var(--color-surface), #0000 calc(50% + var(--spread))), linear-gradient(var(--color-fg-muted), var(--color-fg-muted))",
      } as CSSProperties
    }
  >
    {children}
  </Component>
);

export const Shimmer = memo(ShimmerComponent);
