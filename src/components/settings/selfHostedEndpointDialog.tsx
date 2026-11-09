import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CustomProvider } from "../../customProviders";
import { Z } from "../../zLayers";
import { LinkButton } from "./controls";
import { SelfHostedConnectionTest } from "./selfHostedConnectionTest";
import { tailscaleEndpointUrl } from "./tailscaleEndpoint";
import { TailscaleIcon } from "../../icons";

export function SelfHostedEndpointDialog({
  provider, editing, busy, error, onNameChange, onUrlChange, onTokenChange,
  onModelChange, onCancel, onSave,
}: {
  provider: CustomProvider;
  editing: boolean;
  busy: boolean;
  error: string | null;
  onNameChange: (value: string) => void;
  onUrlChange: (value: string) => void;
  onTokenChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const [connection, setConnection] = useState<"api" | "tailscale">("api");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("8000");
  const [advanced, setAdvanced] = useState(false);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLInputElement>("input")?.focus();
    return () => previous?.focus();
  }, []);

  function chooseConnection(next: "api" | "tailscale") {
    if (next === "tailscale") {
      let nextHost = host;
      let nextPort = port;
      // Preserve a pasted URL when moving into the shortcut, if it fits.
      try {
        const url = new URL(provider.baseUrl);
        if (url.protocol === "http:" && url.pathname.replace(/\/$/, "") === "/v1" && !url.search && !url.hash && !url.username && !url.password) {
          nextHost = url.hostname;
          nextPort = url.port || "80";
        }
      } catch { /* An empty URL is normal on add. */ }
      setHost(nextHost);
      setPort(nextPort);
      onUrlChange(tailscaleEndpointUrl(nextHost, nextPort));
    }
    setConnection(next);
  }

  return createPortal(
    <div
      style={{ position: "fixed", inset: 0, zIndex: Z.modalRaised, display: "grid", placeItems: "center", padding: 16, background: "rgba(0,0,0,0.30)", backdropFilter: "blur(3px)" }}
      onClick={() => { if (!busy) onCancel(); }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="self-hosted-dialog-title"
        className="floating-panel"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key !== "Tab") return;
          const controls = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, a[href]');
          if (!controls?.length) return;
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }}
        style={{ width: "min(480px, calc(100vw - 32px))", maxHeight: "calc(100dvh - 32px)", overflowY: "auto", boxSizing: "border-box", borderRadius: "var(--radius-lg)", padding: 24, display: "grid", gap: 14 }}
      >
        <div>
          <div id="self-hosted-dialog-title" style={{ fontSize: 16, fontWeight: 700, color: "var(--fg-strong)" }}>
            {editing ? "Edit self-hosted API" : "Connect a self-hosted API"}
          </div>
          <p className="klide-row-description" style={{ margin: "6px 0 0" }}>
            Use your own OpenAI-compatible model server.
          </p>
        </div>

        <div role="group" aria-label="Connection method" style={{ display: "flex", gap: 4, padding: 4, background: "var(--bg-hover)", borderRadius: "var(--radius-md)" }}>
          {([ ["api", "API URL"], ["tailscale", "Tailscale quick setup"] ] as const).map(([id, title]) => (
            <button type="button" key={id} aria-pressed={connection === id} disabled={busy} className="klide-button" onClick={() => chooseConnection(id)}
              style={{ flex: 1, minHeight: 34, justifyContent: "center", background: connection === id ? "var(--bg)" : "transparent", color: connection === id ? "var(--fg-strong)" : "var(--fg-subtle)", border: "1px solid", borderColor: connection === id ? "var(--border)" : "transparent", borderRadius: "var(--radius-sm)" }}>
              {id === "tailscale" && <TailscaleIcon size={16} />}{title}
            </button>
          ))}
        </div>

        <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0, display: "grid", gap: 14 }}>
          <EndpointInput label="Endpoint name" value={provider.label} placeholder="My inference server" onChange={onNameChange} />

          {connection === "api" ? <>
            <EndpointInput label="API base URL" value={provider.baseUrl} placeholder="https://llm.example.com/v1" onChange={onUrlChange} mono />
            <p className="klide-row-description" style={{ margin: "-7px 0 0" }}>
              Paste the server’s OpenAI-compatible base URL, including its API path (usually <code>/v1</code>).
            </p>
          </> : <>
            <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.7, color: "var(--fg-subtle)" }}>
              <li>Connect this Mac and your inference server to the same tailnet.</li>
              <li>Make the running model API reachable on the server’s Tailscale interface.</li>
              <li>Enter its machine address and API port below.</li>
            </ol>
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 80px", gap: 10 }}>
              <EndpointInput label="Tailscale IP or machine name" value={host} placeholder="100.64.1.2 or gpu-box" mono
                onChange={(value) => { setHost(value); onUrlChange(tailscaleEndpointUrl(value, port)); }} />
              <EndpointInput label="API port" value={port} placeholder="8000" mono
                onChange={(value) => { setPort(value); onUrlChange(tailscaleEndpointUrl(host, value)); }} />
            </div>
            <div style={{ fontSize: 12, color: "var(--fg-subtle)", overflowWrap: "anywhere" }}>
              {provider.baseUrl ? <code>{provider.baseUrl}</code> : "Enter a machine address and a port from 1 to 65535."}
            </div>
            <p className="klide-row-description" style={{ margin: 0 }}>
              Uses HTTP over your encrypted tailnet. For HTTPS or a different API path, use API URL.
            </p>
          </>}

          <EndpointInput label="API token reference (optional)" value={provider.tokenRef ?? ""} placeholder="${INFERENCE_API_KEY}" onChange={onTokenChange} mono />
          <p className="klide-row-description" style={{ margin: "-7px 0 0", fontSize: 11 }}>
            If required, enter <code>{"${INFERENCE_API_KEY}"}</code> and keep its value in your workspace’s <code>.env</code> or <code>~/.klide/.env</code>.
          </p>

          <SelfHostedConnectionTest provider={provider} onSelectModel={onModelChange} />

          <button type="button" className="klide-button" aria-expanded={advanced} onClick={() => setAdvanced((value) => !value)} style={{ justifyContent: "flex-start", color: "var(--fg-subtle)", padding: 0 }}>
            {advanced ? "−" : "+"} Model options
          </button>
          {advanced && <>
            <EndpointInput label="Default model ID (optional)" value={provider.defaultModel} onChange={onModelChange} placeholder="Exact model ID reported by the server" mono />
            <p className="klide-row-description" style={{ margin: "-7px 0 0" }}>Set context length on the server. You can also choose a default from the connection test.</p>
          </>}
        </fieldset>

        {error && <div role="alert" style={{ fontSize: 12, color: "var(--danger)" }}>{error}</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className="klide-button klide-button-secondary" disabled={busy} onClick={onCancel}>Cancel</button>
          <LinkButton disabled={busy || !provider.label.trim() || !provider.baseUrl.trim()} onClick={onSave}>
            {busy ? "Saving…" : editing ? "Save changes" : "Add endpoint"}
          </LinkButton>
        </div>
      </div>
    </div>, document.body,
  );
}

function EndpointInput({ label, value, placeholder, onChange, mono }: {
  label: string; value: string; placeholder: string; onChange: (value: string) => void; mono?: boolean;
}) {
  return <label style={{ display: "grid", gap: 6, minWidth: 0 }}>
    <span style={{ fontSize: 12, color: "var(--fg-subtle)" }}>{label}</span>
    <input className="klide-field" aria-label={label} value={value} placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)} autoComplete="off" spellCheck={false}
      style={{ width: "100%", minWidth: 0, boxSizing: "border-box", height: 36, padding: "0 11px", fontFamily: mono ? "var(--font-mono)" : undefined, fontSize: mono ? 12 : undefined }} />
  </label>;
}
