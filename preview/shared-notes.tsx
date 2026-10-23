// Browser interaction fixture. Uses an in-memory IPC mock; never writes Workspace files.
import { createRoot } from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import { useState } from "react";
import { MemoryModal } from "../src/components/MemoryModal";
import { SharedNotesControl } from "../src/components/ai/SharedNotesControl";
import type { SharedNotesAction, SharedNotesStore } from "../src/sharedNotes";
import "@fontsource/atkinson-hyperlegible/400.css";
import "../src/styles/tokens.css";

const query = new URLSearchParams(location.search);
document.documentElement.dataset.theme = query.get("theme") ?? "light";
let notes: SharedNotesStore = { revision: 1, sets: query.has("empty") ? [] : [{
  id: "remote", title: "Remote execution", body: "Decisions\n• Run tools beside the remote files.\n• Use SSH for transport.\n\nOpen questions\n• How should reconnect replay be tested?",
  conversationIds: ["current-chat", "other-provider-chat"], archived: false, updatedAtMs: Date.now(),
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
  const [open, setOpen] = useState(true);
  return <main style={{ padding: 24, minHeight: "100vh", background: "var(--bg)", color: "var(--fg-strong)", fontFamily: "var(--font-ui)" }}>
    <button onClick={() => setOpen(true)}>Open Memory fixture</button>
    <div style={{ position: "absolute", right: 24, top: 24, width: 300 }}>
      <SharedNotesControl workspaceRoot="/shared-notes-preview" conversationId="current-chat" terminal={false} seed={null} onSeedConsumed={() => {}} />
    </div>
    <MemoryModal open={open} workspaceRoot="/shared-notes-preview" conversationId="current-chat" initialSection="shared"
      sharedNotesSeed={query.has("seed") ? { sourceConversationId: "current-chat", text: "Event streams should replay from a stable cursor. Verify this with a disconnect test." } : null}
      onClose={() => setOpen(false)} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
