// Throwaway: the plan-step mark in its three states, large and at size, so a
// change to the arc can be judged against the old one.
import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/monaspace-neon/400.css";
import "@fontsource/monaspace-neon/700.css";
import "../src/styles/tokens.css";
import "../src/components/todoStrip.css";
import { StepMark } from "../src/components/TodoStrip";

function Row({ scale }: { scale: number }) {
  return (
    <div style={{ display: "flex", gap: 24, alignItems: "center", transform: `scale(${scale})`, transformOrigin: "left center", height: 20 * scale }}>
      <StepMark index={0} state="active" />
      <StepMark index={1} state="todo" />
      <StepMark index={2} state="done" />
      <span style={{ color: "var(--fg)", fontFamily: "var(--font-ui)", fontSize: 13 }}>Commit the three uncommitted concerns</span>
    </div>
  );
}

document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") ?? "dark";
createRoot(document.getElementById("root")!).render(
  <div style={{ background: "var(--bg)", minHeight: "100vh", padding: 32, display: "grid", gap: 40, alignContent: "start" }}>
    <Row scale={1} />
    <Row scale={4} />
    <Row scale={8} />
  </div>,
);
