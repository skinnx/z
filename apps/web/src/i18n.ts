import { createStored } from "./lib/store.ts";
import type { Widen } from "./i18n/types.ts";
import * as shell from "./i18n/shell.ts";
import * as common from "./i18n/common.ts";
import * as today from "./i18n/today.ts";
import * as chat from "./i18n/chat.ts";
import * as tasks from "./i18n/tasks.ts";
import * as models from "./i18n/models.ts";
import * as connect from "./i18n/connect.ts";
import * as channels from "./i18n/channels.ts";
import * as plugins from "./i18n/plugins.ts";
import * as settings from "./i18n/settings.ts";
import * as setup from "./i18n/setup.ts";
import * as skills from "./i18n/skills.ts";
import * as notices from "./i18n/notices.ts";
import * as approvals from "./i18n/approvals.ts";
import * as recovery from "./i18n/recovery.ts";

// Strings live per app area in ./i18n/<area>.ts (en + vi each); keys are unique across areas (`pnpm check:i18n`).
const en = {
  ...shell.en,
  ...common.en,
  ...today.en,
  ...chat.en,
  ...tasks.en,
  ...models.en,
  ...connect.en,
  ...channels.en,
  ...plugins.en,
  ...settings.en,
  ...setup.en,
  ...skills.en,
  ...notices.en,
  ...approvals.en,
  ...recovery.en,
} as const;

export type Dict = { [K in keyof typeof en]: Widen<(typeof en)[K]> };

const vi: Dict = {
  ...shell.vi,
  ...common.vi,
  ...today.vi,
  ...chat.vi,
  ...tasks.vi,
  ...models.vi,
  ...connect.vi,
  ...channels.vi,
  ...plugins.vi,
  ...settings.vi,
  ...setup.vi,
  ...skills.vi,
  ...notices.vi,
  ...approvals.vi,
  ...recovery.vi,
};

export type Locale = "en" | "vi";
const dicts: Record<Locale, Dict> = { en, vi };

export const locale = createStored<Locale>(
  "z.lang",
  () => (typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("vi") ? "vi" : "en"),
  (v): v is Locale => v === "en" || v === "vi",
);

function applyLang() {
  document.documentElement.lang = locale.get();
}
locale.subscribe(applyLang);
applyLang();

export function useT(): Dict {
  return dicts[locale.use()];
}

/** For code outside React (toasts from live events). */
export function t(): Dict {
  return dicts[locale.get()];
}
