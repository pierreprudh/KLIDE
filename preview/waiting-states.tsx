// Throwaway: what the panel shows while a non-streaming Delegate turn is
// silent, and what a turn killed with the app should read as afterwards.
// Three states side by side, real tokens, real marks, real loader.
import { useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { AssistantPlaceholderLoader, KlideMark, ProviderLogo } from "../src/components/ai/icons";
import "../src/styles/tokens.css";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/monaspace-neon/400.css";

const MONO = { fontFamily: "var(--font-mono)", fontSize: 11.5 } as const;

function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function UserBubble({ text }: { text: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "flex-start", gap: 10, margin: "14px 0 8px" }}>
      <div style={{ background: "color-mix(in srgb, var(--accent) 22%, var(--bg-elevated))", color: "var(--fg-strong)", fontSize: 13, lineHeight: 1.5, padding: "9px 14px", borderRadius: 14, maxWidth: 420 }}>{text}</div>
      <div aria-hidden style={{ width: 22, height: 22, borderRadius: "50%", background: "var(--fg-dim)", flexShrink: 0, opacity: 0.5 }} />
    </div>
  );
}

function ReplyRow({ children, mark = true }: { children: ReactNode; mark?: boolean }) {
  return (
    <div style={{ display: "flex", gap: 10, margin: "14px 0 8px" }}>
      <div aria-hidden style={{ flexShrink: 0, width: 22, height: 22, marginTop: 1, display: "grid", placeItems: "center" }}>
        {mark ? <ProviderLogo id="opencode" size={18} /> : <KlideMark size={20} />}
      </div>
      <div style={{ flex: 1, minWidth: 0, color: "var(--fg-strong)", fontSize: 13, lineHeight: 1.6 }}>{children}</div>
    </div>
  );
}

// B — the proposal. The word from runPresentation ("Working") and a clock
// that counts, where the first token would land. Nothing animates.
function WorkingLine({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(t); }, []);
  return (
    <span style={{ ...MONO, color: "var(--fg-dim)", letterSpacing: "0.02em", display: "inline-flex", alignItems: "center", height: 22, gap: 8 }}>
      <span>Working</span>
      <span aria-hidden style={{ opacity: 0.6 }}>·</span>
      <span style={{ fontVariantNumeric: "tabular-nums" }}>{clock(now - startedAt)}</span>
    </span>
  );
}

// C — a killed turn. The RunFailedRow family (centered, hairlines), but it is
// not a failure: quiet ink, one plain verb to move on.
function InterruptedRow() {
  const hairline = <span aria-hidden style={{ height: 1, flex: "1 1 44px", minWidth: 28, maxWidth: 72, background: "color-mix(in srgb, var(--border) 82%, transparent)" }} />;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 5, width: "100%", margin: "16px 0 10px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, width: "100%", maxWidth: "min(520px, 100%)" }}>
        {hairline}
        <span style={{ ...MONO, color: "var(--fg-subtle)", fontWeight: 500, flexShrink: 0 }}>Interrupted</span>
        {hairline}
      </div>
      <div style={{ ...MONO, color: "var(--fg-subtle)", textAlign: "center", lineHeight: 1.5 }}>
        Klide closed before this turn answered.{" "}
        <button type="button" style={{ ...MONO, background: "none", border: 0, padding: 0, color: "var(--fg)", cursor: "pointer", textDecoration: "underline", textDecorationColor: "var(--border)", textUnderlineOffset: 3 }}>Retry</button>
      </div>
    </div>
  );
}

function Column({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return (
    <section style={{ flex: "1 1 320px", minWidth: 300, maxWidth: 460 }}>
      <h2 style={{ fontSize: 12, fontWeight: 400, color: "var(--fg-dim)", margin: "0 0 4px", letterSpacing: "0.04em", textTransform: "uppercase" }}>{title}</h2>
      <p style={{ fontSize: 12, color: "var(--fg-subtle)", margin: "0 0 18px", lineHeight: 1.5, minHeight: 36 }}>{note}</p>
      <div style={{ border: "1px solid var(--border)", borderRadius: 12, padding: "18px 20px 22px", background: "var(--bg)" }}>{children}</div>
    </section>
  );
}

function Page() {
  const [theme, setTheme] = useState(new URLSearchParams(location.search).get("theme") ?? "cursor-dark");
  const [startedAt] = useState(() => Date.now() - 38_000);
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  const prompt = "I need something more detailed please you can do more schemas";
  return (
    <main style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--fg)", fontFamily: "var(--font-ui)", padding: "40px 32px" }}>
      <header style={{ display: "flex", alignItems: "baseline", gap: 16, marginBottom: 32 }}>
        <h1 style={{ fontSize: 15, fontWeight: 400, margin: 0 }}>Waiting on a turn that does not stream</h1>
        <button type="button" onClick={() => setTheme(theme === "cursor-dark" ? "klide-light" : "cursor-dark")} style={{ ...MONO, background: "none", border: "1px solid var(--border)", borderRadius: 6, padding: "3px 9px", color: "var(--fg-dim)", cursor: "pointer" }}>{theme === "cursor-dark" ? "light" : "dark"}</button>
      </header>
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "flex-start" }}>
        <Column title="A · today" note="The streaming loader, for the whole 61 s. It promises a token any second; none comes until the answer is complete.">
          <UserBubble text={prompt} />
          <ReplyRow><AssistantPlaceholderLoader /></ReplyRow>
        </Column>
        <Column title="B · proposed" note="Same slot. The run's status word and a clock that counts. Static ink, so a minute of silence reads as progress.">
          <UserBubble text={prompt} />
          <ReplyRow><WorkingLine startedAt={startedAt} /></ReplyRow>
        </Column>
        <Column title="C · after a kill" note="The transcript ends on your message. Today: nothing. Proposed: one quiet line in the Run-failed family, and a verb.">
          <UserBubble text={prompt} />
          <InterruptedRow />
        </Column>
      </div>
      <p style={{ ...MONO, color: "var(--fg-subtle)", marginTop: 36, maxWidth: 720, lineHeight: 1.6 }}>
        Rule: B replaces A only on the Delegate headless path (OpenCode, Codex, Claude Code in Focus), which delivers its text in one piece. Harness runs keep the loader, because they stream. C shows whenever the tail is non-terminal and Rust holds no live run.
      </p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Page />);
