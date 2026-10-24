import React from "react";
import { createRoot } from "react-dom/client";
import { RunActivityTabs, type RunActivityView } from "../src/components/missionControl/RunActivityTabs";
import { RunTimeline } from "../src/components/missionControl/RunTimeline";
import type { AgentEvent } from "../src/agent/types";
import type { Run } from "../src/runs";
import "@fontsource/atkinson-hyperlegible/400.css";
import "../src/styles/tokens.css";

const events: AgentEvent[] = [
  { type: "run_started", runId: "preview", cwd: null, mode: "goal", provider: "anthropic", model: "claude-sonnet-4", ts: 1000 },
  { type: "assistant_message", runId: "preview", messageId: "m", content: [{ type: "text", text: "I’ll inspect the source and run the checks." }], timing: { modelMs: 1500 }, usage: { promptTokens: 6200, completionTokens: 450, cacheReadTokens: 4000, cacheWriteTokens: 1000, contextWindow: 32768, costUsd: 0.018 }, ts: 2500 },
  { type: "tool_call_started", runId: "preview", toolCallId: "a", name: "read_file", input: { path: "src/App.tsx" }, summary: "Read app source", ts: 2600 },
  { type: "tool_call_finished", runId: "preview", toolCallId: "a", result: { ok: true, content: "Source loaded." }, ts: 3300 },
  { type: "tool_call_started", runId: "preview", toolCallId: "b", name: "run_command", input: { command: "npm test" }, summary: "Run tests", ts: 3400 },
  { type: "permission_requested", runId: "preview", ts: 3450, request: { id: "approve", runId: "preview", toolCallId: "b", toolName: "run_command", input: { command: "npm test" }, summary: "Run tests", reason: "Command needs approval", options: [] } },
  { type: "permission_resolved", runId: "preview", ts: 4500, requestId: "approve", decision: { behavior: "allow", scope: "once" } },
  { type: "subagent_requested", runId: "preview", requestId: "w", subagent: "reviewer", task: "Review the implementation while the tests run.", ts: 3600 },
  { type: "tool_call_finished", runId: "preview", toolCallId: "b", result: { ok: false, content: "Test failed: expected status completed, received running." }, ts: 8500 },
  { type: "subagent_resolved", runId: "preview", requestId: "w", result: "Check interrupted run handling.", ts: 9200 },
];
events.push(
  { type: "context_snapshot", runId: "preview", ts: 1020, snapshot: { workspaceRoot: "/preview", estimatedTokens: 2400, attachments: [{ path: "README.md", content: "# Klide\nA small AI-first IDE." }], lensItems: [{ id: "app", path: "src/App.tsx", label: "App.tsx", detail: "The selected editor file and its surrounding code." }], omitted: [{ path: "package-lock.json", reason: "Exceeds context budget" }] } },
  { type: "context_injected", runId: "preview", role: "user", content: "The background test runner finished. Review its recorded output before making further changes.", ts: 8700 },
  { type: "assistant_message", runId: "preview", messageId: "followup", content: [{ type: "text", text: "I found the failing check and will revise the patch." }], timing: { modelMs: 600 }, usage: { promptTokens: 12400, completionTokens: 320, cacheReadTokens: 6200, costUsd: 0.024, contextWindow: 32768 }, ts: 9800 },
  { type: "context_compacted", runId: "preview", summary: "Keep the edited files, the failing check, and the reviewer's finding. The next response should fix interrupted-run handling.", kept: 4, contextTokens: 3800, costUsd: 0.002, ts: 10000 },
  { type: "assistant_message", runId: "preview", messageId: "final", content: [{ type: "text", text: "The check now passes." }], timing: { modelMs: 900 }, usage: { promptTokens: 4400, completionTokens: 180, cacheReadTokens: 0, costUsd: 0.009, contextWindow: 32768 }, ts: 12000 },
);
events.sort((a, b) => a.ts - b.ts);
Object.assign(window, { __TAURI_INTERNALS__: { invoke: async () => structuredClone(events) } });
const params = new URLSearchParams(location.search);
const previewModel = params.get("model");
if (previewModel) for (const event of events) {
  if (event.type === "run_started") { event.model = previewModel; event.provider = "openrouter"; }
}
const base = Date.UTC(2026, 9, 23, 8);
for (const event of events) event.ts += base;
if (params.has("history")) {
  const earlier = base - 1500 * 60_000;
  events.unshift(
    { type: "run_started", runId: "preview", cwd: null, mode: "goal", provider: "openai", model: "gpt-5", ts: earlier },
    { type: "assistant_message", runId: "preview", messageId: "earlier", content: [{ type: "text", text: "Earlier run completed." }], timing: { modelMs: 2000 }, ts: earlier + 2000 },
    { type: "run_error", runId: "preview", error: { code: "aborted", message: "Stopped", retryable: false }, ts: earlier + 3000 },
  );
}
document.documentElement.dataset.theme = params.get("theme") ?? "dark";
const run = { id: "preview", source: params.has("imported") ? "codex" : "klide", status: "done" } as Run;
function Preview() {
  const initial = params.get("view");
  const [view, setView] = React.useState<RunActivityView>(initial === "context" || initial === "usage" ? initial : "timeline");
  return <main style={{ maxWidth: params.has("narrow") ? 494 : 900, margin: "40px auto", padding: 24, color: "var(--fg)", fontFamily: "var(--font-ui)" }}>
    <h2 style={{ color: "var(--fg-strong)", fontWeight: 500 }}>Inspect a run</h2>
    <RunActivityTabs idPrefix="preview" value={view} onChange={setView} />
    <div role="tabpanel" id="preview-activity" aria-labelledby={`preview-${view}-tab`} tabIndex={0}>
      {view === "conversation" ? <p>Conversation preview. Select a trace to inspect its recorded evidence.</p> : <RunTimeline run={run} view={view} />}
    </div>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
