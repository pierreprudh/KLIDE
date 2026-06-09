import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { type OnMount } from "@monaco-editor/react";
import { invoke } from "@tauri-apps/api/core";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import { readTextFile, watch, writeTextFile } from "@tauri-apps/plugin-fs";
import { listen } from "@tauri-apps/api/event";
import { ActivityBar } from "./components/ActivityBar";
import { MissionControl } from "./components/MissionControl";
import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { EditorArea } from "./components/EditorArea";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { TerminalPanel } from "./components/TerminalPanel";
import { AiPanel } from "./components/AiPanel";
import { StatusBar } from "./components/StatusBar";
import { eventsToConversation } from "./components/ai/eventsToMsgs";
import type { AgentEvent, ProviderId } from "./agent/types";
import type { Conversation } from "./components/ai/types";
import type { GitStatus } from "./gitTypes";
import { GitReview } from "./components/GitReview";
import { MemoryModal } from "./components/MemoryModal";
import { FileViewerPanel } from "./components/FileViewerPanel";
import { SkillsModal } from "./components/SkillsModal";
import { SettingsPanel } from "./components/SettingsPanel";
import { ProfileModal } from "./components/ProfileModal";
import { getNextThemeId, normalizeThemeId, type ThemeId } from "./theme";
import { loadSkills, saveSkills, loadFilesystemSkills, type Skill } from "./skills";
import { PROVIDER_GROUPS } from "./agent/providers";
import {
  loadCustomPresets,
  saveCustomPresets,
  type LayoutPreset,
} from "./layouts";
import { loadGridLayouts, type GridLayout, type PanelKind } from "./gridLayouts";
import { GridWorkbench } from "./components/GridWorkbench";
import { FloatingPanel } from "./components/FloatingPanel";
import { SplitPane } from "./components/SplitPane";
import {
  defaultLayout as defaultPanelLayout,
  loadLayout as loadPanelLayout,
  saveLayout as savePanelLayout,
  clearLayout as clearPanelLayout,
  clampRect,
  PANEL_CONSTRAINTS,
  type Layout as PanelLayout,
  type PanelRect,
  type PanelId as PanelLayoutId,
  type StoredAiPanel,
} from "./panelLayout";
import { CommandPalette } from "./components/CommandPalette";
import { SearchPanel } from "./components/SearchPanel";
import "./styles/tokens.css";

type Panel = "explorer" | "git" | "memory" | "skills" | "ai" | "runs" | "settings" | "profile";
type Tab = {
  path: string;
  code: string;
  dirty: boolean;
  externalChanged?: boolean;
  // Last content loaded from / saved to disk — the baseline for deciding
  // whether a watch event is a real external edit or just noise (rename, save).
  diskCode?: string;
};
type AiPanelInstance = {
  id: string;
  rect: PanelRect;
  provider?: ProviderId;
  model?: string;
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

function newAiPanelId(): string {
  return `ai-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function storedAiProvider(id: string | undefined): ProviderId | undefined {
  if (!id) return undefined;
  const known = PROVIDER_GROUPS.some((group) =>
    group.items.some((item) => item.id === id)
  );
  return known ? (id as ProviderId) : undefined;
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

function filename(path: string): string {
  return path.split("/").pop() ?? path;
}

function App() {
  const [view, setView] = useState<"workbench" | "runs" | "settings" | "git-review">("workbench");
  const [explorerVisible, setExplorerVisible] = useState(
    () => localStorage.getItem("klide-explorer-visible") !== "false"
  );
  const [memoryVisible, setMemoryVisible] = useState(false);
  // Bumped when the AI panel writes a new memory entry, so the modal
  // refreshes when the user opens it.
  const [memoryRefreshKey, setMemoryRefreshKey] = useState(0);
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
  const [resumeConversation, setResumeConversation] = useState<Conversation | null>(null);
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
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeIdx, setActiveIdx] = useState<number>(-1);
  const [fileNotice, setFileNotice] = useState<string | null>(null);
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);
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
  // One Layout per workspace, persisted on every change.
  const workbenchRef = useRef<HTMLDivElement | null>(null);
  const [workbenchSize, setWorkbenchSize] = useState({ w: 0, h: 0 });
  const [panelLayout, setPanelLayout] = useState<PanelLayout>(() => ({}));
  const [layoutHydratedRoot, setLayoutHydratedRoot] = useState<string | null>(null);
  const [aiPanels, setAiPanels] = useState<AiPanelInstance[]>(() => [
    { id: "ai-main", rect: { x: 0, y: 0, w: 360, h: 360 } },
  ]);
  // Bring-to-front z-index. Bumped when the user clicks a panel.
  const [zCounter, setZCounter] = useState(10);
  const [focusedPanel, setFocusedPanel] = useState<string | null>(null);
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

  // Measure the workbench container so we can build a default layout on
  // first paint, and re-clamp every panel rect when the window resizes.
  useEffect(() => {
    const el = workbenchRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      const next = { w: Math.round(width), h: Math.round(height) };
      setWorkbenchSize((prev) =>
        prev.w === next.w && prev.h === next.h ? prev : next
      );
    });
    ro.observe(el);
    const rect = el.getBoundingClientRect();
    const next = { w: Math.round(rect.width), h: Math.round(rect.height) };
    setWorkbenchSize((prev) =>
      prev.w === next.w && prev.h === next.h ? prev : next
    );
    return () => ro.disconnect();
  }, [view, workspaceRoot]);

  // Load the saved layout for the current workspace (if any), otherwise
  // build a default. Migrate from the legacy per-key localStorage entries
  // on first run so users don't lose their existing widths.
  const [layoutMigrated, setLayoutMigrated] = useState(false);
  function fallbackAiRect(): PanelRect {
    const w = Math.min(360, Math.max(1, workbenchSize.w));
    const h = workbenchSize.h;
    return clampRect(
      { x: Math.max(0, workbenchSize.w - w), y: 0, w, h },
      workbenchSize.w,
      workbenchSize.h,
      PANEL_CONSTRAINTS.ai
    );
  }

  function aiPanelsFromRects(
    stored: StoredAiPanel[] | undefined,
    previous: AiPanelInstance[]
  ): AiPanelInstance[] {
    const source = stored && stored.length > 0 ? stored : [{ id: "ai-main", rect: fallbackAiRect() }];
    return source.map((entry, idx) => {
      const prev = previous.find((p) => p.id === entry.id);
      return {
        id: entry.id ?? (idx === 0 ? "ai-main" : newAiPanelId()),
        rect: entry.rect,
        provider: storedAiProvider(entry.provider) ?? prev?.provider,
        model: entry.model ?? prev?.model,
      };
    });
  }

  function syncAiPanelsFromRects(stored: StoredAiPanel[] | undefined) {
    setAiPanels((previous) => aiPanelsFromRects(stored, previous));
  }

  // Project an in-memory AI panel list back onto a StoredAiPanel array.
  // Preserves every panel's id+rect+provider+model so subsequent hydration
  // is a no-op rather than a destructive rebuild.
  function projectAiPanelsToRects(panels: AiPanelInstance[]): StoredAiPanel[] {
    return panels.map((p) => ({ id: p.id, rect: p.rect, provider: p.provider, model: p.model }));
  }

  useEffect(() => {
    if (!workspaceRoot || workbenchSize.w === 0 || workbenchSize.h === 0) return;
    if (layoutHydratedRoot === workspaceRoot && Object.keys(panelLayout).length > 0) {
      return;
    }
    const saved = loadPanelLayout(workspaceRoot);
    if (saved) {
      setPanelLayout(saved);
      syncAiPanelsFromRects(saved.ai);
      setLayoutHydratedRoot(workspaceRoot);
      return;
    }
    if (!layoutMigrated) {
      setLayoutMigrated(true);
      const migrated: PanelLayout = {
        explorer: {
          x: 0,
          y: 0,
          w: readNumberSetting("klide-left-width", 280, 220, 520),
          h: workbenchSize.h - readNumberSetting("klide-terminal-height", 240, 140, 460) - 6,
        },
        git: {
          x: 0,
          y: 0,
          w: readNumberSetting("klide-git-width", 280, 220, 520),
          h: workbenchSize.h - readNumberSetting("klide-terminal-height", 240, 140, 460) - 6,
        },
        ai: [{
          id: "ai-main",
          rect: {
            x: workbenchSize.w - readNumberSetting("klide-ai-width", 380, 300, 620),
            y: 0,
            w: readNumberSetting("klide-ai-width", 380, 300, 620),
            h: workbenchSize.h - readNumberSetting("klide-terminal-height", 240, 140, 460) - 6,
          },
        }],
        terminal: {
          x: 0,
          y: workbenchSize.h - readNumberSetting("klide-terminal-height", 240, 140, 460) - 6,
          w: workbenchSize.w - readNumberSetting("klide-ai-width", 380, 300, 620) - 6,
          h: readNumberSetting("klide-terminal-height", 240, 140, 460),
        },
      };
      setPanelLayout(migrated);
      syncAiPanelsFromRects(migrated.ai);
      savePanelLayout(workspaceRoot, migrated);
      setLayoutHydratedRoot(workspaceRoot);
      return;
    }
    const fresh = defaultPanelLayout(workbenchSize.w, workbenchSize.h);
    setPanelLayout(fresh);
    syncAiPanelsFromRects(fresh.ai);
    savePanelLayout(workspaceRoot, fresh);
    setLayoutHydratedRoot(workspaceRoot);
  }, [workspaceRoot, workbenchSize.w, workbenchSize.h, layoutMigrated, layoutHydratedRoot]);

  // Persist layout on change (debounced via the React batched updates).
  useEffect(() => {
    if (!workspaceRoot) return;
    if (Object.keys(panelLayout).length === 0) return;
    savePanelLayout(workspaceRoot, panelLayout);
  }, [panelLayout, workspaceRoot]);

  // Re-clamp every panel rect to the current workbench dimensions. Without
  // this, a saved layout (or a manual drag) keeps its old coords when the
  // window shrinks, so panels overflow the workbench or get pushed off-screen
  // ("we lose the responsive panel" / "panels are bigger than the window").
  useEffect(() => {
    if (workbenchSize.w === 0 || workbenchSize.h === 0) return;
    if (Object.keys(panelLayout).length === 0) return;
    let dirty = false;
    const next: PanelLayout = { ...panelLayout };
    for (const id of ["explorer", "git", "memory", "terminal"] as const) {
      const rect = panelLayout[id];
      if (!rect) continue;
      const clamped = clampRect(
        rect,
        workbenchSize.w,
        workbenchSize.h,
        PANEL_CONSTRAINTS[id]
      );
      if (
        clamped.x !== rect.x ||
        clamped.y !== rect.y ||
        clamped.w !== rect.w ||
        clamped.h !== rect.h
      ) {
        next[id] = clamped;
        dirty = true;
      }
    }
    if (panelLayout.ai) {
      const clampedAi: StoredAiPanel[] = [];
      let aiDirty = false;
      panelLayout.ai.forEach((entry) => {
        const c = clampRect(entry.rect, workbenchSize.w, workbenchSize.h, PANEL_CONSTRAINTS.ai);
        clampedAi.push({ ...entry, rect: c });
        if (
          c.x !== entry.rect.x ||
          c.y !== entry.rect.y ||
          c.w !== entry.rect.w ||
          c.h !== entry.rect.h
        ) {
          aiDirty = true;
        }
      });
      if (aiDirty) {
        next.ai = clampedAi;
        syncAiPanelsFromRects(clampedAi);
        dirty = true;
      }
    }
    if (dirty) setPanelLayout(next);
  }, [workbenchSize.w, workbenchSize.h, panelLayout]);

  function resetPanelLayout() {
    if (!workspaceRoot) return;
    clearPanelLayout(workspaceRoot);
    const fresh = defaultPanelLayout(workbenchSize.w, workbenchSize.h);
    setPanelLayout(fresh);
    syncAiPanelsFromRects(fresh.ai);
    savePanelLayout(workspaceRoot, fresh);
    setLayoutHydratedRoot(workspaceRoot);
  }
  void resetPanelLayout;

  function updatePanelRect(panelId: PanelLayoutId, next: PanelRect) {
    setPanelLayout((prev) => ({ ...prev, [panelId]: next }));
  }

  // Saved layouts can lack an `ai` rect (pre-panel-management saves, or a
  // layout persisted while AI was hidden). Seed one so toggling AI on
  // always has something to render.
  function ensureAiRect() {
    const panels =
      aiPanels.length > 0
        ? aiPanels
        : [{ id: "ai-main", rect: fallbackAiRect() }];
    if (aiPanels.length === 0) setAiPanels(panels);
    setPanelLayout((prev) =>
      prev.ai && prev.ai.length > 0
        ? prev
        : { ...prev, ai: projectAiPanelsToRects(panels) }
    );
  }

  function updateAiRect(id: string, next: PanelRect) {
    const rect = clampRect(next, workbenchSize.w, workbenchSize.h, PANEL_CONSTRAINTS.ai);
    setAiPanels((prev) => {
      const updated = prev.map((panel) => panel.id === id ? { ...panel, rect } : panel);
      setPanelLayout((prevLayout) => ({ ...prevLayout, ai: projectAiPanelsToRects(updated) }));
      return updated;
    });
  }

  function focusPanel(panelId: string) {
    setFocusedPanel(panelId);
    setZCounter((n) => n + 1);
  }
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
  type HarnessSettings = {
    chatPrompt?: string;
    planPrompt?: string;
    goalPrompt?: string;
    toolOverrides?: Record<string, boolean>;
  };
  const [harnessSettings, setHarnessSettings] = useState<HarnessSettings>(() => {
    try {
      const raw = localStorage.getItem("klide.harnessSettings");
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  });
  useEffect(() => {
    localStorage.setItem("klide.harnessSettings", JSON.stringify(harnessSettings));
  }, [harnessSettings]);
  const active = activeIdx >= 0 ? tabs[activeIdx] : null;
  // Monaco instance + the position a search-result click wants to land on.
  // The reveal runs in an effect so it fires after the tab's content commits.
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const [pendingReveal, setPendingReveal] = useState<
    { path: string; line: number; column: number } | null
  >(null);
  useEffect(() => {
    if (!pendingReveal || active?.path !== pendingReveal.path) return;
    const editor = editorRef.current;
    if (!editor) return;
    editor.revealLineInCenter(pendingReveal.line);
    editor.setPosition({ lineNumber: pendingReveal.line, column: pendingReveal.column });
    editor.focus();
    setPendingReveal(null);
  }, [pendingReveal, activeIdx]);
  const activeGrid =
    activeGridId != null
      ? gridLayouts.find((g) => g.id === activeGridId) ?? null
      : null;
  const activityState: Record<Panel, boolean> = {
    explorer: view === "workbench" && (explorerVisible || sidebarSlot2 === "explorer"),
    git: view === "git-review",
    memory: view === "workbench" && memoryVisible,
    skills: view === "workbench" && (skillsVisible || sidebarSlot2 === "skills"),
    ai: view === "workbench" && aiVisible,
    runs: view === "runs",
    settings: view === "settings",
    profile: profileVisible,
  };

  function togglePanel(panel: Panel, meta?: boolean) {
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
    setView("workbench");
    if (panel === "ai") {
      // From a non-workbench view (Mission Control, Settings) the AI icon
      // should always *show* the panel — toggling would hide it (the
      // closure still sees aiVisible=true from when the user left) and
      // the user has to click twice to make it reappear.
      if (view !== "workbench") {
        setAiVisible(true);
        if (!panelLayout.ai || panelLayout.ai.length === 0) ensureAiRect();
      } else {
        if (!aiVisible) ensureAiRect();
        setAiVisible((cur) => !cur);
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
        const setter = panel === "explorer" ? setExplorerVisible : setSkillsVisible;
        setter((cur) => !cur);
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
            onProviderChange={(provider) => updateAiPanelProvider(aiPanels[0]?.id ?? "ai-main", provider)}
            availableModels={panelModels[aiPanels[0]?.id ?? "ai-main"] ?? [aiPanels[0]?.model ?? aiModel]}
            onAvailableModelsChange={(models) => setPanelModels((prev) => ({ ...prev, [aiPanels[0]?.id ?? "ai-main"]: models }))}
            apiKeyVersion={apiKeyVersion}
            requireDiffReview={requireDiffReview}
            stopAfterRejection={stopAfterRejection}
            skills={skills}
            harnessSettings={harnessSettings}
            resumeConversation={resumeConversation}
            onResumeConsumed={() => setResumeConversation(null)}
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

  function openFile(
    p: string,
    content: string,
    position?: { line: number; column: number }
  ) {
    if (position) setPendingReveal({ path: p, ...position });
    const existing = tabs.findIndex((t) => t.path === p);
    if (existing >= 0) {
      setActiveIdx(existing);
      return;
    }
    setTabs([
      ...tabs,
      { path: p, code: content, dirty: false, externalChanged: false, diskCode: content },
    ]);
    setActiveIdx(tabs.length);
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

  function updateActiveCode(v: string) {
    if (activeIdx < 0) return;
    setTabs(
      tabs.map((t, i) => (i === activeIdx ? { ...t, code: v, dirty: true } : t))
    );
  }

  function onEntryRenamed(oldPath: string, newPath: string) {
    // Folder-aware: renaming a folder remaps every open tab underneath it.
    setTabs((cur) =>
      cur.map((t) => {
        if (t.path === oldPath) return { ...t, path: newPath };
        if (t.path.startsWith(`${oldPath}/`))
          return { ...t, path: newPath + t.path.slice(oldPath.length) };
        return t;
      })
    );
  }

  function onEntryDeleted(path: string) {
    const isGone = (p: string) => p === path || p.startsWith(`${path}/`);
    const next = tabs.filter((t) => !isGone(t.path));
    if (next.length === tabs.length) return;
    const activePath = active?.path ?? null;
    setTabs(next);
    if (next.length === 0) setActiveIdx(-1);
    else if (activePath && !isGone(activePath))
      setActiveIdx(next.findIndex((t) => t.path === activePath));
    else setActiveIdx(Math.min(Math.max(activeIdx, 0), next.length - 1));
  }

  async function closeTab(i: number) {
    const closing = tabs[i];
    if (closing?.dirty) {
      // window.confirm is a no-op in Tauri's webview (always falsy) —
      // use the dialog plugin's native confirm instead.
      try {
        const ok = await confirm(
          `Close ${filename(closing.path)} with unsaved changes?`,
          { title: "Unsaved changes", kind: "warning" }
        );
        if (!ok) return;
      } catch (e) {
        console.error("Confirm dialog failed:", e);
        setFileNotice(
          `Confirm failed: ${e instanceof Error ? e.message : String(e)}`
        );
        return;
      }
    }
    const next = tabs.filter((_, idx) => idx !== i);
    setTabs(next);
    if (next.length === 0) setActiveIdx(-1);
    else if (i < activeIdx) setActiveIdx(activeIdx - 1);
    else if (i === activeIdx) setActiveIdx(Math.min(activeIdx, next.length - 1));
  }

  async function saveActive() {
    if (!active) return;
    try {
      if (active.externalChanged) {
        const ok = await confirm(
          `${filename(active.path)} changed on disk while you were editing. Save anyway and overwrite the disk version?`,
          { title: "File changed on disk", kind: "warning" }
        );
        if (!ok) return;
      }
      await writeTextFile(active.path, active.code);
      setTabs((cur) =>
        cur.map((t, i) =>
          i === activeIdx
            ? { ...t, dirty: false, externalChanged: false, diskCode: t.code }
            : t
        )
      );
      setFileNotice(`Saved ${filename(active.path)}`);
    } catch (e) {
      // Surface the failure in the status notice instead of dying silently.
      console.error("Save failed:", e);
      setFileNotice(
        `Save failed: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  function onAgentWrote(path: string, newContent: string) {
    setTabs((cur) =>
      cur.map((t) =>
        t.path === path
          ? { ...t, code: newContent, dirty: false, externalChanged: false, diskCode: newContent }
          : t
      )
    );
  }

  async function refreshGitStatus(root: string) {
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

  async function resumeKlideRun(runId: string) {
    try {
      const events = await invoke<AgentEvent[]>("agent_read_run", { runId });
      const convo = eventsToConversation(events, runId, eventsToTitle(events));
      setResumeConversation(convo);
      togglePanel("ai");
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
    const id = newAiPanelId();
    setAiPanels((prevPanels) => {
      const last = prevPanels[prevPanels.length - 1]?.rect;
      const baseW = last?.w ?? Math.min(360, Math.max(1, workbenchSize.w));
      const baseH = last?.h ?? workbenchSize.h;
      const offset = 20;
      const rect = clampRect(
        {
          x: (last?.x ?? workbenchSize.w - baseW) - offset,
          y: (last?.y ?? 0) + offset,
          w: baseW,
          h: baseH,
        },
        workbenchSize.w,
        workbenchSize.h,
        PANEL_CONSTRAINTS.ai
      );
      const nextPanels = [...prevPanels, { id, rect, provider: opts.provider }];
      setPanelLayout((prevLayout) => ({
        ...prevLayout,
        ai: projectAiPanelsToRects(nextPanels),
      }));
      return nextPanels;
    });
    setPendingAiPanel({
      panelId: id,
      provider: opts.provider,
      resumeSessionId: opts.resumeSessionId ?? null,
      initialTask: opts.initialTask ?? null,
    });
  }

  function updateAiPanelProvider(id: string, provider: ProviderId) {
    setAiPanels((panels) => {
      const next = panels.map((panel) => panel.id === id ? { ...panel, provider } : panel);
      setPanelLayout((prev) => ({ ...prev, ai: projectAiPanelsToRects(next) }));
      return next;
    });
  }

  function updateAiPanelModel(id: string, model: string) {
    setAiPanels((panels) => {
      const next = panels.map((panel) => panel.id === id ? { ...panel, model } : panel);
      setPanelLayout((prev) => ({ ...prev, ai: projectAiPanelsToRects(next) }));
      return next;
    });
    if (id === "ai-main") setAiModel(model);
  }

  function duplicateAiPanel(snapshot?: { provider: ProviderId; model: string }) {
    // Add a fresh rect for the new panel. Offset from the last one so
    // the user can see both, but clamp inside the workbench.
    setAiPanels((prevPanels) => {
      const last = prevPanels[prevPanels.length - 1]?.rect;
      const baseW = last?.w ?? Math.min(360, Math.max(1, workbenchSize.w));
      const baseH = last?.h ?? workbenchSize.h;
      const offset = 20;
      const rect = clampRect(
        {
          x: (last?.x ?? workbenchSize.w - baseW) - offset,
          y: (last?.y ?? 0) + offset,
          w: baseW,
          h: baseH,
        },
        workbenchSize.w,
        workbenchSize.h,
        PANEL_CONSTRAINTS.ai
      );
      const nextPanels = [
        ...prevPanels,
        {
          id: newAiPanelId(),
          rect,
          provider: snapshot?.provider,
          model: snapshot?.model,
        },
      ];
      setPanelLayout((prevLayout) => ({
        ...prevLayout,
        ai: projectAiPanelsToRects(nextPanels),
      }));
      return nextPanels;
    });
  }

  function closeAiPanel(id: string) {
    setAiPanels((panels) => {
      if (panels.length <= 1) return panels;
      const next = panels.filter((panel) => panel.id !== id);
      if (next.length === panels.length) return panels;
      setPanelLayout((prev) => {
        return { ...prev, ai: projectAiPanelsToRects(next) };
      });
      return next;
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

  useEffect(() => {
    if (!workspaceRoot) {
      setGitStatus(null);
      return;
    }

    let unwatch: (() => void) | undefined;
    let cancelled = false;
    const refresh = () => {
      if (!cancelled) refreshGitStatus(workspaceRoot);
    };

    refresh();
    watch(workspaceRoot, refresh, { recursive: true, delayMs: 250 })
      .then((un) => {
        if (cancelled) un();
        else unwatch = un;
      })
      .catch(() => {
        if (!cancelled) refreshGitStatus(workspaceRoot);
      });

    return () => {
      cancelled = true;
      unwatch?.();
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
    const openPaths = Array.from(new Set(tabs.map((t) => t.path)));
    if (openPaths.length === 0) return;

    let unwatch: (() => void) | undefined;
    let cancelled = false;

    watch(
      openPaths,
      (event) => {
        const changedPaths = openPaths.filter((path) => event.paths.includes(path));
        for (const path of changedPaths) {
          readTextFile(path)
            .then((diskCode) => {
              if (cancelled) return;
              setTabs((cur) =>
                cur.map((tab) => {
                  if (tab.path !== path) return tab;
                  // Same as the last disk content we know about? Then this
                  // event is noise (our own save, or a rename) — not an edit.
                  if (diskCode === (tab.diskCode ?? tab.code)) {
                    return { ...tab, diskCode, externalChanged: false };
                  }
                  if (tab.dirty) {
                    setFileNotice(`${filename(path)} changed on disk`);
                    return { ...tab, diskCode, externalChanged: true };
                  }
                  setFileNotice(`Reloaded ${filename(path)}`);
                  return { ...tab, code: diskCode, diskCode, externalChanged: false };
                })
              );
            })
            .catch(() => {
              if (cancelled) return;
              setTabs((cur) => {
                // Tab may have been renamed or closed already (e.g. via the
                // explorer context menu) — don't raise a false alarm.
                if (!cur.some((tab) => tab.path === path)) return cur;
                setFileNotice(`${filename(path)} is unavailable on disk`);
                return cur.map((tab) =>
                  tab.path === path ? { ...tab, externalChanged: true } : tab
                );
              });
            });
        }
      },
      { delayMs: 150 }
    )
      .then((un) => {
        if (cancelled) un();
        else unwatch = un;
      })
      .catch((e) => console.error("open tab watch failed:", e));

    return () => {
      cancelled = true;
      unwatch?.();
    };
  }, [tabs.map((t) => t.path).join("\n")]);

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
        if (view === "runs" || view === "git-review" || view === "settings") {
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
                onBack={() => setView("workbench")}
              />
            ) : activeGrid ? (
              <GridWorkbench layout={activeGrid} renderPanel={renderPanel} />
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
                {explorerVisible && panelLayout.explorer && (
                  <FloatingPanel
                    panelId="explorer"
                    rect={panelLayout.explorer}
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
                            width={panelLayout.explorer.w}
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
                        defaultSplit={panelLayout.explorer.h * 0.45}
                        minPane={80}
                      />
                    ) : (
                      <Sidebar
                        fill
                        visible
                        width={panelLayout.explorer.w}
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
                      onClose={() => setPreviewPath(null)}
                    />
                  </div>
                )}
                {terminalVisible && panelLayout.terminal && (
                  <FloatingPanel
                    panelId="terminal"
                    rect={panelLayout.terminal}
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
                      height={panelLayout.terminal.h}
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
                        onProviderChange={(provider) => updateAiPanelProvider(panel.id, provider)}
                        availableModels={panelModels[panel.id] ?? [panel.model ?? aiModel]}
                        onAvailableModelsChange={(models) => setPanelModels((prev) => ({ ...prev, [panel.id]: models }))}
                        apiKeyVersion={apiKeyVersion}
                        requireDiffReview={requireDiffReview}
                        stopAfterRejection={stopAfterRejection}
                        skills={skills}
                        harnessSettings={harnessSettings}
                        onDuplicate={duplicateAiPanel}
                        onClose={
                          aiPanels.length > 1 ? () => closeAiPanel(panel.id) : undefined
                        }
                        resumeConversation={resumeConversation}
                        onResumeConsumed={() => setResumeConversation(null)}
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
        onApplyGrid={applyGrid}
        onExitGrid={exitGrid}
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
          const absolute = path.startsWith("/") ? path : `${workspaceRoot}/${path}`;
          try {
            const content = await readTextFile(absolute);
            openFile(absolute, content);
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
