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
const entry = (id: string, title: string, days: number, extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1, id, path: `${root}/.klide/memory/${id}.md`, relPath: `.klide/memory/${id}.md`,
  createdAtMs: now - days * 86400e3, dateIso: new Date(now - days * 86400e3).toISOString(), title, kind: "decision",
  reviewState: "accepted", tags: [], sourceRefs: [], supersedes: null, goal: title, plan: [], decisions: [title],
  filesTouched: [], nextSteps: [], notes: "", runId: null, provider: null, model: null, mode: null, status: null, ...extra,
});
const proposal = (draftId: string, title: string) => ({
  draftId, title, kind: "convention", tags: [], sourceRefs: [], supersedes: null, goal: title, plan: [], decisions: [title],
  filesTouched: [], nextSteps: [], notes: "", runId: null, provider: null, model: null, mode: null, status: null,
  createdAtMs: now - 3600e3, workspaceRoot: root, why: "Seen in two runs this week: both accepted attempts were fast-forwarded onto the Mission branch.", evidence: "missions/isolation.rs: accept → commit → git merge --ff-only klide/mission-<id>", evidenceHash: "x", filesTouched: ["src-tauri/src/missions/isolation.rs"],
});
mockIPC((command) => {
  if (command === "shared_notes_read") return { revision: 1, sets: [
    { id: "fixture-foundations", title: "Working conventions", body: "Keep the interface calm and keyboard accessible.\n\nDecisions so far\n- Library tabs share one body\n- No chips, no status dots\n\nOpen questions\n- Should Foundations sync to the phone companion?", conversationIds: ["c-focus", "c-review"], archived: false, updatedAtMs: now - 2 * 3600e3 },
    { id: "billing", title: "Billing migration", body: "", conversationIds: [], archived: false, updatedAtMs: now - 5 * 86400e3 },
    { id: "old", title: "v0.5 race dogfood", body: "Done.", conversationIds: ["c-old"], archived: true, updatedAtMs: now - 40 * 86400e3 },
  ] };
  if (command === "memory_list") return [
    entry("durable", "Durable writes go through durable.rs", 3, {
      goal: "Never let a reader see a torn Mission or Transcript file.",
      decisions: ["Atomic replace for whole documents", "Flushed appends for logs; a torn final line is reported, not skipped"],
      filesTouched: ["src-tauri/src/durable.rs", "src-tauri/src/missions.rs"],
      notes: "Interior corruption is an **error**, never a silent `continue`.",
      runId: "convo-1730812345-durable", provider: "anthropic", model: "claude-opus-5-5",
    }),
    entry("agent", "A conversation keeps its first agent", 9, { kind: "convention", goal: "The rail mark is the first run's pair." }),
    entry("ollama", "Ollama num_ctx is the gauge's window", 12, { kind: "fact" }),
    entry("cache", "Keep the system prompt frozen", 15, { kind: "pattern", goal: "Provider caches match prefixes; the first changed byte re-bills the rest." }),
  ];
  if (command === "memory_proposals_list") return [proposal("p1", "Mission attempts fast-forward on accept"), proposal("p2", "Never stage peer hunks with -U0"), proposal("p3", "Ollama num_ctx is the gauge's window")];
  if (command === "memory_read") return "---\nkind: decision\nreviewState: accepted\n---\n# Durable writes go through durable.rs\n\n## Goal\nNever let a reader see a torn Mission or Transcript file.\n";
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
        <LibraryModal open initialSection={section} onSectionChange={setSection} workspaceRoot={root} initialDraftId={params.get("draft")}
          skills={{ skills, onChange: setSkills, onReloadFilesystemSkills: () => {} }} onClose={() => setSection(null)} />
      ) : null}
    </div>
  );
}
ReactDOM.createRoot(document.getElementById("root")!).render(<Page />);
