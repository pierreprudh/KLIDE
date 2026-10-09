import { MissionTaskEditor } from "../src/components/ai/MissionTaskEditor";
import { MissionLibrary } from "../src/components/missionControl/MissionLibrary";
// Browser-only interaction fixture; no worker runs or workspace writes.
import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "../src/styles/tokens.css";
import { MissionCard } from "../src/components/ai/MissionCard";
import type { DurableMissionBundle, DurableMissionTaskDispatch } from "../src/agent/durableMissions";
const route: DurableMissionTaskDispatch = { workerKind: "harness", provider: "ollama", model: "llama3.1:8b", requireDiffReview: true };
const bundle: DurableMissionBundle = {
  mission: { schemaVersion: 1, id: "preview", title: "Move orchestration into the conversation", intent: "Keep the plan close to the work", mode: "goal", taskIds: ["edit", "verify"], createdMs: 1, updatedMs: 1 },
  tasks: ["edit", "verify"].map((id, i) => ({ schemaVersion: 1, id, missionId: "preview", title: i ? "Verify the Mission flow" : "Edit the task card", bodyMarkdown: "Make the plan editable in the conversation and verify worker recovery.", phase: i ? "Verify" : "Build", mode: "goal", risk: "medium", writesFiles: !i, dependencies: i ? ["edit"] : [], acceptanceCriteria: ["The task can be inspected and verified"], needsRepoWideContext: false, needsStrongReasoning: false, needsDelegateCli: false, needsVisualReview: false, createdMs: 1, updatedMs: 1 })),
  events: [{ schemaVersion: 1, missionId: "preview", seq: 1, ts: 1, event: { type: "mission_created" } }],
};
const append = (event: DurableMissionBundle["events"][number]["event"]) => bundle.events.push({ schemaVersion: 1, missionId: "preview", seq: bundle.events.length + 1, ts: Date.now(), event });
bundle.mission.coordinatorRunId = "preview-planner";
if (new URLSearchParams(location.search).get("state") === "completed") {
  bundle.tasks.forEach((task, i) => {
    task.dispatch = { workerKind: "harness", provider: "anthropic", model: "claude-sonnet-4", requireDiffReview: false };
    append({ type: "attempt_attached", taskId: task.id, runId: `worker-${i}` });
    append({ type: "attempt_validation_recorded", taskId: task.id, runId: `worker-${i}`, accepted: true, validation: { status: "skipped", checks: [], filesChanged: 0, commandsRun: 0, commandsFailed: 0, diffReviews: 0, permissionsApproved: 0, permissionsDenied: 0, warnings: [] } });
  });
  append({ type: "plan_approved" });
  append({ type: "mission_completed" });
  bundle.report = { completedMs: Date.now(), markdown: "## Mission completed: Read app name and README heading\n\n### Read package.json\n\nApp name: **klide**\n\nWorker: `worker-0` · anthropic / claude-sonnet-4\n\nVerification: skipped · 0 files changed · 0 commands run · 0 failed.\n\n### Read README.md\n\nFirst heading: `# Klide`\n\nWorker: `worker-1` · anthropic / claude-sonnet-4\n\nVerification: skipped · 0 files changed · 0 commands run · 0 failed." };
}
const state = new URLSearchParams(location.search).get("state");
if (state === "parked") {
  append({ type: "plan_approved" }); bundle.tasks.forEach((task) => { task.dispatch = route; });
  append({ type: "attempt_attached", taskId: "edit", runId: "worker-preview" });
  append({ type: "attempt_dispatch_failed", taskId: "edit", runId: "worker-preview", message: "Preview failure" });
  append({ type: "mission_parked", reason: "Worker failed — retry explicitly" });
}
Object.assign(window, { __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, any>) => {
  if (command === "mission_list") return structuredClone([bundle]);
  if (command === "custom_provider_list" || command === "ai_provider_model_meta") return [];
  if (command === "ai_list_models") return ["llama3.1:8b", "qwen3:8b"];
  if (command === "mission_save_task") { bundle.tasks = bundle.tasks.map((task) => task.id === args.input.id ? { ...task, ...args.input, updatedMs: Date.now() } : task); append({ type: "task_updated", taskId: args.input.id }); return structuredClone(bundle); }
  if (command === "mission_approve") { bundle.tasks.forEach((task) => { task.dispatch = args.input.tasks.find((dispatch: any) => dispatch.taskId === task.id); }); append({ type: "plan_approved" }); append({ type: "mission_parked", reason: "Preview — no workers launched" }); return structuredClone(bundle); }
  if (command === "mission_set_policy") { bundle.tasks.forEach((task) => { if (task.dispatch) { task.dispatch.requireDiffReview = args.requireDiffReview; task.dispatch.autoApproveCommands = args.autoApproveCommands; } }); append({ type: "task_updated", taskId: "edit" }); return structuredClone(bundle); }
  if (command === "mission_request_task") { append({ type: "attempt_attached", taskId: args.taskId, runId: "retried-preview" }); append({ type: "attempt_dispatch_failed", taskId: args.taskId, runId: "retried-preview", message: "Preview only" }); append({ type: "mission_parked", reason: "Retry recorded" }); return structuredClone(bundle); }
  throw new Error(`Preview does not implement ${command}`);
} } });
document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") ?? "dark";
const sidePreview = new URLSearchParams(location.search).get("view") === "side";
createRoot(document.getElementById("root")!).render(<main style={{ padding: 24, maxWidth: sidePreview ? 320 : 560, margin: "auto", fontFamily: "var(--font-ui)", color: "var(--fg-strong)" }}>{new URLSearchParams(location.search).get("view") === "form" ? <MissionTaskEditor task={bundle.tasks[0]} tasks={bundle.tasks} route={route} busy={false} onSave={async () => {}} onRoute={() => {}} onDirty={() => {}} /> : sidePreview ? <MissionLibrary workspaceRoot="/preview" coordinatorRunId="preview-planner" onOpenRun={(id) => alert(`Open worker: ${id}`)} /> : <MissionCard workspaceRoot="/preview" receipt={{ missionId: "preview", title: bundle.mission.title, route }} onOpenRun={(id) => alert(`Open worker: ${id}`)} />}</main>);
