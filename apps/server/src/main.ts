import { timingSafeEqual } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import pkg from "../package.json" with { type: "json" };
import type { Services } from "./app.ts";
import { createBriefings } from "./briefings.ts";
import { createBus } from "./bus.ts";
import { createChannels } from "./channels.ts";
import { createSealer } from "./crypto.ts";
import { openDatabase } from "./db.ts";
import { loadEnv } from "./env.ts";
import { startDelivery } from "./notify.ts";
import { createPairing } from "./owner.ts";
import { createPluginRegistry, loadPlugins } from "./plugins.ts";
import { createPush } from "./push.ts";
import { channelRoutes } from "./routes/channels.ts";
import { chatRoutes } from "./routes/chat.ts";
import { configRoutes } from "./routes/config.ts";
import { eventRoutes } from "./routes/events.ts";
import { reachRoutes } from "./routes/reach.ts";
import { workRoutes } from "./routes/work.ts";
import { createRuntime } from "./runtime.ts";
import { mountWeb } from "./static.ts";
import { createStore } from "./store.ts";
import { ConflictError } from "./tasks.ts";
import { createTasks } from "./tasks.ts";

const env = loadEnv();
const store = createStore(openDatabase(env.dataDir), createSealer(env.masterKey));
const plugins = createPluginRegistry(await loadPlugins(env.plugins), store);
const rt = createRuntime(env, store, plugins, createBus());
const tasks = createTasks(rt);
const pairing = createPairing();
const push = createPush(rt);
const channels = createChannels(rt, tasks, pairing);
startDelivery(rt, push, channels);
const services: Services = { rt, tasks, briefings: createBriefings(rt), channels, push, pairing };

const app = new Hono();

app.onError((error, c) => {
  if (error instanceof HTTPException) return error.getResponse();
  if (error instanceof ConflictError) return c.json({ error: error.message }, 409);
  console.error(`[z] ${c.req.method} ${c.req.path} failed:`, error);
  return c.json({ error: "Internal server error" }, 500);
});

const api = new Hono();
api.use("*", auth(env.token));
api.get("/health", (c) => c.json({ ok: true, version: pkg.version }));
for (const routes of [configRoutes, workRoutes, chatRoutes, channelRoutes, reachRoutes, eventRoutes]) api.route("/", routes(services));
api.all("*", (c) => c.json({ error: "Not found" }, 404));

app.route("/api", api);
app.all("/hooks/:channelId", (c) => services.channels.hook(c.req.param("channelId"), c.req.raw));
const servingWeb = mountWeb(app);

services.tasks.start();
services.briefings.schedule();
void services.channels.syncAll();

const server = serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`[z] listening on http://localhost:${info.port}${servingWeb ? " (serving web app)" : ""}`);
  console.log(`[z] data dir ${env.dataDir}; ${plugins.manifests().length} plugin(s); auth ${env.token ? "on" : "off"}`);
});

async function shutdown() {
  services.tasks.stopAll();
  services.briefings.stop();
  await services.channels.stopAll();
  server.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function auth(token: string | null): MiddlewareHandler {
  const expected = token ? Buffer.from(token) : null;
  return async (c, next) => {
    if (!expected) return next();
    const header = c.req.header("authorization");
    const given = header?.startsWith("Bearer ") ? header.slice(7) : c.req.query("token");
    const buf = Buffer.from(given ?? "");
    if (buf.length !== expected.length || !timingSafeEqual(buf, expected)) return c.json({ error: "Unauthorized" }, 401);
    return next();
  };
}
