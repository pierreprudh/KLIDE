// The shipping activity row, with simulated workers. The preview's IPC stub
// only accepts its own IDs; no real Run is started or stopped here.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "@fontsource/monaspace-neon/400.css";
import "../src/styles/tokens.css";
import { SubagentWatchLine } from "../src/components/ai/SubagentWatcher";
import { neverStarted, type SubagentActivity } from "../src/components/ai/subagentWatch";
import { ProviderLogo } from "../src/components/ai/icons";

document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") ?? "dark";
const cancels = new Map<string, () => void>();
Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {
  invoke: async (command: string, args: { runId?: string }) => {
    const cancel = args.runId && cancels.get(args.runId);
    if (command !== "agent_abort_run" || !cancel) throw new Error("Only simulated workers can be cancelled in this preview.");
    cancel();
  },
} });

function Example({ id, provider, task, stage }: { id: string; provider: "codex" | "claude-code"; task: string; stage?: string }) {
  const [cancelled, setCancelled] = useState(false);
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    cancels.set(id, () => { timer = setTimeout(() => setCancelled(true), 600); });
    return () => { cancels.delete(id); clearTimeout(timer); };
  }, [id]);
  const activity: SubagentActivity = cancelled ? neverStarted("Cancelled by you.") : {
    status: stage ? "starting" : "working", startedMs: Date.now() - 38_000,
    steps: stage ? 0 : 4, turns: 1, tokens: stage ? 0 : 370,
    current: stage ? null : { name: "read_file", detail: "src/time.ts" }, pendingPermission: null,
  };
  return (
    <section style={{ padding: "20px 0", borderBottom: "1px solid var(--border)" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
        <ProviderLogo id={provider} size={14} />
        <span style={{ fontWeight: 500, color: "var(--fg-strong)" }}>{provider === "codex" ? "Codex" : "Claude Code"}</span>
        <span style={{ color: "var(--fg-subtle)", fontSize: 12 }}>implementer</span>
      </div>
      <div style={{ margin: "10px 0 0 7px", padding: "1px 0 2px 18px", borderLeft: "1px solid var(--border)" }}>
        <div style={{ fontSize: 13 }}>{task}</div>
        <SubagentWatchLine runId={id} activity={activity} stage={stage} open={opened} onToggle={() => setOpened(!opened)} hasRows={!stage} />
        {cancelled && <div style={{ marginTop: 6, fontSize: 12, color: "var(--fg-dim)" }}>Worktree kept for review or discard.</div>}
      </div>
    </section>
  );
}

createRoot(document.getElementById("root")!).render(
  <main style={{ minHeight: "100vh", padding: "32px 24px", background: "var(--bg)", color: "var(--fg)", fontFamily: "var(--font-ui)" }}>
    <div style={{ maxWidth: 660, margin: "0 auto" }}>
      <p style={{ margin: "0 0 8px", fontSize: 13, color: "var(--fg-subtle)", lineHeight: 1.5 }}>Each worker has its own Cancel button. Try one — the other workers keep going.</p>
      <Example id="preview-worker-setup" provider="codex" task="Prepare the dependency update" stage="Running setup…" />
      <Example id="preview-worker-running" provider="claude-code" task="Add the slug helper" />
      <Example id="preview-worker-queued" provider="codex" task="Check the implementation" stage="Queued behind 4 running API workers" />
      <p style={{ marginTop: 20, fontSize: 11, color: "var(--fg-dim)" }}>Interactive preview · simulated workers</p>
    </div>
  </main>,
);
