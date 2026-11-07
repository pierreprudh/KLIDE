import "./sharedNotes.css";
import "./memoryPanel.css";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useModalFocus } from "../hooks/useModalFocus";
import { MemoryPanel } from "./MemoryPanel";
import { Z } from "../zLayers";
import { LibraryIcon } from "../icons";
import { useMemoryReviewCount } from "../hooks/useMemoryReviewCount";
import type { Skill } from "../skills";

import type { SharedNotesSeed } from "./ai/SharedNotesControl";
const SharedNotesEditor = lazy(() => import("./SharedNotesDialog"));
const SkillsModal = lazy(() => import("./SkillsModal").then((m) => ({ default: m.SkillsModal })));

export type LibrarySection = "memory" | "skills" | "shared";

/** What the Skills tab edits. Absent where the Library is opened only for
 *  Memory or Foundations (the conversation's notes control), and then the tab
 *  is not offered. */
export type LibrarySkills = {
  skills: Skill[];
  onChange: (skills: Skill[]) => void;
  onReloadFilesystemSkills: () => Promise<void> | void;
};

type Props = {
  initialSection?: LibrarySection;
  /** Told when the person picks another tab, so whoever opened the Library
   *  knows which tab is showing (a later "open on Skills" must still land). */
  onSectionChange?: (section: LibrarySection) => void;
  skills?: LibrarySkills;
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

// The Library — what Kit brings into every run, behind one destination:
// Project Memory (what it knows), Skills (how it works) and Foundations (the
// working notes a set of conversations shares). A centered overlay so the
// list+detail layouts have the room they need. Escape closes; clicking the
// backdrop closes.
export function LibraryModal({
  open,
  workspaceRoot,
  initialSection = "memory",
  onSectionChange,
  skills,
  conversationId = "",
  sharedNotesSeed = null,
  refreshKey = 0,
  initialDraftId,
  onOpenInEditor,
  onOpenTouchedFile,
  onClose,
}: Props) {
  const modalRoot = useRef<HTMLDivElement>(null);
  useModalFocus(modalRoot, open);
  const [section, setSectionState] = useState(initialSection);
  function setSection(next: LibrarySection) {
    setSectionState(next);
    onSectionChange?.(next);
  }
  const [sharedDirty, setSharedDirty] = useState(false);
  useEffect(() => { if (open) setSectionState(initialSection); }, [open, initialSection]);
  useEffect(() => { if (open) setSharedDirty(false); }, [open]);
  const reviewCount = useMemoryReviewCount(open ? workspaceRoot : null);
  const sections: { id: LibrarySection; label: string; note?: string }[] = [
    { id: "memory", label: "Memory", note: reviewCount > 0 ? `${reviewCount} to review` : undefined },
    ...(skills ? [{ id: "skills" as const, label: "Skills" }] : []),
    ...(workspaceRoot ? [{ id: "shared" as const, label: "Foundations" }] : []),
  ];
  function close() {
    if (sharedDirty && !window.confirm("Close the Library without saving your Foundations draft?")) return;
    onClose();
  }
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      // The Skills tab answers Escape itself: it first leaves an open edit,
      // and only then closes the Library through `close`.
      if (section === "skills") return;
      const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      if (e.key === "Escape" && dialogs[dialogs.length - 1] === modalRoot.current) close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, sharedDirty, section]);

  if (!open) return null;

  return (
    <div
      ref={modalRoot}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Library"
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
            <span style={{ display: "grid", color: "var(--fg-subtle)" }}><LibraryIcon size={16} /></span>
            Library
          </span>
          <div className="memory-sections" role="tablist" aria-label="Library sections" onKeyDown={event => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const at = sections.findIndex((s) => s.id === section);
            const index = event.key === "Home" ? 0
              : event.key === "End" ? sections.length - 1
              : (at + (event.key === "ArrowRight" ? 1 : -1) + sections.length) % sections.length;
            setSection(sections[index].id);
            event.currentTarget.querySelectorAll<HTMLButtonElement>("button")[index]?.focus();
          }}>
            {sections.map((s) => (
              <button key={s.id} type="button" role="tab" aria-selected={section === s.id} tabIndex={section === s.id ? 0 : -1} onClick={() => setSection(s.id)}>
                {s.label}
                {s.note ? <span className="memory-section-note">{s.note}</span> : null}
              </button>
            ))}
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
          <div hidden={section !== "memory"} style={{ flex: 1, minHeight: 0, display: section === "memory" ? "flex" : "none" }}>
            <MemoryPanel
              workspaceRoot={workspaceRoot}
              refreshKey={refreshKey}
              initialDraftId={initialDraftId}
              onOpenInEditor={onOpenInEditor}
              onOpenTouchedFile={onOpenTouchedFile}
            />
          </div>
          {skills && section === "skills" ? (
            <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
              <Suspense fallback={null}>
                <SkillsModal
                  open
                  embedded
                  skills={skills.skills}
                  onChange={skills.onChange}
                  onReloadFilesystemSkills={skills.onReloadFilesystemSkills}
                  onClose={close}
                />
              </Suspense>
            </div>
          ) : null}
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
