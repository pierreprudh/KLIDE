#!/usr/bin/env node
// check-bundle-split.mjs — fail the build if the editor core or the terminal
// emulator lands back on the first-paint path.
//
// `vite.config.ts` splits Monaco (4.5 MB) and xterm into their own chunks, but
// splitting is not deferring: one static import from the entry graph and Vite
// adds the chunk to index.html's <link rel="modulepreload"> list, so every
// launch downloads and parses it before the Welcome screen paints. That is how
// it shipped for months — `chunkSizeWarningLimit` was raised past the warning
// that would have said so. `src/components/lazySurfaces.tsx` loads those
// surfaces on first render; this script keeps it that way.
//
// Runs after `vite build` (see package.json "build"). Reads dist/index.html.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const DIST = process.argv[2] ?? "dist";
// Chunks that must not be preloaded by the entry. Names come from
// `manualChunks` in vite.config.ts.
const DEFERRED_CHUNKS = ["vendor-monaco", "vendor-terminal", "vendor-spreadsheet"];
// The app shell itself. 0.53 MB today; a jump past this means something heavy
// was statically imported into App.
const ENTRY_LIMIT_BYTES = 1_000_000;

function fail(msg) {
  console.error(`✗ bundle split: ${msg}`);
  process.exit(1);
}

const html = readFileSync(join(DIST, "index.html"), "utf8");
const preloads = [...html.matchAll(/<link rel="modulepreload"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
const entries = [...html.matchAll(/<script type="module"[^>]*src="([^"]+)"/g)].map((m) => m[1]);

for (const chunk of DEFERRED_CHUNKS) {
  const hit = preloads.find((href) => href.includes(`/${chunk}-`));
  if (hit) {
    fail(
      `${chunk} is modulepreloaded by the entry (${hit}) — a static import put it back on the ` +
        `first-paint path. Import the surface through src/components/lazySurfaces.tsx instead.`,
    );
  }
}

if (entries.length !== 1) fail(`expected one entry <script>, found ${entries.length}`);
const entryPath = join(DIST, entries[0].replace(/^\//, ""));
const entrySize = statSync(entryPath).size;
if (entrySize > ENTRY_LIMIT_BYTES) {
  fail(`entry chunk is ${(entrySize / 1e6).toFixed(2)} MB (limit ${ENTRY_LIMIT_BYTES / 1e6} MB): ${entries[0]}`);
}

const assets = readdirSync(join(DIST, "assets"));
for (const chunk of DEFERRED_CHUNKS) {
  if (!assets.some((name) => name.startsWith(`${chunk}-`) && name.endsWith(".js"))) {
    fail(`${chunk} chunk is missing from dist/assets — manualChunks in vite.config.ts changed?`);
  }
}

const preloadBytes = preloads.reduce((sum, href) => sum + statSync(join(DIST, href.replace(/^\//, ""))).size, 0);
console.log(
  `✓ bundle split: entry ${(entrySize / 1e6).toFixed(2)} MB + ${preloads.length} preloads ` +
    `${(preloadBytes / 1e6).toFixed(2)} MB; ${DEFERRED_CHUNKS.join(", ")} load on demand`,
);
