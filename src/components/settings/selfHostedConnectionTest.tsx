import { useEffect, useRef, useState } from "react";
import { testCustomProvider, type CustomProvider, type EndpointConnection } from "../../customProviders";

export function SelfHostedConnectionTest({ provider, onSelectModel }: {
  provider: CustomProvider; onSelectModel: (model: string) => void;
}) {
  const [result, setResult] = useState<EndpointConnection | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++; setResult(null); setError(""); setBusy(false);
    return () => { generation.current++; };
  }, [provider.id, provider.baseUrl, provider.tokenRef]);

  async function test() {
    if (busy) return;
    const request = ++generation.current;
    setBusy(true); setError(""); setResult(null);
    try {
      const next = await testCustomProvider(provider);
      if (request === generation.current) setResult(next);
    } catch (e) { if (request === generation.current) setError(String(e)); }
    finally { if (request === generation.current) setBusy(false); }
  }
  return <div style={{ display: "grid", gap: 8, fontSize: 12 }}>
    <button type="button" className="klide-button klide-button-secondary" disabled={busy || !provider.baseUrl.trim()} onClick={() => void test()}>
      {busy ? "Testing connection…" : "Test connection"}
    </button>
    {error && <div role="alert" style={{ color: "var(--danger)" }}>{error}</div>}
    {result && <>
      <div role="status">Connected · {result.models.length} models · {result.elapsedMs} ms</div>
      {result.models.length > 0 ? <label>Choose a default model
        <select className="klide-field" style={{ display: "block", width: "100%", marginTop: 6 }} value={result.models.includes(provider.defaultModel) ? provider.defaultModel : ""} onChange={(e) => onSelectModel(e.target.value)}>
          <option value="">Choose a model</option>
          {result.models.map((model) => <option key={model} value={model}>{model}</option>)}
        </select>
      </label> : <div>The endpoint is reachable but reports no models. Load a model on the server, then test again.</div>}
      <div style={{ color: "var(--fg-subtle)" }}>This checks access and model discovery. Coding and tool support require a separate model test.</div>
    </>}
  </div>;
}
