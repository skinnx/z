/** Settings, providers, routing, plugins and adapters. */
import {
  describeError,
  fillEmptyLanes,
  listModels,
  pickDefaultModels,
  ProviderInput,
  Routing,
  Settings,
  say,
  testProvider,
  type AdapterManifest,
  type Lane,
  type ProviderConfig,
  type ProviderSaveResult,
  type ProviderTestResult,
  type ProviderView,
} from "@z/core";
import { Hono } from "hono";
import { z } from "zod";
import type { Services } from "../app.ts";
import { badRequest, body, errorBody, notFound, validate } from "../http.ts";
import { redactJson } from "../secrets.ts";
import { isValidCron, isValidTimezone } from "../schedule.ts";

/** The check on save is a key check, not a benchmark: a slow free tier is "not checked", not broken. */
const SAVE_CHECK_TIMEOUT_MS = 12_000;

const PluginUpdate = z.object({
  enabled: z.boolean(),
  settings: z.record(z.string(), z.string()).optional(),
});

/** A provider as clients see it: the key itself never leaves the server. */
export function toProviderView(store: Services["rt"]["store"], p: ProviderConfig): ProviderView {
  const { apiKey, ...rest } = p;
  return { ...rest, hasKey: Boolean(apiKey), keyHint: store.providers.keyHint(p.id), usage: store.usage.month(p.id) };
}

export function configRoutes({ rt, tasks, briefings, channels, setup }: Services) {
  const { store } = rt;
  const app = new Hono();

  const providerView = (p: ProviderConfig) => toProviderView(store, p);

  const provider = (id: string) => {
    const p = store.providers.get(id);
    if (!p) throw notFound("Provider");
    return p;
  };

  app.get("/settings", (c) => c.json(store.settings.get()));

  app.put("/settings", async (c) => {
    const current = store.settings.get();
    // The owner is set by pairing only (POST /api/owner/link, DELETE /api/owner).
    const { owner: _readOnly, ...patch } = await body(c, z.record(z.string(), z.unknown()));
    // Naming a timezone is choosing one: the web app stops filling in the browser's.
    const next = validate(Settings, { ...current, ...patch, ...("timezone" in patch ? { timezoneSet: true } : {}) });
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
    const parsed = validate(ProviderInput, { ...raw, id });
    if (parsed.kind === "openai-compatible" && !parsed.baseURL) throw badRequest("baseURL: required for openai-compatible providers");
    if (parsed.command && parsed.kind !== "codex-cli") throw badRequest("command: only for codex-cli providers");
    // The Codex CLI owns sign-in: no key, endpoint or headers are stored for it.
    const { apiKey, ...input } = parsed.kind === "codex-cli" ? { ...parsed, apiKey: "", baseURL: undefined, headers: undefined } : parsed;
    const before = store.providers.get(id);
    store.providers.upsert(input, apiKey);
    // A new key, endpoint or headers make earlier live tests meaningless.
    const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    if (!before || apiKey !== undefined || before.kind !== input.kind || !same(before.baseURL, input.baseURL) || !same(before.headers, input.headers) || !same(before.command, input.command)) setup.forget(id);
    if (c.req.query("check") === undefined || !input.enabled) return c.json(providerView(provider(id)));

    // ─── Check on save: models, a live answer, then the empty lanes ───
    if (!input.models.length && input.kind !== "codex-cli") {
      let listed: string[] = [];
      try {
        listed = await listModels(provider(id));
      } catch {} // the test below says why
      const picks = pickDefaultModels(listed, false);
      if (picks) store.providers.upsert({ ...input, models: [...new Set([picks.main, picks.fast])] }, undefined);
    }
    const saved = provider(id);
    const check: ProviderTestResult = await testProvider(saved, fetch, SAVE_CHECK_TIMEOUT_MS);
    setup.record(id, check);
    let filledLanes: Lane[] = [];
    // A rejected key or unknown model fills nothing; a rate limit or a slow answer says nothing against it.
    if (check.ok || check.rateLimited || check.timedOut) {
      // The owner's order wins; the model that answered stands in when none is listed (Codex's default).
      const picks = pickDefaultModels(saved.models.length ? saved.models : check.model ? [check.model] : [], true);
      if (picks) {
        const filled = fillEmptyLanes(store.routing.get(), id, picks);
        if (filled.filled.length) store.routing.set(filled.routing);
        filledLanes = filled.filled;
      }
    }
    // Some providers quote the key back in their error message.
    const result: ProviderSaveResult = { ...providerView(provider(id)), check: redactJson(check), filledLanes };
    return c.json(result);
  });

  app.delete("/providers/:id", (c) => {
    if (!store.providers.delete(c.req.param("id"))) throw notFound("Provider");
    setup.forget(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/providers/:id/test", async (c) => {
    const id = c.req.param("id");
    const result = await testProvider(provider(id));
    setup.record(id, result);
    // Some providers quote the key back in their error message.
    return c.json(redactJson(result));
  });

  app.get("/providers/:id/models", async (c) => {
    const p = provider(c.req.param("id"));
    try {
      return c.json({ models: await listModels(p) });
    } catch (error) {
      return c.json(errorBody(say("errListModels", { error: describeError(error) })), 502);
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
          config: a.config.map((f) => ({
            key: f.key,
            label: f.label,
            secret: f.secret ?? false,
            required: f.required ?? false,
            ...(f.toggle ? { toggle: true } : {}),
            ...(f.generate ? { generate: true } : {}),
            ...(f.legacy ? { legacy: true } : {}),

          })),
          mode: a.webhook && !a.start ? "webhook" : "connect",
        }),
      ),
    ),
  );

  return app;
}
