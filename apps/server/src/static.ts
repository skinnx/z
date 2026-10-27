/** Serve the built web app (apps/web/dist) with an SPA fallback, when it exists. */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Hono } from "hono";

const WEB_DIST = fileURLToPath(new URL("../../web/dist", import.meta.url));

export function mountWeb(app: Hono): boolean {
  const index = `${WEB_DIST}/index.html`;
  if (!existsSync(index)) return false;
  app.use("*", serveStatic({ root: WEB_DIST }));
  app.get("*", (c) => {
    if (c.req.path.startsWith("/api/") || c.req.path.startsWith("/hooks/")) return c.notFound();
    return c.html(readFileSync(index, "utf8"));
  });
  return true;
}
