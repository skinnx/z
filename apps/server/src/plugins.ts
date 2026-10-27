import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ActivePlugin, ChannelAdapter, PluginManifest, ZPlugin } from "@z/core";
import { builtinPlugins } from "@z/plugins";
import type { Store } from "./store.ts";

/**
 * Built-in plugins, server-provided ones (`own`, e.g. memory) and those named in Z_PLUGINS
 * (module specifiers or paths default-exporting a ZPlugin).
 */
export async function loadPlugins(specifiers: string[], own: ZPlugin[] = []): Promise<ZPlugin[]> {
  const plugins = [...builtinPlugins, ...own];
  for (const spec of specifiers) {
    const target = /^[./]/.test(spec) ? pathToFileURL(resolve(spec)).href : spec;
    try {
      const mod = await import(target);
      const plugin = (mod.default ?? mod) as ZPlugin;
      if (!plugin || typeof plugin.id !== "string" || typeof plugin.name !== "string") {
        throw new Error("module does not default-export a plugin");
      }
      if (plugins.some((p) => p.id === plugin.id)) throw new Error(`duplicate plugin id "${plugin.id}"`);
      plugins.push(plugin);
      console.log(`[z] loaded plugin ${plugin.id} from ${spec}`);
    } catch (error) {
      console.error(`[z] failed to load plugin ${spec}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return plugins;
}

export type PluginRegistry = ReturnType<typeof createPluginRegistry>;

export function createPluginRegistry(plugins: ZPlugin[], store: Store) {
  const requiredMissing = (plugin: ZPlugin, settings: Record<string, string>) =>
    (plugin.settings ?? []).some((f) => f.required && !settings[f.key]);

  const state = (plugin: ZPlugin) =>
    store.plugins.get(plugin.id) ?? {
      enabled: plugin.enabledByDefault ?? !requiredMissing(plugin, {}),
      settings: {},
    };

  const find = (id: string) => plugins.find((p) => p.id === id) ?? null;
  const enabled = () => plugins.filter((p) => state(p).enabled);

  return {
    find,
    /** Enabled plugins whose required settings are filled in; these provide tools and briefings. */
    active: (): ActivePlugin[] =>
      enabled()
        .map((plugin) => ({ plugin, settings: state(plugin).settings }))
        .filter(({ plugin, settings }) => !requiredMissing(plugin, settings)),
    adapters: (): ChannelAdapter[] => enabled().flatMap((p) => p.adapters ?? []),
    manifests: () => plugins.map(manifest),
    manifest: (plugin: ZPlugin) => manifest(plugin),
    /** Settings merge: provided keys replace stored ones, empty strings clear them. */
    update: (plugin: ZPlugin, enabledFlag: boolean, settings?: Record<string, string>) => {
      const merged = { ...state(plugin).settings };
      for (const [key, value] of Object.entries(settings ?? {})) {
        if (value) merged[key] = value;
        else delete merged[key];
      }
      store.plugins.set(plugin.id, enabledFlag, merged);
      return manifest(plugin);
    },
  };

  function manifest(plugin: ZPlugin): PluginManifest {
    return {
      id: plugin.id,
      name: plugin.name,
      description: plugin.description,
      tools: Object.entries(plugin.tools ?? {}).map(([name, t]) => ({
        name,
        description: t.description,
        risk: t.risk,
        ...(t.defaultPolicy && t.risk !== "external" ? { defaultPolicy: t.defaultPolicy } : {}),
      })),
      settings: (plugin.settings ?? []).map((f) => ({ key: f.key, label: f.label, secret: f.secret ?? false, required: f.required ?? false })),
      briefing: Boolean(plugin.briefing),
      enabled: state(plugin).enabled,
    };
  }
}
