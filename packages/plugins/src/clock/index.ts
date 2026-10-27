import { definePlugin, defineTool } from "@z/core";
import { z } from "zod";

/** `2026-10-27T09:15:00+01:00`-style local timestamp for `date` in `timeZone`. */
export function localIso(date: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "longOffset",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  // longOffset renders as "GMT+05:30", or plain "GMT" for UTC.
  const offset = (parts.timeZoneName ?? "GMT").replace("GMT", "") || "+00:00";
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}

const now = defineTool({
  description: "Current date and time in an IANA timezone (e.g. Europe/Paris). Defaults to UTC.",
  risk: "read",
  inputSchema: z.object({ timezone: z.string().default("UTC") }),
  execute: async ({ timezone }) => {
    const date = new Date();
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    } catch {
      throw new Error(`Unknown timezone "${timezone}". Use an IANA name like America/New_York.`);
    }
    return {
      timezone,
      local: localIso(date, timezone),
      utc: date.toISOString(),
      readable: new Intl.DateTimeFormat("en-US", { timeZone: timezone, dateStyle: "full", timeStyle: "long" }).format(date),
    };
  },
});

export default definePlugin({
  id: "clock",
  name: "Clock",
  description: "Current date and time in any timezone.",
  tools: { now },
});
