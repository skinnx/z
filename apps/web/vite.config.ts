import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const api = process.env.Z_API ?? "http://localhost:8787";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { chunkSizeWarningLimit: 600 },
  server: {
    proxy: {
      "/api": { target: api, changeOrigin: true },
      "/hooks": { target: api, changeOrigin: true },
    },
  },
  preview: {
    proxy: {
      "/api": { target: api, changeOrigin: true },
      "/hooks": { target: api, changeOrigin: true },
    },
  },
});
