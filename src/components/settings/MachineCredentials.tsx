import { useEffect, useMemo, useState } from "react";
import { isRemoteApiProvider, machineApiAuthorize, machineApiKeys, type Machine, type MachineStatus, type MachineKeyOption } from "../../ipc/machines";
import { hostedProviderRows, providerLabel } from "../../agent/providerCatalog";
import { errMessage } from "../../errors";
import { GhostButton } from "./controls";

/**
 * What powers tasks on a machine. Claude Code runs on the machine's own Claude
 * login; any API key authorized here lets Kit run on that API, and lets Claude
 * Code be routed to it. The model is chosen per conversation in the composer,
 * never here.
 */
export function MachineCredentials({ machine, status, disabled, onSignIn, onCheck }: {
  machine: Machine; status: MachineStatus | null; disabled: boolean;
  onSignIn: () => void; onCheck: () => void;
}) {
  const apiSupported = status?.target?.os !== "windows";
  const providers = useMemo(() => hostedProviderRows().filter((row) => isRemoteApiProvider(row.id)), []);
  const authorized = status?.setup.apiKeys ?? [];
  const [provider, setProvider] = useState(() => providers.find((row) => !authorized.includes(row.id))?.id ?? providers[0]?.id ?? "");
  const [keys, setKeys] = useState<MachineKeyOption[]>([]);
  const [keyId, setKeyId] = useState("");
  const [consent, setConsent] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  // Folded by default: the step stays one screen tall beside a running sign-in.
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    if (!provider || !adding) return;
    let active = true;
    setKeys([]); setKeyId(""); setConsent(false); setError("");
    void machineApiKeys(provider).then((value) => { if (active) { setKeys(value); setKeyId(value[0]?.id ?? ""); } })
      .catch((reason) => { if (active) setError(errMessage(reason)); });
    return () => { active = false; };
  }, [provider, adding]);
  const busy = disabled || working;
  const name = machine.label ?? machine.sshHost;
  const label = providerLabel(provider) ?? provider;
  async function authorize() {
    if (!consent || !keyId || !provider) return;
    setWorking(true); setError(""); setDone("");
    try {
      await machineApiAuthorize(machine.id, provider, keyId);
      setConsent(false); setAdding(false); setDone(`${label} key authorized on ${name}.`); onCheck();
    } catch (reason) { setError(errMessage(reason)); }
    finally { setWorking(false); }
  }
  const claude = status?.setup.claude;
  return <><h3>Model credentials</h3><p>Each conversation picks its agent and model. This machine supplies a Claude login, API keys, or both.</p>
    <div className="klide-machine-credential-group">
      <p><strong>Claude subscription</strong> · {claude === "ready" ? "signed in — Claude Code runs on its own models." : claude === "missing" ? "Claude Code is not installed." : "sign in so Claude Code runs on its own models."}</p>
      {claude !== "ready" && claude !== "missing" && <GhostButton disabled={busy} onClick={onSignIn}>Sign in on this machine</GhostButton>}
    </div>
    {/* While a sign-in runs, its terminal needs the room. */}
    {!(disabled && !adding) && <div className="klide-machine-credential-group">
      <p><strong>API keys</strong> · {authorized.length ? authorized.map((id) => providerLabel(id) ?? id).join(", ") : "none yet"}. Kit runs on these, and Claude Code can be routed to them.</p>
      {!apiSupported ? <p>API key setup is available on Linux and macOS machines.</p> : !adding ? <GhostButton disabled={busy} onClick={() => setAdding(true)}>Add an API key</GhostButton> : <>
        <label className="klide-machine-project">Provider<select aria-label="Provider" className="klide-field" value={provider} disabled={busy} onChange={(event) => setProvider(event.target.value)}>{providers.map((row) => <option key={row.id} value={row.id}>{row.label}{authorized.includes(row.id) ? " · authorized" : ""}</option>)}</select></label>
        <label className="klide-machine-project">Key<select aria-label="Key" className="klide-field" value={keyId} disabled={busy || !keys.length} onChange={(event) => { setKeyId(event.target.value); setConsent(false); }}>{keys.length ? keys.map((key) => <option key={key.id} value={key.id}>{key.label}</option>) : <option value="">No {label} key on this Mac</option>}</select></label>
        {!keys.length && <p>Add a {label} key in Settings → Providers, then come back here.</p>}
        <label className="klide-machine-key-consent"><input type="checkbox" checked={consent} disabled={busy || !keys.length} onChange={(event) => setConsent(event.target.checked)} /> Store this key on {name} so tasks keep running when my Mac is off.{authorized.includes(provider) ? " It replaces the key there now." : ""}</label>
        <div className="klide-machine-actions"><GhostButton disabled={busy || !consent || !keyId} onClick={() => { void authorize(); }}>{working ? "Authorizing…" : `Authorize ${label} key`}</GhostButton></div>
      </>}
    </div>}
    {done && <p role="status">{done}</p>}
    {error && <p role="alert">{error}</p>}
  </>;
}
