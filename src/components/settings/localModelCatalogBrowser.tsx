import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { readLlamaSetupInfo } from "../../ipc/aiProviders";
import { resolveCatalogHardware, THIS_COMPUTER, type CatalogMachine, type LocalModelCatalog } from "./localModelCatalog";

export function LocalModelCatalogBrowser() {
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
        invoke<LocalModelCatalog>("ai_local_model_catalog"), readLlamaSetupInfo().catch(() => null),
      ]);
      setCatalog(next); setMachine(info?.machine ?? null); setHardware("");
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  async function retryDetection() {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const info = await readLlamaSetupInfo();
      setMachine(info.machine); setHardware("");
    } catch (e) { setMachine(null); setError(String(e)); }
    finally { setBusy(false); }
  }
  const view = resolveCatalogHardware(catalog?.hardware ?? [], machine, hardware);
  return <section className="klide-llama-body" aria-label="Tested model configurations">
    <div className="klide-llama-label">Explore tested configurations</div>
    <p className="klide-llama-hint">Find models tested on your hardware or another machine. Evidence comes from the Local AI registry; these configurations have not been verified in Klide.</p>
    {!catalog && <button className="klide-button klide-button-secondary" disabled={busy} onClick={() => void load()}>
      {busy ? "Loading configurations…" : error ? "Retry catalog" : "Browse model catalog"}
    </button>}
    {error && <div role="alert" className="klide-llama-hint">{error}</div>}
    {catalog && <>
      <label className="klide-llama-hint">Hardware
        <select className="klide-field" style={{ display: "block", width: "100%", marginTop: 8 }} value={view.value} onChange={(e) => setHardware(e.target.value)}>
          {view.currentLabel ? <option value={THIS_COMPUTER}>{view.currentLabel}</option> : <option value="">Choose hardware</option>}
          <optgroup label="Tested catalog hardware">
            {catalog.hardware.map((h) => <option key={h.id} value={h.id}>{h.name} · {h.memoryGb} GB</option>)}
          </optgroup>
        </select>
      </label>
      <div role="status" className="klide-llama-hint">{view.message}</div>
      {!machine && <button className="klide-button klide-button-secondary" disabled={busy} onClick={() => void retryDetection()}>
        {busy ? "Checking hardware…" : "Retry hardware detection"}
      </button>}
      <div className="klide-llama-card-grid">
        {view.selected?.recipes.map((r) => <article className="klide-llama-card" key={r.id}>
          <strong>{r.model}</strong>
          <div className="klide-llama-hint">{r.engine.split("@")[0]}</div>
          <dl className="klide-llama-card-stats">
            <div><dt>Context</dt><dd>{r.context?.toLocaleString() ?? "—"}</dd></div>
            <div><dt>Generation</dt><dd>{r.decodeTps == null ? "—" : `${r.decodeTps} tok/s`}</dd></div>
            <div><dt>Prompt processing</dt><dd>{r.prefillTps == null ? "—" : `${r.prefillTps} tok/s`}</dd></div>
          </dl>
          <p className="klide-llama-hint">{r.evidence}{r.date ? ` · ${r.date}` : ""}</p>
          {r.needs && <p className="klide-llama-hint">{Object.entries(r.needs).map(([key, value]) => `${key.replace(/_/g, " ")}: ${String(value)}`).join(" · ")}</p>}
          <a href={r.source} target="_blank" rel="noreferrer">Configuration and evidence</a>
        </article>)}
      </div>
      <div className="klide-llama-hint">Catalog revision {catalog.revision.slice(0, 8)}. Follow the linked setup instructions, then connect the running server through Local AI or Self-hosted.</div>
    </>}
  </section>;
}
