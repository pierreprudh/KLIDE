import {
  Fragment,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { WorkspaceRail, type RailNavItem } from "./components/WorkspaceRail";
import {
  CloseIcon,
  FocusLayoutIcon,
  FreeLayoutIcon,
  TerminalIcon,
  FolderIcon,
  GitIcon,
  MemoryIcon,
  MissionIcon,
  NewTaskIcon,
  OrchestratorIcon,
  SkillsIcon,
} from "./icons";
import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { EditorArea, type EditorEmptyAction } from "./components/lazySurfaces";
import { ImageView } from "./components/ImageView";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { KbdFor } from "./components/Kbd";
import { TerminalPanel } from "./components/lazySurfaces";
import { AiPanel } from "./components/AiPanel";
import { StatusBar } from "./components/StatusBar";
// Static (not lazy) on purpose: it is the placeholder shown *while* the
// Mission Control chunk loads, so it has to be in the main bundle.
import { MissionControlSkeleton } from "./components/MissionControlSkeleton";
import ToastHost from "./components/ToastHost";
import { notify } from "./toast";
import { onDelegateExit } from "./ipc/delegatePty";
import {
  gitWorktreeAdd,
  gitWorktreeMerge,
  gitWorktreeRemove,
  createPr,
} from "./ipc/git";
import { refreshGitStatus, useGitStatus } from "./gitStatus";
import { eventsToConversation, runMessagesToMsgs } from "./components/ai/replayConversation";
import {
  CONVERSATIONS_CHANGED_EVENT,
  PANEL_BINDINGS_CHANGED_EVENT,
  loadConversations,
  loadPanelSession,
} from "./components/ai/storedConversations";
import type { AgentAttachment, AgentEvent, ProviderId } from "./agent/types";
import { defaultModelForProvider, providerName } from "./agent/providers";
import type { Conversation } from "./components/ai/types";
import { summarizeAndHandoff } from "./components/ai/summarize";
import { fetchRunMessages, type Run, type RunMessage as MissionRunMessage } from "./runs";
import { isDelegateId, type DelegateId } from "./delegates";
import { ProfileModal } from "./components/ProfileModal";
import { getNextThemeId } from "./theme";
import { SETTINGS, getSetting, setSetting, useSetting } from "./settingsStore";
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
import { detectLanguage } from "./editorLanguage";
import { beginDragSession } from "./dragSession";
import {
  isConversationDrag,
  readConversationDrag,
} from "./conversationDrag";
import { CommandPalette } from "./components/CommandPalette";
import { SearchPanel } from "./components/SearchPanel";
import { useEditorTabs } from "./hooks/useEditorTabs";
import { usePanelLayout, type AiPanelInstance } from "./hooks/usePanelLayout";
import {
  useSurface,
  resolveSurface,
  ownsTitlebar,
  showsRail,
  showsStatusBar,
} from "./hooks/useSurface";
import { useAiPanelFleet } from "./hooks/useAiPanelFleet";
import { useArtifactInspector } from "./hooks/useArtifactInspector";
import { listCheckpoints, readAgentRunEvents } from "./agent/client";
import { artifactOpensIn, artifactPreview, loadArtifactPreview, openArtifactInApp } from "./artifacts";
import { DocumentViewer } from "./components/DocumentViewer";
import { errMessage } from "./errors";
import {
  DEFAULT_AI_PANEL_ID,
  admissionBase,
  admissionNeedsWorkbench,
  admissionSurface,
  conversationSessionKey,
  initialHandoffFor,
  panelWorkspace,
  resumeConversationFor,
  surfaceShowsOneAiPanel,
  type AiPanelRenderOptions,
  type AiSurface,
} from "./components/ai/panelHost";
import { readWorkspaceTextFile } from "./workspaceFs";
import { modelLabel } from "./components/ai/ModelPicker";
import { ProviderLogo } from "./components/ai/icons";
import { RaceFollowUpBar } from "./components/ai/RaceFollowUpBar";
import { raceForRun, removeRace, type RaceGroup } from "./races";
import { useIsConversationRunning } from "./runningConversations";
import {
  worktreeSetupSummary,
  worktreeName,
  type WorktreeSetupDone,
} from "./worktrees";
import { createListenerScope } from "./tauriEvents";
import { registerSettingsOpener } from "./settingsNavigation";
import {
  canonicalWorkspaceRoot,
  legacyAutoRunWorkspace,
  linkedProjectForPath,
} from "./projectPaths";
import { promoteWorkedFolder, rememberOpenedFolder } from "./recentFolders";
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

/** Documents whose best picture App keeps in memory for the viewer's first
 *  frame. A run makes a handful; past this the oldest is forgotten. */
const BEST_PICTURES_KEPT = 48;

function App() {
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);
  // The Surface — which screen the app is on. One owner for what used to be
  // four unrelated atoms (view / focusMode / activeGridId / the derived
  // Welcome condition): a base (Focus, a grid, or the anchored/free panels
  // workbench) plus at most one full-window overlay (Mission Control,
  // Orchestrator, Settings, Git Review) over it. `enterWorkbench`'s
  // anchored/free half belongs to the panel-layout store below; the two hooks
  // reference each other in opposite directions (surface → hostKey → layout;
  // layout → anchored setter → surface), so the setter arrives through a ref.
  const applyPanelsModeRef = useRef<(anchored: boolean) => void>(() => {});
  const {
    core: surfaceCore,
    hostKey: surfaceKey,
    enterFocus,
    exitFocus,
    enterWorkbench,
    applyGrid,
    exitGrid,
    openOverlay,
    toggleOverlay,
    back,
  } = useSurface({
    applyPanelsMode: useCallback((anchored: boolean) => {
      applyPanelsModeRef.current(anchored);
    }, []),
  });
  // The two shorthands most guards need: is an overlay covering the base,
  // and is the base the Focus screen (regardless of overlay — the status
  // bar keeps its Focus styling while Settings covers Focus).
  const overlay = surfaceCore.overlay;
  const focusBase = surfaceCore.base.kind === "focus";
  const [explorerVisible, setExplorerVisible] = useState(
    () => localStorage.getItem("klide-explorer-visible") !== "false"
  );
  // General settings — startup, files, and tab behaviour. Durable settings
  // live in the settings store (src/settingsStore.ts); the Settings panel
  // reads/writes the same store, so none of these need prop threading.
  const [autoSaveMode] = useSetting(SETTINGS.autoSaveMode);
  const [showHiddenFiles] = useSetting(SETTINGS.showHiddenFiles);
  const [confirmCloseDirty] = useSetting(SETTINGS.confirmCloseDirty);
  // Focus screen state: home (hero composer) vs the live conversation, and
  // the hero composer's text on its way into the AI panel.
  const [focusChatActive, setFocusChatActive] = useState(false);
  // Focus's half of the rail's selection state. It lives up here because the
  // rail does: one instance across every surface, so the state a rail click
  // sets cannot sit inside one of the shells. `focusConvoError` is the
  // "conversation unavailable" apology Focus draws on its canvas.
  const [focusSelectedConvoId, setFocusSelectedConvoId] = useState<string | null>(null);
  const [focusConvoError, setFocusConvoError] = useState<{ title: string } | null>(null);
  const [focusInitialMessage, setFocusInitialMessage] = useState<string | null>(null);
  // Photos/documents staged on the start stage, travelling with that first
  // message. Cleared by the same consume callback, so a second task never
  // inherits the first one's attachments.
  const [focusInitialAttachments, setFocusInitialAttachments] = useState<AgentAttachment[]>([]);
  // Focus split — a second conversation beside the first. Only the *identity*
  // of the second panel lives here; the panel itself is an ordinary member of
  // the AI fleet, so both halves are fully wired conversations rather than a
  // reader copy, and neither loses its run subscription to the other. The
  // divider's position is remembered, the split itself is not: Focus opens on
  // one conversation.
  const [focusSplitPanelId, setFocusSplitPanelId] = useState<string | null>(null);
  const [focusSplitRatio, setFocusSplitRatio] = useState(() => {
    const stored = Number(localStorage.getItem("klide.focus.splitRatio"));
    return Number.isFinite(stored) && stored >= 0.25 && stored <= 0.75 ? stored : 0.5;
  });
  const focusSplitRowRef = useRef<HTMLDivElement | null>(null);
  // The drag ends in a closure captured when the drag started; the ref is what
  // it reads the settled ratio back out of.
  const focusSplitRatioRef = useRef(focusSplitRatio);
  focusSplitRatioRef.current = focusSplitRatio;
  // Which half the pointer is over mid-drag, and whether a conversation is
  // being dragged at all. The second one is what makes the "Open beside"
  // landing strip appear only when there is something to land — the canvas
  // grows no permanent drop chrome.
  const [focusDropTarget, setFocusDropTarget] = useState<"primary" | "split" | null>(null);
  // The seam opens rather than appears. `shown` is deliberately a frame behind
  // the panel's existence — a width transition needs a previous value to
  // animate FROM, and a half that arrives already at its full width just pops.
  // Same two-frame ritual as the terminal dock, for the same reason.
  const [focusSplitShown, setFocusSplitShown] = useState(false);
  const [focusSplitResizing, setFocusSplitResizing] = useState(false);
  const [focusConversationDrag, setFocusConversationDrag] = useState(false);
  useEffect(() => {
    if (!focusSplitPanelId) {
      setFocusSplitShown(false);
      return;
    }
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setFocusSplitShown(true));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [focusSplitPanelId]);
  useEffect(() => {
    function onDragStart(e: DragEvent) {
      if (isConversationDrag(e.dataTransfer)) setFocusConversationDrag(true);
    }
    function onDragEnd() {
      setFocusConversationDrag(false);
      setFocusDropTarget(null);
    }
    window.addEventListener("dragstart", onDragStart);
    window.addEventListener("dragend", onDragEnd);
    // A drop anywhere ends the gesture — including on a target that ignored
    // it, which never fires `dragend` on the source in every browser.
    window.addEventListener("drop", onDragEnd);
    return () => {
      window.removeEventListener("dragstart", onDragStart);
      window.removeEventListener("dragend", onDragEnd);
      window.removeEventListener("drop", onDragEnd);
    };
  }, []);

  // The shell docked under Focus's canvas. Not persisted: Focus should open on
  // its home (or the conversation you left), never on a terminal you forgot.
  const [focusTerminalOpen, setFocusTerminalOpen] = useState(false);
  const [focusTerminalMounted, setFocusTerminalMounted] = useState(false);
  const [focusTerminalResizing, setFocusTerminalResizing] = useState(false);
  // `shown` is deliberately a frame behind `mounted`: a height transition needs
  // a previous value to animate FROM, and an element that appears already at
  // its full height just pops. So the dock mounts closed, then opens — which is
  // also why xterm gets a real box (the inner wrapper) from its very first
  // frame and only ever measures once.
  const [focusTerminalShown, setFocusTerminalShown] = useState(false);
  useEffect(() => {
    if (!focusTerminalOpen) {
      setFocusTerminalShown(false);
      return;
    }
    if (!focusTerminalMounted) {
      setFocusTerminalMounted(true);
      return;
    }
    // Two frames: one for the browser to lay the closed dock out, one to start
    // the transition from it.
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setFocusTerminalShown(true));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [focusTerminalOpen, focusTerminalMounted]);
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
  // One poll per root lives in `gitStatus.ts`; this only re-renders when
  // the branch or the changed-file list actually differs.
  const gitStatus = useGitStatus(workspaceRoot);
  const [recentFolders, setRecentFolders] = useState<string[]>(() => {
    try {
      const parsed = JSON.parse(
        localStorage.getItem("klide.recentFolders") || "[]"
      );
      return Array.isArray(parsed)
        ? Array.from(new Set(
            parsed
              .filter((p): p is string => typeof p === "string")
              .map(canonicalWorkspaceRoot)
              .filter((p): p is string => Boolean(p)),
          ))
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
    setAiPanelCwd,
    closeAiPanel,
  } = usePanelLayout({ workspaceRoot, hostKey: surfaceKey });
  // Close the surface↔layout loop: enterWorkbench("anchored" | "free")
  // lands its anchored bit here, in the per-workspace layout store.
  useEffect(() => {
    applyPanelsModeRef.current = setAnchoredLayout;
  });
  // Which of the four AI surfaces is on screen, and which workbench an
  // admission forced off Focus would land on. Both feed the fleet's slot
  // question below: only free (floating) mode renders more than one AI panel.
  const workbenchKind: "anchored" | "free" =
    panelLayout.anchored !== false ? "anchored" : "free";
  const aiSurfaceBase: AiSurface =
    surfaceCore.base.kind === "focus"
      ? "focus"
      : surfaceCore.base.kind === "grid"
        ? "grid"
        : workbenchKind;
  // Fleet membership + lifecycle: which Conversation sessions are live, and
  // every queue keyed by panel id (handoffs, targeted resumes, race tabs,
  // follow-ups, per-panel settings). `admit` is the one way a session enters
  // the fleet, `release` the one way it leaves — geometry (rect seeding,
  // persistence) stays in usePanelLayout behind the injected callbacks.
  const {
    resumeTarget,
    raceWatchTabs,
    focusActiveTabId,
    followUpsByPanel,
    modelsByPanel,
    reviewOverrideByPanel,
    commandsOverrideByPanel,
    admit,
    release,
    endRaceWatch,
    pendingForPanel,
    seatFor,
    consumeHandoff,
    targetResume,
    consumeResume,
    selectRaceTab,
    queueRaceFollowUp,
    consumeFollowUp,
    clearRaceWatch,
    reportPanelModels,
    setPanelReviewOverride,
    setPanelCommandsOverride,
  } = useAiPanelFleet({
    createPanel: appendAiPanel,
    removePanel: closeAiPanel,
    focusPanel,
    // The reveal ritual every admission shared: return to the base surface
    // (AI panels render there — Focus or the workbench) and show the AI
    // surface without toggling it off when it's already up. A race split
    // manages its own visibility instead — Focus swaps to tabs, free mode
    // unanchors (see watchRace).
    revealSurface: (intent) => {
      back();
      if (intent.kind === "race-watch") return;
      if (intent.kind === "focus-resume") {
        // The one admission that names its surface: it goes to Focus from
        // wherever the user is, and Focus shows a start stage until a
        // conversation is active.
        enterFocus();
        setFocusChatActive(true);
        return;
      }
      if (aiSurfaceBase === "focus") {
        const provider = "provider" in intent ? intent.provider : undefined;
        if (admissionNeedsWorkbench(intent)) {
          // The CLI's interactive session is a terminal, and Focus does not
          // host one — it runs the same delegate one-shot and headless. Left
          // in Focus this admission spawns a session nothing renders, which
          // is exactly what "Resume in Claude Code" used to feel like.
          exitFocus();
          notify(
            provider
              ? `${providerName(provider)}'s live session opens in the workbench.`
              : "This session opens in the workbench.",
          );
        } else {
          // Focus shows its start stage until a conversation is active; a
          // resumed run has to switch it on or the canvas stays a start page.
          setFocusChatActive(true);
        }
      }
      if (!aiVisible) togglePanel("ai");
    },
    // Where a single-session admission lands. On a one-slot surface that is
    // the panel already on screen — appending there is what made Resume look
    // like a no-op. `race-watch` and `fresh` mean "another panel" by
    // definition, and an empty fleet has no slot to reuse.
    slotForAdmission: (intent) => {
      if (intent.kind === "race-watch" || intent.kind === "fresh") return null;
      if (aiPanels.length === 0) return null;
      const surface = admissionSurface(
        admissionNeedsWorkbench(intent),
        admissionBase(intent.kind, aiSurfaceBase),
        workbenchKind,
      );
      return surfaceShowsOneAiPanel(surface) ? primaryPanelId : null;
    },
    reseatPanel: (panelId, seed) => {
      if (seed.provider) setAiPanelProvider(panelId, seed.provider);
      if (seed.model) setAiPanelModel(panelId, seed.model);
      // Always written, never only when set: a panel still pinned to the last
      // admission's worktree must follow this one back to the Workspace.
      setAiPanelCwd(panelId, seed.cwd);
      focusPanel(panelId);
    },
    openPanelIds: () => aiPanels.map((panel) => panel.id),
    // The panel already bound to a conversation (the one that spawned its PTY,
    // or an earlier reattach) — reattach focuses it instead of opening a
    // second terminal onto the same live session.
    panelBoundToConversation: (conversationId) =>
      aiPanels.find((p) => loadPanelSession(p.id)?.convoId === conversationId)?.id ?? null,
  });
  // "The" AI panel when a surface addresses the default slot.
  const primaryPanelId = aiPanels[0]?.id ?? DEFAULT_AI_PANEL_ID;

  // What each open AI panel currently holds. The rail lists these under its AI
  // row — in a floating-panel workspace the conversation you are in is
  // otherwise only visible by reading the panels themselves — and marks the
  // matching row in its history tree. A panel's bound conversation lives in
  // localStorage, which is not reactive, so this re-reads on the same index
  // event AiPanel publishes when a conversation is created, renamed or
  // switched.
  const [openConversations, setOpenConversations] = useState<
    { panelId: string; convoId: string; title: string }[]
  >([]);
  useEffect(() => {
    const read = () => {
      const stored = loadConversations<Conversation>();
      // An empty fleet still renders the default slot (Focus's primary pane,
      // the anchored workbench's AI panel), so its binding must still count.
      const panelIds =
        aiPanels.length > 0 ? aiPanels.map((p) => p.id) : [DEFAULT_AI_PANEL_ID];
      setOpenConversations(
        panelIds.flatMap((panelId) => {
          const convoId = loadPanelSession(panelId)?.convoId;
          if (!convoId) return [];
          const convo = stored.find((c) => c.id === convoId);
          // A session pointing at a pruned conversation is not something to
          // show — the panel is showing an empty chat, and so should the rail.
          if (!convo) return [];
          return [{ panelId, convoId, title: convo.title || "Untitled" }];
        }),
      );
    };
    read();
    window.addEventListener(CONVERSATIONS_CHANGED_EVENT, read);
    // A resume into a panel rebinds it without touching the conversation
    // index, so the bindings' own event is what keeps the rail's marks live.
    window.addEventListener(PANEL_BINDINGS_CHANGED_EVENT, read);
    return () => {
      window.removeEventListener(CONVERSATIONS_CHANGED_EVENT, read);
      window.removeEventListener(PANEL_BINDINGS_CHANGED_EVENT, read);
    };
  }, [aiPanels]);
  // The rail's "you are here" row — the focused panel's conversation, falling
  // back to the primary slot. One derivation for both rails: the workbench's
  // and Focus's draw the same history tree, and with two conversations up
  // (Focus split, floating panels) they must agree on which one is selected
  // and which are merely open.
  const railActiveConversationId =
    openConversations.find((c) => c.panelId === focusedPanel)?.convoId ??
    openConversations.find((c) => c.panelId === primaryPanelId)?.convoId ??
    openConversations[0]?.convoId ??
    null;
  // A race is a comparison: both columns are on the canvas and both are where
  // you are, so the rail lights the route to every racer rather than to
  // whichever column the pointer last engaged. A racer's Run id *is* its
  // conversation id — the watch panels reattach to it — so this is right from
  // the moment the tabs exist, without waiting on a panel binding.
  const raceWatchConversationIds = raceWatchTabs.map((tab) => tab.runId);
  const railSelectedConversationId = focusBase
    ? focusChatActive && !focusConvoError
      ? railActiveConversationId ?? focusSelectedConvoId
      : focusSelectedConvoId
    : railActiveConversationId;
  const railSelectedConversationIds =
    raceWatchConversationIds.length > 0
      ? raceWatchConversationIds
      : railSelectedConversationId
        ? [railSelectedConversationId]
        : [];
  /* Focus: only while the canvas is actually showing them — on the hero home
     nothing is open, whatever the panels still hold, and during a race watch
     the racers are the only thing on the canvas. The workbench keeps its
     panels and adds the racers to them. */
  const railOpenConversationIds =
    focusBase && !focusChatActive
      ? []
      : focusBase && raceWatchConversationIds.length > 0
        ? raceWatchConversationIds
        : [
            ...new Set([
              ...openConversations.map((c) => c.convoId),
              ...raceWatchConversationIds,
            ]),
          ];

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

  // With the OS-level file-drop handler disabled (tauri.conf `dragDropEnabled:
  // false`), the webview handles drops itself — but a file dropped anywhere
  // *without* a handler makes the webview navigate to it, replacing the whole
  // app with the file full-screen. Swallow the default for file drags globally;
  // real drop targets (the AI panel) still receive their own event and ingest
  // the file first.
  useEffect(() => {
    const guard = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
    };
    window.addEventListener("dragover", guard);
    window.addEventListener("drop", guard);
    return () => {
      window.removeEventListener("dragover", guard);
      window.removeEventListener("drop", guard);
    };
  }, []);

  const [customLayouts, setCustomLayouts] = useState<LayoutPreset[]>(() =>
    loadCustomPresets()
  );
  const [gridLayouts, setGridLayouts] = useState<GridLayout[]>(() =>
    loadGridLayouts()
  );
  const [settingsInitial, setSettingsInitial] = useState<string | null>(null);
  // Let a background module (the conversation-cache quota toast) send the user
  // to a Settings section, without reaching into this component's state.
  useEffect(() => {
    registerSettingsOpener((section) => {
      setSettingsInitial(section);
      openOverlay("settings");
    });
    return () => registerSettingsOpener(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
  // Global default for "require diff review" (auto-accept off). Settings edits
  // this. Each AI panel keeps its own override in the fleet — toggling
  // auto-accept in one conversation must NOT leak into the others. A panel
  // with no entry falls back to the global default; in-memory only, so on
  // reload every panel reverts to the safe global default.
  const [requireDiffReview] = useSetting(SETTINGS.requireDiffReview);
  const reviewForPanel = (id: string) =>
    id in reviewOverrideByPanel ? reviewOverrideByPanel[id] : requireDiffReview;
  const setPanelReview = setPanelReviewOverride;
  // The full-auto rung's command half has no global default on purpose:
  // silencing the command permission gate is opted into per conversation and
  // reverts to prompting on reload.
  const commandsForPanel = (id: string) => commandsOverrideByPanel[id] ?? false;
  const setPanelCommands = setPanelCommandsOverride;
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
  // The resolved Surface: the union render branches on. Grid existence and
  // the anchored bit come from the world (a stored grid id may be dangling
  // after the grid was deleted in Settings — it resolves to anchored/free,
  // same as the old `find(...) ?? null` fallback).
  const activeGridId = surfaceCore.base.kind === "grid" ? surfaceCore.base.gridId : null;
  const surface = resolveSurface(surfaceCore, {
    workspaceOpen: workspaceRoot !== null,
    panelsAnchored: panelLayout.anchored !== false,
    gridExists: (id) => gridLayouts.some((g) => g.id === id),
  });
  const activeGrid =
    activeGridId != null
      ? gridLayouts.find((g) => g.id === activeGridId) ?? null
      : null;
  const effectiveGitReviewRoot = workspaceRoot;
  const activityState: Record<ActivityPanel, boolean> = {
    home: overlay === null,
    explorer: overlay === null && (explorerVisible || sidebarSlot2 === "explorer"),
    git: overlay === "git-review",
    memory: overlay === null && memoryVisible,
    skills: overlay === null && (skillsVisible || sidebarSlot2 === "skills"),
    ai: overlay === null && aiVisible,
    runs: overlay === "runs",
    orchestrator: overlay === "orchestrator",
    settings: overlay === "settings",
    profile: profileVisible,
  };

  function togglePanel(panel: ActivityPanel, meta?: boolean) {
    if (panel === "home") {
      // Home = back to the base surface from wherever you are (Mission
      // Control, Git, Settings, …). Leaving a project entirely is the
      // native Projects menu's job ("Welcome Screen" item), not this
      // button's — it never clears the workspace.
      back();
      return;
    }
    if (panel === "settings") {
      setSettingsInitial(null);
      openOverlay("settings");
      return;
    }
    if (panel === "profile") {
      setProfileVisible((cur) => !cur);
      return;
    }
    if (panel === "runs") {
      openOverlay("runs");
      return;
    }
    if (panel === "orchestrator") {
      openOverlay("orchestrator");
      return;
    }
    back();
    if (panel === "ai") {
      // From an overlay view (Mission Control, Settings) the AI icon
      // should always *show* the panel — toggling would hide it (the
      // closure still sees aiVisible=true from when the user left) and
      // the user has to click twice to make it reappear.
      if (overlay !== null) {
        setAiVisible(true);
        if (!panelLayout.ai || panelLayout.ai.length === 0) ensureAiRect();
        focusPanel(primaryPanelId);
      } else {
        // Always ensure the in-memory list is populated, even if the
        // persisted layout has it empty. The render path gates on both
        // `aiVisible` AND `aiPanels.length > 0` — a stale empty list
        // (left over from a previous session's misbehaviour) would
        // otherwise make the panel invisible after a toggle.
        if (aiPanels.length === 0) ensureAiRect();
        const willShow = !aiVisible;
        setAiVisible(willShow);
        if (willShow) focusPanel(primaryPanelId);
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
        // Coming back from an overlay view (Mission Control,
        // Orchestrator, Git Review) the icon should always *show* the
        // panel — its visibility state still reads `true` from before the
        // user left, so a plain toggle would hide it and they'd have to
        // click twice to get back. Mirrors the AI-panel behaviour above.
        const cameFromOtherView = overlay !== null;
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
    // Git is a dedicated full-window view, not a sidebar panel. (The `back()`
    // above already cleared the overlay, so from the rail this always opens
    // Git Review — it never toggles it off. Same net effect as the old
    // batched setView pair.)
    if (panel === "git") {
      toggleOverlay("git-review");
      return;
    }
    // Memory opens as a centered modal (like Skills) rather than a
    // sidebar — its list+detail layout needs the room.
    if (panel === "memory") {
      setMemoryVisible((cur) => !cur);
      return;
    }
  }

  // ── The rail ─────────────────────────────────────────────────────────
  // The workbench's half of the one sidebar. Focus assembles the same shapes
  // in FocusMode; between them, `nav` and where a conversation lands are the
  // only things the two shells' rails still differ in.

  /** Reveal the AI surface and put the focus on one panel. */
  function revealAiPanel(panelId: string) {
    back();
    if (aiPanels.length === 0) ensureAiRect();
    setAiVisible(true);
    focusPanel(panelId);
  }

  /** "New task". A panel holding no conversation is already a blank one, so
   *  reuse it; otherwise the task gets its own panel rather than displacing a
   *  conversation that may still be running. Over a canvas of floating panels
   *  a second panel *is* the new task. */
  function startWorkbenchTask() {
    if (!openConversations.some((c) => c.panelId === primaryPanelId)) {
      revealAiPanel(primaryPanelId);
      return;
    }
    back();
    setAiVisible(true);
    appendAiPanel();
  }

  /** "New task" on the Focus side: clear the canvas back to the start stage.
   *  `back()` first — the rail stands beside the full-window overlays (Git
   *  Review, Mission Control), so from one of those a new task that only reset
   *  Focus state would land under a screen still covering it. */
  function startFocusTask() {
    back();
    endFocusRaceWatch();
    setAiPanelCwd(aiPanels[0]?.id ?? "ai-main", undefined);
    setFocusChatActive(false);
  }

  /** Resume a conversation the rail's tree points at, into an AI panel. Focus
   *  does the same work against its own canvas (see `onOpenConversation` on
   *  <FocusMode>) — one set of rules, one surface each. */
  function openConversationInAiPanel(convo: Conversation) {
    // A conversation from another project's history brings its project along —
    // resuming it against the wrong workspace would point every tool at the
    // wrong tree.
    const legacyWorkspace = legacyAutoRunWorkspace(convo);
    // Legacy ordinary conversations were auto-isolated before that policy was
    // removed. Reopen those on the Workspace; intentional worktree
    // conversations stay pinned.
    const resumed = legacyWorkspace
      ? { ...convo, cwd: legacyWorkspace, branch: null, worktree: null }
      : convo;
    markFolderWorked(resumed.cwd);
    const owningWorkspace =
      linkedProjectForPath(resumed.cwd, recentFolders) ??
      canonicalWorkspaceRoot(resumed.cwd);
    if (owningWorkspace && owningWorkspace !== workspaceRoot) changeRoot(owningWorkspace);
    // Already open in a panel? Raise that one instead of loading a second copy
    // of the same conversation into another.
    const bound = openConversations.find((c) => c.convoId === convo.id);
    const panelId = bound?.panelId ?? primaryPanelId;
    setAiPanelCwd(panelId, legacyWorkspace ? undefined : convo.cwd ?? undefined);
    if (!bound) targetResume(panelId, resumed);
    revealAiPanel(panelId);
    offerRaceSplit(convo.id);
  }

  const railNav: RailNavItem[] = [
    {
      id: "new-task",
      label: "New task",
      icon: <NewTaskIcon size={15} />,
      onClick: () => startWorkbenchTask(),
    },
    {
      id: "git",
      label: "Git",
      icon: <GitIcon size={15} />,
      active: activityState.git,
      onClick: () => togglePanel("git"),
    },
    // No AI row. The rail's tree below is already the AI surface — it lists
    // every conversation and marks the open ones — so a row that only toggles
    // the panel holding them was the same idea stated twice. Showing and
    // hiding the panel lives in the command palette now, and every handoff
    // (Mission Control, a resumed conversation) reveals it on its own.
    {
      id: "runs",
      label: "Mission Control",
      icon: <MissionIcon size={15} />,
      active: activityState.runs,
      onClick: () => togglePanel("runs"),
    },
    {
      id: "orchestrator",
      label: "Orchestrator",
      icon: <OrchestratorIcon size={15} />,
      active: activityState.orchestrator,
      onClick: () => togglePanel("orchestrator"),
    },
    {
      id: "memory",
      label: "Memory",
      icon: <MemoryIcon size={15} />,
      active: activityState.memory,
      onClick: () => togglePanel("memory"),
    },
    {
      id: "skills",
      label: "Skills",
      icon: <SkillsIcon size={15} />,
      active: activityState.skills,
      onClick: (meta) => togglePanel("skills", meta),
    },
    {
      // Last row, and a disclosure rather than a destination: the tree unfolds
      // directly beneath it. It sits at the foot of the actions because that
      // is where it opens — a row whose chevron points at a region above the
      // rest of the list would be pointing at nothing.
      id: "explorer",
      label: "Explorer",
      icon: <FolderIcon size={15} />,
      active: activityState.explorer,
      onClick: (meta) => togglePanel("explorer", meta),
    },
  ];

  function clearFocusConvoNavigation() {
    setFocusSelectedConvoId(null);
    setFocusConvoError(null);
  }

  /** Focus's rows. The workbench's `railNav` above and this differ only where
   *  the two shells genuinely do: "New task" means a fresh canvas here and a
   *  fresh panel there, Mission Control is an overlay either way, and Focus has
   *  no Explorer row because it has no editor to open a file into. Everything
   *  else is the same destination reached the same way. */
  const focusRailNav: RailNavItem[] = [
    {
      id: "new-task",
      label: "New task",
      icon: <NewTaskIcon size={15} />,
      onClick: () => startFocusTask(),
    },
    {
      // Git Review is a full-window surface, not a panel, so Focus reaches the
      // very same one the workbench does. It earns its own row: the git island
      // carries the branch on the home screen but is gone the moment a
      // conversation is up, which in Focus is nearly always.
      id: "git",
      label: "Git",
      icon: <GitIcon size={15} />,
      active: activityState.git,
      onClick: () => togglePanel("git"),
    },
    {
      id: "runs",
      label: "Mission Control",
      icon: <MissionIcon size={15} />,
      active: activityState.runs,
      onClick: () => openOverlay("runs"),
    },
    {
      id: "orchestrator",
      label: "Orchestrator",
      icon: <OrchestratorIcon size={15} />,
      active: activityState.orchestrator,
      onClick: () => togglePanel("orchestrator"),
    },
    {
      id: "memory",
      label: "Memory",
      icon: <MemoryIcon size={15} />,
      active: activityState.memory,
      onClick: () => togglePanel("memory"),
    },
    {
      id: "skills",
      label: "Skills",
      icon: <SkillsIcon size={15} />,
      active: activityState.skills,
      // Skills is a modal here. togglePanel treats it as a sidebar view and
      // would collapse the free-mode explorer on the way, which Focus has no
      // business touching.
      onClick: () => setSkillsVisible((cur) => !cur),
    },
  ];

  function applyLayout(layout: {
    explorer: boolean;
    terminal: boolean;
    ai: boolean;
  }) {
    back();
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
    openOverlay("settings");
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
    function onMove(ev: MouseEvent) {
      // Left-edge drag: moving left grows the pane.
      setEditorDockWidth(Math.min(maxW, Math.max(420, startW - (ev.clientX - startX))));
    }
    beginDragSession({
      cursor: "col-resize",
      onMove,
    });
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
    function onMove(ev: MouseEvent) {
      const w = Math.min(
        PANEL_CONSTRAINTS.explorer.maxW,
        Math.max(PANEL_CONSTRAINTS.explorer.minW, startW + (ev.clientX - startX))
      );
      updatePanelRect("explorer", { ...explorerRect, w });
    }
    beginDragSession({
      cursor: "col-resize",
      onMove,
    });
  }

  /**
   * Drag the terminal drawer's top edge. `availableH` overrides what the 72%
   * ceiling is measured against: Focus never mounts the workbench, so
   * `workbenchSize` stays 0×0 there (see usePanelLayout) and the default bound
   * would collapse to the 160px floor. Its dock passes its own canvas height.
   */
  function beginTerminalDockResize(e: ReactMouseEvent<HTMLDivElement>, availableH?: number) {
    e.preventDefault();
    const startY = e.clientY;
    const startH = terminalRect.h;
    const bound = availableH && availableH > 0 ? availableH : workbenchSize.h;
    const maxH = Math.min(
      PANEL_CONSTRAINTS.terminal.maxH,
      Math.max(160, Math.round(bound * 0.72))
    );
    function onMove(ev: MouseEvent) {
      const h = Math.min(
        maxH,
        Math.max(PANEL_CONSTRAINTS.terminal.minH, startH - (ev.clientY - startY))
      );
      updatePanelRect("terminal", { ...terminalRect, h });
    }
    beginDragSession({
      cursor: "row-resize",
      onMove,
    });
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

  // A document a run produced, opened where it can actually be read: text in
  // the inspector, everything else — a deck, a PDF, a spreadsheet — in the
  // application the machine already opens it with. Klide renders none of
  // those, and a viewer for each would be a bigger thing than the card that
  // lists them.
  // A picture of a produced document for its row in the card. An image is
  // already one; a deck, a PDF or a spreadsheet is drawn by macOS through
  // Quick Look. Null is a normal answer — the row keeps its name and its size
  // and simply has no picture.
  // One complaint per file: the rail and the canvas both ask for the same
  // document, and two toasts for one failure is one too many.
  const previewFailures = useRef<Set<string>>(new Set());
  // The best picture seen for each document this session, so the viewer can
  // put the card's thumbnail on its canvas the instant it opens and swap it
  // for the sharp one when Quick Look has drawn it. Rust remembers the renders
  // themselves; this only knows which one to show first.
  const bestPictures = useRef<Map<string, { size: number; src: string }>>(new Map());
  const previewRunArtifact = useCallback(async (path: string, size = 900): Promise<string | null> => {
    const root = workspaceRoot;
    if (!root) return null;
    try {
      const src = await loadArtifactPreview(root, path, size);
      const best = bestPictures.current;
      const known = best.get(path);
      if (!known || known.size <= size) {
        best.delete(path);
        best.set(path, { size, src });
        if (best.size > BEST_PICTURES_KEPT) best.delete(best.keys().next().value as string);
      }
      return src;
    } catch (err) {
      // A file with no preview is normal and says so on the sheet. A preview
      // that *failed* is not: it looks identical to the reader, so the reason
      // is surfaced once — per file, not per thumbnail — instead of being
      // swallowed into the same empty sheet.
      const reason = errMessage(err);
      if (!previewFailures.current.has(path)) {
        previewFailures.current.add(path);
        notify(`No preview for ${path.split("/").pop()}: ${reason}`);
      }
      console.warn(`No preview for ${path}:`, reason);
      return null;
    }
  }, [workspaceRoot]);
  const placeholderPicture = useCallback((path: string) => bestPictures.current.get(path)?.src ?? null, []);

  // The document a reader opened, and the set its rail walks.
  const [documentViewer, setDocumentViewer] = useState<
    { path: string; documents: { path: string; bytes: number }[] } | null
  >(null);

  async function openRunArtifact(
    { runId, path, documents }: { runId: string; path: string; documents: { path: string; bytes: number }[] },
  ) {
    const root = workspaceRoot;
    if (!root) return;
    // Text is read properly in the inspector, with its own editor. A document
    // Klide cannot render opens in the viewer — reading it in the app beats
    // bouncing to Keynote for a look, and the viewer keeps a way out to the
    // real thing. Only a file with no picture at all still leaves straight
    // away, since there would be nothing to show.
    if (artifactOpensIn(path) === "inspector") {
      openArtifact({ kind: "file", runId, workspaceRoot: root, path });
      return;
    }
    if (artifactPreview(path) !== "none") {
      const set = documents.length > 0 ? documents : [{ path, bytes: 0 }];
      setDocumentViewer({ path, documents: set.filter((d) => artifactPreview(d.path) !== "none") });
      return;
    }
    await openArtifactExternally(path);
  }

  async function openArtifactExternally(path: string) {
    const root = workspaceRoot;
    if (!root) return;
    try {
      await openArtifactInApp(root, path);
    } catch (err) {
      notify(`Unable to open ${path}: ${errMessage(err)}`, { tone: "error" });
    }
  }

  async function reviewRunChanges({ runId, title, path }: { runId: string; title: string; path?: string }) {
    try {
      const checkpoints = await listCheckpoints(runId);
      const entries = path ? checkpoints.filter((entry) => entry.path === path) : checkpoints;
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
      pendingForPanel(panelId),
    );
    const { root, worktreeName } = panelWorkspace(
      panel,
      workspaceRoot,
      opts?.respectWorktree ?? true
    );
    return (
      <AiPanel
        key={conversationSessionKey(panelId, root, opts?.key, seatFor(panelId))}
        fill
        visible
        width={opts?.width ?? panel?.rect.w ?? 360}
        panelId={panelId}
        initialProvider={handoff.initialProvider}
        initialConversationId={handoff.initialConversationId}
        initialResumeSessionId={handoff.initialResumeSessionId}
        initialTask={handoff.initialTask}
        initialStartFresh={handoff.initialStartFresh}
        onInitialConsumed={
          handoff.matched ? () => consumeHandoff(panelId) : undefined
        }
        workspaceRoot={root}
        worktreeName={worktreeName}
        workspaceBranch={!worktreeName && root === workspaceRoot ? gitStatus?.branch ?? null : null}
        onOpenPeerConversation={(conversationId) => {
          // The peer link's card names another thread; land it exactly where a
          // click in the rail's tree would — raised if it is already open.
          const convo = loadConversations<Conversation>().find((c) => c.id === conversationId);
          if (!convo) return;
          if (focusBase) {
            setFocusSelectedConvoId(convo.id);
            setFocusConvoError(null);
            openFocusConversation(convo, "primary");
            return;
          }
          openConversationInAiPanel(convo);
        }}
        onFileWritten={onAgentWrote}
        // Focus reviews in its own column, so it offers no route into the
        // docked inspector it does not render.
        onReviewChanges={opts?.variant === "focus" ? undefined : (info) => void reviewRunChanges(info)}
        onOpenArtifact={(info) => void openRunArtifact(info)}
        onPreviewArtifact={previewRunArtifact}
        onWorkspaceChanged={() => {
          // A worktree-pinned panel changes its own branch, not the main
          // checkout — only refresh the sidebar git status when the panel
          // runs in the global workspace.
          if (!worktreeName && root) refreshGitStatus(root);
        }}
        model={model}
        onModelChange={(m) => updateAiPanelModel(panelId, m)}
        // The Focus hero edits this same panel's provider+model pair while the
        // panel is mounted behind it. The model has always been a live prop;
        // the provider has to be one too, or a hero pick pushes one provider's
        // model into a session still on another.
        provider={panel?.provider}
        onProviderChange={(provider) => setAiPanelProvider(panelId, provider)}
        onOpenSettingsSection={(section) => {
          setSettingsInitial(section);
          openOverlay("settings");
        }}
        availableModels={modelsByPanel[panelId] ?? [model]}
        onAvailableModelsChange={(models) => reportPanelModels(panelId, models)}
        apiKeyVersion={apiKeyVersion}
        requireDiffReview={reviewForPanel(panelId)}
        onRequireDiffReviewChange={(v) => setPanelReview(panelId, v)}
        autoApproveCommands={commandsForPanel(panelId)}
        onAutoApproveCommandsChange={(v) => setPanelCommands(panelId, v)}
        onOpenDiff={setDiffView}
        stopAfterRejection={stopAfterRejection}
        skills={skills}
        harnessSettings={harnessSettings}
        onDuplicate={
          opts?.duplicatable
            ? (snapshot) => admit({ kind: "fresh", ...snapshot })
            : undefined
        }
        onForkConversationInWorktree={forkConversationInWorktree}
        onClose={opts?.closable ? () => release(panelId) : undefined}
        resumeConversation={resumeConversationFor(panelId, resumeTarget)}
        onResumeConsumed={() => consumeResume(panelId)}
        variant={opts?.variant}
        initialMessage={opts?.initialMessage ?? null}
        initialAttachments={opts?.initialAttachments ?? null}
        onInitialMessageConsumed={() => {
          setFocusInitialMessage(null);
          setFocusInitialAttachments([]);
        }}
        followUpMessage={followUpsByPanel[panelId] ?? null}
        onFollowUpConsumed={() => consumeFollowUp(panelId)}
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

  /** Accept a conversation dropped onto one half of the Focus canvas. The
   *  drop carries only an id — the stored conversation is resolved here, and a
   *  row whose messages never made it to disk is refused out loud rather than
   *  opening an empty panel. */
  function openDroppedConversation(target: "primary" | "split", conversationId: string) {
    const convo = loadConversations<Conversation>().find(
      (c) => c.id === conversationId && Array.isArray(c.msgs)
    );
    if (!convo) {
      notify("That conversation is no longer in local history.", { tone: "warn" });
      return;
    }
    openFocusConversation(convo, target);
  }

  /** Resume a stored conversation into one half of the Focus canvas — the one
   *  path for a rail click, a ⌘P-style navigation, and a drop. A conversation
   *  carries the project it ran in: resuming it against the wrong tree would
   *  point every tool at the wrong files.
   *
   *  Which half it lands in changes what "bring its project along" means. The
   *  main half IS the app's workspace, so it switches the workspace. The split
   *  half is one panel, so it pins itself to the conversation's directory
   *  instead and leaves the other half — and the rest of the app — where they
   *  were. Two conversations side by side are allowed to come from two
   *  projects. */
  function openFocusConversation(convo: Conversation, target: "primary" | "split") {
    endFocusRaceWatch();
    // Legacy ordinary conversations were auto-isolated before that policy was
    // removed. Reopen those on the Workspace; intentional worktree
    // conversations stay pinned.
    const legacyWorkspace = legacyAutoRunWorkspace(convo);
    const resumedConvo = legacyWorkspace
      ? { ...convo, cwd: legacyWorkspace, branch: null, worktree: null }
      : convo;
    markFolderWorked(resumedConvo.cwd);
    const pinnedCwd = legacyWorkspace ? undefined : convo.cwd ?? undefined;
    if (target === "split") {
      openFocusSplit(resumedConvo, pinnedCwd);
      setFocusChatActive(true);
      return;
    }
    const owningWorkspace =
      linkedProjectForPath(resumedConvo.cwd, recentFolders) ??
      canonicalWorkspaceRoot(resumedConvo.cwd);
    if (owningWorkspace && owningWorkspace !== workspaceRoot) {
      changeRoot(owningWorkspace);
    }
    setAiPanelCwd(primaryPanelId, pinnedCwd);
    targetResume(primaryPanelId, resumedConvo);
    setFocusChatActive(true);
    offerRaceSplit(convo.id);
  }

  /** The drop plumbing every Focus half shares. `dragover` must preventDefault
   *  for the drop to be allowed at all, and it is also the only moment the
   *  browser lets us ask *what* is being dragged — hence the types check
   *  rather than a payload read. */
  function focusPaneDropProps(target: "primary" | "split") {
    return {
      onDragOver: (e: ReactDragEvent) => {
        if (!isConversationDrag(e.dataTransfer)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      },
      onDragEnter: (e: ReactDragEvent) => {
        if (isConversationDrag(e.dataTransfer)) setFocusDropTarget(target);
      },
      onDragLeave: (e: ReactDragEvent) => {
        // Moving onto a child fires `dragleave` on the parent; only a pointer
        // that has actually left the pane clears the highlight.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setFocusDropTarget((current) => (current === target ? null : current));
      },
      onDrop: (e: ReactDragEvent) => {
        const id = readConversationDrag(e.dataTransfer);
        setFocusDropTarget(null);
        if (!id) return;
        e.preventDefault();
        openDroppedConversation(target, id);
      },
    };
  }

  /** The Focus canvas. One conversation, two side by side, or the race strip's
   *  tabs — always the same fully wired AiPanel, never a reader copy, and
   *  always mounted: run subscriptions are mount-tied, so a half you are not
   *  looking at must still be in the tree to keep streaming.
   *
   *  The canvas carries no split affordance of its own. A split is opened by
   *  dragging a conversation onto it or with ⌘N, and killed with ⌘W — three
   *  gestures, no chrome added to the calm screen. */
  function renderFocusChat(): ReactNode {
    if (raceWatchTabs.length > 0) {
      // Race watch: the racers sit side by side in the same split idiom the
      // two-conversation canvas uses — a race is a comparison, and a
      // comparison you can only see one half of at a time isn't one. Every
      // panel stays mounted (run subscriptions are mount-tied); clicking into
      // a column selects it, so the rail accent and follow-up routing track
      // the column you are actually in. Two racers share the draggable seam
      // and its remembered ratio; a wider field falls back to equal columns.
      const activeId = focusActiveTabId ?? raceWatchTabs[0].panelId;
      const twoUp = raceWatchTabs.length === 2;
      const engageRacePane = (panelId: string) => {
        if (focusActiveTabId !== panelId) selectRaceTab(panelId);
        if (focusedPanel !== panelId) focusPanel(panelId);
      };
      return (
        <div
          ref={focusSplitRowRef}
          className="klide-focus-split-row"
          data-resizing={focusSplitResizing || undefined}
          style={{ position: "relative" }}
        >
          <RacePilotBox
            agents={raceWatchTabs.length}
            onAsk={sendRaceFollowUp}
            onEnd={() => {
              endFocusRaceWatch();
              setFocusChatActive(false);
            }}
          />
          {raceWatchTabs.map((t, index) => {
            const basis = twoUp
              ? (index === 0 ? focusSplitRatio : 1 - focusSplitRatio) * 100
              : 100 / raceWatchTabs.length;
            const active = t.panelId === activeId;
            return (
              <Fragment key={t.panelId}>
                {index > 0 && (
                  <div
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={twoUp ? "Resize the race split" : undefined}
                    className="klide-focus-split-divider"
                    data-shown
                    style={twoUp ? undefined : { cursor: "default" }}
                    onMouseDown={
                      twoUp
                        ? () => {
                            const row = focusSplitRowRef.current;
                            if (!row) return;
                            setFocusSplitResizing(true);
                            beginDragSession({
                              cursor: "col-resize",
                              onMove: (e) => {
                                const box = row.getBoundingClientRect();
                                if (box.width <= 0) return;
                                const next = Math.min(
                                  0.75,
                                  Math.max(0.25, (e.clientX - box.left) / box.width)
                                );
                                setFocusSplitRatio(next);
                              },
                              onDone: () => {
                                setFocusSplitResizing(false);
                                try {
                                  localStorage.setItem(
                                    "klide.focus.splitRatio",
                                    String(focusSplitRatioRef.current)
                                  );
                                } catch {
                                  /* storage unavailable */
                                }
                              },
                            });
                          }
                        : undefined
                    }
                  />
                )}
                <div
                  className="klide-focus-split-pane"
                  data-shown
                  style={{
                    flexBasis: `${basis}%`,
                    display: "flex",
                    flexDirection: "column",
                    overflow: "hidden",
                  }}
                  onMouseDownCapture={() => engageRacePane(t.panelId)}
                >
                  {/* Column head — the label the tab used to carry, now naming
                      what's below it, plus a live/settled word. The selected
                      column's label is the only selection marker: weight and
                      ink, never a pill. */}
                  <RacePaneHead
                    label={t.label}
                    runId={t.runId}
                    provider={t.provider}
                    active={active}
                  />
                  {/* The AI surface sizes itself `height: 100%`, which inside
                      this column would ignore the head above it and clip the
                      composer's foot off the bottom — give it the remaining
                      height to be 100% of instead. */}
                  <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
                    {renderAiPanel(aiPanels.find((p) => p.id === t.panelId), {
                      key: `focus-${t.panelId}`,
                      variant: "focus",
                      respectWorktree: true,
                    })}
                  </div>
                </div>
              </Fragment>
            );
          })}
        </div>
      );
    }
    const splitPanel = focusSplitPanelId
      ? aiPanels.find((p) => p.id === focusSplitPanelId)
      : undefined;
    // Dragging a conversation over an unsplit canvas opens the seam *while you
    // drag*: the conversation you are in gives up exactly the width the second
    // one will take, so the drop lands where the preview already is. Dropping
    // means "beside" — it is the whole point of the gesture, and a drop that
    // replaced what you were reading would be the one thing you cannot undo.
    const previewing = focusConversationDrag && !splitPanel;
    const opened = splitPanel !== undefined && focusSplitShown;
    const primaryBasis = opened || previewing ? focusSplitRatio * 100 : 100;
    // Clicking into a half is selecting it. The rail's accent route follows
    // `focusedPanel`, and with two conversations up it must mean the one you
    // are actually in — admission alone would leave it stuck on whichever half
    // opened last. Capture-phase so the composer/scroll clicks inside count.
    const engageFocusPane = (panelId: string) => {
      if (focusedPanel !== panelId) focusPanel(panelId);
    };
    return (
      <div
        ref={focusSplitRowRef}
        className="klide-focus-split-row"
        data-resizing={focusSplitResizing || undefined}
        {...(splitPanel ? {} : focusPaneDropProps("split"))}
      >
        <div
          key="focus-pane-primary"
          className="klide-focus-split-pane"
          data-drop-target={focusDropTarget === "primary" || undefined}
          style={{ flexBasis: `${primaryBasis}%` }}
          onMouseDownCapture={() => engageFocusPane(primaryPanelId)}
          {...(splitPanel ? focusPaneDropProps("primary") : {})}
        >
          {renderPanel("ai", "focus-ai", { aiVariant: "focus" })}
        </div>
        {splitPanel ? (
          <>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize the split"
              className="klide-focus-split-divider"
              data-shown={opened || undefined}
              onMouseDown={() => {
                const row = focusSplitRowRef.current;
                if (!row) return;
                setFocusSplitResizing(true);
                beginDragSession({
                  cursor: "col-resize",
                  onMove: (e) => {
                    const box = row.getBoundingClientRect();
                    if (box.width <= 0) return;
                    const next = Math.min(
                      0.75,
                      Math.max(0.25, (e.clientX - box.left) / box.width)
                    );
                    setFocusSplitRatio(next);
                  },
                  onDone: () => {
                    setFocusSplitResizing(false);
                    try {
                      localStorage.setItem(
                        "klide.focus.splitRatio",
                        String(focusSplitRatioRef.current)
                      );
                    } catch {
                      /* storage unavailable */
                    }
                  },
                });
              }}
            />
            <div
              key="focus-pane-split"
              className="klide-focus-split-pane klide-focus-split-pane--second"
              data-drop-target={focusDropTarget === "split" || undefined}
              data-shown={opened || undefined}
              style={{ flexBasis: `${opened ? (1 - focusSplitRatio) * 100 : 0}%` }}
              onMouseDownCapture={() => engageFocusPane(splitPanel.id)}
              {...focusPaneDropProps("split")}
            >
              {renderAiPanel(splitPanel, {
                key: `focus-${splitPanel.id}`,
                variant: "focus",
                respectWorktree: true,
              })}
              {/* Focus hides the AI panel's own header, so the half needs a way
                  out that isn't a keystroke. The app's own close mark from
                  icons.tsx — one vocabulary, one weight — sitting where that
                  header's close would have been. */}
              <button
                type="button"
                className="klide-focus-split-close"
                aria-label="Close this conversation"
                title="Close this half — the run keeps going (⌘W)"
                onClick={() => closeFocusSplit()}
              >
                <CloseIcon size={14} />
              </button>
            </div>
          </>
        ) : (
          previewing && (
            /* Where it will land. Not a drop target of its own — the whole
               canvas is one, and this is the shape the drop takes. */
            <div
              className="klide-focus-split-ghost"
              aria-hidden="true"
              data-drop-target={focusDropTarget === "split" || undefined}
              style={{ flexBasis: `${(1 - focusSplitRatio) * 100}%` }}
            >
              <span>Open beside</span>
            </div>
          )
        )}
      </div>
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
            {active?.dataUri ? (
              <ImageView src={active.dataUri} name={active.path} />
            ) : (
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
            )}
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
          initialAttachments:
            opts?.aiVariant === "focus" ? focusInitialAttachments : null,
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
  // full-screen overlay (settings/git/etc.) so the Welcome derivation in
  // resolveSurface actually fires (Settings is the one overlay that would
  // keep showing without a workspace).
  function closeFolder() {
    back();
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

  // ── Native macOS menu: recents ──────────────────────────────────────
  // Rust owns the whole menu; this only hands it the current recents so the
  // File ▸ Open Recent and Projects lists stay in step, and the active project
  // keeps its checkmark. Clicks come back as `menu:open-project`.
  //
  // This used to build the submenu here and attach it with
  // `Menu.default().append(...).setAsAppMenu()` — but `Menu.default()` is
  // Tauri's *stock* menu, whose File submenu is nothing but Close Window. Every
  // rebuild therefore replaced Rust's menu wholesale, which is why File, Edit
  // and View had lost everything except Close Window.
  useEffect(() => {
    invoke("menu_sync_projects", {
      projects: recentFolders,
      active: workspaceRoot,
    }).catch((e) => {
      notify(`Projects menu unavailable: ${e instanceof Error ? e.message : String(e)}`, {
        tone: "warn",
      });
    });
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

  function eventsToTitle(events: AgentEvent[]): string {
    const first = events.find((e) => e.type === "user_message");
    if (first && first.type === "user_message") return first.text.slice(0, 120);
    return "Resumed run";
  }

  async function resumeKlideRun(runId: string) {
    try {
      const events = await readAgentRunEvents(runId);
      const convo = eventsToConversation(events, runId, eventsToTitle(events));
      // Open one fresh panel and land the resumed run in it — never broadcast
      // to existing panels. The fleet reveals the workbench AI surface and
      // de-dupes by run id: re-clicking Resume focuses the existing panel
      // instead of piling up identical ones.
      admit({ kind: "resume-run", runId, convo });
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
      // A delegate's tool rows say which CLI ran them; a Klide run's tools
      // went through the harness and carry no such disclaimer.
      msgs: runMessagesToMsgs(messages, isDelegateId(run.source) ? run.source : undefined),
      updatedAt: Date.now(),
      provider,
      model: run.model,
      cwd,
      branch: gitMeta?.branch ?? null,
      worktree: gitMeta?.worktree ?? null,
    };
  }

  function openForkedConversation(convo: Conversation) {
    // The forked conversation carries its own provider, model, and worktree
    // pin — the fleet seeds the fresh panel from it.
    admit({ kind: "fork", convo });
  }

  async function forkRun(run: Run, preloadedMessages?: MissionRunMessage[]) {
    try {
      const messages = preloadedMessages ?? await fetchRunMessages(run);
      if (messages.length === 0) {
        setFileNotice("Run has no readable messages to fork.");
        return;
      }
      openForkedConversation(forkConversationFromRun(run, messages, run.cwd, {
        branch: run.branch,
        worktree: run.worktree,
      }));
      setFileNotice(`Forked "${run.title}" into a new Klide conversation.`);
    } catch (e) {
      setFileNotice(e instanceof Error ? e.message : String(e));
    }
  }

  // "Continue in Focus" — the chat-first answer to a delegate CLI's own
  // `/resume`. The interactive session is a terminal and Focus hosts none, so
  // this carries the *conversation* across instead: the run's transcript
  // becomes a Klide thread pinned to the same agent, and the next turn runs
  // that CLI headless with the whole history folded into its prompt
  // (`delegate/chat.rs`). Continuity of the transcript, not of the CLI's own
  // session — the agent starts fresh underneath and reads the thread.
  async function continueRunInFocus(run: Run, preloadedMessages?: MissionRunMessage[]) {
    try {
      const messages = preloadedMessages ?? await fetchRunMessages(run);
      if (messages.length === 0) {
        setFileNotice("Run has no readable messages to continue.");
        return;
      }
      // The agent that produced the run keeps producing it: a CLI run
      // continues on its own delegate, a Klide run on the provider it ran on.
      const provider =
        run.source === "klide"
          ? (run.provider as ProviderId | undefined)
          : isDelegateId(run.source)
            ? (run.source as ProviderId)
            : undefined;
      admit({
        kind: "focus-resume",
        convo: {
          ...forkConversationFromRun(run, messages, run.cwd, {
            branch: run.branch,
            worktree: run.worktree,
          }),
          // Not a fork: this thread *is* the run, carried to another surface.
          title: run.title,
          forkedFrom: null,
          provider,
        },
      });
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
      const wt = await gitWorktreeAdd(baseRoot, branch);
      openForkedConversation(forkConversationFromRun(run, messages, wt.path, {
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
      const wt = await gitWorktreeAdd(root, branch);
      const forked: Conversation = {
        ...convo,
        cwd: wt.path,
        branch: wt.branch,
        worktree: worktreeName(wt),
        updatedAt: Date.now(),
      };
      admit({ kind: "fork", convo: forked });
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
    // A race resolves as a unit: merging the winner discards the losing
    // siblings. Outside a race a worktree run is standalone — merge, then tear
    // down its own checkout so a resolved run never lingers as an orphan.
    const race = raceForRun(run.id);
    const losers = race
      ? race.members.filter((m) => m.branch !== run.branch)
      : [];
    const confirmMsg = race
      ? losers.length > 0
        ? `Merge ${run.branch} into the main checkout, then discard the ${losers.length} losing worktree${losers.length === 1 ? "" : "s"} and end the race? This can't be undone.`
        : `Merge ${run.branch} into the main checkout and clear the race?`
      : `Merge ${run.branch} into the main checkout, then remove its worktree?`;
    if (!confirm(confirmMsg)) return;
    try {
      const msg = await gitWorktreeMerge(workspaceRoot, run.branch);
      // Teardown is best-effort and post-merge: the work is already in main, so
      // a cleanup hiccup must not read as a failed merge. Collect what we
      // couldn't remove and report it alongside the success.
      const failures: string[] = [];
      const removeWorktree = async (path: string, branch: string, force: boolean) => {
        try {
          await gitWorktreeRemove(workspaceRoot, path, { force, deleteBranch: branch });
        } catch (e) {
          failures.push(`${branch}: ${e instanceof Error ? e.message : String(e)}`);
        }
      };
      if (race) {
        // Winner: its work is committed + merged, so a non-force removal
        // succeeds and refuses only if there's genuinely unmerged work left.
        const winner = race.members.find((m) => m.branch === run.branch);
        if (winner) await removeWorktree(winner.worktreePath, winner.branch, false);
        // Losers are discarded by the operator's choice — force past their
        // uncommitted work.
        for (const loser of losers) await removeWorktree(loser.worktreePath, loser.branch, true);
        removeRace(race.id);
      } else if (run.cwd) {
        await removeWorktree(run.cwd, run.branch, false);
      }
      await refreshGitStatus(workspaceRoot);
      setFileNotice(
        failures.length > 0
          ? `${msg} Cleanup incomplete — ${failures.join("; ")}`
          : race
          ? `${msg} Race resolved and worktrees cleaned up.`
          : `${msg} Worktree removed.`,
      );
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
    admit({
      kind: "handoff",
      provider: opts.provider,
      resumeSessionId: opts.resumeSessionId ?? null,
      initialTask: opts.initialTask ?? null,
      cwd: opts.cwd,
    });
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
    // The fleet de-dupes by conversation id: a panel already bound to this
    // live PTY (the one that spawned it, or an earlier reattach) is focused
    // instead of opening a second terminal that would mirror it — the "two
    // synchronized terminals" bug.
    admit({
      kind: "reattach",
      provider: opts.provider,
      conversationId: opts.conversationId,
      resumeSessionId: opts.resumeSessionId ?? null,
      cwd: opts.workspaceRoot ?? undefined,
    });
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
    const margin = 12;
    const gap = 12;
    const splitW = Math.max(320, Math.floor((workbenchSize.w - margin * 2 - gap) / 2));
    const splitH = Math.max(320, workbenchSize.h - margin * 2);
    admit({
      kind: "race-watch",
      focusActive: focusBase,
      racers: members.map((m, i) => ({
        runId: m.runId,
        provider: m.provider as ProviderId,
        model: m.model,
        cwd: m.worktreePath,
        label: modelLabel(m.model),
        // Two racers split the workbench half/half; a partial race (one
        // survivor) or >2 members fall back to the cascade placement.
        rect:
          !focusBase && members.length === 2
            ? { x: margin + i * (splitW + gap), y: margin, w: splitW, h: splitH }
            : undefined,
      })),
    });
    if (focusBase) {
      setFocusChatActive(true);
    } else {
      // Two side-by-side panels need the free (floating) layout — the
      // anchored column has one AI slot. This is a panel-geometry move, not
      // a surface change (a grid base deliberately stays a grid, as before).
      setAnchoredLayout(false);
      if (!aiVisible) togglePanel("ai");
    }
  }

  // One follow-up, every racer: queue the same text for each watched panel.
  // Each AiPanel sends it into its own conversation — and if that racer's
  // run is still streaming, the turn waits in its queue instead of racing it.
  function sendRaceFollowUp(text: string) {
    queueRaceFollowUp(text);
  }

  // Leave the Focus race-tab view: release the racers' panels (the runs keep
  // going headless in Rust and stay visible on the Mission Control board)
  // and return the canvas to the normal single-conversation chat. `release`
  // clears every queue keyed by each panel id — including its unconsumed
  // handoff, which the old close-per-tab path leaked.
  function endFocusRaceWatch() {
    // Callers invoke this defensively before opening something else — only an
    // actually-watched race earns the goodbye toast.
    if (raceWatchTabs.length === 0) return;
    endRaceWatch();
    // The runs keep going headless — tell the user where the way back is.
    notify("Race keeps running — reopen the split from Mission Control.", {
      tone: "info",
    });
  }

  /** Opening one racer's conversation on its own: offer the whole comparison
   *  back. The toast carries the reopen action itself, so the split is one
   *  click away instead of a trip through Mission Control. */
  function offerRaceSplit(convoId: string) {
    const group = raceForRun(convoId);
    if (!group || group.members.length < 2) return;
    notify(`This run raced ${group.members.length - 1 === 1 ? "another agent" : `${group.members.length - 1} other agents`} on the same task.`, {
      tone: "info",
      action: { label: "Open split view", run: () => watchRace(group) },
    });
  }

  // Split the Focus canvas in two. The second half is an ordinary fleet panel
  // (appended directly rather than through `admit`, whose reveal ritual is for
  // panels arriving into the *workbench*), so it carries its own provider,
  // model, history and composer. Closing the split releases it — the run it
  // was watching keeps going in Rust and stays on the Mission Control board,
  // the same contract "End watch" honours for a race.
  function openFocusSplit(convo?: Conversation, cwd?: string) {
    if (focusSplitPanelId) {
      // An empty call is "make sure the split is open" — ⌘N and the rail
      // toggle both mean that, and neither may repoint a half that already
      // holds a conversation.
      if (convo) {
        setAiPanelCwd(focusSplitPanelId, cwd);
        targetResume(focusSplitPanelId, convo);
      }
      return focusSplitPanelId;
    }
    const primary = aiPanels[0];
    const panelId = appendAiPanel({
      provider: convo?.provider ?? primary?.provider,
      model: convo?.model ?? primary?.model,
      // Seeded at creation rather than pinned after: the panel's workspace is
      // part of its Conversation session key, so setting it afterwards would
      // remount the half the moment it appeared.
      cwd: convo ? cwd : primary?.cwd,
    });
    setFocusSplitPanelId(panelId);
    if (convo) targetResume(panelId, convo);
    return panelId;
  }

  function closeFocusSplit() {
    if (!focusSplitPanelId) return;
    release(focusSplitPanelId);
    setFocusSplitPanelId(null);
  }

  // The split half can also be closed from its own panel chrome, or released
  // with the fleet — the canvas must not keep pointing at a panel that is
  // gone.
  useEffect(() => {
    if (focusSplitPanelId && !aiPanels.some((p) => p.id === focusSplitPanelId)) {
      setFocusSplitPanelId(null);
    }
  }, [aiPanels, focusSplitPanelId]);

  // Open an existing worktree (from the Worktrees modal) in a fresh AI panel
  // pinned to its path — same pin mechanism as newWorktreeRun, no new branch.
  function openExistingWorktree(path: string) {
    admit({ kind: "fresh", cwd: path });
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
      const wt = await gitWorktreeAdd(workspaceRoot, name);
      admit({ kind: "fresh", cwd: wt.path });
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
      const msgs = runMessagesToMsgs(messages);
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
    if (id === DEFAULT_AI_PANEL_ID) setAiModel(model);
  }

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // Grids are edited in Settings; refresh App's copy when returning to the
  // base surface so the status-bar Layout picker shows the latest.
  useEffect(() => {
    if (overlay === null) setGridLayouts(loadGridLayouts());
  }, [overlay]);

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

  // Navigation must not reshuffle the project rail. A newly discovered folder
  // is appended; actual task activity promotes it through `markFolderWorked`.
  useEffect(() => {
    if (!workspaceRoot) return;
    setRecentFolders((prev) => {
      const owningProject =
        linkedProjectForPath(workspaceRoot, prev) ?? canonicalWorkspaceRoot(workspaceRoot);
      const next = rememberOpenedFolder(prev, owningProject);
      if (next === prev) return prev;
      try {
        localStorage.setItem("klide.recentFolders", JSON.stringify(next));
      } catch {
        /* storage unavailable — skip */
      }
      return next;
    });
  }, [workspaceRoot]);

  function markFolderWorked(path: string | null | undefined) {
    if (!path) return;
    setRecentFolders((prev) => {
      const owningProject = linkedProjectForPath(path, prev) ?? canonicalWorkspaceRoot(path);
      if (!owningProject) return prev;
      const next = promoteWorkedFolder(prev, owningProject);
      if (next === prev) return prev;
      try {
        localStorage.setItem("klide.recentFolders", JSON.stringify(next));
      } catch {
        /* storage unavailable — skip */
      }
      return next;
    });
  }

  // Let the backend know which folder is open, so `${VAR}` token references
  // resolve from this project's `.env`. The first value is always `null` —
  // the boot restore lands a tick later — and sending that would clear a
  // root the backend already knows (a window reload leaves runs alive in
  // Rust), so hold the clear until a root has actually been announced.
  const announcedRootRef = useRef(false);
  useEffect(() => {
    if (!workspaceRoot && !announcedRootRef.current) return;
    if (workspaceRoot) announcedRootRef.current = true;
    void invoke("set_active_workspace", { root: workspaceRoot }).catch(() => {
      /* command unavailable (non-Tauri preview) — ignore */
    });
  }, [workspaceRoot]);

  // Interactive delegate PTY (Claude Code / Codex / OpenCode) edits files
  // outside the harness's FileChanged event stream, so the file watcher is
  // the only other path that refreshes git status. Refresh explicitly on
  // session exit so the sidebar decorations update the moment the user
  // finishes an interactive run.
  useEffect(() => {
    if (!workspaceRoot || !("__TAURI_INTERNALS__" in window)) return;
    const listeners = createListenerScope();
    listeners.add(onDelegateExit(() => {
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
        overlay === null &&
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
      // Fold the sidebar. Written straight to the store rather than through a
      // `useSetting` binding: the rail (in either shell) subscribes to the same
      // setting, so this handler needs no state of its own and no new dep here.
      if (mod && !e.shiftKey && e.key === "b") {
        e.preventDefault();
        setSetting(SETTINGS.railCollapsed, !getSetting(SETTINGS.railCollapsed));
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
      // ⌘W closes what is in front of you. Focus has no editor tabs, so there
      // it means the second conversation — the counterpart to ⌘N, and the only
      // way to close a half now that the canvas carries no chrome.
      if (mod && !e.shiftKey && e.key === "w" && focusBase && overlay === null && focusSplitPanelId) {
        e.preventDefault();
        closeFocusSplit();
        return;
      }
      if (mod && !e.shiftKey && e.key === "w" && tabs.length > 0) {
        e.preventDefault();
        closeTab(activeIdx >= 0 ? activeIdx : 0);
        return;
      }
      if (mod && !e.shiftKey && e.key === ",") {
        e.preventDefault();
        openOverlay("settings");
        return;
      }
      if (mod && !e.shiftKey && e.key === ".") {
        e.preventDefault();
        setProfileVisible((v) => !v);
        return;
      }
      if (mod && !e.shiftKey && e.key === "n") {
        e.preventDefault();
        // ⌘N means "the other one": in the workbench that is the editor you
        // came from, and in Focus — which has no editor — it is a second
        // conversation beside the one you are in. Already split, it does
        // nothing: ⌘N never takes a conversation away.
        if (focusBase && overlay === null && focusChatActive) {
          if (!focusSplitPanelId) openFocusSplit();
          return;
        }
        back();
        return;
      }
      if (mod && e.shiftKey && e.key === "G") {
        e.preventDefault();
        toggleOverlay("git-review");
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
      // Escape — close palette, search, or return to the base surface from an overlay
      if (e.key === "Escape") {
        if (shortcutsOpen) { setShortcutsOpen(false); return; }
        if (paletteOpen) { setPaletteOpen(false); return; }
        if (searchVisible) { setSearchVisible(false); return; }
        if (overlay !== null) {
          e.preventDefault();
          back();
          return;
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, activeIdx, tabs, saveActive, paletteOpen, searchVisible, overlay, explorerVisible, terminalVisible, aiVisible, shortcutsOpen, focusBase, focusChatActive, focusSplitPanelId, aiPanels]);

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
      openOverlay("settings");
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
    listeners.add(listen("menu:save", () => {
      saveActive();
    }));
    listeners.add(listen("menu:welcome-screen", () => {
      closeFolder();
    }));
    // Fired by both File ▸ Open Recent and the Projects menu; Rust strips the
    // id prefix and sends the path.
    listeners.add(listen<string>("menu:open-project", (event) => {
      if (event.payload) changeRoot(event.payload);
    }));
    return listeners.dispose;
  }, [activeIdx, tabs, saveActive]);

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
    // The rail no longer carries an AI row, so this is the way to put the panel
    // away and get it back by hand.
    { id: "ai-toggle", label: "View: Toggle AI Panel", action: () => { togglePanel("ai"); setPaletteOpen(false); } },
    { id: "settings", label: "Preferences: Open Settings", shortcut: "⌘,", action: () => { openOverlay("settings"); setPaletteOpen(false); } },
    { id: "profile", label: "View: Open Profile", shortcut: "⌘.", action: () => { setProfileVisible(true); setPaletteOpen(false); } },
    { id: "theme", label: "Appearance: Toggle Theme", action: () => { setTheme((t) => getNextThemeId(t)); setPaletteOpen(false); } },
    { id: "word-wrap", label: "Editor: Toggle Word Wrap", action: () => { setEditorWordWrap((v) => !v); setPaletteOpen(false); } },
    { id: "line-numbers", label: "Editor: Toggle Line Numbers", action: () => { setEditorLineNumbers((v) => !v); setPaletteOpen(false); } },
    { id: "minimap", label: "Editor: Toggle Minimap", action: () => { setEditorMinimap((v) => !v); setPaletteOpen(false); } },
    { id: "layout-anchored", label: "Layout: Anchored (IDE)", action: () => { enterWorkbench("anchored"); setPaletteOpen(false); } },
    { id: "layout-free", label: "Layout: Free (floating panels)", action: () => { enterWorkbench("free"); setPaletteOpen(false); } },
    { id: "layout-focus", label: "Layout: Focus (chat)", action: () => { enterFocus(); setPaletteOpen(false); } },
    { id: "terminal-focus", label: "Terminal: Open in Focus", action: () => { setFocusTerminalOpen(true); setTerminalVisible(false); enterFocus(); setPaletteOpen(false); } },
    { id: "runs", label: "View: Mission Control", action: () => { openOverlay("runs"); setPaletteOpen(false); } },
    { id: "orchestrator", label: "View: Orchestrator", action: () => { openOverlay("orchestrator"); setPaletteOpen(false); } },
    { id: "back-to-workbench", label: "View: Back to Workbench", shortcut: "Esc", action: () => { back(); setPaletteOpen(false); } },
    { id: "git-review", label: "View: Git Review", shortcut: "⌘⇧G", action: () => { toggleOverlay("git-review"); setPaletteOpen(false); } },
    { id: "create-pr", label: "Git: Create Pull Request…", action: () => { setPaletteOpen(false); void (async () => { try { const pr = await createPr(workspaceRoot, "Klide changes", null); setFileNotice(`PR: ${pr}`); } catch(e) { setFileNotice(`PR failed: ${e}`); } })(); } },
    { id: "worktree", label: "Agent: New Run in Worktree", action: () => { setPaletteOpen(false); void newWorktreeRun(); } },
    { id: "worktrees-view", label: "View: Worktrees", action: () => { setPaletteOpen(false); setWorktreesVisible(true); } },
    { id: "rollback", label: "Git: View Checkpoints", action: () => { openOverlay("runs"); setPaletteOpen(false); } },
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
  // reachable so API keys can be set up before a folder is ever opened —
  // resolveSurface only derives Welcome when the overlay is not Settings.
  if (surface.kind === "welcome") {
    return (
      <div
        // No rail here, so the welcome page keeps the traffic-light band clear
        // itself — and that band is the window's drag handle.
        data-tauri-drag-region
        style={{
          height: "100vh",
          display: "flex",
          flexDirection: "column",
          paddingTop: "var(--titlebar-h)",
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
          onOpenSettings={() => openOverlay("settings")}
        />
      </div>
    );
  }

  // The bar belongs to the content column, not to the window: it starts at the
  // rail's inner edge so the rail reads as one full-height surface, from the
  // traffic lights down to the identity card. Focus is chrome-free: no status
  // bar. Overlay views opened from Focus bring the bar back (the bar keeps
  // its Focus styling then — `focusBase`, not the resolved surface).
  const statusBar = !showsStatusBar(surface) ? null : (
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
      focusMode={focusBase}
      onSetFocusMode={(on) => (on ? enterFocus() : exitFocus())}
      onApplyGrid={applyGrid}
      onExitGrid={exitGrid}
      onSetAnchored={setAnchoredLayout}
      onOpenGrid={openGridSettings}
      theme={statusTheme}
      autoTheme={autoTheme}
      onToggleTheme={() => setTheme((t) => getNextThemeId(t))}
      onResetLayout={resetPanelLayout}
      showLayoutControls={overlay === null}
      foldedEditor={
        surface.kind === "workbench" &&
        surface.layout.kind === "free" &&
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
  );

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        className="klide-app-row"
        data-titlebar-owner={ownsTitlebar(surface) ? "focus" : "row"}
        style={{ flex: 1, display: "flex", minHeight: 0 }}
      >
        {overlay === "settings" ? (
          <div className="klide-shell-col" data-tauri-drag-region>
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
              availableAiModels={modelsByPanel[DEFAULT_AI_PANEL_ID] ?? [aiModel]}
              explorerVisible={explorerVisible}
              onExplorerVisibleChange={setExplorerVisible}
              explorerFloating={explorerFloating}
              onExplorerFloatingChange={setExplorerFloating}
              customLayouts={customLayouts}
              onCustomLayoutsChange={updateCustomLayouts}
              onApplyLayout={applyLayout}
              onProviderKeyChange={() => setApiKeyVersion((version) => version + 1)}
              onBack={back}
            />
          </Suspense>
          {statusBar}
          </div>
        ) : (
          <>
            {/* The one rail. Focus renders the very same component with its own
                `nav` — the two sidebars used to be separate components and had
                drifted into two different apps. What the workbench adds here is
                the panel tools only it can open (Explorer, Git, AI); what it
                gains is the conversation history that used to exist in Focus
                alone. Focus hides the rail because it draws its own copy. */}
            {showsRail(surface) && (
            /* The one sidebar, and one instance of it — Focus used to draw a
               second copy, which meant a mode change unmounted one rail and
               mounted another: the entrance animation replayed and the tree's
               expanded folders and scroll went with it. The shells differ only
               in the props below, so switching mode now morphs the icons and
               leaves the column where it stands. */
            <WorkspaceRail
              workspaceRoot={workspaceRoot}
              projects={recentFolders}
              nav={focusBase ? focusRailNav : railNav}
              activeProvider={aiPanels[0]?.provider ?? "ollama"}
              /* The focused pane's conversation is the one you are looking at,
                 so it takes the tree's active route; the rest are marked as
                 merely open. In Focus the panel bindings are the truth while a
                 chat is up — they follow a drop into the split — and the local
                 click state covers the apology row and the moment between a
                 click and the binding catching up. A race watch is the one case
                 with more than one "here": see the derivation above. */
              selectedConversationIds={railSelectedConversationIds}
              openConversationIds={railOpenConversationIds}
              onSwitchProject={(root) => {
                if (focusBase) {
                  endFocusRaceWatch();
                  setFocusChatActive(false);
                }
                changeRoot(root);
              }}
              onOpenConversation={(convo) => {
                if (focusBase) {
                  setFocusSelectedConvoId(convo.id);
                  setFocusConvoError(null);
                  // History is navigation, not a second reader mode: resume it
                  // into the same fully wired AiPanel a live Focus chat uses.
                  openFocusConversation(convo, "primary");
                  return;
                }
                openConversationInAiPanel(convo);
              }}
              onConversationDeleted={(convo) => {
                // The panel showing it has already dropped to a fresh chat.
                // What the rail cannot see is Focus's canvas: if the thread
                // you were looking at is the one that went, the start stage
                // is the honest place to be, not an empty chat under a route
                // that leads nowhere.
                if (!focusBase) return;
                if (convo.id !== focusSelectedConvoId && convo.id !== railActiveConversationId) return;
                endFocusRaceWatch();
                clearFocusConvoNavigation();
                setFocusChatActive(false);
              }}
              onConversationUnavailable={(convo) => {
                if (focusBase) {
                  // Focus swaps its canvas for a plain apology rather than
                  // silently reopening whatever was up.
                  setFocusSelectedConvoId(convo.id);
                  setFocusConvoError({ title: convo.title || "Untitled conversation" });
                  return;
                }
                notify(
                  `"${convo.title || "That conversation"}" is no longer in local history.`,
                  { tone: "warn" },
                );
              }}
              onNavigateAway={focusBase ? clearFocusConvoNavigation : undefined}
              reloadKey={focusBase ? focusChatActive : undefined}
              onOpenSettings={() => togglePanel("settings")}
              onOpenProfile={() => togglePanel("profile")}
              /* The same two controls in both shells, so the foot never gains
                 or loses a button on a mode change — only the view switch's
                 icon morphs. They sit apart from the destinations above because
                 they change the shell rather than opening a surface. */
              footActions={
                <>
                  <button
                    type="button"
                    className="klide-rail-view-switch"
                    data-active={(focusBase ? focusTerminalOpen : terminalVisible) || undefined}
                    aria-label={
                      (focusBase ? focusTerminalOpen : terminalVisible)
                        ? "Hide the terminal"
                        : "Show the terminal"
                    }
                    aria-pressed={focusBase ? focusTerminalOpen : terminalVisible}
                    title={
                      (focusBase ? focusTerminalOpen : terminalVisible)
                        ? "Hide the terminal"
                        : "Terminal"
                    }
                    onClick={() =>
                      focusBase
                        ? setFocusTerminalOpen((open) => !open)
                        : setTerminalVisible((shown) => !shown)
                    }
                  >
                    <TerminalIcon size={14} />
                  </button>
                  <button
                    type="button"
                    className="klide-rail-view-switch"
                    aria-label={focusBase ? "Leave Focus — Free layout" : "Focus layout"}
                    title={focusBase ? "Leave Focus — Free layout" : "Focus layout"}
                    onClick={() => {
                      if (focusBase) {
                        clearFocusConvoNavigation();
                        enterWorkbench("free");
                        return;
                      }
                      enterFocus();
                    }}
                  >
                    {focusBase ? <FreeLayoutIcon size={14} /> : <FocusLayoutIcon size={14} />}
                  </button>
                </>
              }
            />
            )}

            {/* Everything right of the rail — the views and the status bar —
                is one column, so the bar stops at the rail's inner edge. It
                also owns the title-bar band (`.klide-app-row` rule), so it is
                the element the traffic-light strip belongs to — and therefore
                the one that has to carry the window drag region. Its children
                fill the rest of the column and remain their own event targets,
                so only the empty band drags. */}
            <div className="klide-shell-col" data-tauri-drag-region>
            {overlay === "git-review" ? (
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
            ) : overlay === "runs" ? (
              <Suspense fallback={<MissionControlSkeleton />}>
                <MissionControl
                  workspaceRoot={workspaceRoot}
                  theme={theme}
                  onResumeKlideRun={resumeKlideRun}
                  onOpenInAiPanel={openRunInAiPanel}
                  onReattachLiveSession={reattachLiveSession}
                  onWatchRace={watchRace}
                  onSaveMemory={saveMemoryFromRun}
                  onForkRun={forkRun}
                  onContinueRunInFocus={continueRunInFocus}
                  onForkRunInWorktree={forkRunInWorktree}
                  onMergeWorktreeRun={mergeWorktreeRun}
                  summarizingFromRunId={summarizingFromRun}
                />
              </Suspense>
            ) : overlay === "orchestrator" ? (
              // The tier-board console. Rust's Mission supervisor owns which
              // task runs next (ADR-0002); this surface authors the plan,
              // approves it, and reattaches to the resulting Harness Runs.
              <Suspense fallback={null}>
                <OrchestratorConsole workspaceRoot={workspaceRoot} />
              </Suspense>
            ) : activeGrid ? (
              // A grid base and Focus are mutually exclusive by construction
              // (one `base` in the Surface), so no `!focusMode` guard.
              <GridWorkbench layout={activeGrid} renderPanel={renderPanel} />
            ) : null}
            {/* The workbench stays mounted across overlay switches so an
                in-flight agent run keeps streaming into the AI panel.
                Switching to Mission Control / Git / Settings used to UNMOUNT
                it, dropping the live event subscription — the answer then only
                "respawned" on return via the transcript. Here it's hidden
                (display:none), not unmounted, whenever an overlay view is
                showing. Grid mode owns its own layout, so it's excluded. */}
            {!activeGrid && (
              <div
                style={{
                  display: overlay === null ? "flex" : "none",
                  flex: 1,
                  minWidth: 0,
                  minHeight: 0,
                }}
              >
                {focusBase ? (
              /* Focus — the chat-first main screen: rail + hero home, and
                 for the live conversation the same fully-wired AiPanel in
                 its fullscreen "focus" design variant (centered reading
                 column). One agent surface, two designs. */
              <Suspense fallback={null}>
                <FocusMode
                  workspaceRoot={workspaceRoot}
                  branch={gitStatus?.branch ?? null}
                  gitChangeCount={gitStatus?.files.length ?? 0}
                  gitRefreshToken={gitStatus
                    ? `${gitStatus.branch}|${gitStatus.files
                        .map((file) => `${file.path}:${file.status}:${file.staged ? 1 : 0}`)
                        .join("|")}`
                    : ""}
                  projects={recentFolders}
                  chatActive={focusChatActive}
                  /* The apology the canvas shows for a conversation history no
                     longer holds. The sidebar that navigates there is the
                     host's, so its state is too. */
                  conversationOpenError={focusConvoError}
                  onConversationUnavailable={(convo) => {
                    setFocusSelectedConvoId(convo.id);
                    setFocusConvoError({ title: convo.title || "Untitled conversation" });
                  }}
                  onClearConversationNavigation={clearFocusConvoNavigation}
                  onNewChat={() => startFocusTask()}
                  onOpenConversation={(convo) => {
                    setFocusSelectedConvoId(convo.id);
                    setFocusConvoError(null);
                    openFocusConversation(convo, "primary");
                  }}
                  onSubmit={(text, attachments) => {
                    markFolderWorked(workspaceRoot);
                    // A normal Focus task runs in the open Workspace. Worktree
                    // isolation is opt-in through the dedicated action/fork
                    // flows, never an invisible side effect of pressing Send.
                    setAiPanelCwd(aiPanels[0]?.id ?? "ai-main", undefined);
                    setFocusInitialMessage(text);
                    setFocusInitialAttachments(attachments);
                    setFocusChatActive(true);
                  }}
                  /* Focus's canvas reaches the shared destinations through the
                     very same handler the rail uses — one Git view, one Memory
                     modal, one Settings. */
                  onOpenPanel={(panel) => {
                    // Skills is the one exception: togglePanel treats it as a
                    // sidebar view and would collapse the free-mode explorer on
                    // the way, which Focus has no business touching.
                    if (panel === "skills") {
                      setSkillsVisible((cur) => !cur);
                      return;
                    }
                    togglePanel(panel);
                  }}
                  onOpenSettingsSection={(section) => {
                    setSettingsInitial(section);
                    openOverlay("settings");
                  }}
                  /* Terminal on the full canvas. There is one native shell, so
                     this is the same PTY the workbench drawer shows — and
                     because the drawer is unmounted while Focus is up, exactly
                     one xterm is ever attached to it. */
                  renderTerminal={() =>
                    // Mounts on first open, then stays — same as the workbench
                    // drawer, so closing can animate out and the shell's
                    // scrollback survives the trip.
                    focusTerminalMounted ? (
                      <div
                        className="klide-focus-terminal-dock"
                        data-open={focusTerminalShown ? "true" : "false"}
                        data-resizing={focusTerminalResizing ? "true" : undefined}
                        aria-hidden={!focusTerminalShown}
                        // Height is the animated property here — that's what
                        // makes the canvas above give way instead of being
                        // covered. Closed is a real 0, so it occupies nothing.
                        style={{ height: focusTerminalShown ? terminalRect.h : 0 }}
                      >
                        <div
                          role="separator"
                          aria-orientation="horizontal"
                          aria-label="Resize terminal"
                          // Suspend the height transition for the drag, then
                          // restore it so closing still animates.
                          onMouseDown={(e) => {
                            setFocusTerminalResizing(true);
                            const done = () => {
                              setFocusTerminalResizing(false);
                              window.removeEventListener("mouseup", done);
                            };
                            window.addEventListener("mouseup", done);
                            // The Focus canvas, measured live — the drawer's
                            // usual bound (workbenchSize) is 0 in Focus.
                            const canvas = e.currentTarget.parentElement?.parentElement;
                            beginTerminalDockResize(e, canvas?.clientHeight);
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
                        {/* Settled height, held while the dock's box animates —
                            so xterm re-measures once, not every frame. */}
                        <div
                          className="klide-focus-terminal-dock-inner"
                          style={{ height: terminalRect.h }}
                        >
                          <TerminalPanel
                            key="focus-terminal"
                            fill
                            visible
                            inset
                            theme={theme}
                            height={terminalRect.h}
                            workspaceRoot={workspaceRoot}
                            onToggle={() => setFocusTerminalOpen(false)}
                          />
                        </div>
                      </div>
                    ) : null
                  }
                  renderChat={renderFocusChat}
                  provider={
                    aiPanels[0]?.provider ??
                    ((localStorage.getItem("klide.provider") as ProviderId) || "ollama")
                  }
                  onProviderChange={(p) => {
                    const panelId = primaryPanelId;
                    setAiPanelProvider(panelId, p);
                    // The panel keeps its model across provider switches, but a
                    // hero pick means "start on this provider" — reset to its
                    // default so the pair is never mismatched. Resolved through
                    // providers so a self-hosted endpoint lands on the model
                    // pinned in Settings, not on an empty string.
                    updateAiPanelModel(panelId, defaultModelForProvider(p));
                  }}
                  model={aiPanels[0]?.model ?? aiModel}
                  onModelChange={(m) => updateAiPanelModel(primaryPanelId, m)}
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
                    const panelId = primaryPanelId;
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
                  requireDiffReview={reviewForPanel(primaryPanelId)}
                  onRequireDiffReviewChange={(required) =>
                    setPanelReview(primaryPanelId, required)
                  }
                  autoApproveCommands={commandsForPanel(primaryPanelId)}
                  onAutoApproveCommandsChange={(enabled) =>
                    setPanelCommands(primaryPanelId, enabled)
                  }
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
                        focusPanel(primaryPanelId);
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
                      clearRaceWatch();
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
                    {active?.dataUri ? (
                      <ImageView src={active.dataUri} name={active.path} />
                    ) : (
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
                    )}
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
                      /* Take the drawer to Focus, where it docks under the
                         canvas at the same height. The shell keeps running —
                         this only moves which xterm is attached to it, so a
                         build in progress survives the trip. The workbench
                         drawer closes behind you so coming back doesn't land
                         on a half-open dock. */
                      onOpenInFocus={() => {
                        setFocusTerminalOpen(true);
                        setTerminalVisible(false);
                        enterFocus();
                      }}
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
                instance, so this one only shows on the base surface.
                Not in Focus: that canvas reviews a run's changes live in its
                right-hand column, where the result card lists the files and
                opens its evidence in place. Docking a second review surface
                under the composer there put the same work in two places, and
                the one that lost the argument was a header strip squeezed
                against the status bar. */}
            {overlay === null && !focusBase && (
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
            {statusBar}
            </div>
          </>
        )}
      </div>
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
      {documentViewer && (
        <DocumentViewer
          documents={documentViewer.documents}
          path={documentViewer.path}
          load={previewRunArtifact}
          placeholder={placeholderPicture}
          onOpenExternal={(path) => void openArtifactExternally(path)}
          onClose={() => setDocumentViewer(null)}
        />
      )}
      <ToastHost />
    </div>
  );
}

/** The race's one shared instrument: a centered composer floating over the
 *  seam that fans a single follow-up into every racer's conversation. Each
 *  column keeps its own composer for steering one racer; this box is how you
 *  steer the race. Flat soft-fill card — hairline, no shadow — in the same
 *  entrance the rest of Focus uses. */
function RacePilotBox({
  agents,
  onAsk,
  onEnd,
}: {
  agents: number;
  onAsk: (text: string) => void;
  /** Leave the race view — the runs keep going headless. */
  onEnd: () => void;
}) {
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        // On top, under the column heads — the pilot instrument leads the
        // race instead of crowding the two per-column composers below.
        top: 40,
        display: "flex",
        justifyContent: "center",
        pointerEvents: "none",
        zIndex: 4,
      }}
    >
      <div
        style={{
          pointerEvents: "auto",
          width: "min(640px, 62%)",
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "13px 18px",
          background: "var(--bg)",
          border: `1px solid ${focused ? "var(--border-strong)" : "var(--border)"}`,
          borderRadius: "var(--radius-lg)",
          transition: "border-color var(--motion-fast) var(--ease-out)",
          animation: "klide-enter-rise 460ms var(--ease-soft) both",
        }}
      >
        <input
          type="text"
          name="race-pilot"
          aria-label={agents > 1 ? "Ask all racing agents" : "Ask the racing agent"}
          autoComplete="off"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            const t = text.trim();
            if (!t) return;
            onAsk(t);
            setText("");
          }}
          placeholder={agents > 1 ? "Ask both agents…" : "Ask the racer…"}
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 14,
            fontFamily: "inherit",
            color: "var(--fg-strong)",
            background: "transparent",
            border: "none",
            outline: "none",
            padding: 0,
          }}
        />
        <span
          aria-hidden="true"
          style={{
            fontSize: 11,
            color: focused && text.trim() ? "var(--fg-subtle)" : "var(--fg-dim)",
            whiteSpace: "nowrap",
            transition: "color var(--motion-fast) var(--ease-out)",
          }}
        >
          {agents > 1 ? `⏎ → ${agents} agents` : "⏎"}
        </span>
        <span
          aria-hidden="true"
          style={{
            width: 1,
            alignSelf: "stretch",
            margin: "1px 0",
            background: "var(--border)",
            flexShrink: 0,
          }}
        />
        <button
          type="button"
          onClick={onEnd}
          title="Close the race view — both runs keep going and stay on Mission Control"
          style={{
            border: "none",
            background: "transparent",
            font: "inherit",
            fontSize: 11.5,
            color: "var(--fg-dim)",
            padding: 0,
            cursor: "pointer",
            whiteSpace: "nowrap",
            flexShrink: 0,
            transition: "color var(--motion-fast) var(--ease-out)",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--fg-strong)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "var(--fg-dim)"; }}
        >
          End watch
        </button>
      </div>
    </div>
  );
}

/** One race column's head: the racer's label, and on the right the only fact
 *  worth a glance while piloting — whether its run is still live. Words in
 *  ink, never a dot or a pill: "running" while the harness streams, "settled"
 *  once it reaches a terminal event (done, error, or cancelled — the compare
 *  table on Mission Control carries the verdict). */
function RacePaneHead({
  label,
  runId,
  provider,
  active,
}: {
  label: string;
  runId: string;
  provider: ProviderId;
  active: boolean;
}) {
  const running = useIsConversationRunning(runId);
  return (
    // Centered like a macOS window title: the provider's own mark and the
    // model name are the column's identity, its live word beside them in
    // quieter ink.
    <div
      style={{
        flexShrink: 0,
        height: 30,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        padding: "0 16px",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <span style={{ display: "flex", alignItems: "center", opacity: active ? 1 : 0.7 }}>
        <ProviderLogo id={provider} size={13} />
      </span>
      <span
        style={{
          fontSize: 12.5,
          fontWeight: active ? 550 : 400,
          color: active ? "var(--fg-strong)" : "var(--fg-subtle)",
          transition: "color var(--motion-fast) var(--ease-out)",
          whiteSpace: "nowrap",
          textOverflow: "ellipsis",
          overflow: "hidden",
          maxWidth: "72%",
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: 11.5,
          color: running ? "var(--accent)" : "var(--fg-dim)",
          whiteSpace: "nowrap",
        }}
      >
        {running ? "running" : "settled"}
      </span>
    </div>
  );
}

export default App;
