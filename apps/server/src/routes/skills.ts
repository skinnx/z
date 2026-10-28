/** Skills: reusable instructions the owner invokes with `/name` in chat or the Today composer. */
import { randomUUID } from "node:crypto";
import { say, SkillInput } from "@z/core";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Services } from "../app.ts";
import { body, errorResponse, notFound } from "../http.ts";

const taken = (name: string) =>
  new HTTPException(409, { res: errorResponse(say("errSkillExists", { name }), 409) });

export function skillRoutes({ rt }: Services) {
  const { store } = rt;
  const app = new Hono();

  app.get("/skills", (c) => c.json(store.skills.list()));

  app.post("/skills", async (c) => {
    const input = await body(c, SkillInput);
    if (store.skills.byName(input.name)) throw taken(input.name);
    return c.json(store.skills.save(randomUUID(), { ...input, tools: [...new Set(input.tools)] }), 201);
  });

  app.put("/skills/:id", async (c) => {
    const id = c.req.param("id");
    const input = await body(c, SkillInput);
    if (!store.skills.get(id)) throw notFound("Skill");
    const other = store.skills.byName(input.name);
    if (other && other.id !== id) throw taken(input.name);
    return c.json(store.skills.save(id, { ...input, tools: [...new Set(input.tools)] }));
  });

  app.delete("/skills/:id", (c) => {
    if (!store.skills.delete(c.req.param("id"))) throw notFound("Skill");
    return c.json({ ok: true });
  });

  return app;
}
