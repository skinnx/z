import type { ComponentProps, ReactNode } from "react";
import { Button } from "./button.tsx";
import { Tooltip, type TooltipHandle } from "./tooltip.tsx";

/** An icon-only button with a tooltip that doubles as its aria-label (in long lists, a shared one: `tooltipHandle`). */
export function IconButton({
  label,
  children,
  size = "icon",
  variant = "ghost",
  tooltipHandle,
  ...props
}: Omit<ComponentProps<typeof Button>, "children" | "aria-label"> & { label: string; children: ReactNode; tooltipHandle?: TooltipHandle }) {
  return (
    <Tooltip label={label} handle={tooltipHandle}>
      <Button aria-label={label} size={size} variant={variant} {...props}>
        {children}
      </Button>
    </Tooltip>
  );
}
