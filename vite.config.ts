import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    // Keep the app shell readable in production output. Monaco's workers stay
    // as their own emitted assets; these chunks separate the biggest shared
    // browser-side libraries from Klide's application code.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("monaco-editor") || id.includes("@monaco-editor")) return "vendor-monaco";
          if (id.includes("@xterm")) return "vendor-terminal";
          if (id.includes("@tauri-apps")) return "vendor-tauri";
          if (id.includes("react")) return "vendor-react";
          if (id.includes("/diff/") || id.endsWith("/diff/lib/index.es6.js")) return "vendor-diff";
          return "vendor";
        },
      },
    },
    // Monaco's TypeScript worker is intentionally large and loaded as a worker
    // asset. Warn on genuinely surprising chunks above that size.
    chunkSizeWarningLimit: 8_000,
  },
}));
