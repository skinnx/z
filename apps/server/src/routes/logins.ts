/** Saved sign-ins the browser fills by itself. Views carry the origin and username only. */
import { randomUUID } from "node:crypto";
import { LoginInput, LoginUpdate } from "@z/core";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Services } from "../app.ts";
import { body, notFound } from "../http.ts";

const taken = (origin: string) =>
  new HTTPException(409, { res: Response.json({ error: `A sign-in for ${origin} is already saved` }, { status: 409 }) });

export function loginRoutes({ rt }: Services) {
  const { store } = rt;
  const app = new Hono();

  app.get("/logins", (c) => c.json(store.logins.list()));

  app.post("/logins", async (c) => {
    const { origin, username, password, totpSecret } = await body(c, LoginInput);
    if (store.logins.byOrigin(origin)) throw taken(origin);
    return c.json(store.logins.save(randomUUID(), { origin, username, password, totp: totpSecret }), 201);
  });

  app.put("/logins/:id", async (c) => {
    const { origin, username, password, totpSecret } = await body(c, LoginUpdate);
    const id = c.req.param("id");
    if (!store.logins.get(id)) throw notFound("Sign-in");
    const other = store.logins.byOrigin(origin);
    if (other && other.id !== id) throw taken(origin);
    return c.json(store.logins.save(id, { origin, username, password, totp: totpSecret }));
  });

  app.delete("/logins/:id", (c) => {
    if (!store.logins.delete(c.req.param("id"))) throw notFound("Sign-in");
    return c.json({ ok: true });
  });

  return app;
}
