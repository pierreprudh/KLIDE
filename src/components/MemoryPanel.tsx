import { notify } from "../toast";
import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  listMemory,
  listMemoryProposals,
  reviewMemoryProposal,
  readMemory,
  relativeMemoryTime,
  writeMemory,
  type MemoryEntry,
  type MemoryKind,
} from "../memory";
import {
  subscribeMemoryDrafts,
  getMemoryDrafts,
  removeMemoryDraft,
  dismissMemoryDraft,
  MEMORY_DRAFT_TTL,
  type MemoryDraft,
} from "../memoryDrafts";
import {
  matchesMemoryQuery,
  memoryMatchNote,
  parseMemoryQuery,
} from "../memorySearch";
import { useSlidingHighlight } from "../hooks/useSlidingHighlight";
import {
  DetailAction,
  Highlight,
  NavRail,
  PencilIcon,
  SearchIcon,
  SectionLabel,
  ViewToggle,
  fieldStyle,
  labelStyle,
  renderMarkdown,
  type NavItem,
} from "./library/parts";

// Project Memory as the Library's Memory tab — the same body as Skills: the
// command menu's field on top, the sections on the left, the list beside
// them, and the page. Saved notes group by kind; proposals wait under
// "To review" and are kept or dismissed from their page.

type Props = {
  workspaceRoot: string | null;
  /** Open a memory entry's raw markdown as an editor tab. */
  onOpenInEditor?: (path: string, content: string) => void;
  /** Open a source file referenced by a memory entry. */
  onOpenTouchedFile?: (path: string) => void;
  /** Bumped when the AI panel writes a new entry, to force a refresh. */
  refreshKey?: number;
  initialDraftId?: string | null;
};

type View = "saved" | "review";

/* ------------------------------------------------------------------ icons */

function NavSavedIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 3.5h12a1 1 0 0 1 1 1v16l-7-4-7 4v-16a1 1 0 0 1 1-1z" />
    </svg>
  );
}
function NavReviewIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.5 13.5l2.6-7.2A1.5 1.5 0 0 1 7.5 5.3h9a1.5 1.5 0 0 1 1.4 1l2.6 7.2" />
      <path d="M3.5 13.5V18a1.5 1.5 0 0 0 1.5 1.5h14a1.5 1.5 0 0 0 1.5-1.5v-4.5h-5l-1.5 2.5h-4L8.5 13.5z" />
    </svg>
  );
}

/* ------------------------------------------------------------- vocabulary */

const KIND_ORDER: MemoryKind[] = ["decision", "convention", "pattern", "fact", "failure", "handoff", "run"];
const KIND_GROUP: Record<MemoryKind, string> = {
  decision: "Decisions",
  convention: "Conventions",
  pattern: "Patterns",
  fact: "Facts",
  failure: "Failures",
  handoff: "Handoffs",
  run: "Run notes",
};
const KIND_ONE: Record<MemoryKind, string> = {
  decision: "Decision",
  convention: "Convention",
  pattern: "Pattern",
  fact: "Fact",
  failure: "Failure",
  handoff: "Handoff",
  run: "Run note",
};

/** "3d ago" → "3d": the row's hint column is narrow and always about age. */
function age(ts: number): string {
  const t = relativeMemoryTime(ts);
  return t === "just now" ? "now" : t.replace(/ ago$/, "");
}

/** One line under a row's title — what it says beyond its title, if anything. */
function summaryOf(e: { title: string; goal: string; notes: string }): string | null {
  const title = e.title.trim().toLowerCase();
  for (const text of [e.goal, e.notes]) {
    const t = text.trim();
    if (t && t.toLowerCase() !== title) return t.split("\n")[0];
  }
  return null;
}

/** A saved note's body as markdown — its lists under small headings, then its
 *  free notes. The title and goal are drawn above the paper, not repeated. */
function noteMarkdown(e: MemoryEntry): string {
  const parts: string[] = [];
  const list = (heading: string, items: string[]) => {
    if (items.length) parts.push(`### ${heading}\n${items.map((i) => `- ${i}`).join("\n")}`);
  };
  list("Decisions", e.decisions);
  list("Plan", e.plan);
  list("Next steps", e.nextSteps);
  if (e.notes.trim()) parts.push(e.notes.trim());
  return parts.join("\n\n");
}

/* ============================================================== panel === */

export function MemoryPanel({
  workspaceRoot,
  onOpenInEditor,
  onOpenTouchedFile,
  refreshKey = 0,
  initialDraftId = null,
}: Props) {
  const [view, setView] = useState<View>(initialDraftId ? "review" : "saved");
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rawContent, setRawContent] = useState<string | null>(null);
  const [rawLoading, setRawLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [rawView, setRawView] = useState(false);
  const [savingDraftId, setSavingDraftId] = useState<string | null>(null);
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(initialDraftId);

  // A lesson proposed while the Library is open lands on its page.
  useEffect(() => {
    if (!initialDraftId) return;
    setView("review");
    setSelectedDraftId(initialDraftId);
  }, [initialDraftId]);

  // Pending memory drafts (from finished runs) awaiting keep / dismiss.
  // The store snapshot is shared across panels; filter to this workspace.
  const localDrafts = useSyncExternalStore(subscribeMemoryDrafts, getMemoryDrafts);
  const [proposals, setProposals] = useState<MemoryDraft[]>([]);
  const [proposalError, setProposalError] = useState<string | null>(null);
  // Bumped by every Keep / Dismiss: a poll that started before one lands
  // carries the old inbox and must not put the reviewed proposal back.
  const reviewGeneration = useRef(0);
  // Pending proposals survive panel closure and process restarts. Poll only
  // while this review surface is mounted; avoid stale results on workspace switches.
  useEffect(() => {
    if (!workspaceRoot) { setProposals([]); return; }
    let disposed = false;
    async function load() {
      const generation = reviewGeneration.current;
      try {
        const items = await listMemoryProposals(workspaceRoot!);
        if (disposed || generation !== reviewGeneration.current) return;
        setProposalError(null);
        // Same inbox → same array, so an idle poll re-renders nothing.
        setProposals((current) =>
          current.length === items.length && current.every((p, i) => p.draftId === items[i].draftId)
            ? current
            : items.map((p) => ({ ...p, workspaceRoot: workspaceRoot!, backendProposal: true })),
        );
      } catch (err) {
        if (!disposed) setProposalError(String(err));
      }
    }
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => { disposed = true; clearInterval(timer); };
  }, [workspaceRoot]);
  const allDrafts = useMemo(() => [...proposals, ...localDrafts], [proposals, localDrafts]);
  const drafts = useMemo(
    () => allDrafts.filter((d) => d.workspaceRoot === workspaceRoot && (!d.automatic || Date.now() - d.createdAtMs < MEMORY_DRAFT_TTL)),
    [allDrafts, workspaceRoot]
  );
  // A failed inbox poll clears itself on the next good one; an action's
  // error stays until the next action.
  const shownError = error ?? proposalError;

  async function refresh() {
    if (!workspaceRoot) return;
    setError(null);
    try {
      const list = await listMemory(workspaceRoot);
      setEntries(list);
      setSelectedId((current) => (list.some((e) => e.id === current) ? current : (list[0]?.id ?? null)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void refresh();
  }, [workspaceRoot, refreshKey]);

  // Keep a draft: write it to durable memory and drop it. The next proposal
  // opens in its place; the last one hands over to the note it became.
  async function acceptDraft(draft: MemoryDraft) {
    if (!workspaceRoot || savingDraftId) return;
    setSavingDraftId(draft.draftId);
    try {
      const { draftId, createdAtMs: _created, workspaceRoot: _ws, automatic: _auto, why: _why, evidence: _evidence, backendProposal: _backend, ...input } = draft;
      if (draft.backendProposal) reviewGeneration.current += 1;
      const entry = draft.backendProposal
        ? await reviewMemoryProposal(workspaceRoot, draftId, { title: draft.title, notes: draft.notes, goal: draft.goal, decisions: draft.decisions })
        : await writeMemory(workspaceRoot, input);
      if (draft.backendProposal) setProposals((items) => items.filter((p) => p.draftId !== draftId));
      else removeMemoryDraft(draftId);
      const next = drafts.find((d) => d.draftId !== draftId) ?? null;
      setSelectedDraftId(next?.draftId ?? null);
      await refresh();
      if (!next) {
        setView("saved");
        if (entry) setSelectedId(entry.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingDraftId(null);
    }
  }

  async function dismissDraft(draft: MemoryDraft) {
    if (!workspaceRoot || savingDraftId) return;
    setSavingDraftId(draft.draftId);
    try {
      if (draft.backendProposal) {
        reviewGeneration.current += 1;
        // An interrupted Keep had already saved it: say so rather than
        // pretend the lesson is gone.
        const saved = await reviewMemoryProposal(workspaceRoot, draft.draftId, null);
        setProposals((items) => items.filter((p) => p.draftId !== draft.draftId));
        if (saved) {
          notify(`"${saved.title}" was already saved to Project Memory.`, { tone: "warn" });
          await refresh();
        }
      } else dismissMemoryDraft(draft);
      setSelectedDraftId(drafts.find((d) => d.draftId !== draft.draftId)?.draftId ?? null);
    } catch (err) {
      setError(String(err));
    } finally {
      setSavingDraftId(null);
    }
  }

  // Load raw markdown on selection (for the "Source" view).
  useEffect(() => {
    let cancelled = false;
    const entry = entries.find((e) => e.id === selectedId);
    if (!workspaceRoot || !entry) {
      setRawContent(null);
      return;
    }
    setRawLoading(true);
    setRawContent(null);
    readMemory(workspaceRoot, entry.relPath)
      .then((c) => { if (!cancelled) setRawContent(c); })
      .catch(() => { if (!cancelled) setRawContent(null); })
      .finally(() => { if (!cancelled) setRawLoading(false); });
    return () => { cancelled = true; };
  }, [workspaceRoot, selectedId, entries]);

  // Memory search: bare terms match anywhere; `file:` / `run:` /
  // `decision:` scope to that facet (see memorySearch.ts).
  const parsedQuery = useMemo(() => parseMemoryQuery(query), [query]);
  const filtered = useMemo(() => {
    if (!query.trim()) return entries;
    return entries.filter((e) => matchesMemoryQuery(e, parsedQuery));
  }, [entries, query, parsedQuery]);
  const filteredDrafts = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return drafts;
    return drafts.filter((d) => [d.title, d.notes, d.goal, d.why ?? ""].some((t) => t.toLowerCase().includes(q)));
  }, [drafts, query]);

  // The list in the order it is drawn, so ↑ / ↓ follow the rows on screen.
  const groups = useMemo(
    () => KIND_ORDER
      .map((kind) => ({ kind, label: KIND_GROUP[kind], items: filtered.filter((e) => e.kind === kind) }))
      .concat([{ kind: "run" as MemoryKind, label: "Other", items: filtered.filter((e) => !KIND_ORDER.includes(e.kind)) }])
      .filter((g) => g.items.length > 0),
    [filtered],
  );
  const orderedIds = view === "saved"
    ? groups.flatMap((g) => g.items.map((e) => e.id))
    : filteredDrafts.map((d) => d.draftId);

  // The review page always shows a proposal while there is one.
  useEffect(() => {
    if (view !== "review") return;
    if (!drafts.some((d) => d.draftId === selectedDraftId)) setSelectedDraftId(drafts[0]?.draftId ?? null);
  }, [view, drafts, selectedDraftId]);

  const selected = view === "saved" ? entries.find((e) => e.id === selectedId) ?? null : null;
  const selectedDraft = view === "review" ? drafts.find((d) => d.draftId === selectedDraftId) ?? null : null;

  function select(id: string) {
    if (view === "saved") { setSelectedId(id); setRawView(false); }
    else setSelectedDraftId(id);
  }
  function step(delta: 1 | -1) {
    if (orderedIds.length === 0) return;
    const current = view === "saved" ? selectedId : selectedDraftId;
    const at = current ? orderedIds.indexOf(current) : -1;
    select(orderedIds[at < 0 ? 0 : Math.max(0, Math.min(orderedIds.length - 1, at + delta))]);
  }

  /** "Browse by" from a page: filter saved notes by this run / file. */
  function searchFacet(facetQuery: string) {
    setView("saved");
    setQuery(facetQuery);
  }

  async function openInEditor(entry: MemoryEntry) {
    if (!onOpenInEditor || !workspaceRoot) return;
    try {
      const content = await readMemory(workspaceRoot, entry.relPath);
      onOpenInEditor(entry.path, content);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const navItems: NavItem<View>[] = [
    { id: "saved", label: "Saved", icon: <NavSavedIcon />, count: entries.length },
    { id: "review", label: "To review", icon: <NavReviewIcon />, count: drafts.length },
  ];

  const activeKey = view === "saved" ? selectedId : selectedDraftId;
  const hl = useSlidingHighlight(activeKey, `${view}|${orderedIds.join("|")}`);

  return (
    <div className="klide-skills" data-embedded role="region" aria-label="Memory">
      <div className="klide-cmd-header">
        <SearchIcon />
        <input
          className="klide-cmd-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); step(1); }
            else if (e.key === "ArrowUp") { e.preventDefault(); step(-1); }
          }}
          placeholder={view === "saved" ? "Search memories…" : "Search proposals…"}
          title={view === "saved" ? "Narrow with file:, run: or decision:" : undefined}
          spellCheck={false}
          autoComplete="off"
          aria-label={view === "saved" ? "Search memories" : "Search proposals"}
        />
        {query.trim() && view === "saved" && <span className="klide-cmd-hint">file: · run: · decision:</span>}
      </div>

      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <nav aria-label="Sections" className="klide-skills-column" style={{ width: 196 }}>
          <NavRail navItems={navItems} tab={view} onTabChange={setView} />
        </nav>

        <main style={{ flex: 1, minWidth: 0, display: "flex" }} className="skills-tab-in" key={view}>
          <aside aria-label={view === "saved" ? "Saved memories" : "Proposed memories"} className="klide-skills-column" style={{ width: 300 }}>
            <div className="klide-skills-list" role="listbox" aria-label={view === "saved" ? "Memories" : "Proposals"} {...hl.list}>
              <Highlight at={hl.indicator} />
              {!workspaceRoot ? (
                <ListNote>Open a folder to start a project memory.</ListNote>
              ) : shownError ? (
                <ListNote tone="error">{shownError}</ListNote>
              ) : view === "saved" ? (
                filtered.length === 0 ? (
                  <ListNote>
                    {entries.length === 0
                      ? "Useful lessons will appear here as you work. You choose what stays."
                      : `No memories matching "${query.trim()}"`}
                  </ListNote>
                ) : groups.map((group) => (
                  <Fragment key={group.label}>
                    <div className="klide-cmd-heading">{group.label}</div>
                    {group.items.map((e) => {
                      const active = e.id === selectedId;
                      const note = query.trim() ? memoryMatchNote(e, parsedQuery) : null;
                      const sub = note ?? summaryOf(e);
                      return (
                        <div
                          key={e.id}
                          {...hl.row(e.id)}
                          onClick={() => select(e.id)}
                          className="klide-cmd-option klide-skill-option"
                          role="option"
                          aria-selected={active}
                          data-active={active || undefined}
                        >
                          <div className="klide-skill-text">
                            <span>{e.title}</span>
                            {sub && <small title={sub}>{sub}</small>}
                          </div>
                          <span className="klide-cmd-hint">{age(e.createdAtMs)}</span>
                        </div>
                      );
                    })}
                  </Fragment>
                ))
              ) : filteredDrafts.length === 0 ? (
                <ListNote>
                  {drafts.length === 0
                    ? "Nothing to review. Lessons Kit proposes wait here until you keep or dismiss them."
                    : `No proposals matching "${query.trim()}"`}
                </ListNote>
              ) : (
                <>
                  <div className="klide-cmd-heading">Proposed</div>
                  {filteredDrafts.map((d) => {
                    const active = d.draftId === selectedDraftId;
                    const sub = d.why?.trim() || summaryOf(d);
                    return (
                      <div
                        key={d.draftId}
                        {...hl.row(d.draftId)}
                        onClick={() => select(d.draftId)}
                        className="klide-cmd-option klide-skill-option"
                        role="option"
                        aria-selected={active}
                        data-active={active || undefined}
                      >
                        <div className="klide-skill-text">
                          <span>{d.title}</span>
                          {sub && <small title={sub}>{sub}</small>}
                        </div>
                        <span className="klide-cmd-hint">{age(d.createdAtMs)}</span>
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          </aside>

          <div style={{ flex: 1, minWidth: 0, overflow: "auto" }} className="skills-tab-in" key={selected?.id ?? selectedDraft?.draftId ?? "empty"}>
            {selectedDraft ? (
              <DraftReview
                draft={selectedDraft}
                saving={savingDraftId !== null}
                onAccept={(edited) => void acceptDraft(edited)}
                onSkip={() => void dismissDraft(selectedDraft)}
              />
            ) : selected ? (
              <MemoryDetail
                entry={selected}
                rawView={rawView}
                setRawView={setRawView}
                rawContent={rawContent}
                rawLoading={rawLoading}
                onOpenInEditor={onOpenInEditor ? () => void openInEditor(selected) : undefined}
                onOpenTouchedFile={onOpenTouchedFile}
                onSearchRun={(runId) => searchFacet(`run:${runId}`)}
              />
            ) : (
              <EmptyDetail view={view} />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

function ListNote({ children, tone }: { children: string; tone?: "error" }) {
  return (
    <div style={{ padding: "18px 12px", fontSize: 12, lineHeight: 1.55, color: tone === "error" ? "var(--danger)" : "var(--fg-dim)" }}>
      {children}
    </div>
  );
}

/* ============================================================ detail === */

function MemoryDetail({
  entry,
  rawView,
  setRawView,
  rawContent,
  rawLoading,
  onOpenInEditor,
  onOpenTouchedFile,
  onSearchRun,
}: {
  entry: MemoryEntry;
  rawView: boolean;
  setRawView: (v: boolean) => void;
  rawContent: string | null;
  rawLoading: boolean;
  onOpenInEditor?: () => void;
  onOpenTouchedFile?: (path: string) => void;
  /** Filter the list to every note written from this run ("browse by run"). */
  onSearchRun?: (runId: string) => void;
}) {
  const body = noteMarkdown(entry);
  const goal = entry.goal.trim();
  const showGoal = goal && goal.toLowerCase() !== entry.title.trim().toLowerCase();
  const raw = rawContent?.trim() ?? "";
  const lineCount = raw ? raw.split("\n").length : 0;
  return (
    <div style={{ padding: "32px 36px", maxWidth: 780 }}>
      {/* Title row */}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <h1 style={{ flex: 1, minWidth: 0, margin: 0, fontSize: 22, fontWeight: 600, color: "var(--fg-strong)", letterSpacing: "-0.018em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={entry.title}>
          {entry.title}
        </h1>
        {onOpenInEditor && (
          <DetailAction label="Open in editor" onClick={onOpenInEditor}><PencilIcon /></DetailAction>
        )}
      </div>

      {/* Meta strip */}
      <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", rowGap: 6, columnGap: 22, alignItems: "center", fontSize: 12, color: "var(--fg-subtle)" }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-dim)" }}>{KIND_ONE[entry.kind] ?? entry.kind}</span>
        <span>Written {relativeMemoryTime(entry.createdAtMs)}</span>
        {(entry.provider || entry.model) && (
          <span>{[entry.provider, entry.model].filter(Boolean).join(" · ")}</span>
        )}
        {entry.runId && (
          <button
            onClick={onSearchRun ? () => onSearchRun(entry.runId!) : undefined}
            title="Show every note written from this run"
            className="memory-run-link"
          >
            run {entry.runId.length > 18 ? `${entry.runId.slice(0, 18)}…` : entry.runId}
          </button>
        )}
      </div>

      {showGoal && (
        <blockquote className="klide-quote" style={{ marginTop: 20, fontSize: 13 }}>
          {goal}
        </blockquote>
      )}

      {/* Files touched — the Skills page's tool list, but each opens */}
      {entry.filesTouched.length > 0 && (
        <section style={{ marginTop: 28 }}>
          <SectionLabel>Files touched</SectionLabel>
          <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", rowGap: 8, columnGap: 22, fontSize: 11.5, fontFamily: "var(--font-mono)", color: "var(--fg)" }}>
            {entry.filesTouched.map((path) => onOpenTouchedFile ? (
              <button key={path} title={`Open ${path}`} onClick={() => onOpenTouchedFile(path)} className="memory-file-link">{path}</button>
            ) : (
              <span key={path} style={{ whiteSpace: "nowrap" }}>{path}</span>
            ))}
          </div>
        </section>
      )}

      {/* The note on paper */}
      <section style={{ marginTop: 32 }}>
        <div style={{ display: "flex", alignItems: "center" }}>
          <SectionLabel>Note</SectionLabel>
          <div style={{ flex: 1 }} />
          <ViewToggle raw={rawView} onChange={setRawView} />
        </div>
        <div className="klide-paper" style={{ marginTop: 10 }}>
          <div className="klide-paper-header">
            <span style={{ color: "var(--fg-subtle)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={entry.relPath}>{entry.relPath}</span>
            <span style={{ flex: 1 }} />
            {raw && <>
              <span style={{ color: "var(--fg-dim)", flexShrink: 0 }}>{lineCount} {lineCount === 1 ? "line" : "lines"}</span>
              <span style={{ color: "var(--fg-dim)", marginLeft: 10, flexShrink: 0 }}>{raw.length} chars</span>
            </>}
          </div>
          <div style={{ padding: "18px 26px" }}>
            {rawView ? (
              rawLoading ? (
                <div style={{ color: "var(--fg-subtle)", fontSize: 13 }}>Loading source…</div>
              ) : rawContent ? (
                <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.7, color: "var(--fg)" }}>{rawContent}</pre>
              ) : (
                <div style={{ color: "var(--fg-subtle)", fontSize: 13 }}>Could not read the source file.</div>
              )
            ) : body ? (
              <div>{renderMarkdown(body)}</div>
            ) : (
              <div style={{ color: "var(--fg-subtle)", fontSize: 13 }}>{showGoal ? "Nothing more than its goal." : "This note has no content yet."}</div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

/* ====================================================== draft review === */

// Editable review of a proposed memory — the Skills edit form's shape. Local
// state seeded from the draft (the page is keyed by draftId, so picking
// another remounts it fresh). Keep hands the edited note back to be written;
// Dismiss discards. Files touched stays read-only — it's extracted, not authored.
function DraftReview({
  draft,
  saving,
  onAccept,
  onSkip,
}: {
  draft: MemoryDraft;
  saving: boolean;
  onAccept: (edited: MemoryDraft) => void;
  onSkip: () => void;
}) {
  const [title, setTitle] = useState(draft.title);
  const [goal, setGoal] = useState(draft.goal);
  const [notes, setNotes] = useState(draft.notes);
  const [decisionsText, setDecisionsText] = useState(draft.decisions.join("\n"));
  const canKeep = title.trim().length > 0;
  // A proposal often repeats its title as goal and decision; then those
  // fields fold away rather than read as the same line three times.
  const echoesTitle = [draft.goal, ...draft.decisions].every((t) => !t.trim() || t.trim() === draft.title.trim());

  function accept() {
    onAccept({
      ...draft,
      title: title.trim() || "Untitled session",
      goal: goal.trim(),
      notes: notes.trim(),
      decisions: decisionsText
        .split("\n")
        .map((l) => l.replace(/^[-*]\s+/, "").trim())
        .filter(Boolean),
    });
  }

  const id = (name: string) => `mr-${name}-${draft.draftId}`;
  return (
    <div style={{ padding: "32px 36px", maxWidth: 720 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <h2 style={{ flex: 1, minWidth: 0, margin: 0, fontSize: 19, fontWeight: 600, color: "var(--fg-strong)", letterSpacing: "-0.014em" }}>
          Keep this lesson?
        </h2>
        <button onClick={onSkip} disabled={saving} className="klide-button klide-button-ghost" style={{ minHeight: 30, padding: "0 12px", color: "var(--fg-subtle)" }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--fg-strong)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "var(--fg-subtle)"; }}>
          Dismiss
        </button>
        <button
          onClick={accept}
          disabled={saving || !canKeep}
          className={canKeep ? "klide-button klide-button-primary" : "klide-button klide-button-secondary"}
          style={{ minHeight: 30, padding: "0 14px" }}
        >
          {saving ? "Keeping…" : "Keep"}
        </button>
      </div>
      <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", rowGap: 6, columnGap: 22, alignItems: "center", fontSize: 12, color: "var(--fg-subtle)" }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-dim)" }}>{KIND_ONE[draft.kind] ?? draft.kind}</span>
        <span>Proposed {relativeMemoryTime(draft.createdAtMs)}</span>
        {draft.automatic && <span>after a finished run</span>}
      </div>
      {draft.why?.trim() && (
        <blockquote className="klide-quote" style={{ marginTop: 18, fontSize: 13, WebkitLineClamp: 3 }}>
          {draft.why.trim()}
        </blockquote>
      )}

      <div style={{ marginTop: 26, marginBottom: 18 }}>
        <label style={labelStyle} htmlFor={id("title")}>Title</label>
        <input id={id("title")} value={title} onChange={(e) => setTitle(e.target.value)} style={fieldStyle} />
      </div>
      <div style={{ marginBottom: 18 }}>
        <label style={labelStyle} htmlFor={id("notes")}>What to remember</label>
        <textarea id={id("notes")} value={notes} onChange={(e) => setNotes(e.target.value)} rows={5}
          style={{ ...fieldStyle, minHeight: 110, resize: "vertical", lineHeight: 1.65 }} />
      </div>
      <details className="memory-more" open={!echoesTitle}>
        <summary>Goal and decisions</summary>
        <div style={{ marginTop: 14, marginBottom: 18 }}>
          <label style={labelStyle} htmlFor={id("goal")}>Goal</label>
          <input id={id("goal")} value={goal} onChange={(e) => setGoal(e.target.value)} style={fieldStyle} />
        </div>
        <div style={{ marginBottom: 22 }}>
          <label style={labelStyle} htmlFor={id("decisions")}>Decisions, one per line</label>
          <textarea id={id("decisions")} value={decisionsText} onChange={(e) => setDecisionsText(e.target.value)} rows={3}
            style={{ ...fieldStyle, resize: "vertical", lineHeight: 1.65 }} />
        </div>
      </details>

      {draft.filesTouched.length > 0 && (
        <section style={{ marginBottom: 22 }}>
          <SectionLabel>Files touched</SectionLabel>
          <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", rowGap: 8, columnGap: 22, fontSize: 11.5, fontFamily: "var(--font-mono)", color: "var(--fg)" }}>
            {draft.filesTouched.map((path) => <span key={path} style={{ whiteSpace: "nowrap" }}>{path}</span>)}
          </div>
        </section>
      )}

      {(draft.evidence?.trim() || draft.sourceRefs.length > 0) && (
        <section style={{ marginBottom: 26 }}>
          <SectionLabel>Evidence</SectionLabel>
          <div className="klide-paper" style={{ marginTop: 10 }}>
            {draft.sourceRefs.length > 0 && (
              <div className="klide-paper-header">
                {draft.sourceRefs.map((ref) => (
                  <span key={ref.id} title={ref.id} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {ref.label ?? ref.sourceType} {ref.id.length > 14 ? `${ref.id.slice(0, 14)}…` : ref.id}
                  </span>
                ))}
              </div>
            )}
            {draft.evidence?.trim() && (
              <pre style={{ margin: 0, padding: "14px 18px", maxHeight: 220, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.7, color: "var(--fg)" }}>
                {draft.evidence.trim()}
              </pre>
            )}
          </div>
        </section>
      )}

    </div>
  );
}

function EmptyDetail({ view }: { view: View }) {
  return (
    <div style={{ height: "100%", display: "grid", placeItems: "center", color: "var(--fg-subtle)", textAlign: "center", padding: 40 }}>
      <div style={{ maxWidth: 320 }}>
        <div style={{ width: 44, height: 44, borderRadius: "var(--radius-md)", background: "var(--bg-elevated)", border: "1px solid var(--border)", display: "grid", placeItems: "center", margin: "0 auto 14px", color: "var(--fg-subtle)" }}>
          {view === "saved" ? <NavSavedIcon /> : <NavReviewIcon />}
        </div>
        <div style={{ color: "var(--fg-strong)", marginBottom: 6, fontSize: 14, fontWeight: 600 }}>
          {view === "saved" ? "No memory selected" : "Nothing to review"}
        </div>
        <div style={{ fontSize: 12.5, lineHeight: 1.55, color: "var(--fg-subtle)" }}>
          {view === "saved"
            ? "Pick a note from the list to read what Kit remembers about this project."
            : "When Kit finds a lasting lesson in a run, it waits here for you to keep or dismiss."}
        </div>
      </div>
    </div>
  );
}
