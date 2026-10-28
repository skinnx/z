import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const api = process.env.Z_API ?? "http://localhost:8787";

/** Emits /sw.js from src/sw.js with this build's files to precache, under a cache named after them. */
function serviceWorker(): Plugin {
  return {
    name: "z-service-worker",
    apply: "build",
    generateBundle(_, bundle) {
      const files = Object.keys(bundle)
        .filter((f) => !f.endsWith(".map") && f !== "index.html")
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
