import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { errMessage } from "../../errors";

type Changes = { diff: string; status: string; worktree: string };

export function RemoteRunChanges({ runId }: { runId: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [changes, setChanges] = useState<Changes | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function refresh() {
    setLoading(true); setError(null);
    try { setChanges(await invoke<Changes>("machine_run_changes", { runId })); }
    catch (reason) { setError(errMessage(reason)); }
    finally { setLoading(false); }
  }
  return <div style={{ padding: "4px 12px", fontSize: 12 }}>
    <button type="button" className="klide-button klide-button-ghost" aria-expanded={open} onClick={() => {
      setOpen(!open); if (!open) void refresh();
    }}>{open ? "Hide remote changes" : "Remote changes"}</button>
    {open && <div style={{ border: "1px solid var(--border)", borderRadius: 12, padding: 12, marginTop: 8 }}>
      {loading && <span role="status">Reading remote changes…</span>}
      {error && <p role="alert">{error}</p>}
      {changes && <>
        <p style={{ overflowWrap: "anywhere", color: "var(--fg-subtle)" }}>{changes.worktree}</p>
        <pre style={{ maxHeight: 240, overflow: "auto", fontSize: 11, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{changes.diff || "No tracked changes since this task started."}{changes.status ? `\nWorking tree:\n${changes.status}` : ""}</pre>
        <button type="button" className="klide-button klide-button-ghost" disabled={loading} onClick={() => { void refresh(); }}>Refresh</button>
      </>}
    </div>}
  </div>;
}
