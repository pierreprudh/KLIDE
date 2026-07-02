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
// The real tier-board console (built from the prototype's winning variant C).
import { OrchestratorConsole } from "./components/OrchestratorConsole";
import { Sidebar } from "./components/Sidebar";
import { FocusMode } from "./components/FocusMode";
import { TabBar } from "./components/TabBar";
import { EditorArea } from "./components/EditorArea";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { TerminalPanel } from "./components/TerminalPanel";
import { AiPanel } from "./components/AiPanel";
import { StatusBar } from "./components/StatusBar";
import ToastHost from "./components/ToastHost";
import { notify } from "./toast";
import { eventsToConversation } from "./components/ai/eventsToMsgs";
import { loadPanelSession } from "./components/ai/utils";
import type { AgentEvent, ProviderId } from "./agent/types";
import { DEFAULT_MODELS } from "./agent/providers";
import type { Conversation, Msg } from "./components/ai/types";
import { summarizeAndHandoff } from "./components/ai/summarize";
import { fetchRunMessages, type Run, type RunMessage as MissionRunMessage } from "./runs";
import type { DelegateId } from "./delegates";
import type { GitStatus } from "./gitTypes";
import { GitReview } from "./components/GitReview";
import { MemoryModal } from "./components/MemoryModal";
import { WorktreesModal } from "./components/WorktreesModal";
import { FileViewerPanel } from "./components/FileViewerPanel";
import { DiffViewerPanel } from "./components/DiffViewerPanel";
import { SkillsModal } from "./components/SkillsModal";
import { SettingsPanel } from "./components/SettingsPanel";
import { ProfileModal } from "./components/ProfileModal";
import { KeyboardShortcuts } from "./components/KeyboardShortcuts";
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
type ActivityPanel = Panel | "orchestrator" | "home";
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
  /** Optional command to run after accepted edits/creates. Empty/absent means off. */
  testAfterEditCommand?: string;
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
  const [gitReviewRoot, setGitReviewRoot] = useState<string | null>(null);
  const [explorerVisible, setExplorerVisible] = useState(
    () => localStorage.getItem("klide-explorer-visible") !== "false"
  );
  // General settings — startup, files, and tab behaviour.
  const [restoreLastProject, setRestoreLastProject] = useState(
    () => localStorage.getItem("klide-restore-project") === "true"
  );
  const [autoSaveMode, setAutoSaveMode] = useState<"off" | "delay" | "blur">(() => {
    const v = localStorage.getItem("klide-autosave");
    return v === "delay" || v === "blur" ? v : "off";
  });
  const [showHiddenFiles, setShowHiddenFiles] = useState(
    () => localStorage.getItem("klide-show-hidden") !== "false"
  );
  const [confirmCloseDirty, setConfirmCloseDirty] = useState(
    () => localStorage.getItem("klide-confirm-close") !== "false"
  );
  // Third main screen next to Anchored and Free: a single centered AI
  // conversation (the Claude Code / Codex desktop pattern). The editor,
  // explorer, and terminal step back; the chat column is the workbench.
  const [focusMode, setFocusMode] = useState(
    () => localStorage.getItem("klide-focus-mode") === "true"
  );
  // Focus screen state: home (hero composer) vs the live conversation, and
  // the hero composer's text on its way into the AI panel.
  const [focusChatActive, setFocusChatActive] = useState(false);
  const [focusInitialMessage, setFocusInitialMessage] = useState<string | null>(null);
  const [memoryVisible, setMemoryVisible] = useState(false);
  const [worktreesVisible, setWorktreesVisible] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
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
  const [diffView, setDiffView] = useState<{ path: string; oldContent: string; newContent: string; isCreate: boolean } | null>(null);
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
    provider: DelegateId;
    resumeSessionId: string | null;
    initialTask: string | null;
    /** Set only for "Reattach" to a live session — binds the new panel to the
     *  running PTY's conversation id so its terminal reconnects + replays. */
    conversationId: string | null;
  } | null>(null);
  void pendingAiPanel;
  const [apiKeyVersion, setApiKeyVersion] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [searchVisible, setSearchVisible] = useState(false);
  // Action results + failures route through the global toast bus (see
  // src/toast.ts). Kept the `setFileNotice` name so the ~30 existing call sites
  // are untouched; `null` is a no-op (used to clear the old status-bar slot).
  const setFileNotice = useCallback((msg: string | null) => {
    if (msg) notify(msg);
  }, []);
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
  } = useEditorTabs({
    notify: setFileNotice,
    workspaceRoot,
    autoSave: autoSaveMode,
    confirmCloseDirty,
  });
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
    zMap,
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
  } = usePanelLayout({ workspaceRoot, view, focusMode });
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
  // Global default for "require diff review" (auto-accept off). Settings edits
  // this. Each AI panel keeps its own override below — toggling auto-accept in
  // one conversation must NOT leak into the others.
  const [requireDiffReview, setRequireDiffReview] = useState(() =>
    readBoolSetting("klide-confirm-agent-edits", true)
  );
  // Per-panel overrides, keyed by panelId (same pattern as `panelModels`).
  // A panel with no entry falls back to the global default. In-memory only:
  // on reload every panel reverts to the safe global default.
  const [panelReviewOverrides, setPanelReviewOverrides] = useState<Record<string, boolean>>({});
  const reviewForPanel = (id: string) =>
    id in panelReviewOverrides ? panelReviewOverrides[id] : requireDiffReview;
  const setPanelReview = (id: string, value: boolean) =>
    setPanelReviewOverrides((prev) => ({ ...prev, [id]: value }));
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
  const effectiveGitReviewRoot = gitReviewRoot ?? workspaceRoot;
  const activityState: Record<ActivityPanel, boolean> = {
    home: view === "workbench",
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
    if (panel === "home") {
      // Home = back to the main workbench from wherever you are (Mission
      // Control, Git, Settings, …). Leaving a project entirely is the
      // native Projects menu's job ("Welcome Screen" item), not this
      // button's — it never clears the workspace.
      setView("workbench");
      return;
    }
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
        // Coming back from a non-workbench view (Mission Control,
        // Orchestrator, Git Review) the icon should always *show* the
        // panel — its visibility state still reads `true` from before the
        // user left, so a plain toggle would hide it and they'd have to
        // click twice to get back. Mirrors the AI-panel behaviour above.
        const cameFromOtherView = view !== "workbench";
        if (panel === "explorer") {
          const willShow = cameFromOtherView ? true : !explorerVisible;
          setExplorerVisible(willShow);
          // In free mode the explorer is a FloatingPanel sharing the
          // z-stack with the AI/terminal panels. Opening it must raise it
          // to the front, otherwise it appears "in the background" behind a
          // panel that happens to overlap its position.
          if (willShow) focusPanel("explorer");
        } else {
          setSkillsVisible((cur) => cameFromOtherView ? true : !cur);
        }
      }
      return;
    }
    // Git is a dedicated full-window view, not a sidebar panel.
    if (panel === "git") {
      setGitReviewRoot(null);
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
  function renderPanel(
    kind: PanelKind,
    key: string,
    opts?: { aiVariant?: "focus" }
  ): ReactNode {
    switch (kind) {
      case "editor":
        return (
          <div key={key} className="editor-frame" style={{ flex: 1, minHeight: 0 }}>
            <TabBar
              tabs={tabs.map((t) => ({ path: t.path, dirty: t.dirty, externalChanged: t.externalChanged }))}
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
            showHidden={showHiddenFiles}
            width={panelLayout.explorer?.w ?? 280}
            workspaceRoot={workspaceRoot}
            onOpen={openFile}
            onRootChange={changeRoot}
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
            requireDiffReview={reviewForPanel(aiPanels[0]?.id ?? "ai-main")}
            onRequireDiffReviewChange={(v) => setPanelReview(aiPanels[0]?.id ?? "ai-main", v)}
            onOpenDiff={setDiffView}
            stopAfterRejection={stopAfterRejection}
            skills={skills}
            harnessSettings={harnessSettings}
            onForkConversationInWorktree={forkConversationInWorktree}
            resumeConversation={
              resumeTarget?.panelId === (aiPanels[0]?.id ?? "ai-main")
                ? resumeTarget.convo
                : null
            }
            onResumeConsumed={() => setResumeTarget(null)}
            variant={opts?.aiVariant}
            initialMessage={opts?.aiVariant === "focus" ? focusInitialMessage : null}
            onInitialMessageConsumed={() => setFocusInitialMessage(null)}
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
    if (typeof picked === "string") changeRoot(picked);
  }

  // Return to the welcome screen so a different project can be opened. Clears
  // open tabs so no stale paths from the old workspace linger, and drops any
  // full-screen view (settings/git/etc.) back to the workbench so the welcome
  // condition (`view !== "settings" && !workspaceRoot`) actually fires.
  function closeFolder() {
    setView("workbench");
    setWorkspaceRoot(null);
  }

  // Single entry point for switching projects. Clearing the root (null) sends
  // you back to Welcome; switching swaps the workspace. Floating panels are
  // persisted per project (usePanelLayout keys on workspaceRoot), so the target
  // project's own window layout re-hydrates and the previous one is restored
  // when you switch back — we never wipe tabs or windows on switch.
  const changeRoot = (root: string | null) => {
    if (root === null) return closeFolder();
    if (root === workspaceRoot) return;
    setWorkspaceRoot(root);
  };

  // ── Native macOS menu: Projects ─────────────────────────────────────
  // Project switching and the Welcome screen live in the system menu bar
  // now — the rail's home icon returns to the workbench. The menu is
  // rebuilt whenever the recents list or the active project changes, and is
  // APPENDED to Tauri's default menu so the stock App/Edit/Window menus
  // (copy, paste, hide, …) survive.
  useEffect(() => {
    let cancelled = false;
    async function build() {
      try {
        const { Menu, Submenu, MenuItem, CheckMenuItem, PredefinedMenuItem } =
          await import("@tauri-apps/api/menu");
        const projectItems = await Promise.all(
          recentFolders.map((p) =>
            CheckMenuItem.new({
              text: p.split("/").filter(Boolean).pop() ?? p,
              checked: p === workspaceRoot,
              action: () => changeRoot(p),
            })
          )
        );
        const items = [
          ...projectItems,
          ...(projectItems.length > 0
            ? [await PredefinedMenuItem.new({ item: "Separator" })]
            : []),
          await MenuItem.new({ text: "Open Folder…", action: () => void openFolderDialog() }),
          await MenuItem.new({ text: "Welcome Screen", action: () => closeFolder() }),
        ];
        const submenu = await Submenu.new({ text: "Projects", items });
        const menu = await Menu.default();
        await menu.append(submenu);
        if (!cancelled) await menu.setAsAppMenu();
      } catch (e) {
        notify(`Projects menu unavailable: ${e instanceof Error ? e.message : String(e)}`, {
          tone: "warn",
        });
      }
    }
    void build();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recentFolders, workspaceRoot]);

  // New project: pick a parent location, create + `git init` the folder in
  // Rust, then open it. Throws on error so the welcome screen can show it.
  async function newProject(name: string) {
    const parent = await open({
      directory: true,
      title: "Choose where to create the project",
    });
    if (typeof parent !== "string") return;
    const path = await invoke<string>("project_create", { parentDir: parent, name });
    setWorkspaceRoot(path);
  }

  // Clone: pick a parent location, `git clone` into it, then open the result.
  async function cloneRepo(url: string) {
    const parent = await open({
      directory: true,
      title: "Choose where to clone the repository",
    });
    if (typeof parent !== "string") return;
    const path = await invoke<string>("project_clone", { url, parentDir: parent });
    setWorkspaceRoot(path);
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

  function forkConversationFromRun(
    run: Run,
    messages: MissionRunMessage[],
    cwd?: string | null,
    gitMeta?: { branch?: string | null; worktree?: string | null },
  ): Conversation {
    const id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : Date.now().toString(36);
    const provider = run.source === "klide" && run.provider ? (run.provider as ProviderId) : undefined;
    return {
      id,
      title: `Fork: ${run.title}`,
      msgs: runMessagesToAiMsgs(messages),
      updatedAt: Date.now(),
      provider,
      model: run.model,
      cwd,
      branch: gitMeta?.branch ?? null,
      worktree: gitMeta?.worktree ?? null,
    };
  }

  function openForkedConversation(run: Run, convo: Conversation) {
    const provider = convo.provider;
    setView("workbench");
    if (!aiVisible) togglePanel("ai");
    const panelId = appendAiPanel({
      provider,
      model: run.model ?? undefined,
      cwd: convo.cwd ?? undefined,
    });
    setResumeTarget({ panelId, convo });
  }

  async function forkRun(run: Run, preloadedMessages?: MissionRunMessage[]) {
    try {
      const messages = preloadedMessages ?? await fetchRunMessages(run);
      if (messages.length === 0) {
        setFileNotice("Run has no readable messages to fork.");
        return;
      }
      openForkedConversation(run, forkConversationFromRun(run, messages, run.cwd, {
        branch: run.branch,
        worktree: run.worktree,
      }));
      setFileNotice(`Forked "${run.title}" into a new Klide conversation.`);
    } catch (e) {
      setFileNotice(e instanceof Error ? e.message : String(e));
    }
  }

  async function forkRunInWorktree(run: Run, preloadedMessages?: MissionRunMessage[]) {
    const baseRoot = run.cwd ?? workspaceRoot;
    if (!baseRoot) {
      setFileNotice("Open a workspace folder first.");
      return;
    }
    try {
      const messages = preloadedMessages ?? await fetchRunMessages(run);
      if (messages.length === 0) {
        setFileNotice("Run has no readable messages to fork.");
        return;
      }
      const branch = `klide/fork-${Date.now().toString(36)}`;
      const wt = await invoke<{ path: string; branch: string; bootstrapped: string[] }>(
        "git_worktree_add",
        { workspaceRoot: baseRoot, branch, copyFiles: null }
      );
      openForkedConversation(run, forkConversationFromRun(run, messages, wt.path, {
        branch: wt.branch,
        worktree: wt.path.split("/").filter(Boolean).pop() ?? wt.branch,
      }));
      const copied = wt.bootstrapped.length > 0 ? ` · copied ${wt.bootstrapped.join(", ")}` : "";
      setFileNotice(`Forked "${run.title}" into worktree ${wt.branch}${copied}.`);
    } catch (e) {
      setFileNotice(`Worktree fork failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function forkConversationInWorktree(convo: Conversation, baseRoot: string | null) {
    const root = baseRoot ?? workspaceRoot;
    if (!root) {
      setFileNotice("Open a workspace folder first.");
      return;
    }
    try {
      const branch = `klide/turn-${Date.now().toString(36)}`;
      const wt = await invoke<{ path: string; branch: string; bootstrapped: string[] }>(
        "git_worktree_add",
        { workspaceRoot: root, branch, copyFiles: null }
      );
      const forked: Conversation = {
        ...convo,
        cwd: wt.path,
        branch: wt.branch,
        worktree: wt.path.split("/").filter(Boolean).pop() ?? wt.branch,
        updatedAt: Date.now(),
      };
      setView("workbench");
      if (!aiVisible) togglePanel("ai");
      const panelId = appendAiPanel({
        provider: forked.provider,
        model: forked.model ?? undefined,
        cwd: wt.path,
      });
      setResumeTarget({ panelId, convo: forked });
      const copied = wt.bootstrapped.length > 0 ? ` · copied ${wt.bootstrapped.join(", ")}` : "";
      setFileNotice(`Branched turn into worktree ${wt.branch}${copied}.`);
    } catch (e) {
      setFileNotice(`Turn worktree branch failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function mergeWorktreeRun(run: Run) {
    if (!workspaceRoot) {
      setFileNotice("Open the main workspace folder before merging a worktree.");
      return;
    }
    if (!run.branch) {
      setFileNotice("Run has no branch to merge.");
      return;
    }
    if (!run.worktree) {
      setFileNotice("Run did not execute in a linked worktree.");
      return;
    }
    if (!confirm(`Merge ${run.branch} into the main checkout?`)) return;
    try {
      const msg = await invoke<string>("git_worktree_merge", { workspaceRoot, branch: run.branch });
      await refreshGitStatus(workspaceRoot);
      setFileNotice(msg);
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
    provider: DelegateId;
    workspaceRoot: string | null;
    resumeSessionId?: string;
    initialTask?: string;
    cwd?: string;
  }) {
    setView("workbench");
    if (!aiVisible) togglePanel("ai");
    const id = appendAiPanel({ provider: opts.provider, cwd: opts.cwd });
    setPendingAiPanel({
      panelId: id,
      provider: opts.provider,
      resumeSessionId: opts.resumeSessionId ?? null,
      initialTask: opts.initialTask ?? null,
      conversationId: null,
    });
  }

  // "Reattach" from Mission Control's live-sessions strip — reconnect to a
  // delegate PTY that's still running in this Klide process. Unlike resume,
  // there's no `--resume` and no fresh CLI spawn: binding the new panel to the
  // session's conversation id makes its terminal land on the same PTY, and the
  // scrollback buffer (Slice 1) replays everything it produced while detached.
  function reattachLiveSession(opts: {
    provider: DelegateId;
    conversationId: string;
    workspaceRoot: string | null;
  }) {
    setView("workbench");
    if (!aiVisible) togglePanel("ai");
    // Don't open a second terminal onto the same live PTY: if a panel is
    // already bound to this conversation (the one that spawned it, or an
    // earlier reattach), just focus it. Two surfaces sharing the sessionId
    // would mirror each other — the "two synchronized terminals" bug.
    const already = aiPanels.find(
      (p) => loadPanelSession(p.id)?.convoId === opts.conversationId
    );
    if (already) {
      focusPanel(already.id);
      return;
    }
    const id = appendAiPanel({ provider: opts.provider, cwd: opts.workspaceRoot ?? undefined });
    setPendingAiPanel({
      panelId: id,
      provider: opts.provider,
      resumeSessionId: null,
      initialTask: null,
      conversationId: opts.conversationId,
    });
  }

  // Open an existing worktree (from the Worktrees modal) in a fresh AI panel
  // pinned to its path — same pin mechanism as newWorktreeRun, no new branch.
  function openExistingWorktree(path: string) {
    setView("workbench");
    if (!aiVisible) togglePanel("ai");
    appendAiPanel({ cwd: path });
  }

  // Fleet: create a fresh git worktree (isolated branch) and open an AI panel
  // pinned to it, so the agent works without touching the main checkout. The
  // run shows up in Mission Control labelled `· in <name>` via the existing
  // worktree_label read side. Branch is auto-named to avoid a webview
  // prompt(); rename later from the branch UI.
  async function newWorktreeRun(branch?: string) {
    if (!workspaceRoot) {
      setFileNotice("Open a workspace folder first.");
      return;
    }
    const name = branch?.trim() || `klide/wt-${Date.now().toString(36)}`;
    try {
      const wt = await invoke<{ path: string; branch: string; bootstrapped: string[] }>(
        "git_worktree_add",
        { workspaceRoot, branch: name, copyFiles: null }
      );
      setView("workbench");
      if (!aiVisible) togglePanel("ai");
      appendAiPanel({ cwd: wt.path });
      const copied = wt.bootstrapped.length > 0 ? ` · copied ${wt.bootstrapped.join(", ")}` : "";
      setFileNotice(`Worktree ready on ${wt.branch} — this panel runs there${copied}.`);
    } catch (err) {
      setFileNotice(`Worktree failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // "Review Diff" from Mission Control — for Klide runs the CheckpointPanel
  // is already mounted in the detail pane (it lists every file the agent
  // changed with revert affordances), so the row action is just: make sure
  // the run is selected. For external CLI runs we switch to the GitReview
  // view pinned to the run's cwd, so worktree-backed runs show the right
  // branch, status, and diff rather than the main checkout.
  function reviewDiffFromRun(run: { id: string; source: string; cwd: string | null }) {
    if (run.source === "klide") {
      // MissionControl is rendered as a single view, so the run is "selected"
      // by being the current `view === "runs"` selection. We just need to
      // ask MissionControl to focus the CheckpointPanel — done via a small
      // bus (see pendingCheckpointRunId below).
      setPendingCheckpointRunId(run.id);
    } else {
      if (!run.cwd) {
        setFileNotice("Run has no workspace root, so there is no checkout to review.");
        return;
      }
      setGitReviewRoot(run.cwd);
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

  // Remember the last open project so "Reopen last project on launch"
  // (Settings → General) has something to restore. Closing the folder on
  // purpose (root → null) leaves the stored value alone — the next launch
  // still reopens the project you were last working in.
  useEffect(() => {
    if (workspaceRoot) localStorage.setItem("klide.lastRoot", workspaceRoot);
  }, [workspaceRoot]);

  // Boot restore: probe the stored root first (the folder may have moved or
  // been deleted since) and only then open it. `cur ?? last` keeps a folder
  // the user opened while the probe was in flight.
  useEffect(() => {
    if (localStorage.getItem("klide-restore-project") !== "true") return;
    const last = localStorage.getItem("klide.lastRoot");
    if (!last) return;
    let cancelled = false;
    invoke("list_dir", { workspaceRoot: last, path: last })
      .then(() => {
        if (!cancelled) setWorkspaceRoot((cur) => cur ?? last);
      })
      .catch(() => {
        /* folder gone — stay on Welcome */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    localStorage.setItem("klide-restore-project", String(restoreLastProject));
  }, [restoreLastProject]);

  useEffect(() => {
    localStorage.setItem("klide-autosave", autoSaveMode);
  }, [autoSaveMode]);

  useEffect(() => {
    localStorage.setItem("klide-show-hidden", String(showHiddenFiles));
  }, [showHiddenFiles]);

  useEffect(() => {
    localStorage.setItem("klide-confirm-close", String(confirmCloseDirty));
  }, [confirmCloseDirty]);

  useEffect(() => {
    localStorage.setItem("klide-focus-mode", String(focusMode));
  }, [focusMode]);

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
    // Is the user currently typing? Used to keep bare "?" / ⌘/ from firing the
    // cheatsheet (and from stealing ⌘/ comment-toggle) while in a text surface.
    function isEditableTarget(t: EventTarget | null): boolean {
      const el = t as HTMLElement | null;
      if (!el || !el.tagName) return false;
      const tag = el.tagName;
      return (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        el.isContentEditable === true ||
        !!el.closest?.(".monaco-editor, .xterm")
      );
    }
    // Region focus navigation (WAI-ARIA landmark cycling). Focus lands in the
    // editor (Monaco), explorer (first header action), terminal (xterm input),
    // or AI composer — whichever regions are currently open.
    type Region = "explorer" | "editor" | "terminal" | "ai";
    function focusRegion(region: Region): boolean {
      let sel: string | null = null;
      if (region === "editor") { editorRef.current?.focus(); return true; }
      if (region === "terminal") sel = ".xterm-helper-textarea";
      else if (region === "ai") sel = "[data-ai-composer]";
      else if (region === "explorer") sel = ".klide-explorer-action";
      const el = sel ? document.querySelector<HTMLElement>(sel) : null;
      if (el) { el.focus(); return true; }
      return false;
    }
    function currentRegion(): Region | null {
      const ae = document.activeElement;
      if (!ae) return null;
      if (ae.closest(".monaco-editor")) return "editor";
      if (ae.closest(".xterm")) return "terminal";
      if (ae.closest("[data-ai-composer]")) return "ai";
      if (ae.closest('[class*="klide-explorer"]')) return "explorer";
      return null;
    }
    function cycleRegion(dir: 1 | -1) {
      const order = (["explorer", "editor", "terminal", "ai"] as Region[]).filter((r) =>
        r === "editor" ? true
          : r === "explorer" ? explorerVisible
          : r === "terminal" ? terminalVisible
          : aiVisible
      );
      if (order.length === 0) return;
      const cur = currentRegion();
      const at = cur ? order.indexOf(cur) : -1;
      const start = at === -1 ? (dir === 1 ? 0 : order.length - 1) : (at + dir + order.length) % order.length;
      // Walk from the target onward so F6 never dead-ends if a region can't
      // take focus yet (e.g. terminal still mounting).
      for (let i = 0; i < order.length; i++) {
        if (focusRegion(order[(start + i + order.length) % order.length])) return;
      }
    }

    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;

      // Region focus cycle — workbench only. F6 is the cross-platform a11y
      // standard (works on external keyboards / "standard function keys"); on
      // macOS, where the laptop F-row needs Fn, ⌃Tab is the no-Fn primary. ⌃Tab
      // must be caught BEFORE the editor-tab handler below (whose `mod` includes
      // ctrlKey). On Windows/Linux ⌃Tab stays tab-switching (the convention),
      // so this gates ⌃Tab to macOS; F6 covers region cycling there.
      const isMac = /mac/i.test(navigator.platform || navigator.userAgent);
      if (
        view === "workbench" &&
        (e.key === "F6" || (isMac && e.key === "Tab" && e.ctrlKey && !e.metaKey))
      ) {
        e.preventDefault();
        cycleRegion(e.shiftKey ? -1 : 1);
        return;
      }
      // Keyboard-shortcuts cheatsheet (⌘/ or "?"). Guarded so it doesn't fire
      // while typing, and so Monaco keeps ⌘/ for comment-toggle in the editor.
      if (!isEditableTarget(e.target) && ((mod && e.key === "/") || (!mod && e.key === "?"))) {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
        return;
      }

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
        if (shortcutsOpen) { setShortcutsOpen(false); return; }
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
  }, [active, activeIdx, tabs, saveActive, paletteOpen, searchVisible, view, explorerVisible, terminalVisible, aiVisible, shortcutsOpen]);

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
    { id: "close-folder", label: "File: Switch Project (Welcome)", action: () => { closeFolder(); setPaletteOpen(false); } },
    { id: "close-tab", label: "View: Close Tab", shortcut: "⌘W", action: () => { if (activeIdx >= 0) closeTab(activeIdx); setPaletteOpen(false); } },
    { id: "find", label: "Edit: Find in Files", shortcut: "⌘⇧F", action: () => { setSearchVisible((v) => !v); setPaletteOpen(false); } },
    { id: "terminal-toggle", label: "Terminal: Toggle", shortcut: "⌘`", action: () => { setTerminalVisible((v) => !v); setPaletteOpen(false); } },
    { id: "settings", label: "Preferences: Open Settings", shortcut: "⌘,", action: () => { setView("settings"); setPaletteOpen(false); } },
    { id: "profile", label: "View: Open Profile", shortcut: "⌘.", action: () => { setProfileVisible(true); setPaletteOpen(false); } },
    { id: "theme", label: "Appearance: Toggle Theme", action: () => { setTheme((t) => getNextThemeId(t)); setPaletteOpen(false); } },
    { id: "word-wrap", label: "Editor: Toggle Word Wrap", action: () => { setEditorWordWrap((v) => !v); setPaletteOpen(false); } },
    { id: "line-numbers", label: "Editor: Toggle Line Numbers", action: () => { setEditorLineNumbers((v) => !v); setPaletteOpen(false); } },
    { id: "minimap", label: "Editor: Toggle Minimap", action: () => { setEditorMinimap((v) => !v); setPaletteOpen(false); } },
    { id: "layout-anchored", label: "Layout: Anchored (IDE)", action: () => { setFocusMode(false); setAnchoredLayout(true); exitGrid(); setView("workbench"); setPaletteOpen(false); } },
    { id: "layout-free", label: "Layout: Free (floating panels)", action: () => { setFocusMode(false); setAnchoredLayout(false); exitGrid(); setView("workbench"); setPaletteOpen(false); } },
    { id: "layout-focus", label: "Layout: Focus (chat)", action: () => { setFocusMode(true); exitGrid(); setView("workbench"); setPaletteOpen(false); } },
    { id: "runs", label: "View: Mission Control", action: () => { setView("runs"); setPaletteOpen(false); } },
    { id: "orchestrator", label: "View: Orchestrator Preview", action: () => { setView("orchestrator"); setPaletteOpen(false); } },
    { id: "back-to-workbench", label: "View: Back to Workbench", shortcut: "Esc", action: () => { setView("workbench"); setPaletteOpen(false); } },
    { id: "git-review", label: "View: Git Review", shortcut: "⌘⇧G", action: () => { setView((v) => v === "git-review" ? "workbench" : "git-review"); setPaletteOpen(false); } },
    { id: "create-pr", label: "Git: Create Pull Request…", action: () => { setPaletteOpen(false); void (async () => { try { const pr = await invoke<string>("create_pr", { workspaceRoot, title: "Klide changes", body: null }); setFileNotice(`PR: ${pr}`); } catch(e) { setFileNotice(`PR failed: ${e}`); } })(); } },
    { id: "worktree", label: "Agent: New Run in Worktree", action: () => { setPaletteOpen(false); void newWorktreeRun(); } },
    { id: "worktrees-view", label: "View: Worktrees", action: () => { setPaletteOpen(false); setWorktreesVisible(true); } },
    { id: "rollback", label: "Git: View Checkpoints", action: () => { setView("runs"); setPaletteOpen(false); } },
    { id: "reload", label: "Developer: Reload Window", action: () => { window.location.reload(); } },
    { id: "shortcuts", label: "Help: Keyboard Shortcuts", shortcut: "?", action: () => { setShortcutsOpen(true); setPaletteOpen(false); } },
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
          onNewProject={newProject}
          onCloneRepo={cloneRepo}
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
            onExplorerVisibleChange={setExplorerVisible}
            restoreLastProject={restoreLastProject}
            onRestoreLastProjectChange={setRestoreLastProject}
            autoSaveMode={autoSaveMode}
            onAutoSaveModeChange={setAutoSaveMode}
            showHiddenFiles={showHiddenFiles}
            onShowHiddenFilesChange={setShowHiddenFiles}
            confirmCloseDirty={confirmCloseDirty}
            onConfirmCloseDirtyChange={setConfirmCloseDirty}
            customLayouts={customLayouts}
            onCustomLayoutsChange={updateCustomLayouts}
            onApplyLayout={applyLayout}
            onProviderKeyChange={() => setApiKeyVersion((version) => version + 1)}
            onBack={() => setView("workbench")}
          />
        ) : (
          <>
            {/* Focus is chat-first: the icon rail steps back while the focus
                screen itself is showing (its own rail carries navigation —
                projects, Mission Control, profile). Overlay views opened from
                it (Mission Control, Git) bring the rail back. */}
            {!(focusMode && view === "workbench") && (
            <ActivityBar active={activityState} onToggle={togglePanel} />
            )}
            {view === "git-review" ? (
              <GitReview
                workspaceRoot={effectiveGitReviewRoot}
                gitStatus={effectiveGitReviewRoot === workspaceRoot ? gitStatus : null}
                onRefreshGitStatus={() =>
                  effectiveGitReviewRoot && effectiveGitReviewRoot === workspaceRoot
                    ? refreshGitStatus(effectiveGitReviewRoot)
                    : Promise.resolve()
                }
                onBack={() => {
                  setGitReviewRoot(null);
                  setView("workbench");
                }}
                theme={theme}
              />
            ) : view === "runs" ? (
              <MissionControl
                workspaceRoot={workspaceRoot}
                theme={theme}
                onResumeKlideRun={resumeKlideRun}
                onOpenInAiPanel={openRunInAiPanel}
                onReattachLiveSession={reattachLiveSession}
                onReviewDiff={reviewDiffFromRun}
                onSaveMemory={saveMemoryFromRun}
                onForkRun={forkRun}
                onForkRunInWorktree={forkRunInWorktree}
                onMergeWorktreeRun={mergeWorktreeRun}
                pendingCheckpointRunId={pendingCheckpointRunId}
                onPendingCheckpointConsumed={() => setPendingCheckpointRunId(null)}
                summarizingFromRunId={summarizingFromRun}
                onBack={() => setView("workbench")}
              />
            ) : view === "orchestrator" ? (
              // Real tier-board console. workspaceRoot enables real plan-mode
              // dispatch through the slice-1 dispatcher seam.
              <OrchestratorConsole workspaceRoot={workspaceRoot} />
            ) : activeGrid && !focusMode ? (
              <GridWorkbench layout={activeGrid} renderPanel={renderPanel} />
            ) : null}
            {/* The workbench stays mounted across view switches so an in-flight
                agent run keeps streaming into the AI panel. Switching to Mission
                Control / Git / Settings used to UNMOUNT it, dropping the live
                event subscription — the answer then only "respawned" on return
                via the transcript. Here it's hidden (display:none), not
                unmounted, whenever an overlay view is showing. Grid mode owns
                its own layout, so it's excluded. */}
            {(!activeGrid || focusMode) && (
              <div
                style={{
                  display: view === "workbench" ? "flex" : "none",
                  flex: 1,
                  minWidth: 0,
                  minHeight: 0,
                }}
              >
                {focusMode ? (
              /* Focus — the chat-first main screen: rail + hero home, and
                 for the live conversation the same fully-wired AiPanel in
                 its fullscreen "focus" design variant (centered reading
                 column). One agent surface, two designs. */
              <FocusMode
                workspaceRoot={workspaceRoot}
                branch={gitStatus?.branch ?? null}
                projects={recentFolders}
                chatActive={focusChatActive}
                onSwitchProject={(root) => {
                  setFocusChatActive(false);
                  changeRoot(root);
                }}
                onNewChat={() => setFocusChatActive(false)}
                onOpenConversation={(convo) => {
                  // A conversation from another project's history brings its
                  // project along — resuming it against the wrong workspace
                  // would point every tool at the wrong tree.
                  if (convo.cwd && convo.cwd !== workspaceRoot) changeRoot(convo.cwd);
                  setResumeTarget({ panelId: aiPanels[0]?.id ?? "ai-main", convo });
                  setFocusChatActive(true);
                }}
                onSubmit={(text) => {
                  setFocusInitialMessage(text);
                  setFocusChatActive(true);
                }}
                onOpenMissionControl={() => setView("runs")}
                renderChat={() => renderPanel("ai", "focus-ai", { aiVariant: "focus" })}
                provider={
                  aiPanels[0]?.provider ??
                  ((localStorage.getItem("klide.provider") as ProviderId) || "ollama")
                }
                onProviderChange={(p) => {
                  const panelId = aiPanels[0]?.id ?? "ai-main";
                  setAiPanelProvider(panelId, p);
                  // The panel keeps its model across provider switches, but a
                  // hero pick means "start on this provider" — reset to its
                  // default so the pair is never mismatched.
                  updateAiPanelModel(panelId, DEFAULT_MODELS[p] ?? "");
                }}
                model={aiPanels[0]?.model ?? aiModel}
                onModelChange={(m) => updateAiPanelModel(aiPanels[0]?.id ?? "ai-main", m)}
                effort={harnessSettings?.reflectionLevels?.[aiPanels[0]?.model ?? aiModel]}
                onEffortChange={(v) => {
                  const m = aiPanels[0]?.model ?? aiModel;
                  const next = { ...(harnessSettings?.reflectionLevels ?? {}) };
                  if (v === undefined) delete next[m];
                  else next[m] = v;
                  setHarnessSettings({ ...harnessSettings, reflectionLevels: next });
                  // The AI panel prefers its own per-panel override when one
                  // was set from its composer — drop it so the value picked
                  // here is what the next run actually uses.
                  const panelId = aiPanels[0]?.id ?? "ai-main";
                  const prov =
                    aiPanels[0]?.provider ?? localStorage.getItem("klide.provider") ?? "ollama";
                  try {
                    localStorage.removeItem(`klide.reflectionLevel.${panelId}.${prov}.${m}`);
                  } catch {
                    /* storage unavailable */
                  }
                }}
                contextWindow={harnessSettings?.contextWindows?.[aiPanels[0]?.model ?? aiModel]}
                onContextWindowChange={(w) => {
                  const m = aiPanels[0]?.model ?? aiModel;
                  const next = { ...(harnessSettings?.contextWindows ?? {}) };
                  if (w === undefined) delete next[m];
                  else next[m] = w;
                  setHarnessSettings({ ...harnessSettings, contextWindows: next });
                }}
              />
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
                onRootChange={changeRoot}
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
                requireDiffReview={reviewForPanel(aiPanels[0]?.id ?? "ai-main")}
                onRequireDiffReviewChange={(v) => setPanelReview(aiPanels[0]?.id ?? "ai-main", v)}
                onOpenDiff={setDiffView}
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
                onOpenMemory={() => setMemoryVisible(true)}
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
                      // Solid (not translucent) and NO backdrop-filter: a
                      // blurred backdrop here re-composites over a focused panel
                      // once its z-index is bumped onto its own layer (Z.panel
                      // ~1011), making the clicked panel vanish in the webview.
                      // Killing the filter removes that compositing bug.
                      background: "var(--bg)",
                      boxShadow: "inset 0 1px 0 var(--panel-highlight)",
                      overflow: "hidden",
                      zIndex: 1,
                    }}
                  >
                    <TabBar
                      tabs={tabs.map((t) => ({ path: t.path, dirty: t.dirty, externalChanged: t.externalChanged }))}
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
                    zIndex={zMap["explorer"] ?? 10}
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
                            showHidden={showHiddenFiles}
                            width={explorerRect.w}
                            workspaceRoot={workspaceRoot}
                            onOpen={openFile}
                            onRootChange={changeRoot}
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
                        showHidden={showHiddenFiles}
                        width={explorerRect.w}
                        workspaceRoot={workspaceRoot}
                        onOpen={openFile}
                        onRootChange={changeRoot}
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
                {diffView && (
                  <div
                    style={{
                      position: "absolute",
                      right: 8,
                      top: 8,
                      width: "min(900px, calc(100% - 16px))",
                      height: "calc(100% - 16px)",
                      background: "var(--bg-elevated)",
                      border: "1px solid var(--panel-border)",
                      borderRadius: "var(--radius-md)",
                      boxShadow: "var(--panel-shadow)",
                      zIndex: 21,
                      display: "flex",
                      flexDirection: "column",
                      overflow: "hidden",
                    }}
                  >
                    <DiffViewerPanel
                      key={diffView.path}
                      path={diffView.path}
                      original={diffView.oldContent}
                      modified={diffView.newContent}
                      language={detectLanguage(diffView.path)}
                      isCreate={diffView.isCreate}
                      theme={theme}
                      onClose={() => setDiffView(null)}
                    />
                  </div>
                )}
                {terminalVisible && (
                  <FloatingPanel
                    panelId="terminal"
                    rect={terminalRect}
                    workbenchW={workbenchSize.w}
                    workbenchH={workbenchSize.h}
                    zIndex={zMap["terminal"] ?? 10}
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
                      zIndex={zMap[panel.id] ?? (10 + idx)}
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
                        initialConversationId={
                          pendingAiPanel?.panelId === panel.id
                            ? pendingAiPanel.conversationId
                            : undefined
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
                        workspaceRoot={panel.cwd ?? workspaceRoot}
                        worktreeName={panel.cwd ? panel.cwd.split("/").filter(Boolean).pop() : undefined}
                        onFileWritten={onAgentWrote}
                        onWorkspaceChanged={() => {
                          // A worktree-pinned panel changes its own branch, not
                          // the main checkout, so only refresh the sidebar git
                          // status when the panel runs in the global workspace.
                          const root = panel.cwd ?? workspaceRoot;
                          if (!panel.cwd && root) refreshGitStatus(root);
                        }}
                        model={panel.model ?? aiModel}
                        onModelChange={(model) => updateAiPanelModel(panel.id, model)}
                        onProviderChange={(provider) => setAiPanelProvider(panel.id, provider)}
                        availableModels={panelModels[panel.id] ?? [panel.model ?? aiModel]}
                        onAvailableModelsChange={(models) => updatePanelModels(panel.id, models)}
                        apiKeyVersion={apiKeyVersion}
                        requireDiffReview={reviewForPanel(panel.id)}
                        onRequireDiffReviewChange={(v) => setPanelReview(panel.id, v)}
                        onOpenDiff={setDiffView}
                        stopAfterRejection={stopAfterRejection}
                        skills={skills}
                        harnessSettings={harnessSettings}
                        onDuplicate={appendAiPanel}
                        onForkConversationInWorktree={forkConversationInWorktree}
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
                        onOpenMemory={() => setMemoryVisible(true)}
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
              </div>
            )}
          </>
        )}
      </div>
      <StatusBar
        path={active?.path ?? null}
        language={language}
        workspaceRoot={workspaceRoot}
        fileNotice={active?.externalChanged ? "File changed on disk" : null}
        gitStatus={gitStatus}
        terminalVisible={terminalVisible}
        onToggleTerminal={() => setTerminalVisible((v) => !v)}
        gridLayouts={gridLayouts}
        activeGridId={activeGridId}
        anchoredLayout={panelLayout.anchored !== false}
        focusMode={focusMode}
        onSetFocusMode={setFocusMode}
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
      <WorktreesModal
        open={worktreesVisible}
        workspaceRoot={workspaceRoot}
        onOpenWorktree={openExistingWorktree}
        onNotice={setFileNotice}
        onClose={() => setWorktreesVisible(false)}
      />
      <ProfileModal
        open={profileVisible}
        workspaceRoot={workspaceRoot}
        onClose={() => setProfileVisible(false)}
      />
      {shortcutsOpen && <KeyboardShortcuts onClose={() => setShortcutsOpen(false)} />}
      {paletteOpen && (
        <CommandPalette
          workspaceRoot={workspaceRoot}
          commands={paletteCommands}
          onOpenFile={openFile}
          initialQuery={paletteQuery}
        />
      )}
      <ToastHost />
    </div>
  );
}

export default App;
