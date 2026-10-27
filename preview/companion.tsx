// Browser-only fixture for a Klide phone companion — the app you talk to Kit
// with while the Mac keeps the Runs. Three screens side by side: threads,
// a conversation waiting on an approval, and the model sheet that lists only
// what can run right now. `?theme=light|dark`.
import { useState, type CSSProperties, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "@fontsource/monaspace-neon/400.css";
import "../src/styles/tokens.css";
import { KlideMark } from "../src/components/ai/icons";
import { ProviderModelMark } from "../src/modelIdentity";
import { CheckIcon, ChevronIcon, SendIcon, TerminalIcon } from "../src/icons";
import type { ProviderId } from "../src/agent/types";

type Model = { provider: ProviderId; model: string; name: string; detail: string; unusable?: string; action?: string };

const STARRED: Model[] = [
  { provider: "anthropic", model: "claude-opus-4-5", name: "Claude Opus", detail: "API · 200k · Keychain" },
  { provider: "ollama", model: "llama3.1:8b", name: "Llama 3.1 8B", detail: "This Mac · 16k · loaded" },
];
const GROUPS: { title: string; rows: Model[] }[] = [
  { title: "This Mac", rows: [
    { provider: "ollama", model: "qwen3.5:9b", name: "Qwen 3.5 9B", detail: "Ollama · 32k · tools" },
    { provider: "mlx", model: "gemma4-12b-mtp", name: "Gemma 4 12B", detail: "MLX · stopped", unusable: "Server stopped", action: "Start" },
  ] },
  { title: "Subscriptions", rows: [
    { provider: "claude-code", model: "default", name: "Claude Code", detail: "Signed in · Max" },
    { provider: "codex", model: "default", name: "Codex", detail: "Signed in · Pro" },
  ] },
  { title: "API", rows: [
    { provider: "openrouter", model: "deepseek/deepseek-v3.2", name: "DeepSeek V3.2", detail: "OpenRouter · 128k · $" },
    { provider: "mistral", model: "mistral-large-latest", name: "Mistral Large", detail: "Mistral", unusable: "Not on your plan" },
    { provider: "xai", model: "grok-4", name: "Grok 4", detail: "xAI", unusable: "No key" },
  ] },
];

const text = { strong: "var(--fg-strong)", muted: "var(--fg-muted)", dim: "var(--fg-dim)" };

function Phone({ label, children }: { label: string; children: ReactNode }) {
  return (
    <figure style={{ margin: 0, display: "grid", gap: 12, justifyItems: "center" }}>
      <div style={{
        width: 390, height: 844, borderRadius: 48, border: "1px solid var(--border-strong)",
        background: "var(--bg)", overflow: "hidden", position: "relative", display: "flex", flexDirection: "column",
      }}>
        <div style={{ height: 54, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 32px", fontSize: 15, fontWeight: 700, color: text.strong }}>
          <span>9:41</span><span style={{ width: 120, height: 34, borderRadius: 20, background: "var(--fg-strong)", opacity: 0.9 }} /><span style={{ width: 24 }} />
        </div>
        {children}
      </div>
      <figcaption style={{ fontSize: 12, color: text.dim }}>{label}</figcaption>
    </figure>
  );
}

/* ── 1 · Threads ─────────────────────────────────────────────────────────── */

function Threads() {
  const thread = (title: string, project: string, when: string, provider: ProviderId, model: string, state?: "working" | "waiting") => (
    <div style={{ display: "flex", gap: 12, padding: "12px 20px" }}>
      <ProviderModelMark provider={provider} model={model} size={26} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <span style={{ fontSize: 15, fontWeight: state ? 700 : 400, color: text.strong, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</span>
          <span style={{ fontSize: 12, color: text.dim, flexShrink: 0 }}>{when}</span>
        </div>
        <div style={{ fontSize: 13, color: state === "waiting" ? "var(--accent)" : text.muted, marginTop: 2 }}>
          {state === "waiting" ? "Waiting on you · 1 edit to review" : state === "working" ? "Working · 4m" : project}
        </div>
      </div>
    </div>
  );
  return (
    <>
      <header style={{ padding: "8px 20px 18px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <KlideMark size={22} />
          <span style={{ fontSize: 26, fontWeight: 700, color: text.strong, letterSpacing: -0.3 }}>Kit</span>
        </div>
        <div style={{ fontSize: 13, color: text.muted, marginTop: 6 }}>On Pierre’s MacBook Pro · reachable · 2 running</div>
      </header>
      <div style={{ flex: 1, overflow: "auto" }}>
        <Section title="Now">
          {thread("Fix the compaction marker replay", "KLIDE", "now", "anthropic", "claude-opus-4-5", "waiting")}
          {thread("Benchmark qwen3.5 tool calls", "KLIDE", "4m", "ollama", "qwen3.5:9b", "working")}
        </Section>
        <Section title="Earlier">
          {thread("Release notes for 0.6.11", "KLIDE", "2h", "claude-code", "default")}
          {thread("Why is the sheet surface slow?", "KLIDE", "Yesterday", "codex", "default")}
          {thread("Draft the Orb comparison", "notes", "Fri", "openrouter", "deepseek/deepseek-v3.2")}
        </Section>
      </div>
      <Composer placeholder="Ask Kit about any project…" model={STARRED[0]} />
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ marginBottom: 18 }}>
      <div style={{ padding: "0 20px 4px", fontSize: 12, color: text.dim }}>{title}</div>
      {children}
    </section>
  );
}

/* ── 2 · Conversation waiting on an approval ─────────────────────────────── */

function Conversation() {
  const [answer, setAnswer] = useState<null | "approved" | "rejected">(null);
  return (
    <>
      <header style={{ padding: "4px 16px 12px", display: "flex", alignItems: "center", gap: 10, borderBottom: "1px solid var(--border)" }}>
        <span style={{ display: "inline-flex", transform: "rotate(90deg)", color: text.muted }}><ChevronIcon size={18} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: text.strong }}>Fix the compaction marker replay</div>
          <div style={{ fontSize: 12, color: text.muted }}>KLIDE · Work</div>
        </div>
        <ProviderModelMark provider="anthropic" model="claude-opus-4-5" size={24} />
      </header>
      <div style={{ flex: 1, overflow: "auto", padding: "16px 18px", fontSize: 15, lineHeight: 1.55, color: text.strong }}>
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 16 }}>
          <div style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 12, padding: "9px 13px", maxWidth: "82%" }}>
            The kept-turns count is off by one after a replay. Find it and fix it.
          </div>
        </div>
        <div style={{ fontSize: 13, color: text.muted, marginBottom: 10 }}>Worked for 1m 12s ›</div>
        <p style={{ margin: "0 0 14px" }}>
          Found it — <code style={{ fontFamily: "var(--font-mono)", fontSize: 13 }}>effective_events</code> counts the marker itself as a kept turn. One line in <code style={{ fontFamily: "var(--font-mono)", fontSize: 13 }}>compaction.rs</code>:
        </p>
        <div style={{ border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden", fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.7 }}>
          <div style={{ padding: "8px 12px", fontFamily: "var(--font-ui)", fontSize: 13, color: text.muted, borderBottom: "1px solid var(--border)" }}>src-tauri/src/agent/compaction.rs <span style={{ color: text.dim }}>· +1 −1</span></div>
          <div style={{ padding: "0 12px", background: "var(--diff-remove-bg)" }}>- let kept = marker_index + 1;</div>
          <div style={{ padding: "0 12px", background: "var(--diff-add-bg)" }}>+ let kept = marker_index;</div>
        </div>
        {answer === null ? (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 10 }}>
            <button onClick={() => setAnswer("rejected")} style={button(false)}>Reject</button>
            <button onClick={() => setAnswer("approved")} style={button(true)}>Apply</button>
          </div>
        ) : (
          <div style={{ fontSize: 13, color: text.muted, marginTop: 10, display: "flex", alignItems: "center", gap: 6 }}>
            {answer === "approved" ? <><CheckIcon size={14} /> Applied from your phone · running cargo test</> : "Rejected — Kit will try another way"}
          </div>
        )}
        <div style={{ fontSize: 13, color: text.dim, marginTop: 18, display: "flex", alignItems: "center", gap: 6 }}>
          <TerminalIcon size={14} /> Commands still ask here first. Full auto stays on the Mac.
        </div>
      </div>
      <Composer placeholder="Reply, or tell Kit what to change…" model={STARRED[0]} />
    </>
  );
}

const button = (primary: boolean): CSSProperties => ({
  height: 44, borderRadius: 10, fontFamily: "var(--font-ui)", fontSize: 15, fontWeight: 700, cursor: "pointer",
  border: primary ? "none" : "1px solid var(--border-strong)",
  background: primary ? "var(--control-primary-bg)" : "transparent",
  color: primary ? "var(--control-primary-fg)" : "var(--fg-strong)",
});

function Composer({ placeholder, model }: { placeholder: string; model: Model }) {
  return (
    <div style={{ padding: "10px 14px 30px", borderTop: "1px solid var(--border)" }}>
      <div style={{ border: "1px solid var(--border-strong)", borderRadius: 14, padding: "10px 12px", display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ flex: 1, fontSize: 15, color: text.dim }}>{placeholder}</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: text.muted }}>
          <ProviderModelMark provider={model.provider} model={model.model} size={18} />{model.name}
        </span>
        <span style={{ color: text.strong, display: "inline-flex" }}><SendIcon size={18} /></span>
      </div>
    </div>
  );
}

/* ── 3 · Model sheet — only what can run now ─────────────────────────────── */

function ModelSheet() {
  const [picked, setPicked] = useState("claude-opus-4-5");
  const [showHidden, setShowHidden] = useState(false);
  const usable = GROUPS.map((g) => ({ ...g, rows: g.rows.filter((r) => !r.unusable) }));
  const hidden = GROUPS.flatMap((g) => g.rows.filter((r) => r.unusable));

  const row = (m: Model) => {
    const off = Boolean(m.unusable);
    return (
      <div key={m.model} onClick={() => !off && setPicked(m.model)}
        style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 20px", cursor: off ? "default" : "pointer", opacity: off ? 0.55 : 1 }}>
        <ProviderModelMark provider={m.provider} model={m.model} size={26} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, color: text.strong, fontWeight: picked === m.model ? 700 : 400 }}>{m.name}</div>
          <div style={{ fontSize: 12, color: text.muted }}>{off ? m.unusable : m.detail}</div>
        </div>
        {m.action ? <span style={{ fontSize: 13, color: "var(--accent)", opacity: 1 / 0.55 }}>{m.action}</span>
          : picked === m.model && <span style={{ color: text.strong, display: "inline-flex" }}><CheckIcon size={16} /></span>}
      </div>
    );
  };

  return (
    <>
      <div style={{ flex: 1, opacity: 0.35, pointerEvents: "none", overflow: "hidden" }}><Conversation /></div>
      <div style={{ position: "absolute", inset: 0, background: "var(--modal-scrim)" }} />
      <div style={{
        position: "absolute", left: 0, right: 0, bottom: 0, height: "78%", background: "var(--bg)",
        borderTop: "1px solid var(--border-strong)", borderRadius: "24px 24px 0 0", display: "flex", flexDirection: "column",
      }}>
        <div style={{ width: 36, height: 5, borderRadius: 3, background: "var(--border-strong)", margin: "8px auto 0" }} />
        <div style={{ padding: "14px 20px 10px" }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: text.strong }}>Model</div>
          <div style={{ fontSize: 13, color: text.muted, marginTop: 2 }}>Only what can answer right now · checked on your Mac</div>
        </div>
        <div style={{ flex: 1, overflow: "auto", paddingBottom: 24 }}>
          <Section title="Starred">{STARRED.map(row)}</Section>
          {usable.map((g) => <Section key={g.title} title={g.title}>{g.rows.map(row)}</Section>)}
          <div onClick={() => setShowHidden(!showHidden)} style={{ padding: "6px 20px", fontSize: 13, color: text.muted, cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ display: "inline-flex", transform: showHidden ? "none" : "rotate(-90deg)", transition: "transform var(--motion-fast) var(--ease-out)" }}><ChevronIcon size={12} /></span>
            {hidden.length} not usable now
          </div>
          {showHidden && hidden.map(row)}
        </div>
      </div>
    </>
  );
}

function Preview() {
  return (
    <main style={{ padding: "36px 24px", fontFamily: "var(--font-ui)", display: "flex", gap: 40, justifyContent: "center", flexWrap: "wrap" }}>
      <Phone label="Threads — every project, running ones first"><Threads /></Phone>
      <Phone label="A conversation waiting on you"><Conversation /></Phone>
      <Phone label="Model — only usable choices"><ModelSheet /></Phone>
    </main>
  );
}

document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") ?? "light";
createRoot(document.getElementById("root")!).render(<Preview />);
