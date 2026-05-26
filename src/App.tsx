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
import { SettingsPanel } from "./components/SettingsPanel";
import "./styles/tokens.css";

type LeftPanel = "explorer" | "git" | "settings";
type Panel = LeftPanel | "ai";
type Tab = { path: string; code: string; dirty: boolean };
type Theme = "light" | "dark";

function readNumberSetting(key: string, fallback: number, min: number, max: number): number {
  const raw = Number(localStorage.getItem(key));
  return Number.isFinite(raw) ? clamp(raw, min, max) : fallback;
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
  const [leftPanel, setLeftPanel] = useState<LeftPanel | null>(() => {
    const stored = localStorage.getItem("kide-left-panel");
    return stored === "explorer" || stored === "git" || stored === "settings"
      ? stored
      : stored === "none"
      ? null
      : "explorer";
  });
  const [aiVisible, setAiVisible] = useState(
    () => localStorage.getItem("kide-ai-visible") !== "false"
  );
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeIdx, setActiveIdx] = useState<number>(-1);
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);
  const [terminalVisible, setTerminalVisible] = useState(
    () => localStorage.getItem("kide-terminal-visible") === "true"
  );
  const [explorerWidth, setExplorerWidth] = useState(() =>
    readNumberSetting("kide-left-width", 280, 220, 520)
  );
  const [aiWidth, setAiWidth] = useState(() =>
    readNumberSetting("kide-ai-width", 380, 300, 620)
  );
  const [terminalHeight, setTerminalHeight] = useState(() =>
    readNumberSetting("kide-terminal-height", 240, 140, 460)
  );
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = localStorage.getItem("kide-theme");
    return stored === "dark" || stored === "light" ? stored : "light";
  });
  const active = activeIdx >= 0 ? tabs[activeIdx] : null;
  const activityState: Record<Panel, boolean> = {
    explorer: leftPanel === "explorer",
    git: leftPanel === "git",
    settings: leftPanel === "settings",
    ai: aiVisible,
  };

  function togglePanel(panel: Panel) {
    if (panel === "ai") {
      setAiVisible((cur) => !cur);
      return;
    }
    setLeftPanel((cur) => (cur === panel ? null : panel));
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

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("kide-theme", theme);
  }, [theme]);

  useEffect(() => {
    if (leftPanel) localStorage.setItem("kide-left-panel", leftPanel);
    else localStorage.setItem("kide-left-panel", "none");
  }, [leftPanel]);

  useEffect(() => {
    localStorage.setItem("kide-ai-visible", String(aiVisible));
  }, [aiVisible]);

  useEffect(() => {
    localStorage.setItem("kide-terminal-visible", String(terminalVisible));
  }, [terminalVisible]);

  useEffect(() => {
    localStorage.setItem("kide-left-width", String(explorerWidth));
  }, [explorerWidth]);

  useEffect(() => {
    localStorage.setItem("kide-ai-width", String(aiWidth));
  }, [aiWidth]);

  useEffect(() => {
    localStorage.setItem("kide-terminal-height", String(terminalHeight));
  }, [terminalHeight]);

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
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <ActivityBar active={activityState} onToggle={togglePanel} />
        <Sidebar
          onOpen={openFile}
          onRootChange={setWorkspaceRoot}
          visible={leftPanel === "explorer"}
          width={explorerWidth}
        />
        <GitPanel
          visible={leftPanel === "git"}
          width={explorerWidth}
          workspaceRoot={workspaceRoot}
        />
        <SettingsPanel
          visible={leftPanel === "settings"}
          width={explorerWidth}
          theme={theme}
          onThemeChange={setTheme}
        />
        {leftPanel && (
          <ResizeHandle
            direction="vertical"
            label={`Resize ${leftPanel} panel`}
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
        <AiPanel
          workspaceRoot={workspaceRoot}
          onFileWritten={onAgentWrote}
          visible={aiVisible}
          width={aiWidth}
        />
      </div>
      <StatusBar
        path={active?.path ?? null}
        language={language}
        workspaceRoot={workspaceRoot}
        terminalVisible={terminalVisible}
        onToggleTerminal={() => setTerminalVisible((v) => !v)}
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
      />
    </div>
  );
}

export default App;
