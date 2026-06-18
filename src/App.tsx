import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { ActivityBar } from "./components/ActivityBar";
import { MissionControl } from "./components/MissionControl";
import { OrchestratorPreview } from "./components/OrchestratorPreview";
import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { EditorArea } from "./components/EditorArea";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { TerminalPanel } from "./components/TerminalPanel";
import { AiPanel } from "./components/AiPanel";
import { StatusBar } from "./components/StatusBar";
import { eventsToConversation } from "./components/ai/eventsToMsgs";
import type { AgentEvent } from "./agent/types";
import type { Conversation, Msg } from "./components/ai/types";
import { summarizeAndHandoff } from "./components/ai/summarize";
import { fetchRunMessages, type RunMessage as MissionRunMessage } from "./runs";
import type { GitStatus } from "./gitTypes";
import { GitReview } from "./components/GitReview";
import { MemoryModal } from "./components/MemoryModal";
import { FileViewerPanel } from "./components/FileViewerPanel";
import { SkillsModal } from "./components/SkillsModal";
import { SettingsPanel } from "./components/SettingsPanel";
import { ProfileModal } from "./components/ProfileModal";
import { getNextThemeId, normalizeThemeId, type ThemeId } from "./theme";
import { loadSkills, saveSkills, loadFilesystemSkills, type Skill } from "./skills";
import {
  loadCustomPresets,
  saveCustomPresets,
  type LayoutPreset,
} from "./layouts";
import { loadGridLayouts, type GridLayout, type PanelKind } from "./gridLayouts";
import { GridWorkbench } from "./components/GridWorkbench";
import { FloatingPanel } from "./components/FloatingPanel";
import { AnchoredWorkbench } from "./components/AnchoredWorkbench";
import { SplitPane } from "./components/SplitPane";
import { defaultLayout as defaultPanelLayout } from "./panelLayout";
import { CommandPalette } from "./components/CommandPalette";
import { SearchPanel } from "./components/SearchPanel";
import { useEditorTabs } from "./hooks/useEditorTabs";
import { usePanelLayout } from "./hooks/usePanelLayout";
import { readWorkspaceTextFile } from "./workspaceFs";
import "./styles/tokens.css";

type Panel = "explorer" | "git" | "memory" | "skills" | "ai" | "runs" | "settings" | "profile";
type ActivityPanel = Panel | "orchestrator";
export type HarnessSettings = {
  chatPrompt?: string;
  planPrompt?: string;
  goalPrompt?: string;
  toolOverrides?: Record<string, boolean>;
  /** Per-model context window (num_ctx) override for local models. Absent →
   *  use the model's detected trained window. Keyed by model id. */
  contextWindows?: Record<string, number>;
  /** Per-model reply budget (num_predict) for local models. Absent → provider default. */
  effortBudgets?: Record<string, number>;
  /** Per-model thinking/reflection level for models that advertise thinking. */
  reflectionLevels?: Record<string, string>;
  /** Max read-only tool calls to run concurrently within a turn (1 = off). */
  maxParallelTools?: number;
  /** Max tool turns per run before handing back to the user. Absent → harness
   *  default (50). A runaway-loop guard; raise it for big multi-file / multi-
   *  agent tasks. The conversation can always be continued past the cap. */
  maxTurns?: number;
  /** Seconds a run_command may run before it's killed. Absent → 180. Raise it
   *  for slow builds; a hang guard, not a task limit. */
  commandTimeoutSecs?: number;
  /** OLLAMA_NUM_PARALLEL for Klide-launched Ollama servers (concurrent
   *  request slots). Absent → Ollama's own default. */
  serverConcurrency?: number;
  /** When a Klide agent run settles with status "done", automatically write
   *  a project-memory note from the conversation. Default ON (undefined /
   *  missing field is treated as true). Off silences the auto-save — the
   *  manual Summarize header action still works. */
  autoMemoryOnRunDone?: boolean;
};
const DEFAULT_AI_MODEL = "llama3.1:8b";

function readNumberSetting(key: string, fallback: number, min: number, max: number): number {
  const stored = localStorage.getItem(key);
  if (stored === null) return fallback;
  const raw = Number(stored);
  return Number.isFinite(raw) ? clamp(raw, min, max) : fallback;
}

function readBoolSetting(key: string, fallback: boolean): boolean {
  const stored = localStorage.getItem(key);
  return stored === null ? fallback : stored === "true";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function detectLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return (
    {
      ts: "typescript",
      tsx: "typescript",
      js: "javascript",
      jsx: "javascript",
      rs: "rust",
      py: "python",
      json: "json",
      md: "markdown",
      html: "html",
      css: "css",
      toml: "ini",
      yml: "yaml",
      yaml: "yaml",
    } as Record<string, string>
  )[ext] ?? "plaintext";
}

function App() {
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);
  const [view, setView] = useState<"workbench" | "runs" | "orchestrator" | "settings" | "git-review">("workbench");
  const [explorerVisible, setExplorerVisible] = useState(
    () => localStorage.getItem("klide-explorer-visible") !== "false"
  );
  const [memoryVisible, setMemoryVisible] = useState(false);
  // Bumped when the AI panel writes a new memory entry, so the modal
  // refreshes when the user opens it.
  const [memoryRefreshKey, setMemoryRefreshKey] = useState(0);
  // When MissionControl asks us to "Review Diff" on a Klide run, this
  // holds the runId so the MissionControl detail pane can scroll its
  // CheckpointPanel into view (and the CheckpointPanel isn't always in
  // the DOM if a CLI run is selected).
  const [pendingCheckpointRunId, setPendingCheckpointRunId] = useState<string | null>(null);
  // runId currently being summarised by `saveMemoryFromRun` — surfaced as
  // a subtle spinner on the row so the user knows the model call is in
  // flight.
  const [summarizingFromRun, setSummarizingFromRun] = useState<string | null>(null);
  const [profileVisible, setProfileVisible] = useState(false);
  const [aiVisible, setAiVisible] = useState(
    () => localStorage.getItem("klide-ai-visible") !== "false"
  );
  const [skillsVisible, setSkillsVisible] = useState(
    () => localStorage.getItem("klide-skills-visible") === "true"
  );
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [sidebarSlot2, setSidebarSlot2] = useState<Panel | null>(
    () => localStorage.getItem("klide-sidebar-slot2") as Panel | null
  );
  // A resumed Klide run, targeted at one specific panel by id. Without the
  // panelId every mounted AiPanel would adopt the same conversation (they all
  // receive this prop in one render), so a resume click would clobber every
  // open panel instead of landing in one. Mirrors `pendingAiPanel`'s keying.
  const [resumeTarget, setResumeTarget] = useState<{ panelId: string; convo: Conversation } | null>(null);
  // Tracks which panel a given run was resumed into (runId → panelId), so
  // re-resuming the same run focuses its panel instead of opening a duplicate.
  const resumePanelsRef = useRef<Map<string, string>>(new Map());
  // AI panel spawn queue: when Mission Control asks to open a fresh panel
  // pinned to a delegate provider, we set this and the matching <AiPanel>
  // picks it up on mount, sets its initial provider + resume/task, then
  // clears the entry. One-at-a-time, key matched by panel id.
  const [pendingAiPanel, setPendingAiPanel] = useState<{
    panelId: string;
    provider: "claude-code" | "codex" | "opencode";
    resumeSessionId: string | null;
    initialTask: string | null;
  } | null>(null);
  void pendingAiPanel;
  const [apiKeyVersion, setApiKeyVersion] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [searchVisible, setSearchVisible] = useState(false);
  const [fileNotice, setFileNotice] = useState<string | null>(null);
  const {
    tabs,
    activeIdx,
    setActiveIdx,
    active,
    editorRef,
    openFile,
    updateActiveCode,
    onEntryRenamed,
    onEntryDeleted,
    closeTab,
    saveActive,
    onAgentWrote,
  } = useEditorTabs({ notify: setFileNotice, workspaceRoot });
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [recentFolders, setRecentFolders] = useState<string[]>(() => {
    try {
      const parsed = JSON.parse(
        localStorage.getItem("klide.recentFolders") || "[]"
      );
      return Array.isArray(parsed)
        ? parsed.filter((p): p is string => typeof p === "string")
        : [];
    } catch {
      return [];
    }
  });
  const [terminalVisible, setTerminalVisible] = useState(
    () => localStorage.getItem("klide-terminal-visible") === "true"
  );
  // Bento layout — each panel is a free-floating rect in the workbench area.
  // One Layout per workspace; the hook owns hydration, persistence, clamping,
  // and the AI-panel list. App composes its mutators into orchestration.
  const {
    workbenchRef,
    workbenchSize,
    setWorkbenchSize,
    panelLayout,
    aiPanels,
    zCounter,
    focusedPanel,
    updatePanelRect,
    updateAiRect,
    ensureAiRect,
    focusPanel,
    resetPanelLayout,
    setAnchoredLayout,
    appendAiPanel,
    setAiPanelProvider,
    setAiPanelModel,
    closeAiPanel,
  } = usePanelLayout({ workspaceRoot, view });
  const [skills, setSkills] = useState<Skill[]>(() => loadSkills());

  const reloadFilesystemSkills = useCallback(async () => {
    const fsSkills = await loadFilesystemSkills(workspaceRoot);
    setSkills((prev) => {
      const userDefined = prev.filter((s) => !s.fromFile);
      return [...userDefined, ...fsSkills];
    });
  }, [workspaceRoot]);

  useEffect(() => {
    void reloadFilesystemSkills();
  }, [reloadFilesystemSkills]);

  const [customLayouts, setCustomLayouts] = useState<LayoutPreset[]>(() =>
    loadCustomPresets()
  );
  const [gridLayouts, setGridLayouts] = useState<GridLayout[]>(() =>
    loadGridLayouts()
  );
  const [settingsInitial, setSettingsInitial] = useState<string | null>(null);
  const [activeGridId, setActiveGridId] = useState<string | null>(
    () => localStorage.getItem("klide-active-grid") || null
  );
  const [theme, setTheme] = useState<ThemeId>(() =>
    normalizeThemeId(localStorage.getItem("klide-theme"))
  );
  const [autoTheme, setAutoTheme] = useState(() => {
    // Default ON for first-run users so Klide matches their OS theme out of
    // the box. Users can disable the toggle in Settings → Appearance.
    const stored = localStorage.getItem("klide-auto-theme");
    return stored === null ? true : stored === "true";
  });
  const [lightTheme, setLightTheme] = useState<ThemeId>(() =>
    normalizeThemeId(localStorage.getItem("klide-light-theme") || "klide-light")
  );
  const [darkTheme, setDarkTheme] = useState<ThemeId>(() =>
    normalizeThemeId(localStorage.getItem("klide-dark-theme") || "cursor-dark")
  );
  // Listen for system color-scheme changes and auto-switch if enabled.
  useEffect(() => {
    if (!autoTheme) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      const next = mq.matches ? darkTheme : lightTheme;
      setTheme((prev) => (prev === next ? prev : next));
    };
    handler();
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [autoTheme, lightTheme, darkTheme]);
  const [editorFontSize, setEditorFontSize] = useState(() =>
    readNumberSetting("klide-editor-font-size", 13, 11, 20)
  );
  const [editorLineNumbers, setEditorLineNumbers] = useState(() =>
    readBoolSetting("klide-editor-line-numbers", true)
  );
  const [editorWordWrap, setEditorWordWrap] = useState(() =>
    readBoolSetting("klide-editor-word-wrap", false)
  );
  const [editorMinimap, setEditorMinimap] = useState(() =>
    readBoolSetting("klide-editor-minimap", true)
  );
  const [aiModel, setAiModel] = useState(
    () =>
      localStorage.getItem("klide-ai-model") ||
      localStorage.getItem("klide-ollama-model") ||
      DEFAULT_AI_MODEL
  );
  const [panelModels, setPanelModels] = useState<Record<string, string[]>>({});
  const [requireDiffReview, setRequireDiffReview] = useState(() =>
    readBoolSetting("klide-confirm-agent-edits", true)
  );
  const [stopAfterRejection, setStopAfterRejection] = useState(() =>
    readBoolSetting("klide.stopAfterRejection", false)
  );
  const [harnessSettings, setHarnessSettings] = useState<HarnessSettings>(() => {
    try {
      const raw = localStorage.getItem("klide.harnessSettings");
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  });
  useEffect(() => {
    localStorage.setItem("klide.harnessSettings", JSON.stringify(harnessSettings));
  }, [harnessSettings]);
  // Free-mode floating panels fall back to a default rect when the persisted
  // layout never stored one. Anchored mode renders the explorer/terminal from
  // their visibility flag alone (width falls back to a constant), so a
  // workspace that only ever ran anchored can have `panelLayout.explorer` /
  // `.terminal` undefined — and free mode would then silently render nothing
  // for them (no explorer tree → can't open files either). Deriving a fallback
  // here keeps free mode working regardless of what's been persisted; if a
  // rect exists it's used unchanged, so there's no behaviour change otherwise.
  const freeFallbackLayout = defaultPanelLayout(workbenchSize.w, workbenchSize.h);
  const explorerRect = panelLayout.explorer ?? freeFallbackLayout.explorer!;
  const terminalRect = panelLayout.terminal ?? freeFallbackLayout.terminal!;
  const activeGrid =
    activeGridId != null
      ? gridLayouts.find((g) => g.id === activeGridId) ?? null
      : null;
  const activityState: Record<ActivityPanel, boolean> = {
    explorer: view === "workbench" && (explorerVisible || sidebarSlot2 === "explorer"),
    git: view === "git-review",
    memory: view === "workbench" && memoryVisible,
    skills: view === "workbench" && (skillsVisible || sidebarSlot2 === "skills"),
    ai: view === "workbench" && aiVisible,
    runs: view === "runs",
    orchestrator: view === "orchestrator",
    settings: view === "settings",
    profile: profileVisible,
  };

  function togglePanel(panel: ActivityPanel, meta?: boolean) {
    if (panel === "settings") {
      setSettingsInitial(null);
      setView("settings");
      return;
    }
    if (panel === "profile") {
      setProfileVisible((cur) => !cur);
      return;
    }
    if (panel === "runs") {
      setView("runs");
      return;
    }
    if (panel === "orchestrator") {
      setView("orchestrator");
      return;
    }
    setView("workbench");
    if (panel === "ai") {
      // From a non-workbench view (Mission Control, Settings) the AI icon
      // should always *show* the panel — toggling would hide it (the
      // closure still sees aiVisible=true from when the user left) and
      // the user has to click twice to make it reappear.
      if (view !== "workbench") {
        setAiVisible(true);
        if (!panelLayout.ai || panelLayout.ai.length === 0) ensureAiRect();
        focusPanel(aiPanels[0]?.id ?? "ai-main");
      } else {
        // Always ensure the in-memory list is populated, even if the
        // persisted layout has it empty. The render path gates on both
        // `aiVisible` AND `aiPanels.length > 0` — a stale empty list
        // (left over from a previous session's misbehaviour) would
        // otherwise make the panel invisible after a toggle.
        if (aiPanels.length === 0) ensureAiRect();
        const willShow = !aiVisible;
        setAiVisible(willShow);
        if (willShow) focusPanel(aiPanels[0]?.id ?? "ai-main");
      }
      return;
    }
    // Sidebar views: normal click opens one at a time; ⌘+click stacks below.
    if (panel === "explorer" || panel === "skills") {
      if (meta) {
        // ⌘+click toggles the secondary slot in the explorer panel.
        setSidebarSlot2((cur) => cur === panel ? null : panel);
      } else {
        // Plain click: collapse any other sidebar view, then toggle this one.
        if (sidebarSlot2 === panel) setSidebarSlot2(null);
        if (panel !== "explorer" && explorerVisible) setExplorerVisible(false);
        if (panel !== "skills" && skillsVisible) setSkillsVisible(false);
        if (panel === "explorer") {
          const willShow = !explorerVisible;
          setExplorerVisible(willShow);
          // In free mode the explorer is a FloatingPanel sharing the
          // z-stack with the AI/terminal panels. Opening it must raise it
          // to the front, otherwise it appears "in the background" behind a
          // panel that happens to overlap its position.
          if (willShow) focusPanel("explorer");
        } else {
          setSkillsVisible((cur) => !cur);
        }
      }
      return;
    }
    // Git is a dedicated full-window view, not a sidebar panel.
    if (panel === "git") {
      setView((v) => (v === "git-review" ? "workbench" : "git-review"));
      return;
    }
    // Memory opens as a centered modal (like Skills) rather than a
    // sidebar — its list+detail layout needs the room.
    if (panel === "memory") {
      setView("workbench");
      setMemoryVisible((cur) => !cur);
      return;
    }
  }

  function applyLayout(layout: {
    explorer: boolean;
    terminal: boolean;
    ai: boolean;
  }) {
    setView("workbench");
    setExplorerVisible(layout.explorer);
    setTerminalVisible(layout.terminal);
    if (layout.ai) ensureAiRect();
    setAiVisible(layout.ai);
  }

  function updateCustomLayouts(next: LayoutPreset[]) {
    setCustomLayouts(next);
    saveCustomPresets(next);
  }

  function openGridSettings() {
    setSettingsInitial("layout");
    setView("settings");
  }

  function applyGrid(id: string) {
    setView("workbench");
    setActiveGridId(id);
  }

  function exitGrid() {
    setActiveGridId(null);
  }

  // Build the real panel for a grid cell. Reuses the same state/handlers as the
  // fixed frame, but with `fill` so each panel sizes to its cell.
  function renderPanel(kind: PanelKind, key: string): ReactNode {
    switch (kind) {
      case "editor":
        return (
          <div key={key} className="editor-frame" style={{ flex: 1, minHeight: 0 }}>
            <TabBar
              tabs={tabs.map((t) => ({ path: t.path, dirty: t.dirty }))}
              activeIdx={activeIdx}
              onSelect={setActiveIdx}
              onClose={closeTab}
              workspaceRoot={workspaceRoot}
            />
            <SearchPanel
              workspaceRoot={workspaceRoot}
              visible={searchVisible}
              onClose={() => setSearchVisible(false)}
              onOpenFile={openFile}
            />
            <EditorArea
              code={active?.code ?? ""}
              onChange={updateActiveCode}
              language={language ?? "plaintext"}
              hasFile={active !== null}
              theme={theme}
              fontSize={editorFontSize}
              lineNumbers={editorLineNumbers}
              wordWrap={editorWordWrap}
              minimap={editorMinimap}
              onEditorMount={(editor) => { editorRef.current = editor; }}
            />
          </div>
        );
      case "files":
        return (
          <Sidebar
            key={key}
            fill
            visible
            width={panelLayout.explorer?.w ?? 280}
            workspaceRoot={workspaceRoot}
            onOpen={openFile}
            onRootChange={setWorkspaceRoot}
            onEntryRenamed={onEntryRenamed}
            onEntryDeleted={onEntryDeleted}
            onFilePreview={setPreviewPath}
            activePath={active?.path ?? null}
          />
        );
      case "terminal":
        return (
          <TerminalPanel
            key={key}
            fill
            visible
            theme={theme}
            height={panelLayout.terminal?.h ?? 240}
            workspaceRoot={workspaceRoot}
            onToggle={() => {}}
          />
        );
      case "ai":
        return (
          <AiPanel
            key={key}
            fill
            visible
            width={aiPanels[0]?.rect.w ?? 360}
            panelId={aiPanels[0]?.id}
            initialProvider={aiPanels[0]?.provider}
            workspaceRoot={workspaceRoot}
            onFileWritten={onAgentWrote}
            onWorkspaceChanged={() =>
              workspaceRoot ? refreshGitStatus(workspaceRoot) : undefined
            }
            model={aiPanels[0]?.model ?? aiModel}
            onModelChange={(model) => updateAiPanelModel(aiPanels[0]?.id ?? "ai-main", model)}
            onProviderChange={(provider) => setAiPanelProvider(aiPanels[0]?.id ?? "ai-main", provider)}
            availableModels={panelModels[aiPanels[0]?.id ?? "ai-main"] ?? [aiPanels[0]?.model ?? aiModel]}
            onAvailableModelsChange={(models) => updatePanelModels(aiPanels[0]?.id ?? "ai-main", models)}
            apiKeyVersion={apiKeyVersion}
            requireDiffReview={requireDiffReview}
            stopAfterRejection={stopAfterRejection}
            skills={skills}
            harnessSettings={harnessSettings}
            resumeConversation={
              resumeTarget?.panelId === (aiPanels[0]?.id ?? "ai-main")
                ? resumeTarget.convo
                : null
            }
            onResumeConsumed={() => setResumeTarget(null)}
          />
        );
      default:
        return (
          <div
            style={{
              flex: 1,
              display: "grid",
              placeItems: "center",
              borderRadius: "var(--radius-md)",
              border: "1px dashed var(--border-strong)",
              color: "var(--fg-subtle)",
              fontSize: 12,
              textAlign: "center",
              padding: 12,
            }}
          >
            Skills open as a modal (⌘ palette) — not placeable in the grid yet
          </div>
        );
    }
  }

  function forgetFolder(path: string) {
    setRecentFolders((prev) => {
      const next = prev.filter((p) => p !== path);
      try {
        localStorage.setItem("klide.recentFolders", JSON.stringify(next));
      } catch {
        /* storage unavailable — skip */
      }
      return next;
    });
  }

  async function openFolderDialog() {
    const picked = await open({ directory: true });
    if (typeof picked === "string") setWorkspaceRoot(picked);
  }

  async function refreshGitStatus(root: string | null) {
    if (!root) {
      setGitStatus(null);
      return;
    }
    try {
      const next = await invoke<GitStatus>("git_status", { workspaceRoot: root });
      setGitStatus(next);
    } catch {
      setGitStatus(null);
    }
  }

  function eventsToTitle(events: AgentEvent[]): string {
    const first = events.find((e) => e.type === "user_message");
    if (first && first.type === "user_message") return first.text.slice(0, 120);
    return "Resumed run";
  }

  // Convert MissionControl's `RunMessage` (a read-back of the on-disk
  // transcript) into the AI panel's `Msg` shape so we can hand it to
  // `summarizeAndHandoff`, which expects Msg[]. The two shapes diverge
  // because MissionControl carries `tools: RunToolCall[]` per message
  // while the AI panel uses `toolCalls: ToolCall[]` (different types).
  // We do a best-effort conversion: the name + input are preserved, the
  // result and status are dropped (the summary doesn't need them).
  function runMessagesToAiMsgs(messages: MissionRunMessage[]): Msg[] {
    const out: Msg[] = [];
    for (const m of messages) {
      if (m.role === "user") {
        out.push({ role: "user", content: m.text });
      } else {
        const toolCalls = (m.tools ?? [])
          .map((t) => ({
            name: t.name,
            args: t.input,
          }))
          .filter((t) => Boolean(t.name));
        out.push({
          role: "assistant",
          content: m.text,
          ...(toolCalls.length > 0 ? { toolCalls: toolCalls as any } : {}),
        });
      }
    }
    return out;
  }

  async function resumeKlideRun(runId: string) {
    try {
      const events = await invoke<AgentEvent[]>("agent_read_run", { runId });
      const convo = eventsToConversation(events, runId, eventsToTitle(events));
      // Open one fresh panel and land the resumed run in it — never broadcast
      // to existing panels. Resume is triggered from the Mission Control view,
      // so switch back to the workbench (where AI panels render) and ensure the
      // AI surface is visible without toggling it off when it already is —
      // matches the CLI handoff path (`openRunInAiPanel`).
      setView("workbench");
      if (!aiVisible) togglePanel("ai");
      // Don't stack duplicates: if this run is already open in a panel that's
      // still around, just focus it. Re-clicking Resume on the same run would
      // otherwise pile up identical panels (each offset by appendAiPanel).
      const existing = resumePanelsRef.current.get(runId);
      if (existing && aiPanels.some((p) => p.id === existing)) {
        focusPanel(existing);
        return;
      }
      const panelId = appendAiPanel();
      resumePanelsRef.current.set(runId, panelId);
      setResumeTarget({ panelId, convo });
    } catch (e) {
      setFileNotice(e instanceof Error ? e.message : String(e));
    }
  }

  // "Open in {CLI}" / "Resume in {CLI}" from Mission Control — land the user
  // in a fresh AI panel pinned to that delegate provider. The AI panel is
  // the natural home for an agent TUI (it already renders DelegateTerminalSurface
  // for claude-code / codex / opencode). For Klide handoff, the first user
  // message becomes the CLI's task arg via `initialTask`.
  function openRunInAiPanel(opts: {
    provider: "claude-code" | "codex" | "opencode";
    workspaceRoot: string | null;
    resumeSessionId?: string;
    initialTask?: string;
  }) {
    setView("workbench");
    if (!aiVisible) togglePanel("ai");
    const id = appendAiPanel({ provider: opts.provider });
    setPendingAiPanel({
      panelId: id,
      provider: opts.provider,
      resumeSessionId: opts.resumeSessionId ?? null,
      initialTask: opts.initialTask ?? null,
    });
  }

  // "Review Diff" from Mission Control — for Klide runs the CheckpointPanel
  // is already mounted in the detail pane (it lists every file the agent
  // changed with revert affordances), so the row action is just: make sure
  // the run is selected. For external CLI runs we switch to the GitReview
  // view; the user can navigate from there. (CLI runs whose cwd differs
  // from the current workspaceRoot will show the wrong diff — that case
  // is rare in practice; if it becomes common we'll add a per-run diff
  // overlay later.)
  function reviewDiffFromRun(run: { id: string; source: string; cwd: string | null }) {
    if (run.source === "klide") {
      // MissionControl is rendered as a single view, so the run is "selected"
      // by being the current `view === "runs"` selection. We just need to
      // ask MissionControl to focus the CheckpointPanel — done via a small
      // bus (see pendingCheckpointRunId below).
      setPendingCheckpointRunId(run.id);
    } else {
      setView("git-review");
    }
  }

  // "Save Memory" from Mission Control — fetch the run's transcript, ask
  // the model for a structured note, and write it to .klide/memory/. Then
  // open the MemoryModal so the user can see the entry. Klide-only for
  // now: external CLI runs have no provider+model we can call directly.
  async function saveMemoryFromRun(run: {
    id: string;
    source: string;
    provider?: string | null;
    model: string | null;
    cwd: string | null;
  }) {
    if (run.source !== "klide") {
      setFileNotice("Save Memory is supported for Klide runs only in this slice — open the AI panel pinned to this run to summarise it.");
      return;
    }
    if (!run.cwd) {
      setFileNotice("Run has no workspace root — can't write a memory note.");
      return;
    }
    if (!run.provider || !run.model) {
      setFileNotice("Run is missing provider or model — can't summarise.");
      return;
    }
    setSummarizingFromRun(run.id);
    try {
      const messages = await fetchRunMessages(run as any);
      if (messages.length === 0) {
        setFileNotice("Run has no messages to summarise.");
        return;
      }
      const msgs = runMessagesToAiMsgs(messages);
      const entry = await summarizeAndHandoff({
        workspaceRoot: run.cwd,
        provider: run.provider,
        model: run.model,
        mode: "chat",
        msgs,
        runId: run.id,
        status: "done",
      });
      setMemoryRefreshKey((k) => k + 1);
      setMemoryVisible(true);
      setFileNotice(`Memory written → ${entry.title} (${entry.relPath})`);
    } catch (err) {
      setFileNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setSummarizingFromRun(null);
    }
  }

  function updateAiPanelModel(id: string, model: string) {
    setAiPanelModel(id, model);
    if (id === "ai-main") setAiModel(model);
  }

  function updatePanelModels(id: string, models: string[]) {
    setPanelModels((prev) => {
      const current = prev[id] ?? [];
      if (current.length === models.length && current.every((name, idx) => name === models[idx])) {
        return prev;
      }
      return { ...prev, [id]: models };
    });
  }

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("klide-theme", theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("klide-auto-theme", String(autoTheme));
  }, [autoTheme]);
  useEffect(() => {
    localStorage.setItem("klide-light-theme", lightTheme);
  }, [lightTheme]);
  useEffect(() => {
    localStorage.setItem("klide-dark-theme", darkTheme);
  }, [darkTheme]);

  // Grids are edited in Settings; refresh App's copy when returning to the
  // workbench so the status-bar Layout picker shows the latest.
  useEffect(() => {
    if (view === "workbench") setGridLayouts(loadGridLayouts());
  }, [view]);

  useEffect(() => {
    if (activeGridId) localStorage.setItem("klide-active-grid", activeGridId);
    else localStorage.removeItem("klide-active-grid");
  }, [activeGridId]);

  useEffect(() => {
  }, [workspaceRoot]);

  useEffect(() => {
    localStorage.setItem("klide-explorer-visible", String(explorerVisible));
  }, [explorerVisible]);

  useEffect(() => {
    if (sidebarSlot2) localStorage.setItem("klide-sidebar-slot2", sidebarSlot2);
    else localStorage.removeItem("klide-sidebar-slot2");
  }, [sidebarSlot2]);

  useEffect(() => {
    localStorage.setItem("klide-ai-visible", String(aiVisible));
  }, [aiVisible]);

  useEffect(() => {
    localStorage.setItem("klide-terminal-visible", String(terminalVisible));
  }, [terminalVisible]);

  function updateSkills(next: Skill[]) {
    saveSkills(next);
    setSkills(next);
  }
  void updateSkills;

  useEffect(() => {
    localStorage.setItem("klide-editor-font-size", String(editorFontSize));
  }, [editorFontSize]);

  useEffect(() => {
    localStorage.setItem("klide-editor-line-numbers", String(editorLineNumbers));
  }, [editorLineNumbers]);

  useEffect(() => {
    localStorage.setItem("klide-editor-word-wrap", String(editorWordWrap));
  }, [editorWordWrap]);

  useEffect(() => {
    localStorage.setItem("klide-editor-minimap", String(editorMinimap));
  }, [editorMinimap]);

  useEffect(() => {
    localStorage.setItem("klide-ai-model", aiModel);
  }, [aiModel]);

  useEffect(() => {
    localStorage.setItem("klide-confirm-agent-edits", String(requireDiffReview));
  }, [requireDiffReview]);

  useEffect(() => {
    localStorage.setItem("klide.stopAfterRejection", String(stopAfterRejection));
  }, [stopAfterRejection]);

  // Record every opened workspace as most-recent — covers folders opened from
  // the welcome screen, the sidebar, or restored sessions alike. Capped at 8.
  useEffect(() => {
    if (!workspaceRoot) return;
    setRecentFolders((prev) => {
      const next = [workspaceRoot, ...prev.filter((p) => p !== workspaceRoot)].slice(0, 8);
      try {
        localStorage.setItem("klide.recentFolders", JSON.stringify(next));
      } catch {
        /* storage unavailable — skip */
      }
      return next;
    });
  }, [workspaceRoot]);

  // Let the backend know which folder is open, so `${VAR}` token references
  // for self-hosted endpoints resolve from this project's `.env`.
  useEffect(() => {
    void invoke("set_active_workspace", { root: workspaceRoot }).catch(() => {
      /* command unavailable (non-Tauri preview) — ignore */
    });
  }, [workspaceRoot]);

  useEffect(() => {
    if (!workspaceRoot) {
      setGitStatus(null);
      return;
    }

    let cancelled = false;
    const refresh = () => {
      if (!cancelled) refreshGitStatus(workspaceRoot);
    };

    refresh();
    const interval = window.setInterval(refresh, 3_000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [workspaceRoot]);

  // Interactive delegate PTY (Claude Code / Codex / OpenCode) edits files
  // outside the harness's FileChanged event stream, so the file watcher is
  // the only other path that refreshes git status. Refresh explicitly on
  // session exit so the sidebar decorations update the moment the user
  // finishes an interactive run.
  useEffect(() => {
    if (!workspaceRoot || !("__TAURI_INTERNALS__" in window)) return;
    let unlisten: (() => void) | undefined;
    void listen("delegate-pty:exit", () => {
      refreshGitStatus(workspaceRoot);
    }).then((u) => { unlisten = u; });
    return () => { unlisten?.(); };
  }, [workspaceRoot]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;

      if (mod && !e.shiftKey && e.key === "s" && active) {
        e.preventDefault();
        saveActive();
        return;
      }
      if (mod && !e.shiftKey && e.key === "`") {
        e.preventDefault();
        setTerminalVisible((v) => !v);
        return;
      }
      if (mod && !e.shiftKey && e.key === "o") {
        e.preventDefault();
        openFolderDialog();
        return;
      }
      if (mod && e.shiftKey && e.key === "F") {
        e.preventDefault();
        setSearchVisible((v) => !v);
        return;
      }
      // Plain Cmd+F is NOT intercepted — it belongs to Monaco's in-editor find.
      if (mod && !e.shiftKey && e.key === "p") {
        e.preventDefault();
        setPaletteQuery(e.shiftKey ? "> " : "");
        setPaletteOpen(true);
        return;
      }
      if (mod && e.shiftKey && e.key === "P") {
        e.preventDefault();
        setPaletteQuery("> ");
        setPaletteOpen(true);
        return;
      }
      if (mod && !e.shiftKey && e.key === "w" && tabs.length > 0) {
        e.preventDefault();
        closeTab(activeIdx >= 0 ? activeIdx : 0);
        return;
      }
      if (mod && !e.shiftKey && e.key === ",") {
        e.preventDefault();
        setView("settings");
        return;
      }
      if (mod && !e.shiftKey && e.key === ".") {
        e.preventDefault();
        setProfileVisible((v) => !v);
        return;
      }
      if (mod && !e.shiftKey && e.key === "n") {
        e.preventDefault();
        setView("workbench");
        return;
      }
      if (mod && e.shiftKey && e.key === "G") {
        e.preventDefault();
        setView((v) => (v === "git-review" ? "workbench" : "git-review"));
        return;
      }
      // Tab navigation
      if (mod && !e.shiftKey && e.key === "Tab" && tabs.length > 1) {
        e.preventDefault();
        setActiveIdx((i) => (i + 1) % tabs.length);
        return;
      }
      if (mod && e.shiftKey && e.key === "Tab" && tabs.length > 1) {
        e.preventDefault();
        setActiveIdx((i) => (i - 1 + tabs.length) % tabs.length);
        return;
      }
      // Escape — close palette, search, or return to workbench from a top-level view
      if (e.key === "Escape") {
        if (paletteOpen) { setPaletteOpen(false); return; }
        if (searchVisible) { setSearchVisible(false); return; }
        if (view === "runs" || view === "orchestrator" || view === "git-review" || view === "settings") {
          e.preventDefault();
          setView("workbench");
          return;
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, activeIdx, tabs, saveActive, paletteOpen, searchVisible, view]);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    const unlisteners: (() => void)[] = [];
    void (async () => {
      unlisteners.push(await listen("menu:command-palette", () => {
        setPaletteQuery("> ");
        setPaletteOpen(true);
      }));
      unlisteners.push(await listen("menu:find-in-files", () => {
        setSearchVisible((v) => !v);
      }));
      unlisteners.push(await listen("menu:toggle-terminal", () => {
        setTerminalVisible((v) => !v);
      }));
      unlisteners.push(await listen("menu:toggle-search", () => {
        setSearchVisible((v) => !v);
      }));
      unlisteners.push(await listen("menu:open-settings", () => {
        setView("settings");
      }));
      unlisteners.push(await listen("menu:close-tab", () => {
        if (activeIdx >= 0 && activeIdx < tabs.length) closeTab(activeIdx);
      }));
      unlisteners.push(await listen("menu:close-window", () => {
        // On macOS, window close is handled by the system; this is a fallback
      }));
      unlisteners.push(await listen("menu:open-folder", () => {
        openFolderDialog();
      }));
    })();
    return () => { unlisteners.forEach((u) => u()); };
  }, [activeIdx, tabs]);

  const language = active ? detectLanguage(active.path) : null;

  // ── Command palette ──────────────────────────────────────────────────

  useEffect(() => {
    function onPaletteClose() { setPaletteOpen(false); }
    window.addEventListener("command-palette-close" as any, onPaletteClose);
    return () => window.removeEventListener("command-palette-close" as any, onPaletteClose);
  }, []);

  const paletteCommands = [
    { id: "save", label: "File: Save", shortcut: "⌘S", action: () => { saveActive(); setPaletteOpen(false); } },
    { id: "open-folder", label: "File: Open Folder…", shortcut: "⌘O", action: () => { openFolderDialog(); setPaletteOpen(false); } },
    { id: "close-tab", label: "View: Close Tab", shortcut: "⌘W", action: () => { if (activeIdx >= 0) closeTab(activeIdx); setPaletteOpen(false); } },
    { id: "find", label: "Edit: Find in Files", shortcut: "⌘⇧F", action: () => { setSearchVisible((v) => !v); setPaletteOpen(false); } },
    { id: "terminal-toggle", label: "Terminal: Toggle", shortcut: "⌘`", action: () => { setTerminalVisible((v) => !v); setPaletteOpen(false); } },
    { id: "settings", label: "Preferences: Open Settings", shortcut: "⌘,", action: () => { setView("settings"); setPaletteOpen(false); } },
    { id: "profile", label: "View: Open Profile", shortcut: "⌘.", action: () => { setProfileVisible(true); setPaletteOpen(false); } },
    { id: "theme", label: "Appearance: Toggle Theme", action: () => { setTheme((t) => getNextThemeId(t)); setPaletteOpen(false); } },
    { id: "word-wrap", label: "Editor: Toggle Word Wrap", action: () => { setEditorWordWrap((v) => !v); setPaletteOpen(false); } },
    { id: "line-numbers", label: "Editor: Toggle Line Numbers", action: () => { setEditorLineNumbers((v) => !v); setPaletteOpen(false); } },
    { id: "minimap", label: "Editor: Toggle Minimap", action: () => { setEditorMinimap((v) => !v); setPaletteOpen(false); } },
    { id: "runs", label: "View: Mission Control", action: () => { setView("runs"); setPaletteOpen(false); } },
    { id: "orchestrator", label: "View: Orchestrator Preview", action: () => { setView("orchestrator"); setPaletteOpen(false); } },
    { id: "back-to-workbench", label: "View: Back to Workbench", shortcut: "Esc", action: () => { setView("workbench"); setPaletteOpen(false); } },
    { id: "git-review", label: "View: Git Review", shortcut: "⌘⇧G", action: () => { setView((v) => v === "git-review" ? "workbench" : "git-review"); setPaletteOpen(false); } },
    { id: "create-pr", label: "Git: Create Pull Request…", action: () => { setPaletteOpen(false); void (async () => { try { const pr = await invoke<string>("create_pr", { workspaceRoot, title: "Klide changes", body: null }); setFileNotice(`PR: ${pr}`); } catch(e) { setFileNotice(`PR failed: ${e}`); } })(); } },
    { id: "worktree", label: "Git: New Worktree…", action: () => { setPaletteOpen(false); const name = prompt("Worktree name:"); if (name && workspaceRoot) { void (async () => { try { const path = await invoke<string>("create_worktree", { workspaceRoot, name }); setFileNotice(`Worktree: ${path}`); } catch(e) { setFileNotice(`Failed: ${e}`); } })(); } } },
    { id: "rollback", label: "Git: View Checkpoints", action: () => { setView("runs"); setPaletteOpen(false); } },
    { id: "reload", label: "Developer: Reload Window", action: () => { window.location.reload(); } },
  ];
  const statusTheme =
    autoTheme
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? darkTheme
        : lightTheme
      : theme;

  // Nothing open → a full-screen welcome page (no chrome at all). Settings stays
  // reachable so API keys can be set up before a folder is ever opened.
  if (view !== "settings" && !workspaceRoot) {
    return (
      <div
        style={{
          height: "100vh",
          display: "flex",
          flexDirection: "column",
          borderTop: "1px solid var(--border-strong)",
          background: "var(--bg)",
        }}
      >
        <WelcomeScreen
          recentFolders={recentFolders}
          onOpenFolder={openFolderDialog}
          onOpenRecent={setWorkspaceRoot}
          onRemoveRecent={forgetFolder}
          onOpenSettings={() => setView("settings")}
        />
      </div>
    );
  }

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        borderTop: "1px solid var(--border-strong)",
      }}
    >
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {view === "settings" ? (
          <SettingsPanel
            key={settingsInitial ?? "default"}
            initialSection={settingsInitial}
            theme={theme}
            onThemeChange={setTheme}
            autoTheme={autoTheme}
            onAutoThemeChange={setAutoTheme}
            lightTheme={lightTheme}
            onLightThemeChange={setLightTheme}
            darkTheme={darkTheme}
            onDarkThemeChange={setDarkTheme}
            aiVisible={aiVisible}
            onAiVisibleChange={setAiVisible}
            terminalVisible={terminalVisible}
            onTerminalVisibleChange={setTerminalVisible}
            panelLayout={panelLayout}
            onPanelWidthChange={(panel, w) => {
              if (panel === "explorer" && panelLayout.explorer) {
                updatePanelRect("explorer", { ...panelLayout.explorer, w });
              } else if (panel === "ai" && aiPanels[0]) {
                updateAiRect(aiPanels[0].id, { ...aiPanels[0].rect, w });
              }
            }}
            onPanelHeightChange={(panel, h) => {
              if (panel === "terminal" && panelLayout.terminal) {
                updatePanelRect("terminal", { ...panelLayout.terminal, h });
              }
            }}
            editorFontSize={editorFontSize}
            onEditorFontSizeChange={setEditorFontSize}
            editorLineNumbers={editorLineNumbers}
            onEditorLineNumbersChange={setEditorLineNumbers}
            editorWordWrap={editorWordWrap}
            onEditorWordWrapChange={setEditorWordWrap}
            editorMinimap={editorMinimap}
            onEditorMinimapChange={setEditorMinimap}
            aiModel={aiModel}
            onAiModelChange={setAiModel}
            availableAiModels={panelModels["ai-main"] ?? [aiModel]}
            requireDiffReview={requireDiffReview}
            onRequireDiffReviewChange={setRequireDiffReview}
            stopAfterRejection={stopAfterRejection}
            onStopAfterRejectionChange={setStopAfterRejection}
            harnessSettings={harnessSettings}
            onHarnessSettingsChange={setHarnessSettings}
            explorerVisible={explorerVisible}
            customLayouts={customLayouts}
            onCustomLayoutsChange={updateCustomLayouts}
            onApplyLayout={applyLayout}
            onProviderKeyChange={() => setApiKeyVersion((version) => version + 1)}
            onBack={() => setView("workbench")}
          />
        ) : (
          <>
            <ActivityBar active={activityState} onToggle={togglePanel} />
            {view === "git-review" ? (
              <GitReview
                workspaceRoot={workspaceRoot}
                gitStatus={gitStatus}
                onRefreshGitStatus={() => workspaceRoot ? refreshGitStatus(workspaceRoot) : Promise.resolve()}
                onBack={() => setView("workbench")}
                theme={theme}
              />
            ) : view === "runs" ? (
              <MissionControl
                workspaceRoot={workspaceRoot}
                theme={theme}
                onResumeKlideRun={resumeKlideRun}
                onOpenInAiPanel={openRunInAiPanel}
                onReviewDiff={reviewDiffFromRun}
                onSaveMemory={saveMemoryFromRun}
                pendingCheckpointRunId={pendingCheckpointRunId}
                onPendingCheckpointConsumed={() => setPendingCheckpointRunId(null)}
                summarizingFromRunId={summarizingFromRun}
                onBack={() => setView("workbench")}
              />
            ) : view === "orchestrator" ? (
              <OrchestratorPreview />
            ) : activeGrid ? (
              <GridWorkbench layout={activeGrid} renderPanel={renderPanel} />
            ) : panelLayout.anchored ? (
              <AnchoredWorkbench
                workbenchRef={workbenchRef}
                workbenchSize={workbenchSize}
                onWorkbenchSize={setWorkbenchSize}
                panelLayout={panelLayout}
                aiPanels={aiPanels}
                focusedPanel={focusedPanel}
                zCounter={zCounter}
                explorerVisible={explorerVisible}
                terminalVisible={terminalVisible}
                aiVisible={aiVisible}
                sidebarSlot2={sidebarSlot2}
                tabs={tabs}
                activeIdx={activeIdx}
                workspaceRoot={workspaceRoot}
                searchVisible={searchVisible}
                active={active}
                language={language}
                theme={theme}
                editorFontSize={editorFontSize}
                editorLineNumbers={editorLineNumbers}
                editorWordWrap={editorWordWrap}
                editorMinimap={editorMinimap}
                onSelectTab={setActiveIdx}
                onCloseTab={closeTab}
                onChangeCode={updateActiveCode}
                setSearchVisible={setSearchVisible}
                onOpenFile={openFile}
                onRootChange={setWorkspaceRoot}
                onEntryRenamed={onEntryRenamed}
                onEntryDeleted={onEntryDeleted}
                onFilePreview={setPreviewPath}
                setExplorerVisible={setExplorerVisible}
                setSidebarSlot2={setSidebarSlot2}
                setTerminalVisible={setTerminalVisible}
                focusPanel={focusPanel}
                onMountEditor={(editor) => { editorRef.current = editor; }}
                skills={skills}
                setSkills={(next) => {
                  setSkills(next);
                  saveSkills(next);
                }}
                reloadFilesystemSkills={reloadFilesystemSkills}
                apiKeyVersion={apiKeyVersion}
                requireDiffReview={requireDiffReview}
                stopAfterRejection={stopAfterRejection}
                aiModel={aiModel}
                panelModels={panelModels}
                setPanelModels={setPanelModels}
                onAiPanelModelChange={updateAiPanelModel}
                onAiPanelProviderChange={setAiPanelProvider}
                onDuplicateAiPanel={appendAiPanel}
                onCloseAiPanel={closeAiPanel}
                onAgentWrote={onAgentWrote}
                refreshGitStatus={refreshGitStatus}
                onPanelWidthChange={(panel, w) => {
                  if (panel === "explorer" && panelLayout.explorer) {
                    updatePanelRect("explorer", { ...panelLayout.explorer, w });
                  } else if (panel === "ai" && aiPanels[0]) {
                    updateAiRect(aiPanels[0].id, { ...aiPanels[0].rect, w });
                  }
                }}
                onPanelHeightChange={(panel, h) => {
                  if (panel === "terminal" && panelLayout.terminal) {
                    updatePanelRect("terminal", { ...panelLayout.terminal, h });
                  }
                }}
                pendingAiPanel={pendingAiPanel}
                onPendingAiPanelConsumed={() => setPendingAiPanel(null)}
                resumeTarget={resumeTarget}
                onResumeConsumed={() => setResumeTarget(null)}
                previewPath={previewPath}
                onClosePreview={() => setPreviewPath(null)}
                onMemoryWritten={(entry) => {
                  setMemoryRefreshKey((k) => k + 1);
                  setFileNotice(`Memory written → ${entry.title} (${entry.relPath})`);
                }}
                onSkillGenerated={(skill) => {
                  void reloadFilesystemSkills();
                  setFileNotice(`Skill generated → ${skill.name} (${skill.relPath})`);
                }}
                harnessSettings={harnessSettings}
              />
            ) : (
              <div
                ref={workbenchRef}
                className="workbench-main"
                style={{
                  flex: 1,
                  minWidth: 0,
                  minHeight: 0,
                  position: "relative",
                  // No padding: FloatingPanels are absolutely positioned
                  // from the workbench's padding box edge, and their
                  // negative-offset resize handles need a few px of room
                  // past the panel edge. The editor carries its own
                  // 6px inset so the visual margin is preserved.
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    inset: 6,
                      display: "flex",
                      flexDirection: "column",
                      minWidth: 0,
                      minHeight: 0,
                      borderRadius: "var(--radius-md)",
                      border: "1px solid color-mix(in srgb, var(--border) 82%, transparent)",
                      background: "color-mix(in srgb, var(--bg) 92%, transparent)",
                      boxShadow: "inset 0 1px 0 var(--panel-highlight)",
                      backdropFilter: "blur(10px)",
                      WebkitBackdropFilter: "blur(10px)",
                      overflow: "hidden",
                      zIndex: 1,
                    }}
                  >
                    <TabBar
                      tabs={tabs.map((t) => ({ path: t.path, dirty: t.dirty }))}
                      activeIdx={activeIdx}
                      onSelect={setActiveIdx}
                      onClose={closeTab}
                      workspaceRoot={workspaceRoot}
                    />
                    <SearchPanel
                      workspaceRoot={workspaceRoot}
                      visible={searchVisible}
                      onClose={() => setSearchVisible(false)}
                      onOpenFile={openFile}
                    />
                    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
                      <EditorArea
                        code={active?.code ?? ""}
                        onChange={updateActiveCode}
                        language={language ?? "plaintext"}
                        hasFile={active !== null}
                        theme={theme}
                        fontSize={editorFontSize}
                        lineNumbers={editorLineNumbers}
                        wordWrap={editorWordWrap}
                        minimap={editorMinimap}
                        onEditorMount={(editor) => { editorRef.current = editor; }}
                      />
                    </div>
                  </div>
                {explorerVisible && (
                  <FloatingPanel
                    panelId="explorer"
                    rect={explorerRect}
                    workbenchW={workbenchSize.w}
                    workbenchH={workbenchSize.h}
                    zIndex={focusedPanel === "explorer" ? 10 + zCounter : 10}
                    onFocus={() => focusPanel("explorer")}
                    onResize={(next) => updatePanelRect("explorer", next)}
                    onMove={(next) => updatePanelRect("explorer", next)}
                  >
                    {sidebarSlot2 ? (
                      <SplitPane
                        top={
                          <Sidebar
                            fill
                            visible
                            width={explorerRect.w}
                            workspaceRoot={workspaceRoot}
                            onOpen={openFile}
                            onRootChange={setWorkspaceRoot}
                            onEntryRenamed={onEntryRenamed}
                            onEntryDeleted={onEntryDeleted}
                            onFilePreview={setPreviewPath}
                            activePath={active?.path ?? null}
                          />
                        }
                        bottom={
                          sidebarSlot2 === "skills" ? (
                            <SkillsModal
                              open
                              skills={skills}
                              onChange={setSkills}
                              onReloadFilesystemSkills={reloadFilesystemSkills}
                              onClose={() => setSidebarSlot2(null)}
                            />
                          ) : null
                        }
                        defaultSplit={explorerRect.h * 0.45}
                        minPane={80}
                      />
                    ) : (
                      <Sidebar
                        fill
                        visible
                        width={explorerRect.w}
                        workspaceRoot={workspaceRoot}
                        onOpen={openFile}
                        onRootChange={setWorkspaceRoot}
                        onEntryRenamed={onEntryRenamed}
                        onEntryDeleted={onEntryDeleted}
                        onFilePreview={setPreviewPath}
                        activePath={active?.path ?? null}
                      />
                    )}
                  </FloatingPanel>
                )}
                {previewPath && (
                  <div
                    style={{
                      position: "absolute",
                      right: 8,
                      top: 8,
                      width: 440,
                      maxHeight: "calc(100% - 16px)",
                      background: "var(--bg-elevated)",
                      border: "1px solid var(--panel-border)",
                      borderRadius: "var(--radius-md)",
                      boxShadow: "var(--panel-shadow)",
                      zIndex: 20,
                      display: "flex",
                      flexDirection: "column",
                      overflow: "hidden",
                    }}
                  >
                    <FileViewerPanel
                      key={previewPath}
                      filePath={previewPath}
                      workspaceRoot={workspaceRoot}
                      onClose={() => setPreviewPath(null)}
                    />
                  </div>
                )}
                {terminalVisible && (
                  <FloatingPanel
                    panelId="terminal"
                    rect={terminalRect}
                    workbenchW={workbenchSize.w}
                    workbenchH={workbenchSize.h}
                    zIndex={focusedPanel === "terminal" ? 10 + zCounter : 10}
                    onFocus={() => focusPanel("terminal")}
                    onResize={(next) => updatePanelRect("terminal", next)}
                    onMove={(next) => updatePanelRect("terminal", next)}
                  >
                    <TerminalPanel
                      fill
                      visible
                      theme={theme}
                      height={terminalRect.h}
                      workspaceRoot={workspaceRoot}
                      onToggle={() => setTerminalVisible((v) => !v)}
                    />
                  </FloatingPanel>
                )}
                {aiVisible && aiPanels.map((panel, idx) => {
                  return (
                    <FloatingPanel
                      key={panel.id}
                      panelId="ai"
                      rect={panel.rect}
                      workbenchW={workbenchSize.w}
                      workbenchH={workbenchSize.h}
                      zIndex={focusedPanel === panel.id ? 10 + zCounter : 10 + idx}
                      onFocus={() => focusPanel(panel.id)}
                      onResize={(next) => updateAiRect(panel.id, next)}
                      onMove={(next) => updateAiRect(panel.id, next)}
                    >
                      <AiPanel
                        fill
                        visible
                        width={panel.rect.w}
                        panelId={panel.id}
                        initialProvider={
                          pendingAiPanel?.panelId === panel.id
                            ? pendingAiPanel.provider
                            : panel.provider
                        }
                        initialResumeSessionId={
                          pendingAiPanel?.panelId === panel.id
                            ? pendingAiPanel.resumeSessionId
                            : undefined
                        }
                        initialTask={
                          pendingAiPanel?.panelId === panel.id
                            ? pendingAiPanel.initialTask
                            : undefined
                        }
                        onInitialConsumed={
                          pendingAiPanel?.panelId === panel.id
                            ? () => setPendingAiPanel(null)
                            : undefined
                        }
                        workspaceRoot={workspaceRoot}
                        onFileWritten={onAgentWrote}
                        onWorkspaceChanged={() =>
                          workspaceRoot ? refreshGitStatus(workspaceRoot) : undefined
                        }
                        model={panel.model ?? aiModel}
                        onModelChange={(model) => updateAiPanelModel(panel.id, model)}
                        onProviderChange={(provider) => setAiPanelProvider(panel.id, provider)}
                        availableModels={panelModels[panel.id] ?? [panel.model ?? aiModel]}
                        onAvailableModelsChange={(models) => updatePanelModels(panel.id, models)}
                        apiKeyVersion={apiKeyVersion}
                        requireDiffReview={requireDiffReview}
                        stopAfterRejection={stopAfterRejection}
                        skills={skills}
                        harnessSettings={harnessSettings}
                        onDuplicate={appendAiPanel}
                        onClose={
                          aiPanels.length > 1 ? () => closeAiPanel(panel.id) : undefined
                        }
                        resumeConversation={
                          resumeTarget?.panelId === panel.id ? resumeTarget.convo : null
                        }
                        onResumeConsumed={() => setResumeTarget(null)}
                        onMemoryWritten={(entry) => {
                          setMemoryRefreshKey((k) => k + 1);
                          setFileNotice(
                            `Memory written → ${entry.title} (${entry.relPath})`
                          );
                        }}
                        onSkillGenerated={(skill) => {
                          void reloadFilesystemSkills();
                          setFileNotice(`Skill generated → ${skill.name} (${skill.relPath})`);
                        }}
                      />
                    </FloatingPanel>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
      <StatusBar
        path={active?.path ?? null}
        language={language}
        workspaceRoot={workspaceRoot}
        fileNotice={active?.externalChanged ? "File changed on disk" : fileNotice}
        gitStatus={gitStatus}
        terminalVisible={terminalVisible}
        onToggleTerminal={() => setTerminalVisible((v) => !v)}
        gridLayouts={gridLayouts}
        activeGridId={activeGridId}
        anchoredLayout={panelLayout.anchored !== false}
        onApplyGrid={applyGrid}
        onExitGrid={exitGrid}
        onSetAnchored={setAnchoredLayout}
        onOpenGrid={openGridSettings}
        theme={statusTheme}
        autoTheme={autoTheme}
        onToggleTheme={() => setTheme((t) => getNextThemeId(t))}
        onResetLayout={resetPanelLayout}
      />
      <SkillsModal
        open={skillsVisible && sidebarSlot2 !== "skills"}
        skills={skills}
        onChange={updateSkills}
        onReloadFilesystemSkills={reloadFilesystemSkills}
        onClose={() => setSkillsVisible(false)}
      />
      <MemoryModal
        open={memoryVisible}
        workspaceRoot={workspaceRoot}
        refreshKey={memoryRefreshKey}
        onOpenInEditor={(path: string, content: string) => openFile(path, content)}
        onOpenTouchedFile={async (path: string) => {
          if (!workspaceRoot) return;
          try {
            const content = await readWorkspaceTextFile(workspaceRoot, path);
            openFile(path, content);
            setMemoryVisible(false);
          } catch (err) {
            setFileNotice(err instanceof Error ? err.message : String(err));
          }
        }}
        onClose={() => setMemoryVisible(false)}
      />
      <ProfileModal
        open={profileVisible}
        workspaceRoot={workspaceRoot}
        onClose={() => setProfileVisible(false)}
      />
      {paletteOpen && (
        <CommandPalette
          workspaceRoot={workspaceRoot}
          commands={paletteCommands}
          onOpenFile={openFile}
          initialQuery={paletteQuery}
        />
      )}
    </div>
  );
}

export default App;
