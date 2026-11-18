import { lazy, Suspense, useRef, useState, type ReactNode, type RefObject, type ComponentProps } from "react";
import { beginDragSession } from "../dragSession";
import { clamp } from "./settings/controls";
import type { Skill } from "../skills";
import type { Layout as PanelLayout } from "../panelLayout";
import type { AiPanelInstance } from "../hooks/usePanelLayout";
import type { RenderAiPanel } from "./ai/panelHost";
import { Sidebar } from "./Sidebar";
import { TabBar } from "./TabBar";
import { EditorArea } from "./lazySurfaces";
import { ImageView } from "./ImageView";
import { SearchPanel } from "./SearchPanel";
import { TerminalPanel } from "./lazySurfaces";
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
  dataUri?: string;
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
  // A splitter drag rewrites the column widths on every mouse move. The reveal
  // transition on those same widths would make the column trail the pointer,
  // so it is switched off for the length of the drag.
  const [resizing, setResizing] = useState(false);
  const sidePanelWidth = panelLayout.explorer?.w ?? 280;
  const aiPanel = aiPanels[0];
  const aiPanelWidth = aiPanel?.rect.w ?? 360;
  const terminalHeight = panelLayout.terminal?.h ?? 220;

  // The side column shows explorer; ⌘+click in the activity bar can stack
  // skills below it via a SplitPane (matches the existing behaviour).
  // The side column is always in the grid so its width can animate: the track
  // goes 0 → sidePanelWidth and back, and this content keeps its full width
  // underneath, so the column clips like a curtain instead of reflowing every
  // row on the way. The tree stays mounted while hidden — same folders, same
  // scroll when it comes back — and `active` stops it polling the disk.
  const renderSide = () => {
    const explorer = (
      <Sidebar
        fill
        visible
        active={sideVisible}
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
      const skillsPane = (
        <Suspense fallback={null}>
          <SkillsModal
            open
            skills={skills}
            onChange={setSkills}
            onReloadFilesystemSkills={reloadFilesystemSkills}
            onClose={() => setSidebarSlot2(null)}
          />
        </Suspense>
      );
      return (
        <div style={{ width: sidePanelWidth, flexShrink: 0, height: "100%", display: "flex", flexDirection: "column" }}>
          <SplitPane
            top={explorer}
            bottom={skillsPane}
            defaultSplit={sidePanelWidth * 0.55}
            minPane={80}
          />
        </div>
      );
    }
    return (
      <div style={{ width: sidePanelWidth, flexShrink: 0, height: "100%", display: "flex", flexDirection: "column" }}>
        {explorer}
      </div>
    );
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
          tabs={tabs.map((t) => ({ path: t.path, dirty: t.dirty, externalChanged: t.externalChanged }))}
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
        {active?.dataUri ? (
          <ImageView src={active.dataUri} name={active.path} />
        ) : (
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
        )}
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
          /* The side tracks are always present — 0px when the Explorer is
             closed — so the track list keeps its shape and the browser can
             interpolate grid-template-columns: the column slides open rather
             than appearing. (The AI tracks still come and go, so toggling the
             AI panel snaps as before.) */
          className="klide-anchored-columns"
          data-resizing={resizing || undefined}
          style={{
            display: "grid",
            gridTemplateColumns: `${sideVisible ? sidePanelWidth : 0}px ${sideVisible ? 1 : 0}px minmax(0, 1fr)${aiVisible ? ` 1px ${aiPanelWidth}px` : ""}`,
            minHeight: 0,
            minWidth: 0,
            overflow: "hidden",
          }}
        >
          <div className="klide-anchored-side" data-open={sideVisible ? "true" : "false"}>
            {renderSide()}
          </div>
          <div className="klide-anchored-splitter" data-open={sideVisible ? "true" : "false"}>
            <SideSplitter
              side="left"
              current={sidePanelWidth}
              onChange={(w) => onPanelWidthChange("explorer", clamp(w, 200, 520))}
              onDragging={setResizing}
              min={200}
              max={520}
            />
          </div>
          <ColumnSurface>{renderEditor()}</ColumnSurface>
          {aiVisible && (
            <>
              <SideSplitter
                side="right"
                current={aiPanelWidth}
                onChange={(w) => onPanelWidthChange("ai", clamp(w, 300, 620))}
                onDragging={setResizing}
                min={300}
                max={620}
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
              min={140}
              max={460}
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
  onDragging,
  min,
  max,
}: {
  side: "left" | "right";
  current: number;
  onChange: (next: number) => void;
  /** Reports the start and end of a drag, so the host can pause any width
   *  transition that would otherwise trail the pointer. */
  onDragging?: (dragging: boolean) => void;
  min: number;
  max: number;
}) {
  // The column itself is 1px so the layout hairline stays crisp. A 1px-wide
  // drag target is impossible to hit, so we overlay a wider invisible hit zone
  // (centered, overflowing both sides) that catches the drag and lights up the
  // visible line on hover.
  function beginDrag(e: React.MouseEvent, line: HTMLElement | null) {
    e.preventDefault();
    const startX = e.clientX;
    const start = current;
    if (line) line.style.background = "var(--accent-soft)";
    onDragging?.(true);
    function onMove(ev: MouseEvent) {
      const dx = ev.clientX - startX;
      const next = side === "left" ? start + dx : start - dx;
      onChange(next);
    }
    beginDragSession({
      cursor: "col-resize",
      onMove,
      onDone: () => {
        if (line) line.style.background = "var(--border)";
        onDragging?.(false);
      },
    });
  }

  const lineRef = useRef<HTMLDivElement>(null);

  // Keyboard equivalent of the drag: same clamp as the call site.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.key === "PageUp" || e.key === "PageDown" ? 48 : 16;
    let next: number | null = null;
    if (e.key === "ArrowLeft") next = side === "left" ? current - step : current + step;
    else if (e.key === "ArrowRight") next = side === "left" ? current + step : current - step;
    else if (e.key === "PageUp" || e.key === "PageDown") next = side === "left" ? current + (e.key === "PageDown" ? step : -step) : current - (e.key === "PageDown" ? step : -step);
    else if (e.key === "Home") next = min;
    else if (e.key === "End") next = max;
    if (next === null) return;
    e.preventDefault();
    onChange(clamp(next, min, max));
  };

  return (
    <div
      ref={lineRef}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${side} panel`}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(current)}
      tabIndex={0}
      onKeyDown={onKeyDown}
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
  min = 140,
  max = 460,
}: {
  current: number;
  onChange: (next: number) => void;
  min?: number;
  max?: number;
}) {
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.key === "PageUp" || e.key === "PageDown" ? 48 : 16;
    let next: number | null = null;
    if (e.key === "ArrowUp") next = current - step;
    else if (e.key === "ArrowDown") next = current + step;
    else if (e.key === "PageUp") next = current - step;
    else if (e.key === "PageDown") next = current + step;
    else if (e.key === "Home") next = min;
    else if (e.key === "End") next = max;
    if (next === null) return;
    e.preventDefault();
    onChange(clamp(next, min, max));
  };
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize terminal"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(current)}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onMouseDown={(e) => {
        e.preventDefault();
        const startY = e.clientY;
        const start = current;
        function onMove(ev: MouseEvent) {
          const dy = ev.clientY - startY;
          onChange(start - dy);
        }
        beginDragSession({
          cursor: "row-resize",
          onMove,
        });
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

