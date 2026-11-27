import { useEffect, useState } from "react";
import { machineKeySync, type Machine, type MachineStatus } from "../../ipc/machines";
import { providerLabel } from "../../agent/providerCatalog";
import { errMessage } from "../../errors";
import { GhostButton } from "./controls";

/**
 * What powers tasks on a machine. Claude Code runs on the machine's own Claude
 * login. With key sync on, the machine keeps a copy of this Mac's API keys —
 * Kit runs on them and Claude Code can be routed to them — refreshed whenever
 * Klide checks the machine and removed when sync is turned off. Keys are only
 * sent once the machine can hide them from the commands agents run there.
 */
export function MachineCredentials({ machine, status, disabled, onSignIn, onProtect, onCheck }: {
  machine: Machine; status: MachineStatus | null; disabled: boolean;
  onSignIn: () => void; onProtect: () => void; onCheck: () => void;
}) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const setup = status?.setup;
  const name = machine.label ?? machine.sshHost;
  // The secret wall that guards synced keys is Linux-only for now.
  const supported = status?.target?.os === "linux";
  const protectedKeys = setup?.wall === "ready";
  // The live check is the truth (the machine prop is the form's copy and can
  // lag); a toggle just made holds until the next check lands.
  const [toggled, setToggled] = useState<boolean | null>(null);
  useEffect(() => setToggled(null), [setup?.keySync]);
  const syncing = toggled ?? (setup?.keySync ? setup.keySync !== "off" : !!machine.syncKeys);
  const keys = (setup?.apiKeys ?? []).map((id) => providerLabel(id) ?? id);
  const busy = disabled || working;
  async function toggle(enabled: boolean) {
    setWorking(true); setError("");
    try { await machineKeySync(machine.id, enabled); setToggled(enabled); onCheck(); }
    catch (reason) { setError(errMessage(reason)); }
    finally { setWorking(false); }
  }
  const claude = setup?.claude;
  const syncLine = !syncing ? "Off." : setup?.keySync === "inSync" ? "In sync with this Mac." : setup?.keySync === "unavailable" ? "Update the Klide helper to sync keys." : setup?.keySync === "pending" ? "Changes waiting to sync." : "On.";
  return <><h3>Model credentials</h3><p>Each conversation picks its agent and model. This machine supplies a Claude login, your API keys, or both.</p>
    <div className="klide-machine-credential-group">
      <p><strong>Claude subscription</strong> · {claude === "ready" ? "signed in — Claude Code runs on its own models." : claude === "missing" ? "Claude Code is not installed." : "sign in so Claude Code runs on its own models."}</p>
      {claude !== "ready" && claude !== "missing" && <GhostButton disabled={busy} onClick={onSignIn}>Sign in on this machine</GhostButton>}
    </div>
    {/* While a sign-in runs, its terminal needs the room. */}
    {!(disabled && !working) && <div className="klide-machine-credential-group">
      <p><strong>Your API keys</strong> · {syncLine}{keys.length ? ` On the machine: ${keys.join(", ")}.` : ""}</p>
      {!supported ? <p>Key sync is available on Linux machines for now.</p>
        : !protectedKeys && !syncing ? <>
          <p>First, make the keys unreadable to the commands agents run there. One sudo step on the machine.</p>
          <GhostButton disabled={busy} onClick={onProtect}>Protect keys on {name}</GhostButton>
        </> : <label className="klide-machine-key-consent">
          <input type="checkbox" checked={syncing} disabled={busy} onChange={(event) => { void toggle(event.target.checked); }} />
          {" "}Keep a copy of this Mac's API keys on {name}, so tasks keep running when my Mac is off. Turning this off removes them there.
        </label>}
      {syncing && !protectedKeys && setup?.wall === "needsSetup" && <><p role="alert">Commands there could read the keys, so Klide refuses to run them.</p><GhostButton disabled={busy} onClick={onProtect}>Protect keys on {name}</GhostButton></>}
    </div>}
    {working && <p role="status">{syncing ? "Removing the keys…" : "Sending the keys…"}</p>}
    {error && <p role="alert">{error}</p>}
  </>;
}
