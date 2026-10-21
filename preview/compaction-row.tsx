// Throwaway page for the compaction row between "Worked for" rows, in the
// states it has. Not part of the app.
//
//   npx vite --port 1422  →  http://localhost:1422/preview/compaction-row.html
//   ?theme=klide-light | dark | …
import ReactDOM from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "@fontsource/monaspace-neon/400.css";
import "../src/styles/tokens.css";
import { CompactionRow, FoldLine, foldLineStyle } from "../src/components/ai/ChatMessage";
import { KlideMark } from "../src/components/ai/icons";

const THEME = new URLSearchParams(location.search).get("theme") ?? "klide-light";
document.documentElement.dataset.theme = THEME;

// A folded run row as the panel draws it: the mark in the 22px gutter, the
// disclosure line in the text column, a hairline under it.
function WorkedFor({ label }: { label: string }) {
  return (
    <div style={{ display: "flex", gap: 10, margin: "14px 0 8px" }}>
      <span style={{ width: 22, height: 22, display: "grid", placeItems: "center", flexShrink: 0 }}><KlideMark size={15} /></span>
      <div style={{ flex: 1, ...foldLineStyle, borderBottom: "1px solid var(--border)", paddingBottom: 6 }}>
        <FoldLine expanded={false}>{label}</FoldLine>
      </div>
    </div>
  );
}

const SUMMARY = `- Goal: one line per file for eight source files.
- Read so far: providers.ts, panelHost.ts, attachments.ts.

The user's requests in the folded turns, verbatim (oldest first):
1. Read these files one at a time with read_file, then give me one line on what each does…

Already done in the folded turns — reopen a stored result with peek_value instead of running the call again:
- read_file src/agent/providers.ts — result stored: peek_value id "call_0vdt5pty"
- read_file src/components/ai/panelHost.ts — result stored: peek_value id "call_gv4d07cr"`;

function App() {
  return (
    <div style={{ background: "var(--bg)", minHeight: "100vh", padding: "24px 40px", fontFamily: "var(--font-ui)" }}>
      <div style={{ width: 720 }}>
        <WorkedFor label="Worked for 52.6s" />
        <div style={{ margin: "6px 0 8px" }}><CompactionRow count={5} summary={SUMMARY} /></div>
        <WorkedFor label="Worked for 1m 14.9s" />
        <div style={{ margin: "6px 0 8px" }}><CompactionRow count={9} summary={SUMMARY} /></div>
        <WorkedFor label="Worked for 1m 2.2s" />
        <div style={{ margin: "26px 0 6px", fontSize: 11, color: "var(--fg-dim)" }}>opened</div>
        <OpenRow />
        <div style={{ margin: "26px 0 6px", fontSize: 11, color: "var(--fg-dim)" }}>running · failed · manual (/compact)</div>
        <div style={{ margin: "6px 0 8px" }}><CompactionRow status="running" /></div>
        <div style={{ margin: "6px 0 8px" }}><CompactionRow error="Nothing to compact yet — every turn is still recent." /></div>
        <CompactionRow source="manual" count={4} summary={SUMMARY} messages={4} toolCalls={8} />
      </div>
    </div>
  );
}

// The same row with its <details> open, to show the summary.
function OpenRow() {
  return (
    <div style={{ margin: "6px 0 8px" }} ref={(el) => { const d = el?.querySelector("details"); if (d && !d.open) d.open = true; }}>
      <CompactionRow count={9} summary={SUMMARY} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
