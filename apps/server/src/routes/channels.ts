/**
 * Bot channels. Config values are write-only: omitted keys keep their value, empty strings clear them.
 * Omitted `limits` keep the stored ones.
 */
import { ChannelInput, ChannelTestInput } from "@z/core";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Services } from "../app.ts";
import { badRequest, body, notFound, validate } from "../http.ts";

export function channelRoutes({ rt, channels }: Services) {
  const { store } = rt;
  const app = new Hono();

  app.get("/channels", (c) => c.json(store.channels.list().map(channels.view)));

  app.put("/channels/:id", async (c) => {
    const id = c.req.param("id");
    const raw = await body(c, z.record(z.string(), z.unknown()));
    if (raw.id !== undefined && raw.id !== id) throw badRequest("id: must match the URL");
    const input = validate(ChannelInput, { ...raw, id });

    const existing = store.channels.get(id);
    const config = existing && existing.kind === input.kind ? { ...existing.config } : {};
    for (const [key, value] of Object.entries(input.config)) {
      if (value) config[key] = value;
      else delete config[key];
    }
    const limits = raw.limits === undefined && existing ? existing.limits : input.limits;
    store.channels.upsert({ ...input, config, limits });
    await channels.sync(id);
    return c.json(channels.view(store.channels.get(id)!));
  });

  // Owner-only like every /api route: previews of what people asked the bot.
  app.get("/channels/:id/activity", (c) => {
    const activity = channels.activity(c.req.param("id"));
    if (!activity) throw notFound("Channel");
    return c.json(activity);
  });

  app.get("/channels/:id/setup", async (c) => {
    const steps = await channels.setup(c.req.param("id"));
    if (!steps) throw notFound("Channel");
    return c.json(steps);
  });

  app.post("/channels/:id/test", async (c) => {
    const { text } = await body(c, ChannelTestInput);
    let result;
    try {
      result = await channels.test(c.req.param("id"), text);
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      throw badRequest(error instanceof Error ? error.message : String(error));
    }
    if (!result) throw notFound("Channel");
    return c.json(result);
  });

  app.delete("/channels/:id", async (c) => {
    if (!(await channels.remove(c.req.param("id")))) throw notFound("Channel");
    return c.json({ ok: true });
  });

  return app;
}
