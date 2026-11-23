import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { errMessage } from "../../errors";
import { machineRunChanges, machinesList, subscribeMachines, type Machine, type RemoteChanges } from "../../ipc/machines";
import { ChevronIcon, CloseIcon, MachineIcon, ReplayIcon } from "../../icons";
import { Z } from "../../zLayers";
import "./remoteRunControls.css";

export function RemoteRunChanges({ runId, machineId, connectionError }: { runId?: string; machineId: string; connectionError?: string | null }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [machine, setMachine] = useState<Machine | null>(null);
  const [changes, setChanges] = useState<RemoteChanges | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState({ left: 16, bottom: 50, width: 600 });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const request = useRef(0);
  const panelId = useId();
  useEffect(() => {
    let live = true;
    let revision = 0;
    const reload = () => {
      const current = ++revision;
      void machinesList().then((list) => { if (live && current === revision) setMachine(list.find((item) => item.id === machineId) ?? null); }).catch(() => {});
    };
    reload();
    const unsubscribe = subscribeMachines(reload);
    return () => { live = false; unsubscribe(); ++request.current; };
  }, [machineId]);
  useEffect(() => {
    if (!open) return;
    const close = () => { setOpen(false); trigger.current?.focus(); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); close(); } };
    const outside = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false); };
    panel.current?.focus();
    document.addEventListener("keydown", key);
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", close);
    return () => { document.removeEventListener("keydown", key); document.removeEventListener("pointerdown", outside); window.removeEventListener("resize", close); };
  }, [open]);
  async function refresh() {
    if (!runId) return;
    const current = ++request.current;
    setLoading(true); setError(null);
    try { const result = await machineRunChanges(runId); if (current === request.current) setChanges(result); }
    catch (reason) { if (current === request.current) setError(errMessage(reason)); }
    finally { if (current === request.current) setLoading(false); }
  }
  const label = machine?.label?.trim() || machine?.sshHost || "Remote machine";
  return <div className="klide-remote-controls" aria-label="Remote task">
    <span className="klide-remote-controls-machine" title={connectionError || (machine?.sshHost ? `Runs on ${machine.sshHost}. Keeps going when this Mac sleeps.` : "Runs on a remote machine.")}>
      <MachineIcon size={13} /><span>{label}</span>
      {connectionError && <span role="status" className="klide-remote-reconnecting">Reconnecting…</span>}
    </span>
    {runId && <button ref={trigger} type="button" className="klide-remote-changes-trigger" aria-expanded={open} aria-controls={open ? panelId : undefined} aria-haspopup="dialog" onClick={() => {
      if (open) { setOpen(false); return; }
      const rect = trigger.current!.getBoundingClientRect();
      const width = Math.min(600, window.innerWidth - 32);
      setPosition({ width, left: Math.max(16, Math.min(rect.right - width, window.innerWidth - width - 16)), bottom: window.innerHeight - rect.top + 8 });
      setOpen(true); void refresh();
    }}>View changes<ChevronIcon size={11} open={open} /></button>}
    {open && createPortal(<div ref={panel} id={panelId} role="dialog" aria-label="Remote changes" tabIndex={-1} className="klide-remote-changes-panel" style={{ ...position, zIndex: Z.popover }}>
      <header><div><strong>Changes</strong><span>{label}</span></div><div>
        <button type="button" aria-label="Refresh remote changes" title="Refresh" disabled={loading} onClick={() => { void refresh(); }}><ReplayIcon size={15} /></button>
        <button type="button" aria-label="Close remote changes" onClick={() => { setOpen(false); trigger.current?.focus(); }}><CloseIcon size={15} /></button>
      </div></header>
      {loading && <p role="status">Reading changes…</p>}
      {error && <p role="alert">{error}</p>}
      {changes && <>
        {changes.diff || changes.status ? <pre>{changes.diff || "No tracked changes."}{changes.status ? `\nWorking tree\n${changes.status}` : ""}</pre> : <div className="klide-remote-changes-empty"><strong>No changes yet</strong><p>Edits from this task will appear here.</p></div>}
        <details><summary><ChevronIcon size={11} />Working folder</summary><code>{changes.worktree}</code></details>
      </>}
    </div>, document.body)}
  </div>;
}
