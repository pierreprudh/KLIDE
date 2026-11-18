// Throwaway page for the Watch CI row in Mission Control › Scheduled.
//   http://localhost:1420/preview/ci-watch.html   ?theme=dark   ?state=off
import ReactDOM from "react-dom/client";
import "../src/styles/tokens.css";
import "../src/components/scheduled.css";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "klide-light";
const OFF = params.get("state") === "off";
const now = Date.now();
const fired = (n: number, title: string, checks: string[], ago: number, error: string | null = null) => ({
  key: `k${n}`, workspaceRoot: "/Users/pierre/KLIDE", prNumber: n, prTitle: title, prUrl: "", checks,
  provider: "anthropic", model: "claude-sonnet-5-5", runId: error ? null : `run_${n}`, error, at: now - ago, announced: true,
});
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  transformCallback: (cb: unknown) => cb,
  invoke: async (cmd: string) => cmd === "list_provider_models" || cmd === "ai_list_models" ? ["claude-sonnet-5-5", "claude-opus-5-5"] : cmd === "ci_watch_get" ? (OFF
    ? { enabled: false, provider: null, model: null, enabledAt: null, lastPollAt: null, lastError: null, fired: [] }
    : { enabled: true, provider: "anthropic", model: "claude-sonnet-5-5", enabledAt: now - 3600e3, lastPollAt: now - 50e3, lastError: null,
        fired: [fired(552, "Pin dependency audit to high", ["Frontend tests and build"], 4 * 60e3), fired(548, "Rail: hold agent groups", ["Rust tests", "Rust on windows-latest"], 3 * 3600e3), fired(541, "Sandbox network card", ["Review"], 26 * 3600e3, "Add an Anthropic key in Settings")] }) : [],
};
const { CiWatchBar } = await import("../src/components/missionControl/CiWatchBar");
ReactDOM.createRoot(document.getElementById("root")!).render(
  <div className="scheduled-page" style={{ background: "var(--bg-panel)", minHeight: "100vh", paddingTop: 16 }}>
    <CiWatchBar workspaceRoot="/Users/pierre/KLIDE" provider="anthropic" model="claude-sonnet-5-5" settings={{} as never} onOpenRun={() => {}} />
  </div>,
);
