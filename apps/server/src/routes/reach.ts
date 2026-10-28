/** Reaching the owner while away: notices, Web Push devices and owner-channel pairing. */
import { PushSubscriptionInput } from "@z/core";
import { Hono } from "hono";
import { z } from "zod";
import type { Services } from "../app.ts";
import { badRequest, body } from "../http.ts";

const ReadInput = z.object({ ids: z.array(z.string()).max(500).optional() });
const EndpointInput = z.object({ endpoint: z.string().min(1) });

export function reachRoutes({ rt, push, pairing }: Services) {
  const { store } = rt;
  const app = new Hono();

  app.get("/notices", (c) => c.json(store.notices.list()));

  app.post("/notices/read", async (c) => {
    const { ids } = await body(c, ReadInput);
    store.notices.markRead(ids);
    return c.json({ ok: true });
  });

  app.get("/push", (c) =>
    c.json({
      publicKey: push.publicKey(),
      devices: store.push.list().map(({ endpoint, device, createdAt }) => ({ endpoint, device, createdAt })),
    }),
  );

  app.post("/push", async (c) => {
    const input = await body(c, PushSubscriptionInput);
    // Push services are always https; anything else would make the server a request relay.
    if (!input.endpoint.startsWith("https://")) throw badRequest("endpoint: must be https");
    store.push.upsert(input.endpoint, input.keys, input.device);
    return c.json({ ok: true });
  });

  app.delete("/push", async (c) => {
    store.push.delete((await body(c, EndpointInput)).endpoint);
    return c.json({ ok: true });
  });

  app.post("/push/test", async (c) =>
    c.json({
      sent: await push.send({ id: crypto.randomUUID(), kind: "test", title: "z", body: "Notifications work on this device.", path: "/?settings=notifications" }),
    }),
  );

  app.post("/owner/link", (c) => c.json(pairing.issue()));

  app.delete("/owner", (c) => {
    const next = { ...store.settings.get(), owner: null };
    store.settings.set(next);
    return c.json(next);
  });

  return app;
}
