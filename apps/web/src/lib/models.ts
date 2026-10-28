import type { ProviderKind, Routing } from "@z/core";

/** Model ids may contain ":" themselves (`llm7:gpt-oss:20b`), so split on the first one only. */
export function splitRef(ref: string): { provider: string; model: string } {
  const i = ref.indexOf(":");
  return i === -1 ? { provider: ref, model: "" } : { provider: ref.slice(0, i), model: ref.slice(i + 1) };
}

export type ProviderPreset = {
  key: string;
  kind: ProviderKind;
  label: string;
  id: string;
  /** Shown as the placeholder (server default) unless `fixedBaseURL`. */
  baseURL?: string;
  fixedBaseURL?: boolean;
  docs?: string;
  needsKey: boolean;
  /** Two-letter mark for the monogram. */
  mark: string;
  free?: boolean;
  models?: string[];
};

export const PRESETS: ProviderPreset[] = [
  {
    key: "llm7",
    mark: "L7",
    kind: "openai-compatible",
    label: "LLM7",
    id: "llm7",
    baseURL: "https://api.llm7.io/v1",
    fixedBaseURL: true,
    docs: "https://llm7.io",
    needsKey: false,
    free: true,
    models: ["gpt-oss:20b", "codestral-latest", "nemotron-3-nano:30b", "minimax-m2.7"],
  },
  {
    key: "pollinations",
    mark: "PO",
    kind: "openai-compatible",
    label: "Pollinations",
    id: "pollinations",
    baseURL: "https://text.pollinations.ai/openai",
    fixedBaseURL: true,
    docs: "https://pollinations.ai",
    needsKey: false,
    free: true,
    models: ["openai-fast"],
  },
  { key: "openai", mark: "OA", kind: "openai", label: "OpenAI", id: "openai", baseURL: "https://api.openai.com/v1", docs: "https://platform.openai.com/api-keys", needsKey: true },
  { key: "anthropic", mark: "AN", kind: "anthropic", label: "Anthropic", id: "anthropic", baseURL: "https://api.anthropic.com/v1", docs: "https://console.anthropic.com/settings/keys", needsKey: true },
  { key: "google", mark: "GO", kind: "google", label: "Google", id: "google", baseURL: "https://generativelanguage.googleapis.com/v1beta", docs: "https://aistudio.google.com/apikey", needsKey: true },
  { key: "xai", mark: "xA", kind: "xai", label: "xAI", id: "xai", baseURL: "https://api.x.ai/v1", docs: "https://console.x.ai", needsKey: true },
  { key: "openrouter", mark: "OR", kind: "openrouter", label: "OpenRouter", id: "openrouter", baseURL: "https://openrouter.ai/api/v1", docs: "https://openrouter.ai/keys", needsKey: true },
  { key: "ollama", mark: "OL", kind: "ollama", label: "Ollama", id: "local", baseURL: "http://localhost:11434/v1", docs: "https://ollama.com/download", needsKey: false },
  { key: "codex", mark: "CX", kind: "codex-cli", label: "Codex (ChatGPT plan)", id: "codex", needsKey: false },
  { key: "custom", mark: "{}", kind: "openai-compatible", label: "OpenAI-compatible", id: "custom", needsKey: false },
];

export function presetFor(kind: ProviderKind, baseURL?: string): ProviderPreset {
  return (
    PRESETS.find((p) => p.fixedBaseURL && p.baseURL === baseURL) ??
    PRESETS.find((p) => p.kind === kind && !p.free) ??
    PRESETS[PRESETS.length - 1]!
  );
}

/** One-tap onboarding: LLM7 serves every lane, with fallbacks inside the same provider. */
export const LLM7_ROUTING: Routing = {
  chat: ["llm7:gpt-oss:20b", "llm7:codestral-latest"],
  agent: ["llm7:gpt-oss:20b", "llm7:nemotron-3-nano:30b"],
  briefing: ["llm7:gpt-oss:20b", "llm7:codestral-latest"],
  bot: ["llm7:codestral-latest", "llm7:gpt-oss:20b"],
  fast: ["llm7:codestral-latest"],
};
