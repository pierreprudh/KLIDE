// Throwaway page for the Git Review workbench, without launching Tauri.
//
// The real GitReview over a mocked IPC: a dirty tree (one staged, two
// changed), a short history, one stash and two pull requests. Mutations
// resolve and change nothing.
//
//   npm run dev  →  http://localhost:1420/preview/git-review.html
//   ?theme=dark | klide-light | sage-garden | …
import ReactDOM from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "@fontsource/monaspace-neon/400.css";
import "@fontsource/monaspace-neon/700.css";
import "../src/styles/tokens.css";
import { GitReview } from "../src/components/GitReview";
import type { GitStatus } from "../src/gitTypes";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") ?? "klide-light";
document.documentElement.dataset.theme = theme;

const now = Math.floor(Date.now() / 1000);
const status: GitStatus = {
  branch: "main",
  files: [
    { path: "src/auth.ts", status: "M", staged: true },
    { path: "CONTEXT.md", status: "M", staged: false },
    { path: "src/session.ts", status: "A", staged: false },
  ],
};
const commits = [
  ["a1b2c3d", "fix: a run parked before the window opened still says it needs you", ["HEAD -> main", "origin/main"]],
  ["b2c3d4e", "fix(toast): more room between the answers", []],
  ["c3d4e5f", "polish(diff): each file a hairline card with edge markers", []],
  ["d4e5f6a", "feat(review): Diff Comment → Agent", ["tag: v0.6.11"]],
].map(([h, subject, refs], i, all) => ({
  hash: (h as string).repeat(6).slice(0, 40), shortHash: h as string, subject: subject as string, author: "pierreprudh",
  authorEmail: "pierreprudh@users.noreply.github.com", timestamp: now - i * 5400, refs: refs as string[],
  parents: i < all.length - 1 ? [(all[i + 1][0] as string).repeat(6).slice(0, 40)] : [],
}));
const DIFF = `diff --git a/CONTEXT.md b/CONTEXT.md
--- a/CONTEXT.md
+++ b/CONTEXT.md
@@ -1,5 +1,7 @@
 # Klide
 
+TEST
+
 The domain language of Klide — a minimalist AI-first IDE. Reviews use this vocabulary; code drifts, not it.
 
 ## Core product principle: harness and model independence`;
const pr = (n: number, title: string, badge: "open" | "draft") => ({
  number: n, title, state: "OPEN", isDraft: badge === "draft", author: "pierreprudh", headRef: `polish/pr-${n}`, baseRef: "main",
  url: `https://github.com/pierreprudh/KLIDE/pull/${n}`, additions: 120, deletions: 34, changedFiles: 4, comments: 2,
  commentAuthors: ["pierreprudh"], updatedAtMs: Date.now() - n * 60000, badge, isCurrentBranch: false,
});
const replies: Record<string, unknown> = {
  git_status: status,
  git_log: { branch: "main", upstream: "origin/main", ahead: 1, behind: 0, lastFetchMs: Date.now() - 120000, commits, branches: [{ name: "main", isCurrent: true }], tags: [], defaultBranch: "main" },
  git_graph: commits,

  git_stash_list: [{ index: 0, branch: "main", message: "WIP on main", timestamp: now - 3600 }],
  git_commit_details: {
    ...commits[2], body: "", files: [{ path: "src/components/diffView.tsx", status: "M", additions: 3, deletions: 1 }, { path: "src/session.ts", status: "A", additions: 1, deletions: 0 }],
    diff: `diff --git a/src/components/diffView.tsx b/src/components/diffView.tsx
@@ -12,3 +12,5 @@ export function DiffView() {
 const rows = [];
-const ROW = "36px 36px 18px 1fr";
+const ROW_COLUMNS = "3px 34px 34px 22px 1fr";
+const GUTTER_WIDTH = 71;
 return rows;
diff --git a/src/session.ts b/src/session.ts
@@ -0,0 +1,1 @@
+export type Session = { id: string };`, additions: 4, deletions: 1,
  },
  git_pr_list: [pr(321, "Git Review on rounded cards", "open"), pr(318, "Commit graph density zoom", "draft")],
};
(window as any).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string, args?: { path?: string }) => {
    if (cmd === "git_diff") {
      const path = args?.path ?? "";
      if (path === "CONTEXT.md") return { path, diff: DIFF, additions: 2, deletions: 0 };
      return {
        path,
        diff: `diff --git a/${path} b/${path}\n@@ -1,3 +1,4 @@\n export const a = 1;\n-export const b = 2;\n+export const b = 3;\n+export const c = b * 2;\n export default a;`,
        additions: 2,
        deletions: 1,
      };
    }
    return cmd in replies ? replies[cmd] : null;
  },
  transformCallback: () => 0,
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <div style={{ height: "100vh", display: "flex" }}>
    <GitReview workspaceRoot="/fixture" gitStatus={status} onRefreshGitStatus={() => {}} theme={theme as never} onOpenFile={(path) => console.log("open", path)} />
  </div>
);
