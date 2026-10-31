// Throwaway page for the ⌘P / ⌘⇧P command menu over a fake workbench.
//   http://localhost:1420/preview/command-menu.html?theme=dark&mode=commands|files|search
import ReactDOM from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "@fontsource/monaspace-neon/400.css";
import "../src/styles/tokens.css";
import { CommandPalette } from "../src/components/CommandPalette";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "dark";
const mode = params.get("mode") ?? "commands";

localStorage.setItem("klide.recentFiles", JSON.stringify([
  "src/components/CommandPalette.tsx",
  "src/styles/tokens.css",
  "src-tauri/src/agent/mod.rs",
  "README.md",
  "TODO.md",
]));

const noop = () => {};
const labels: [string, string?][] = [
  ["File: Save", "⌘S"], ["File: Open Folder…", "⌘O"], ["File: Switch Project (Welcome)"],
  ["View: Close Tab", "⌘W"], ["Edit: Find in Files", "⌘⇧F"], ["Terminal: Toggle", "⌘`"],
  ["View: Toggle AI Panel"], ["Preferences: Open Settings", "⌘,"], ["View: Open Profile", "⌘."],
  ["Appearance: Toggle Theme"], ["Editor: Toggle Word Wrap"], ["Editor: Toggle Line Numbers"],
  ["Layout: Anchored (IDE)"], ["Layout: Focus (chat)"], ["View: Git Review", "⌘⇧G"],
  ["Git: Create Pull Request…"], ["Agent: New Run in Worktree"], ["View: Worktrees"],
];
const commands = labels.map(([label, shortcut], i) => ({ id: `c${i}`, label, shortcut, action: noop }));
const initialQuery = mode === "files" ? "" : mode === "search" ? ">git" : ">";

const code = Array.from({ length: 40 }, (_, i) =>
  `${String(i + 1).padStart(3)}  ${["export function", "  const", "  return", "}", "// the run loop"][i % 5]} value_${i} = compute(${i});`).join("\n");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <div style={{ height: "100vh", background: "var(--bg)", color: "var(--fg-subtle)", fontFamily: "var(--font-mono)", fontSize: 12, whiteSpace: "pre", padding: 24, overflow: "hidden" }}>
    {code}
    <CommandPalette workspaceRoot={null} commands={commands} onOpenFile={noop} initialQuery={initialQuery} />
  </div>,
);
