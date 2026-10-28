import { timingSafeEqual } from "node:crypto";
import { serve } from "@hono/node-server";
import { say } from "@z/core";
import { Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import pkg from "../package.json" with { type: "json" };
import type { Services } from "./app.ts";
import { createBriefings } from "./briefings.ts";
import { createBus } from "./bus.ts";
import { createChannels } from "./channels.ts";
import { createConnectors } from "./connectors.ts";
import { createSealer } from "./crypto.ts";
import { openDatabase } from "./db.ts";
import { loadEnv } from "./env.ts";
import { startDelivery } from "./notify.ts";
import { createPairing } from "./owner.ts";
import { createPluginRegistry, loadPlugins } from "./plugins.ts";
import { memoryPlugin } from "./plugins/memory.ts";
import { tasksPlugin } from "./plugins/tasks.ts";
import { createPush } from "./push.ts";
import { channelRoutes } from "./routes/channels.ts";
import { chatRoutes } from "./routes/chat.ts";
import { configRoutes } from "./routes/config.ts";
import { connectorRoutes } from "./routes/connectors.ts";
import { eventRoutes } from "./routes/events.ts";
import { dataRoutes } from "./routes/data.ts";
import { loginRoutes } from "./routes/logins.ts";
import { memoryRoutes } from "./routes/memory.ts";
import { reachRoutes } from "./routes/reach.ts";
import { skillRoutes } from "./routes/skills.ts";
import { workRoutes } from "./routes/work.ts";
import { createRuntime } from "./runtime.ts";
import { setupRoutes } from "./routes/setup.ts";
import { installRedaction } from "./secrets.ts";
import { createSetup } from "./setup.ts";
import { mountWeb } from "./static.ts";
import { errorBody } from "./http.ts";
import { createStore } from "./store.ts";
import { ConflictError } from "./tasks.ts";
import { createTasks } from "./tasks.ts";

// First: everything written to stdout/stderr from here on has registered secrets redacted.
installRedaction();
const env = loadEnv();
const store = createStore(openDatabase(env.dataDir), createSealer(env.masterKey));
store.openAllSecrets();
const plugins = createPluginRegistry(await loadPlugins(env.plugins, [memoryPlugin(store), tasksPlugin(() => tasks)]), store);
const bus = createBus();
const connectors = createConnectors(env, store, bus);
const rt = createRuntime(env, store, plugins, bus, connectors);
const tasks = createTasks(rt);
const pairing = createPairing();
const push = createPush(rt);
const channels = createChannels(rt, tasks, pairing);
startDelivery(rt, push, channels);
const setup = createSetup(rt, channels, connectors, push);
const services: Services = { rt, tasks, briefings: createBriefings(rt), channels, push, pairing, connectors, setup };

const app = new Hono();

app.onError((error, c) => {
  if (error instanceof HTTPException) return error.getResponse();
  if (error instanceof ConflictError) return c.json(errorBody(error.msg), 409);
  console.error(`[z] ${c.req.method} ${c.req.path} failed:`, error);
  return c.json(errorBody(say("errInternal")), 500);
});

const api = new Hono();
api.use("*", auth(env.token));
api.get("/health", (c) => c.json({ ok: true, version: pkg.version }));
for (const routes of [configRoutes, workRoutes, chatRoutes, channelRoutes, reachRoutes, eventRoutes, memoryRoutes, connectorRoutes, dataRoutes, loginRoutes, setupRoutes, skillRoutes]) {
  api.route("/", routes(services));
}
api.all("*", (c) => c.json(errorBody(say("errRouteNotFound")), 404));

app.route("/api", api);
app.all("/hooks/:channelId", (c) => services.channels.hook(c.req.param("channelId"), c.req.raw));
// The OAuth provider redirects the browser here: no bearer token, the single-use state is the check.
app.get("/oauth/callback", async (c) =>
  c.redirect(
    await connectors.finishOAuth({
      code: c.req.query("code"),
      state: c.req.query("state"),
      error: c.req.query("error"),
      errorDescription: c.req.query("error_description"),
      iss: c.req.query("iss"),
    }),
  ),
);
const servingWeb = mountWeb(app);

services.tasks.start();
services.briefings.schedule();
void services.channels.syncAll();
void connectors.syncAll();

const server = serve({ fetch: app.fetch, port: env.port, hostname: env.host }, (info) => {
  console.log(`[z] listening on http://${env.host.includes(":") ? `[${env.host}]` : env.host}:${info.port}${servingWeb ? " (serving web app)" : ""}`);
  console.log(`[z] data dir ${env.dataDir}; ${plugins.manifests().length} plugin(s); auth ${env.token ? "on" : "off"}`);
  if (env.allowPrivateMcp) console.log("[z] Z_ALLOW_PRIVATE_MCP=1: connectors may reach private networks and plain http");
  if (process.env.Z_ALLOW_PRIVATE_BROWSER === "1") console.log("[z] Z_ALLOW_PRIVATE_BROWSER=1: the browser may open localhost and private networks");
});

async function shutdown() {
  services.tasks.stopAll();
  services.briefings.stop();
  await services.channels.stopAll();
  await connectors.stopAll();
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
    if (buf.length !== expected.length || !timingSafeEqual(buf, expected)) return c.json(errorBody(say("errUnauthorized")), 401);
    return next();
  };
}
