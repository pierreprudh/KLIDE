import { useEffect, useState } from "react";
import { machineApiKeys, machineAuthorizeApiKey, type Machine, type MachineApiKey } from "../../ipc/machines";
import { errMessage } from "../../errors";
import { GhostButton } from "./controls";

export function MachineApiKeyAccess({ machine, disabled, onChange }: { machine: Machine; disabled: boolean; onChange: () => void }) {
  const [keys, setKeys] = useState<MachineApiKey[]>([]);
  const [keyId, setKeyId] = useState("");
  const [consent, setConsent] = useState(false);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState("");
  useEffect(() => {
    let live = true;
    void machineApiKeys().then((next) => { if (live) setKeys(next); }).catch((reason) => { if (live) setError(errMessage(reason)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);
  async function authorize() {
    if (!keyId || !consent) return;
    setWorking(true); setError(""); setReceipt("");
    try { await machineAuthorizeApiKey(machine.id, keyId); setReceipt("Selected key authorized on this destination. Your Mac can be switched off. Removing the local key does not revoke the remote copy; revoke it with Anthropic when needed."); setConsent(false); onChange(); }
    catch (reason) { setError(errMessage(reason)); }
    finally { setWorking(false); }
  }
  return <div className="klide-machine-key-access">
    <p>Remote tasks currently use Claude Code. Choose an Anthropic key saved in Settings → Intelligence. Other providers and environment references are not transferred.</p>
    <label>API key<select className="klide-field" value={keyId} disabled={disabled || working || loading} onChange={(event) => { setKeyId(event.target.value); setConsent(false); }}><option value="">{loading ? "Loading saved keys…" : "Choose a key"}</option>{keys.map((key) => <option key={key.id} value={key.id}>{key.label}</option>)}</select></label>
    {!loading && !keys.length && <p>No saved Anthropic keys. Add one in Intelligence settings, then reopen this step.</p>}
    <label className="klide-machine-key-consent"><input type="checkbox" checked={consent} disabled={disabled || working || !keyId} onChange={(event) => setConsent(event.target.checked)} /><span>Authorize this key on {machine.label || machine.sshHost} ({machine.sshHost}). {machine.runtime?.execution === "isolated" ? "The key stays in Docker’s credential store on the host, outside the agent sandbox. On headless Linux, this may be a file protected by permissions." : "This sends a copy to the remote account; its agents can read and use it."}</span></label>
    <GhostButton disabled={disabled || working || !keyId || !consent} onClick={() => { void authorize(); }}>{working ? "Authorizing…" : "Authorize selected key"}</GhostButton>
    {error && <p role="alert">{error}</p>}{receipt && <p role="status">{receipt}</p>}
  </div>;
}
