/** The owner's inbox of notices. */
import { Hono } from "hono";
import { z } from "zod";
import type { Services } from "../app.ts";
import { body } from "../http.ts";

const ReadBody = z.object({ ids: z.array(z.string()).max(500).optional() });

export function noticeRoutes({ rt }: Services) {
  const app = new Hono();

  app.get("/notices", (c) => c.json(rt.store.notices.list(100)));

  app.post("/notices/read", async (c) => {
    const { ids } = await body(c, ReadBody);
    rt.notices.markRead(ids);
    return c.json({ ok: true });
  });

  return app;
}
