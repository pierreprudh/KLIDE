import { DocumentIcon, ChevronIcon, MemoryIcon } from "../../icons";
import { lazy, Suspense, useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { listen } from "@tauri-apps/api/event";
import { createListenerScope } from "../../tauriEvents";
import { readSharedNotes, sharedNotesForConversation, sharedNotesSlot, type SharedNotesStore } from "../../sharedNotes";
import "../sharedNotes.css";
import "./completionCard.css";

const MemoryModal = lazy(() => import("../MemoryModal").then(module => ({ default: module.MemoryModal })));

export type SharedNotesSeed = { text: string; sourceConversationId: string };

/** One control in both Focus and workbench. No per-token subscription. */
export function SharedNotesControl({ workspaceRoot, conversationId, terminal, seed, expanded, variant = "island", folded = false, onUnfold, onOpenChange, onPresenceChange, onSeedConsumed }: {
  workspaceRoot: string;
  conversationId: string;
  terminal: boolean;
  seed: SharedNotesSeed | null;
  onSeedConsumed: () => void;
  expanded?: boolean;
  variant?: "island" | "launcher";
  folded?: boolean;
  onUnfold?: () => void;
  onOpenChange?: (open: boolean) => void;
  onPresenceChange?: (slot: "none" | "mark" | "card") => void;
}) {
  const previewId = useId();
  const [store, setStore] = useState<SharedNotesStore | null>(null);
  const [error, setError] = useState("");
  const [localOpen, setLocalOpen] = useState(false);
  const open = expanded ?? localOpen;
  function setOpen(value: boolean) { setLocalOpen(value); onOpenChange?.(value); }
  const [memoryOpen, setMemoryOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    let generation = 0;
    const refresh = () => {
      const mine = ++generation;
      void readSharedNotes(workspaceRoot).then(value => {
        if (alive && mine === generation) { setStore(value); setError(""); }
      }).catch(error => { if (alive && mine === generation) setError(String(error)); });
    };
    refresh();
    const scope = createListenerScope();
    scope.add(listen<string>("shared-notes-changed", refresh));
    window.addEventListener("focus", refresh);
    return () => { alive = false; scope.dispose(); window.removeEventListener("focus", refresh); };
  }, [workspaceRoot]);
  const set = store ? sharedNotesForConversation(store, conversationId) : undefined;
  const slot = sharedNotesSlot(store, conversationId, open);
  useEffect(() => { onPresenceChange?.(slot); }, [slot, onPresenceChange]);
  useEffect(() => () => onPresenceChange?.("none"), [onPresenceChange]);
  const hasSeed = seed?.sourceConversationId === conversationId;
  useEffect(() => () => onOpenChange?.(false), [onOpenChange]);
  return <>
    {slot !== "none" && <div className="klide-result-entry sn-shared-entry" data-variant="island" data-open={!folded && open ? "1" : undefined}>
    {variant === "launcher" || folded ? <button type="button" className="klide-result-mark" aria-label="Open the side panel — foundations" title="Foundations" onClick={() => { if (variant === "launcher") setMemoryOpen(true); else { onUnfold?.(); setOpen(true); } }}><DocumentIcon size={18} /></button> :
      <section className="klide-result-island" data-open={open ? "1" : undefined} aria-label="Foundations">
        <div className="klide-result-island-header" role="button" tabIndex={0} aria-label={`${open ? "Collapse" : "Expand"} foundations`} aria-expanded={open} aria-controls={previewId}
          onClick={() => setOpen(!open)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setOpen(!open); } }}>
          <DocumentIcon size={17} /><span className="klide-result-island-title">Foundations</span><span className="klide-result-island-chevron" aria-hidden="true"><ChevronIcon open={open} /></span>
        </div>
        <div className="klide-result-island-rule" data-shown={open ? "1" : undefined} aria-hidden="true" />
        {open && <div className="sn-island-preview" id={previewId}>
          {error ? <p role="alert">{error}</p> : set ? <><strong>{set.title}</strong><p className="sn-island-excerpt">{set.body || "No notes saved yet."}</p><small>{set.archived ? "Archived" : terminal ? "Shared through the composer" : "Used on the next turn"}</small></> : <p>Keep working context across conversations and providers.</p>}
          <button type="button" className="sn-island-manage" onClick={() => setMemoryOpen(true)}><MemoryIcon size={14} />{set ? "Manage in Memory" : "Set up in Memory"}</button>
        </div>}
      </section>}
    </div>}
    {(memoryOpen || hasSeed) && createPortal(<Suspense fallback={<div role="status" className="shared-notes-loading">Opening Memory…</div>}>
      <MemoryModal open workspaceRoot={workspaceRoot} conversationId={conversationId} initialSection="shared" sharedNotesSeed={hasSeed ? seed : null}
        onClose={() => { setMemoryOpen(false); onSeedConsumed(); }} />
    </Suspense>, document.body)}
  </>;
}
