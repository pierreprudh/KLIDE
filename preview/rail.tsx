// The sidebar — the real WorkspaceRail over seeded local history.
// npx vite --port 1436 --strictPort → /preview/rail.html?theme=klide-light
//   &view=agent      the By agent view (default: Sections)
//   &picker=1        the folder menu open
//   &quiet=1         nothing waiting
//   &search=ses      the search field with a query
//   &morph=1         click the switch after load (Sections ⇄ Agent)
//   &done=1          the running conversation finishes off screen (the dot)
import { useState } from "react";
import ReactDOM from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "@fontsource/monaspace-neon/400.css";
import "../src/styles/tokens.css";
import { WorkspaceRail, type RailNavItem } from "../src/components/WorkspaceRail";
import { GitIcon, LibraryIcon, MissionIcon, NewTaskIcon, TerminalIcon, FocusLayoutIcon } from "../src/icons";
import { applyRunAttention, markNeedsYou, watchRunAttention } from "../src/runAttention";
import { publishKlideConvo } from "../src/klideConvos";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "klide-light";
const KIDE = "/Users/pierre/Documents/Private/KIDE";
const WEB = "/Users/pierre/Sites/website";
const DECK = "/Users/pierre/Documents/Ontraak/deck";
const now = Date.now();
const m = 60e3, h = 60 * m, d = 24 * h;
const convo = (id: string, title: string, cwd: string, provider: string, model: string, ago: number) =>
  ({ id, title, cwd, provider, model, msgs: [{ role: "user", content: title }], createdAt: now - ago - h, updatedAt: now - ago });
const CONVOS = [
  convo("a", "Session refresh", KIDE, "claude-code", "claude-opus-4-6", 2 * m),
  convo("g", "Pricing table", WEB, "codex", "gpt-5.4", 9 * m),
  convo("b", "Rail grouping modes", KIDE, "claude-code", "claude-opus-4-6", 1 * m),
  convo("c", "Remote host bootstrap", KIDE, "codex", "gpt-5.4", 14 * m),
  convo("d", "Scheduled task selectors", KIDE, "codex", "gpt-5.4", 3 * h),
  convo("m", "Release notes 0.6.12", KIDE, "anthropic", "claude-sonnet-4-6", 1 * d),
  convo("e", "Fix the Copilot resume path", KIDE, "claude-code", "claude-sonnet-4-6", 5 * h),
  convo("f", "Explain the compaction marker", KIDE, "ollama", "llama3.1:8b", 1 * d + h),
  convo("h", "Mission worktree setup script", KIDE, "codex", "gpt-5.4", 1 * d + 2 * h),
  convo("i", "Toast stack spacing", KIDE, "claude-code", "claude-opus-4-6", 2 * d),
  convo("j", "Hermes .env alignment", KIDE, "opencode", "openrouter/qwen3-coder", 3 * d),
  convo("k", "Gateway restore on stop", KIDE, "claude-code", "claude-opus-4-6", 4 * d),
  convo("l", "PDF drop card", KIDE, "codex", "gpt-5.4", 5 * d),
  convo("n", "Delegate spawn debugging", KIDE, "claude-code", "claude-sonnet-4-6", 6 * d),
  convo("o", "Prompt caching breakpoints", KIDE, "claude-code", "claude-opus-4-6", 7 * d),
  convo("p", "Worker acceptance pass", KIDE, "codex", "gpt-5.4", 8 * d),
];
localStorage.setItem("klide-conversations", JSON.stringify(CONVOS));
localStorage.setItem("klide.pinnedConversations", JSON.stringify(["d", "m"]));
localStorage.setItem("klide-rail-conversation-view", params.get("view") === "agent" ? "agent" : "sections");
localStorage.setItem("klide-rail-width", "264");

mockIPC((command) => {
  if (command === "agent_run_status") return { status: "running" };
  if (command === "app_user_info") return { username: "Pierre", hostname: "MacBook-Pro" };
  if (command === "github_current_user") return { login: "pierre", avatarUrl: "" };
  if (command.includes("listen")) return 1;
  return null;
});

publishKlideConvo({ id: "b", title: "Rail grouping modes", status: "running", provider: "claude-code", messages: [], updatedMs: now } as unknown as Parameters<typeof publishKlideConvo>[0]);

if (!params.has("quiet")) {
  applyRunAttention({ runId: "a", state: "asking", kind: "permission", requestId: "r1", summary: "Edit src/session.ts" });
  applyRunAttention({ runId: "g", state: "asking", kind: "question", requestId: "r2", summary: "Monthly or yearly first?" });
  markNeedsYou("a", "a", true);
}

function Page() {
  const [selected, setSelected] = useState<string[]>(["c"]);
  const nav: RailNavItem[] = [
    { id: "git", label: "Git", icon: <GitIcon size={15} />, onClick: () => {} },
    { id: "runs", label: "Mission Control", icon: <MissionIcon size={15} />, onClick: () => {} },
    { id: "library", label: "Library", icon: <LibraryIcon size={15} />, note: "3 to review", onClick: () => {} },
  ];
  const foot = <>
    <button type="button" className="klide-rail-view-switch" aria-label="Show the terminal"><TerminalIcon size={14} /></button>
    <button type="button" className="klide-rail-view-switch" aria-label="Focus layout"><FocusLayoutIcon size={14} /></button>
  </>;
  return (
    <div className="klide-app-row" style={{ height: "100vh", display: "flex" }}>
      <WorkspaceRail
        workspaceRoot={KIDE}
        projects={[KIDE, WEB, DECK, "/Users/pierre/Documents/Private/klide-acceptance", "/private/tmp/klide-btw-live-20261026", "/Users/pierre/Documents/Private/klide-delegate-smoke-with-a-long-name", "/Users/pierre/Documents/Private/usage_tool", "/Users/pierre/Documents/Private/Portfolio"]}
        newTask={{ id: "new-task", label: "New task", icon: <NewTaskIcon size={15} />, onClick: () => {} }}
        nav={nav}
        selectedConversationIds={selected}
        onSwitchProject={() => {}}
        onOpenFolder={() => {}}
        onCloneRepo={async () => { throw new Error("Couldn't reach github.com"); }}
        onOpenConversation={(c) => setSelected([c.id])}
        onOpenSettings={() => {}}
        onOpenProfile={() => {}}
        footActions={foot}
      />
      <div style={{ flex: 1, background: "var(--bg)" }} />
    </div>
  );
}
ReactDOM.createRoot(document.getElementById("root")!).render(<Page />);

if (params.has("picker")) setTimeout(() => (document.querySelector(".klide-rail-folder") as HTMLElement | null)?.click(), 300);
const q = params.get("search");
if (q) setTimeout(() => {
  (document.querySelector('[aria-label="Search conversations"]') as HTMLElement | null)?.click();
  setTimeout(() => {
    const input = document.querySelector<HTMLInputElement>('input[name="conversation-search"]');
    if (!input) return;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(input, q);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, 100);
}, 300);

const morph = params.get("morph");
if (morph) setTimeout(() => (document.querySelector(".klide-rail-view-pick") as HTMLElement | null)?.click(), 600);

if (params.has("done")) {
  watchRunAttention();
  setTimeout(() => publishKlideConvo({ id: "b", title: "Rail grouping modes", status: "done", provider: "claude-code", messages: [], updatedMs: Date.now() } as unknown as Parameters<typeof publishKlideConvo>[0]), 1500);
}
