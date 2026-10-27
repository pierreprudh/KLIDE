// Throwaway page for the one diff renderer, without launching Tauri.
//
// Renders DiffView over a two-file patch: a modified file with a word-level
// change pair and a hunk gap, and an added file. Line comments are on, so a
// gutter click shows the selection marker and the composer.
//
//   npm run dev  →  http://localhost:1420/preview/file-diff.html
//   ?theme=dark | klide-light | sage-garden | …
import ReactDOM from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "@fontsource/monaspace-neon/400.css";
import "@fontsource/monaspace-neon/700.css";
import "../src/styles/tokens.css";
import { DiffView, parseDiffBlocks, type FileCount } from "../src/components/diffView";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "klide-light";

const PATCH = `diff --git a/src/auth.ts b/src/auth.ts
index 1234567..89abcde 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -12,3 +12,5 @@ import { cookies } from "./cookies";
 export function getToken() {
-  return localStorage.token;
+  const t = cookies.get("session");
+  if (!t) throw new Error("no session");
+  return t;
 }
@@ -40,3 +42,3 @@ export function signOut() {
 export function ttl() {
-  return 60 * 60;
+  return 60 * 60 * 24;
 }
diff --git a/src/session.ts b/src/session.ts
new file mode 100644
--- /dev/null
+++ b/src/session.ts
@@ -0,0 +1,3 @@
+export type Session = { id: string; expires: number };
+
+export const isLive = (s: Session) => s.expires > Date.now();`;

const counts = new Map<string, FileCount>([
  ["src/auth.ts", { status: "M", additions: 4, deletions: 2 }],
  ["src/session.ts", { status: "A", additions: 3, deletions: 0 }],
]);

function App() {
  return (
    <div style={{ background: "var(--bg)", minHeight: "100vh", padding: "24px 0", maxWidth: 640 }}>
      <DiffView
        blocks={parseDiffBlocks(PATCH.split("\n"))}
        limit={1000}
        fileCounts={counts}
        onLineComment={(c) => console.log(c)}
        commentActionLabel="Send to agent"
        onOpenFile={(path) => console.log("open", path)}
      />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
