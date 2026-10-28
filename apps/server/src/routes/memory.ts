/** Long-term memory the owner can see, review and edit. */
import { randomUUID } from "node:crypto";
import { MemoryInput, MemoryStatus } from "@z/core";
import { Hono } from "hono";
import { z } from "zod";
import type { Services } from "../app.ts";
import { body, notFound } from "../http.ts";

const PinInput = z.object({ pinned: z.boolean() });

export function memoryRoutes({ rt }: Services) {
  const { store } = rt;
  const app = new Hono();

  app.get("/memories", (c) => {
    const status = MemoryStatus.optional().catch(undefined).parse(c.req.query("status"));
    const q = c.req.query("q")?.trim();
    return c.json(q ? store.memories.search(q, { status }) : store.memories.list({ status }));
  });

  app.post("/memories", async (c) => {
    const { text, pinned } = await body(c, MemoryInput);
    return c.json(store.memories.add(randomUUID(), text.trim(), "user", "active", pinned), 201);
  });

  app.put("/memories/:id", async (c) => {
    const { text, pinned } = await body(c, MemoryInput);
    const id = c.req.param("id");
    if (!store.memories.get(id)) throw notFound("Memory");
    return c.json(store.memories.update(id, text.trim(), pinned));
  });

  app.post("/memories/:id/confirm", (c) => {
    const memory = store.memories.confirm(c.req.param("id"));
    if (!memory) throw notFound("Memory");
    return c.json(memory);
  });

  app.post("/memories/:id/pin", async (c) => {
    const { pinned } = await body(c, PinInput);
    const memory = store.memories.pin(c.req.param("id"), pinned);
    if (!memory) throw notFound("Memory");
    return c.json(memory);
  });

  app.delete("/memories", (c) => c.json({ deleted: store.memories.clear() }));

  app.delete("/memories/:id", (c) => {
    if (!store.memories.delete(c.req.param("id"))) throw notFound("Memory");
    return c.json({ ok: true });
  });

  return app;
}
