import type { Settings } from "./contract.ts";

/** Local date (YYYY-MM-DD) in a time zone; falls back to UTC for unknown zones. */
export function localDate(date: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function localDateTime(date: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: timezone, dateStyle: "full", timeStyle: "short" }).format(date);
  } catch {
    return date.toISOString();
  }
}

/** Shared preamble: who z is, the user's persona notes and the current time. */
export function baseInstructions(settings: Settings, now: Date, role: string): string {
  const parts = [
    `You are ${settings.handle}, a personal AI agent. ${role}`,
    `Current time for the user: ${localDateTime(now, settings.timezone)} (${settings.timezone}).`,
  ];
  if (settings.persona.trim()) parts.push(`About the user and how to behave:\n${settings.persona.trim()}`);
  return parts.join("\n\n");
}
