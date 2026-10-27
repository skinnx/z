import { createStored } from "./store.ts";

export type ThemePref = "system" | "light" | "dark";

export const theme = createStored<ThemePref>(
  "z.theme",
  () => "system",
  (v): v is ThemePref => v === "system" || v === "light" || v === "dark",
);

export function applyTheme(pref: ThemePref) {
  const root = document.documentElement;
  if (pref === "system") delete root.dataset.theme;
  else root.dataset.theme = pref;
}

theme.subscribe(() => applyTheme(theme.get()));
applyTheme(theme.get());

/** Flip between light and dark relative to what is currently shown. */
export function toggleTheme() {
  const dark =
    document.documentElement.dataset.theme === "dark" ||
    (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
  theme.set(dark ? "light" : "dark");
}
