// Throwaway page for Mission Control, without launching Tauri.
//
// The real MissionControl over a mocked IPC: a handful of Harness and
// Delegate runs across states. Anything else answers null.
//
//   npm run dev  →  http://localhost:1420/preview/mission-control.html
//   ?theme=dark | klide-light | …
import ReactDOM from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "@fontsource/monaspace-neon/400.css";
import "@fontsource/monaspace-neon/700.css";
import "../src/styles/tokens.css";
import { MissionControl } from "../src/components/MissionControl";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") ?? "klide-light";
document.documentElement.dataset.theme = theme;

const now = Date.now();
const run = (id: string, source: string, title: string, status: string, ago: number, extra: Record<string, unknown> = {}) => ({
  id, path: `/fixture/.klide/runs/${id}.jsonl`, source, title, status, model: null, cwd: "/fixture", project: "KIDE",
  gitBranch: "main", createdMs: now - ago - 600000, updatedMs: now - ago, messageCount: 12, inputTokens: 42000, outputTokens: 3100,
  ...extra,
});
const klideRuns = [
  run("r1", "klide", "Hide the status bar under Mission Control", "running", 20000, { provider: "anthropic", model: "claude-opus-5-5" }),
  run("r2", "klide", "Fix the worker capacity queue", "waiting_for_diff", 300000, { provider: "openrouter", model: "mistralai/mistral-medium" }),
  run("r3", "klide", "Summarize the coordination journal", "done", 3600000, { provider: "ollama", model: "llama3.1:8b", filesTouched: 3 }),
  run("r4", "klide", "Port the graph density zoom", "error", 7200000, { provider: "openai", model: "gpt-5" }),
];
const cliRuns = [
  run("c1", "claude-code", "Review PR #363 omp subagents", "done", 900000, { model: "claude-sonnet-5-5", costUsd: 0.42 }),
  run("c2", "codex", "Cancel workers independently", "done", 5400000, { model: "gpt-5-codex" }),
  run("c3", "opencode", "Stream OpenCode events", "cancelled", 86400000, { model: "openrouter/qwen3" }),
  run("c4", "omp", "Port the omp task tray", "done", 90000000, { model: "claude-sonnet-5-5" }),
  run("c5", "copilot", "Copilot effort levels", "done", 95000000, { model: "gpt-5" }),
];
const replies: Record<string, unknown> = {
  agent_list_runs: klideRuns,
  list_agent_runs: cliRuns,
  delegate_pty_live_sessions: [],
  read_agent_run: [
    { role: "user", text: "Hide the bottom bar under Mission Control.", ts: now - 600000 },
    { role: "assistant", text: "Done — `showsStatusBar` now leaves out the runs view.", ts: now - 500000 },
  ],
};
(window as any).__TAURI_INTERNALS__ = {
  // Unknown list-shaped commands answer an empty list; everything else null.
  invoke: async (cmd: string) => (cmd in replies ? replies[cmd] : /list|sessions|runs/.test(cmd) ? [] : null),
  transformCallback: () => 0,
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <div style={{ height: "100vh", display: "flex", background: "var(--bg)" }}>
    <MissionControl workspaceRoot="/fixture" theme={theme as never} initialSelectedRunId={params.get("select")} onOpenInAiPanel={(o) => console.log("open", o)} onForkRun={() => {}} onForkRunInWorktree={() => {}} onContinueRunInFocus={() => {}} onSaveMemory={() => {}} onResumeKlideRun={() => {}} />
  </div>
);
