import { Cron } from "croner";

export function isValidCron(pattern: string, timezone?: string): boolean {
  try {
    new Cron(pattern, timezone ? { timezone } : {});
    return true;
  } catch {
    return false;
  }
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** The first run strictly after `from` (default: now), or null for an invalid or exhausted pattern. */
export function nextRunAt(pattern: string, timezone: string, from: Date = new Date()): string | null {
  try {
    return new Cron(pattern, { timezone }).nextRun(from)?.toISOString() ?? null;
  } catch {
    return null;
  }
}
