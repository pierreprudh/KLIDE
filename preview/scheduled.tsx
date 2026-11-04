// Real Scheduled surface over isolated IPC fixtures. No service or real task.
// npm run dev → /preview/scheduled.html?theme=klide-light
import ReactDOM from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "../src/styles/tokens.css";
import { Scheduled } from "../src/components/Scheduled";
import type { Schedule } from "../src/agent/schedules";
import type { toStartRunRequest } from "../src/agent/client";
const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "klide-light";
let rows: Schedule[] = [];
mockIPC((command, payload) => {
  const args = (payload ?? {}) as Record<string, unknown>;
  if (command === "agent_schedule_list") return rows;
  if (command === "agent_schedule_service_status") return { supported: true, installed: true, running: true, compatible: true, pid: 1, error: null };
  if (command === "agent_schedule_create" || command === "agent_schedule_update") {
    const request = args.request as ReturnType<typeof toStartRunRequest>;
    const row: Schedule = { id: String(args.id ?? "fixture-schedule"), revision: 1, target: { kind: "local" }, name: String(args.name), text: request.initialText, provider: request.provider, model: request.model, mode: request.mode, workspaceRoot: request.workspaceRoot ?? null, dueAt: Number(args.dueAt), intervalMs: args.intervalMs as number | null, runId: null, activeRunId: null, status: "pending", error: null };
    rows = [row]; return row;
  }
  if (command === "ai_provider_models" || command === "harness_source_models") return ["gpt-5.4", "gpt-5.4-mini"];
  if (command === "harness_source_support") return { supported: true };
  if (command === "ai_subscription_status") return { installed: true, authenticated: true };
  if (command.includes("listen")) return 1;
  if (command.includes("read") && command.includes("file")) throw new Error("No project rules in this fixture");
  return [];
});
ReactDOM.createRoot(document.getElementById("root")!).render(<div style={{height:"100vh",display:"flex"}}><Scheduled workspaceRoot={params.has("no-workspace") ? null : "/fixture/klide"} defaultProvider="codex" defaultModel="gpt-5.4" harnessSettings={{}} onOpenRun={() => {}} /></div>);
