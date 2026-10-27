import type { ComponentProps, ReactNode } from "react";
import { Button } from "./button.tsx";
import { Tooltip } from "./tooltip.tsx";

/** An icon-only button with a tooltip that doubles as its aria-label. */
export function IconButton({
  label,
  children,
  size = "icon",
  variant = "ghost",
  ...props
}: Omit<ComponentProps<typeof Button>, "children" | "aria-label"> & { label: string; children: ReactNode }) {
  return (
    <Tooltip label={label}>
      <Button aria-label={label} size={size} variant={variant} {...props}>
        {children}
      </Button>
    </Tooltip>
  );
}
