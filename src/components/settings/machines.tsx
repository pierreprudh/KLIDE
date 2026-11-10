import { useEffect, useId, useRef, useState } from "react";
import { machineCheck, machineLabel, machineRemove, machineSave, machinesList, type Machine, type MachineStatus } from "../../ipc/machines";
import { errMessage } from "../../errors";
import { refreshMachineStatus } from "../../machineStatus";
import { GhostButton, SettingBlock } from "./controls";
import { MachineIcon, TailscaleIcon, ThisMacIcon } from "../../icons";
import { CloudIcon } from "./icons";
import "./machines.css";

type ConnectionKind = "cloud" | "self-hosted" | "tailscale";

function MachineDetails({ machine, workspaceRoot, onEdit, onRemove, disabled }: {
  machine: Machine; workspaceRoot: string | null; onEdit: () => void;
  onRemove: () => Promise<void>; disabled: boolean;
}) {
  const [status, setStatus] = useState<MachineStatus | null>(null);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsId = useId();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let live = true;
    setChecking(true);
    setError("");
    machineCheck(machine.id, workspaceRoot)
      .then((value) => { if (live) setStatus(value); })
      .catch((reason) => { if (live) setError(errMessage(reason)); })
      .finally(() => { if (live) setChecking(false); });
    return () => { live = false; };
  }, [machine.id, workspaceRoot, revision]);
  const caption = error || (checking ? "Checking…" : status?.ready ? "Ready" : status?.caption ?? "Not checked");
  return <article className="klide-machine-entry">
    <div className="klide-machine-row">
      <span className="klide-machine-glyph"><MachineIcon size={20} /></span>
      <div className="klide-machine-name"><h3>{machineLabel(machine)}</h3><code>{machine.sshHost}</code></div>
      <span className="klide-machine-state" data-tone={error ? "bad" : checking ? "quiet" : status?.ready ? "ok" : "warn"} role="status">{caption}</span>
      <div className="klide-machine-row-actions">
        <button type="button" className="klide-button klide-button-ghost" aria-expanded={detailsOpen} aria-controls={detailsId} onClick={() => setDetailsOpen((open) => !open)}>{detailsOpen ? "Hide details" : "Details"}</button>
        <GhostButton disabled={disabled} onClick={onEdit}>Edit</GhostButton>
      </div>
    </div>
    <div id={detailsId} hidden={!detailsOpen} className="klide-machine-details">
      <div className="klide-machine-details-body">
        <div className="klide-machine-detail-heading"><span>SSH · Claude Code</span><GhostButton disabled={checking || disabled} onClick={() => { setRevision((r) => r + 1); refreshMachineStatus(machine.id, workspaceRoot, { force: true }); }}>{checking ? "Checking…" : "Check connection"}</GhostButton></div>
        {error && <p role="alert">{error}</p>}
        {!checking && !error && status?.facts.map((fact) => <div className="klide-machine-fact" key={fact.label}>
          <span>{fact.label}</span><span data-tone={fact.tone}>{fact.value}</span>
          {fact.fix && <div className="klide-machine-fix"><code>{fact.fix}</code><GhostButton onClick={() => { void navigator.clipboard.writeText(fact.fix!).catch((reason) => setError(errMessage(reason))); }}>Copy fix</GhostButton></div>}
        </div>)}
        {status?.checkout && <div className="klide-machine-fact"><span>Remote checkout</span><code>{status.checkout}</code></div>}
        <div className="klide-machine-remove"><GhostButton disabled={disabled} onClick={() => setConfirmRemove(true)}>Remove</GhostButton></div>
        {confirmRemove && <div className="klide-machine-confirm" role="alert">
          Remove this machine from Klide? Remote files and running sessions stay there. Re-add ID <code>{machine.id}</code> to reconnect existing conversations.
          <div className="klide-machine-actions"><GhostButton disabled={disabled} onClick={() => { void onRemove(); }}>Remove machine</GhostButton><GhostButton disabled={disabled} onClick={() => setConfirmRemove(false)}>Cancel</GhostButton></div>
        </div>}
      </div>
    </div>
  </article>;
}

function MachineEditor({ machine, workspaceRoot, onSave, onCancel, busy, connection }: {
  machine: Machine | null; workspaceRoot: string | null; connection: ConnectionKind;
  onSave: (machine: Machine, creating: boolean) => Promise<void>; onCancel: () => void; busy: boolean;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => { formRef.current?.scrollIntoView({ block: "nearest" }); }, []);
  const [id, setId] = useState(machine?.id ?? "");
  const [label, setLabel] = useState(machine?.label ?? "");
  const [host, setHost] = useState(machine?.sshHost ?? "");
  const [checkout, setCheckout] = useState(workspaceRoot ? machine?.checkouts?.[workspaceRoot] ?? "" : "");
  return <SettingBlock title={machine ? "Edit machine" : "Add machine"}>
    <form ref={formRef} className="klide-machine-form" onSubmit={(event) => {
      event.preventDefault();
      const checkouts = { ...machine?.checkouts };
      if (workspaceRoot) {
        if (checkout.trim()) checkouts[workspaceRoot] = checkout.trim();
        else delete checkouts[workspaceRoot];
      }
      void onSave({ id: id.trim(), label: label.trim() || undefined, sshHost: host.trim(), checkouts }, !machine);
    }}>
      {!machine && <div className="klide-machine-form-context">{connection === "tailscale" ? <><TailscaleIcon size={22} /><span>Connect over Tailscale</span></> : connection === "cloud" ? <><CloudIcon /><span>Connect a cloud machine</span></> : <><MachineIcon size={22} /><span>Connect a self-hosted machine</span></>}</div>}
      <label>Machine ID<input className="klide-field" style={{ display: "block", width: "100%" }} required pattern="[A-Za-z0-9_-]+" disabled={!!machine || busy} value={id} onChange={(e) => setId(e.target.value)} placeholder="my-server" /></label>
      <label>Display name<input className="klide-field" style={{ display: "block", width: "100%" }} disabled={busy} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="My server" /></label>
      <label>{connection === "tailscale" ? "Tailscale SSH address" : "SSH host"}<input className="klide-field" style={{ display: "block", width: "100%" }} required disabled={busy} value={host} onChange={(e) => setHost(e.target.value)} placeholder={connection === "tailscale" ? "user@100.64.1.2 or user@machine-name" : "my-server or user@hostname"} /></label>
      {connection === "tailscale" && <p className="klide-machine-hint">Connect this Mac and the remote machine to your Tailscale network, then enter the machine’s Tailscale IP or name. Klide connects using SSH.</p>}
      <p className="klide-machine-hint">Use an SSH alias from ~/.ssh/config to configure ports and keys. Connect once from Terminal to accept the machine’s host key. Klide uses your existing SSH authentication.</p>
      {workspaceRoot ? <label>Remote checkout for {workspaceRoot}<input className="klide-field" style={{ display: "block", width: "100%" }} disabled={busy} value={checkout} onChange={(e) => setCheckout(e.target.value)} placeholder={`~/code/${workspaceRoot.split("/").filter(Boolean).pop()}`} /><span>Leave blank to use ~/code/&lt;workspace name&gt;. Clone the repository on the machine first.</span></label> : <p>Open a workspace to configure its remote checkout.</p>}
      <div style={{ display: "flex", gap: 8 }}><button type="submit" className="klide-button klide-button-secondary" disabled={busy}>{busy ? "Saving…" : "Save machine"}</button><GhostButton disabled={busy} onClick={onCancel}>Cancel</GhostButton></div>
    </form>
  </SettingBlock>;
}

export function MachinesSection({ workspaceRoot }: { workspaceRoot: string | null }) {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Machine | null | undefined>(undefined);
  const [reload, setReload] = useState(0);
  const [connection, setConnection] = useState<ConnectionKind>("cloud");
  const cannotAdd = loading || busy || editing !== undefined || !!error;
  function add(kind: ConnectionKind) { setConnection(kind); setEditing(null); }
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError("");
    machinesList().then((list) => { if (live) setMachines(list); })
      .catch((reason) => { if (live) setError(errMessage(reason)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [reload]);
  async function save(machine: Machine, creating: boolean) {
    setBusy(true); setError("");
    try {
      setMachines(await machineSave(machine, creating));
      refreshMachineStatus(machine.id, workspaceRoot, { force: true });
      setEditing(undefined);
    } catch (reason) { setError(errMessage(reason)); }
    finally { setBusy(false); }
  }
  async function remove(id: string) {
    setBusy(true); setError("");
    try { setMachines(await machineRemove(id)); }
    catch (reason) { setError(errMessage(reason)); }
    finally { setBusy(false); }
  }
  return <div className="klide-machines">
    <SettingBlock title="Your machines" action={<GhostButton disabled={cannotAdd} onClick={() => add("cloud")}>Add machine</GhostButton>}>
      <p className="klide-machine-intro">Choose where your agents work. Your files and logins stay on each machine.</p>
      <div className="klide-machine-list">
        <div className="klide-machine-row klide-machine-local">
          <span className="klide-machine-glyph"><ThisMacIcon size={20} /></span>
          <div className="klide-machine-name"><h3>This Mac</h3><span>Your local workspace</span></div>
          <span className="klide-machine-state" data-tone="quiet">Local</span>
        </div>
        {machines.map((machine) => <MachineDetails key={JSON.stringify(machine) + workspaceRoot} machine={machine} workspaceRoot={workspaceRoot} onEdit={() => { setConnection("cloud"); setEditing(machine); }} onRemove={() => remove(machine.id)} disabled={busy || editing !== undefined} />)}
        {loading && <p className="klide-machine-message" role="status">Loading machines…</p>}
        {!loading && !error && machines.length === 0 && <p className="klide-machine-message">No remote machines connected yet.</p>}
      </div>
      {error && <div className="klide-machine-confirm" role="alert">{error} <GhostButton disabled={busy || editing !== undefined} onClick={() => setReload((value) => value + 1)}>Reload</GhostButton></div>}
      <p className="klide-machine-footnote">Select a machine in “Where it runs” before starting a conversation. Remote runs use Claude Code.</p>
    </SettingBlock>

    <SettingBlock title="Connect a machine">
      <div className="klide-machine-options">
        <article className="klide-machine-option">
          <span className="klide-machine-option-icon"><CloudIcon /></span>
          <div className="klide-machine-option-copy"><h3>Cloud</h3><p>A Linux server from your cloud provider, ready when you need it.</p></div>
          <GhostButton disabled={cannotAdd} onClick={() => add("cloud")}>Connect</GhostButton>
        </article>
        <article className="klide-machine-option">
          <span className="klide-machine-option-icon"><MachineIcon size={26} /></span>
          <div className="klide-machine-option-copy"><h3>Self-hosted</h3><p>Your own Linux computer, home server, or machine on your network.</p></div>
          <GhostButton disabled={cannotAdd} onClick={() => add("self-hosted")}>Connect</GhostButton>
        </article>
      </div>
    </SettingBlock>

    <SettingBlock title="Private network · VPN">
      <article className="klide-machine-vpn">
        <div className="klide-machine-tailscale"><TailscaleIcon size={42} /></div>
        <div><h3>Tailscale</h3><p>Reach a cloud or self-hosted machine through your private network. Use its Tailscale IP or machine name as the SSH address.</p></div>
        <GhostButton disabled={cannotAdd} onClick={() => add("tailscale")}>Connect via Tailscale</GhostButton>
      </article>
    </SettingBlock>

    {editing !== undefined && <MachineEditor key={(editing?.id ?? "new") + workspaceRoot + connection} machine={editing} connection={connection} workspaceRoot={workspaceRoot} onSave={save} onCancel={() => { setEditing(undefined); setError(""); }} busy={busy} />}
  </div>;
}
