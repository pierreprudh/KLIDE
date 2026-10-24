// Browser interaction fixture. Uses an in-memory IPC mock; never writes Workspace files.
import { createRoot } from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import { useEffect, useState } from "react";
import { MemoryModal } from "../src/components/MemoryModal";
import { SharedNotesControl } from "../src/components/ai/SharedNotesControl";
import { columnGeometry } from "../src/components/ai/canvasColumn";
import type { SharedNotesAction, SharedNotesStore } from "../src/sharedNotes";
import "@fontsource/atkinson-hyperlegible/400.css";
import "../src/styles/tokens.css";

const query = new URLSearchParams(location.search);
document.documentElement.dataset.theme = query.get("theme") ?? "light";
let notes: SharedNotesStore = { revision: 1, sets: query.has("empty") ? [] : [{
  id: "remote", title: "Remote execution", body: "Decisions\n• Run tools beside the remote files.\n• Use SSH for transport.\n\nOpen questions\n• How should reconnect replay be tested?",
  conversationIds: query.has("unlinked") ? ["other-provider-chat"] : ["current-chat", "other-provider-chat"], archived: query.has("archived"), updatedAtMs: Date.now(),
}] };
const memories: unknown[] = [];
mockIPC((command, args) => {
  if (command === "shared_notes_read") return structuredClone(notes);
  if (command === "shared_notes_apply") {
    if (args?.expectedRevision !== notes.revision) throw new Error("Shared notes changed in another window. Reload before saving; your draft has been kept.");
    const action = args.action as SharedNotesAction;
    const set = "id" in action ? notes.sets.find(set => set.id === action.id) : undefined;
    if (action.type === "create") notes.sets.push({ id: `preview-${notes.revision}`, title: action.title, body: "", conversationIds: [action.conversationId], archived: false, updatedAtMs: Date.now() });
    if (action.type === "edit" && set) { set.title = action.title; set.body = action.body; }
    if (action.type === "attach") notes.sets.forEach(set => { set.conversationIds = set.conversationIds.filter(id => id !== action.conversationId); if (set.id === action.id) set.conversationIds.push(action.conversationId); });
    if (action.type === "archive" && set) set.archived = action.archived;
    if (action.type === "delete") notes.sets = notes.sets.filter(set => set.id !== action.id);
    notes.revision++;
    return structuredClone(notes);
  }
  if (command === "memory_list") return structuredClone(memories);
  if (command === "memory_proposals_list") return [];
  if (command === "memory_write") {
    const entry = { ...(args?.input as object), id: `memory-${memories.length + 1}`, relPath: ".klide/memory/preview.md", reviewState: "reviewed", createdAtMs: Date.now(), dateIso: new Date().toISOString() };
    memories.push(entry);
    return entry;
  }
  return [];
}, { shouldMockEvents: true });

function Preview() {
  const [open, setOpen] = useState(query.has("memory") || query.has("seed"));
  const [expanded, setExpanded] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [slot, setSlot] = useState<"none" | "mark" | "card">("none");
  const [width, setWidth] = useState(window.innerWidth - 48);
  useEffect(() => {
    const resize = () => setWidth(window.innerWidth - 48);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const column = columnGeometry({ planSlot: "none", resultUp: false, notesSlot: slot, hidden, canvasWidth: width });
  return <main style={{ position: "relative", boxSizing: "border-box", padding: 24, minHeight: "100vh", background: "var(--bg)", color: "var(--fg-strong)", fontFamily: "var(--font-ui)" }}>
    <article style={{ paddingRight: column.inset, fontSize: 16, lineHeight: 1.8 }}>
      <button onClick={() => setOpen(true)}>Memory</button>
      <h1 style={{ fontSize: 24, fontWeight: 500 }}>Context for the next conversation</h1>
      <p>This conversation should have the space it needs. Foundations only appears here when this chat has been explicitly linked to working notes.</p>
      <p>A linked foundation rests as a small icon in its own lane. Clicking it opens a short preview in the same right-side panel as the other conversation cards. The transcript makes room for that preview.</p>
      <p>Use Memory to write and organize foundations, choose the conversations that share them, and review lessons for Project Memory.</p>
    </article>
    <aside className="klide-island-column" style={{ position: "absolute", right: 24, top: 24, width: column.width, display: "flex", flexDirection: "column", gap: 10, pointerEvents: "none" }}>
      {column.showClose && <button style={{ alignSelf: "flex-end", pointerEvents: "auto" }} aria-label="Close the side panel" onClick={() => { setExpanded(false); setHidden(true); }}>×</button>}
      <SharedNotesControl workspaceRoot="/shared-notes-preview" conversationId="current-chat" terminal={false} seed={null}
        expanded={expanded} folded={column.planFolded || !column.cardsUp} onUnfold={() => setHidden(false)} onOpenChange={setExpanded} onPresenceChange={setSlot} onSeedConsumed={() => {}} />
    </aside>
    <MemoryModal open={open} workspaceRoot="/shared-notes-preview" conversationId="current-chat" initialSection="shared"
      sharedNotesSeed={query.has("seed") ? { sourceConversationId: "current-chat", text: "Event streams should replay from a stable cursor. Verify this with a disconnect test." } : null}
      onClose={() => setOpen(false)} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
