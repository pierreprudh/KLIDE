import {
  useRef,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  SIZE_OPTIONS,
  fractionForSize,
  nearestSize,
  type RegionConfig,
  type RegionSize,
} from "../layouts";

type RegionId = "files" | "ai" | "terminal";

type Props = {
  files: RegionConfig;
  ai: RegionConfig;
  terminal: RegionConfig;
  onFilesChange: (config: RegionConfig) => void;
  onAiChange: (config: RegionConfig) => void;
  onTerminalChange: (config: RegionConfig) => void;
};

// Fraction of the canvas given to a region's "off" strip — just enough to be a
// clickable target that says "+ add this panel".
const OFF_STRIP = 0.07;

function sizeLabel(size: RegionSize): string {
  return SIZE_OPTIONS.find((option) => option.id === size)?.label ?? size;
}

export function LayoutCanvas({
  files,
  ai,
  terminal,
  onFilesChange,
  onAiChange,
  onTerminalChange,
}: Props) {
  const canvasRef = useRef<HTMLDivElement>(null);

  const setters: Record<RegionId, (config: RegionConfig) => void> = {
    files: onFilesChange,
    ai: onAiChange,
    terminal: onTerminalChange,
  };
  const configs: Record<RegionId, RegionConfig> = { files, ai, terminal };

  function beginDrag(region: RegionId, e: ReactMouseEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const horizontal = region !== "terminal";
    document.body.style.cursor = horizontal ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";

    function onMove(ev: MouseEvent) {
      let fraction: number;
      if (region === "files") fraction = (ev.clientX - rect!.left) / rect!.width;
      else if (region === "ai") fraction = (rect!.right - ev.clientX) / rect!.width;
      else fraction = (rect!.bottom - ev.clientY) / rect!.height;
      fraction = Math.min(0.5, Math.max(0.1, fraction));
      setters[region]({ on: true, size: nearestSize(fraction) });
    }
    function onUp() {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  const filesPct = (files.on ? fractionForSize(files.size) : OFF_STRIP) * 100;
  const aiPct = (ai.on ? fractionForSize(ai.size) : OFF_STRIP) * 100;
  const termPct = (terminal.on ? fractionForSize(terminal.size) : OFF_STRIP) * 100;

  function RemoveDot({ region }: { region: RegionId }) {
    return (
      <button
        type="button"
        aria-label={`Remove ${region}`}
        title="Remove from layout"
        onClick={(e) => {
          e.stopPropagation();
          setters[region]({ ...configs[region], on: false });
        }}
        style={{
          position: "absolute",
          top: 5,
          right: 5,
          width: 16,
          height: 16,
          borderRadius: "50%",
          border: "none",
          background: "var(--bg-elevated)",
          color: "var(--fg-subtle)",
          fontSize: 12,
          lineHeight: "14px",
          display: "grid",
          placeItems: "center",
          cursor: "pointer",
        }}
      >
        ×
      </button>
    );
  }

  function OnRegion({
    region,
    title,
    edge,
  }: {
    region: RegionId;
    title: string;
    edge: "right" | "left" | "top";
  }) {
    const config = configs[region];
    const handleStyle: CSSProperties =
      edge === "top"
        ? { left: 0, right: 0, top: -3, height: 7, cursor: "row-resize" }
        : edge === "right"
        ? { top: 0, bottom: 0, right: -3, width: 7, cursor: "col-resize" }
        : { top: 0, bottom: 0, left: -3, width: 7, cursor: "col-resize" };
    return (
      <div
        style={{
          position: "relative",
          height: "100%",
          borderRadius: "var(--radius-sm)",
          border: "1px solid var(--accent)",
          background: "var(--accent-soft)",
          display: "grid",
          placeItems: "center",
          overflow: "hidden",
          userSelect: "none",
        }}
      >
        <div style={{ textAlign: "center", padding: 4 }}>
          <div style={{ color: "var(--accent)", fontSize: 12 }}>{title}</div>
          <div style={{ color: "var(--fg-subtle)", fontSize: 10, marginTop: 2 }}>
            {sizeLabel(config.size)}
          </div>
        </div>
        <RemoveDot region={region} />
        <div
          role="separator"
          aria-label={`Resize ${title}`}
          onMouseDown={(e) => beginDrag(region, e)}
          style={{ position: "absolute", ...handleStyle, zIndex: 2 }}
        />
      </div>
    );
  }

  function OffStrip({ region, title }: { region: RegionId; title: string }) {
    return (
      <button
        type="button"
        title={`Add ${title}`}
        onClick={() => setters[region]({ ...configs[region], on: true })}
        style={{
          height: "100%",
          width: "100%",
          borderRadius: "var(--radius-sm)",
          border: "1px dashed var(--border-strong)",
          background: "transparent",
          color: "var(--fg-subtle)",
          fontSize: 11,
          cursor: "pointer",
          writingMode: region === "terminal" ? "horizontal-tb" : "vertical-rl",
        }}
      >
        + {title}
      </button>
    );
  }

  return (
    <div style={{ padding: "16px 18px" }}>
      <div
        ref={canvasRef}
        style={{
          display: "grid",
          gridTemplateColumns: `${filesPct}% minmax(0, 1fr) ${aiPct}%`,
          gap: 6,
          height: 230,
          padding: 8,
          borderRadius: "var(--radius-md)",
          border: "1px solid var(--border)",
          background: "var(--bg)",
        }}
      >
        {/* Left: Files */}
        {files.on ? (
          <OnRegion region="files" title="Files" edge="right" />
        ) : (
          <OffStrip region="files" title="Files" />
        )}

        {/* Center: Editor over Terminal */}
        <div
          style={{
            display: "grid",
            gridTemplateRows: `minmax(0, 1fr) ${termPct}%`,
            gap: 6,
            minWidth: 0,
          }}
        >
          <div
            style={{
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--border-strong)",
              background: "var(--bg-elevated)",
              display: "grid",
              placeItems: "center",
              color: "var(--fg-subtle)",
              fontSize: 12,
            }}
          >
            Editor
          </div>
          {terminal.on ? (
            <OnRegion region="terminal" title="Terminal" edge="top" />
          ) : (
            <OffStrip region="terminal" title="Terminal" />
          )}
        </div>

        {/* Right: AI */}
        {ai.on ? (
          <OnRegion region="ai" title="AI" edge="left" />
        ) : (
          <OffStrip region="ai" title="AI" />
        )}
      </div>
      <div
        style={{
          marginTop: 8,
          fontSize: 11,
          color: "var(--fg-subtle)",
          fontFamily: "var(--font-ui)",
        }}
      >
        Drag a panel's edge to resize · click a dashed strip to add · × to remove
      </div>
    </div>
  );
}
