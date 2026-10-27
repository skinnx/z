/** Shared look for floating listbox/menu popups. */
export const popupClass =
  "z-50 min-w-[var(--anchor-width)] max-w-[var(--available-width)] origin-[var(--transform-origin)] overflow-hidden rounded-xl border border-line bg-surface text-fg shadow-xl transition-[scale,opacity] duration-100 data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0";

export const itemClass =
  "flex min-h-9 cursor-default select-none items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none data-highlighted:bg-subtle data-disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0";
