import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { defineConfig, type Plugin, type Rolldown } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const api = process.env.Z_API ?? "http://localhost:8787";

/**
 * Code loaded only when a reply needs it: Shiki (and its ~300 grammars and themes), KaTeX and
 * Mermaid. They are not precached; the worker caches each chunk the first time it is fetched.
 */
const ON_DEMAND = /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(?:@streamdown\/(?:code|math|mermaid)|katex|shiki|@shikijs\/[^/]+|mermaid)\//;

/** Every file the app can load without reaching into an on-demand library. */
function precacheList(bundle: Rolldown.OutputBundle): string[] {
  type Chunk = Rolldown.OutputChunk;
  const chunks = new Map<string, Chunk>();
  for (const out of Object.values(bundle)) if (out.type === "chunk") chunks.set(out.fileName, out);
  const onDemand = (c: Chunk) => c.isDynamicEntry && !!c.facadeModuleId && ON_DEMAND.test(c.facadeModuleId);
  const keep = new Set<string>();
  const referenced = new Set<string>();
  const stack = [...chunks.values()].filter((c) => c.isEntry).map((c) => c.fileName);
  while (stack.length) {
    const c = chunks.get(stack.pop()!);
    if (!c || keep.has(c.fileName)) continue;
    keep.add(c.fileName);
    for (const f of [...(c.viteMetadata?.importedCss ?? []), ...(c.viteMetadata?.importedAssets ?? [])]) keep.add(f);
    stack.push(...c.imports, ...c.dynamicImports.filter((f) => !chunks.get(f) || !onDemand(chunks.get(f)!)));
  }
  for (const c of chunks.values()) for (const f of [...(c.viteMetadata?.importedCss ?? []), ...(c.viteMetadata?.importedAssets ?? [])]) referenced.add(f);
  // Assets no chunk claims (icons, the main stylesheet) are part of the shell.
  for (const [f, out] of Object.entries(bundle)) if (out.type === "asset" && !referenced.has(f)) keep.add(f);
  return [...keep].filter((f) => !f.endsWith(".map") && f !== "index.html");
}

/** Emits /sw.js from src/sw.js with this build's files to precache, under a cache named after them. */
function serviceWorker(): Plugin {
  return {
    name: "z-service-worker",
    apply: "build",
    generateBundle(_, bundle) {
      const files = precacheList(bundle)
        .map((f) => `/${f}`)
        .sort();
      const version = createHash("sha256").update(files.join("\n")).digest("hex").slice(0, 12);
      const source = readFileSync(new URL("./src/sw.js", import.meta.url), "utf8")
        .replace("self.__PRECACHE__", JSON.stringify(files))
        .replace("self.__VERSION__", JSON.stringify(version));
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}

const proxy = {
  // Connector OAuth builds its redirect URI from the request origin: keep the browser's host so
  // the provider sends the user back through this dev server (first match wins, so it leads).
  "/api/connectors": { target: api, changeOrigin: false },
  "/oauth": { target: api, changeOrigin: false },
  "/api": { target: api, changeOrigin: true },
  "/hooks": { target: api, changeOrigin: true },
};

export default defineConfig({
  plugins: [react(), tailwindcss(), serviceWorker()],
  build: { chunkSizeWarningLimit: 600 },
  server: { proxy },
  preview: { proxy },
});
