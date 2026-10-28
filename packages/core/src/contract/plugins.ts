import type { Risk } from "./common.ts";
import type { ChannelKind } from "./channels.ts";

// ─── Plugins: the extension point ───────────────────────────────────────────

export type PluginManifest = {
  id: string;
  name: string;
  description: string;
  tools: { name: string; description: string; risk: Risk; defaultPolicy?: "ask" | "allow" }[];
  /** Settings keys the plugin reads, shown as a form in the UI. */
  settings: { key: string; label: string; secret: boolean; required: boolean; multiline?: boolean }[];
  briefing: boolean;
  enabled: boolean;
};

export type AdapterManifest = {
  kind: ChannelKind;
  label: string;
  /**
   * Fields for ChannelInput.config, rendered as a form. A `toggle` field is on when its value is `on`.
   * `generate`: pre-fill a random secret on create. `legacy`: show only where it is already set.
   */
  config: { key: string; label: string; secret: boolean; required: boolean; toggle?: boolean; generate?: boolean; legacy?: boolean }[];

  /** Whether the platform calls us (needs Z_PUBLIC_URL) or we connect out. */
  mode: "webhook" | "connect";
};

// Routes (HTTP API; overview in ../contract.ts):
// GET    /api/adapters                     → AdapterManifest[]
// GET    /api/plugins                      → PluginManifest[]
// PUT    /api/plugins/:id   { enabled: boolean, settings?: Record<string,string> } → PluginManifest
