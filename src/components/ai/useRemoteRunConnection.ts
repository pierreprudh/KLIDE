import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getAgentRunState } from "../../agent/client";
import { errMessage } from "../../errors";

/** Reconnect even when the app was opened before SSH became reachable. */
export function useRemoteRunConnection(machine: string | null, runId: string, onReconnect: () => void): string | null {
  const [error, setError] = useState<string | null>(null);
  const reconnect = useRef(onReconnect);
  reconnect.current = onReconnect;
  useEffect(() => {
    setError(null);
    if (!machine) return;
    let disposed = false;
    let checking = false;
    let wasOffline = false;
    const check = async () => {
      if (checking || disposed) return;
      checking = true;
      try {
        await getAgentRunState(runId);
        if (disposed) return;
        setError(null);
        if (wasOffline) reconnect.current();
        wasOffline = false;
      } catch (reason) {
        if (!disposed) { wasOffline = true; setError(errMessage(reason)); }
      } finally { checking = false; }
    };
    const unlisten = listen<{ connected: boolean; error?: string }>(`remote-run-connection:${runId}`, ({ payload }) => {
      if (disposed) return;
      if (!payload.connected) wasOffline = true;
      if (payload.connected && wasOffline) { wasOffline = false; reconnect.current(); }
      setError(payload.connected ? null : payload.error || "Reconnecting…");
    }).catch(() => () => {});
    void check();
    const interval = window.setInterval(() => { void check(); }, 15000);
    window.addEventListener("online", check);
    window.addEventListener("focus", check);
    return () => {
      disposed = true;
      window.clearInterval(interval);
      window.removeEventListener("online", check);
      window.removeEventListener("focus", check);
      void unlisten.then((stop) => stop()).catch(() => {});
    };
  }, [machine, runId]);
  return error;
}
