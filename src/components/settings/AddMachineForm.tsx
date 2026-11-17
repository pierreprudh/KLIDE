import { useEffect, useRef, useState } from "react";
import { machineCheck, machineInstallHost, machineSave, type Machine, type MachineStatus, type MachineConnectionMethod, type MachineCandidate } from "../../ipc/machines";
import { refreshMachineStatus } from "../../machineStatus";
import { errMessage } from "../../errors";
import { MachineConnectionPicker } from "./MachineConnectionPicker";
import { MachineSetup } from "./MachineSetup";
import { MachineSetupWaiting } from "./MachineSetupWaiting";
import { GhostButton } from "./controls";
import "./machines.css";

export default function AddMachineForm({ workspaceRoot, onClose, onSaved }: {
  workspaceRoot: string | null; onClose: () => void; onSaved?: (machines: Machine[]) => void;
}) {
  const [id] = useState(() => `machine-${crypto.randomUUID()}`);
  const [method, setMethod] = useState<MachineConnectionMethod | null>(null);
  const [enteringHost, setEnteringHost] = useState(false);
  const [host, setHost] = useState("");
  const [label, setLabel] = useState("");
  const [machine, setMachine] = useState<Machine | null>(null);
  const [status, setStatus] = useState<MachineStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (enteringHost) input.current?.focus(); }, [enteringHost]);
  useEffect(() => {
    if (!machine) return;
    let live = true;
    setChecking(true);
    setError("");
    machineCheck(machine.id, workspaceRoot)
      .then((next) => { if (live) setStatus(next); })
      .catch((reason) => { if (live) { setStatus(null); setError(errMessage(reason)); } })
      .finally(() => { if (live) setChecking(false); });
    return () => { live = false; };
  }, [machine, workspaceRoot, revision]);

  function choose(candidate: MachineCandidate) {
    setError("");
    if (candidate.machine) { setChecking(true); setMachine(candidate.machine); return; }
    setHost(candidate.sshHost); setLabel(candidate.label); setEnteringHost(true);
  }
  async function save() {
    if (saving) return;
    setSaving(true); setError("");
    const next: Machine = { id, label: label.trim() || host.trim(), sshHost: host.trim(), checkouts: {} };
    try {
      const machines = await machineSave(next, true);
      setChecking(true); setMachine(next); onSaved?.(machines);
    } catch (reason) { setError(errMessage(reason)); }
    finally { setSaving(false); }
  }
  async function install(): Promise<boolean> {
    if (!machine) return false;
    setError("");
    try {
      await machineInstallHost(machine.id);
      setRevision((value) => value + 1);
      refreshMachineStatus(machine.id, workspaceRoot, { force: true });
      return true;
    } catch (reason) { setError(errMessage(reason)); return false; }
  }
  async function project(path: string) {
    if (!machine || !workspaceRoot) return;
    const next = { ...machine, checkouts: { ...machine.checkouts, [workspaceRoot]: path } };
    const machines = await machineSave(next, false);
    setMachine(next); onSaved?.(machines);
    refreshMachineStatus(next.id, workspaceRoot, { force: true });
  }
  return <>
    {!machine && !enteringHost ? <MachineConnectionPicker method={method} onMethod={setMethod} onSelect={choose} onManual={() => { setHost(""); setLabel(""); setError(""); setEnteringHost(true); }} onClose={onClose} /> : !machine ? <form className="klide-add-machine-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <p>{method === "tailscale" ? "Enter the Tailscale name or IP and your remote username." : method === "vpn" ? "Enter the machine’s private address while your VPN is connected." : "Connect a Linux machine over SSH to run tasks while your Mac is off."}</p>
      <label>SSH host<input ref={input} className="klide-field" required value={host} onChange={(event) => setHost(event.target.value)} disabled={saving} placeholder="user@hostname or SSH alias" autoCapitalize="none" spellCheck={false} /></label>
      <label>Display name (optional)<input className="klide-field" value={label} onChange={(event) => setLabel(event.target.value)} disabled={saving} placeholder="My server" /></label>
      <p>Use your existing SSH keys and config. You can save the setup even if the machine is offline.</p>
      {saving && <MachineSetupWaiting>Saving your machine</MachineSetupWaiting>}
      <footer><GhostButton disabled={saving} onClick={() => { setError(""); setEnteringHost(false); }}>Back</GhostButton><GhostButton onClick={onClose}>Cancel</GhostButton><button className="klide-button klide-button-secondary" type="submit" disabled={saving}>Continue</button></footer>
    </form> : checking && !status ? <MachineSetupWaiting>Checking SSH connection to {machine.sshHost}</MachineSetupWaiting> : <MachineSetup key={machine.id} machine={machine} status={status} checking={checking} workspaceRoot={workspaceRoot} onCheck={() => setRevision((value) => value + 1)} onInstall={install} onProject={project} onClose={onClose} />}
    {error && <p className="klide-add-machine-error" role="alert">{error}</p>}
  </>;
}
