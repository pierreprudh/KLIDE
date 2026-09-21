// Throwaway page for links in a model's answer, without launching Tauri.
//
// It renders the real markdown renderer over the link shapes a model actually
// writes, and reports every click the page intercepts. Outside Tauri there is
// no opener plugin, so `openExternal` falls back to `window.open` — what this
// page proves is the half that is pure: which text became a link, where the
// link ends, and that the click never navigates this page.
//
//   npx vite --port 1421   →  http://localhost:1421/preview/links.html
//   ?theme=dark | klide-light | sage-garden | …
import { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "@fontsource/monaspace-neon/400.css";
import "@fontsource/monaspace-neon/700.css";
import "../src/styles/tokens.css";
import { renderMarkdown } from "../src/components/markdown";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "klide-light";

const CASES: [string, string][] = [
  ["a repo — reads as the repo, not the owner", "Ported the worktree recipe from https://github.com/tauri-apps/tauri last week."],
  ["a deep repo path", "The shapes are in https://github.com/ollama/ollama/blob/main/docs/api.md if you need them."],
  ["several in one line", "Compare https://github.com/microsoft/monaco-editor with https://github.com/xtermjs/xterm.js here."],
  ["a package", "Install https://www.npmjs.com/package/@tauri-apps/api first."],
  ["products Klide knows", "Read https://v2.tauri.app, then https://xtermjs.org/docs/, then https://ollama.com/library/llama3.1."],
  ["a provider", "Keys go to https://platform.openai.com and https://docs.anthropic.com respectively."],
  ["an unknown host — reads as the host", "The write-up is at https://www.example.com/2026/09/a-very-long-slug-nobody-reads."],
  ["a sentence that ends on one", "Start with https://xtermjs.org/docs/."],
  ["one in parentheses", "Monaco is the core (see https://github.com/suren-atoyan/monaco-react) that VS Code uses."],
  ["a URL with its own parens", "See https://en.wikipedia.org/wiki/Monaco_(editor) for the history."],
  ["author's words — kept, brand still marked", "See [the Ollama API](https://github.com/ollama/ollama) and [the plain guide](https://example.com/guide)."],
  ["a table, the way a model writes one", "| Competitor | Useful pattern |\n| --- | --- |\n| https://github.com/orca-so/orca | Explicit outcomes |\n| https://claude.ai | Background workers |\n| https://cursor.com | Option to finish |"],
  ["a mailto — already a name", "Mail [the maintainer](mailto:someone@example.com) about it."],
  ["a URL inside code — must stay text", "Run `curl https://v2.tauri.app` to check it."],
  ["a URL in a fenced block — must stay text", "```sh\ncurl https://v2.tauri.app\n```"],
  ["a poisoned scheme — must not link", "Click [here](javascript:alert(1)) to continue."],
  ["a data: URL — must not link", "Open [this](data:text/html,<script>alert(1)</script>) now."],
  ["a link inside a drawing", "```html\n<p style=\"font-family:var(--font-ui);font-size:13px\">A drawing with <a href=\"https://v2.tauri.app\">a link inside it</a>.</p>\n```"],
];

function Page() {
  const [log, setLog] = useState<string[]>([]);
  const [navigated, setNavigated] = useState(false);

  useEffect(() => {
    // `window.open` stands in for the opener plugin out here. Recording it is
    // the point: a click that reaches this handler never reached the webview.
    const real = window.open;
    window.open = ((url?: string | URL) => {
      setLog((l) => [`opened externally → ${String(url)}`, ...l]);
      return null;
    }) as typeof window.open;
    const onUnload = () => setNavigated(true);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      window.open = real;
      window.removeEventListener("beforeunload", onUnload);
    };
  }, []);

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: "var(--bg)", color: "var(--fg)", fontFamily: "var(--font-ui)" }}>
      <div style={{ flex: 1, padding: "32px 28px", maxWidth: 720 }}>
        <h1 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 4px" }}>Links in an answer</h1>
        <p style={{ fontSize: 12, color: "var(--fg-subtle)", margin: "0 0 28px" }}>
          A bare URL reads as its name with the site's mark; the address is the hover. Click every blue thing \u2014 each logs on the right, none navigates this page.
        </p>
        {CASES.map(([label, text]) => (
          <section key={label} style={{ marginBottom: 26 }}>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--fg-subtle)", marginBottom: 8 }}>
              {label}
            </div>
            <div style={{ fontSize: 14, lineHeight: 1.6 }}>{renderMarkdown(text)}</div>
          </section>
        ))}
      </div>
      <aside style={{ width: 320, borderLeft: "1px solid var(--border)", padding: "32px 24px", position: "sticky", top: 0, alignSelf: "flex-start", height: "100vh" }}>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--fg-subtle)", marginBottom: 12 }}>
          intercepted
        </div>
        {navigated ? (
          <div style={{ fontSize: 12, color: "var(--danger)", marginBottom: 12 }}>
            This page navigated — that is the bug.
          </div>
        ) : null}
        {log.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--fg-subtle)" }}>Nothing clicked yet.</div>
        ) : (
          log.map((line, i) => (
            <div key={i} style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, lineHeight: 1.7, color: "var(--fg)", wordBreak: "break-all", marginBottom: 6 }}>
              {line}
            </div>
          ))
        )}
      </aside>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<Page />);
