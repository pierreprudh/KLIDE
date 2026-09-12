// Throwaway page for looking at the Focus canvas' corner, state by state.
// Not part of the app: it renders the real components (CompletionCard,
// QuestionCard) against the real tokens, so what you see here is what the
// canvas draws. The plan card is a stand-in — TodoStrip reads its store over
// Tauri IPC, which a browser tab does not have.
//
//   npx vite --port 1421      →  http://localhost:1421/preview-corner.html
//   ?theme=dark | klide-light | sage-garden | cursor-dark | …
//
// The cards are live: click a result to open it, type in a question.
import { useState, type CSSProperties, type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "@fontsource/monaspace-neon/400.css";
import "@fontsource/monaspace-neon/700.css";
import "./src/styles/tokens.css";
import { CompletionCard, ResultEvidence } from "./src/components/ai/CompletionCard";
import { QuestionCard } from "./src/components/ai/QuestionCard";
import { columnGeometry } from "./src/components/ai/canvasColumn";
import { CloseIcon, PlanIcon, ReviewIcon } from "./src/icons";

const THEME = new URLSearchParams(location.search).get("theme") ?? "klide-light";
document.documentElement.dataset.theme = THEME;

const RESULT = {
  runId: "r1",
  completedAt: Date.now(),
  outcome: "Built the Q3 deck and its source.",
  files: ["q3-demo/summary.md"],
  artifacts: [
    { path: "q3-demo/deck.pptx", bytes: 41_000, created: true },
    { path: "q3-demo/summary.docx", bytes: 12_400, created: true },
  ],
  commands: [{ id: "c1", label: "python3 q3-demo/build_deck.py", status: "passed" as const }],
  warnings: [],
};

// A stand-in picture, so the two-step open can be walked without a backend:
// the real host renders the document and hands back a data URI.
const SWATCH =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#f2f1ea"/><rect x="20" y="24" width="180" height="14" fill="#c9c8bd"/><rect x="20" y="52" width="260" height="8" fill="#dddcd2"/><rect x="20" y="70" width="240" height="8" fill="#dddcd2"/><rect x="20" y="112" width="120" height="44" fill="#e6e5da"/></svg>`,
  );

const QUESTION = "The deck is built from summary.md — should the script stay in the folder so it is reproducible?";

/** The column, as AiPanel positions it: top-right, cards stacked with a gap. */
function Column({ width, children }: { width: number; children: ReactNode }) {
  return (
    <div style={{ position: "absolute", top: 16, right: 16, bottom: 16, width, display: "flex", flexDirection: "column", gap: 10, pointerEvents: "none" }}>
      {children}
    </div>
  );
}

/** The head control, drawn as AiPanel draws it (it lives there, not in a card). */
function ColumnClose({ shown, onClose }: { shown: boolean; onClose: () => void }) {
  return (
    <div className="klide-island-close-slot" data-shown={shown ? "1" : undefined}>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button type="button" onClick={onClose} title="Close the side panel" aria-label="Close the side panel"
          style={{ pointerEvents: "auto", width: 24, height: 24, display: "grid", placeItems: "center", padding: 0, border: "none", background: "transparent", color: "var(--fg-dim)", cursor: "pointer" }}>
          <CloseIcon size={14} />
        </button>
      </div>
    </div>
  );
}

/** Stand-in for the plan island — same glass, same header shape. */
function PlanCard() {
  return (
    <section style={{ pointerEvents: "auto", background: "var(--composer-glass)", border: "1px solid var(--composer-border)", borderRadius: 15, backdropFilter: "var(--composer-blur)", padding: "12px 16px 0", overflow: "hidden" }}>
      <div style={{ display: "grid", gridTemplateColumns: "14px minmax(0,1fr) auto 18px", alignItems: "center", columnGap: 12, paddingBottom: 11 }}>
        <span style={{ width: 14, height: 14, borderRadius: "50%", background: "var(--accent)", display: "grid", placeItems: "center", color: "var(--bg-elevated)", fontSize: 8 }}>✓</span>
        <span style={{ color: "var(--fg-subtle)", fontSize: 13 }}>Plan</span>
        <span style={{ color: "var(--fg-subtle)", fontSize: 11, fontFamily: "var(--font-mono)" }}>3/3</span>
        <span style={{ color: "var(--fg-dim)", fontSize: 12, textAlign: "center" }}>✕</span>
      </div>
      <span style={{ display: "block", height: 1, marginLeft: -16, marginRight: -16, background: "var(--border)" }} />
      <div style={{ padding: "10px 0 12px 3px", display: "grid", gap: 9 }}>
        {["Write summary.md", "Convert to .docx", "Build deck.pptx"].map((step) => (
          <div key={step} style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
            <span style={{ flexShrink: 0, width: 14, height: 14, borderRadius: "50%", background: "var(--accent)", display: "grid", placeItems: "center", color: "var(--bg-elevated)", fontSize: 8 }}>✓</span>
            <span style={{ fontSize: 12.5, lineHeight: 1.45, color: "var(--fg-subtle)", textDecoration: "line-through" }}>{step}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

const markPill: CSSProperties = {
  pointerEvents: "auto",
  display: "inline-flex",
  alignItems: "center",
  gap: 7,
  height: 30,
  padding: "0 10px 0 9px",
  borderRadius: 10,
  border: "1px solid var(--composer-border)",
  background: "var(--composer-glass)",
  backdropFilter: "var(--composer-blur)",
  color: "var(--fg-subtle)",
  fontSize: 11,
};

function PlanMark() {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end" }}>
      <span style={markPill}><PlanIcon size={15} /><span style={{ fontFamily: "var(--font-mono)" }}>3/3</span></span>
    </div>
  );
}

function Prose({ inset }: { inset: number }) {
  return (
    <div style={{ padding: `16px ${Math.max(20, inset + 20)}px 16px 20px`, fontSize: 13.5, lineHeight: 1.6, color: "var(--fg)" }}>
      <p style={{ margin: 0 }}>
        <strong style={{ color: "var(--fg-strong)" }}>Done.</strong> The folder has the summary, the .docx and a
        one-slide deck. This paragraph is here to show where the prose ends: it must never run under the corner.
      </p>
    </div>
  );
}

function Case({ title, note, height = 260, children }: { title: string; note: string; height?: number; children: ReactNode }) {
  return (
    <section style={{ display: "grid", gap: 6 }}>
      <h2 style={{ margin: 0, fontSize: 12, fontWeight: 500, color: "var(--fg-strong)" }}>{title}</h2>
      <p style={{ margin: 0, fontSize: 11.5, lineHeight: 1.45, color: "var(--fg-subtle)", minHeight: 32 }}>{note}</p>
      <div style={{ position: "relative", height, overflow: "hidden", borderRadius: 12, border: "1px solid var(--border)", background: "var(--bg)" }}>
        {children}
      </div>
    </section>
  );
}

/** One canvas: the geometry rule decides everything from the slots. */
function Canvas({
  plan,
  result,
  question,
  hidden,
  canvasWidth = 1000,
}: {
  plan: "card" | "mark" | "none";
  result: "card" | "mark" | "none";
  question: boolean;
  hidden: boolean;
  canvasWidth?: number;
}) {
  const [answer, setAnswer] = useState("");
  const [resultUp, setResultUp] = useState(result !== "none");
  const [closed, setClosed] = useState(hidden);
  const column = columnGeometry({ planSlot: plan, resultUp, questionUp: question, hidden: closed, canvasWidth });
  return (
    <>
      <Prose inset={column.inset} />
      <Column width={column.cardsUp ? column.width : 120}>
        <ColumnClose shown={column.showClose} onClose={() => setClosed(true)} />
        {column.cardsUp && plan === "card" && <PlanCard />}
        {(column.cardsUp || column.marksUp) && plan === "mark" && <PlanMark />}
        {resultUp && (
          <CompletionCard
            variant="island"
            compact={column.compact}
            folded={column.planFolded}
            completion={RESULT}
            onReview={() => {}}
            onOpenArtifact={(path) => window.alert(`Full width: ${path}`)}
            onPreviewArtifact={async () => SWATCH}
            onRequestChanges={() => {}}
            onDismiss={() => setResultUp(false)}
            onUnfold={() => setClosed(false)}
          />
        )}
        {question && (
          <QuestionCard
            variant="island"
            question={QUESTION}
            answer={answer}
            onAnswerChange={setAnswer}
            onSubmit={() => setAnswer("")}
            onSkip={() => setAnswer("")}
          />
        )}
      </Column>
    </>
  );
}

function Preview() {
  return (
    <div style={{ padding: 20, display: "grid", gap: 20, gridTemplateColumns: "repeat(auto-fit, minmax(620px, 1fr))", background: "var(--bg-elevated)", color: "var(--fg)", fontFamily: "var(--font-ui)", minHeight: "100vh" }}>
      <Case title="1 · Column open — every entry full width" note="Plan and result are both windows. The head keeps one close; click it to fold the corner to icons.">
        <Canvas plan="card" result="mark" question={false} hidden={false} />
      </Case>
      {/* The rows on their own, at column width: the alignment is easier to
          judge without opening a card first. */}
      <Case title="0 · Document rows, at column width" note="App mark, name over its folder, size, arrow — one row, one baseline." height={330}>
        <div style={{ position: "absolute", top: 12, right: 12, width: 320, background: "var(--composer-glass)", border: "1px solid var(--composer-border)", borderRadius: 15, padding: "4px 16px 0", pointerEvents: "auto" }}>
          <ResultEvidence
            completion={RESULT}
            onReview={() => {}}
            onOpenArtifact={(path) => window.alert(`Full width: ${path}`)}
            onPreviewArtifact={async () => SWATCH}
            onRequestChanges={() => {}}
            onDone={() => {}}
          />
        </div>
      </Case>
      <Case title="2 · Documents open in two steps" note="Open the result, then click a document: the first click previews it here in the panel, the second opens it full width." height={430}>
        <Canvas plan="none" result="mark" question={false} hidden={false} />
      </Case>
      <Case title="3 · Plan folded to its mark" note="Closing the plan leaves its 3/3 mark. The head's close goes with the last card — this was the stray X.">
        <Canvas plan="mark" result="mark" question={false} hidden={false} />
      </Case>
      <Case title="4 · Column closed — icons only" note="Plan and result fold to their marks, and the canvas is whole. Either mark opens the column again.">
        <Canvas plan="mark" result="mark" question={false} hidden />
      </Case>
      <Case title="5 · A question is parked" note="It cannot be closed away — it holds the run. Type in it; ⌘↩ sends, Esc skips." height={330}>
        <Canvas plan="card" result="mark" question hidden />
      </Case>
      <Case title="6 · Narrow canvas (700px)" note="The column shrinks to its 232px floor, and the entries keep their words — narrow is not a third state." height={330}>
        <Canvas plan="card" result="mark" question={false} hidden={false} canvasWidth={700} />
      </Case>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<Preview />);
