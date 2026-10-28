import type { ReactNode } from "react";
import { cn } from "../lib/cn.ts";

/**
 * The frame of every screen: one width, one gutter, one rhythm between sections. The name is for
 * screen readers only; the layout leads with the screen's primary action (a `md` primary button).
 */
export function Page({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("mx-auto flex w-full max-w-4xl flex-col gap-8 px-4 py-6 md:px-8 md:py-10", className)}>
      <h1 className="sr-only">{title}</h1>
      {children}
    </div>
  );
}
