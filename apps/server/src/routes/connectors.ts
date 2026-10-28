/** MCP connectors. URL and header values are write-only: views carry `urlDisplay` and `headerKeys` only. */
import { ConnectorInput, describeError, OAuthCompleteInput, PRESETS, say } from "@z/core";
import { Hono } from "hono";
import { z } from "zod";
import type { Services } from "../app.ts";
import { ConnectorError } from "../connectors.ts";
import { badRequest, body, notFound, validate } from "../http.ts";

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

export function connectorRoutes({ rt, connectors }: Services) {
  const { store } = rt;
  const app = new Hono();

  const record = (id: string) => {
    const r = connectors.get(id);
    if (!r) throw notFound("Connector");
    return r;
  };

  const fixable = (error: unknown) => (error instanceof ConnectorError ? badRequest(error.message) : error);

  app.get("/connector-presets", (c) => c.json(PRESETS));

  app.get("/connectors", (c) => c.json(connectors.list()));

  app.put("/connectors/:id", async (c) => {
    const id = c.req.param("id");
    const raw = await body(c, z.record(z.string(), z.unknown()));
    if (raw.id !== undefined && raw.id !== id) throw badRequest("id: must match the URL");
    const { url: newUrl, headers: headerPatch, ...input } = validate(ConnectorInput, { ...raw, id });

    const existing = connectors.get(id);
    const url = newUrl ?? existing?.url;
    if (!url) throw badRequest("url: required when creating a connector");
    if (newUrl) await connectors.assertTarget(newUrl).catch((error) => Promise.reject(fixable(error)));

    // Omitted keeps, `{}` clears, otherwise per key: a value sets it, an empty string removes it.
    let headers = existing?.headers ?? {};
    if (headerPatch) {
      headers = Object.keys(headerPatch).length ? { ...headers } : {};
      for (const [name, value] of Object.entries(headerPatch)) {
        if (!HEADER_NAME.test(name)) throw badRequest(`headers: invalid header name "${name}"`);
        if (value) headers[name] = value;
        else delete headers[name];
      }
    }

    store.connectors.upsert({ ...input, url, headers });
    // Tokens and client registrations belong to one server: a new URL or auth mode drops them.
    if (existing && (url !== existing.url || input.auth !== existing.auth)) store.connectors.setOAuth(id, null);
    if (existing && url !== existing.url) store.connectors.setCache(id, null);
    await connectors.sync(id);
    return c.json(connectors.view(record(id)));
  });

  app.delete("/connectors/:id", async (c) => {
    if (!(await connectors.remove(c.req.param("id")))) throw notFound("Connector");
    return c.json({ ok: true });
  });

  app.post("/connectors/:id/refresh", async (c) => {
    const id = c.req.param("id");
    record(id);
    await connectors.sync(id);
    return c.json(connectors.view(record(id)));
  });

  app.post("/connectors/:id/oauth", async (c) => {
    const id = c.req.param("id");
    record(id);
    try {
      return c.json(await connectors.startOAuth(id, new URL(c.req.url).origin));
    } catch (error) {
      if (error instanceof ConnectorError) throw badRequest(error.message);
      return c.json({ error: describeError(error) }, 502);
    }
  });

  // The paste fallback for a callback that can't reach z; bearer-protected like the rest of /api.
  app.post("/connectors/:id/oauth/complete", async (c) => {
    const id = c.req.param("id");
    if (record(id).auth !== "oauth") throw badRequest(say("errNotOAuth"));
    const { url } = await body(c, OAuthCompleteInput);
    return c.json(await connectors.completeOAuth(id, url).catch((error) => Promise.reject(fixable(error))));
  });

  return app;
}
