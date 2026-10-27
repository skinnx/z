import { locale } from "../i18n.ts";

const units: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31536000],
  ["month", 2592000],
  ["week", 604800],
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
];

/** "in 3 hours", "5 minutes ago", "now". */
export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const diff = (new Date(iso).getTime() - now) / 1000;
  const fmt = new Intl.RelativeTimeFormat(locale.get(), { numeric: "auto" });
  for (const [unit, secs] of units) {
    if (Math.abs(diff) >= secs) return fmt.format(Math.round(diff / secs), unit);
  }
  return fmt.format(Math.round(diff / 60), "minute");
}

export function dateTime(iso: string): string {
  return new Intl.DateTimeFormat(locale.get(), { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

export function time(iso: string): string {
  return new Intl.DateTimeFormat(locale.get(), { timeStyle: "short" }).format(new Date(iso));
}

export function longDate(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Intl.DateTimeFormat(locale.get(), { weekday: "long", month: "long", day: "numeric" }).format(
    new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1),
  );
}

export function usd(n: number): string {
  return new Intl.NumberFormat(locale.get(), { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(n);
}

export function compact(n: number): string {
  return new Intl.NumberFormat(locale.get(), { notation: "compact" }).format(n);
}

/** Lowercase slug usable as a provider/channel id. */
export function slug(text: string): string {
  return (
    text
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || ""
  );
}

export function json(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
