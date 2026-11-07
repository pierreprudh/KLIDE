import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { applySharedNotes, readSharedNotes, sharedNoteLesson, sharedNotesForConversation, type SharedNotesAction, type SharedNotesStore } from "../sharedNotes";
import { addMemoryDraft } from "../memoryDrafts";
import { relativeTime } from "../time";
import { useSlidingHighlight } from "../hooks/useSlidingHighlight";
import { loadConversations } from "./ai/storedConversations";
import type { Conversation } from "./ai/types";
import type { SharedNotesSeed } from "./ai/SharedNotesControl";
import {
  DetailAction,
  Highlight,
  NavRail,
  PlusIcon,
  SearchIcon,
  SectionLabel,
  Toggle,
  TrashIcon,
  fieldStyle,
  labelStyle,
  type NavItem,
} from "./library/parts";
import "./sharedNotes.css";

// Foundations as the Library's third tab — the Skills body again: the command
// menu's field on top, Active / Archived on the left with "New foundation"
// under the hairline, the list beside them, and one page per foundation:
// its notes on paper, the conversations that receive them, and a lesson to
// propose for Project Memory.

type View = "active" | "archived";
const MAX_BYTES = 12_000;

function NavActiveIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 3.5h7l4 4V20.5H7z" />
      <path d="M14 3.5v4h4" />
      <path d="M10 12h5M10 15.5h5" />
    </svg>
  );
}
function NavArchivedIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.5 5h17v4h-17z" />
      <path d="M5 9v10.5h14V9" />
      <path d="M10 13h4" />
    </svg>
  );
}

function plural(n: number, one: string) { return `${n} ${one}${n === 1 ? "" : "s"}`; }

export default function SharedNotesDialog({ workspaceRoot, conversationId, seed, onChanged, onDirtyChange, onOpenMemory }: {
  workspaceRoot: string; conversationId: string; seed: SharedNotesSeed | null;
  onDirtyChange?: (dirty: boolean) => void;
  onChanged: (store: SharedNotesStore) => void;
  /** Hand over to the Memory tab — with a proposed lesson open, or just the tab. */
  onOpenMemory?: (draftId: string | null) => void;
}) {
  const [store, setStore] = useState<SharedNotesStore | null>(null);
  const [view, setView] = useState<View>("active");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState({ title: "", body: "" });
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [lessonOpen, setLessonOpen] = useState(false);
  const [lessonTitle, setLessonTitle] = useState("");
  const [lesson, setLesson] = useState("");
  const [seedAdded, setSeedAdded] = useState(false);
  const selection = useRef("");
  const set = store?.sets.find(item => item.id === selectedId);
  const dirty = !!set && (draft.title !== set.title || draft.body !== set.body);
  const hasLessonDraft = !!lesson.trim() || !!lessonTitle.trim();
  const pending = dirty || hasLessonDraft || !!(seed && !seedAdded);
  useEffect(() => { onDirtyChange?.(pending); }, [pending, onDirtyChange]);
  const [conversations] = useState(() => loadConversations<Conversation>().filter(item => item.cwd === workspaceRoot));

  function adopt(next: SharedNotesStore) { setStore(next); onChanged(next); }
  function select(id: string | null, next = store) {
    const picked = next?.sets.find(item => item.id === id);
    setSelectedId(picked?.id ?? null);
    setDraft({ title: picked?.title ?? "", body: picked?.body ?? "" });
    setLesson(""); setLessonTitle(""); setLessonOpen(false); setStatus(""); selection.current = "";
    if (picked) { setCreating(false); setView(picked.archived ? "archived" : "active"); }
  }
  /** Leaving a page with unsaved words asks first. */
  function leave(): boolean {
    return !(dirty || hasLessonDraft) || window.confirm("Discard your unsaved Foundations changes?");
  }

  useEffect(() => {
    let alive = true;
    void readSharedNotes(workspaceRoot).then(next => {
      if (!alive) return;
      adopt(next);
      select(sharedNotesForConversation(next, conversationId)?.id ?? next.sets.find(item => !item.archived)?.id ?? next.sets[0]?.id ?? null, next);
      if (!next.sets.length) setCreating(true);
    }).catch(err => { if (alive) setError(String(err)); });
    return () => { alive = false; };
    // The Library keys this tab by Workspace and Conversation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function mutate(action: SharedNotesAction) {
    if (!store || busy) return;
    setBusy(true); setError(""); setStatus("");
    try {
      const next = await applySharedNotes(workspaceRoot, store.revision, action);
      adopt(next);
      if (action.type === "create") {
        select(sharedNotesForConversation(next, conversationId)?.id ?? next.sets[next.sets.length - 1]?.id ?? null, next);
        setNewTitle("");
        setStatus("Created.");
      } else if (action.type === "edit") {
        const saved = next.sets.find(item => item.id === action.id);
        if (saved) setDraft({ title: saved.title, body: saved.body });
        selection.current = "";
        setStatus("Saved. Linked conversations use these notes on their next turn.");
      } else if (action.type === "delete") {
        select(next.sets.find(item => !item.archived)?.id ?? null, next);
      } else if (action.type === "archive") {
        setView(action.archived ? "archived" : "active");
        setStatus(action.archived ? "Archived. Conversations no longer receive these notes." : "Restored.");
      } else setStatus("Sharing updated.");
    } catch (err) { setError(String(err)); }
    finally { setBusy(false); }
  }
  async function reload() {
    setBusy(true);
    try {
      const next = await readSharedNotes(workspaceRoot);
      adopt(next); setError("");
      setStatus(selectedId && !next.sets.some(item => item.id === selectedId)
        ? "This foundation was deleted elsewhere. Copy your draft before choosing another."
        : "Reloaded. Your draft is unchanged.");
    } catch (err) { setError(String(err)); }
    finally { setBusy(false); }
  }

  const sets = store?.sets ?? [];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sets.filter(item => item.archived === (view === "archived")
      && (!q || item.title.toLowerCase().includes(q) || item.body.toLowerCase().includes(q)));
  }, [sets, view, query]);
  const ids = filtered.map(item => item.id);
  const hl = useSlidingHighlight(creating ? null : selectedId, `${view}|${ids.join("|")}`);

  function pick(id: string) {
    if (id === selectedId && !creating) return;
    if (!leave()) return;
    select(id);
  }
  function step(delta: 1 | -1) {
    if (!ids.length) return;
    const at = selectedId ? ids.indexOf(selectedId) : -1;
    pick(ids[at < 0 ? 0 : Math.max(0, Math.min(ids.length - 1, at + delta))]);
  }
  function startCreate() {
    if (!leave()) return;
    setCreating(true); setView("active"); setStatus(""); setError("");
  }

  const navItems: NavItem<View>[] = [
    { id: "active", label: "Foundations", icon: <NavActiveIcon />, count: sets.filter(item => !item.archived).length },
    { id: "archived", label: "Archived", icon: <NavArchivedIcon />, count: sets.filter(item => item.archived).length },
  ];

  return (
    <div className="klide-skills" data-embedded role="region" aria-label="Foundations">
      <div className="klide-cmd-header">
        <SearchIcon />
        <input
          className="klide-cmd-input"
          value={query}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            if (event.key === "ArrowDown") { event.preventDefault(); step(1); }
            else if (event.key === "ArrowUp") { event.preventDefault(); step(-1); }
          }}
          placeholder="Search foundations…"
          spellCheck={false}
          autoComplete="off"
          aria-label="Search foundations"
        />
      </div>

      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <nav aria-label="Sections" className="klide-skills-column" style={{ width: 196 }}>
          <NavRail navItems={navItems} tab={view} onTabChange={next => { setView(next); setCreating(false); }}
            action={{ label: "New foundation", icon: <PlusIcon />, onClick: startCreate }} />
        </nav>

        <main style={{ flex: 1, minWidth: 0, display: "flex" }} className="skills-tab-in" key={view}>
          <aside aria-label="Foundation list" className="klide-skills-column" style={{ width: 300 }}>
            <div className="klide-skills-list" role="listbox" aria-label="Foundations" {...hl.list}>
              <Highlight at={hl.indicator} />
              {!store && !error ? null : filtered.length === 0 ? (
                <div style={{ padding: "18px 12px", fontSize: 12, lineHeight: 1.55, color: "var(--fg-dim)" }}>
                  {query.trim()
                    ? `No foundations matching "${query.trim()}"`
                    : view === "archived"
                      ? "Archived foundations are kept for reference and no longer reach conversations."
                      : "A little shared context for your next conversations."}
                </div>
              ) : (
                <>
                  <div className="klide-cmd-heading">{view === "archived" ? "Archived" : "Shared"}</div>
                  {filtered.map(item => {
                    const active = !creating && item.id === selectedId;
                    return (
                      <div
                        key={item.id}
                        {...hl.row(item.id)}
                        onClick={() => pick(item.id)}
                        className="klide-cmd-option klide-skill-option"
                        role="option"
                        aria-selected={active}
                        data-active={active || undefined}
                        data-disabled={item.archived || undefined}
                      >
                        <div className="klide-skill-text">
                          <span>{item.title || "Untitled"}</span>
                          <small>{plural(item.conversationIds.length, "conversation")}</small>
                        </div>
                        <span className="klide-cmd-hint">{relativeTime(item.updatedAtMs).replace(/ ago$/, "")}</span>
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          </aside>

          <div style={{ flex: 1, minWidth: 0, overflow: "auto" }} className="skills-tab-in" key={creating ? "new" : selectedId ?? "empty"}>
            {creating ? (
              <CreateForm
                title={newTitle}
                setTitle={setNewTitle}
                busy={busy || !store}
                error={error}
                onCreate={() => void mutate({ type: "create", title: newTitle.trim(), conversationId })}
                onCancel={sets.length ? () => setCreating(false) : undefined}
              />
            ) : set ? (
              <div style={{ padding: "32px 36px", maxWidth: 780 }}>
                {/* Title row — the name is the field; actions beside it */}
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <label style={{ flex: 1, minWidth: 0 }}>
                    <span className="sn-sr-only">Title</span>
                    <input className="sn-title-input" value={draft.title} maxLength={160} disabled={busy}
                      onChange={event => setDraft(previous => ({ ...previous, title: event.target.value }))} placeholder="Untitled foundation" />
                  </label>
                  {dirty ? <>
                    <button className="klide-button klide-button-ghost" style={{ minHeight: 30, padding: "0 12px", color: "var(--fg-subtle)" }} disabled={busy}
                      onClick={() => { setDraft({ title: set.title, body: set.body }); selection.current = ""; }}>Discard</button>
                    <button className="klide-button klide-button-primary" style={{ minHeight: 30, padding: "0 14px" }}
                      disabled={busy || !draft.title.trim() || bytes(draft.body) > MAX_BYTES}
                      onClick={() => void mutate({ type: "edit", id: set.id, ...draft })}>{busy ? "Saving…" : "Save"}</button>
                  </> : <>
                    <Toggle on={!set.archived} disabled={busy}
                      label={set.archived ? `Restore ${set.title}` : `Archive ${set.title}`}
                      onClick={() => void mutate({ type: "archive", id: set.id, archived: !set.archived })} />
                    <div style={{ width: 1, height: 18, background: "var(--border)", margin: "0 4px" }} />
                    <DetailAction label="Delete foundation" danger onClick={() => {
                      if (window.confirm(`Delete "${set.title}"? Its notes and conversation links are removed.`)) void mutate({ type: "delete", id: set.id });
                    }}><TrashIcon /></DetailAction>
                  </>}
                </div>

                {/* Meta strip */}
                <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", rowGap: 6, columnGap: 22, alignItems: "center", fontSize: 12, color: "var(--fg-subtle)" }}>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-dim)" }}>{set.archived ? "Archived" : "Shared"}</span>
                  <span>{set.archived ? "Not supplied to conversations" : `Reaches ${plural(set.conversationIds.length, "conversation")}`}</span>
                  <span>Updated {relativeTime(set.updatedAtMs)}</span>
                  <button className="sn-quiet-link" onClick={() => void reload()} disabled={busy}>Reload</button>
                </div>
                {(error || status) && (
                  <p role={error ? "alert" : "status"} style={{ margin: "12px 0 0", fontSize: 12, color: error ? "var(--danger)" : "var(--fg-subtle)" }}>{error || status}</p>
                )}

                <blockquote className="klide-quote" style={{ marginTop: 20, fontSize: 13 }}>
                  The decisions, questions and next steps your conversations share — on any provider.
                </blockquote>

                {seed && !seedAdded && (
                  <section style={{ marginTop: 28 }}>
                    <div style={{ display: "flex", alignItems: "center" }}>
                      <SectionLabel>An answer worth keeping</SectionLabel>
                      <div style={{ flex: 1 }} />
                      <button className="klide-button klide-button-secondary" style={{ minHeight: 28, padding: "0 12px" }} disabled={set.archived || busy}
                        onClick={() => {
                          setDraft(previous => ({ ...previous, body: `${previous.body}${previous.body.trim() ? "\n\n" : ""}From conversation ${seed.sourceConversationId}:\n${seed.text}` }));
                          setSeedAdded(true);
                        }}>Add to notes</button>
                    </div>
                    <div className="klide-paper" style={{ marginTop: 10 }}>
                      <pre className="sn-paper-text" style={{ maxHeight: 160, overflow: "auto" }}>{seed.text}</pre>
                    </div>
                  </section>
                )}

                {/* The notes on paper */}
                <section style={{ marginTop: 28 }}>
                  <SectionLabel>Notes</SectionLabel>
                  <div className="klide-paper" style={{ marginTop: 10 }}>
                    <div className="klide-paper-header">
                      <span style={{ color: "var(--fg-subtle)" }}>Working notes</span>
                      <span style={{ flex: 1 }} />
                      <span style={{ color: bytes(draft.body) > MAX_BYTES ? "var(--danger)" : "var(--fg-dim)" }}>
                        {bytes(draft.body).toLocaleString()} / {MAX_BYTES.toLocaleString()} bytes
                      </span>
                    </div>
                    <textarea
                      className="sn-paper-editor"
                      aria-label="Notes"
                      value={draft.body}
                      disabled={busy}
                      onChange={event => setDraft(previous => ({ ...previous, body: event.target.value }))}
                      onSelect={event => { const field = event.currentTarget; selection.current = field.value.slice(field.selectionStart, field.selectionEnd); }}
                      placeholder={"What should the next conversation know?\n\nDecisions so far\nOpen questions\nWhat comes next"}
                    />
                  </div>
                  {dirty && (
                    <details className="sn-more">
                      <summary>Compare saved version</summary>
                      <div className="klide-paper" style={{ marginTop: 10 }}>
                        <pre className="sn-paper-text">{set.body || "No saved notes yet."}</pre>
                      </div>
                    </details>
                  )}
                </section>

                {/* Who receives them */}
                <ConversationsSection
                  setId={set.id}
                  linkedIds={set.conversationIds}
                  conversationId={conversationId}
                  conversations={conversations}
                  disabled={busy || dirty || set.archived}
                  note={dirty ? "Save or discard your edits before changing who shares them." : set.archived ? "Restore this foundation to share it again." : null}
                  onToggle={(id, linked) => void mutate({ type: "attach", id: linked ? null : set.id, conversationId: id })}
                />

                {/* A lasting lesson */}
                <section style={{ marginTop: 32 }}>
                  <div style={{ display: "flex", alignItems: "center" }}>
                    <SectionLabel>Lasting lesson</SectionLabel>
                    <div style={{ flex: 1 }} />
                    {onOpenMemory && <button className="sn-quiet-link" onClick={() => onOpenMemory(null)}>Open Project Memory</button>}
                  </div>
                  {!lessonOpen ? (
                    <p style={{ margin: "10px 0 0", fontSize: 12.5, lineHeight: 1.6, color: "var(--fg-subtle)" }}>
                      Select a passage in the notes, then{" "}
                      <button className="sn-quiet-link sn-inline-link" disabled={dirty || busy} onClick={() => {
                        if (selection.current.trim()) setLesson(selection.current.trim().slice(0, 4000));
                        if (!lessonTitle.trim()) setLessonTitle(draft.title);
                        setLessonOpen(true);
                      }}>propose it for Project Memory</button>. You review it before it is kept.
                    </p>
                  ) : (
                    <div style={{ marginTop: 14 }}>
                      <div style={{ marginBottom: 16 }}>
                        <label style={labelStyle} htmlFor={`sn-lesson-title-${set.id}`}>Lesson title</label>
                        <input id={`sn-lesson-title-${set.id}`} value={lessonTitle} maxLength={160} onChange={event => setLessonTitle(event.target.value)} placeholder="A clear, reusable takeaway" style={fieldStyle} />
                      </div>
                      <div style={{ marginBottom: 18 }}>
                        <label style={labelStyle} htmlFor={`sn-lesson-${set.id}`}>What to remember</label>
                        <textarea id={`sn-lesson-${set.id}`} value={lesson} maxLength={4000} onChange={event => setLesson(event.target.value)} rows={5}
                          placeholder="The lesson, with the file paths or test results that support it…"
                          style={{ ...fieldStyle, minHeight: 110, resize: "vertical", lineHeight: 1.65 }} />
                      </div>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <button className="klide-button klide-button-primary" style={{ minHeight: 32, padding: "0 16px" }}
                          disabled={!lessonTitle.trim() || !lesson.trim() || busy || dirty}
                          onClick={() => {
                            const proposed = addMemoryDraft(sharedNoteLesson(set, lessonTitle, lesson), workspaceRoot, { why: `Selected by you from the foundation "${set.title}".`, evidence: set.body });
                            setLesson(""); setLessonTitle(""); setLessonOpen(false);
                            if (onOpenMemory) onOpenMemory(proposed?.draftId ?? null);
                            else setStatus("Proposed. Review it in Memory → To review.");
                          }}>Review in Memory</button>
                        <button className="klide-button klide-button-ghost" style={{ minHeight: 32, padding: "0 12px", color: "var(--fg-subtle)" }}
                          onClick={() => { setLesson(""); setLessonTitle(""); setLessonOpen(false); }}>Cancel</button>
                      </div>
                    </div>
                  )}
                </section>
              </div>
            ) : (
              <EmptyDetail view={view} onCreate={startCreate} disabled={!store || busy} />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

function bytes(text: string): number { return new TextEncoder().encode(text).length; }

function ConversationsSection({ setId, linkedIds, conversationId, conversations, disabled, note, onToggle }: {
  setId: string;
  linkedIds: string[];
  conversationId: string;
  conversations: Conversation[];
  disabled: boolean;
  note: string | null;
  onToggle: (id: string, linked: boolean) => void;
}) {
  const members = [...new Set([conversationId, ...linkedIds, ...conversations.map(item => item.id)])].filter(Boolean);
  // Linked first, then the rest in the order they came.
  const ordered = [...members.filter(id => linkedIds.includes(id)), ...members.filter(id => !linkedIds.includes(id))];
  const groups = [
    { label: "Receiving these notes", ids: ordered.filter(id => linkedIds.includes(id)) },
    { label: "Not linked", ids: ordered.filter(id => !linkedIds.includes(id)) },
  ].filter(group => group.ids.length);
  return (
    <section style={{ marginTop: 32 }} key={setId}>
      <SectionLabel>Conversations</SectionLabel>
      <p style={{ margin: "6px 0 0", fontSize: 12, lineHeight: 1.55, color: "var(--fg-dim)" }}>
        {note ?? "A linked conversation receives the saved notes on its next turn, whichever provider it uses. In an interactive CLI session, send through Klide's composer to include them."}
      </p>
      {members.length === 0 ? (
        <p style={{ margin: "12px 0 0", fontSize: 12.5, color: "var(--fg-subtle)" }}>No conversations in this project yet.</p>
      ) : (
        <div className="sn-conversations">
          {groups.map(group => (
            <Fragment key={group.label}>
              <div className="klide-cmd-heading">{group.label}</div>
              {group.ids.map(id => {
                const conversation = conversations.find(item => item.id === id);
                const linked = linkedIds.includes(id);
                const name = id === conversationId ? "This conversation" : conversation?.title || "Linked conversation";
                return (
                  <div className="klide-cmd-option klide-skill-option sn-conversation" key={id} data-disabled={!linked || undefined}>
                    <div className="klide-skill-text">
                      <span title={id}>{name}</span>
                      <small>{conversation?.provider ?? (id === conversationId ? "Current chat" : "Saved conversation")}</small>
                    </div>
                    <Toggle on={linked} disabled={disabled} label={`${linked ? "Stop sharing with" : "Share with"} ${name}`} onClick={() => onToggle(id, linked)} />
                  </div>
                );
              })}
            </Fragment>
          ))}
        </div>
      )}
    </section>
  );
}

function CreateForm({ title, setTitle, busy, error, onCreate, onCancel }: {
  title: string; setTitle: (t: string) => void; busy: boolean; error: string;
  onCreate: () => void; onCancel?: () => void;
}) {
  return (
    <form style={{ padding: "32px 36px", maxWidth: 720 }} onSubmit={event => { event.preventDefault(); if (title.trim() && !busy) onCreate(); }}>
      <h2 style={{ margin: "0 0 8px", fontSize: 19, fontWeight: 600, color: "var(--fg-strong)", letterSpacing: "-0.014em" }}>New foundation</h2>
      <p style={{ margin: "0 0 22px", fontSize: 12.5, lineHeight: 1.6, color: "var(--fg-subtle)" }}>
        One place for the decisions and open questions a set of conversations shares, so the next one starts with the context it needs.
      </p>
      <div style={{ marginBottom: 22 }}>
        <label style={labelStyle} htmlFor="sn-new-title">Name</label>
        <input id="sn-new-title" autoFocus value={title} maxLength={160} onChange={event => setTitle(event.target.value)} placeholder="e.g. Billing migration" style={fieldStyle} />
      </div>
      {error && <p role="alert" style={{ margin: "0 0 14px", fontSize: 12, color: "var(--danger)" }}>{error}</p>}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button type="submit" disabled={busy || !title.trim()} className={title.trim() ? "klide-button klide-button-primary" : "klide-button klide-button-secondary"} style={{ minHeight: 32, padding: "0 16px" }}>
          Create foundation
        </button>
        {onCancel && <button type="button" onClick={onCancel} className="klide-button klide-button-ghost" style={{ minHeight: 32, padding: "0 12px", color: "var(--fg-subtle)" }}>Cancel</button>}
      </div>
    </form>
  );
}

function EmptyDetail({ view, onCreate, disabled }: { view: View; onCreate: () => void; disabled: boolean }) {
  return (
    <div style={{ height: "100%", display: "grid", placeItems: "center", color: "var(--fg-subtle)", textAlign: "center", padding: 40 }}>
      <div style={{ maxWidth: 320 }}>
        <div style={{ width: 44, height: 44, borderRadius: "var(--radius-md)", background: "var(--bg-elevated)", border: "1px solid var(--border)", display: "grid", placeItems: "center", margin: "0 auto 14px", color: "var(--fg-subtle)" }}>
          {view === "archived" ? <NavArchivedIcon /> : <NavActiveIcon />}
        </div>
        <div style={{ color: "var(--fg-strong)", marginBottom: 6, fontSize: 14, fontWeight: 600 }}>No foundation selected</div>
        <div style={{ fontSize: 12.5, lineHeight: 1.55, color: "var(--fg-subtle)", marginBottom: 16 }}>
          Pick one from the list, or start a shared place to pick up the thread.
        </div>
        <button onClick={onCreate} disabled={disabled} className="klide-button klide-button-secondary" style={{ minHeight: 32, padding: "0 14px" }}>
          <PlusIcon /> New foundation
        </button>
      </div>
    </div>
  );
}
