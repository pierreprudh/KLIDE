// Local AI servers — start/stop/status row for Ollama and MLX. Extracted
// from SettingsPanel.tsx.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Row, StatusText } from "./controls";

export function LocalServerRow({
  provider,
  title,
  defaultModel,
}: {
  provider: string;
  title: string;
  defaultModel: string;
}) {
  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval>;
    async function check() {
      try {
        const ok = await invoke<boolean>("ai_local_server_status", { provider });
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
        await invoke("ai_local_server_stop", { provider });
        setRunning(false);
      } else {
        const started = await invoke<boolean>("ai_local_server_start", { provider, model: defaultModel });
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

