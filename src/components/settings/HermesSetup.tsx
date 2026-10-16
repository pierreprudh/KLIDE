import { useEffect, useState } from "react";
import { ProviderLogo } from "../ai/icons";
import { defaultModelForProvider } from "../../agent/providers";
import type { ProviderId } from "../../agent/types";
import { listProviderModels, readProviderKeyStatus } from "../../ipc/aiProviders";
import { alignHermesEnv, clearHermesSettings, readHermesEnvOverrides, readHermesOwnSetup, readHermesSettings, saveHermesSettings, setHermesOwnModel, type HermesEnvOverride, type HermesOwnSetup } from "../../ipc/hermes";
import { describeOwnSetup } from "../ai/hermesOwnSetup";
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
  const [overrides, setOverrides] = useState<HermesEnvOverride[]>([]);
  const [own, setOwn] = useState<HermesOwnSetup | null>(null);
  const [ownBusy, setOwnBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    readHermesOwnSetup().then((setup) => { if (!cancelled) setOwn(setup); }).catch((e) => { if (!cancelled) setError(errMessage(e)); });
    return () => { cancelled = true; };
  }, []);
  async function setOwnModel(next: string) {
    setOwnBusy(true);
    setError("");
    try {
      setOwn(await setHermesOwnModel(next));
      notify(`Hermes now runs on ${next} by itself. New Hermes sessions use it, in the terminal too.`, { tone: "success" });
    } catch (e) { setError(errMessage(e)); }
    finally { setOwnBusy(false); }
  }
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
    setOverrides([]);
    readProviderKeyStatus(provider).then(async (status) => {
      if (cancelled) return;
      setHasKey(status.hasKey);
      if (status.hasKey) {
        const [available, conflicts] = await Promise.all([listProviderModels(provider), readHermesEnvOverrides(provider)]);
        if (cancelled) return;
        setModels(available);
        setOverrides(conflicts);
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
  async function align(keep: "hermes" | "klide") {
    setBusy(true);
    setError("");
    try {
      const left = await alignHermesEnv(provider, keep);
      setOverrides(left);
      if (keep === "hermes") setKeyRevision((n) => n + 1);
      notify(keep === "hermes" ? "Klide now uses the key Hermes was set up with." : "Hermes’s .env now carries Klide’s values. New Hermes sessions use them, in the terminal too.", { tone: "success" });
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
    <>
    <SettingBlock title="Hermes’s own setup">
      <Panel>
        <HermesOwnSetupRow setup={own} klideConfigured={configured} busy={ownBusy} onSetModel={(next) => void setOwnModel(next)} />
      </Panel>
    </SettingBlock>
    <SettingBlock title="Hermes on a Klide source">
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
        <HermesEnvOverrideRow overrides={overrides} disabled={loading || busy} onAlign={(keep) => void align(keep)} />
        <Row title={configured ? "Klide configuration saved" : "Use Hermes from Klide"}
          description={error || "Applies to new sessions. Existing Hermes sessions keep their current configuration."}
          control={<div style={{ display: "flex", gap: 8 }}>
            {configured && <LinkButton disabled={loading || busy} onClick={() => void clear()}>Use Hermes defaults</LinkButton>}
            <LinkButton disabled={loading || busy || !model.trim() || (!hasKey && !key.trim())} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</LinkButton>
          </div>} />
      </Panel>
    </SettingBlock>
    </>
  );
}

/** What Hermes runs on when Klide passes nothing — its own model and key,
 *  the way `hermes setup` left them. The model can be changed here through
 *  Hermes's own `config set`; the key stays Hermes's business. */
export function HermesOwnSetupRow({ setup, klideConfigured, busy, onSetModel }: {
  setup: HermesOwnSetup | null; klideConfigured: boolean; busy?: boolean; onSetModel: (model: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const model = setup?.model ?? null;
  const value = draft || model || "";
  const changed = value.trim() !== "" && value.trim() !== model;
  const description = !setup ? "Reading Hermes’s configuration…"
    : !model ? "Hermes has no model yet. Run `hermes setup` in a terminal, or give Hermes a Klide source below."
    : `${describeOwnSetup(setup)}. ${klideConfigured ? "The Klide source below takes over; choose “Use Hermes defaults” there to run on this." : "What a Hermes conversation runs on unless its picker chooses a Klide source."}`;
  return (
    <Row title={model ?? "Not set up yet"} description={description} leading={<ProviderLogo id="hermes" />}
      control={<div style={{ display: "flex", gap: 8 }}>
        <input className="klide-field" aria-label="Hermes’s own model" value={value} placeholder="provider/model" disabled={busy || !setup}
          onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && changed && !busy) onSetModel(value.trim()); }} />
        <LinkButton disabled={busy || !changed} onClick={() => onSetModel(value.trim())}>{busy ? "Saving…" : "Set model"}</LinkButton>
      </div>} />
  );
}

/** Hermes reads its own `.env` over the environment Klide passes, so a value
 *  set there wins silently. Show the conflict and let either side adopt the
 *  other's value — a key Hermes names for this provider can come into Klide's
 *  keychain; Klide's values can go into the file, where the terminal Hermes
 *  picks them up as well. */
export function HermesEnvOverrideRow({ overrides, disabled, onAlign }: {
  overrides: HermesEnvOverride[]; disabled?: boolean; onAlign: (keep: "hermes" | "klide") => void;
}) {
  if (overrides.length === 0) return null;
  const importable = overrides.some((o) => o.importable);
  const what = importable ? "key" : "values";
  return (
    <Row title={`${overrides[0].path} sets ${overrides.map((o) => o.name).join(", ")}`}
      description={`Hermes reads its own file over what Klide passes, so a session started here would run on a different ${importable ? "key" : "endpoint"}.`}
      control={<div style={{ display: "flex", gap: 8 }}>
        {importable && <LinkButton disabled={disabled} onClick={() => onAlign("hermes")}>Use Hermes’s key in Klide</LinkButton>}
        <LinkButton disabled={disabled} onClick={() => onAlign("klide")}>Give Hermes Klide’s {what}</LinkButton>
      </div>} />
  );
}
