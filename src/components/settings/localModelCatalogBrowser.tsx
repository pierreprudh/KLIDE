import { useState } from "react";
import { readLlamaSetupInfo } from "../../ipc/aiProviders";
import { readLocalModelCatalog } from "../../ipc/localModelCatalog";
import { ChevronDown } from "../ai/icons";
import { Row } from "./controls";
import { resolveCatalogHardware, THIS_COMPUTER, type CatalogMachine, type LocalModelCatalog } from "./localModelCatalog";

/** Optional upstream evidence; the managed suggestions above work without it. */
export function LocalModelCatalogBrowser({ machine: detectedMachine }: { machine?: CatalogMachine } = {}) {
  const [catalog, setCatalog] = useState<LocalModelCatalog | null>(null);
  const [hardware, setHardware] = useState("");
  const [machine, setMachine] = useState<CatalogMachine | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function load() {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const [next, info] = await Promise.all([
        readLocalModelCatalog(), detectedMachine ? Promise.resolve(null) : readLlamaSetupInfo().catch(() => null),
      ]);
      setCatalog(next); setMachine(info?.machine ?? null); setHardware("");
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  async function retryDetection() {
    if (busy) return;
    setBusy(true); setError("");
    try { const info = await readLlamaSetupInfo(); setMachine(info.machine); setHardware(""); }
    catch (e) { setMachine(null); setError(String(e)); }
    finally { setBusy(false); }
  }
  const currentMachine = detectedMachine ?? machine;
  return <details className="klide-llama-details klide-local-catalog" onToggle={(e) => {
    if (e.currentTarget.open && !catalog && !busy && !error) void load();
  }}>
    <summary><span aria-hidden="true"><ChevronDown /></span>Community benchmarks</summary>
    <div>
      <p className="klide-llama-hint">Measured configurations from the Local AI registry. These are separate from Klide’s estimated model suggestions.</p>
      {busy && <p className="klide-llama-hint" role="status">Checking community benchmarks…</p>}
      {error && <div role="alert" className="klide-llama-hint">{error}</div>}
      {!catalog && !busy && <button type="button" className="klide-button klide-button-subtle" onClick={() => void load()}>{error ? "Retry benchmarks" : "Load benchmarks"}</button>}
      {catalog && <CommunityModelConfigurations catalog={catalog} machine={currentMachine} hardware={hardware} onHardwareChange={setHardware} />}
      {catalog && !currentMachine && <button type="button" className="klide-button klide-button-subtle" disabled={busy} onClick={() => void retryDetection()}>Retry hardware detection</button>}
    </div>
  </details>;
}

export function CommunityModelConfigurations({ catalog, machine, hardware, onHardwareChange }: {
  catalog: LocalModelCatalog; machine: CatalogMachine | null; hardware: string; onHardwareChange: (value: string) => void;
}) {
  const view = resolveCatalogHardware(catalog.hardware, machine, hardware);
  return <div className="klide-community-configurations">
    <Row title="Hardware" description={machine ? `${machine.chip} · ${machine.memoryGb == null ? "RAM unknown" : `${Math.round(machine.memoryGb)} GB RAM`} detected` : "Hardware could not be detected"}
      control={<select className="klide-field klide-settings-select" aria-label="Benchmark hardware" value={view.value} onChange={(e) => onHardwareChange(e.target.value)}>
        {view.currentLabel ? <option value={THIS_COMPUTER}>This computer</option> : <option value="">Choose hardware</option>}
        <optgroup label="Tested hardware">{catalog.hardware.map((h) => <option key={h.id} value={h.id}>{h.name} · {h.memoryGb} GB</option>)}</optgroup>
      </select>} />
    <p role="status" className="klide-llama-hint">{view.message}</p>
    {view.selected?.recipes.map((r) => <Row key={r.id} title={r.model} description={`${r.engine.split("@")[0]} · ${r.context?.toLocaleString() ?? "Unknown"} context tokens`}
      control={<a className="klide-button klide-button-subtle" href={r.source} target="_blank" rel="noreferrer">Evidence</a>}
      footer={<>
        <dl className="klide-community-metrics">
          <div><dt>Generation</dt><dd>{r.decodeTps == null ? "—" : `${r.decodeTps} tok/s`}</dd></div>
          <div><dt>Prompt processing</dt><dd>{r.prefillTps == null ? "—" : `${r.prefillTps} tok/s`}</dd></div>
        </dl>
        <div className="klide-llama-hint">{r.evidence}{r.date ? ` · ${r.date}` : ""}. Not verified in Klide.</div>
        {r.needs && Object.keys(r.needs).length > 0 && <details className="klide-llama-details"><summary>Requirements</summary>
          <dl className="klide-community-metrics">{Object.entries(r.needs).map(([key, value]) => <div key={key}><dt>{key.replace(/_/g, " ")}</dt><dd>{typeof value === "object" ? JSON.stringify(value) : String(value)}</dd></div>)}</dl>
        </details>}
      </>} />)}
    <a className="klide-community-source" href={`https://github.com/sybil-solutions/local-ai-registry/tree/${catalog.revision}`} target="_blank" rel="noreferrer">Source: Local AI registry</a>
  </div>;
}
