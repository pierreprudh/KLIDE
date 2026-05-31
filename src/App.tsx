import {
  useEffect,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { readTextFile, watch, writeTextFile } from "@tauri-apps/plugin-fs";
import { ActivityBar } from "./components/ActivityBar";
import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { EditorArea } from "./components/EditorArea";
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
import { loadSkills, saveSkills, type Skill } from "./skills";
import {
  loadCustomPresets,
  saveCustomPresets,
  type LayoutPreset,
} from "./layouts";
import { loadGridLayouts, type GridLayout, type PanelKind } from "./gridLayouts";
import { GridWorkbench } from "./components/GridWorkbench";
import "./styles/tokens.css";

type Panel = "explorer" | "git" | "graph" | "skills" | "ai" | "settings";
type Tab = { path: string; code: string; dirty: boolean; externalChanged?: boolean };
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
  const [view, setView] = useState<"workbench" | "settings">("workbench");
  const [explorerVisible, setExplorerVisible] = useState(
    () => localStorage.getItem("klide-explorer-visible") !== "false"
  );
  const [gitVisible, setGitVisible] = useState(
    () => localStorage.getItem("klide-git-visible") === "true"
  );
  const [graphVisible, setGraphVisible] = useState(
    () => localStorage.getItem("klide-graph-visible") === "true"
  );
  const [skillsVisible, setSkillsVisible] = useState(
    () => localStorage.getItem("klide-skills-visible") === "true"
  );
  const [aiVisible, setAiVisible] = useState(
    () => localStorage.getItem("klide-ai-visible") !== "false"
  );
  const [aiPanelIds, setAiPanelIds] = useState<string[]>(["ai-main"]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeIdx, setActiveIdx] = useState<number>(-1);
  const [fileNotice, setFileNotice] = useState<string | null>(null);
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [activeGitDiff, setActiveGitDiff] = useState<GitDiff | null>(null);
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);
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
    () => localStorage.getItem("klide-ollama-model") || DEFAULT_AI_MODEL
  );
  const [ollamaModels, setOllamaModels] = useState<string[]>([aiModel]);
  const [requireDiffReview, setRequireDiffReview] = useState(() =>
    readBoolSetting("klide-confirm-agent-edits", true)
  );
  const [stopAfterRejection, setStopAfterRejection] = useState(() =>
    readBoolSetting("klide-stop-after-rejection", true)
  );
  const active = activeIdx >= 0 ? tabs[activeIdx] : null;
  const activeGrid =
    activeGridId != null
      ? gridLayouts.find((g) => g.id === activeGridId) ?? null
      : null;
  const activityState: Record<Panel, boolean> = {
    explorer: view === "workbench" && explorerVisible,
    git: view === "workbench" && gitVisible,
    graph: view === "workbench" && graphVisible,
    skills: view === "workbench" && skillsVisible,
    settings: view === "settings",
    ai: view === "workbench" && aiVisible,
  };

  function togglePanel(panel: Panel) {
    if (panel === "settings") {
      setSettingsInitial(null);
      setView("settings");
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
            <EditorArea
              code={active?.code ?? ""}
              onChange={updateActiveCode}
              language={language ?? "plaintext"}
              hasFile={active !== null}
              workspaceOpen={workspaceRoot !== null}
              theme={theme}
              fontSize={editorFontSize}
              lineNumbers={editorLineNumbers}
              wordWrap={editorWordWrap}
              minimap={editorMinimap}
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
            model={aiModel}
            onModelChange={setAiModel}
            availableModels={ollamaModels}
            onAvailableModelsChange={setOllamaModels}
            requireDiffReview={requireDiffReview}
            stopAfterRejection={stopAfterRejection}
            skills={skills}
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

  function openFile(p: string, content: string) {
    const existing = tabs.findIndex((t) => t.path === p);
    if (existing >= 0) {
      setActiveIdx(existing);
      return;
    }
    setTabs([...tabs, { path: p, code: content, dirty: false, externalChanged: false }]);
    setActiveIdx(tabs.length);
  }

  function updateActiveCode(v: string) {
    if (activeIdx < 0) return;
    setTabs(
      tabs.map((t, i) => (i === activeIdx ? { ...t, code: v, dirty: true } : t))
    );
  }

  function closeTab(i: number) {
    const closing = tabs[i];
    if (closing?.dirty) {
      const ok = window.confirm(`Close ${filename(closing.path)} with unsaved changes?`);
      if (!ok) return;
    }
    const next = tabs.filter((_, idx) => idx !== i);
    setTabs(next);
    if (next.length === 0) setActiveIdx(-1);
    else if (i < activeIdx) setActiveIdx(activeIdx - 1);
    else if (i === activeIdx) setActiveIdx(Math.min(activeIdx, next.length - 1));
  }

  async function saveActive() {
    if (!active) return;
    if (active.externalChanged) {
      const ok = window.confirm(
        `${filename(active.path)} changed on disk while you were editing. Save anyway and overwrite the disk version?`
      );
      if (!ok) return;
    }
    await writeTextFile(active.path, active.code);
    setTabs((cur) =>
      cur.map((t, i) =>
        i === activeIdx ? { ...t, dirty: false, externalChanged: false } : t
      )
    );
    setFileNotice(`Saved ${filename(active.path)}`);
  }

  function onAgentWrote(path: string, newContent: string) {
    setTabs((cur) =>
      cur.map((t) =>
        t.path === path
          ? { ...t, code: newContent, dirty: false, externalChanged: false }
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
    localStorage.setItem("klide-explorer-visible", String(explorerVisible));
  }, [explorerVisible]);

  useEffect(() => {
    localStorage.setItem("klide-git-visible", String(gitVisible));
  }, [gitVisible]);

  useEffect(() => {
    localStorage.setItem("klide-graph-visible", String(graphVisible));
  }, [graphVisible]);

  useEffect(() => {
    localStorage.setItem("klide-skills-visible", String(skillsVisible));
  }, [skillsVisible]);

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
    setSkills(next);
    saveSkills(next);
  }

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
    localStorage.setItem("klide-ollama-model", aiModel);
  }, [aiModel]);

  useEffect(() => {
    localStorage.setItem("klide-confirm-agent-edits", String(requireDiffReview));
  }, [requireDiffReview]);

  useEffect(() => {
    localStorage.setItem("klide-stop-after-rejection", String(stopAfterRejection));
  }, [stopAfterRejection]);

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
                  if (tab.path !== path || tab.code === diskCode) {
                    return tab.path === path
                      ? { ...tab, externalChanged: false }
                      : tab;
                  }
                  if (tab.dirty) {
                    setFileNotice(`${filename(path)} changed on disk`);
                    return { ...tab, externalChanged: true };
                  }
                  setFileNotice(`Reloaded ${filename(path)}`);
                  return { ...tab, code: diskCode, externalChanged: false };
                })
              );
            })
            .catch(() => {
              if (cancelled) return;
              setTabs((cur) =>
                cur.map((tab) =>
                  tab.path === path ? { ...tab, externalChanged: true } : tab
                )
              );
              setFileNotice(`${filename(path)} is unavailable on disk`);
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
      if ((e.metaKey || e.ctrlKey) && e.key === "s" && active) {
        e.preventDefault();
        saveActive();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "`") {
        e.preventDefault();
        setTerminalVisible((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, activeIdx, tabs]);

  const language = active ? detectLanguage(active.path) : null;

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
            explorerVisible={explorerVisible}
            customLayouts={customLayouts}
            onCustomLayoutsChange={updateCustomLayouts}
            onApplyLayout={applyLayout}
            onBack={() => setView("workbench")}
          />
        ) : (
          <>
            <ActivityBar active={activityState} onToggle={togglePanel} />
            {activeGrid ? (
              <GridWorkbench layout={activeGrid} renderPanel={renderPanel} />
            ) : (
              <>
            <Sidebar
              onOpen={openFile}
              onRootChange={setWorkspaceRoot}
              onOpenGitDiff={openGitDiff}
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
                <EditorArea
                  code={active?.code ?? ""}
                  onChange={updateActiveCode}
                  language={language ?? "plaintext"}
                  hasFile={active !== null}
                  workspaceOpen={workspaceRoot !== null}
                  theme={theme}
                  fontSize={editorFontSize}
                  lineNumbers={editorLineNumbers}
                  wordWrap={editorWordWrap}
                  minimap={editorMinimap}
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
                visible={aiVisible}
                width={aiWidth}
                model={aiModel}
                onModelChange={setAiModel}
                availableModels={ollamaModels}
                onAvailableModelsChange={setOllamaModels}
                requireDiffReview={requireDiffReview}
                stopAfterRejection={stopAfterRejection}
                skills={skills}
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
    </div>
  );
}

export default App;
