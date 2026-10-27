/** Settings, providers, routing, plugins and adapters. */
import { listModels, describeError, ProviderInput, Routing, Settings, testProvider, type AdapterManifest, type ProviderConfig, type ProviderView } from "@z/core";
import { Hono } from "hono";
import { z } from "zod";
import type { Services } from "../app.ts";
import { badRequest, body, notFound, validate } from "../http.ts";
import { isValidCron, isValidTimezone } from "../schedule.ts";

const PluginUpdate = z.object({
  enabled: z.boolean(),
  settings: z.record(z.string(), z.string()).optional(),
});

export function configRoutes({ rt, tasks, briefings, channels }: Services) {
  const { store } = rt;
  const app = new Hono();

  const providerView = (p: ProviderConfig): ProviderView => {
    const { apiKey, ...rest } = p;
    return { ...rest, hasKey: Boolean(apiKey), keyHint: store.providers.keyHint(p.id), usage: store.usage.month(p.id) };
  };

  const provider = (id: string) => {
    const p = store.providers.get(id);
    if (!p) throw notFound("Provider");
    return p;
  };

  app.get("/settings", (c) => c.json(store.settings.get()));

  app.put("/settings", async (c) => {
    const current = store.settings.get();
    const patch = await body(c, z.record(z.string(), z.unknown()));
    const next = validate(Settings, { ...current, ...patch });
    if (!isValidTimezone(next.timezone)) throw badRequest(`timezone: unknown time zone "${next.timezone}"`);
    if (!isValidCron(next.briefingCron, next.timezone)) throw badRequest(`briefingCron: invalid cron expression`);
    store.settings.set(next);
    if (next.briefingCron !== current.briefingCron || next.timezone !== current.timezone) briefings.schedule();
    if (next.timezone !== current.timezone) tasks.rescheduleAll();
    if (next.handle !== current.handle) void channels.syncAll();
    return c.json(next);
  });

  app.get("/providers", (c) => c.json(store.providers.list().map(providerView)));

  app.put("/providers/:id", async (c) => {
    const id = c.req.param("id");
    const raw = await body(c, z.record(z.string(), z.unknown()));
    if (raw.id !== undefined && raw.id !== id) throw badRequest("id: must match the URL");
    const { apiKey, ...input } = validate(ProviderInput, { ...raw, id });
    if (input.kind === "openai-compatible" && !input.baseURL) throw badRequest("baseURL: required for openai-compatible providers");
    store.providers.upsert(input, apiKey);
    return c.json(providerView(provider(id)));
  });

  app.delete("/providers/:id", (c) => {
    if (!store.providers.delete(c.req.param("id"))) throw notFound("Provider");
    return c.json({ ok: true });
  });

  app.post("/providers/:id/test", async (c) => c.json(await testProvider(provider(c.req.param("id")))));

  app.get("/providers/:id/models", async (c) => {
    const p = provider(c.req.param("id"));
    try {
      return c.json({ models: await listModels(p) });
    } catch (error) {
      return c.json({ error: `Could not list models: ${describeError(error)}` }, 502);
    }
  });

  app.get("/routing", (c) => c.json(store.routing.get()));

  app.put("/routing", async (c) => {
    const patch = await body(c, z.record(z.string(), z.unknown()));
    const next = validate(Routing, { ...store.routing.get(), ...patch });
    store.routing.set(next);
    return c.json(store.routing.get());
  });

  app.get("/plugins", (c) => c.json(rt.plugins.manifests()));

  app.put("/plugins/:id", async (c) => {
    const plugin = rt.plugins.find(c.req.param("id"));
    if (!plugin) throw notFound("Plugin");
    const input = await body(c, PluginUpdate);
    const manifest = rt.plugins.update(plugin, input.enabled, input.settings);
    void channels.syncAll(); // the set of available adapters may have changed
    return c.json(manifest);
  });

  app.get("/adapters", (c) =>
    c.json(
      rt.plugins.adapters().map(
        (a): AdapterManifest => ({
          kind: a.kind,
          label: a.label,
          config: a.config.map((f) => ({ key: f.key, label: f.label, secret: f.secret ?? false, required: f.required ?? false })),
          mode: a.webhook && !a.start ? "webhook" : "connect",
        }),
      ),
    ),
  );

  return app;
}
