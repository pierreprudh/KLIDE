import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
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
import {
  GitDiffWindow,
  GitPanel,
  type GitDiff,
  type GitStatus,
} from "./components/GitPanel";
import { ProjectGraphPanel } from "./components/ProjectGraphPanel";
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

function ResizeHandle({
  direction,
  label,
  onMouseDown,
}: {
  direction: "vertical" | "horizontal";
  label: string;
  onMouseDown: (e: ReactMouseEvent<HTMLDivElement>) => void;
}) {
  const isVertical = direction === "vertical";
  return (
    <div
      role="separator"
      aria-label={label}
      onMouseDown={onMouseDown}
      style={{
        width: isVertical ? 7 : "100%",
        height: isVertical ? "100%" : 7,
        flexShrink: 0,
        cursor: isVertical ? "col-resize" : "row-resize",
        position: "relative",
        zIndex: 5,
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: isVertical ? "0 3px" : "3px 0",
          background: "transparent",
          transition: "background var(--motion-med) var(--ease-out)",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--accent-soft)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      />
    </div>
  );
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
  const [aiPanelIds, setAiPanelIds] = useState<string[]>(["ai-main"]);
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
  const [explorerWidth, setExplorerWidth] = useState(() =>
    readNumberSetting("klide-left-width", 280, 220, 520)
  );
  const [gitWidth, setGitWidth] = useState(() =>
    readNumberSetting("klide-git-width", 280, 220, 520)
  );
  const [graphWidth, setGraphWidth] = useState(() =>
    readNumberSetting("klide-graph-width", 320, 260, 560)
  );
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
  const [aiWidth, setAiWidth] = useState(() =>
    readNumberSetting("klide-ai-width", 380, 300, 620)
  );
  const [terminalHeight, setTerminalHeight] = useState(() =>
    readNumberSetting("klide-terminal-height", 240, 140, 460)
  );
  const [theme, setTheme] = useState<ThemeId>(() =>
    normalizeThemeId(localStorage.getItem("klide-theme"))
  );
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
    explorer: view === "workbench" && explorerVisible,
    git: view === "workbench" && gitVisible,
    graph: view === "workbench" && graphVisible,
    skills: view === "workbench" && skillsVisible,
    ai: view === "workbench" && aiVisible,
    runs: view === "runs",
    settings: view === "settings",
  };

  function togglePanel(panel: Panel) {
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
      setAiVisible((cur) => !cur);
      return;
    }
    if (panel === "explorer") {
      setExplorerVisible((cur) => !cur);
      return;
    }
    if (panel === "git") {
      setGitVisible((cur) => !cur);
      return;
    }
    if (panel === "graph") {
      setGraphVisible((cur) => !cur);
      return;
    }
    if (panel === "skills") {
      setSkillsVisible((cur) => !cur);
      return;
    }
  }

  function applyLayout(layout: {
    explorer: boolean;
    terminal: boolean;
    ai: boolean;
    explorerWidth?: number;
    aiWidth?: number;
    terminalHeight?: number;
  }) {
    setView("workbench");
    setExplorerVisible(layout.explorer);
    setTerminalVisible(layout.terminal);
    setAiVisible(layout.ai);
    if (layout.explorerWidth !== undefined) setExplorerWidth(layout.explorerWidth);
    if (layout.aiWidth !== undefined) setAiWidth(layout.aiWidth);
    if (layout.terminalHeight !== undefined) setTerminalHeight(layout.terminalHeight);
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
            width={explorerWidth}
            workspaceRoot={workspaceRoot}
            onOpen={openFile}
            onRootChange={setWorkspaceRoot}
            onOpenGitDiff={openGitDiff}
            onEntryRenamed={onEntryRenamed}
            onEntryDeleted={onEntryDeleted}
          />
        );
      case "git":
        return (
          <GitPanel
            key={key}
            fill
            visible
            width={gitWidth}
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
            width={graphWidth}
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
            height={terminalHeight}
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
            width={aiWidth}
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

  function beginResize(
    e: ReactMouseEvent<HTMLDivElement>,
    config:
      | {
          axis: "x";
          startValue: number;
          min: number;
          max: number;
          reverse?: boolean;
          setValue: (v: number) => void;
        }
      | {
          axis: "y";
          startValue: number;
          min: number;
          max: number;
          reverse?: boolean;
          setValue: (v: number) => void;
        }
  ) {
    e.preventDefault();
    const start = config.axis === "x" ? e.clientX : e.clientY;
    const previousCursor = document.body.style.cursor;
    const previousSelect = document.body.style.userSelect;
    document.body.style.cursor = config.axis === "x" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";

    function onMove(ev: MouseEvent) {
      const current = config.axis === "x" ? ev.clientX : ev.clientY;
      const delta = config.reverse ? start - current : current - start;
      config.setValue(clamp(config.startValue + delta, config.min, config.max));
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

  function duplicateAiPanel() {
    setAiPanelIds((ids) => [
      ...ids,
      `ai-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    ]);
  }

  function closeAiPanel(id: string) {
    setAiPanelIds((ids) => (ids.length > 1 ? ids.filter((x) => x !== id) : ids));
  }

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("klide-theme", theme);
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
    localStorage.setItem("klide-ai-visible", String(aiVisible));
  }, [aiVisible]);

  useEffect(() => {
    localStorage.setItem("klide-terminal-visible", String(terminalVisible));
  }, [terminalVisible]);

  useEffect(() => {
    localStorage.setItem("klide-left-width", String(explorerWidth));
  }, [explorerWidth]);

  useEffect(() => {
    localStorage.setItem("klide-git-width", String(gitWidth));
  }, [gitWidth]);

  useEffect(() => {
    localStorage.setItem("klide-graph-width", String(graphWidth));
  }, [graphWidth]);

  function updateSkills(next: Skill[]) {
    saveSkills(next);
    setSkills(next);
  }
  void updateSkills;

  useEffect(() => {
    localStorage.setItem("klide-ai-width", String(aiWidth));
  }, [aiWidth]);

  useEffect(() => {
    localStorage.setItem("klide-terminal-height", String(terminalHeight));
  }, [terminalHeight]);

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
            aiVisible={aiVisible}
            onAiVisibleChange={setAiVisible}
            terminalVisible={terminalVisible}
            onTerminalVisibleChange={setTerminalVisible}
            leftPanelWidth={explorerWidth}
            onLeftPanelWidthChange={setExplorerWidth}
            aiWidth={aiWidth}
            onAiWidthChange={setAiWidth}
            terminalHeight={terminalHeight}
            onTerminalHeightChange={setTerminalHeight}
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
              <MissionControl workspaceRoot={workspaceRoot} theme={theme} />
            ) : activeGrid ? (
              <GridWorkbench layout={activeGrid} renderPanel={renderPanel} />
            ) : (
              <>
            <Sidebar
              onOpen={openFile}
              onRootChange={setWorkspaceRoot}
              onOpenGitDiff={openGitDiff}
              onEntryRenamed={onEntryRenamed}
              onEntryDeleted={onEntryDeleted}
              visible={explorerVisible}
              width={explorerWidth}
              workspaceRoot={workspaceRoot}
            />
            {explorerVisible && (
              <ResizeHandle
                direction="vertical"
                label="Resize explorer panel"
                onMouseDown={(e) =>
                  beginResize(e, {
                    axis: "x",
                    startValue: explorerWidth,
                    min: 220,
                    max: 520,
                    setValue: setExplorerWidth,
                  })
                }
              />
            )}
            <GitPanel
              visible={gitVisible}
              width={gitWidth}
              workspaceRoot={workspaceRoot}
              gitStatus={gitStatus}
              onRefreshGitStatus={() =>
                workspaceRoot ? refreshGitStatus(workspaceRoot) : undefined
              }
            />
            {gitVisible && (
              <ResizeHandle
                direction="vertical"
                label="Resize git panel"
                onMouseDown={(e) =>
                  beginResize(e, {
                    axis: "x",
                    startValue: gitWidth,
                    min: 220,
                    max: 520,
                    setValue: setGitWidth,
                  })
                }
              />
            )}
            <ProjectGraphPanel
              visible={graphVisible}
              width={graphWidth}
              workspaceRoot={workspaceRoot}
              activePath={active?.path ?? null}
              onContextChange={setProjectContext}
            />
            {graphVisible && (
              <ResizeHandle
                direction="vertical"
                label="Resize project graph panel"
                onMouseDown={(e) =>
                  beginResize(e, {
                    axis: "x",
                    startValue: graphWidth,
                    min: 260,
                    max: 560,
                    setValue: setGraphWidth,
                  })
                }
              />
            )}
            <main
              className="workbench-main"
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                minWidth: 0,
                position: "relative",
              }}
            >
              <div className="editor-frame">
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
              {terminalVisible && (
                <ResizeHandle
                  direction="horizontal"
                  label="Resize terminal"
                  onMouseDown={(e) =>
                    beginResize(e, {
                      axis: "y",
                      startValue: terminalHeight,
                      min: 140,
                      max: 460,
                      reverse: true,
                      setValue: setTerminalHeight,
                    })
                  }
                />
              )}
              <TerminalPanel
                visible={terminalVisible}
                onToggle={() => setTerminalVisible((v) => !v)}
                theme={theme}
                height={terminalHeight}
                workspaceRoot={workspaceRoot}
              />
            </main>
            {aiVisible && (
              <ResizeHandle
                direction="vertical"
                label="Resize AI panel"
                onMouseDown={(e) =>
                  beginResize(e, {
                    axis: "x",
                    startValue: aiWidth,
                    min: 300,
                    max: 620,
                    reverse: true,
                    setValue: setAiWidth,
                  })
                }
              />
            )}
            {aiPanelIds.map((id) => (
              <AiPanel
                key={id}
                workspaceRoot={workspaceRoot}
                onFileWritten={onAgentWrote}
                onWorkspaceChanged={() =>
                  workspaceRoot ? refreshGitStatus(workspaceRoot) : undefined
                }
                visible={aiVisible}
                width={aiWidth}
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
              />
            ))}
              </>
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
      />
      {activeGitDiff && (
        <GitDiffWindow diff={activeGitDiff} onClose={() => setActiveGitDiff(null)} />
      )}
      <SkillsModal
        open={skillsVisible}
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
