// Browser-only fixture for the answered-question card, in the message row
// AiPanel draws it in (22px mark, 10px gap, body), with the GitHub observer
// card above it for the family resemblance. `?theme=light|dark`.
import { createRoot } from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "@fontsource/monaspace-neon/400.css";
import "../src/styles/tokens.css";
import { renderMessageBody, type AttachedResult } from "../src/components/ai/ChatMessage";
import { GithubObserverCard } from "../src/components/ai/GithubObserverCard";
import { KlideMark } from "../src/components/ai/icons";
import type { Msg } from "../src/components/ai/types";

(window as any).__TAURI_INTERNALS__ = { invoke: async () => ({
  runId: 35927357206, attempt: 1, url: "https://github.com/pierreprudh/KLIDE/actions/runs/35927357206",
  status: "completed", conclusion: "success", headSha: "abc", prHeadSha: "abc", prNumber: 120,
  prUrl: "https://github.com/pierreprudh/KLIDE/pull/120", prState: "open", repo: "pierreprudh/KLIDE", localRepo: "pierreprudh/KLIDE", cwd: "/fixture",
  jobs: [{ name: "Frontend", status: "completed", conclusion: "success" }],
}) };

const q = new URLSearchParams(location.search);
const question = "OpenCode dispatch was declined, so nothing has been created yet — how would you like slugify.js done: written here by me, or dispatched to another worker?";
const asked = (answer: string, id: string): [Msg, AttachedResult] => [
  { role: "assistant", content: "", toolCalls: [{ id, name: "userAnswerQuestion", args: { question } }] },
  { msg: { role: "tool", content: answer, toolName: "userAnswerQuestion", toolCallId: id }, active: false },
];
const [m1, r1] = asked("Skip it for now", "q1");
const [m2, r2] = asked("[user skipped this question]", "q2");

const Row = ({ children, mark }: { children: React.ReactNode; mark?: boolean }) => (
  <div style={{ display: "flex", flexWrap: "wrap", gap: 10, margin: mark ? "14px 0 8px" : "3px 0" }}>
    <div aria-hidden style={{ flexShrink: 0, width: 22, height: 22, marginTop: 1, display: "grid", placeItems: "center" }}>{mark && <KlideMark size={20} />}</div>
    <div style={{ flex: 1, minWidth: 0, color: "var(--fg-strong)", fontSize: 13, lineHeight: 1.6 }}>{children}</div>
  </div>
);

function Preview() {
  return (
    <main style={{ padding: "28px 24px", maxWidth: 760, margin: "auto", fontFamily: "var(--font-ui)", color: "var(--fg-strong)", fontSize: 13, lineHeight: 1.6 }}>
      <div style={{ display: "flex", justifyContent: "flex-end", margin: "0 0 14px" }}>
        <div style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 10, padding: "8px 12px", maxWidth: "80%" }}>Add slugify.js at the repo root with OpenCode.</div>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, margin: "14px 0 8px" }}>
        <div aria-hidden style={{ flexShrink: 0, width: 22, height: 22, marginTop: 1, display: "grid", placeItems: "center" }}><KlideMark size={20} /></div>
        <div style={{ flex: 1, minWidth: 0 }}>I’m watching PR #120 meanwhile.</div>
        <div className="github-observer-message-slot">
          <GithubObserverCard runId="preview" observer={{ id: "fixture", command: "gh run watch 35927357206 --exit-status", githubWatch: { runId: 35927357206, repo: null }, status: { state: "exited", code: 0 }, startedMs: Date.now(), endedMs: null, notifyOnExit: true }} onStop={() => {}} />
        </div>
      </div>
      <Row mark>{renderMessageBody(m1, false, { results: new Map([["q1", r1]]) })}</Row>
      <Row>Skipping it — the OpenCode dispatch was declined and no files were touched, so slugify.js does not exist yet.</Row>
      <Row mark>{renderMessageBody(m2, false, { results: new Map([["q2", r2]]) })}</Row>
      <Row>Carrying on without an answer.</Row>
    </main>
  );
}

document.documentElement.dataset.theme = q.get("theme") ?? "light";
createRoot(document.getElementById("root")!).render(<Preview />);
