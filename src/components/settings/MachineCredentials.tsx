import { useEffect, useState } from "react";
import { machineOpenrouterAuthorize, machineOpenrouterKeys, type Machine, type MachineInference, type MachineStatus, type MachineKeyOption } from "../../ipc/machines";
import { errMessage } from "../../errors";
import { GhostButton } from "./controls";

const defaultModel = "deepseek/deepseek-v4.1-flash-1017";
export function MachineCredentials({ machine, status, disabled, onInference, onSignIn, onCheck }: {
  machine: Machine; status: MachineStatus | null; disabled: boolean;
  onInference: (inference: MachineInference | null) => Promise<void>;
  onSignIn: () => void; onCheck: () => void;
}) {
  const api = !!machine.inference;
  const apiSupported = status?.target?.os !== "windows";
  const [model, setModel] = useState(machine.inference?.model ?? defaultModel);
  const [keys, setKeys] = useState<MachineKeyOption[]>([]);
  const [keyId, setKeyId] = useState("");
  const [consent, setConsent] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setModel(machine.inference?.model ?? defaultModel); setConsent(false); }, [machine.inference?.model, api]);
  useEffect(() => {
    if (!api) return;
    let active = true;
    void machineOpenrouterKeys().then((value) => { if (active) { setKeys(value); setKeyId(value[0]?.id ?? ""); } }).catch((reason) => { if (active) setError(errMessage(reason)); });
    return () => { active = false; };
  }, [api]);
  const busy = disabled || working;
  async function choose(next: boolean) {
    setWorking(true); setError("");
    try { await onInference(next ? { provider: "openrouter", model: model.trim() || defaultModel } : null); }
    catch (reason) { setError(errMessage(reason)); }
    finally { setWorking(false); }
  }
  async function authorize() {
    if (!consent || !keyId || !model.trim()) return;
    setWorking(true); setError("");
    try {
      await onInference({ provider: "openrouter", model: model.trim() });
      await machineOpenrouterAuthorize(machine.id, keyId);
      setConsent(false); onCheck();
    } catch (reason) { setError(errMessage(reason)); }
    finally { setWorking(false); }
  }
  return <><h3>Choose model credentials</h3><p>Choose which account or API powers tasks on this machine.</p>
    <fieldset disabled={busy} className="klide-machine-credential-options"><legend>Authentication</legend>
      <label><input type="radio" name={`credentials-${machine.id}`} checked={!api} onChange={() => { void choose(false); }} /> Claude subscription</label>
      <label><input type="radio" name={`credentials-${machine.id}`} checked={api} disabled={!apiSupported} onChange={() => { void choose(true); }} /> OpenRouter API key</label>
    </fieldset>
    {!apiSupported && <p>OpenRouter key setup is available on Linux and macOS machines.</p>}
    {api ? <>
      <p>Use DeepSeek or another OpenRouter model. Claude account sign-in is not required.</p>
      <label className="klide-machine-project">OpenRouter model ID<input className="klide-field" value={model} disabled={busy} onChange={(event) => setModel(event.target.value)} /></label>
      <label className="klide-machine-project">API key<select className="klide-field" value={keyId} disabled={busy || !keys.length} onChange={(event) => { setKeyId(event.target.value); setConsent(false); }}>{keys.length ? keys.map((key) => <option key={key.id} value={key.id}>{key.label}</option>) : <option value="">No OpenRouter key configured on this Mac</option>}</select></label>
      {!keys.length && <p>Add an OpenRouter key in Settings → Providers, then reopen this step.</p>}
      {status?.setup.credentialMode === "openrouter" && status.setup.credentials === "ready" && <p role="status">OpenRouter key configured on this machine.</p>}
      <label className="klide-machine-key-consent"><input type="checkbox" checked={consent} disabled={busy || !keys.length} onChange={(event) => setConsent(event.target.checked)} /> Store only this selected key on {machine.label ?? machine.sshHost} so tasks can continue when my Mac is off.</label>
      <div className="klide-machine-actions"><GhostButton disabled={busy || !apiSupported || !consent || !keyId || !model.trim()} onClick={() => { void authorize(); }}>{working ? "Authorizing…" : "Authorize selected key and model"}</GhostButton></div>
    </> : <><p>Sign in to your Claude subscription on this machine.</p><GhostButton disabled={busy} onClick={onSignIn}>Sign in on this machine</GhostButton></>}
    {error && <p role="alert">{error}</p>}
  </>;
}
