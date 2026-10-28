/**
 * Time zones as people search for them: by city ("Ho Chi Minh", "Kolkata", "New York"), with or
 * without spaces and diacritics, by old names ("Saigon", "Calcutta") and by UTC offset ("UTC+7").
 */
import type { Settings } from "@z/core";
import { keys, queryClient } from "../api/query.ts";

/**
 * Old IANA names some browsers still list or report (ICU keeps them canonical) → today's names.
 * The current name is what z stores and shows; the old one stays searchable.
 */
const RENAMED: Record<string, string> = {
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Rangoon": "Asia/Yangon",
  "Asia/Dacca": "Asia/Dhaka",
  "Asia/Thimbu": "Asia/Thimphu",
  "Asia/Ulan_Bator": "Asia/Ulaanbaatar",
  "Asia/Macao": "Asia/Macau",
  "Asia/Ujung_Pandang": "Asia/Makassar",
  "Asia/Chongqing": "Asia/Shanghai",
  "Asia/Chungking": "Asia/Shanghai",
  "Asia/Harbin": "Asia/Shanghai",
  "Asia/Kashgar": "Asia/Urumqi",
  "Asia/Tel_Aviv": "Asia/Jerusalem",
  "Europe/Kiev": "Europe/Kyiv",
  "Europe/Uzhgorod": "Europe/Kyiv",
  "Europe/Zaporozhye": "Europe/Kyiv",
  "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
  "America/Indianapolis": "America/Indiana/Indianapolis",
  "America/Louisville": "America/Kentucky/Louisville",
  "America/Godthab": "America/Nuuk",
  "Atlantic/Faeroe": "Atlantic/Faroe",
  "Pacific/Truk": "Pacific/Chuuk",
  "Pacific/Ponape": "Pacific/Pohnpei",
  "Pacific/Enderbury": "Pacific/Kanton",
  "Africa/Asmera": "Africa/Asmara",
  "Etc/UTC": "UTC",
  "Etc/GMT": "UTC",
  GMT: "UTC",
  "Etc/Universal": "UTC",
  "Etc/Zulu": "UTC",
};

/** Other words people type for a zone: old city names, big cities without a zone of their own, countries. */
const ALIASES: Record<string, string[]> = {
  "Asia/Ho_Chi_Minh": ["Saigon", "Sài Gòn", "Hanoi", "Hà Nội", "Da Nang", "Đà Nẵng", "Vietnam", "Việt Nam"],
  "Asia/Kolkata": ["Calcutta", "Mumbai", "Bombay", "Delhi", "New Delhi", "Bangalore", "Bengaluru", "Chennai", "India", "IST"],
  "America/New_York": ["NYC", "Boston", "Washington", "Miami", "Atlanta", "Philadelphia", "Eastern", "EST", "EDT", "ET"],
  "America/Chicago": ["Dallas", "Houston", "Austin", "Central", "CST", "CDT"],
  "America/Denver": ["Mountain", "MST", "MDT"],
  "America/Phoenix": ["Arizona"],
  "America/Los_Angeles": ["LA", "San Francisco", "SF", "Seattle", "San Diego", "Pacific", "PST", "PDT", "PT", "California"],
  "America/Toronto": ["Ottawa", "Montreal"],
  "America/Sao_Paulo": ["Rio de Janeiro", "Brazil"],
  "America/Mexico_City": ["Mexico"],
  "America/Argentina/Buenos_Aires": ["Argentina"],
  "Europe/London": ["UK", "England", "Britain", "GMT", "BST"],
  "Europe/Paris": ["France"],
  "Europe/Berlin": ["Germany", "Munich", "Frankfurt", "Hamburg"],
  "Europe/Madrid": ["Spain", "Barcelona"],
  "Europe/Rome": ["Italy", "Milan"],
  "Europe/Amsterdam": ["Netherlands", "Holland"],
  "Europe/Zurich": ["Switzerland", "Geneva"],
  "Europe/Kyiv": ["Kiev", "Ukraine"],
  "Europe/Moscow": ["Russia", "Saint Petersburg"],
  "Europe/Istanbul": ["Turkey", "Ankara"],
  "Asia/Shanghai": ["Beijing", "Peking", "Shenzhen", "Guangzhou", "China", "CST"],
  "Asia/Hong_Kong": ["HK"],
  "Asia/Taipei": ["Taiwan"],
  "Asia/Tokyo": ["Japan", "Osaka", "JST"],
  "Asia/Seoul": ["Korea", "KST"],
  "Asia/Singapore": ["SG"],
  "Asia/Bangkok": ["Thailand", "Phnom Penh", "Vientiane"],
  "Asia/Jakarta": ["Indonesia", "WIB"],
  "Asia/Manila": ["Philippines"],
  "Asia/Kuala_Lumpur": ["Malaysia", "KL"],
  "Asia/Dubai": ["UAE", "Abu Dhabi"],
  "Asia/Karachi": ["Pakistan", "Lahore", "Islamabad"],
  "Asia/Dhaka": ["Dacca", "Bangladesh"],
  "Asia/Kathmandu": ["Katmandu", "Nepal"],
  "Asia/Yangon": ["Rangoon", "Myanmar", "Burma"],
  "Asia/Jerusalem": ["Tel Aviv", "Israel"],
  "Australia/Sydney": ["Australia", "Canberra", "AEST"],
  "Pacific/Auckland": ["New Zealand", "Wellington", "NZ"],
  "Africa/Johannesburg": ["South Africa", "Cape Town"],
  "Africa/Lagos": ["Nigeria"],
  "Africa/Cairo": ["Egypt"],
  "Africa/Nairobi": ["Kenya"],
  UTC: ["GMT", "Zulu", "Coordinated Universal Time"],
};

/** The current IANA name for a zone the browser or an old setting reports. */
export const canonicalZone = (tz: string): string => RENAMED[tz] ?? tz;

/** This device's zone, by its current name ("UTC" when the browser won't say). */
export function deviceZone(): string {
  try {
    return canonicalZone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  } catch {
    return "UTC";
  }
}

/** Lowercase, no diacritics (đ included), every separator one space. */
export function fold(text: string): string {
  return text
    .replace(/[đĐ]/g, "d")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9+]+/g, " ")
    .trim();
}

/** "Asia/Ho_Chi_Minh" → "Ho Chi Minh"; "America/Argentina/Buenos_Aires" → "Buenos Aires". */
export function zoneCity(tz: string): string {
  return (tz.split("/").pop() ?? tz).replace(/_/g, " ");
}

/** "UTC+7", "UTC+5:30", "UTC" for the zone right now. */
export function zoneOffset(tz: string, at = new Date()): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "";
    return part.replace(/^GMT/, "UTC");
  } catch {
    return "";
  }
}

/** Every zone this browser knows, by current names, UTC first. */
export function zoneList(): string[] {
  let list: string[] = [];
  try {
    list = Intl.supportedValuesOf("timeZone");
  } catch {}
  const names = new Set(["UTC", ...list.map(canonicalZone), ...Object.keys(ALIASES)]);
  // A name this browser can't format would only fail on save.
  return [...names].filter((tz) => zoneOffset(tz) !== "" || tz === "UTC");
}

/** How a zone reads in lists and the field: "Ho Chi Minh · Asia/Ho_Chi_Minh · UTC+7". */
export function zoneLabel(tz: string): string {
  if (tz === "UTC") return "UTC";
  return `${zoneCity(tz)} · ${tz} · ${zoneOffset(tz)}`;
}

const searchCache = new Map<string, { spaced: string; joined: string }>();

function searchText(tz: string) {
  let hit = searchCache.get(tz);
  if (!hit) {
    const old = Object.entries(RENAMED)
      .filter(([, now]) => now === tz)
      .map(([was]) => was);
    const offset = zoneOffset(tz);
    let longName = "";
    try {
      longName = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "long" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value ?? "";
    } catch {}
    const spaced = fold([tz, ...old, ...(ALIASES[tz] ?? []), offset, offset.replace(/^UTC/, "GMT"), longName].join(" "));
    hit = { spaced: ` ${spaced} `, joined: spaced.replace(/ /g, "") };
    searchCache.set(tz, hit);
  }
  return hit;
}

/** Whether a zone matches what was typed: every word somewhere, or the whole query with spaces dropped. */
export function zoneMatches(tz: string, query: string): boolean {
  const q = fold(query);
  if (!q) return true;
  const { spaced, joined } = searchText(tz);
  if (joined.includes(q.replace(/ /g, ""))) return true;
  return q.split(" ").every((word) => spaced.includes(word));
}

/** The zone schedules run in (Settings), by current name; null until settings load. */
export function scheduleZone(): string | null {
  const tz = queryClient.getQueryData<Settings>(keys.settings)?.timezone;
  return tz ? canonicalZone(tz) : null;
}

/**
 * The zone to name next to a schedule time, or null when it is this device's own (then the time is
 * unambiguous). `always`: name it even then (where the time is being chosen).
 */
export function zoneHint(always = false): string | null {
  const tz = scheduleZone();
  if (!tz) return null;
  if (!always && tz === deviceZone()) return null;
  return tz === "UTC" ? "UTC" : zoneCity(tz);
}

/** "Weekdays at 08:00" → "Weekdays at 08:00 (Ho Chi Minh)" when schedules run on another clock than this device's. */
export function withZone(text: string): string {
  const zone = zoneHint();
  return zone ? `${text} (${zone})` : text;
}
