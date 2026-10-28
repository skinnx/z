import type { DictOf } from "./types.ts";

export const en = {
  // plugins
  pluginSettings: "Settings",
  inBriefing: "Feeds the briefing",
  noPlugins: "No plugins installed on this server.",
} as const;

export const vi: DictOf<typeof en> = {
  pluginSettings: "Cài đặt",
  inBriefing: "Góp vào bản tin",
  noPlugins: "Máy chủ chưa cài tiện ích nào.",
};
