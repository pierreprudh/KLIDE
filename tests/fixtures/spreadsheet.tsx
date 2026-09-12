/** Browser QA fixture. Uses the production component with in-memory IPC. */
import React from "react";
import { createRoot } from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import { SpreadsheetViewer } from "../../src/components/SpreadsheetViewer";
import { encodeBytes } from "../../src/spreadsheets/files";
import "../../src/styles/tokens.css";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";

const sample = { version: 1, sheets: [
  { name: "Overview", widths: [30, 18, 18, 18], cells: {
    A1: { value: "Studio budget", bold: true, color: "365D43" },
    A2: { value: "September 2026 · Working forecast" },
    A4: { value: "Category", bold: true, fill: "E7EDE4" }, B4: { value: "Budget", bold: true, fill: "E7EDE4" }, C4: { value: "Actual", bold: true, fill: "E7EDE4" }, D4: { value: "Remaining", bold: true, fill: "E7EDE4" },
    A5: { value: "Design & research" }, B5: { value: 12000, format: "#,##0" }, C5: { value: 8500, format: "#,##0" }, D5: { value: "=B5-C5", format: "#,##0" },
    A6: { value: "Engineering" }, B6: { value: 24000, format: "#,##0" }, C6: { value: 18200, format: "#,##0" }, D6: { value: "=B6-C6", format: "#,##0" },
    A7: { value: "Operations" }, B7: { value: 6000, format: "#,##0" }, C7: { value: 4100, format: "#,##0" }, D7: { value: "=B7-C7", format: "#,##0" },
    A9: { value: "Total", bold: true }, B9: { value: "=SUM(B5:B7)", bold: true, format: "#,##0" }, C9: { value: "=SUM(C5:C7)", bold: true, format: "#,##0" }, D9: { value: "=SUM(D5:D7)", bold: true, format: "#,##0" },
    A12: { value: "Available budget" }, B12: { value: "=D9/B9", format: "0.0%", color: "365D43", bold: true },
  } },
  { name: "Assumptions", cells: { A1: { value: "Contingency rate", bold: true }, B1: { value: 0.1, format: "0%" }, A3: { value: "Total available" }, B3: { value: "=Overview!D9", format: "#,##0" } } },
] };
const files = new Map([["/fixture/budget.sheet.json", encodeBytes(new TextEncoder().encode(JSON.stringify(sample)))]]);
mockIPC((command, args) => {
  const payload = args as { path: string; content: string; expected: string | null };
  if (command === "read_file_data_uri") return `data:application/octet-stream;base64,${files.get(payload.path)}`;
  if (command === "spreadsheet_version") return files.get(payload.path) ?? "missing";
  if (command === "save_spreadsheet") {
    if (payload.expected === null && files.has(payload.path)) throw new Error("A file already exists at that path. Choose a new name.");
    if (payload.expected !== null && files.get(payload.path) !== payload.expected) throw new Error("This file changed on disk. Reload it or save your edits under a new name.");
    files.set(payload.path, payload.content); return;
  }
  throw new Error(`Unexpected command: ${command}`);
});
function Fixture() {
  const [open, setOpen] = React.useState(true);
  const [path, setPath] = React.useState("budget.sheet.json");
  const [draft, setDraft] = React.useState("");
  return <><div style={{ padding: 32, maxWidth: "24vw", fontFamily: "var(--font-ui)", color: "var(--fg-strong)" }}>
    <p style={{ fontSize: 11, color: "var(--fg-subtle)", letterSpacing: 2 }}>FOCUS</p><h2 style={{ fontWeight: 500 }}>A little more room<br />to work with numbers.</h2>
    <p style={{ color: "var(--fg-subtle)", fontSize: 13, lineHeight: 1.7 }}>Your workbook lives beside the conversation. Edit an input and its formulas update across every sheet.</p>
    <textarea aria-label="Chat draft" value={draft} onChange={e => setDraft(e.target.value)} placeholder="Ask about this spreadsheet…" style={{ width: "100%", minHeight: 90, marginTop: 30, background: "var(--bg-elevated)", color: "var(--fg-strong)", border: "1px solid var(--border)", borderRadius: 10, padding: 12 }} />
    <p><button onClick={() => { setPath("budget.sheet.json"); setOpen(true); }}>Open sample</button> <button onClick={() => { setPath(""); setOpen(true); }}>New workbook</button></p>
    <button onClick={() => document.documentElement.setAttribute("data-theme", document.documentElement.getAttribute("data-theme") ? "" : "sage-garden-dark")}>Toggle theme</button>
    <button onClick={() => {
      const updated = structuredClone(sample); updated.sheets[0].cells.B5.value = 20000;
      files.set("/fixture/budget.sheet.json", encodeBytes(new TextEncoder().encode(JSON.stringify(updated))));
    }}>Simulate external edit</button>
  </div>{open && <SpreadsheetViewer key={path} workspaceRoot="/fixture" path={path} onClose={() => setOpen(false)} onOpenExternal={() => {}} onAddToChat={text => setDraft(current => `${current}${current ? "\n\n" : ""}${text}`)} />}</>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
