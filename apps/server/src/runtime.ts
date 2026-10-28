/** Wires storage and plugins into the core runtime's dependency shape. */
import { createModelResolver } from "@z/core";
import type { Bus } from "./bus.ts";
import type { Connectors } from "./connectors.ts";
import type { Env } from "./env.ts";
import type { PluginRegistry } from "./plugins.ts";
import type { Store } from "./store.ts";

export type Runtime = ReturnType<typeof createRuntime>;

export function createRuntime(env: Env, store: Store, plugins: PluginRegistry, bus: Bus, connectors: Connectors) {
  const models = createModelResolver({
    providers: () => store.providers.list(),
    onUsage: (u) => store.usage.add(u.providerId, u.inputTokens + u.outputTokens, u.costUsd),
    monthUsd: (providerId) => store.usage.month(providerId).monthUsd,
  });

  /**
   * Fresh core deps for one run: settings, routing, plugins and connected MCP connectors are read at call time.
   * No memories: this is what channel bots (strangers) get.
   */
  const deps = (scope: string) => ({
    models,
    routing: store.routing.get(),
    settings: store.settings.get(),
    plugins: [...plugins.active(), ...connectors.active()],
    log: (text: string) => console.log(`[z:${scope}] ${text}`),
  });

  /** Deps for runs only the owner reaches (chat, tasks, watches, briefing): adds long-term memory. */
  const ownerDeps = (scope: string) => ({ ...deps(scope), memories: store.memories.list() });

  return { env, store, plugins, bus, models, deps, ownerDeps };
}
