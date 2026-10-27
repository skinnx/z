export type Preset = "once" | "daily" | "weekdays" | "custom";

const SIMPLE = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5)$/;

/** Build a cron expression from a preset and an "HH:MM" time. */
export function toCron(preset: Preset, hhmm: string, custom: string): string | undefined {
  if (preset === "once") return undefined;
  if (preset === "custom") return custom.trim() || undefined;
  const [h = "9", m = "0"] = hhmm.split(":");
  return `${Number(m)} ${Number(h)} * * ${preset === "weekdays" ? "1-5" : "*"}`;
}

/** Recognise the presets this UI writes; anything else is "custom". */
export function parseCron(cron: string | null | undefined): { preset: Preset; time: string } {
  if (!cron) return { preset: "once", time: "09:00" };
  const m = SIMPLE.exec(cron.trim());
  if (!m) return { preset: "custom", time: "09:00" };
  const time = `${m[2]!.padStart(2, "0")}:${m[1]!.padStart(2, "0")}`;
  return { preset: m[3] === "1-5" ? "weekdays" : "daily", time };
}

/** How often a watch checks. */
export type WatchEvery = "hourly" | "4h" | "daily" | "custom";

export function watchCron(every: WatchEvery, hhmm: string, custom: string): string | undefined {
  if (every === "hourly") return "0 * * * *";
  if (every === "4h") return "0 */4 * * *";
  return toCron(every, hhmm, custom);
}

export function isValidCron(cron: string): boolean {
  const parts = cron.trim().split(/\s+/);
  return parts.length >= 5 && parts.length <= 6 && parts.every((p) => /^[\d*/,\-A-Za-z?LW#]+$/.test(p));
}
