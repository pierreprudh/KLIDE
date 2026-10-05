import { useEffect, useState } from "react";
import {
  installLlamaRuntime, readLlamaSetupInfo, readLocalProviderStatus,
  selectLlamaModel, startLocalProvider, stopLocalProvider, type LlamaSetupInfo,
} from "../../ipc/aiProviders";
import { Row, StatusText } from "./controls";
import { ChevronDown, ProviderLogo } from "../ai/icons";
import "./llamaServerSetup.css";
import { LlamaModelCards } from "./llamaModelCards";

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
  return <div className="klide-llama-setup">
    <Row leading={<ProviderLogo id="llamacpp" size={24} />} title="llama.cpp" description={info
      ? `${info.machine.chip} · ${info.machine.memoryGb == null ? "RAM unknown" : `${Math.round(info.machine.memoryGb)} GB RAM`}`
      : "Checking this machine…"}
      control={<StatusText tone={running ? "ok" : "idle"}>{running ? "Running" : info?.runtimeInstalled ? "Installed" : "Not installed"}</StatusText>} />
    {info && <div className="klide-llama-body">
      <LlamaModelCards info={info} value={model} disabled={!!busy || running} onChange={setModel} />
      <div className="klide-llama-controls">
        <button className="klide-button klide-button-secondary"
          disabled={!!busy || (!running && !model)} onClick={() => void act(running ? "stop" : "model")}>
          {busy ? "Please wait…" : running ? "Stop" : info.runtimeInstalled ? `Start ${chosen?.label ?? "model"}` : "Set up & start"}
        </button>
        <span className="klide-llama-hint">{running ? "Stop to change models" : "Downloads on first start"}</span>
      </div>
      {fits === false && <div className="klide-llama-hint">This model may exceed your memory budget. Choose a smaller one for smoother use.</div>}
      {info.memoryBudgetGb == null && <div className="klide-llama-hint">RAM could not be detected. Start with a small model.</div>}
      <details className="klide-llama-details">
        <summary><span aria-hidden="true"><ChevronDown /></span>About this recommendation</summary>
        <div>
          {info.machine.cpuCores} CPU cores · {info.machine.acceleration}.
          {info.memoryBudgetGb != null && ` Estimated model budget: ${info.memoryBudgetGb.toFixed(1)} GB, with room left for other apps.`}
          {" Memory estimates use an 8k context. Smaller models favour speed; larger models favour quality. Actual speed depends on your workload and has not been benchmarked."}
        </div>
      </details>
      {!info.runtimeInstalled && <button className="klide-button klide-button-subtle klide-llama-engine"
        disabled={!!busy} onClick={() => void act("runtime")}>Download engine only</button>}
      {busy && <div role="status" className="klide-llama-hint">
        {busy === "runtime" ? "Downloading and verifying llama.cpp…" : busy === "stop" ? "Stopping…" : "Downloading and loading the model. First start may take several minutes…"}
      </div>}
    </div>}
    {error && <div role="alert" className="klide-llama-error">{error}
      {!info && <button className="klide-button klide-button-secondary" onClick={() => { setError(null); setRetry((n) => n + 1); }}>Retry</button>}
    </div>}
  </div>;
}
