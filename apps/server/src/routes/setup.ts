/** The setup checklist and the diagnostics export. Neither carries a secret or a URL beyond its origin. */
import { arch, platform, release } from "node:os";
import type { Diagnostics } from "@z/core";
import { Hono } from "hono";
import pkg from "../../package.json" with { type: "json" };
import type { Services } from "../app.ts";
import { badRequest } from "../http.ts";
import { recentLogs, redactJson } from "../secrets.ts";
import { origin } from "../setup.ts";

export function setupRoutes({ rt, setup, connectors }: Services) {
  const { store, env } = rt;
  const app = new Hono();

  app.get("/setup", (c) => c.json(setup.checklist()));

  app.post("/setup/check", async (c) => c.json(await setup.check()));

  app.post("/setup/:id/ack", (c) => {
    if (!setup.ack(c.req.param("id"))) throw badRequest("This item can't be confirmed by hand");
    return c.json(setup.checklist());
  });

  app.get("/diagnostics", (c) => {
    const generatedAt = new Date().toISOString();
    const data: Diagnostics = {
      generatedAt,
      version: pkg.version,
      runtime: {
        node: process.versions.node,
        sqlite: process.versions.sqlite ?? "unknown",
        os: `${platform()} ${release()}`,
        arch: arch(),
        uptimeSeconds: Math.round(process.uptime()),
      },
      schemaVersion: store.schemaVersion(),
      server: {
        authToken: Boolean(env.token),
        publicOrigin: env.publicUrl ? origin(env.publicUrl) : null,
        bind: `${env.host ?? "all interfaces"}:${env.port}`,
        plugins: rt.plugins.manifests().length,
      },
      setup: setup.checklist(),
      providers: store.providers.list().map((p) => ({
        id: p.id,
        kind: p.kind,
        enabled: p.enabled,
        origin: p.baseURL ? origin(p.baseURL) : null,
        hasKey: Boolean(p.apiKey),
        models: p.models.length,
      })),
      modelChecks: setup.modelChecks(),
      routing: store.routing.get(),
      channels: store.channels.list().map((ch) => ({
        id: ch.id,
        kind: ch.kind,
        enabled: ch.enabled,
        status: ch.status,
        statusDetail: ch.statusDetail,
        lastEventAt: ch.lastEventAt,
      })),
      connectors: connectors.list().map((cn) => ({
        id: cn.id,
        origin: cn.urlDisplay.replace(/\/…$/, ""),
        auth: cn.auth,
        enabled: cn.enabled,
        status: cn.status,
        statusDetail: cn.statusDetail,
        tools: cn.tools.length,
      })),
      tasks: store.taskCounts(),
      logs: recentLogs(),
    };
    c.header("content-disposition", `attachment; filename="z-diagnostics-${generatedAt.slice(0, 10)}.json"`);
    // Last line of defence: status details and log lines may quote what a service echoed back.
    return c.json(redactJson(data));
  });

  return app;
}
