// Throwaway page: candidate marks for Kit — the Harness as the person meets it —
// beside the app logo and the delegate marks it will sit next to, at the sizes
// Kit actually appears (34 chat hero, 20 message, 16 Settings nav, 12 rail/tab).
//   npx vite --port 1421  →  http://localhost:1421/preview/kit-mark.html
//   ?theme=dark | sage-garden | cursor-dark | …
import ReactDOM from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "../src/styles/tokens.css";
import { KlideMark, ProviderLogo, DotGridLoader } from "../src/components/ai/icons";
import { AgentMark } from "../src/components/fileMarks";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "klide-light";
(window as any).__TAURI_INTERNALS__ = { transformCallback: (cb: unknown) => cb, unregisterCallback: () => {}, invoke: async () => [] };

type MarkFn = (size: number) => JSX.Element;

/** A — Orbit: one ring, one dot riding it. The working loader, stilled. */
const Orbit: MarkFn = (s) => (
  <svg width={s} height={s} viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <circle cx="8" cy="8" r="5.6" stroke="currentColor" strokeWidth="1.6" />
    <circle cx="12.2" cy="3.8" r="2.3" fill="currentColor" />
  </svg>
);
/** B — Core: one ring with its dot inside, off-centre — one half of the app logo. */
const Core: MarkFn = (s) => (
  <svg width={s} height={s} viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.6" />
    <circle cx="9.6" cy="6.4" r="2.2" fill="currentColor" />
  </svg>
);
/** C — Spark: the four-point star Kit's steering files already wear. */
const Spark: MarkFn = (s) => <AgentMark size={s} />;
/** D — Caret: the editor's cursor with a spark — Kit types with you. */
const Caret: MarkFn = (s) => (
  <svg width={s} height={s} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <rect x="3" y="1.5" width="2.4" height="13" rx="1.2" />
    <path d="M11 4.2 11.9 6.6 14.3 7.5 11.9 8.4 11 10.8 10.1 8.4 7.7 7.5 10.1 6.6Z" />
  </svg>
);

const CANDIDATES: { key: string; name: string; why: string; mark: MarkFn }[] = [
  { key: "orbit", name: "Orbit", why: "The loader at rest — the dot that circles while Kit works, parked. Kit is the ring that moves.", mark: Orbit },
  { key: "core", name: "Core", why: "One of the logo's two rings with its dot, in one colour. Kit is one half of Klide.", mark: Core },
  { key: "spark", name: "Spark", why: "Already the mark on CLAUDE.md / KIT.md. Kit's files wear Kit's mark. Risk: the AI cliché.", mark: Spark },
  { key: "caret", name: "Caret", why: "A text cursor with a spark. Kit lives in the editor, not in a chat window.", mark: Caret },
];

const SIZES = [34, 20, 16, 12];

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", alignItems: "center", gap: 18, padding: "10px 0", borderTop: "1px solid var(--border)" }}>
      <div style={{ fontSize: 12, color: "var(--fg-subtle)" }}>{label}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 28 }}>{children}</div>
    </div>
  );
}

/** The places the mark lives, mocked with real tokens. */
function InContext({ mark }: { mark: MarkFn }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginTop: 10 }}>
      {/* chat turn */}
      <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: "12px 14px", background: "var(--bg-elevated)" }}>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
          <span style={{ width: 22, height: 22, display: "grid", placeItems: "center", color: "var(--fg-strong)" }}>{mark(20)}</span>
          <div style={{ fontSize: 13, lineHeight: 1.5, color: "var(--fg)" }}>The menu opened upward from a trigger 90px below the top edge, so it landed off-screen. I made the direction a preference.</div>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 10, color: "var(--fg-dim)", fontSize: 12 }}>
          <span style={{ width: 22, display: "grid", placeItems: "center" }}><DotGridLoader size={16} color="var(--fg-dim)" /></span>
          Reading src/components/ai/ModelPicker.tsx
        </div>
      </div>
      {/* rail + settings nav */}
      <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: "8px 6px", background: "var(--bg)", fontSize: 12.5 }}>
        {[
          ["Advisor picker off-screen", mark(12), true],
          ["Release notes for 0.6.6", <ProviderLogo id={"claude-code" as any} size={12} />, false],
          ["Memory inbox icon", <ProviderLogo id={"codex" as any} size={12} />, false],
        ].map(([t, m, on], i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", borderRadius: 6, color: on ? "var(--fg-strong)" : "var(--fg-subtle)", background: on ? "var(--bg-hover)" : "transparent" }}>
            <span style={{ width: 14, display: "grid", placeItems: "center", opacity: on ? 1 : 0.8 }}>{m as any}</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t as string}</span>
          </div>
        ))}
        <div style={{ borderTop: "1px solid var(--border)", margin: "8px 4px" }} />
        {[["General"], ["Kit", true], ["Local AI"]].map(([t, on], i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 9, padding: "5px 8px", color: on ? "var(--fg-strong)" : "var(--fg-subtle)" }}>
            <span style={{ width: 16, display: "grid", placeItems: "center" }}>{on ? mark(16) : <span style={{ width: 12, height: 12, borderRadius: 3, border: "1px solid currentColor", opacity: 0.5 }} />}</span>
            {t as string}
          </div>
        ))}
      </div>
    </div>
  );
}

function Page() {
  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--fg)", fontFamily: "var(--font-ui)", padding: "36px 40px 60px", maxWidth: 980 }}>
      <div style={{ fontSize: 18, fontWeight: 700, color: "var(--fg-strong)" }}>A mark for Kit</div>
      <div style={{ fontSize: 13, color: "var(--fg-subtle)", marginTop: 4, marginBottom: 24 }}>
        One colour, filled where it must survive 12px, next to what it will sit beside.
      </div>

      <Row label="Today">
        <span style={{ display: "flex", alignItems: "center", gap: 10 }}><KlideMark size={34} /><span style={{ fontSize: 12, color: "var(--fg-dim)" }}>app logo, also worn by Kit</span></span>
        <span style={{ display: "flex", alignItems: "center", gap: 10 }}><ProviderLogo id={"claude-code" as any} size={20} /><ProviderLogo id={"codex" as any} size={20} /><ProviderLogo id={"anthropic" as any} size={20} /><span style={{ fontSize: 12, color: "var(--fg-dim)" }}>the marks beside it</span></span>
      </Row>

      {CANDIDATES.map((c) => (
        <div key={c.key} style={{ marginTop: 26 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--fg-strong)" }}>{c.name}</div>
            <div style={{ fontSize: 12.5, color: "var(--fg-subtle)" }}>{c.why}</div>
          </div>
          <Row label="Sizes">
            {SIZES.map((s) => (
              <span key={s} style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--fg-strong)" }}>
                {c.mark(s)}<span style={{ fontSize: 11, color: "var(--fg-dim)" }}>{s}</span>
              </span>
            ))}
            <span style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--accent)" }}>{c.mark(20)}<span style={{ fontSize: 11, color: "var(--fg-dim)" }}>accent</span></span>
            <span style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--fg-subtle)" }}>{c.mark(20)}<span style={{ fontSize: 11, color: "var(--fg-dim)" }}>quiet</span></span>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}><KlideMark size={20} /><ProviderLogo id={"claude-code" as any} size={20} /><span style={{ color: "var(--fg-strong)" }}>{c.mark(20)}</span></span>
          </Row>
          <InContext mark={c.mark} />
        </div>
      ))}
    </div>
  );
}
ReactDOM.createRoot(document.getElementById("root")!).render(<Page />);
