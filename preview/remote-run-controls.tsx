import { createRoot } from "react-dom/client";
import { RemoteRunChanges } from "../src/components/ai/RemoteRunChanges";
import "../src/styles/tokens.css";
const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") || "klide-light";
(window as any).__REMOTE_READS__ = 0;
(window as any).__TAURI_INTERNALS__ = { invoke: async (command: string) => {
  if (command === "machines_list") return [{ id: "machine-long-private-id", label: "Dev mini", sshHost: "dev@mini" }];
  if (command === "machine_run_changes") {
    (window as any).__REMOTE_READS__++;
    if (params.has("error")) throw new Error("The mini is offline. Reconnect to read changes.");
    return { diff: params.has("empty") ? "" : "diff --git a/app.ts b/app.ts\n--- a/app.ts\n+++ b/app.ts\n@@ -1 +1 @@\n-export const ready = false;\n+export const ready = true;", status: params.has("empty") ? "" : " M app.ts", worktree: "/Users/dev/.klide/run-host/worktrees/task-private-id" };
  }
  return null;
} };
createRoot(document.getElementById("root")!).render(<main style={{ minHeight: "100vh", background: "var(--bg)", display: "flex", alignItems: "flex-end", justifyContent: "center", padding: "32px 16px", boxSizing: "border-box" }}>
  <div style={{ width: 740, maxWidth: "100%" }}>
    <div style={{ padding: 20, border: "1px solid var(--border)", borderRadius: 20, background: "var(--bg-elevated)" }}><p style={{ color: "var(--fg-subtle)", margin: "0 0 25px" }}>Ask anything, @ to attach a file…</p><span style={{ fontSize: 12 }}>＋　Claude Code</span></div>
    <div className="klide-ai-conversation-status"><span className="klide-ai-local-branch">main</span><span className="klide-ai-mode-note">auto-accept edits</span><RemoteRunChanges machineId="machine-long-private-id" runId="task-example" connectionError={params.has("reconnecting") ? "Connection interrupted" : null}/></div>
  </div>
</main>);
