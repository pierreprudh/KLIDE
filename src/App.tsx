import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { ActivityBar } from "./components/ActivityBar";
import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { EditorArea, type EditorEmptyAction } from "./components/EditorArea";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { KbdFor } from "./components/Kbd";
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
import { ProfileModal } from "./components/ProfileModal";
import { getNextThemeId } from "./theme";
import { SETTINGS, useSetting } from "./settingsStore";
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
import { isAgentFile } from "./components/fileMarks";
import { SplitPane } from "./components/SplitPane";
import { defaultLayout as defaultPanelLayout, PANEL_CONSTRAINTS, type PanelRect } from "./panelLayout";
import { Z } from "./zLayers";
import { CommandPalette } from "./components/CommandPalette";
import { SearchPanel } from "./components/SearchPanel";
import { useEditorTabs } from "./hooks/useEditorTabs";
import { usePanelLayout, type AiPanelInstance } from "./hooks/usePanelLayout";
import { useArtifactInspector } from "./hooks/useArtifactInspector";
import { listCheckpoints } from "./agent/client";
import {
  DEFAULT_AI_PANEL_ID,
  initialHandoffFor,
  panelWorkspace,
  resumeConversationFor,
  type AiPanelRenderOptions,
  type PendingAiPanel,
} from "./components/ai/panelHost";
import { readWorkspaceTextFile } from "./workspaceFs";
import { modelLabel } from "./components/ai/ModelPicker";
import { RaceFollowUpBar } from "./components/ai/RaceFollowUpBar";
import type { RaceGroup } from "./races";
import {
  worktreeSetupSummary,
  worktreeName,
  type WorktreeInfo,
  type WorktreeSetupDone,
} from "./worktrees";
import { createListenerScope } from "./tauriEvents";
import "./styles/tokens.css";

const MissionControl = lazy(() => import("./components/MissionControl").then((m) => ({ default: m.MissionControl })));
const OrchestratorConsole = lazy(() => import("./components/OrchestratorConsole").then((m) => ({ default: m.OrchestratorConsole })));
const FocusMode = lazy(() => import("./components/FocusMode").then((m) => ({ default: m.FocusMode })));
const GitReview = lazy(() => import("./components/GitReview").then((m) => ({ default: m.GitReview })));
const MemoryModal = lazy(() => import("./components/MemoryModal").then((m) => ({ default: m.MemoryModal })));
const ArtifactInspector = lazy(() => import("./components/ArtifactInspector").then((m) => ({ default: m.ArtifactInspector })));
const WorktreesModal = lazy(() => import("./components/WorktreesModal").then((m) => ({ default: m.WorktreesModal })));
const FileViewerPanel = lazy(() => import("./components/FileViewerPanel").then((m) => ({ default: m.FileViewerPanel })));
const DiffViewerPanel = lazy(() => import("./components/DiffViewerPanel").then((m) => ({ default: m.DiffViewerPanel })));
const SkillsModal = lazy(() => import("./components/SkillsModal").then((m) => ({ default: m.SkillsModal })));
const SettingsPanel = lazy(() => import("./components/SettingsPanel").then((m) => ({ default: m.SettingsPanel })));
const KeyboardShortcuts = lazy(() => import("./components/KeyboardShortcuts").then((m) => ({ default: m.KeyboardShortcuts })));

type Panel = "explorer" | "git" | "memory" | "skills" | "ai" | "runs" | "settings" | "profile";
type ActivityPanel = Panel | "orchestrator" | "home";
export type { HarnessSettings } from "./settingsStore";
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
  // General settings — startup, files, and tab behaviour. Durable settings
  // live in the settings store (src/settingsStore.ts); the Settings panel
  // reads/writes the same store, so none of these need prop threading.
  const [autoSaveMode] = useSetting(SETTINGS.autoSaveMode);
  const [showHiddenFiles] = useSetting(SETTINGS.showHiddenFiles);
  const [confirmCloseDirty] = useSetting(SETTINGS.confirmCloseDirty);
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
  // pinned to a provider, we push an entry and the matching <AiPanel> picks
  // it up on mount, sets its initial provider + resume/task, then clears its
  // entry. A list (not a single slot) because a race "watch live" handoff
  // opens one panel per racer in the same tick — key matched by panel id.
  const [pendingAiPanels, setPendingAiPanels] = useState<PendingAiPanel[]>([]);
  // Active race watch — one entry per racer panel. Drives the Focus tab
  // strip, the free-mode "ask both" bar, and the follow-up fan-out. Empty
  // means no race is being watched.
  const [raceWatchTabs, setRaceWatchTabs] = useState<{ panelId: string; label: string }[]>([]);
  const [focusActiveTabId, setFocusActiveTabId] = useState<string | null>(null);
  // Pending "ask both" follow-ups, keyed by panelId — each racer's AiPanel
  // consumes its entry and sends it into its own conversation.
  const [raceFollowUps, setRaceFollowUps] = useState<Record<string, { text: string; nonce: number }>>({});
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
  const [theme, setTheme] = useSetting(SETTINGS.theme);
  const [autoTheme] = useSetting(SETTINGS.autoTheme);
  const [lightTheme] = useSetting(SETTINGS.lightTheme);
  const [darkTheme] = useSetting(SETTINGS.darkTheme);
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
  const [editorFontSize] = useSetting(SETTINGS.editorFontSize);
  const [editorLineNumbers, setEditorLineNumbers] = useSetting(SETTINGS.editorLineNumbers);
  const [editorWordWrap, setEditorWordWrap] = useSetting(SETTINGS.editorWordWrap);
  const [editorMinimap, setEditorMinimap] = useSetting(SETTINGS.editorMinimap);
  const [aiModel, setAiModel] = useSetting(SETTINGS.aiModel);
  const [panelModels, setPanelModels] = useState<Record<string, string[]>>({});
  // Global default for "require diff review" (auto-accept off). Settings edits
  // this. Each AI panel keeps its own override below — toggling auto-accept in
  // one conversation must NOT leak into the others.
  const [requireDiffReview] = useSetting(SETTINGS.requireDiffReview);
  // Per-panel overrides, keyed by panelId (same pattern as `panelModels`).
  // A panel with no entry falls back to the global default. In-memory only:
  // on reload every panel reverts to the safe global default.
  const [panelReviewOverrides, setPanelReviewOverrides] = useState<Record<string, boolean>>({});
  const reviewForPanel = (id: string) =>
    id in panelReviewOverrides ? panelReviewOverrides[id] : requireDiffReview;
  const setPanelReview = (id: string, value: boolean) =>
    setPanelReviewOverrides((prev) => ({ ...prev, [id]: value }));
  const [stopAfterRejection] = useSetting(SETTINGS.stopAfterRejection);
  const [harnessSettings, setHarnessSettings] = useSetting(SETTINGS.harnessSettings);
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
  const effectiveGitReviewRoot = workspaceRoot;
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

  // ── Workbench Artifact Inspector ────────────────────────────────────
  // The same docked review surface Mission Control has, docked at the right
  // edge of the main workbench. The AI panel's "N files changed" row opens
  // the run's checkpoint diffs here instead of leaving them to the
  // background editor tabs.
  const {
    artifactTabs,
    activeArtifactKey,
    artifactOpen,
    setActiveArtifactKey,
    setArtifactDirty,
    openArtifact,
    closeArtifact,
    closeArtifactTab,
  } = useArtifactInspector();

  // Docked-editor width (free layout). null → the CSS clamp default; a number
  // once the user has dragged the left-edge splitter. Width changes are
  // user-driven only — never animated — so the open/close glide stays pure
  // transform (see .editor-dock-overlay).
  const [editorDockWidth, setEditorDockWidth] = useState<number | null>(() => {
    const stored = Number(localStorage.getItem("klide-editor-dock-width"));
    return Number.isFinite(stored) && stored >= 420 ? stored : null;
  });
  useEffect(() => {
    if (editorDockWidth !== null) {
      localStorage.setItem("klide-editor-dock-width", String(Math.round(editorDockWidth)));
    }
  }, [editorDockWidth]);

  // Folded: the docked editor tucks to a slim spine on the right edge so open
  // documents stay ready without occupying the canvas. Opening/selecting a
  // file from outside (Explorer, ⌘P, search) unfolds it — you asked to see
  // that file.
  const [editorDockFolded, setEditorDockFolded] = useState(false);
  useEffect(() => {
    if (active?.path) setEditorDockFolded(false);
  }, [active?.path]);

  // When the docked editor is open in the free layout, the floating panels
  // make room: any panel that would sit under the dock slides left — and
  // shrinks if it must — into the remaining canvas. FloatingPanel's passive
  // rect transition (380ms, same curve as the dock) turns the dock opening
  // and the panels stepping aside into one choreographed motion. Also
  // re-runs when a panel is dropped or resized under the open dock, easing
  // it back out.
  const editorDockOpen =
    panelLayout.anchored === false &&
    !editorDockFolded &&
    (tabs.length > 0 || searchVisible);
  // Idle canvas: every content surface is away (AI panels hidden, editor
  // dock closed or folded, terminal hidden) — without this the free layout
  // is a blank field the moment the last panel closes. The canvas then
  // offers quiet type-only launchers (see .workbench-idle).
  const canvasIdle =
    panelLayout.anchored === false &&
    (!aiVisible || aiPanels.length === 0) &&
    !terminalVisible &&
    !editorDockOpen;
  // The terminal dock's content mounts on first open and then stays mounted
  // (the drawer hides via transform, like the editor dock) — so the shell,
  // its scrollback and any running process survive toggling. Lazy so an
  // unopened terminal never spawns a PTY at startup.
  const [terminalMounted, setTerminalMounted] = useState(terminalVisible);
  useEffect(() => {
    if (terminalVisible) setTerminalMounted(true);
  }, [terminalVisible]);
  // True-to-size memory: the first time the dock displaces a panel, its
  // original rect is recorded here; closing/folding the dock glides every
  // displaced panel back to it. Cleared after restore so a manual move while
  // the dock is closed becomes the new truth.
  const preDockRectsRef = useRef<{
    fixed: Partial<Record<"explorer" | "terminal", PanelRect>>;
    ai: Record<string, PanelRect>;
  } | null>(null);
  useEffect(() => {
    if (!editorDockOpen || workbenchSize.w === 0) return;
    const dockW =
      editorDockWidth ?? Math.min(960, Math.max(480, Math.round(workbenchSize.w * 0.52)));
    const remaining = Math.max(280, workbenchSize.w - dockW - 12);
    const fit = (rect: PanelRect, minW: number): PanelRect | null => {
      if (rect.x + rect.w <= remaining) return null;
      const w = Math.max(minW, Math.min(rect.w, remaining - 12));
      const x = Math.max(0, Math.min(rect.x, remaining - w));
      // A panel wider than the remaining canvas can't fit — leave it rather
      // than loop on an unsatisfiable constraint.
      if (x === rect.x && w === rect.w) return null;
      return { ...rect, x, w };
    };
    const saved = (preDockRectsRef.current ??= { fixed: {}, ai: {} });
    // Only the explorer can still float here — the terminal lives in the
    // bottom drawer and never needs displacing.
    for (const id of ["explorer"] as const) {
      const rect = panelLayout[id];
      const fitted = rect ? fit(rect, PANEL_CONSTRAINTS[id].minW) : null;
      if (fitted && rect) {
        saved.fixed[id] ??= rect;
        updatePanelRect(id, fitted);
      }
    }
    for (const panel of aiPanels) {
      const fitted = fit(panel.rect, PANEL_CONSTRAINTS.ai.minW);
      if (fitted) {
        saved.ai[panel.id] ??= panel.rect;
        updateAiRect(panel.id, fitted);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorDockOpen, editorDockWidth, workbenchSize.w, panelLayout, aiPanels]);

  // Dock closed (last tab gone) or folded → panels glide back to the exact
  // rects they held before the dock displaced them.
  useEffect(() => {
    if (editorDockOpen) return;
    const saved = preDockRectsRef.current;
    if (!saved) return;
    preDockRectsRef.current = null;
    for (const id of ["explorer"] as const) {
      const rect = saved.fixed[id];
      if (rect) updatePanelRect(id, rect);
    }
    for (const [panelId, rect] of Object.entries(saved.ai)) {
      if (aiPanels.some((p) => p.id === panelId)) updateAiRect(panelId, rect);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorDockOpen]);

  function beginEditorDockResize(e: ReactMouseEvent<HTMLDivElement>) {
    e.preventDefault();
    const pane = e.currentTarget.parentElement;
    if (!pane) return;
    const startX = e.clientX;
    const startW = pane.getBoundingClientRect().width;
    const maxW = Math.max(420, workbenchSize.w - 24);
    const previousCursor = document.body.style.cursor;
    const previousSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    function onMove(ev: MouseEvent) {
      // Left-edge drag: moving left grows the pane.
      setEditorDockWidth(Math.min(maxW, Math.max(420, startW - (ev.clientX - startX))));
    }
    function onUp() {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelect;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // Explorer presentation in the free layout: a drawer docked to the
  // activity bar by default; the Settings toggle restores the draggable
  // floating panel.
  const [explorerFloating, setExplorerFloatingState] = useState<boolean>(
    () => localStorage.getItem("klide-explorer-floating") === "true"
  );
  function setExplorerFloating(v: boolean) {
    setExplorerFloatingState(v);
    localStorage.setItem("klide-explorer-floating", String(v));
  }

  function beginExplorerDockResize(e: ReactMouseEvent<HTMLDivElement>) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = explorerRect.w;
    const previousCursor = document.body.style.cursor;
    const previousSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    function onMove(ev: MouseEvent) {
      const w = Math.min(
        PANEL_CONSTRAINTS.explorer.maxW,
        Math.max(PANEL_CONSTRAINTS.explorer.minW, startW + (ev.clientX - startX))
      );
      updatePanelRect("explorer", { ...explorerRect, w });
    }
    function onUp() {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelect;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function beginTerminalDockResize(e: ReactMouseEvent<HTMLDivElement>) {
    e.preventDefault();
    const startY = e.clientY;
    const startH = terminalRect.h;
    const maxH = Math.min(
      PANEL_CONSTRAINTS.terminal.maxH,
      Math.max(160, Math.round(workbenchSize.h * 0.72))
    );
    const previousCursor = document.body.style.cursor;
    const previousSelect = document.body.style.userSelect;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    function onMove(ev: MouseEvent) {
      const h = Math.min(
        maxH,
        Math.max(PANEL_CONSTRAINTS.terminal.minH, startH - (ev.clientY - startY))
      );
      updatePanelRect("terminal", { ...terminalRect, h });
    }
    function onUp() {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelect;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // The explorer surface itself (tree, optionally stacked with the skills
  // slot) — identical whether it lives in the floating panel or the drawer.
  function renderExplorerContent(): ReactNode {
    const explorer = (
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
    );
    if (!sidebarSlot2) return explorer;
    return (
      <SplitPane
        top={explorer}
        bottom={
          sidebarSlot2 === "skills" ? (
            <Suspense fallback={null}>
              <SkillsModal
                open
                skills={skills}
                onChange={setSkills}
                onReloadFilesystemSkills={reloadFilesystemSkills}
                onClose={() => setSidebarSlot2(null)}
              />
            </Suspense>
          ) : null
        }
        defaultSplit={explorerRect.h * 0.45}
        minPane={80}
      />
    );
  }

  async function reviewRunChanges({ runId, title }: { runId: string; title: string }) {
    try {
      const entries = await listCheckpoints(runId);
      if (entries.length === 0) {
        notify("This run has no reviewable file checkpoints yet.");
        return;
      }
      openArtifact({ kind: "checkpoint-set", runId, title, entries });
    } catch (err) {
      notify(`Unable to open changes: ${err instanceof Error ? err.message : String(err)}`, {
        tone: "error",
      });
    }
  }

  // ── AiPanel host ────────────────────────────────────────────────────
  // The one place the App↔AiPanel contract is turned into props. Every
  // surface that shows an AI panel — the anchored column, free-floating
  // windows, grid cells, Focus — renders through this function, so the
  // pending-handoff keying, resume targeting, and per-panel model/provider/
  // review policy can't drift between render sites. Surfaces only choose the
  // knobs in `AiPanelRenderOptions`; the policy itself lives in
  // `components/ai/panelHost.ts`.
  function renderAiPanel(
    panel: AiPanelInstance | undefined,
    opts?: AiPanelRenderOptions
  ): ReactNode {
    const panelId = panel?.id ?? DEFAULT_AI_PANEL_ID;
    const model = panel?.model ?? aiModel;
    const handoff = initialHandoffFor(
      panelId,
      panel?.provider,
      pendingAiPanels.find((p) => p.panelId === panelId) ?? null
    );
    const { root, worktreeName } = panelWorkspace(
      panel,
      workspaceRoot,
      opts?.respectWorktree ?? false
    );
    return (
      <AiPanel
        key={opts?.key ?? panelId}
        fill
        visible
        width={opts?.width ?? panel?.rect.w ?? 360}
        panelId={panelId}
        initialProvider={handoff.initialProvider}
        initialConversationId={handoff.initialConversationId}
        initialResumeSessionId={handoff.initialResumeSessionId}
        initialTask={handoff.initialTask}
        onInitialConsumed={
          handoff.matched
            ? () => setPendingAiPanels((ps) => ps.filter((p) => p.panelId !== panelId))
            : undefined
        }
        workspaceRoot={root}
        worktreeName={worktreeName}
        onFileWritten={onAgentWrote}
        onReviewChanges={(info) => void reviewRunChanges(info)}
        onWorkspaceChanged={() => {
          // A worktree-pinned panel changes its own branch, not the main
          // checkout — only refresh the sidebar git status when the panel
          // runs in the global workspace.
          if (!worktreeName && root) refreshGitStatus(root);
        }}
        model={model}
        onModelChange={(m) => updateAiPanelModel(panelId, m)}
        onProviderChange={(provider) => setAiPanelProvider(panelId, provider)}
        availableModels={panelModels[panelId] ?? [model]}
        onAvailableModelsChange={(models) => updatePanelModels(panelId, models)}
        apiKeyVersion={apiKeyVersion}
        requireDiffReview={reviewForPanel(panelId)}
        onRequireDiffReviewChange={(v) => setPanelReview(panelId, v)}
        onOpenDiff={setDiffView}
        stopAfterRejection={stopAfterRejection}
        skills={skills}
        harnessSettings={harnessSettings}
        onDuplicate={opts?.duplicatable ? appendAiPanel : undefined}
        onForkConversationInWorktree={forkConversationInWorktree}
        onClose={
          opts?.closable
            ? () => {
                closeAiPanel(panelId);
                // A closed racer drops out of the watch (its run keeps going
                // headless); the "ask both" bar follows the surviving list.
                setRaceWatchTabs((ts) => ts.filter((t) => t.panelId !== panelId));
                setRaceFollowUps((m) => {
                  if (!(panelId in m)) return m;
                  const { [panelId]: _dropped, ...rest } = m;
                  return rest;
                });
              }
            : undefined
        }
        resumeConversation={resumeConversationFor(panelId, resumeTarget)}
        onResumeConsumed={() => setResumeTarget(null)}
        variant={opts?.variant}
        initialMessage={opts?.initialMessage ?? null}
        onInitialMessageConsumed={() => setFocusInitialMessage(null)}
        followUpMessage={raceFollowUps[panelId] ?? null}
        onFollowUpConsumed={() =>
          setRaceFollowUps((m) => {
            if (!(panelId in m)) return m;
            const { [panelId]: _consumed, ...rest } = m;
            return rest;
          })
        }
        onSendToRace={
          raceWatchTabs.length > 1 && raceWatchTabs.some((t) => t.panelId === panelId)
            ? sendRaceFollowUp
            : undefined
        }
        onMemoryWritten={(entry) => {
          setMemoryRefreshKey((k) => k + 1);
          setFileNotice(`Memory written → ${entry.title} (${entry.relPath})`);
        }}
        onOpenMemory={() => setMemoryVisible(true)}
        onSkillGenerated={(skill) => {
          void reloadFilesystemSkills();
          setFileNotice(`Skill generated → ${skill.name} (${skill.relPath})`);
        }}
      />
    );
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
              onEmptyAction={handleEditorEmptyAction}
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
        return renderAiPanel(aiPanels[0], {
          key,
          variant: opts?.aiVariant,
          initialMessage: opts?.aiVariant === "focus" ? focusInitialMessage : null,
        });
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
      const wt = await invoke<WorktreeInfo>(
        "git_worktree_add",
        { workspaceRoot: baseRoot, branch, copyFiles: null }
      );
      openForkedConversation(run, forkConversationFromRun(run, messages, wt.path, {
        branch: wt.branch,
        worktree: worktreeName(wt),
      }));
      setFileNotice(`Forked "${run.title}" into worktree ${wt.branch}${worktreeSetupSummary(wt)}.`);
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
      const wt = await invoke<WorktreeInfo>(
        "git_worktree_add",
        { workspaceRoot: root, branch, copyFiles: null }
      );
      const forked: Conversation = {
        ...convo,
        cwd: wt.path,
        branch: wt.branch,
        worktree: worktreeName(wt),
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
      setFileNotice(`Branched turn into worktree ${wt.branch}${worktreeSetupSummary(wt)}.`);
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
    setPendingAiPanels([{
      panelId: id,
      provider: opts.provider,
      resumeSessionId: opts.resumeSessionId ?? null,
      initialTask: opts.initialTask ?? null,
      conversationId: null,
    }]);
  }

  // "Reattach" from Mission Control's live-sessions strip — reconnect to a
  // delegate PTY that's still running in this Klide process. Unlike resume,
  // there's no `--resume` and no fresh CLI spawn: binding the new panel to the
  // session's conversation id makes its terminal land on the same PTY, and the
  // scrollback buffer (Slice 1) replays everything it produced while detached.
  // "Reopen" on a persisted (ended) session takes the same path with a
  // `resumeSessionId`: the disk-backed scrollback repaints the pre-restart
  // history and the fresh spawn `--resume`s the CLI session when its id is
  // known.
  function reattachLiveSession(opts: {
    provider: ProviderId;
    conversationId: string;
    workspaceRoot: string | null;
    resumeSessionId?: string | null;
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
    setPendingAiPanels([{
      panelId: id,
      provider: opts.provider,
      resumeSessionId: opts.resumeSessionId ?? null,
      initialTask: null,
      conversationId: opts.conversationId,
    }]);
  }

  // "Watch live" from the race composer — open every racer in its own AI
  // panel so both runs stream on screen instead of headless-only. Free /
  // anchored layouts get two floating panels split across the workbench;
  // Focus gets a tab per racer over the chat canvas. Each panel mounts
  // pinned to its worktree and bound to its run id (`conversationId`), so
  // AiPanel's existing mount-reattach path adopts the transcript snapshot
  // and follows the run live off the `agent-run:{id}` broadcast.
  function watchRace(group: RaceGroup) {
    const members = group.members.slice(0, 4);
    if (members.length === 0) return;
    setView("workbench");
    const margin = 12;
    const gap = 12;
    const splitW = Math.max(320, Math.floor((workbenchSize.w - margin * 2 - gap) / 2));
    const splitH = Math.max(320, workbenchSize.h - margin * 2);
    const pending: PendingAiPanel[] = [];
    const tabs: { panelId: string; label: string }[] = [];
    members.forEach((m, i) => {
      // Two racers split the workbench half/half; a partial race (one
      // survivor) or >2 members fall back to the cascade placement.
      const rect =
        !focusMode && members.length === 2
          ? { x: margin + i * (splitW + gap), y: margin, w: splitW, h: splitH }
          : undefined;
      const panelId = appendAiPanel({
        provider: m.provider as ProviderId,
        model: m.model,
        cwd: m.worktreePath,
        rect,
      });
      resumePanelsRef.current.set(m.runId, panelId);
      pending.push({
        panelId,
        provider: m.provider as ProviderId,
        resumeSessionId: null,
        initialTask: null,
        conversationId: m.runId,
      });
      tabs.push({
        panelId,
        label: `${String.fromCharCode(65 + i)} · ${modelLabel(m.model)}`,
      });
    });
    setPendingAiPanels(pending);
    setRaceWatchTabs(tabs);
    if (focusMode) {
      setFocusActiveTabId(tabs[0].panelId);
      setFocusChatActive(true);
    } else {
      // Two side-by-side panels need the free (floating) layout — the
      // anchored column has one AI slot.
      setAnchoredLayout(false);
      if (!aiVisible) togglePanel("ai");
    }
  }

  // One follow-up, every racer: queue the same text for each watched panel.
  // Each AiPanel sends it into its own conversation — and if that racer's
  // run is still streaming, the turn waits in its queue instead of racing it.
  function sendRaceFollowUp(text: string) {
    const t = text.trim();
    if (!t || raceWatchTabs.length === 0) return;
    const nonce = Date.now();
    setRaceFollowUps(
      Object.fromEntries(raceWatchTabs.map((tab) => [tab.panelId, { text: t, nonce }]))
    );
  }

  // Leave the Focus race-tab view: close the racers' panels (the runs keep
  // going headless in Rust and stay visible on the Mission Control board)
  // and return the canvas to the normal single-conversation chat.
  function endFocusRaceWatch() {
    if (raceWatchTabs.length === 0) return;
    for (const t of raceWatchTabs) closeAiPanel(t.panelId);
    setRaceWatchTabs([]);
    setFocusActiveTabId(null);
    setRaceFollowUps({});
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
      const wt = await invoke<WorktreeInfo>(
        "git_worktree_add",
        { workspaceRoot, branch: name, copyFiles: null }
      );
      setView("workbench");
      if (!aiVisible) togglePanel("ai");
      appendAiPanel({ cwd: wt.path });
      setFileNotice(`Worktree ready on ${wt.branch} — this panel runs there${worktreeSetupSummary(wt)}.`);
    } catch (err) {
      setFileNotice(`Worktree failed: ${err instanceof Error ? err.message : String(err)}`);
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
  }, [theme]);

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
    const listeners = createListenerScope();
    listeners.add(listen("delegate-pty:exit", () => {
      refreshGitStatus(workspaceRoot);
    }));
    return listeners.dispose;
  }, [workspaceRoot]);

  // Worktree setup scripts (recipe: .klide/worktree.json) run on a Rust
  // background thread so creating a worktree never blocks on an install —
  // surface their outcome the moment they finish, whichever view is open.
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    const listeners = createListenerScope();
    listeners.add(listen<WorktreeSetupDone>("worktree-setup:done", (e) => {
      const name = worktreeName(e.payload);
      if (e.payload.ok) {
        notify(`Worktree setup finished · ${name}`);
      } else {
        const lines = e.payload.output.trim().split("\n");
        const tail = lines[lines.length - 1] ?? "";
        notify(`Worktree setup failed · ${name}${tail ? ` — ${tail}` : ""}`, { tone: "error" });
      }
    }));
    return listeners.dispose;
  }, []);

  // The editor's no-file launcher rows fire the same handlers as their
  // keyboard chords below — click and shortcut stay one code path.
  const handleEditorEmptyAction = useCallback((action: EditorEmptyAction) => {
    switch (action) {
      case "go-to-file":
        setPaletteQuery("");
        setPaletteOpen(true);
        break;
      case "command-palette":
        setPaletteQuery("> ");
        setPaletteOpen(true);
        break;
      case "find-in-files":
        setSearchVisible(true);
        break;
      case "toggle-terminal":
        setTerminalVisible((v) => !v);
        break;
    }
  }, []);

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
    const listeners = createListenerScope();
    listeners.add(listen("menu:command-palette", () => {
      setPaletteQuery("> ");
      setPaletteOpen(true);
    }));
    listeners.add(listen("menu:find-in-files", () => {
      setSearchVisible((v) => !v);
    }));
    listeners.add(listen("menu:toggle-terminal", () => {
      setTerminalVisible((v) => !v);
    }));
    listeners.add(listen("menu:toggle-search", () => {
      setSearchVisible((v) => !v);
    }));
    listeners.add(listen("menu:open-settings", () => {
      setView("settings");
    }));
    listeners.add(listen("menu:close-tab", () => {
      if (activeIdx >= 0 && activeIdx < tabs.length) closeTab(activeIdx);
    }));
    listeners.add(listen("menu:close-window", () => {
      // On macOS, window close is handled by the system; this is a fallback
    }));
    listeners.add(listen("menu:open-folder", () => {
      openFolderDialog();
    }));
    return listeners.dispose;
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
          <Suspense fallback={null}>
            <SettingsPanel
              key={settingsInitial ?? "default"}
              initialSection={settingsInitial}
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
              availableAiModels={panelModels["ai-main"] ?? [aiModel]}
              explorerVisible={explorerVisible}
              onExplorerVisibleChange={setExplorerVisible}
              explorerFloating={explorerFloating}
              onExplorerFloatingChange={setExplorerFloating}
              customLayouts={customLayouts}
              onCustomLayoutsChange={updateCustomLayouts}
              onApplyLayout={applyLayout}
              onProviderKeyChange={() => setApiKeyVersion((version) => version + 1)}
              onBack={() => setView("workbench")}
            />
          </Suspense>
        ) : (
          <>
            {/* Focus is chat-first: the icon rail steps back while the focus
                screen itself is showing (its own rail carries navigation —
                projects, Mission Control, profile). Overlay views opened from
                it (Mission Control, Git) bring the rail back. */}
            {!(focusMode && view === "workbench") && (
            <ActivityBar
              active={activityState}
              onToggle={togglePanel}
              onSearch={() => setPaletteOpen(true)}
              homeLabel={workspaceRoot?.split("/").filter(Boolean).pop()}
              submenus={{
                // Home is the project-level entry — switching lives there.
                // Explorer stays purely "open the file tree".
                home: {
                  title: "Recent projects",
                  items: recentFolders.slice(0, 6).map((folder) => ({
                    key: folder,
                    label: folder.split("/").filter(Boolean).pop() ?? folder,
                    active: folder === workspaceRoot,
                    onSelect: () => changeRoot(folder),
                  })),
                },
                settings: {
                  title: "Settings",
                  items: (
                    [
                      ["general", "General"],
                      ["appearance", "Appearance"],
                      ["editor", "Editor"],
                      ["ai", "AI & Harness"],
                      ["api", "API Keys"],
                      ["layout", "Layout"],
                      ["stats", "Stats"],
                    ] as const
                  ).map(([section, label]) => ({
                    key: section,
                    label,
                    onSelect: () => {
                      setSettingsInitial(section);
                      setView("settings");
                    },
                  })),
                },
              }}
            />
            )}
            {view === "git-review" ? (
              <Suspense fallback={null}>
                <GitReview
                  workspaceRoot={effectiveGitReviewRoot}
                  gitStatus={effectiveGitReviewRoot === workspaceRoot ? gitStatus : null}
                  onRefreshGitStatus={() =>
                    effectiveGitReviewRoot && effectiveGitReviewRoot === workspaceRoot
                      ? refreshGitStatus(effectiveGitReviewRoot)
                      : Promise.resolve()
                  }
                  theme={theme}
                />
              </Suspense>
            ) : view === "runs" ? (
              <Suspense fallback={null}>
                <MissionControl
                  workspaceRoot={workspaceRoot}
                  theme={theme}
                  onResumeKlideRun={resumeKlideRun}
                  onOpenInAiPanel={openRunInAiPanel}
                  onReattachLiveSession={reattachLiveSession}
                  onWatchRace={watchRace}
                  onSaveMemory={saveMemoryFromRun}
                  onForkRun={forkRun}
                  onForkRunInWorktree={forkRunInWorktree}
                  onMergeWorktreeRun={mergeWorktreeRun}
                  summarizingFromRunId={summarizingFromRun}
                />
              </Suspense>
            ) : view === "orchestrator" ? (
              // Real tier-board console. workspaceRoot enables real plan-mode
              // dispatch through the slice-1 dispatcher seam.
              <Suspense fallback={null}>
                <OrchestratorConsole workspaceRoot={workspaceRoot} />
              </Suspense>
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
              <Suspense fallback={null}>
                <FocusMode
                  workspaceRoot={workspaceRoot}
                  branch={gitStatus?.branch ?? null}
                  projects={recentFolders}
                  chatActive={focusChatActive}
                  onSwitchProject={(root) => {
                    endFocusRaceWatch();
                    setFocusChatActive(false);
                    changeRoot(root);
                  }}
                  onNewChat={() => {
                    endFocusRaceWatch();
                    setFocusChatActive(false);
                  }}
                  onOpenConversation={(convo) => {
                    // A conversation from another project's history brings its
                    // project along — resuming it against the wrong workspace
                    // would point every tool at the wrong tree.
                    endFocusRaceWatch();
                    if (convo.cwd && convo.cwd !== workspaceRoot) changeRoot(convo.cwd);
                    setResumeTarget({ panelId: aiPanels[0]?.id ?? "ai-main", convo });
                    setFocusChatActive(true);
                  }}
                  onSubmit={(text) => {
                    setFocusInitialMessage(text);
                    setFocusChatActive(true);
                  }}
                  onOpenMissionControl={() => setView("runs")}
                  raceTabs={raceWatchTabs}
                  activeRaceTab={focusActiveTabId}
                  onSelectRaceTab={setFocusActiveTabId}
                  onRaceFollowUp={sendRaceFollowUp}
                  onCloseRaceTabs={() => {
                    endFocusRaceWatch();
                    setFocusChatActive(false);
                  }}
                  renderChat={() => {
                    if (raceWatchTabs.length === 0)
                      return renderPanel("ai", "focus-ai", { aiVariant: "focus" });
                    // Race watch: every racer's panel stays MOUNTED (run
                    // subscriptions are mount-tied), the inactive tab is only
                    // display:none.
                    const activeId = focusActiveTabId ?? raceWatchTabs[0].panelId;
                    return raceWatchTabs.map((t) => (
                      <div
                        key={t.panelId}
                        style={{
                          display: t.panelId === activeId ? "flex" : "none",
                          flex: 1,
                          minHeight: 0,
                          flexDirection: "column",
                          overflow: "hidden",
                        }}
                      >
                        {renderAiPanel(
                          aiPanels.find((p) => p.id === t.panelId),
                          { key: `focus-${t.panelId}`, variant: "focus", respectWorktree: true }
                        )}
                      </div>
                    ));
                  }}
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
              </Suspense>
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
                renderAiPanel={renderAiPanel}
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
                previewPath={previewPath}
                onClosePreview={() => setPreviewPath(null)}
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
                  // past the panel edge.
                }}
              >
                {/* Idle canvas — quiet launchers so closing the last panel
                    never strands the user on a blank field. Type-only rows,
                    delayed fade-in (quick toggles don't flash it), under
                    every dock and floating panel. */}
                {canvasIdle && (
                  <div className="workbench-idle">
                    <button
                      type="button"
                      className="workbench-idle-row"
                      onClick={() => {
                        setPaletteQuery("");
                        setPaletteOpen(true);
                      }}
                    >
                      <span>Open a file</span>
                      <KbdFor id="go-to-file" />
                    </button>
                    <button
                      type="button"
                      className="workbench-idle-row"
                      onClick={() => {
                        if (aiPanels.length === 0) ensureAiRect();
                        setAiVisible(true);
                        focusPanel(aiPanels[0]?.id ?? "ai-main");
                      }}
                    >
                      <span>New chat</span>
                    </button>
                    {tabs.length > 0 && (
                      <button
                        type="button"
                        className="workbench-idle-row"
                        onClick={() => setEditorDockFolded(false)}
                      >
                        <span>
                          Show editor — {tabs.length} {tabs.length === 1 ? "file" : "files"} docked
                        </span>
                      </button>
                    )}
                    <button
                      type="button"
                      className="workbench-idle-row"
                      onClick={() => setTerminalVisible(true)}
                    >
                      <span>Open terminal</span>
                      <KbdFor id="toggle-terminal" />
                    </button>
                  </div>
                )}
                {explorerVisible && explorerFloating && (
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
                    {renderExplorerContent()}
                  </FloatingPanel>
                )}
                {/* Docked explorer (default) — the Explorer as a drawer glued
                    to the activity bar, not a floating window: it glides in
                    from the left edge on click (same compositor-only motion
                    as the editor dock) and slides away on toggle. The
                    "Floating explorer" setting restores the draggable panel. */}
                {!explorerFloating && (
                  <div
                    className="explorer-dock-overlay"
                    data-open={explorerVisible ? "true" : "false"}
                    aria-hidden={!explorerVisible}
                    style={{ width: explorerRect.w, zIndex: Z.dock }}
                  >
                    {renderExplorerContent()}
                    <div
                      role="separator"
                      aria-orientation="vertical"
                      aria-label="Resize explorer"
                      onMouseDown={beginExplorerDockResize}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background =
                          "linear-gradient(to left, var(--accent-soft), transparent)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = "transparent";
                      }}
                      style={{
                        position: "absolute",
                        right: 0,
                        top: 0,
                        bottom: 0,
                        width: 7,
                        cursor: "col-resize",
                        zIndex: 30,
                        background: "transparent",
                        transition: "background var(--motion-fast) var(--ease-out)",
                      }}
                    />
                  </div>
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
                    <Suspense fallback={null}>
                      <FileViewerPanel
                        key={previewPath}
                        filePath={previewPath}
                        workspaceRoot={workspaceRoot}
                        onClose={() => setPreviewPath(null)}
                      />
                    </Suspense>
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
                    <Suspense fallback={null}>
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
                    </Suspense>
                  </div>
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
                      {renderAiPanel(panel, {
                        width: panel.rect.w,
                        respectWorktree: true,
                        duplicatable: true,
                        closable: aiPanels.length > 1,
                      })}
                    </FloatingPanel>
                  );
                })}
                {aiVisible && raceWatchTabs.length > 0 && (
                  <RaceFollowUpBar
                    count={raceWatchTabs.length}
                    onSend={sendRaceFollowUp}
                    onDismiss={() => {
                      // Hide the bar only — panels and runs are untouched.
                      setRaceWatchTabs([]);
                      setRaceFollowUps({});
                    }}
                  />
                )}
                {/* Docked editor — in the free layout, files no longer open in
                    a background layer under the floating panels. The editor is
                    an elevated card docked to the right edge that glides in
                    when a file (or find-in-files) opens and away when the last
                    tab closes. It animates with transform/opacity ONLY — its
                    width never changes, so nothing reflows during the slide
                    (Monaco's automaticLayout would otherwise re-measure every
                    frame) and the motion stays on the compositor. Content
                    stays mounted while closed so Monaco doesn't remount per
                    open/close. */}
                <div
                  className="editor-dock-overlay"
                  data-open={tabs.length > 0 || searchVisible ? "true" : "false"}
                  data-folded={editorDockFolded ? "true" : "false"}
                  aria-hidden={(tabs.length === 0 && !searchVisible) || editorDockFolded}
                  style={{
                    zIndex: Z.dock,
                    ...(editorDockWidth !== null ? { width: editorDockWidth } : null),
                  }}
                >
                  {/* Left-edge splitter — a wide invisible grab zone that
                      tints the pane's edge on hover, matching the anchored
                      workbench's hairline splitters. The folded spine takes
                      this edge over while tucked. */}
                  {!editorDockFolded && (
                    <div
                      role="separator"
                      aria-orientation="vertical"
                      aria-label="Resize editor"
                      onMouseDown={beginEditorDockResize}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background =
                          "linear-gradient(to right, var(--accent-soft), transparent)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = "transparent";
                      }}
                      style={{
                        position: "absolute",
                        left: 0,
                        top: 0,
                        bottom: 0,
                        width: 7,
                        cursor: "col-resize",
                        zIndex: 30,
                        background: "transparent",
                        transition: "background var(--motion-fast) var(--ease-out)",
                      }}
                    />
                  )}
                  {/* Everything below fades out while folded so the sliver
                      shows the canvas through the glass surface — not a
                      40px strip of line numbers and tab fragments. Content
                      stays mounted; only opacity changes. */}
                  <div className="editor-dock-content">
                  <div style={{ display: "flex", alignItems: "stretch", minWidth: 0 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <TabBar
                        variant="flat"
                        tabs={tabs.map((t) => ({ path: t.path, dirty: t.dirty, externalChanged: t.externalChanged }))}
                        activeIdx={activeIdx}
                        onSelect={setActiveIdx}
                        onClose={closeTab}
                        workspaceRoot={workspaceRoot}
                      />
                    </div>
                    {tabs.length > 0 && !editorDockFolded && (
                      <button
                        type="button"
                        title="Fold editor — reopen from the status bar"
                        aria-label="Fold editor"
                        onClick={() => setEditorDockFolded(true)}
                        style={{
                          width: 30,
                          flexShrink: 0,
                          border: "none",
                          borderBottom: "1px solid var(--border)",
                          display: "grid",
                          placeItems: "center",
                          background: "transparent",
                          color: "var(--fg-subtle)",
                          cursor: "pointer",
                          transition: "color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out)",
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.color = "var(--fg-strong)";
                          e.currentTarget.style.background = "var(--bg-hover)";
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.color = "var(--fg-subtle)";
                          e.currentTarget.style.background = "transparent";
                        }}
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M6 6l6 6-6 6" />
                          <path d="M13 6l6 6-6 6" />
                        </svg>
                      </button>
                    )}
                  </div>
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
                      onEmptyAction={handleEditorEmptyAction}
                    />
                  </div>
                  </div>
                </div>
                {/* Docked terminal — a full-width drawer glued to the bottom
                    edge. Same compositor-only slide language as the editor
                    dock (transform + opacity only; the height changes by
                    user drag, never by animation). Rendered after the editor
                    dock at the same Z.dock, so it slides over the dock's
                    lower edge. Content mounts on first open, then stays. */}
                <div
                  className="terminal-dock-overlay"
                  data-open={terminalVisible ? "true" : "false"}
                  aria-hidden={!terminalVisible}
                  style={{ height: terminalRect.h, zIndex: Z.dock }}
                >
                  <div
                    role="separator"
                    aria-orientation="horizontal"
                    aria-label="Resize terminal"
                    onMouseDown={beginTerminalDockResize}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background =
                        "linear-gradient(to bottom, var(--accent-soft), transparent)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "transparent";
                    }}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      right: 0,
                      height: 7,
                      cursor: "row-resize",
                      zIndex: 30,
                      background: "transparent",
                      transition: "background var(--motion-fast) var(--ease-out)",
                    }}
                  />
                  {terminalMounted && (
                    <TerminalPanel
                      fill
                      visible
                      theme={theme}
                      height={terminalRect.h}
                      workspaceRoot={workspaceRoot}
                      onToggle={() => setTerminalVisible(false)}
                    />
                  )}
                </div>
              </div>
            )}
              </div>
            )}
            {/* Docked Artifact Inspector — the same slide-in review surface as
                Mission Control, at the right edge of the workbench. Opened
                from the AI panel's "N files changed" row; MC keeps its own
                instance, so this one only shows on the workbench view. */}
            {view === "workbench" && (
              <div
                className="artifact-inspector-shell"
                data-open={artifactOpen ? "true" : "false"}
                aria-hidden={!artifactOpen}
                style={{ pointerEvents: artifactOpen ? "auto" : "none" }}
              >
                {artifactTabs.length > 0 && activeArtifactKey !== null && (
                  <Suspense fallback={<div className="artifact-inspector-state">Opening artifact…</div>}>
                    <ArtifactInspector
                      tabs={artifactTabs}
                      activeTabKey={activeArtifactKey}
                      theme={theme}
                      onSelectTab={setActiveArtifactKey}
                      onCloseTab={closeArtifactTab}
                      onClose={closeArtifact}
                      onDirtyChange={setArtifactDirty}
                    />
                  </Suspense>
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
        showLayoutControls={view === "workbench"}
        foldedEditor={
          view === "workbench" &&
          !focusMode &&
          !activeGrid &&
          panelLayout.anchored === false &&
          editorDockFolded &&
          tabs.length > 0
            ? {
                files: tabs.length,
                agentFile: tabs.find((t) => isAgentFile(t.path))?.path.split("/").pop() ?? null,
                onOpen: () => setEditorDockFolded(false),
              }
            : null
        }
      />
      {skillsVisible && sidebarSlot2 !== "skills" && (
        <Suspense fallback={null}>
          <SkillsModal
            open
            skills={skills}
            onChange={updateSkills}
            onReloadFilesystemSkills={reloadFilesystemSkills}
            onClose={() => setSkillsVisible(false)}
          />
        </Suspense>
      )}
      {memoryVisible && (
        <Suspense fallback={null}>
          <MemoryModal
            open
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
        </Suspense>
      )}
      {worktreesVisible && (
        <Suspense fallback={null}>
          <WorktreesModal
            open
            workspaceRoot={workspaceRoot}
            onOpenWorktree={openExistingWorktree}
            onNotice={setFileNotice}
            onClose={() => setWorktreesVisible(false)}
          />
        </Suspense>
      )}
      <ProfileModal
        open={profileVisible}
        workspaceRoot={workspaceRoot}
        onClose={() => setProfileVisible(false)}
      />
      {shortcutsOpen && (
        <Suspense fallback={null}>
          <KeyboardShortcuts onClose={() => setShortcutsOpen(false)} />
        </Suspense>
      )}
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
