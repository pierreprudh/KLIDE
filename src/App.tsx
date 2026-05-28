import { useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { ActivityBar } from "./components/ActivityBar";
import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { EditorArea } from "./components/EditorArea";
import { TerminalPanel } from "./components/TerminalPanel";
import { AiPanel } from "./components/AiPanel";
import { StatusBar } from "./components/StatusBar";
import { GitPanel } from "./components/GitPanel";
import { ProjectGraphPanel } from "./components/ProjectGraphPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { getNextThemeId, normalizeThemeId, type ThemeId } from "./theme";
import "./styles/tokens.css";

type Panel = "explorer" | "git" | "graph" | "ai" | "settings";
type Tab = { path: string; code: string; dirty: boolean };
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
  const [aiVisible, setAiVisible] = useState(
    () => localStorage.getItem("klide-ai-visible") !== "false"
  );
  const [aiPanelIds, setAiPanelIds] = useState<string[]>(["ai-main"]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeIdx, setActiveIdx] = useState<number>(-1);
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
  const activityState: Record<Panel, boolean> = {
    explorer: view === "workbench" && explorerVisible,
    git: view === "workbench" && gitVisible,
    graph: view === "workbench" && graphVisible,
    settings: view === "settings",
    ai: view === "workbench" && aiVisible,
  };

  function togglePanel(panel: Panel) {
    if (panel === "settings") {
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
    setTabs([...tabs, { path: p, code: content, dirty: false }]);
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
      const filename = closing.path.split("/").pop() ?? closing.path;
      const ok = window.confirm(`Close ${filename} with unsaved changes?`);
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
    await writeTextFile(active.path, active.code);
    setTabs((cur) =>
      cur.map((t, i) => (i === activeIdx ? { ...t, dirty: false } : t))
    );
  }

  function onAgentWrote(path: string, newContent: string) {
    setTabs((cur) =>
      cur.map((t) =>
        t.path === path ? { ...t, code: newContent, dirty: false } : t
      )
    );
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
    localStorage.setItem("klide-ollama-model", aiModel);
  }, [aiModel]);

  useEffect(() => {
    localStorage.setItem("klide-confirm-agent-edits", String(requireDiffReview));
  }, [requireDiffReview]);

  useEffect(() => {
    localStorage.setItem("klide-stop-after-rejection", String(stopAfterRejection));
  }, [stopAfterRejection]);

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
            aiModel={aiModel}
            onAiModelChange={setAiModel}
            availableAiModels={ollamaModels}
            requireDiffReview={requireDiffReview}
            onRequireDiffReviewChange={setRequireDiffReview}
            stopAfterRejection={stopAfterRejection}
            onStopAfterRejectionChange={setStopAfterRejection}
            onBack={() => setView("workbench")}
          />
        ) : (
          <>
            <ActivityBar active={activityState} onToggle={togglePanel} />
            <Sidebar
              onOpen={openFile}
              onRootChange={setWorkspaceRoot}
              visible={explorerVisible}
              width={explorerWidth}
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
                onDuplicate={duplicateAiPanel}
                onClose={
                  aiPanelIds.length > 1 ? () => closeAiPanel(id) : undefined
                }
              />
            ))}
          </>
        )}
      </div>
      <StatusBar
        path={active?.path ?? null}
        language={language}
        workspaceRoot={workspaceRoot}
        terminalVisible={terminalVisible}
        onToggleTerminal={() => setTerminalVisible((v) => !v)}
        theme={theme}
        onToggleTheme={() => setTheme((t) => getNextThemeId(t))}
      />
    </div>
  );
}

export default App;
