import {
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
import type { AgentEvent } from "./agent/types";
import type { Conversation } from "./components/ai/types";
import {
  GitDiffWindow,
  GitPanel,
  type GitDiff,
  type GitStatus,
} from "./components/GitPanel";
import { ProjectGraphPanel } from "./components/ProjectGraphPanel";
import { FileViewerPanel } from "./components/FileViewerPanel";
import { SkillsModal } from "./components/SkillsModal";
import { SettingsPanel } from "./components/SettingsPanel";
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
import { SplitPane } from "./components/SplitPane";
import {
  defaultLayout as defaultPanelLayout,
  loadLayout as loadPanelLayout,
  saveLayout as savePanelLayout,
  clearLayout as clearPanelLayout,
  type Layout as PanelLayout,
  type PanelRect,
  type PanelId as PanelLayoutId,
} from "./panelLayout";
import type { ProjectContextSnapshot } from "./contextTray";
import { CommandPalette } from "./components/CommandPalette";
import { SearchPanel } from "./components/SearchPanel";
import "./styles/tokens.css";

type Panel = "explorer" | "git" | "graph" | "skills" | "ai" | "runs" | "settings";
type Tab = {
  path: string;
  code: string;
  dirty: boolean;
  externalChanged?: boolean;
  // Last content loaded from / saved to disk — the baseline for deciding
  // whether a watch event is a real external edit or just noise (rename, save).
  diskCode?: string;
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

function filename(path: string): string {
  return path.split("/").pop() ?? path;
}

function App() {
  const [view, setView] = useState<"workbench" | "runs" | "settings">("workbench");
  const [explorerVisible, setExplorerVisible] = useState(
    () => localStorage.getItem("klide-explorer-visible") !== "false"
  );
  const [gitVisible, setGitVisible] = useState(
    () => localStorage.getItem("klide-git-visible") === "true"
  );
  const [graphVisible, setGraphVisible] = useState(
    () => localStorage.getItem("klide-graph-visible") === "true"
  );
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
  const [aiPanelIds, setAiPanelIds] = useState<string[]>(["ai-main"]);
  const [resumeConversation, setResumeConversation] = useState<Conversation | null>(null);
  const [projectContext, setProjectContext] = useState<ProjectContextSnapshot | null>(null);
  const [apiKeyVersion, setApiKeyVersion] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [searchVisible, setSearchVisible] = useState(false);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeIdx, setActiveIdx] = useState<number>(-1);
  const [fileNotice, setFileNotice] = useState<string | null>(null);
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [activeGitDiff, setActiveGitDiff] = useState<GitDiff | null>(null);
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
  // Bring-to-front z-index. Bumped when the user clicks a panel.
  const [zCounter, setZCounter] = useState(10);
  const [focusedPanel, setFocusedPanel] = useState<PanelLayoutId | null>(null);
  const [skills, setSkills] = useState<Skill[]>(() => loadSkills());

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const fsSkills = await loadFilesystemSkills(workspaceRoot);
      if (cancelled) return;
      setSkills((prev) => {
        const userDefined = prev.filter((s) => !s.fromFile);
        const existingFileIds = new Set(userDefined.map((s) => s.id));
        const newFileSkills = fsSkills.filter((s) => !existingFileIds.has(s.id));
        return [...userDefined, ...newFileSkills];
      });
    })();
    return () => { cancelled = true; };
  }, [workspaceRoot]);

  // Measure the workbench container so we can build a default layout on
  // first paint, and re-clamp every panel rect when the window resizes.
  useEffect(() => {
    const el = workbenchRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setWorkbenchSize({ w: Math.round(width), h: Math.round(height) });
    });
    ro.observe(el);
    const rect = el.getBoundingClientRect();
    setWorkbenchSize({ w: Math.round(rect.width), h: Math.round(rect.height) });
    return () => ro.disconnect();
  }, [view, workspaceRoot]);

  // Load the saved layout for the current workspace (if any), otherwise
  // build a default. Migrate from the legacy per-key localStorage entries
  // on first run so users don't lose their existing widths.
  const [layoutMigrated, setLayoutMigrated] = useState(false);
  useEffect(() => {
    if (!workspaceRoot || workbenchSize.w === 0 || workbenchSize.h === 0) return;
    const saved = loadPanelLayout(workspaceRoot);
    if (saved) {
      setPanelLayout(saved);
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
        graph: {
          x: 0,
          y: 0,
          w: readNumberSetting("klide-graph-width", 320, 260, 560),
          h: workbenchSize.h - readNumberSetting("klide-terminal-height", 240, 140, 460) - 6,
        },
        ai: [{
          x: workbenchSize.w - readNumberSetting("klide-ai-width", 380, 300, 620),
          y: 0,
          w: readNumberSetting("klide-ai-width", 380, 300, 620),
          h: workbenchSize.h - readNumberSetting("klide-terminal-height", 240, 140, 460) - 6,
        }],
        terminal: {
          x: 0,
          y: workbenchSize.h - readNumberSetting("klide-terminal-height", 240, 140, 460) - 6,
          w: workbenchSize.w - readNumberSetting("klide-ai-width", 380, 300, 620) - 6,
          h: readNumberSetting("klide-terminal-height", 240, 140, 460),
        },
      };
      setPanelLayout(migrated);
      savePanelLayout(workspaceRoot, migrated);
      return;
    }
    const fresh = defaultPanelLayout(workbenchSize.w, workbenchSize.h);
    setPanelLayout(fresh);
    savePanelLayout(workspaceRoot, fresh);
  }, [workspaceRoot, workbenchSize.w, workbenchSize.h, layoutMigrated]);

  // Persist layout on change (debounced via the React batched updates).
  useEffect(() => {
    if (!workspaceRoot) return;
    if (Object.keys(panelLayout).length === 0) return;
    savePanelLayout(workspaceRoot, panelLayout);
  }, [panelLayout, workspaceRoot]);

  function resetPanelLayout() {
    if (!workspaceRoot) return;
    clearPanelLayout(workspaceRoot);
    const fresh = defaultPanelLayout(workbenchSize.w, workbenchSize.h);
    setPanelLayout(fresh);
    savePanelLayout(workspaceRoot, fresh);
  }
  void resetPanelLayout;

  function updatePanelRect(panelId: PanelLayoutId, next: PanelRect) {
    setPanelLayout((prev) => ({ ...prev, [panelId]: next }));
  }

  // Saved layouts can lack an `ai` rect (pre-panel-management saves, or a
  // layout persisted while AI was hidden). Seed one so toggling AI on
  // always has something to render.
  function ensureAiRect() {
    setPanelLayout((prev) => {
      if (prev.ai && prev.ai.length > 0) return prev;
      const w = 360;
      const h = Math.max(240, workbenchSize.h - 246);
      return {
        ...prev,
        ai: [{ x: Math.max(0, workbenchSize.w - w), y: 0, w, h }],
      };
    });
  }

  function updateAiRect(idx: number, next: PanelRect) {
    setPanelLayout((prev) => {
      const list = prev.ai ?? [];
      if (idx >= list.length) return prev;
      const copy = list.slice();
      copy[idx] = next;
      return { ...prev, ai: copy };
    });
  }

  function focusPanel(panelId: PanelLayoutId) {
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
    const handler = () => setTheme(mq.matches ? darkTheme : lightTheme);
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
  const [ollamaModels, setOllamaModels] = useState<string[]>([aiModel]);
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
    git: view === "workbench" && (gitVisible || sidebarSlot2 === "git"),
    graph: view === "workbench" && (graphVisible || sidebarSlot2 === "graph"),
    skills: view === "workbench" && (skillsVisible || sidebarSlot2 === "skills"),
    ai: view === "workbench" && aiVisible,
    runs: view === "runs",
    settings: view === "settings",
  };

  function togglePanel(panel: Panel, meta?: boolean) {
    if (panel === "settings") {
      setSettingsInitial(null);
      setView("settings");
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
    if (panel === "explorer" || panel === "git" || panel === "graph" || panel === "skills") {
      if (meta) {
        // ⌘+click toggles the secondary slot in the explorer panel.
        setSidebarSlot2((cur) => cur === panel ? null : panel);
      } else {
        // Plain click: collapse any other sidebar view, then toggle this one.
        if (sidebarSlot2 === panel) setSidebarSlot2(null);
        if (panel !== "explorer" && explorerVisible) setExplorerVisible(false);
        if (panel !== "git" && gitVisible) setGitVisible(false);
        if (panel !== "graph" && graphVisible) setGraphVisible(false);
        if (panel !== "skills" && skillsVisible) setSkillsVisible(false);
        const setter = panel === "explorer" ? setExplorerVisible
          : panel === "git" ? setGitVisible
          : panel === "graph" ? setGraphVisible
          : setSkillsVisible;
        setter((cur) => !cur);
      }
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
            onOpenGitDiff={openGitDiff}
            onEntryRenamed={onEntryRenamed}
            onEntryDeleted={onEntryDeleted}
            onFilePreview={setPreviewPath}
          />
        );
      case "git":
        return (
          <GitPanel
            key={key}
            fill
            visible
            width={panelLayout.git?.w ?? 280}
            workspaceRoot={workspaceRoot}
            gitStatus={gitStatus}
            onRefreshGitStatus={() =>
              workspaceRoot ? refreshGitStatus(workspaceRoot) : undefined
            }
          />
        );
      case "graph":
        return (
          <ProjectGraphPanel
            key={key}
            fill
            visible
            width={panelLayout.graph?.w ?? 320}
            workspaceRoot={workspaceRoot}
            activePath={active?.path ?? null}
            onContextChange={setProjectContext}
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
            width={panelLayout.ai?.[0]?.w ?? 360}
            workspaceRoot={workspaceRoot}
            onFileWritten={onAgentWrote}
            onWorkspaceChanged={() =>
              workspaceRoot ? refreshGitStatus(workspaceRoot) : undefined
            }
            model={aiModel}
            onModelChange={setAiModel}
            availableModels={ollamaModels}
            onAvailableModelsChange={setOllamaModels}
            apiKeyVersion={apiKeyVersion}
            requireDiffReview={requireDiffReview}
            stopAfterRejection={stopAfterRejection}
            skills={skills}
            projectContext={projectContext}
            harnessSettings={harnessSettings}
            resumeConversation={resumeConversation}
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

  async function openGitDiff(path: string, staged: boolean) {
    if (!workspaceRoot) return;
    try {
      const diff = await invoke<GitDiff>("git_diff", {
        workspaceRoot,
        path,
        staged,
      });
      setActiveGitDiff(diff);
    } catch (e) {
      setFileNotice(e instanceof Error ? e.message : String(e));
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

  function duplicateAiPanel() {
    const newId = `ai-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    setAiPanelIds((ids) => [...ids, newId]);
    // Add a fresh rect for the new panel. Offset from the last one so
    // the user can see both, but clamp inside the workbench.
    setPanelLayout((prev) => {
      const list = prev.ai ?? [];
      const last = list[list.length - 1];
      const baseW = last?.w ?? 360;
      const baseH = last?.h ?? Math.max(0, workbenchSize.h - 246);
      const offset = 20;
      const newRect: PanelRect = {
        x: Math.max(0, Math.min(workbenchSize.w - baseW, (last?.x ?? workbenchSize.w - baseW) - offset)),
        y: Math.max(0, Math.min(workbenchSize.h - baseH, (last?.y ?? 0) + offset)),
        w: baseW,
        h: baseH,
      };
      return { ...prev, ai: [...list, newRect] };
    });
  }

  function closeAiPanel(id: string) {
    setAiPanelIds((ids) => {
      const idx = ids.indexOf(id);
      if (idx === -1 || ids.length <= 1) return ids;
      const next = ids.filter((x) => x !== id);
      // Drop the rect that belonged to the closed panel. Index 0 is
      // always the first AI panel, so the index in `ai` matches the
      // index in `ids`.
      setPanelLayout((prev) => {
        const list = prev.ai ?? [];
        if (idx >= list.length) return prev;
        return { ...prev, ai: list.filter((_, i) => i !== idx) };
      });
      return next;
    });
  }

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("klide-theme", theme);
    // When auto-theme is on and user picks a theme, update the preferred
    // light or dark theme for this system mode.
    if (autoTheme) {
      const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      if (isDark && theme !== darkTheme) setDarkTheme(theme);
      if (!isDark && theme !== lightTheme) setLightTheme(theme);
    }
  }, [theme, autoTheme]);

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
    setProjectContext(null);
  }, [workspaceRoot]);

  useEffect(() => {
    localStorage.setItem("klide-explorer-visible", String(explorerVisible));
  }, [explorerVisible]);

  useEffect(() => {
    localStorage.setItem("klide-git-visible", String(gitVisible));
  }, [gitVisible]);

  useEffect(() => {
    localStorage.setItem("klide-graph-visible", String(graphVisible));
  }, [graphVisible]);

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
      if (mod && !e.shiftKey && e.key === "n") {
        e.preventDefault();
        setView("workbench");
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
      // Escape — close palette or search panel
      if (e.key === "Escape") {
        if (paletteOpen) { setPaletteOpen(false); return; }
        if (searchVisible) { setSearchVisible(false); return; }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, activeIdx, tabs, saveActive, paletteOpen, searchVisible]);

  useEffect(() => {
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
    { id: "theme", label: "Appearance: Toggle Theme", action: () => { setTheme((t) => getNextThemeId(t)); setPaletteOpen(false); } },
    { id: "word-wrap", label: "Editor: Toggle Word Wrap", action: () => { setEditorWordWrap((v) => !v); setPaletteOpen(false); } },
    { id: "line-numbers", label: "Editor: Toggle Line Numbers", action: () => { setEditorLineNumbers((v) => !v); setPaletteOpen(false); } },
    { id: "minimap", label: "Editor: Toggle Minimap", action: () => { setEditorMinimap((v) => !v); setPaletteOpen(false); } },
    { id: "runs", label: "View: Mission Control", action: () => { setView("runs"); setPaletteOpen(false); } },
    { id: "create-pr", label: "Git: Create Pull Request…", action: () => { setPaletteOpen(false); void (async () => { try { const pr = await invoke<string>("create_pr", { workspaceRoot, title: "Klide changes", body: null }); setFileNotice(`PR: ${pr}`); } catch(e) { setFileNotice(`PR failed: ${e}`); } })(); } },
    { id: "worktree", label: "Git: New Worktree…", action: () => { setPaletteOpen(false); const name = prompt("Worktree name:"); if (name && workspaceRoot) { void (async () => { try { const path = await invoke<string>("create_worktree", { workspaceRoot, name }); setFileNotice(`Worktree: ${path}`); } catch(e) { setFileNotice(`Failed: ${e}`); } })(); } } },
    { id: "rollback", label: "Git: View Checkpoints", action: () => { setView("runs"); setPaletteOpen(false); } },
    { id: "reload", label: "Developer: Reload Window", action: () => { window.location.reload(); } },
  ];

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
              } else if (panel === "ai" && panelLayout.ai?.[0]) {
                updateAiRect(0, { ...panelLayout.ai[0], w });
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
            availableAiModels={ollamaModels}
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
            {view === "runs" ? (
              <MissionControl workspaceRoot={workspaceRoot} theme={theme} onResumeKlideRun={resumeKlideRun} />
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
                            onOpenGitDiff={openGitDiff}
                            onEntryRenamed={onEntryRenamed}
                            onEntryDeleted={onEntryDeleted}
                            onFilePreview={setPreviewPath}
                          />
                        }
                        bottom={
                          sidebarSlot2 === "git" ? (
                            <GitPanel
                              fill
                              visible
                              width={panelLayout.explorer.w}
                              workspaceRoot={workspaceRoot}
                              gitStatus={gitStatus}
                              onRefreshGitStatus={() =>
                                workspaceRoot ? refreshGitStatus(workspaceRoot) : undefined
                              }
                            />
                          ) : sidebarSlot2 === "graph" ? (
                            <ProjectGraphPanel
                              fill
                              visible
                              width={panelLayout.explorer.w}
                              workspaceRoot={workspaceRoot}
                              activePath={active?.path ?? null}
                              onContextChange={setProjectContext}
                            />
                          ) : sidebarSlot2 === "skills" ? (
                            <SkillsModal
                              open
                              skills={skills}
                              onChange={setSkills}
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
                        onOpenGitDiff={openGitDiff}
                        onEntryRenamed={onEntryRenamed}
                        onEntryDeleted={onEntryDeleted}
                        onFilePreview={setPreviewPath}
                      />
                    )}
                  </FloatingPanel>
                )}
                {gitVisible && sidebarSlot2 !== "git" && panelLayout.git && (
                  <FloatingPanel
                    panelId="git"
                    rect={panelLayout.git}
                    workbenchW={workbenchSize.w}
                    workbenchH={workbenchSize.h}
                    zIndex={focusedPanel === "git" ? 10 + zCounter : 10}
                    onFocus={() => focusPanel("git")}
                    onResize={(next) => updatePanelRect("git", next)}
                    onMove={(next) => updatePanelRect("git", next)}
                  >
                    <GitPanel
                      fill
                      visible
                      width={panelLayout.git.w}
                      workspaceRoot={workspaceRoot}
                      gitStatus={gitStatus}
                      onRefreshGitStatus={() =>
                        workspaceRoot ? refreshGitStatus(workspaceRoot) : undefined
                      }
                    />
                  </FloatingPanel>
                )}
                {graphVisible && sidebarSlot2 !== "graph" && panelLayout.graph && (
                  <FloatingPanel
                    panelId="graph"
                    rect={panelLayout.graph}
                    workbenchW={workbenchSize.w}
                    workbenchH={workbenchSize.h}
                    zIndex={focusedPanel === "graph" ? 10 + zCounter : 10}
                    onFocus={() => focusPanel("graph")}
                    onResize={(next) => updatePanelRect("graph", next)}
                    onMove={(next) => updatePanelRect("graph", next)}
                  >
                    <ProjectGraphPanel
                      fill
                      visible
                      width={panelLayout.graph.w}
                      workspaceRoot={workspaceRoot}
                      activePath={active?.path ?? null}
                      onContextChange={setProjectContext}
                    />
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
                {aiVisible && panelLayout.ai && panelLayout.ai.map((rect, idx) => {
                  const id = aiPanelIds[idx] ?? `ai-orphan-${idx}`;
                  return (
                    <FloatingPanel
                      key={id}
                      panelId="ai"
                      rect={rect}
                      workbenchW={workbenchSize.w}
                      workbenchH={workbenchSize.h}
                      zIndex={focusedPanel === "ai" ? 10 + zCounter + idx : 10 + idx}
                      onFocus={() => focusPanel("ai")}
                      onResize={(next) => updateAiRect(idx, next)}
                      onMove={(next) => updateAiRect(idx, next)}
                    >
                      <AiPanel
                        fill
                        visible
                        width={rect.w}
                        workspaceRoot={workspaceRoot}
                        onFileWritten={onAgentWrote}
                        onWorkspaceChanged={() =>
                          workspaceRoot ? refreshGitStatus(workspaceRoot) : undefined
                        }
                        model={aiModel}
                        onModelChange={setAiModel}
                        availableModels={ollamaModels}
                        onAvailableModelsChange={setOllamaModels}
                        apiKeyVersion={apiKeyVersion}
                        requireDiffReview={requireDiffReview}
                        stopAfterRejection={stopAfterRejection}
                        skills={skills}
                        projectContext={projectContext}
                        harnessSettings={harnessSettings}
                        onDuplicate={duplicateAiPanel}
                        onClose={
                          aiPanelIds.length > 1 ? () => closeAiPanel(id) : undefined
                        }
                        resumeConversation={resumeConversation}
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
        theme={theme}
        onToggleTheme={() => setTheme((t) => getNextThemeId(t))}
        onResetLayout={resetPanelLayout}
      />
      {activeGitDiff && (
        <GitDiffWindow diff={activeGitDiff} onClose={() => setActiveGitDiff(null)} />
      )}
      <SkillsModal
        open={skillsVisible && sidebarSlot2 !== "skills"}
        skills={skills}
        onChange={updateSkills}
        onClose={() => setSkillsVisible(false)}
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
