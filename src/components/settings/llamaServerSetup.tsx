import { useEffect, useState } from "react";
import {
  discoverRegistryModels, installLlamaRuntime, readLlamaSetupInfo, readLocalProviderStatus,
  selectLlamaModel, startLocalProvider, stopLocalProvider, readLocalProviderDetails, readLocalSetupProgress, type LlamaSetupInfo, type LocalSetupProgress,
} from "../../ipc/aiProviders";
import { Row, StatusText } from "./controls";
import { ChevronDown, ProviderLogo } from "../ai/icons";
import "./llamaServerSetup.css";
import { LlamaModelCards } from "./llamaModelCards";
import { LocalModelCatalogBrowser } from "./localModelCatalogBrowser";

export function LlamaServerSetup() {
  const [info, setInfo] = useState<LlamaSetupInfo | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discovery, setDiscovery] = useState<string | null>(null);
  const [model, setModel] = useState("");
  const [running, setRunning] = useState(false);
  const [owned, setOwned] = useState(false);
  const [busy, setBusy] = useState<"runtime" | "model" | "stop" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [progress, setProgress] = useState<LocalSetupProgress | null>(null);
  const setupActive = progress != null && !["idle", "failed"].includes(progress.phase);

  useEffect(() => {
    let cancelled = false;
    void readLlamaSetupInfo().then((next) => {
      if (cancelled) return;
      setInfo(next);
      setModel(next.selectedModel ?? next.recommendedModel ?? "");
    }).catch((e) => { if (!cancelled) setError(String(e)); });
    async function check() {
      try {
        const [server, step] = await Promise.all([readLocalProviderDetails("llamacpp"), readLocalSetupProgress("llamacpp")]);
        if (!cancelled) { setRunning(server.ready); setOwned(server.owned); setProgress(step); }
      }
      catch (e) { if (!cancelled) setError(String(e)); }
    }
    // Schedule after completion: a slow health probe must not accumulate or
    // overwrite newer progress with an older interval response.
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      await check();
      if (!cancelled) timer = setTimeout(() => void poll(), 1000);
    }
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [retry]);

  async function discover() {
    setDiscovering(true); setError(null);
    try {
      const result = await discoverRegistryModels();
      setInfo((current) => current && { ...current, models: [...current.models.filter((m) => !m.registrySource || m.id === current.selectedModel), ...result.models.filter((m) => m.id !== current?.selectedModel)] });
      setDiscovery(`${result.models.length} registry options estimated to fit. Checked ${result.checked} portable configurations.${result.unavailable ? ` Requirements unavailable for ${result.unavailable}.` : ""} No models downloaded. These have not been tested on this Mac.`);
    } catch (e) { setError(String(e)); }
    finally { setDiscovering(false); }
  }

  async function act(action: "runtime" | "model" | "stop") {
    if (busy) return;
    setBusy(action); setError(null);
    try {
      if (action === "stop") {
        await stopLocalProvider("llamacpp");
        const up = await readLocalProviderStatus("llamacpp");
        setRunning(up);
        setOwned(false);
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
      control={<StatusText tone={running ? "ok" : owned ? "warn" : "idle"}>{running ? "Running" : owned ? "Not ready" : info?.runtimeInstalled ? "Installed" : "Not installed"}</StatusText>} />
    {info && <div className="klide-llama-body">
      <LlamaModelCards info={info} value={model} disabled={!!busy || setupActive || running || owned} onChange={setModel} />
      <div className="klide-llama-controls">
        <button className="klide-button klide-button-subtle" disabled={discovering || !!busy || setupActive} onClick={() => void discover()}>{discovering ? "Checking registry models…" : "Find more models"}</button>
        <span className="klide-llama-hint">Checks pinned weights and memory for this computer</span>
      </div>
      {(discovering || discovery) && <p role="status" className="klide-llama-hint">{discovering ? "Reading model sizes and GGUF headers. Model downloads start only when you press Start." : discovery}</p>}
      <div className="klide-llama-controls">
        <button className="klide-button klide-button-secondary"
          disabled={discovering || !!busy || setupActive || (!running && !owned && !model)} onClick={() => void act(running || owned ? "stop" : "model")}>
          {busy === "stop" ? "Stopping…" : busy || setupActive ? "Setting up…" : running || owned ? "Stop" : info.runtimeInstalled ? `Start ${chosen?.label ?? "model"}` : "Set up & start"}
        </button>
        <span className="klide-llama-hint">{owned && !running ? "The managed server is not ready. Stop it before retrying." : running ? "Stop to change models" : "Downloads on first start"}</span>
      </div>
      {fits === false && <div className="klide-llama-hint">This model may exceed your memory budget. Choose a smaller one for smoother use.</div>}
      {info.memoryBudgetGb == null && <div className="klide-llama-hint">RAM could not be detected. Start with a small model.</div>}
      <details className="klide-llama-details">
        <summary><span aria-hidden="true"><ChevronDown /></span>About this recommendation</summary>
        <div>
          {info.machine.cpuCores} CPU cores · {info.machine.acceleration}.
          {info.memoryBudgetGb != null && ` Estimated model budget: ${info.memoryBudgetGb.toFixed(1)} GB, with room left for other apps.`}
          {" Memory estimates use a 16k context. Smaller models favour speed; larger models favour quality. Actual speed depends on your workload and has not been benchmarked."}
        </div>
      </details>
      <LocalModelCatalogBrowser machine={info.machine} />
      {!info.runtimeInstalled && <button className="klide-button klide-button-subtle klide-llama-engine"
        disabled={!!busy || setupActive} onClick={() => void act("runtime")}>Download engine only</button>}
      {(busy || setupActive) && <div role="status" className="klide-llama-hint">
        {busy === "stop" ? "Stopping…" : progress?.phase === "engine" ? "Downloading and verifying llama.cpp…" : progress?.phase === "model" ? "Downloading and verifying the model…" : progress?.phase === "loading" ? "Loading the model and checking readiness…" : "Preparing setup…"}
        {progress?.phase === "model" && progress.downloadedBytes > 0 && <div>
          {(progress.downloadedBytes / 1e9).toFixed(2)} GB downloaded{progress.totalBytes != null ? ` of ${(progress.totalBytes / 1e9).toFixed(2)} GB` : ""}
        </div>}
      </div>}
    </div>}
    {error && <div role="alert" className="klide-llama-error">{error}
      {!info && <button className="klide-button klide-button-secondary" onClick={() => { setError(null); setRetry((n) => n + 1); }}>Retry</button>}
    </div>}
    {!error && progress?.phase === "failed" && <div role="alert" className="klide-llama-error">{progress.error}</div>}
  </div>;
}
