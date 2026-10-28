/**
 * After AI Elements `loader` (an earlier registry item, no longer published there).
 * Copyright 2023 Vercel, Inc. Licensed under Apache-2.0; see ./LICENSE and ./NOTICE.
 * Modified for z: z's Spinner, stopped under prefers-reduced-motion.
 */
import { cn } from "../../lib/cn.ts";
import { Spinner } from "../../ui/card.tsx";

export type LoaderProps = { className?: string; size?: number };

/** A small busy indicator; pair it with visible or sr-only text that says what is happening. */
export const Loader = ({ className, size = 16 }: LoaderProps) => (
  <span className={cn("inline-flex items-center justify-center text-fg-muted", className)} style={{ width: size, height: size }}>
    <Spinner className="size-full" />
  </span>
);
