/**
 * Serve the built web app (apps/web/dist) with an SPA fallback, when it exists.
 *
 * The build writes `.br` and `.gz` next to every text asset (apps/web/vite.config.ts), served by the
 * browser's Accept-Encoding. Hashed files under /assets never change, so browsers keep them for a
 * year; the page and the service worker are revalidated on every load so a deploy shows up at once.
 */
import { existsSync, readFileSync } from "node:fs";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Context, Hono } from "hono";

const WEB_DIST = fileURLToPath(new URL("../../web/dist", import.meta.url));

export const IMMUTABLE = "public, max-age=31536000, immutable";
export const REVALIDATE = "no-cache";

/** Cache policy by path: content-hashed assets forever, everything else revalidated. */
export function cacheControl(path: string): string {
  return path.startsWith("/assets/") ? IMMUTABLE : REVALIDATE;
}

/** The SPA page, compressed once in memory (it has no precompressed twin when served as the fallback). */
function pageResponder(html: string) {
  const bodies = { br: brotliCompressSync(html), gzip: gzipSync(html), identity: Buffer.from(html) };
  return (c: Context) => {
    const accepted = c.req.header("Accept-Encoding") ?? "";
    const encoding = /\bbr\b/.test(accepted) ? "br" : /\bgzip\b/.test(accepted) ? "gzip" : "identity";
    const headers: Record<string, string> = { "Content-Type": "text/html; charset=UTF-8", "Cache-Control": REVALIDATE, Vary: "Accept-Encoding" };
    if (encoding !== "identity") headers["Content-Encoding"] = encoding;
    return c.body(bodies[encoding], 200, headers);
  };
}

export function mountWeb(app: Hono, root = WEB_DIST): boolean {
  const index = `${root}/index.html`;
  if (!existsSync(index)) return false;
  const page = pageResponder(readFileSync(index, "utf8"));
  app.get("/", page);
  app.get("/index.html", page);
  app.use("*", async (c, next) => {
    await next();
    if (c.res.ok && !c.res.headers.has("Cache-Control")) c.res.headers.set("Cache-Control", cacheControl(c.req.path));
  });
  app.use("*", serveStatic({ root, precompressed: true }));
  app.get("*", (c) => {
    if (c.req.path.startsWith("/api/") || c.req.path.startsWith("/hooks/")) return c.notFound();
    // A missing hashed file is a stale tab after a deploy: say so rather than send the page as script.
    if (c.req.path.startsWith("/assets/")) return c.notFound();
    return page(c);
  });
  return true;
}
