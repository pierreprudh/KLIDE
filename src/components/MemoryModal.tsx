import "./memoryPanel.css";
import { useEffect } from "react";
import { MemoryPanel } from "./MemoryPanel";
import { Z } from "../zLayers";

type Props = {
  open: boolean;
  workspaceRoot: string | null;
  /** Bumped when the AI panel writes a new entry, to force a refresh. */
  refreshKey?: number;
  /** Open a memory entry's raw markdown as an editor tab. */
  onOpenInEditor?: (path: string, content: string) => void;
  /** Open a source file referenced by a memory entry. */
  onOpenTouchedFile?: (path: string) => void;
  onClose: () => void;
};

function CloseIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

// Memory — same centered-overlay treatment as the Skills modal. Lives at
// the top level (not in a sidebar) so the list+detail layout has the room
// it needs. Escape closes; clicking the backdrop closes.
export function MemoryModal({
  open,
  workspaceRoot,
  refreshKey = 0,
  onOpenInEditor,
  onOpenTouchedFile,
  onClose,
}: Props) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Project memory"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: Z.modal,
        display: "grid",
        placeItems: "center",
        background: "rgba(0,0,0,0.16)",
        backdropFilter: "blur(2px)",
        WebkitBackdropFilter: "blur(2px)",
      }}
    >
      <div
        className="floating-panel memory-window"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(1080px, calc(100vw - 32px))",
          height: "min(680px, calc(100vh - 32px))",
          borderRadius: "var(--radius-lg)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <header
          style={{
            height: 50,
            flexShrink: 0,
            padding: "0 12px 0 16px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              color: "var(--fg-strong)",
              fontSize: 13.5,
              fontWeight: 600,
              letterSpacing: "-0.005em",
            }}
          >
            Memory
          </span>
          <div style={{ flex: 1 }} />
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              width: 30,
              height: 30,
              display: "grid",
              placeItems: "center",
              color: "var(--fg-subtle)",
              background: "transparent",
              border: "none",
              borderRadius: "var(--radius-sm)",
              cursor: "pointer",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--bg-hover)";
              e.currentTarget.style.color = "var(--fg-strong)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
              e.currentTarget.style.color = "var(--fg-subtle)";
            }}
          >
            <CloseIcon />
          </button>
        </header>

        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <MemoryPanel
            fill
            visible
            width={0}
            workspaceRoot={workspaceRoot}
            refreshKey={refreshKey}
            onOpenInEditor={onOpenInEditor}
            onOpenTouchedFile={onOpenTouchedFile}
          />
        </div>
      </div>
    </div>
  );
}
