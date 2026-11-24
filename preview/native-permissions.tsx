import { useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "../src/styles/tokens.css";
import { NativePermissionSelector } from "../src/components/ai/NativePermissionSelector";
import { DELEGATES } from "../src/delegates";
import type { DelegateId } from "../src/delegates";
import { delegateLabel } from "../src/delegates";
import { ProviderLogo } from "../src/components/ai/icons";

function ComposerPreview({ provider, model, compact = false }: { provider: DelegateId; model: string; compact?: boolean }) {
  const [choice, setChoice] = useState<string | undefined>(provider === "vibe" ? "smart-approve" : "auto");
  return <div style={{ width: compact ? 320 : 640, maxWidth: "100%", marginTop: 24 }}>
    <div style={{ border: "1px solid var(--border)", borderRadius: 16, background: "var(--bg-elevated)", overflow: "hidden" }}>
      <div style={{ padding: "16px 14px", color: "var(--fg-dim)", fontSize: 14 }}>Ask anything…</div>
      <div style={{ display: "flex", alignItems: "center", gap: 2, padding: "6px 8px", borderTop: "1px solid var(--border)" }}>
        <span style={{ width: 26, textAlign: "center", color: "var(--fg-subtle)" }}>＋</span>
        <NativePermissionSelector provider={provider} value={choice} onChange={setChoice} compact />
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "0 8px", fontSize: 12, whiteSpace: "nowrap" }}><ProviderLogo id={provider} size={14} />{delegateLabel(provider)}<span style={{ color: "var(--fg-dim)" }}>⌄</span></span>
        <span style={{ marginLeft: "auto", fontSize: 12, padding: "0 6px", minWidth: 0, maxWidth: compact ? 80 : 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{model}</span>
        <button type="button" aria-label="Reasoning effort: High" title="Reasoning effort: High" style={{ width: 32, height: 24, display: "grid", placeItems: "center", border: 0, color: "var(--fg-subtle)", background: "transparent", flexShrink: 0 }}>
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">{[4, 7, 10, 13].map((height, index) => <rect key={height} x={index * 4} y={14 - height} width="2" height={height} rx="1" fill="currentColor" opacity={index === 3 ? .3 : 1} />)}</svg>
        </button>
        <svg width="18" height="18" viewBox="0 0 18 18" aria-label="Context usage" style={{ margin: "0 5px", flexShrink: 0 }}><circle cx="9" cy="9" r="6" fill="none" stroke="var(--fg-dim)" strokeWidth="1.5" /></svg>
        <span style={{ color: "var(--fg-dim)", padding: "0 6px" }}>↑</span>
      </div>
    </div>
    <div style={{ color: "var(--fg-dim)", fontSize: 11, marginTop: 6 }}>main</div>
  </div>;
}

document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") ?? "klide-light";
function Preview() {
  const [choices, setChoices] = useState<Record<string, string | undefined>>({});
  return <main style={{ minHeight: "100vh", padding: 32, background: "var(--bg)", color: "var(--fg)", fontFamily: "var(--font-ui)" }}>
    <h1 style={{ fontSize: 20 }}>Native agent permissions</h1>
    <p>Small native mode icons between add-context and the provider picker.</p>
    <ComposerPreview provider="claude-code" model="Claude Sonnet" />
    <ComposerPreview provider="vibe" model="Devstral" compact />
    <div style={{ display: "flex", flexWrap: "wrap", gap: 24, marginTop: 48 }}>
      {DELEGATES.map(agent => <div key={agent.id}><p>{agent.label}</p>
        <NativePermissionSelector provider={agent.id} value={choices[agent.id]} onChange={choice => setChoices(previous => ({ ...previous, [agent.id]: choice }))} />
      </div>)}
    </div>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
