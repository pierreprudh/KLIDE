import { useEffect, useState } from "react";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { ActivityBar } from "./components/ActivityBar";
import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { EditorArea } from "./components/EditorArea";
import { TerminalPanel } from "./components/TerminalPanel";
import { AiPanel } from "./components/AiPanel";
import { StatusBar } from "./components/StatusBar";
import "./styles/tokens.css";

type View = "explorer" | "ai";
type Tab = { path: string; code: string; dirty: boolean };

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
  const [view, setView] = useState<View>("explorer");
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeIdx, setActiveIdx] = useState<number>(-1);
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);
  const active = activeIdx >= 0 ? tabs[activeIdx] : null;

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
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "s" && active) {
        e.preventDefault();
        saveActive();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, activeIdx, tabs]);

  const language = active ? detectLanguage(active.path) : null;

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <ActivityBar active={view} onChange={setView} />
        {view === "explorer" && (
          <Sidebar onOpen={openFile} onRootChange={setWorkspaceRoot} />
        )}
        <main
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
          }}
        >
          <TabBar
            tabs={tabs.map((t) => ({ path: t.path, dirty: t.dirty }))}
            activeIdx={activeIdx}
            onSelect={setActiveIdx}
            onClose={closeTab}
          />
          <EditorArea
            code={active?.code ?? ""}
            onChange={updateActiveCode}
            language={language ?? "plaintext"}
            hasFile={active !== null}
          />
          <TerminalPanel />
        </main>
        <AiPanel
          workspaceRoot={workspaceRoot}
          onFileWritten={onAgentWrote}
          visible={view === "ai"}
        />
      </div>
      <StatusBar path={active?.path ?? null} language={language} />
    </div>
  );
}

export default App;
