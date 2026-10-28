/**
 * Streamdown plugins that load on first use, so Shiki, KaTeX and Mermaid stay out of the
 * bundle until a reply actually contains code, math or a diagram.
 *
 * - code: highlight() answers `null` until @streamdown/code (and Shiki) has loaded, then calls
 *   back, which is exactly the async contract Streamdown already expects from the real plugin.
 * - mermaid: render() awaits the import.
 * - math: unified plugins must be synchronous, so math is a plugin set you get from
 *   `usePlugins(text)`: once a reply contains `$$`, KaTeX loads and the set gains `math`.
 */
import { useSyncExternalStore } from "react";
import type { CodeHighlighterPlugin, DiagramPlugin, HighlightResult, MathPlugin, PluginConfig } from "streamdown";

type CodeModule = typeof import("@streamdown/code");
type RealCode = ReturnType<CodeModule["createCodePlugin"]>;

let realCode: RealCode | null = null;
let codeLoading: Promise<RealCode> | null = null;
const loadCode = () =>
  (codeLoading ??= import("@streamdown/code").then((m) => {
    realCode = m.code;
    return m.code;
  }));

const THEMES: [string, string] = ["github-light", "github-dark"];

export const lazyCode: CodeHighlighterPlugin = {
  name: "shiki",
  type: "code-highlighter",
  getThemes: () => THEMES,
  // Until Shiki is here every language "may" be supported; unknown ones fall back to plain text.
  getSupportedLanguages: () => realCode?.getSupportedLanguages() ?? [],
  supportsLanguage: (language) => realCode?.supportsLanguage(language as never) ?? true,
  highlight(options, callback) {
    if (realCode) return realCode.highlight(options as never, callback as never) as HighlightResult | null;
    void loadCode().then((code) => {
      const sync = code.highlight(options as never, callback as never);
      if (sync) callback?.(sync as HighlightResult);
    });
    return null;
  },
};

type MermaidConfig = Parameters<DiagramPlugin["getMermaid"]>[0];

export const lazyMermaid: DiagramPlugin = {
  name: "mermaid",
  type: "diagram",
  language: "mermaid",
  getMermaid(initial?: MermaidConfig) {
    let config = initial;
    return {
      initialize(next) {
        config = next;
      },
      async render(id, source) {
        const { mermaid } = await import("@streamdown/mermaid");
        return mermaid.getMermaid(config as never).render(id, source);
      },
    };
  },
};

// ─── Math: a tiny store so every message re-renders once KaTeX is in ─────────────────────────

let math: MathPlugin | null = null;
let mathLoading = false;
const listeners = new Set<() => void>();

function loadMath() {
  if (math || mathLoading) return;
  mathLoading = true;
  void Promise.all([import("@streamdown/math"), import("katex/dist/katex.min.css")]).then(([m]) => {
    math = m.math;
    for (const l of listeners) l();
  });
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

const base: PluginConfig = { code: lazyCode, mermaid: lazyMermaid };
let withMath: PluginConfig | null = null;

/** Display math is `$$…$$` (single `$` stays text, as in @streamdown/math's default). */
export const hasMath = (text: string) => text.includes("$$");

/** The plugin set for one piece of markdown. Stable identity, so memoised renderers stay put. */
export function usePlugins(text: string): PluginConfig {
  const loaded = useSyncExternalStore(subscribe, () => math);
  if (!loaded) {
    if (hasMath(text)) loadMath();
    return base;
  }
  return (withMath ??= { ...base, math: loaded });
}

/** Highlight outside Streamdown (CodeBlock), sharing the same Shiki instance. */
export function highlight(code: string, language: string, done: (result: HighlightResult) => void): HighlightResult | null {
  return lazyCode.highlight({ code, language, themes: THEMES }, done);
}
