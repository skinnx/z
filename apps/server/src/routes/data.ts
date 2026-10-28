/** Data controls: export everything z holds about you, minus secrets. */
import { Hono } from "hono";
import type { Services } from "../app.ts";
import { toProviderView } from "./config.ts";

export function dataRoutes({ rt, channels, connectors }: Services) {
  const { store } = rt;
  const app = new Hono();

  app.get("/export", (c) => {
    const exportedAt = new Date().toISOString();
    const data = {
      version: 1,
      exportedAt,
      settings: store.settings.get(),
      routing: store.routing.get(),
      providers: store.providers.list().map((p) => toProviderView(store, p)),
      channels: store.channels.list().map(channels.view),
      connectors: connectors.list(),
      tasks: store.tasks.list(),
      approvals: store.approvals.list(),
      briefings: store.briefings.all(),
      memories: store.memories.list(),
      threads: store.threads.all(),
      notices: store.notices.list(Number.MAX_SAFE_INTEGER),
    };
    c.header("content-disposition", `attachment; filename="z-export-${exportedAt.slice(0, 10)}.json"`);
    return c.json(data);
  });

  return app;
}
