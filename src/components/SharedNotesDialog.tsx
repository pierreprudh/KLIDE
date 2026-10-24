import { DocumentIcon, MissionIcon, MemoryIcon, NewTaskIcon, CloseIcon, ReplayIcon, SendIcon, MoreIcon, CheckIcon, SearchIcon } from "../icons";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { applySharedNotes, readSharedNotes, sharedNoteLesson, sharedNotesForConversation, type SharedNotesAction, type SharedNotesStore } from "../sharedNotes";
import { addMemoryDraft } from "../memoryDrafts";
import { loadConversations } from "./ai/storedConversations";
import type { Conversation } from "./ai/types";
import type { SharedNotesSeed } from "./ai/SharedNotesControl";
import { MemoryModal } from "./MemoryModal";
import { createPortal } from "react-dom";
import "./sharedNotes.css";

type Tab = "notes" | "conversations" | "memory";
const TABS: Tab[] = ["notes", "conversations", "memory"];

const noteIcons = {
  note: DocumentIcon, people: MissionIcon, memory: MemoryIcon, plus: NewTaskIcon,
  close: CloseIcon, refresh: ReplayIcon, arrow: SendIcon, more: MoreIcon,
  check: CheckIcon, search: SearchIcon,
};
function Icon({ name, size = 16 }: { name: keyof typeof noteIcons; size?: number }) {
  const Glyph = noteIcons[name];
  return <Glyph size={size} style={name === "arrow" ? { transform: "rotate(90deg)" } : undefined} />;
}

export default function SharedNotesDialog({ workspaceRoot, conversationId, seed, onChanged, onClose, embedded = false, onDirtyChange }: {
  workspaceRoot: string; conversationId: string; seed: SharedNotesSeed | null;
  embedded?: boolean; onDirtyChange?: (dirty: boolean) => void;
  onChanged: (store: SharedNotesStore) => void; onClose: () => void;
}) {
  const [store, setStore] = useState<SharedNotesStore | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState({ title: "", body: "" });
  const [newTitle, setNewTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<Tab>("notes");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [lessonTitle, setLessonTitle] = useState("");
  const [lesson, setLesson] = useState("");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewDraftId, setReviewDraftId] = useState<string | null>(null);
  const [seedAdded, setSeedAdded] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const selection = useRef("");
  const root = useRef<HTMLDivElement>(null);
  const returnFocus = useRef(document.activeElement);
  const set = store?.sets.find(item => item.id === selectedId);
  const dirty = !!set && (draft.title !== set.title || draft.body !== set.body);
  const hasLessonDraft = !!lesson.trim() || !!lessonTitle.trim();
  useEffect(() => { onDirtyChange?.(dirty || hasLessonDraft || !!(seed && !seedAdded)); }, [dirty, hasLessonDraft, seed, seedAdded, onDirtyChange]);
  const [conversations] = useState(() => loadConversations<Conversation>().filter(item => item.cwd === workspaceRoot));

  function adopt(next: SharedNotesStore) { setStore(next); onChanged(next); }
  function select(id: string | null, next = store) {
    const selected = next?.sets.find(item => item.id === id);
    setSelectedId(selected?.id ?? null);
    setDraft({ title: selected?.title ?? "", body: selected?.body ?? "" });
    setLesson(""); setLessonTitle(""); setDeleteArmed(false); setSettingsOpen(false); setTab("notes"); selection.current = "";
  }
  useEffect(() => {
    let alive = true;
    void readSharedNotes(workspaceRoot).then(next => {
      if (!alive) return;
      adopt(next);
      select(sharedNotesForConversation(next, conversationId)?.id ?? next.sets[0]?.id ?? null, next);
      if (!next.sets.length) setCreating(true);
    }).catch(error => { if (alive) setError(String(error)); });
    root.current?.focus();
    return () => { alive = false; if (returnFocus.current instanceof HTMLElement) returnFocus.current.focus(); };
    // The parent keys the dialog by Workspace and Conversation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function close() {
    if (busy) return;
    if ((dirty || lesson.trim() || lessonTitle.trim() || (seed && !seedAdded)) && !window.confirm("Close without saving this Foundations draft?")) return;
    onClose();
  }
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (reviewOpen) return;
    if (event.key === "Escape") {
      event.stopPropagation();
      if (settingsOpen) setSettingsOpen(false); else close();
    }

  }
  function tabKeyDown(event: KeyboardEvent<HTMLButtonElement>, current: Tab) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = event.key === "Home" ? 0 : event.key === "End" ? 2 : (TABS.indexOf(current) + (event.key === "ArrowRight" ? 1 : 2)) % 3;
    setTab(TABS[index]);
    root.current?.querySelector<HTMLButtonElement>(`#shared-tab-${TABS[index]}`)?.focus();
  }
  async function mutate(action: SharedNotesAction) {
    if (!store || busy) return;
    setBusy(true); setError(""); setStatus("");
    try {
      const next = await applySharedNotes(workspaceRoot, store.revision, action);
      adopt(next);
      if (action.type === "create") {
        select(sharedNotesForConversation(next, conversationId)?.id ?? next.sets[next.sets.length - 1]?.id ?? null, next);
        setNewTitle(""); setCreating(false);
      } else if (action.type === "edit") {
        const saved = next.sets.find(item => item.id === action.id);
        if (saved) setDraft({ title: saved.title, body: saved.body });
        selection.current = "";
      }
      else if (action.type === "delete") select(null, next);
      setSettingsOpen(false);
      setStatus(action.type === "edit" ? "Saved. Linked conversations will use these notes on their next turn." : "Sharing updated.");
    } catch (error) { setError(String(error)); }
    finally { setBusy(false); }
  }
  async function reload() {
    setBusy(true);
    try {
      const next = await readSharedNotes(workspaceRoot);
      adopt(next); setError("");
      setStatus(selectedId && !next.sets.some(set => set.id === selectedId)
        ? "This set was deleted. Copy your draft before choosing another set."
        : "Reloaded. Your draft is unchanged; compare the saved version before saving.");
    } catch (error) { setError(String(error)); }
    finally { setBusy(false); }
  }
  function extractLesson() {
    if (selection.current.trim()) setLesson(selection.current.trim().slice(0, 4000));
    if (!lessonTitle.trim()) setLessonTitle(draft.title);
    setTab("memory");
  }
  const members = set ? [...new Set([conversationId, ...conversations.map(item => item.id), ...set.conversationIds])].filter(Boolean) : [];
  const bytes = new TextEncoder().encode(draft.body).length;
  const filteredSets = store?.sets.filter(item => item.title.toLowerCase().includes(query.toLowerCase())) ?? [];

  return <>
    <div className={embedded ? "shared-notes-embedded" : "shared-notes-dock"} inert={reviewOpen} aria-hidden={reviewOpen || undefined}>
      <div className="shared-notes-dialog" role="complementary" aria-labelledby="shared-notes-title" tabIndex={-1} ref={root} onKeyDown={keyDown}>
        <header className="shared-notes-header">
          <div className="shared-notes-app-icon"><Icon name="note" size={18} /></div>
          <h2 id="shared-notes-title">Foundations</h2><span className="shared-notes-header-caption">Workspace</span>
          <div className="shared-notes-header-actions">
            <button className="sn-icon-button" type="button" onClick={() => void reload()} disabled={busy} aria-label="Reload foundations" title="Reload foundations"><Icon name="refresh" /></button>
            <span className="sn-header-divider" />
            <button className="sn-icon-button sn-close" type="button" onClick={close} aria-label="Close foundations" title="Close" disabled={busy}><Icon name="close" /></button>
          </div>
        </header>
        <div className="shared-notes-layout">
          <nav className="shared-notes-list" aria-label="Shared note sets">
            <div className="sn-sidebar-heading"><span>Your foundations</span><button className="sn-icon-button" type="button" aria-label="Create a foundation" title="Create a foundation" onClick={() => setCreating(!creating)} disabled={busy || dirty || hasLessonDraft}><Icon name="plus" size={15} /></button></div>
            <label className="sn-search"><Icon name="search" size={14} /><input aria-label="Find foundations" placeholder="Find a foundation…" value={query} onChange={event => setQuery(event.target.value)} /></label>
            {creating && <form className="sn-create-form" onSubmit={event => { event.preventDefault(); if (newTitle.trim() && !dirty && !busy) void mutate({ type: "create", title: newTitle, conversationId }); }}>
              <input aria-label="Foundation name" autoFocus value={newTitle} maxLength={160} onChange={event => setNewTitle(event.target.value)} placeholder="Name your initiative" />
              <div className="shared-notes-actions"><button type="button" className="sn-button sn-ghost" onClick={() => setCreating(false)}>Cancel</button><button type="submit" className="sn-button sn-primary" disabled={!store || busy || dirty || hasLessonDraft || !newTitle.trim()}>Create set</button></div>
            </form>}
            <div className="sn-set-scroll">
              {[false, true].map(archived => {
                const sets = filteredSets.filter(item => item.archived === archived);
                return sets.length > 0 ? <div className="sn-set-group" key={String(archived)}>{archived && <span className="sn-section-label">Archived</span>}{sets.map(item => <button className="sn-set-row" type="button" key={item.id} aria-pressed={item.id === selectedId} disabled={busy || dirty || !!lesson.trim() || !!lessonTitle.trim()} onClick={() => select(item.id)}>
                  <span className="sn-set-mark"><Icon name="note" size={16} /></span><span className="sn-set-copy"><span>{item.title}</span><small>{item.conversationIds.length} conversation{item.conversationIds.length === 1 ? "" : "s"}</small></span>{item.id === selectedId && <span className="sn-selection-dot" />}
                </button>)}</div> : null;
              })}
              {store && !filteredSets.length && <p className="sn-list-empty">{query ? "No matching foundations." : "A little context for your next conversation."}</p>}
            </div>
            <div className="sn-sidebar-footer"><Icon name="people" size={15} /><span>One context.<br />Any provider.</span></div>
          </nav>
          <div className="sn-main">
            <div className="sn-feedback" aria-live="polite">
              {error && <div className="sn-alert" role="alert">{error}</div>}
              {status && !error && <div className="sn-status" role="status"><Icon name="check" size={14} />{status}</div>}
            </div>
            {selectedId ? <>
              <div className="sn-document-heading">
                <div className="sn-document-meta"><span className="sn-eyebrow">Working context</span><span className={`sn-badge${set?.archived ? " sn-badge-muted" : ""}`}><span />{set?.archived ? "Archived" : "Shared"}</span>
                  {set && <div className="sn-settings"><button type="button" className="sn-icon-button" aria-label="Foundation options" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(!settingsOpen)}><Icon name="more" /></button>{settingsOpen && <div className="sn-settings-menu">
                    <button type="button" disabled={busy || dirty} onClick={() => void mutate({ type: "archive", id: set.id, archived: !set.archived })}>{set.archived ? "Restore foundation" : "Archive foundation"}</button>
                    <button type="button" className="sn-danger" disabled={busy || dirty} onClick={() => { if (deleteArmed) void mutate({ type: "delete", id: set.id }); else setDeleteArmed(true); }}>{deleteArmed ? "Confirm delete notes and links" : "Delete foundation"}</button>
                    {deleteArmed && <button type="button" onClick={() => setDeleteArmed(false)}>Cancel delete</button>}
                  </div>}</div>}
                </div>
                <label className="sn-document-title"><span className="sn-sr-only">Title</span><input value={draft.title} maxLength={160} onChange={event => setDraft(previous => ({ ...previous, title: event.target.value }))} disabled={busy || !set} placeholder="Untitled notes" /></label>
                <p>The decisions, questions, and next steps your conversations share.</p>
                <div className="sn-tabs" role="tablist" aria-label="Foundations sections">{TABS.map(item => <button type="button" role="tab" key={item} id={`shared-tab-${item}`} aria-selected={tab === item} aria-controls={`shared-panel-${item}`} tabIndex={tab === item ? 0 : -1} onKeyDown={event => tabKeyDown(event, item)} onClick={() => { setTab(item); setSettingsOpen(false); }}>
                  <Icon name={item === "notes" ? "note" : item === "conversations" ? "people" : "memory"} size={14} />{item === "notes" ? "Notes" : item === "conversations" ? "Conversations" : "Project Memory"}{item === "conversations" && <span className="sn-count">{set?.conversationIds.length ?? 0}</span>}
                </button>)}</div>
              </div>
              <div className="sn-panel-scroll">
                <section id="shared-panel-notes" role="tabpanel" aria-labelledby="shared-tab-notes" hidden={tab !== "notes"} className="sn-notes-panel">
                  {seed && !seedAdded && <div className="sn-seed-card"><div className="sn-seed-heading"><Icon name="note" /><strong>An answer worth keeping</strong></div><p>Add it to your draft, then make it your own.</p><details><summary>Preview answer</summary><pre>{seed.text}</pre></details><button className="sn-button sn-secondary" type="button" disabled={!set || set.archived || busy} onClick={() => {
                    setDraft(previous => ({ ...previous, body: `${previous.body}${previous.body.trim() ? "\n\n" : ""}From conversation ${seed.sourceConversationId}:\n${seed.text}` })); setSeedAdded(true);
                  }}>Add answer to draft<Icon name="plus" size={14} /></button></div>}
                  {set?.archived && <div className="sn-callout">Archived notes are kept for reference and no longer supplied to conversations.</div>}
                  <label className="sn-writing-surface"><span className="sn-sr-only">Notes</span><textarea value={draft.body} onChange={event => setDraft(previous => ({ ...previous, body: event.target.value }))} onSelect={event => { const field = event.currentTarget; selection.current = field.value.slice(field.selectionStart, field.selectionEnd); }} disabled={busy || !set} placeholder={"What should the next conversation know?\n\nDecisions so far\nOpen questions\nWhat comes next"} /></label>
                  <div className="sn-writing-meta"><span className={bytes > 12000 ? "sn-danger" : ""}>{bytes.toLocaleString()} / 12,000 bytes</span><span>Working notes, saved by you</span></div>
                  {set && dirty && <details className="sn-compare"><summary>Compare saved version</summary><pre>{set.body || "No saved notes yet."}</pre></details>}
                  <button className="sn-memory-shortcut" type="button" disabled={dirty || !set || busy} onClick={extractLesson}><span className="sn-shortcut-icon"><Icon name="memory" size={18} /></span><span><strong>Found a lasting lesson?</strong><small>Select a passage, then propose it for Project Memory.</small></span><Icon name="arrow" /></button>
                </section>
                <section id="shared-panel-conversations" role="tabpanel" aria-labelledby="shared-tab-conversations" hidden={tab !== "conversations"}>
                  <div className="sn-section-intro"><h3>Keep your conversations in sync</h3><p>Linked conversations receive the saved notes on their next turn, whichever provider they use.</p></div>
                  {dirty && <div className="sn-callout">Save or discard your note edits before changing who shares them.</div>}
                  <div className="sn-conversation-list">{set && members.map(id => {
                    const conversation = conversations.find(item => item.id === id);
                    const linked = set.conversationIds.includes(id);
                    return <label className="sn-conversation-row" key={id}><span className="sn-conversation-icon"><Icon name="people" /></span><span className="sn-conversation-copy"><strong title={id}>{id === conversationId ? "This conversation" : conversation?.title ?? "Linked conversation"}</strong><small>{conversation?.provider ?? (id === conversationId ? "Current chat" : "Saved conversation")}</small></span><input aria-label={`Share notes with ${id === conversationId ? "this conversation" : conversation?.title ?? id}`} type="checkbox" checked={linked} disabled={busy || dirty || set.archived} onChange={() => void mutate({ type: "attach", id: linked ? null : set.id, conversationId: id })} /></label>;
                  })}</div>
                  <div className="sn-footnote"><Icon name="note" size={14} /><p>In interactive CLI sessions, send through Klide’s composer to include notes. Direct terminal input stays direct.</p></div>
                </section>
                <section id="shared-panel-memory" role="tabpanel" aria-labelledby="shared-tab-memory" hidden={tab !== "memory"}>
                  <div className="sn-section-intro"><span className="sn-feature-icon"><Icon name="memory" size={22} /></span><h3>Make a useful lesson last</h3><p>Turn a working decision into knowledge for the whole Workspace. You’ll review it before it becomes Project Memory.</p></div>
                  <div className="sn-promotion-form"><label>Lesson title<input value={lessonTitle} maxLength={160} onChange={event => setLessonTitle(event.target.value)} placeholder="A clear, reusable takeaway" /></label><label>What to remember<textarea value={lesson} maxLength={4000} onChange={event => setLesson(event.target.value)} placeholder="Describe the lesson and include supporting file paths or test results…" /></label><div className="sn-promotion-footer"><span><Icon name="check" size={14} />Always reviewed by you</span>{hasLessonDraft && <button type="button" className="sn-button sn-ghost" onClick={() => { setLesson(""); setLessonTitle(""); }}>Discard lesson</button>}<button className="sn-button sn-primary" type="button" disabled={!set || !lessonTitle.trim() || !lesson.trim() || busy || dirty} onClick={() => {
                    if (!set) return;
                    const proposed = addMemoryDraft(sharedNoteLesson(set, lessonTitle, lesson), workspaceRoot, { why: `Selected by the user from foundations: ${set.title}`, evidence: set.body });
                    setReviewDraftId(proposed?.draftId ?? null); setLesson(""); setLessonTitle(""); setReviewOpen(true);
                  }}>Review lesson<Icon name="arrow" size={14} /></button></div></div>
                  <button type="button" className="sn-text-button" onClick={() => { setReviewDraftId(null); setReviewOpen(true); }}>Open Project Memory<Icon name="arrow" size={14} /></button>
                </section>
              </div>
              <footer className="sn-document-footer"><span className="sn-save-state"><span className={dirty ? "sn-unsaved-dot" : "sn-saved-dot"} />{busy ? "Saving…" : dirty ? "Unsaved changes" : "All changes saved"}</span><div className="shared-notes-actions"><button className="sn-button sn-ghost" type="button" disabled={busy || !dirty} onClick={() => { setDraft({ title: set?.title ?? "", body: set?.body ?? "" }); selection.current = ""; }}>Discard</button><button className="sn-button sn-primary" type="button" disabled={busy || !set || !dirty || !draft.title.trim() || bytes > 12000} onClick={() => void mutate({ type: "edit", id: selectedId, ...draft })}>Save notes<Icon name="check" size={14} /></button></div></footer>
            </> : <div className="sn-empty-state"><span className="sn-empty-icon"><Icon name="note" size={28} /></span><h3>A shared place to pick up the thread.</h3><p>Keep decisions and open questions together, so your next conversation starts with the context it needs.</p><button type="button" className="sn-button sn-primary" disabled={!store || busy} onClick={() => setCreating(true)}><Icon name="plus" size={15} />{store?.sets.length ? "Create a foundation" : "Create your first foundation"}</button></div>}
          </div>
        </div>
      </div>
    </div>
    {reviewOpen && createPortal(<div className="shared-notes-memory-review"><MemoryModal open={reviewOpen} workspaceRoot={workspaceRoot} initialDraftId={reviewDraftId} onClose={() => { setReviewOpen(false); requestAnimationFrame(() => root.current?.focus()); }} /></div>, document.body)}
  </>;
}
