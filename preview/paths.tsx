// Throwaway page for paths in a model's answer, without launching Tauri.
//
// The half worth seeing in a browser is the judgement: which backticked spans
// became places you can open, which stayed prose, and where each one resolves.
// Outside Tauri there is no file manager, so `revealPath` reports the absolute
// path it *would* have shown and this page logs it — same decision, no Finder.
//
//   npx vite --port 1421   →  http://localhost:1421/preview/paths.html
//   ?theme=dark | klide-light | sage-garden | …
import { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "@fontsource/monaspace-neon/400.css";
import "@fontsource/monaspace-neon/700.css";
import "../src/styles/tokens.css";
import { renderMarkdown } from "../src/components/markdown";
import { primeWorkspaceIndex } from "../src/workspaceIndex";
import { registerWorkspaceOpener } from "../src/revealPath";
import { notify } from "../src/toast";
import { subscribeToasts, type Toast } from "../src/toast";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "klide-light";

// The browser has no Tauri backend to walk a project with, so the page stands
// in a repository: these are the files Klide is "opened on" here.
primeWorkspaceIndex("/Users/pierre/Documents/Private/KIDE", [
  "src/App.tsx",
  "src/runPresentation.ts",
  "docs/MODEL_ROUTING.md",
  "docs/HARNESS_CONTRACT.md",
  "CLAUDE.md",
]);

// Stand in for App's tab opener, so the two destinations are visibly
// different out here: one logs an editor open, the other a Finder reveal.
registerWorkspaceOpener("/Users/pierre/Documents/Private/KIDE", async (path, line) => {
  notify(`editor \u2192 ${path}${line ? `:${line}` : ""}`, { tone: "success" });
});

const IN_REPO: [string, string][] = [
  ["a file this project holds", "The one status vocabulary lives in `src/runPresentation.ts`."],
  ["with a line", "The picker starts in `src/App.tsx:2028`, not wherever the OS left it."],
  ["a folder on the way to one", "The contracts are under `docs/`."],
];

const OPENS: [string, string][] = [
  ["another project — the case that started this", "Take a look in the other project `/Users/pierre/Documents/Private/Sylvia`, the same rule is in there."],
  ["wrapped in bold, the way a model writes it", "It's at **`/Users/pierre/Documents/Onetraak`** \u2014 not inside the workspace I'm opened on (`/Users/pierre/Documents/Private/KIDE`)."],
  ["a file, with its line", "The picker starts in `/Users/pierre/Documents/Private/KIDE/src/App.tsx:2028`."],
  ["home-relative", "Connectors are read from `~/.klide/connectors.json` at start."],
  ["two in a sentence", "It spans `~/KIDE/src-tauri/src/agent/mod.rs` and `~/KIDE/src/agent/client.ts`, nothing between them."],
];

const STAYS_PROSE: [string, string][] = [
  ["the paragraph that started this \u2014 every span belongs to another project", "Quick shape of it: a Python project (uv/`pyproject.toml`, `.venv`), on branch `dev`, last commit `d28f499` \u2014 a merge of `m6/orchestrator`. It has a `harness/` package, `skills/`, `deploy/`, `docs/` and a `CLAUDE.md`."],
  ["this project's own files \u2014 Finder is not where those open", "The one status vocabulary lives in `src/runPresentation.ts`, the rule in `docs/MODEL_ROUTING.md`."],
  ["a command", "Run `npm run tauri dev` to see it."],
  ["a flag", "Pass `--force` only when you mean it."],
  ["a glob", "It walks `/Users/pierre/KIDE/src/**/*.ts` and stops there."],
  ["a bare word", "The native tool is `memory_search`."],
  ["a version", "Tauri is pinned at `1.2.3` here."],
  ["an address", "MLX answers on `127.0.0.1:8080`, Ollama on `localhost:11434`."],
  ["a URL in code", "Run `curl https://v2.tauri.app` to check it."],
  ["a fenced block \u2014 never a link", "```sh\ncat /Users/pierre/KIDE/src/App.tsx\n```"],
];

function Cases({ title, note, cases }: { title: string; note: string; cases: [string, string][] }) {
  return (
    <section style={{ marginBottom: 34 }}>
      <h2 style={{ fontSize: 13, fontWeight: 600, margin: "0 0 3px" }}>{title}</h2>
      <p style={{ fontSize: 12, color: "var(--fg-subtle)", margin: "0 0 22px" }}>{note}</p>
      {cases.map(([label, text]) => (
        <div key={label} style={{ marginBottom: 22 }}>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--fg-subtle)", marginBottom: 8 }}>
            {label}
          </div>
          <div style={{ fontSize: 14, lineHeight: 1.6 }}>{renderMarkdown(text)}</div>
        </div>
      ))}
    </section>
  );
}

function Page() {
  // Toasts auto-dismiss; the log here is cumulative, so a run of clicks stays
  // readable side by side.
  const [log, setLog] = useState<Toast[]>([]);
  useEffect(
    () =>
      subscribeToasts((live) =>
        setLog((seen) => {
          const known = new Set(seen.map((t) => t.id));
          const fresh = live.filter((t) => !known.has(t.id));
          return fresh.length ? [...fresh.reverse(), ...seen] : seen;
        }),
      ),
    [],
  );

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: "var(--bg)", color: "var(--fg)", fontFamily: "var(--font-ui)" }}>
      <div style={{ flex: 1, padding: "32px 28px", maxWidth: 720 }}>
        <h1 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 4px" }}>Paths in an answer</h1>
        <p style={{ fontSize: 12, color: "var(--fg-subtle)", margin: "0 0 30px" }}>
          A path this repository holds opens in a tab. A rooted path outside it
          opens in Finder, reading as its last word. Anything this project does
          not recognise stays a code span — it belongs to whichever project the
          answer is about. Out here there is no editor and no Finder, so a
          click reports where it would have gone.
        </p>
        <Cases
          title="Opens in the editor"
          note="This repository holds these, so they belong in a tab. The path keeps its folder — `App.tsx` alone is not the file."
          cases={IN_REPO}
        />
        <Cases
          title="Opens in Finder"
          note="Rooted, and outside this project — only the file manager can show them."
          cases={OPENS}
        />
        <Cases
          title="Stays prose"
          note="Either not a place at all, or a name this repository does not recognise — so it belongs to whichever project the answer is about, and stays a code span."
          cases={STAYS_PROSE}
        />
      </div>
      <aside style={{ width: 340, borderLeft: "1px solid var(--border)", padding: "32px 24px", position: "sticky", top: 0, alignSelf: "flex-start", height: "100vh" }}>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--fg-subtle)", marginBottom: 12 }}>
          resolved
        </div>
        {log.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--fg-subtle)" }}>Nothing clicked yet.</div>
        ) : (
          log.map((t) => (
            <div key={t.id} style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, lineHeight: 1.7, color: t.tone === "warn" || t.tone === "error" ? "var(--warning)" : "var(--fg)", wordBreak: "break-all", marginBottom: 6 }}>
              {t.message}
            </div>
          ))
        )}
      </aside>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<Page />);
