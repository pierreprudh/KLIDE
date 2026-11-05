// The Library — real WorkspaceRail row + real LibraryModal over IPC fixtures.
// npx vite --port 1436 --strictPort → /preview/library.html?theme=klide-light&tab=memory|skills|shared
import { useState } from "react";
import ReactDOM from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "@fontsource/monaspace-neon/400.css";
import "../src/styles/tokens.css";
import { WorkspaceRail, type RailNavItem } from "../src/components/WorkspaceRail";
import { LibraryModal, type LibrarySection } from "../src/components/LibraryModal";
import { useMemoryReviewCount } from "../src/hooks/useMemoryReviewCount";
import { GitIcon, LibraryIcon, MissionIcon, NewTaskIcon, ClockIcon } from "../src/icons";
import { DEFAULT_SKILLS, type Skill } from "../src/skills";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "klide-light";
const root = "/fixture/klide";
const now = Date.now();
const entry = (id: string, title: string, days: number) => ({
  schemaVersion: 1, id, path: `${root}/.klide/memory/${id}.md`, relPath: `.klide/memory/${id}.md`,
  createdAtMs: now - days * 86400e3, dateIso: new Date(now - days * 86400e3).toISOString(), title, kind: "decision",
  reviewState: "accepted", tags: [], sourceRefs: [], supersedes: null, goal: title, plan: [], decisions: [title],
  filesTouched: [], nextSteps: [], notes: "", runId: null, provider: null, model: null, mode: null, status: null,
});
const proposal = (draftId: string, title: string) => ({
  draftId, title, kind: "convention", tags: [], sourceRefs: [], supersedes: null, goal: title, plan: [], decisions: [title],
  filesTouched: [], nextSteps: [], notes: "", runId: null, provider: null, model: null, mode: null, status: null,
  createdAtMs: now - 3600e3, workspaceRoot: root, why: "Seen in two runs this week.", evidence: "", evidenceHash: "x",
});
mockIPC((command) => {
  if (command === "memory_list") return [entry("durable", "Durable writes go through durable.rs", 3), entry("agent", "A conversation keeps its first agent", 9)];
  if (command === "memory_proposals_list") return [proposal("p1", "Mission attempts fast-forward on accept"), proposal("p2", "Never stage peer hunks with -U0"), proposal("p3", "Ollama num_ctx is the gauge's window")];
  if (command === "app_user_info") return { username: "Pierre", hostname: "MacBook-Pro" };
  if (command === "github_current_user") return { login: "pierre", avatarUrl: "" };
  if (command.includes("listen")) return 1;
  return [];
});

function Page() {
  const [section, setSection] = useState<LibrarySection | null>(params.get("tab") === "none" ? null : ((params.get("tab") as LibrarySection) ?? "memory"));
  const [skills, setSkills] = useState<Skill[]>(DEFAULT_SKILLS);
  const review = useMemoryReviewCount(root);
  const nav: RailNavItem[] = [
    { id: "new-task", label: "New task", icon: <NewTaskIcon size={15} />, onClick: () => {} },
    { id: "git", label: "Git", icon: <GitIcon size={15} />, onClick: () => {} },
    { id: "runs", label: "Mission Control", icon: <MissionIcon size={15} />, onClick: () => {} },
    { id: "scheduled", label: "Scheduled", icon: <ClockIcon size={15} />, onClick: () => {} },
    { id: "library", label: "Library", icon: <LibraryIcon size={15} />, active: section !== null, note: review > 0 ? `${review} to review` : undefined, onClick: () => setSection((s) => (s ? null : "memory")) },
  ];
  return (
    <div className="klide-app-row" style={{ height: "100vh", display: "flex" }}>
      <WorkspaceRail workspaceRoot={root} projects={[root]} nav={nav} onSwitchProject={() => {}} onOpenConversation={() => {}} onOpenSettings={() => {}} onOpenProfile={() => {}} />
      <div style={{ flex: 1, background: "var(--bg)" }} />
      {section !== null ? (
        <LibraryModal open initialSection={section} onSectionChange={setSection} workspaceRoot={root}
          skills={{ skills, onChange: setSkills, onReloadFilesystemSkills: () => {} }} onClose={() => setSection(null)} />
      ) : null}
    </div>
  );
}
ReactDOM.createRoot(document.getElementById("root")!).render(<Page />);
