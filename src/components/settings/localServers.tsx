import { useLlamaSetupMode, setLlamaSetupMode } from "../../hooks/useLlamaSetupMode";
// Local AI servers — start/stop/status row for Ollama and MLX. Extracted
// from SettingsPanel.tsx.

import { openUrl } from "@tauri-apps/plugin-opener";
import { LlamaServerSetup } from "./llamaServerSetup";
import { useEffect, useState } from "react";
import {
  readLocalProviderStatus,
  startLocalProvider,
  stopLocalProvider,
} from "../../ipc/aiProviders";
import { LinkButton, Row, Segmented, StatusText } from "./controls";
import { ProviderLogo } from "../ai/icons";
import type { ProviderId } from "../../agent/types";
import { providerDefaultModel, providerLabel } from "../../agent/providerCatalog";

/** One managed local server (`isLocalServer` on its registry row). Its name
 *  and the model it warms up with are the row's, not props. */
export function LocalServerRow({ provider }: { provider: string }) {
  if (provider === "llamaapp") return <Row
    leading={<ProviderLogo id="llamaapp" size={24} />}
    title="Llama app"
    description="Install Llama, choose a model, then select Llama app in the AI panel. Use at least 16k model context for tools. Connects on localhost:9931."
    control={<LinkButton onClick={() => void openUrl("https://llama.app")}>Get Llama</LinkButton>}
  />;
  return provider === "llamacpp" ? <LlamaLocalSetup /> : <ManagedLocalServerRow provider={provider} />;
}
function LlamaLocalSetup() {
  const mode = useLlamaSetupMode();
  function choose(value: number | string | undefined) {
    setLlamaSetupMode(value === "app" ? "app" : "klide");
  }
  return <>
    <Row
      leading={<ProviderLogo id="llamacpp" size={24} />}
      title="Llama"
      description="Choose who manages llama.cpp. The selected setup appears in the provider selector."
      control={<Segmented
        label="Llama setup"
        options={[{ label: "Klide", value: "klide" }, { label: "Llama app", value: "app" }]}
        value={mode}
        onChange={choose}
      />}
    />
    {mode === "klide" ? <LlamaServerSetup /> : <LocalServerRow provider="llamaapp" />}
  </>;
}

function ManagedLocalServerRow({ provider }: { provider: string }) {
  const title = providerLabel(provider) ?? provider;
  const defaultModel = providerDefaultModel(provider) ?? "";
  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval>;
    async function check() {
      try {
        const ok = await readLocalProviderStatus(provider);
        setRunning(ok);
      } catch {
        setRunning(false);
      }
    }
    check();
    timer = setInterval(check, 4000);
    return () => clearInterval(timer);
  }, [provider]);

  async function toggle() {
    if (starting) return;
    setError(null);
    setStarting(true);
    try {
      if (running) {
        await stopLocalProvider(provider);
        setRunning(false);
      } else {
        const started = await startLocalProvider({ provider, model: defaultModel });
        setRunning(started);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setStarting(false);
    }
  }

  const statusText = running ? (
    <StatusText tone="ok">Running</StatusText>
  ) : (
    <StatusText tone="idle">Stopped</StatusText>
  );

  return (
    <Row
      leading={<ProviderLogo id={provider as ProviderId} size={24} />}
      title={title}
      description={error ? error : running ? "Server is reachable on localhost." : "Server is not running. Start it to enable chat."}
      control={
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {statusText}
          <button
            onClick={() => void toggle()}
            disabled={starting}
            style={{
              height: 28,
              padding: "0 12px",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--border-strong)",
              background: running ? "var(--bg-hover)" : "var(--accent)",
              color: running ? "var(--fg-strong)" : "var(--control-primary-fg)",
              fontSize: 12,
              fontWeight: 600,
              cursor: starting ? "default" : "pointer",
              opacity: starting ? 0.6 : 1,
              transition: "opacity var(--motion-fast) var(--ease-out)",
            }}
          >
            {starting ? "..." : running ? "Stop" : "Start"}
          </button>
        </div>
      }
    />
  );
}
