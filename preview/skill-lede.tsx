// Throwaway page for the skill lede — what a wired skill looks like once it's
// typed into a composer. It renders the real SkillTokenLede against the real
// tokens, in both composer geometries (Focus's card, the AI panel's box), so
// what you see here is what the app draws. The surrounding chrome is a
// stand-in: FocusMode and AiPanel both read Tauri IPC on mount.
//
//   npx vite --port 1421      →  http://localhost:1421/preview/skill-lede.html
//   ?theme=dark | klide-light | sage-garden | cursor-dark | …
//
// Type `/visualise ` (or accept it from the fake menu) and the command becomes
// the skill. Backspace at the head of the line takes it off again.
import { useState, type CSSProperties } from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "@fontsource/monaspace-neon/400.css";
import "@fontsource/monaspace-neon/700.css";
import "../src/styles/tokens.css";
import { SkillTokenLede } from "../src/components/ai/SkillTokenLede";
import { joinSkillToken, splitSkillToken } from "../src/components/ai/skillToken";
import type { Skill } from "../src/skills";
import { NewTaskIcon } from "../src/icons";

const THEME = new URLSearchParams(location.search).get("theme") ?? "klide-light";
document.documentElement.dataset.theme = THEME;

const SKILLS: Skill[] = [
  { id: "visualise", name: "visualise", description: "Render inline visuals.", instructions: "", tools: [], enabled: true },
];

function Composer({ variant }: { variant: "focus" | "panel" }) {
  const [draft, setDraft] = useState("/visualise ");
  const [el, setEl] = useState<HTMLTextAreaElement | null>(null);
  const [indent, setIndent] = useState(0);
  const { token, body } = splitSkillToken(draft, SKILLS);

  const panelStyle: CSSProperties = {
    width: "100%", minHeight: 40, maxHeight: 168, resize: "none", background: "transparent",
    border: "none", color: "var(--fg-strong)", font: "inherit", fontSize: 13.5, lineHeight: 1.55,
    padding: "12px 14px 8px", outline: "none", display: "block",
    textIndent: token ? indent : undefined,
  };

  const textarea = (
    <textarea
      ref={setEl}
      className="klide-composer-textarea"
      value={body}
      placeholder="Ask anything, @ to attach a file…"
      rows={variant === "focus" ? 2 : 1}
      onChange={(e) => setDraft(joinSkillToken(token, e.target.value))}
      onKeyDown={(e) => {
        if (token && e.key === "Backspace" && e.currentTarget.selectionStart === 0 && e.currentTarget.selectionEnd === 0) {
          e.preventDefault();
          setDraft(body);
        }
      }}
      style={variant === "panel" ? panelStyle : token ? { textIndent: indent } : undefined}
    />
  );

  const inner = (
    <div style={{ position: "relative", zIndex: 1 }}>
      {token && (
        <SkillTokenLede token={token} textarea={el} onRemove={() => setDraft(body)} onWidth={setIndent} />
      )}
      {textarea}
    </div>
  );

  if (variant === "focus") {
    return (
      <div className="klide-focus-composer-dock" style={{ width: 620 }}>
        <div style={{ position: "relative" }}>
          <div className="klide-focus-composer" data-focused="true">
            {inner}
            <div className="klide-focus-composer-footer">
              <div className="klide-focus-provider-control" style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--fg-subtle)", fontSize: 12 }}>
                <NewTaskIcon size={15} />
                <span>Ask for approval</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div style={{ width: 420, border: "1px solid var(--accent)", borderRadius: "var(--radius-lg)", background: "var(--bg-elevated)", overflow: "hidden" }}>
      {inner}
      <div style={{ padding: "6px 8px", borderTop: "1px solid color-mix(in srgb, var(--border) 30%, transparent)", color: "var(--fg-subtle)", fontSize: 11 }}>Goal · review every edit</div>
    </div>
  );
}

function Page() {
  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--fg)", font: "400 14px/1.5 var(--font-ui)", display: "flex", flexDirection: "column", gap: 56, alignItems: "center", padding: "72px 24px" }}>
      <div style={{ color: "var(--fg-dim)", fontSize: 12 }}>Type <code>/visualise </code> — the command becomes the skill. Backspace at the head of the line removes it.</div>
      <Composer variant="focus" />
      <Composer variant="panel" />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<Page />);
