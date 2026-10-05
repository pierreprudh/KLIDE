import { useEffect, useState } from "react";
import {
  installLlamaRuntime, readLlamaSetupInfo, readLocalProviderStatus,
  selectLlamaModel, startLocalProvider, stopLocalProvider, type LlamaSetupInfo,
} from "../../ipc/aiProviders";
import { Row, StatusText } from "./controls";

export function LlamaServerSetup() {
  const [info, setInfo] = useState<LlamaSetupInfo | null>(null);
  const [model, setModel] = useState("");
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState<"runtime" | "model" | "stop" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void readLlamaSetupInfo().then((next) => {
      if (cancelled) return;
      setInfo(next);
      setModel(next.selectedModel ?? next.recommendedModel ?? "");
    }).catch((e) => { if (!cancelled) setError(String(e)); });
    async function check() {
      try { const up = await readLocalProviderStatus("llamacpp"); if (!cancelled) setRunning(up); }
      catch (e) { if (!cancelled) setError(String(e)); }
    }
    void check();
    const timer = setInterval(() => void check(), 4000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [retry]);

  async function act(action: "runtime" | "model" | "stop") {
    if (busy) return;
    setBusy(action); setError(null);
    try {
      if (action === "stop") {
        await stopLocalProvider("llamacpp");
        const up = await readLocalProviderStatus("llamacpp");
        setRunning(up);
        if (up) throw new Error("This server was started outside Klide. Stop it there before changing models.");
      } else if (action === "runtime") {
        await installLlamaRuntime();
      } else {
        await selectLlamaModel(model);
        const up = await startLocalProvider({ provider: "llamacpp", model });
        setRunning(up);
        if (!up) throw new Error("The model did not become ready. Try starting it again.");
      }
      const next = await readLlamaSetupInfo(); setInfo(next);
    } catch (e) { setError(String(e)); }
    finally { setBusy(null); }
  }

  const chosen = info?.models.find((m) => m.id === model);
  const fits = chosen && info?.memoryBudgetGb != null ? chosen.memoryGb <= info.memoryBudgetGb : null;
  const buttonStyle = { padding: "6px 12px", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-strong)", background: "var(--bg-hover)", color: "var(--fg-strong)", cursor: "pointer" };
  return <div style={{ display: "grid", gap: 12, paddingBottom: 16 }}>
    <Row title="llama.cpp" description={info
      ? `${info.machine.chip} · ${info.machine.memoryGb == null ? "RAM unknown" : `${Math.round(info.machine.memoryGb)} GB RAM`} · ${info.machine.cpuCores} CPU cores · ${info.machine.acceleration}`
      : "Checking this machine…"}
      control={<StatusText tone={running ? "ok" : "idle"}>{running ? "Running" : info?.runtimeInstalled ? "Installed" : "Not installed"}</StatusText>} />
    {info && <div style={{ display: "grid", gap: 10 }}>
      <label style={{ display: "grid", gap: 6 }}>
        <span>Choose a model for this machine</span>
        <select className="klide-field" aria-label="llama.cpp model" value={model}
          disabled={!!busy || running} onChange={(e) => setModel(e.target.value)}>
          <option value="" disabled>Choose a model</option>
          {info.models.map((m) => <option key={m.id} value={m.id}>
            {m.label}{m.id === info.recommendedModel ? " · Recommended" : ""} · {m.downloadGb} GB download
            {info.memoryBudgetGb != null && m.memoryGb > info.memoryBudgetGb ? " · May exceed available budget" : ""}
          </option>)}
        </select>
      </label>
      <div className="klide-row-description">
        {info.memoryBudgetGb == null ? "Memory detection is unavailable. Choose a small model to start." : `Estimated model budget: ${info.memoryBudgetGb.toFixed(1)} GB, leaving memory for Klide and other apps.`}
        {chosen && ` This model needs approximately ${chosen.memoryGb} GB at an 8k context.`}
        {fits === false && " A smaller model is recommended to avoid heavy swapping."}
        {" Recommendations estimate fit and favour smaller models on CPU. Inference speed has not been benchmarked."}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {!info.runtimeInstalled && <button style={buttonStyle} disabled={!!busy} onClick={() => void act("runtime")}>Download llama.cpp</button>}
        <button style={{ ...buttonStyle, background: "var(--accent)", color: "var(--control-primary-fg)" }}
          disabled={!!busy || (!running && !model)} onClick={() => void act(running ? "stop" : "model")}>
          {running ? "Stop" : info.runtimeInstalled ? "Download & start model" : "Install & start selected model"}
        </button>
      </div>
      {busy && <div role="status" className="klide-row-description">
        {busy === "runtime" ? "Downloading and verifying llama.cpp…" : busy === "stop" ? "Stopping…" : "Preparing runtime, downloading the selected model and waiting for it to load. First start can take several minutes…"}
      </div>}
    </div>}
    {error && <div role="alert" className="klide-row-description">{error}
      {!info && <button style={buttonStyle} onClick={() => { setError(null); setRetry((n) => n + 1); }}>Retry hardware detection</button>}
    </div>}
  </div>;
}
