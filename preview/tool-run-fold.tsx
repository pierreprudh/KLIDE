// Browser-only fixture for the "N tool calls" fold: the same pieces AiPanel's
// stackToolRuns composes (toolRuns.ts + ToolRunRow + renderMessageBody), fed a
// transcript shaped like the one in the screenshot — a thought before every
// call. `?open=1` starts the fold open; `?theme=light|dark`.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "@fontsource/monaspace-neon/400.css";
import "@fontsource/monaspace-neon/700.css";
import "../src/styles/tokens.css";
import { renderMessageBody, ToolRunRow, type AttachedResult } from "../src/components/ai/ChatMessage";
import { groupToolRuns, pairToolResults, toolCallKey, toolRunLabel } from "../src/components/ai/toolRuns";
import { KlideMark } from "../src/components/ai/icons";
import type { Msg } from "../src/components/ai/types";

const timed = new URLSearchParams(location.search).get("timed") !== "0";
const step = (thinking: string, thinkingMs: number, name: string, args: Record<string, unknown>, result: string): Msg[] => [
  { role: "assistant", content: "", thinking, ...(timed ? { thinkingMs } : { meta: { ms: thinkingMs * 6 } }), toolCalls: [{ id: `c-${name}-${thinkingMs}`, name, args }] },
  { role: "tool", content: result, toolName: name, toolCallId: `c-${name}-${thinkingMs}` },
];
const msgs: Msg[] = [
  { role: "user", content: "Add a “Keyboard shortcuts” step to the README quick start." },
  ...step("Start from the top: what does the README already say?", 700, "list_dir", { path: "." }, "README.md\nCLAUDE.md\nsrc/\nsrc-tauri/"),
  ...step("The quick start is in the README. Read it.", 1400, "read_file", { path: "README.md" }, "# Klide\n\n## Once Klide opens\n1. Open a folder\n2. ⌘P to jump to a file\n3. ⌘⇧P for commands\n4. Tab toggles mode"),
  ...step("Verify the claims before touching them — ⌘/ is the cheatsheet?", 1500, "peek_value", { path: "src/shortcuts.ts", key: "cheatsheet" }, "cheatsheet: { key: \"/\", meta: true }"),
  ...step("And ⌘P / ⌘⇧P — confirm both are still bound that way.", 1000, "read_file", { path: "src/shortcuts.ts" }, "export const SHORTCUTS = { goToFile: \"⌘P\", commands: \"⌘⇧P\", cheatsheet: \"⌘/\" }"),
  ...step("The step list is a numbered list; a fifth item fits after Tab.", 1700, "grep", { pattern: "Tab toggles", path: "README.md" }, "README.md:14: 4. Tab toggles mode"),
  { role: "assistant", content: "", thinking: "The README's \"Once Klide opens\" 4-step list is the flow we would match. ⌘P go to file, ⌘⇧P command palette, ⌘/ cheatsheet — all true. Now add a fifth step.", thinkingMs: 500 },
  { role: "assistant", content: "The quick start's four steps are accurate. I'll add a fifth, **⌘/ opens the keyboard cheatsheet**, right after the Tab step." },
];

function Fold() {
  const pairing = pairToolResults(msgs);
  const [run] = groupToolRuns(msgs, pairing);
  const [open, setOpen] = useState(new URLSearchParams(location.search).get("open") === "1");
  const { thought, count, names } = toolRunLabel(run);
  const row = (m: Msg, i: number) => {
    if (pairing.claimed.has(i)) return null;
    const mine = pairing.byCall.get(i);
    const results = mine && m.role === "assistant"
      ? new Map<string, AttachedResult>(m.toolCalls!.map((tc, k) => [toolCallKey(tc, k), { msg: msgs[mine.get(toolCallKey(tc, k))!] as Extract<Msg, { role: "tool" }>, active: false }]))
      : undefined;
    return <div key={i} style={{ display: "flex", gap: 10, margin: "6px 0 0" }}><div style={{ width: 22, flexShrink: 0 }} /><div style={{ flex: 1, minWidth: 0 }}>{renderMessageBody(m, false, { results })}</div></div>;
  };
  return (
    <main style={{ padding: "28px 24px", maxWidth: 640, margin: "auto", fontFamily: "var(--font-ui)", color: "var(--fg-strong)", fontSize: 14, lineHeight: 1.6 }}>
      <div style={{ display: "flex", justifyContent: "flex-end", margin: "0 0 14px" }}>
        <div style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 10, padding: "8px 12px", maxWidth: "80%" }}>{(msgs[0] as { content: string }).content}</div>
      </div>
      <div style={{ display: "flex", gap: 10, margin: "14px 0 0" }}>
        <div aria-hidden style={{ flexShrink: 0, width: 22, height: 22, marginTop: 1, display: "grid", placeItems: "center" }}><KlideMark size={20} /></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <ToolRunRow thought={thought} count={count} names={names} expanded={open} onToggle={() => setOpen((v) => !v)} />
        </div>
      </div>
      <div className="klide-tool-run-body" data-open={open ? "true" : "false"} inert={!open}>
        <div>{msgs.slice(run.start, run.end).map((m, k) => row(m, run.start + k))}</div>
      </div>
      {msgs.slice(run.end).map((m, k) => row(m, run.end + k))}
    </main>
  );
}

document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") ?? "light";
// `?hover=1` pins the row's hover state so a headless screenshot can show it.
if (new URLSearchParams(location.search).get("hover") === "1") {
  const style = document.createElement("style");
  style.textContent = ".klide-tool-run-row { opacity: 0.82 } .klide-tool-run-names { opacity: 1 !important }";
  document.head.appendChild(style);
}
createRoot(document.getElementById("root")!).render(<Fold />);
