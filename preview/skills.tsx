// Throwaway page for the Skills window over a fake workbench.
//   http://localhost:1420/preview/skills.html?theme=dark&tab=skills|tools
import { useState } from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "@fontsource/monaspace-neon/400.css";
import "../src/styles/tokens.css";
import { SkillsModal } from "../src/components/SkillsModal";
import type { Skill } from "../src/skills";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "dark";

const seed: Skill[] = [
  { id: "a", name: "visualise", description: "Render inline SVG diagrams, charts and explainers in the conversation.", instructions: "# Visualise\n\nDraw the **mechanism**, not a decoration.\n\n- One idea per figure\n- Label in place\n\n```\n<svg>…</svg>\n```", tools: ["read_file", "list_dir"], enabled: true, fromFile: "/Users/pierre/.claude/skills/visualise/SKILL.md", group: "Personal", updatedAt: Date.now() },
  { id: "b", name: "tdd", description: "Test-driven development with a red-green-refactor loop.", instructions: "Write the failing test first.", tools: ["read_file", "write_file", "run_command"], enabled: true, fromFile: "/Users/pierre/.agents/skills/tdd/SKILL.md", group: "Matt Pocock" },
  { id: "c", name: "web-design-guidelines", description: "Review UI code for Web Interface Guidelines compliance.", instructions: "Audit.", tools: ["read_file"], enabled: true, fromFile: "/Users/pierre/.agents/skills/web-design/SKILL.md", group: "Vercel" },
  { id: "d", name: "linkedin-weekly-post", description: "Draft the weekly LinkedIn post from the week's commits.", instructions: "Draft.", tools: [], enabled: false },
  { id: "e", name: "grill-me", description: "Interview the user relentlessly about a plan until reaching shared understanding.", instructions: "Ask.", tools: [], enabled: false, fromFile: "/Users/pierre/.agents/skills/grill-me/SKILL.md", group: "Matt Pocock" },
  { id: "f", name: "explain", description: "Explain code for a smart beginner.", instructions: "Explain.", tools: ["read_file"], enabled: true, builtin: true },
];

const code = Array.from({ length: 40 }, (_, i) =>
  `${String(i + 1).padStart(3)}  ${["export function", "  const", "  return", "}", "// the run loop"][i % 5]} value_${i} = compute(${i});`).join("\n");

function App() {
  const [skills, setSkills] = useState(seed);
  return (
    <div style={{ height: "100vh", background: "var(--bg)", color: "var(--fg-subtle)", fontFamily: "var(--font-mono)", fontSize: 12, whiteSpace: "pre", padding: 24, overflow: "hidden" }}>
      {code}
      <SkillsModal open skills={skills} onChange={setSkills} onReloadFilesystemSkills={() => {}} onClose={() => {}} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
