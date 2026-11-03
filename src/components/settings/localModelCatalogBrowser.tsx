import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { readLlamaSetupInfo } from "../../ipc/aiProviders";
import { matchCatalogHardware, type LocalModelCatalog } from "./localModelCatalog";

export function LocalModelCatalogBrowser() {
  const [catalog, setCatalog] = useState<LocalModelCatalog | null>(null);
  const [hardware, setHardware] = useState("");
  const [matched, setMatched] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function load() {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const [next, info] = await Promise.all([
        invoke<LocalModelCatalog>("ai_local_model_catalog"), readLlamaSetupInfo().catch(() => null),
      ]);
      const match = info ? matchCatalogHardware(next.hardware, info.machine.chip, info.machine.memoryGb) : "";
      setCatalog(next); setHardware(match); setMatched(match);
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  const selected = catalog?.hardware.find((h) => h.id === hardware);
  return <section className="klide-llama-body" aria-label="Tested model configurations">
    <div className="klide-llama-label">Explore tested configurations</div>
    <p className="klide-llama-hint">Find models tested on your hardware or another machine. Evidence comes from the Local AI registry; these configurations have not been verified in Klide.</p>
    {!catalog && <button className="klide-button klide-button-secondary" disabled={busy} onClick={() => void load()}>
      {busy ? "Loading configurations…" : error ? "Retry catalog" : "Browse model catalog"}
    </button>}
    {error && <div role="alert" className="klide-llama-hint">{error}</div>}
    {catalog && <>
      <label className="klide-llama-hint">Hardware
        <select className="klide-field" style={{ display: "block", width: "100%", marginTop: 8 }} value={hardware} onChange={(e) => setHardware(e.target.value)}>
          <option value="">Choose hardware</option>
          {catalog.hardware.map((h) => <option key={h.id} value={h.id}>{h.name} · {h.memoryGb} GB</option>)}
        </select>
      </label>
      <div className="klide-llama-hint">{hardware && hardware === matched ? "Matches this machine’s chip and memory. Available memory and other requirements still apply." : "Choose the hardware you want to explore. Memory fit on this computer has not been established."}</div>
      <div className="klide-llama-card-grid">
        {selected?.recipes.map((r) => <article className="klide-llama-card" key={r.id}>
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
