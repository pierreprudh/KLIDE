// Throwaway: the Mission flow canvas with a six-task plan across four layers
// and every status the board knows, at the width of a conversation column and
// of the Mission Control pane. ?theme=light|dark
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "@fontsource/monaspace-neon/400.css";
import "@fontsource/monaspace-neon/700.css";
import "../src/styles/tokens.css";
import { MissionFlow, type MissionFlowMeta } from "../src/components/MissionFlow";
import type { GraphTask } from "../src/agent/missionGraph";
import { ProviderModelMark } from "../src/modelIdentity";

const route = (provider: "anthropic" | "ollama" | "claude-code" | "codex", model: string | null, label: string) => (
  <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
    <ProviderModelMark provider={provider} model={model} size={16} />
    <span>{label}</span>
  </span>
);

const tasks: GraphTask[] = [
  { id: "t1", dependencies: [] },
  { id: "t2", dependencies: ["t1"] },
  { id: "t3", dependencies: ["t2"] },
  { id: "t4", dependencies: ["t2"] },
  { id: "t5", dependencies: ["t3", "t4"] },
  { id: "t6", dependencies: ["t5"] },
];

const meta: Record<string, MissionFlowMeta> = {
  t1: { title: "Map modules touched by /mission", phase: "Understand", status: "done", caption: route("ollama", "llama3.1:8b", "Ollama · Llama 3.1") },
  t2: { title: "Draft the implementation plan", phase: "Understand", status: "done", caption: route("anthropic", "claude-sonnet-5-5", "Anthropic · Claude Sonnet") },
  t3: { title: "Scaffold the mission tool", phase: "Build", status: "running", caption: route("anthropic", "claude-sonnet-5-5", "Anthropic · Claude Sonnet") },
  t4: { title: "Render the flow in the conversation", phase: "Build", status: "review", caption: route("claude-code", null, "Claude Code") },
  t5: { title: "Write unit tests", phase: "Verify", status: "queued", caption: "after Scaffold" },
  t6: { title: "Visual QA of the new UI", phase: "Verify", status: "failed", caption: route("codex", null, "Codex") },
};

function Stage({ width, label }: { width: number; label: string }) {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <span style={{ fontSize: 11, color: "var(--fg-dim)", fontFamily: "var(--font-ui)" }}>{label}</span>
      <div style={{ width, border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", overflow: "hidden" }}>
        <MissionFlow tasks={tasks} meta={meta} selected={selected} onSelect={setSelected} />
      </div>
    </div>
  );
}

document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") ?? "dark";
createRoot(document.getElementById("root")!).render(
  <div style={{ background: "var(--bg)", minHeight: "100vh", padding: 32, display: "grid", gap: 40, alignContent: "start", fontFamily: "var(--font-ui)" }}>
    <Stage width={560} label="conversation column · 560" />
    <Stage width={920} label="mission control · 920" />
  </div>,
);
