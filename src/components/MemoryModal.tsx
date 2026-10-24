import "./sharedNotes.css";
import "./memoryPanel.css";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { MemoryPanel } from "./MemoryPanel";
import { Z } from "../zLayers";

import type { SharedNotesSeed } from "./ai/SharedNotesControl";
const SharedNotesEditor = lazy(() => import("./SharedNotesDialog"));

type Props = {
  initialSection?: "memory" | "shared";
  conversationId?: string;
  sharedNotesSeed?: SharedNotesSeed | null;
  open: boolean;
  workspaceRoot: string | null;
  /** Bumped when the AI panel writes a new entry, to force a refresh. */
  refreshKey?: number;
  /** Open a newly proposed lesson directly in the existing review editor. */
  initialDraftId?: string | null;
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
  initialSection = "memory",
  conversationId = "",
  sharedNotesSeed = null,
  refreshKey = 0,
  initialDraftId,
  onOpenInEditor,
  onOpenTouchedFile,
  onClose,
}: Props) {
  const modalRoot = useRef<HTMLDivElement>(null);
  const [section, setSection] = useState(initialSection);
  const [sharedDirty, setSharedDirty] = useState(false);
  useEffect(() => { if (open) { setSection(initialSection); setSharedDirty(false); } }, [open, initialSection]);
  function close() {
    if (sharedDirty && !window.confirm("Close Memory without saving your Foundations draft?")) return;
    onClose();
  }
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      if (e.key === "Escape" && dialogs[dialogs.length - 1] === modalRoot.current) close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, sharedDirty]);

  if (!open) return null;

  return (
    <div
      ref={modalRoot}
      role="dialog"
      aria-modal="true"
      aria-label="Project memory"
      onClick={close}
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
          <div className="memory-sections" role="tablist" aria-label="Memory sections" onKeyDown={event => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === "Home" ? "memory" : event.key === "End" ? "shared" : section === "memory" ? "shared" : "memory";
            setSection(next);
            event.currentTarget.querySelectorAll<HTMLButtonElement>("button")[next === "memory" ? 0 : 1]?.focus();
          }}>
            <button type="button" role="tab" aria-selected={section === "memory"} tabIndex={section === "memory" ? 0 : -1} onClick={() => setSection("memory")}>Project Memory</button>
            <button type="button" role="tab" aria-selected={section === "shared"} tabIndex={section === "shared" ? 0 : -1} onClick={() => setSection("shared")}>Foundations</button>
          </div>
          <div style={{ flex: 1 }} />
          <button
            onClick={close}
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
          <div hidden={section !== "memory"} style={{ flex: 1, minHeight: 0, display: section === "memory" ? "flex" : "none", flexDirection: "column" }}>
          <MemoryPanel
            fill
            visible
            width={0}
            workspaceRoot={workspaceRoot}
            refreshKey={refreshKey}
            initialDraftId={initialDraftId}
            onOpenInEditor={onOpenInEditor}
            onOpenTouchedFile={onOpenTouchedFile}
          />
          </div>
          {workspaceRoot && <div hidden={section !== "shared"} style={{ flex: 1, minHeight: 0, display: section === "shared" ? "flex" : "none" }}>
            {section === "shared" || sharedDirty ? <Suspense fallback={<p>Loading foundations…</p>}>
              <SharedNotesEditor embedded workspaceRoot={workspaceRoot} conversationId={conversationId} seed={sharedNotesSeed}
                onDirtyChange={setSharedDirty} onChanged={() => {}} onClose={close} />
            </Suspense> : null}
          </div>}
        </div>
      </div>
    </div>
  );
}
