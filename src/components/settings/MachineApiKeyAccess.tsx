import { useEffect, useState } from "react";
import { machineApiKeys, machineAuthorizeApiKey, type Machine, type MachineApiKey, type MachineRuntime } from "../../ipc/machines";
import { errMessage } from "../../errors";
import { GhostButton } from "./controls";

export function MachineApiKeyAccess({ machine, disabled, onChange, onRuntime }: { machine: Machine; disabled: boolean; onChange: () => void; onRuntime: (runtime: MachineRuntime) => Promise<void> }) {
  const provider = machine.runtime?.apiProvider ?? "anthropic";
  const [model, setModel] = useState(machine.runtime?.apiModel ?? "deepseek/deepseek-v4.1-flash-1017");
  const modelSaved = provider !== "openrouter" || (!!model.trim() && model.trim() === machine.runtime?.apiModel);
  const [keys, setKeys] = useState<MachineApiKey[]>([]);
  const [keyId, setKeyId] = useState("");
  const [consent, setConsent] = useState(false);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState("");
  useEffect(() => {
    let live = true;
    void machineApiKeys(provider).then((next) => { if (live) setKeys(next); }).catch((reason) => { if (live) setError(errMessage(reason)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [provider]);
  async function authorize() {
    if (!keyId || !consent) return;
    setWorking(true); setError(""); setReceipt("");
    try { await machineAuthorizeApiKey(machine.id, keyId); setReceipt("Selected key authorized on this destination. Your Mac can be switched off. Removing the local key does not revoke the remote copy; revoke it with the provider when needed."); setConsent(false); onChange(); }
    catch (reason) { setError(errMessage(reason)); }
    finally { setWorking(false); }
  }
  return <div className="klide-machine-key-access">
    <p>Remote tasks use Claude Code with the selected intelligence provider. The model bridge runs on the destination, so your personal Mac can be off.</p>
    {provider === "openrouter" && <><label>OpenRouter model<input className="klide-field" value={model} disabled={disabled || working} onChange={(event) => { setModel(event.target.value); setConsent(false); }} /></label><GhostButton disabled={disabled || working || !model.trim() || modelSaved} onClick={() => { if (machine.runtime) void onRuntime({ ...machine.runtime, apiModel: model.trim() }).catch((reason) => setError(errMessage(reason))); }}>Save model</GhostButton></>}
    <label>API key<select className="klide-field" value={keyId} disabled={disabled || working || loading} onChange={(event) => { setKeyId(event.target.value); setConsent(false); }}><option value="">{loading ? "Loading saved keys…" : "Choose a key"}</option>{keys.map((key) => <option key={key.id} value={key.id}>{key.label}</option>)}</select></label>
    {!loading && !keys.length && <p>No configured keys for {provider}. Add one in Intelligence settings, then reopen this step.</p>}
    <label className="klide-machine-key-consent"><input type="checkbox" checked={consent} disabled={disabled || working || !keyId || !modelSaved} onChange={(event) => setConsent(event.target.checked)} /><span>Authorize this key on {machine.label || machine.sshHost} ({machine.sshHost}). {machine.runtime?.execution === "isolated" ? "The key stays in Docker’s credential store on the host, outside the agent sandbox. On headless Linux, this may be a file protected by permissions." : "This sends a copy to the remote account; its agents can read and use it."}</span></label>
    <GhostButton disabled={disabled || working || !keyId || !consent || !modelSaved} onClick={() => { void authorize(); }}>{working ? "Authorizing…" : "Authorize selected key"}</GhostButton>
    {error && <p role="alert">{error}</p>}{receipt && <p role="status">{receipt}</p>}
  </div>;
}
