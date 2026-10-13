import { useEffect, useState } from "react";
import { ProviderLogo } from "../ai/icons";
import { defaultModelForProvider } from "../../agent/providers";
import type { ProviderId } from "../../agent/types";
import { listProviderModels, readProviderKeyStatus } from "../../ipc/aiProviders";
import { clearHermesSettings, readHermesSettings, saveHermesSettings } from "../../ipc/hermes";
import { errMessage } from "../../errors";
import { notify } from "../../toast";
import { LinkButton, Panel, Row, SettingBlock } from "./controls";

const BACKENDS = [
  { id: "deepseek", label: "DeepSeek" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "anthropic", label: "Anthropic" },
  { id: "openai", label: "OpenAI" },
];

export function HermesSetup() {
  const [provider, setProvider] = useState("deepseek");
  const [model, setModel] = useState(defaultModelForProvider("deepseek"));
  const [key, setKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [error, setError] = useState("");
  const [keyRevision, setKeyRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    readHermesSettings().then((settings) => {
      if (cancelled) return;
      if (settings) {
        setProvider(settings.provider);
        setModel(settings.model);
        setConfigured(true);
      }
    }).catch((e) => { if (!cancelled) setError(errMessage(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    let cancelled = false;
    setHasKey(false);
    setModels([]);
    readProviderKeyStatus(provider).then(async (status) => {
      if (cancelled) return;
      setHasKey(status.hasKey);
      if (status.hasKey) {
        const available = await listProviderModels(provider);
        if (!cancelled) setModels(available);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [provider, keyRevision]);
  async function save() {
    setBusy(true);
    setError("");
    try {
      await saveHermesSettings({ provider, model }, key || undefined);
      setKey("");
      setConfigured(true);
      setKeyRevision((n) => n + 1);
      notify("Hermes configured. Start a new Hermes conversation to use it.", { tone: "success" });
    } catch (e) { setError(errMessage(e)); }
    finally { setBusy(false); }
  }
  async function clear() {
    setBusy(true);
    setError("");
    try {
      await clearHermesSettings();
      setConfigured(false);
      setKey("");
      notify("New Hermes sessions will use Hermes's own configuration.", { tone: "success" });
    } catch (e) { setError(errMessage(e)); }
    finally { setBusy(false); }
  }
  return (
    <SettingBlock title="Hermes API setup">
      <Panel>
        <Row title="Model provider" description="Run Hermes with an API key. No Hermes subscription required."
          leading={<ProviderLogo id="hermes" />}
          control={<select className="klide-field" aria-label="Hermes model provider" value={provider} disabled={loading || busy}
            onChange={(e) => { const id = e.target.value; setProvider(id); setModel(defaultModelForProvider(id as ProviderId)); setKey(""); setError(""); }}>
            {BACKENDS.map((backend) => <option key={backend.id} value={backend.id}>{backend.label}</option>)}
          </select>} />
        <Row title="Model" description="Choose a model or enter its exact provider model ID."
          control={<><input className="klide-field" aria-label="Hermes model" value={model} disabled={loading || busy} list="hermes-models"
            onChange={(e) => setModel(e.target.value)} /><datalist id="hermes-models">{models.map((id) => <option key={id} value={id} />)}</datalist></>} />
        <Row title="API key" description={hasKey ? "A key is already configured in Klide. Leave blank to reuse it." : "Saved in Klide's keychain and shared with this API provider."}
          control={<input className="klide-field" aria-label="Hermes API key" type="password" autoComplete="off" value={key} disabled={loading || busy}
            placeholder={hasKey ? "Use existing key" : "Paste API key"} onChange={(e) => setKey(e.target.value)} />} />
        <Row title={configured ? "Klide configuration saved" : "Use Hermes from Klide"}
          description={error || "Applies to new sessions. Existing Hermes sessions keep their current configuration."}
          control={<div style={{ display: "flex", gap: 8 }}>
            {configured && <LinkButton disabled={loading || busy} onClick={() => void clear()}>Use Hermes defaults</LinkButton>}
            <LinkButton disabled={loading || busy || !model.trim() || (!hasKey && !key.trim())} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</LinkButton>
          </div>} />
      </Panel>
    </SettingBlock>
  );
}
