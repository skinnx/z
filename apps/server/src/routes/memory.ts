/** Long-term memory the owner can see and edit. */
import { randomUUID } from "node:crypto";
import { MemoryInput } from "@z/core";
import { Hono } from "hono";
import type { Services } from "../app.ts";
import { body, notFound } from "../http.ts";

export function memoryRoutes({ rt }: Services) {
  const { store } = rt;
  const app = new Hono();

  app.get("/memories", (c) => c.json(store.memories.list()));

  app.post("/memories", async (c) => {
    const { text } = await body(c, MemoryInput);
    return c.json(store.memories.add(randomUUID(), text.trim(), "user"), 201);
  });

  app.put("/memories/:id", async (c) => {
    const { text } = await body(c, MemoryInput);
    const id = c.req.param("id");
    if (!store.memories.get(id)) throw notFound("Memory");
    return c.json(store.memories.update(id, text.trim()));
  });

  app.delete("/memories", (c) => c.json({ deleted: store.memories.clear() }));

  app.delete("/memories/:id", (c) => {
    if (!store.memories.delete(c.req.param("id"))) throw notFound("Memory");
    return c.json({ ok: true });
  });

  return app;
}
