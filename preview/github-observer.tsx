// Browser-only fixture: exercises the production card, without GitHub mutations.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../src/styles/tokens.css";
import { GithubObserverCard } from "../src/components/ai/GithubObserverCard";
import { registerGitOpener } from "../src/gitNavigation";
let state = "running";
(window as any).__TAURI_INTERNALS__ = { invoke: async () => ({
  runId: 35927357206, attempt: 1, url: "https://github.com/pierreprudh/KLIDE/actions/runs/35927357206",
  status: state === "running" ? "in_progress" : "completed", conclusion: state === "failed" ? "failure" : "success",
  headSha: "abc", prHeadSha: "abc", prNumber: 120, prUrl: "https://github.com/pierreprudh/KLIDE/pull/120", prState: "open",
  repo: "pierreprudh/KLIDE", localRepo: "pierreprudh/KLIDE", cwd: "/fixture",
  jobs: [{ name: "Frontend", status: "completed", conclusion: "success" }, { name: "Rust", status: state === "running" ? "in_progress" : "completed", conclusion: state === "failed" ? "failure" : "success" }],
}) };
function Preview() {
  const [mode, setMode] = useState("running");
  const [destination, setDestination] = useState("");
  registerGitOpener(target => setDestination(`Git panel · PR #${target.pr}`));
  return <main style={{ padding: "40px 20px", maxWidth: 720, margin: "auto", fontFamily: "var(--font-ui)", color: "var(--fg)" }}>
    <p>Production card · simulated GitHub data</p>
    <nav>{["running", "passed", "failed"].map(value => <button key={value} onClick={() => { state = value; setMode(value); }}>{value}</button>)}</nav>
    <p>I’m watching PR #120. You can keep working here.</p>
    <GithubObserverCard key={mode} runId="preview" observer={{ id: "fixture", command: "gh run watch 35927357206 --exit-status", githubWatch: { runId: 35927357206, repo: null }, status: mode === "stopped" ? { state: "signalled" } : mode === "running" ? { state: "running" } : { state: "exited", code: mode === "failed" ? 1 : 0 }, startedMs: Date.now(), endedMs: null, notifyOnExit: true }} onStop={() => setMode("stopped")} />
    <p role="status">{destination}</p>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
