import { configDefaults, defineConfig } from "vitest/config";
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
  test: {
    // Coding-agent worktrees live at `.claude/worktrees/<name>/` — inside the
    // repo, and hidden from `git status` by `.git/info/exclude`. Each one holds
    // a full copy of `src/`, so vitest's default include globbed their tests
    // too and every local run silently doubled: 26 files became 52, 215 tests
    // became 430. CI never saw it (fresh checkout, no worktrees), which is the
    // worst shape for a wrong number — it only lies on the machine you develop
    // on. `KIDE-worktrees/` siblings are outside the root and were never
    // affected.
    exclude: [...configDefaults.exclude, "**/.claude/worktrees/**"],
  },
  build: {
    // Keep the app shell readable in production output. Monaco's workers stay
    // as their own emitted assets; these chunks separate the biggest shared
    // browser-side libraries from Klide's application code.
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Vite's dynamic-import preload helper is a virtual module every lazy
          // chunk imports. Left to Rollup it was hoisted into whichever chunk
          // came first — vendor-monaco — which made every lazy surface pull
          // the 4.5 MB editor core onto the first-paint path. Pin it to the
          // small vendor chunk the entry always loads.
          if (id.includes("vite/preload-helper")) return "vendor";
          if (!id.includes("node_modules")) return undefined;
          if (/\/(exceljs|fast-formula-parser|ssf|frac|chevrotain|regexp-to-ast|bahttext|bessel|jstat)\//.test(id)) return "vendor-spreadsheet";
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
