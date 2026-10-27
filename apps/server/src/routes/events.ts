/** `GET /api/events`: LiveEvents as SSE `data:` lines, with heartbeats to keep proxies open. */
import type { LiveEvent } from "@z/core";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Services } from "../app.ts";

const HEARTBEAT_MS = 15_000;

export function eventRoutes({ rt }: Services) {
  const app = new Hono();

  app.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      const pending: LiveEvent[] = [];
      let wake: (() => void) | null = null;
      const unsubscribe = rt.bus.subscribe((event) => {
        pending.push(event);
        wake?.();
      });
      stream.onAbort(() => {
        unsubscribe();
        wake?.();
      });

      await stream.writeSSE({ event: "ready", data: "{}" });
      while (!stream.aborted) {
        while (pending.length) await stream.writeSSE({ data: JSON.stringify(pending.shift()) });
        const timer = new Promise<boolean>((resolve) => {
          const t = setTimeout(() => resolve(true), HEARTBEAT_MS);
          wake = () => {
            clearTimeout(t);
            resolve(false);
          };
        });
        const idle = await timer;
        wake = null;
        if (idle && !stream.aborted) await stream.writeSSE({ event: "ping", data: "" });
      }
      unsubscribe();
    }),
  );

  return app;
}
