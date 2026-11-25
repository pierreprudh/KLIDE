// Throwaway page for the Watch CI row in Mission Control › Scheduled.
//   http://localhost:1420/preview/ci-watch.html   ?theme=dark   ?state=off
//   ?select=__klide-bot__ for the klide-bot trigger
import ReactDOM from "react-dom/client";
import "../src/styles/tokens.css";
import "../src/components/scheduled.css";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "klide-light";
const OFF = params.get("state") === "off";
const now = Date.now();
const fired = (n: number, title: string, checks: string[], ago: number, error: string | null = null) => ({
  key: `k${n}`, workspaceRoot: "/Users/pierre/KLIDE", prNumber: n, prTitle: title, prUrl: "", checks,
  provider: n === 548 ? "openrouter" : "anthropic", model: n === 548 ? "deepseek/deepseek-v4.1-flash-1017" : "claude-sonnet-5-5", runId: error ? null : `run_${n}`, error, at: now - ago, announced: true,
});
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  transformCallback: (cb: unknown) => cb,
  invoke: async (cmd: string) => cmd === "list_provider_models" || cmd === "ai_list_models" ? ["claude-sonnet-5-5", "claude-opus-5-5"] : cmd === "ci_watch_get" ? (OFF
    ? { enabled: false, provider: null, model: null, enabledAt: null, lastPollAt: null, lastError: null, fired: [] }
    : { enabled: true, provider: "anthropic", model: "claude-sonnet-5-5", enabledAt: now - 3600e3, lastPollAt: now - 50e3, lastError: null,
        fired: [fired(552, "Pin dependency audit to high", ["Frontend tests and build"], 4 * 60e3), fired(548, "Rail: hold agent groups", ["Rust tests", "Rust on windows-latest", "build (windows-2025)"], 3 * 3600e3), fired(541, "Sandbox network card", ["Review"], 26 * 3600e3, "Add an Anthropic key in Settings")] }) : [],
};
const sched = (id: string, name: string, interval: number | null) => ({ id, revision: 1, target: { kind: "local" }, name, runId: null, activeRunId: null, text: "Review open TODOs and summarize", provider: "claude-code", model: "default", mode: "plan", workspaceRoot: "/Users/pierre/KLIDE", dueAt: now + 3600e3, intervalMs: interval, status: "pending", error: null });
const realInvoke = (window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__.invoke;
(window as unknown as { __TAURI_INTERNALS__: { invoke: unknown } }).__TAURI_INTERNALS__.invoke = async (cmd: string, args: unknown) => {
  if (cmd === "agent_schedule_list") return [sched("a", "Morning triage", 86_400_000), sched("b", "Weekly dependency check", 604_800_000)];
  if (cmd === "agent_schedule_service_status") return { supported: true, installed: true, running: true, compatible: true, pid: 1, error: null };
  if (cmd === "agent_schedule_history") return [];
  if (cmd === "klide_bot_mentions") {
    if (params.get("mentions") === "error") throw new Error("GitHub is unavailable. Check your connection and retry.");
    if (params.get("mentions") === "loading") return new Promise(() => {});
    if (params.get("mentions") === "empty") return [];
    return [
      { workspaceRoot: "/Users/pierre/KLIDE", repo: "pierreprudh/KLIDE", prNumber: 603, commentId: 4, commentUrl: "https://github.com/pierreprudh/KLIDE/pull/603#issuecomment-4", author: "github-actions[bot]", body: "<!-- klide-review --> verdict=pass sha=abc\n**Review** · model\n\nReview complete. No blocking issues found.\n\nVERDICT: PASS", at: now - 30_000, kind: "review", verdict: "pass" },
      { workspaceRoot: "/Users/pierre/KLIDE", repo: "pierreprudh/KLIDE", prNumber: 603, commentId: 3, commentUrl: "https://github.com/pierreprudh/KLIDE/pull/603#issuecomment-3", author: "pierreprudh", body: "/review", at: now - 60_000, kind: "review_request" },
      { workspaceRoot: "/Users/pierre/KLIDE", repo: "pierreprudh/KLIDE", prNumber: 603, commentId: 5, commentUrl: "https://github.com/pierreprudh/KLIDE/pull/603#issuecomment-5", author: "klide-bot[bot]", body: "<!-- klide-bot -->\nYes, the existing worktree is reused.", at: now - 90_000, kind: "reply" },
      { workspaceRoot: "/Users/pierre/KLIDE", repo: "pierreprudh/KLIDE", prNumber: 603, commentId: 1, commentUrl: "https://github.com/pierreprudh/KLIDE/pull/603#issuecomment-1", author: "pierreprudh", body: "@klide-bot does Look into it reuse the same worktree if I click twice?", at: now - 120_000 },
      { workspaceRoot: "/Users/pierre/KLIDE", repo: "pierreprudh/KLIDE", prNumber: 597, commentId: 2, commentUrl: "https://github.com/pierreprudh/KLIDE/pull/597#issuecomment-2", author: "pierreprudh", body: "@klide-bot explain this pull request in three simple bullet points and tell me the riskiest part.", at: now - 3_600_000 },
    ];
  }
  // klide-bot (`?select=__klide-bot__`; `?bot=nokey` shows the missing-key state).
  if (cmd === "klide_bot_settings" || cmd === "klide_bot_set_model") return {
    repo: "pierreprudh/KLIDE", answerInstalled: true, reviewInstalled: true,
    answerModel: "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free", reviewModel: params.get("bot") === "nokey" ? null : "openrouter/deepseek/deepseek-v4.1-flash",
    keyedProviders: params.get("bot") === "nokey" ? [] : ["openrouter"], appIdentity: true,
  };
  if (cmd === "agent_read_run") {
    const id = (args as { runId: string }).runId;
    if (id === "run_548") return [{ type: "user_message", text: "CI failed" }];
    return [{ type: "user_message", text: "CI failed" }, { type: "assistant_message", runId: id, messageId: "m", content: [{ type: "text", text: "## Cause\n\nThe audit step pins `npm audit` to **high**, but two moderate advisories fail the build. Raise the threshold or update `vite`.\n\n## Fix\n…" }] }, { type: "run_result", runId: id, ts: 1 }];
  }
  return realInvoke(cmd, args);
};
const { registerCiFixOpener } = await import("../src/ciFixNavigation");
registerCiFixOpener(() => {});
const { registerKlideBotOpener } = await import("../src/klideBotNavigation");
registerKlideBotOpener(async () => {
  (window as unknown as { __mentionOpened: boolean }).__mentionOpened = true;
});
const { Scheduled } = await import("../src/components/Scheduled");
const { CI_WATCH_ID } = await import("../src/components/missionControl/ciWatch");
ReactDOM.createRoot(document.getElementById("root")!).render(
  <div style={{ height: "100vh", display: "flex", background: "var(--bg-panel)" }}>
    <Scheduled workspaceRoot="/Users/pierre/KLIDE" defaultProvider="anthropic" defaultModel="claude-sonnet-5-5" harnessSettings={{} as never}
      initialSelectedId={params.get("select") ?? CI_WATCH_ID} onShowRuns={() => {}} onOpenRun={() => {}} />
  </div>,
);
