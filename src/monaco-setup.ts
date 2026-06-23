// Self-host Monaco from the bundled npm package instead of its default CDN.
//
// `@monaco-editor/react` uses `@monaco-editor/loader`, which by default fetches
// the whole editor from `cdn.jsdelivr.net` at runtime. For a local-first IDE
// that's wrong twice over: the editor silently needs the internet to open, and
// the CDN dependency blocks a tight Content-Security-Policy. Pointing the
// loader at the bundled `monaco-editor` makes it load from `self`, fully
// offline — and clears the way for `script-src 'self'`.
//
// Vite compiles Monaco's language services as separate web-worker bundles via
// the `?worker` imports; `MonacoEnvironment.getWorker` hands the right one to
// the editor per language. Imported once from `main.tsx` before <App> mounts.
import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker(_workerId, label) {
    switch (label) {
      case "json":
        return new jsonWorker();
      case "css":
      case "scss":
      case "less":
        return new cssWorker();
      case "html":
      case "handlebars":
      case "razor":
        return new htmlWorker();
      case "typescript":
      case "javascript":
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};

// Use the bundled instance — no network fetch, no CDN.
loader.config({ monaco });
