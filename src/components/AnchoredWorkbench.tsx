import { lazy, Suspense, useRef, type ReactNode, type RefObject, type ComponentProps } from "react";
import type { Skill } from "../skills";
import type { Layout as PanelLayout } from "../panelLayout";
import type { AiPanelInstance } from "../hooks/usePanelLayout";
import type { RenderAiPanel } from "./ai/panelHost";
import { Sidebar } from "./Sidebar";
import { TabBar } from "./TabBar";
import { EditorArea } from "./EditorArea";
import { SearchPanel } from "./SearchPanel";
import { TerminalPanel } from "./TerminalPanel";
import { SplitPane } from "./SplitPane";
import type { ThemeId } from "../theme";

const FileViewerPanel = lazy(() => import("./FileViewerPanel").then((m) => ({ default: m.FileViewerPanel })));
const SkillsModal = lazy(() => import("./SkillsModal").then((m) => ({ default: m.SkillsModal })));

type Tab = {
  path: string;
  code: string;
  dirty: boolean;
  externalChanged?: boolean;
  diskCode?: string;
};
type Panel = "explorer" | "git" | "memory" | "skills" | "ai" | "runs" | "settings" | "profile";

type Props = {
  // Layout measurement + persistence plumbing
  workbenchRef: RefObject<HTMLDivElement | null>;
  workbenchSize: { w: number; h: number };
  onWorkbenchSize: (size: { w: number; h: number }) => void;
  panelLayout: PanelLayout;
  aiPanels: AiPanelInstance[];
  focusedPanel: string | null;
  zCounter: number;

  // Visibility / routing
  explorerVisible: boolean;
  terminalVisible: boolean;
  aiVisible: boolean;
  sidebarSlot2: Panel | null;
  searchVisible: boolean;
  workspaceRoot: string | null;
  active: Tab | null;
  language: string | null;
  theme: ThemeId;

  // Editor
  tabs: Tab[];
  activeIdx: number;
  editorFontSize: number;
  editorLineNumbers: boolean;
  editorWordWrap: boolean;
  editorMinimap: boolean;
  onSelectTab: (i: number) => void;
  onCloseTab: (i: number) => void;
  onChangeCode: (v: string) => void;
  setSearchVisible: (v: boolean) => void;
  onOpenFile: (p: string, content: string, position?: { line: number; column: number }) => void;
  onRootChange: (p: string | null) => void;
  onEntryRenamed: (oldPath: string, newPath: string) => void;
  onEntryDeleted: (path: string) => void;
  onFilePreview: (p: string | null) => void;
  setExplorerVisible: (v: boolean | ((cur: boolean) => boolean)) => void;
  setSidebarSlot2: (v: Panel | null | ((cur: Panel | null) => Panel | null)) => void;
  setTerminalVisible: (v: boolean | ((cur: boolean) => boolean)) => void;
  focusPanel: (id: string) => void;
  onMountEditor: (editor: Parameters<NonNullable<ComponentProps<typeof EditorArea>["onEditorMount"]>>[0]) => void;

  // Sidebar skills slot
  skills: Skill[];
  setSkills: (s: Skill[]) => void;
  reloadFilesystemSkills: () => Promise<void>;

  // The AI column renders through the App's AiPanel host — this shell only
  // chooses the surface knobs (width, closable). See components/ai/panelHost.
  renderAiPanel: RenderAiPanel;
  onPanelWidthChange: (panel: "explorer" | "ai", w: number) => void;
  onPanelHeightChange: (panel: "terminal", h: number) => void;

  // Quick view
  previewPath: string | null;
  onClosePreview: () => void;
};

// Anchored workbench — the calm, fullscreen surface. A single 1px-bordered
// frame that fills the workbench, with three columns (side | editor | ai)
// and an optional terminal row at the bottom. No drag handles, no floating
// panels, no resize grips. The user still resizes side/ai via the splitter
// rails and the terminal via its drag handle, but nothing "wanders".
export function AnchoredWorkbench(props: Props) {
  const {
    workbenchRef,
    panelLayout,
    explorerVisible,
    sidebarSlot2,
    terminalVisible,
    aiVisible,
    aiPanels,
    tabs,
    activeIdx,
    workspaceRoot,
    searchVisible,
    onSelectTab,
    onCloseTab,
    onChangeCode,
    setSearchVisible,
    onOpenFile,
    onRootChange,
    onEntryRenamed,
    onEntryDeleted,
    onFilePreview,
    active,
    language,
    theme,
    editorFontSize,
    editorLineNumbers,
    editorWordWrap,
    editorMinimap,
    onMountEditor,
    setSidebarSlot2,
    skills,
    setSkills,
    reloadFilesystemSkills,
    renderAiPanel,
    onPanelWidthChange,
    onPanelHeightChange,
    previewPath,
    onClosePreview,
  } = props;

  const sideVisible = explorerVisible;
  const sidePanelWidth = panelLayout.explorer?.w ?? 280;
  const aiPanel = aiPanels[0];
  const aiPanelWidth = aiPanel?.rect.w ?? 360;
  const terminalHeight = panelLayout.terminal?.h ?? 220;

  // The side column shows explorer; ⌘+click in the activity bar can stack
  // skills below it via a SplitPane (matches the existing behaviour).
  const renderSide = () => {
    if (!sideVisible) return null;
    const explorer = (
      <Sidebar
        fill
        visible
        width={sidePanelWidth}
        workspaceRoot={workspaceRoot}
        onOpen={onOpenFile}
        onRootChange={onRootChange}
        onEntryRenamed={onEntryRenamed}
        onEntryDeleted={onEntryDeleted}
        onFilePreview={onFilePreview}
        activePath={active?.path ?? null}
      />
    );
    if (sidebarSlot2 === "skills") {
      return (
        <SplitPane
          top={explorer}
          bottom={
            <Suspense fallback={null}>
              <SkillsModal
                open
                skills={skills}
                onChange={setSkills}
                onReloadFilesystemSkills={reloadFilesystemSkills}
                onClose={() => setSidebarSlot2(null)}
              />
            </Suspense>
          }
          defaultSplit={(sidePanelWidth) * 0.55}
          minPane={80}
        />
      );
    }
    return explorer;
  };

  // Editor column = TabBar (when tabs exist) + SearchPanel + Monaco. The
  // background is the workbench surface, not a tinted card — the editor
  // sits inline with the AI column and the side panel.
  const renderEditor = () => (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        background: "transparent",
      }}
    >
      {tabs.length > 0 && (
        <TabBar
          tabs={tabs.map((t) => ({ path: t.path, dirty: t.dirty }))}
          activeIdx={activeIdx}
          onSelect={onSelectTab}
          onClose={onCloseTab}
          workspaceRoot={workspaceRoot}
        />
      )}
      <SearchPanel
        workspaceRoot={workspaceRoot}
        visible={searchVisible}
        onClose={() => setSearchVisible(false)}
        onOpenFile={onOpenFile}
      />
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <EditorArea
          code={active?.code ?? ""}
          onChange={onChangeCode}
          language={language ?? "plaintext"}
          hasFile={active !== null}
          theme={theme}
          fontSize={editorFontSize}
          lineNumbers={editorLineNumbers}
          wordWrap={editorWordWrap}
          minimap={editorMinimap}
          onEditorMount={onMountEditor}
        />
      </div>
    </div>
  );

  // The AI column. In anchored mode we keep ONE AI panel per workspace — the
  // multi-AI-panel "duplicate" feature is a bento affordance that doesn't fit
  // the calm surface. Mission Control handoff still creates a panel and
  // picks the first one; subsequent ones can be addressed in a follow-up.
  //
  // If `aiVisible` is on but `aiPanels` is empty (round-trip anchored ↔ free
  // can momentarily drop the in-memory list), the host falls back to the
  // default "ai-main" slot so the panel still renders; App will re-seed
  // `aiPanels` on the next interaction.
  const renderAi = () => {
    if (!aiVisible) return null;
    return renderAiPanel(aiPanel, {
      width: aiPanelWidth,
      duplicatable: true,
      closable: aiPanels.length > 1,
    });
  };

  return (
    <div
      ref={workbenchRef}
      className="workbench-main"
      data-anchored="true"
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        padding: 0,
        position: "relative",
        display: "flex",
        // The whole workbench is one calm surface — no frame, no card
        // backgrounds. Hairline gaps between regions, identical surface
        // treatment as the surrounding chrome.
        background: "var(--bg)",
      }}
    >
      <div
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          display: "grid",
          gridTemplateRows: terminalVisible
            ? `minmax(0, 1fr) 1px ${terminalHeight}px`
            : "1fr",
          gridTemplateColumns: "1fr",
          overflow: "hidden",
        }}
      >
        {/* Top row: side | editor | ai */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: sideVisible
              ? `${sidePanelWidth}px 1px minmax(0, 1fr)${aiVisible ? ` 1px ${aiPanelWidth}px` : ""}`
              : aiVisible
                ? `minmax(0, 1fr) 1px ${aiPanelWidth}px`
                : "1fr",
            minHeight: 0,
            minWidth: 0,
            overflow: "hidden",
          }}
        >
          {sideVisible && (
            <>
              <ColumnSurface>{renderSide()}</ColumnSurface>
              <SideSplitter
                side="left"
                current={sidePanelWidth}
                onChange={(w) => onPanelWidthChange("explorer", clamp(w, 200, 520))}
              />
            </>
          )}
          <ColumnSurface>{renderEditor()}</ColumnSurface>
          {aiVisible && (
            <>
              <SideSplitter
                side="right"
                current={aiPanelWidth}
                onChange={(w) => onPanelWidthChange("ai", clamp(w, 300, 620))}
              />
              <ColumnSurface>{renderAi()}</ColumnSurface>
            </>
          )}
        </div>

        {/* Terminal row */}
        {terminalVisible && (
          <>
            <TerminalSplitter
              current={terminalHeight}
              onChange={(h) => onPanelHeightChange("terminal", clamp(h, 140, 460))}
            />
            <ColumnSurface>
              <TerminalPanel
                fill
                visible
                theme={theme}
                height={terminalHeight}
                workspaceRoot={workspaceRoot}
                onToggle={() => {}}
              />
            </ColumnSurface>
          </>
        )}
      </div>

      {/* Quick view overlay — anchored to the workbench top-right, not a
          floating window. */}
      {previewPath && (
        <div
          style={{
            position: "absolute",
            right: 14,
            top: 14,
            width: 460,
            maxHeight: "calc(100% - 28px)",
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
              onClose={onClosePreview}
            />
          </Suspense>
        </div>
      )}
    </div>
  );
}

function ColumnSurface({ children }: { children: ReactNode }) {
  // A region inside the anchored workbench. No card, no border, no inset
  // highlight — the whole workbench is one surface, tiles meet at hairlines.
  return (
    <div
      style={{
        minWidth: 0,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        background: "transparent",
      }}
    >
      {children}
    </div>
  );
}

// A 1px-wide draggable gutter that lives between two columns. On hover, the
// gutter shifts to a sage accent so the user can see where to grab. On
// drag, we read the new column width from `current + dx` (for the left
// splitter) or `current - dx` (for the right splitter).
function SideSplitter({
  side,
  current,
  onChange,
}: {
  side: "left" | "right";
  current: number;
  onChange: (next: number) => void;
}) {
  // The column itself is 1px so the layout hairline stays crisp. A 1px-wide
  // drag target is impossible to hit, so we overlay a wider invisible hit zone
  // (centered, overflowing both sides) that catches the drag and lights up the
  // visible line on hover.
  function beginDrag(e: React.MouseEvent, line: HTMLElement | null) {
    e.preventDefault();
    const startX = e.clientX;
    const start = current;
    const previousCursor = document.body.style.cursor;
    const previousSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    if (line) line.style.background = "var(--accent-soft)";
    function onMove(ev: MouseEvent) {
      const dx = ev.clientX - startX;
      const next = side === "left" ? start + dx : start - dx;
      onChange(next);
    }
    function onUp() {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelect;
      if (line) line.style.background = "var(--border)";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  const lineRef = useRef<HTMLDivElement>(null);

  return (
    <div
      ref={lineRef}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${side} panel`}
      style={{
        background: "var(--border)",
        position: "relative",
        transition: "background var(--motion-fast) var(--ease-out)",
      }}
    >
      {/* Invisible grab zone — wider than the 1px line, overflows both sides. */}
      <div
        onMouseDown={(e) => beginDrag(e, lineRef.current)}
        onMouseEnter={() => {
          if (lineRef.current) lineRef.current.style.background = "var(--accent-soft)";
        }}
        onMouseLeave={() => {
          if (lineRef.current) lineRef.current.style.background = "var(--border)";
        }}
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: -5,
          right: -5,
          cursor: "col-resize",
          zIndex: 5,
        }}
      />
    </div>
  );
}

function TerminalSplitter({
  current,
  onChange,
}: {
  current: number;
  onChange: (next: number) => void;
}) {
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize terminal"
      onMouseDown={(e) => {
        e.preventDefault();
        const startY = e.clientY;
        const start = current;
        const previousCursor = document.body.style.cursor;
        const previousSelect = document.body.style.userSelect;
        document.body.style.cursor = "row-resize";
        document.body.style.userSelect = "none";
        function onMove(ev: MouseEvent) {
          const dy = ev.clientY - startY;
          onChange(start - dy);
        }
        function onUp() {
          document.body.style.cursor = previousCursor;
          document.body.style.userSelect = previousSelect;
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
        }
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
      }}
      style={{
        background: "var(--border)",
        cursor: "row-resize",
        position: "relative",
        transition: "background var(--motion-fast) var(--ease-out)",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--accent-soft)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "var(--border)")}
    />
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
