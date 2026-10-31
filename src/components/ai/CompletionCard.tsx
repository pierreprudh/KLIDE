import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { commandStatusSummary, completionDocumentCount, completionDocuments, hasCompletionReview, isCommandHistory, netFileChanges, type RunCompletion } from "../../agent/completion";
import type { CheckpointEntry } from "../../agent/types";
import { buildDiffRows, type DiffRow } from "../../lineDiff";
import { DiffStat } from "../diffView";
import { DocumentAppMark, stackedDocumentMarks } from "../../documentAppLogo";
import { artifactActionLabel, artifactPreview } from "../../artifacts";
import { ChevronIcon, CloseIcon, DocumentIcon, ReviewIcon } from "../../icons";
import { formatBytes } from "../settings/storage";
import { Z } from "../../zLayers";
import "./completionCard.css";

/** Where the entry sits. `inline` is the row under the turn that produced it;
 *  `island` is the Focus canvas' right column, under the plan — the run's
 *  result waiting where its plan just was, rather than at the far end of a
 *  transcript the reader has to scroll back down to. */
export type CompletionCardVariant = "inline" | "island";

type Props = {
  completion: RunCompletion;
  disabled?: boolean;
  onReview?: (path?: string) => void;
  /** Open a document the run produced. Where it opens — the inspector, or the
   *  app the machine owns it with — is the host's call, not the card's. */
  onOpenArtifact?: (path: string) => void;
  /** A picture of a document Klide cannot render, when the host can make one.
   *  Resolving to null is a normal answer — some files have no preview. */
  onPreviewArtifact?: (path: string) => Promise<string | null>;
  onRequestChanges: () => void;
  variant?: CompletionCardVariant;
  /** Too little room for the words: the entry keeps the mark and the count,
   *  and the label it drops moves to its tooltip and accessible name. */
  compact?: boolean;
  /** The column around it is closed: the result shows as its mark and nothing
   *  else, the way the plan folds. Clicking it opens the column (`onUnfold`),
   *  which is a different act from opening the evidence. */
  folded?: boolean;
  onUnfold?: () => void;
  /** The run's file checkpoints, for the +/− counts and the in-place diff.
   *  Absent, the changed files are a plain list. */
  loadChanges?: (runId: string) => Promise<CheckpointEntry[]>;
};

type EvidenceProps = Pick<Props, "completion" | "disabled" | "onReview" | "onOpenArtifact" | "onPreviewArtifact" | "onRequestChanges" | "loadChanges"> & {
  onDone: () => void;
  /** Diffs a host already loaded (the island reads them for its header). */
  diffs?: Map<string, FileDiff> | null;
};

/** The evidence itself — the same sections and the same two actions wherever
 *  it is read: inside the island card on the canvas, or in the sheet the
 *  transcript's entry opens. Exported so its markup can be tested without a
 *  DOM to click in. */
/** One stack in the result — Changes, Documents, the commands — behind a row
 *  that names it and the app's chevron. Not a native `<details>`: that element
 *  cannot animate its height, so every open snapped and the card jumped with
 *  it. The body is a grid whose one row goes from 0fr to 1fr, which is the
 *  one height transition CSS can do without knowing the height, and the card
 *  above it grows and shrinks at the same pace. Closed, the content stays in
 *  the tree but clipped and inert. */
function Fold({ name, open, onToggle, title, label, failed, children }: {
  name: string;
  open: boolean;
  onToggle: () => void;
  title: ReactNode;
  label?: string;
  failed?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div className={`klide-result-fold klide-result-${name}`} data-open={open ? "1" : undefined} data-failed={failed ? "1" : undefined}>
      <button type="button" className="klide-result-fold-summary" aria-label={label} title={label} aria-expanded={open} aria-controls={id} onClick={onToggle}>
        <span className="klide-result-fold-title">{title}</span>
        {/* The chevron turns at the body's pace, so the two read as one thing moving. */}
        <span className="klide-result-fold-chevron" aria-hidden="true"><ChevronIcon open={open} style={{ transition: "transform 440ms var(--ease-soft)" }} /></span>
      </button>
      <div className="klide-result-fold-body" id={id} inert={!open}>
        <div className="klide-result-fold-inner">{children}</div>
      </div>
    </div>
  );
}

/** A changed file as the card reads it: the hunk rows and the two counts. */
type FileDiff = { rows: DiffRow[]; added: number; removed: number; created: boolean };

/** The run's checkpoints, read once per completion and turned into one diff per
 *  file. Null while loading or when the host cannot read them; an accepted run
 *  has none left, and its files stay a plain list. */
function useFileDiffs(completion: RunCompletion, load?: (runId: string) => Promise<CheckpointEntry[]>): Map<string, FileDiff> | null {
  const [diffs, setDiffs] = useState<Map<string, FileDiff> | null>(null);
  useEffect(() => {
    if (!load || completion.files.length === 0) return;
    let live = true;
    void load(completion.runId).then((entries) => {
      if (!live) return;
      const next = new Map<string, FileDiff>();
      for (const change of netFileChanges(entries).values()) {
        next.set(change.path, { ...buildDiffRows(change.before, change.after), created: change.created });
      }
      setDiffs(next);
    }).catch(() => {});
    return () => { live = false; };
    // The loader is a fresh closure every render; the run is what identifies the data.
  }, [completion.runId, completion.completedAt, completion.files.length]);
  return diffs;
}

/** The hunks of one file, small enough for the column: a gutter sign, the
 *  line, and a gap where unchanged lines were folded away. */
function InlineDiff({ rows }: { rows: DiffRow[] }) {
  return (
    <div className="klide-result-diff" role="group" aria-label="Diff">
      <div className="klide-result-diff-lines">
      {rows.map((row, index) => row.kind === "gap"
        ? <div key={index} className="klide-result-diff-gap">{row.hidden} unchanged</div>
        : <div key={index} className="klide-result-diff-line" data-kind={row.kind}>
            <span aria-hidden="true">{row.kind === "add" ? "+" : row.kind === "del" ? "−" : " "}</span>
            <code>{row.text || " "}</code>
          </div>)}
      </div>
    </div>
  );
}

export function ResultEvidence({ completion, disabled, onReview, onOpenArtifact, onPreviewArtifact, onRequestChanges, onDone, loadChanges, diffs: given }: EvidenceProps) {
  const history = isCommandHistory(completion);
  const failed = completion.commands.filter((command) => command.status !== "passed").length;
  const [commandsOpen, setCommandsOpen] = useState(history && failed > 0);
  const [openFile, setOpenFile] = useState<string | null>(null);
  // The documents are what the run made, so they start open; the fold is
  // there to put them away while reading the rest.
  const [documentsOpen, setDocumentsOpen] = useState(true);
  const review = (path?: string) => { onDone(); onReview?.(path); };
  const loaded = useFileDiffs(completion, given === undefined ? loadChanges : undefined);
  const diffs = given === undefined ? loaded : given;
  // The icon opens the document; its preview stays visible below.
  const artifacts = completionDocuments(completion);
  const checks = commandStatusSummary(completion);
  return (
    <>
      <div className="klide-result-body" data-history={history ? "1" : undefined}>
        {completion.files.length > 0 && <section aria-label="Changed files">
          {/* A recap: a row per file — the name and folder on one line, and
              how much changed — with no mark in front of it. The row opens its diff in place, or
              — where the host has a diff viewer — goes there. */}
          <div className="klide-result-changes">{completion.files.map((path) => {
            const name = path.split("/").pop() || path;
            const directory = path.slice(0, -name.length).replace(/\/$/, "");
            const diff = diffs?.get(path);
            const inline = !onReview && !!diff && diff.rows.length > 0;
            const open = inline && openFile === path;
            const label = <>
              <span className="klide-result-file-text">
                <span className="klide-result-filename">{name}</span>
                {directory && <span className="klide-result-directory">{directory}</span>}
              </span>
              {diff && (diff.added > 0 || diff.removed > 0) && <span className="klide-result-stat">
                {diff.added > 0 && <span className="klide-result-stat-add">+{diff.added}</span>}
                {diff.removed > 0 && <span className="klide-result-stat-del">−{diff.removed}</span>}
              </span>}
              {onReview
                ? <span className="klide-result-file-go" aria-hidden="true">↗</span>
                : inline && <span className="klide-result-file-go" aria-hidden="true"><ChevronIcon open={open} size={13} /></span>}
            </>;
            return (
              <div key={path} className="klide-result-file" data-open={open ? "1" : undefined}>
                {onReview
                  ? <button type="button" className="klide-result-file-row" title={`Review ${path}`} onClick={() => review(path)}>{label}</button>
                  : inline
                    ? <button type="button" className="klide-result-file-row" aria-expanded={open} title={path} onClick={() => setOpenFile(open ? null : path)}>{label}</button>
                    : <div className="klide-result-file-row" title={path}>{label}</div>}
                {open && diff && <InlineDiff rows={diff.rows} />}
              </div>
            );
          })}</div>
        </section>}
        {artifacts.length > 0 && <section aria-label="Documents produced">
          {/* Not "Changes": these came from a command, so there is no diff
              behind them and nothing to revert. The row opens the document —
              in the inspector when Klide can read it, in the app that owns it
              when it cannot. */}
          <Fold name="documents" open={documentsOpen} onToggle={() => setDocumentsOpen((was) => !was)} label="Documents" title={<DocumentIcon size={18} />}>
          <div className="klide-result-files klide-result-artifacts">{artifacts.map((artifact) => {
            const name = artifact.path.split("/").pop() || artifact.path;
            const directory = artifact.path.slice(0, -name.length).replace(/\/$/, "");
            const label = <>
              <DocumentAppMark path={artifact.path} size={20} className="klide-result-app-logo" />
              <span className="klide-result-document-text">
                <span className="klide-result-filename">{name}</span>
                {directory && <span className="klide-result-directory">{directory}</span>}
              </span>
            </>;
            const size = <span className="klide-result-size">{artifact.bytes > 0 ? formatBytes(artifact.bytes) : ""}</span>;
            const row = onOpenArtifact
              ? <button type="button" className="klide-result-document-row" title={artifactActionLabel(artifact.path)}
                  onClick={() => { onDone(); onOpenArtifact(artifact.path); }}>{label}{size}<span className="klide-result-open" aria-hidden="true">↗</span></button>
              : <div className="klide-result-document-row">{label}{size}</div>;
            return (
              <div key={artifact.path} className="klide-result-document">
                {row}
                <ArtifactThumb key={`${completion.runId}:${completion.completedAt}:${artifact.path}`} path={artifact.path} load={onPreviewArtifact} />
              </div>
            );
          })}</div>
          </Fold>
        </section>}
        {completion.commands.length > 0 && <section aria-label="Command results">
          {/* The commands are the run's receipts, so they are one line — what
              was checked and how it went — that opens onto the list. Each
              command is one line too, cut at the column's edge (the whole of
              it is in the opened output and the tooltip); a status word appears
              only when it is not a pass, since the summary already said how
              many passed. */}
          <Fold name="commands" open={commandsOpen} onToggle={() => setCommandsOpen((was) => !was)} failed={failed > 0}
            title={<>
              <span>{history ? "Commands" : "Checks"}</span>
              <span className="klide-result-fold-meta">{checks}</span>
            </>}>
          {completion.commands.map((command) => <details key={command.id} className="klide-result-command" data-status={command.status}>
            <summary title={command.label}><code>{command.label}</code>{command.status !== "passed" && <span className={`klide-result-status-${command.status}`}>{command.status === "unknown" ? "No result" : "Failed"}</span>}</summary>
            <pre><span className="klide-result-command-echo">$ {command.label}</span>{"\n"}{command.output || "No output recorded."}</pre>
          </details>)}
          </Fold>
        </section>}
        {completion.warnings.length > 0 && <section className="klide-result-notes" aria-label="Review notes"><h3>Worth a look</h3>{completion.warnings.map((warning) => <p key={warning}>{warning}</p>)}</section>}
      </div>
      {!history && <footer className="klide-result-footer">
        {completion.files.length > 0 && onReview && <button type="button" className="klide-result-primary" onClick={() => review()}>Review changes <span aria-hidden="true">↗</span></button>}
        <button type="button" disabled={disabled} onClick={() => { onDone(); onRequestChanges(); }}>Request changes</button>
      </footer>}
    </>
  );
}

/** Render the document preview beneath its compact open icon. */
function ArtifactThumb({ path, load }: { path: string; load?: (path: string) => Promise<string | null> }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!load || artifactPreview(path) === "none") return;
    let live = true;
    void load(path).then(next => { if (live) setSrc(next); }).catch(() => {});
    return () => { live = false; };
  }, [path, load]);
  if (!src) return <p className="klide-result-preview-note">{artifactPreview(path) === "none" ? "No preview for this kind of file." : "Opening a preview…"}</p>;
  return <img className="klide-result-thumb" src={src} alt={`Preview of ${path.split("/").pop() ?? path}`} loading="lazy" />;
}

/** A quiet entry point. On the canvas the evidence opens inside the card, in
 *  the column the plan already lives in; in a transcript it opens as a sheet. */
export function CompletionCard({ completion, disabled, onReview, onOpenArtifact, onPreviewArtifact, onRequestChanges, variant = "inline", compact = false, folded = false, onUnfold, loadChanges }: Props) {
  const island = variant === "island";
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const id = useId();
  const islandDiffs = useFileDiffs(completion, island && !folded ? loadChanges : undefined);

  // The sheet is modal, so Escape closes it and focus goes back to the row
  // that opened it. The island is part of the page — Escape belongs to the
  // conversation there, not to a card sitting in the corner.
  useEffect(() => {
    if (island || !open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [island, open]);

  if (!hasCompletionReview(completion)) return null;

  const failed = completion.commands.filter((command) => command.status !== "passed").length;
  const history = isCommandHistory(completion);
  const attention = history ? 0 : failed + completion.warnings.length;
  const label = completion.stopped ? "Review partial work" : history ? "Review commands" : "Review result";
  const title = completion.stopped ? "Partial work" : history ? "Command history" : "Result";
  const files = completion.files.length > 0
    ? `${completion.files.length} file${completion.files.length === 1 ? "" : "s"}`
    : "";
  const dot = attention > 0 && <span className="klide-result-attention-dot" aria-label={`${attention} item${attention === 1 ? "" : "s"} to review`} />;
  // What the compact mark cannot say, its name says.
  const documentCount = completionDocumentCount(completion);
  const spoken = [label, files, history ? commandStatusSummary(completion) : "", documentCount > 0 ? `${documentCount} document${documentCount === 1 ? "" : "s"}` : "", attention > 0 ? `${attention} item${attention === 1 ? "" : "s"} to review` : ""]
    .filter(Boolean).join(" · ");

  // The run's mark is what it made: the documents' app marks as a stack — one
  // disc for one document, two overlapping for two, three for three or more,
  // and past that the count says how many more. PowerPoint, Excel, Word as
  // pictures; the Markdown and HTML glyphs drawn. A run that only changed code
  // keeps the review glass and its file count.
  const documentPaths = completionDocuments(completion).map((artifact) => artifact.path);
  const stack = stackedDocumentMarks(documentPaths);
  const mark = stack.length > 0
    ? (
      <span className="klide-result-app-stack" aria-hidden="true">
        {stack.map((path, index) => <span key={`${path}#${index}`} className="klide-result-app-disc"><DocumentAppMark path={path} size={16} /></span>)}
      </span>
    )
    : <ReviewIcon size={15} />;
  // Beyond the stack: the documents it could not show, or the changed files
  // when there is no document at all.
  const beyond = stack.length > 0 ? documentCount - stack.length : completion.files.length;
  const count = beyond > 0 ? (stack.length > 0 ? `+${beyond}` : String(beyond)) : null;

  if (island && folded) {
    // Closed column: icons only. Same pill as the plan's reopen mark — icon
    // and count, nothing else — and the same job: bring the column back.
    return (
      <div className="klide-result-entry" data-variant="island" data-folded="1">
        <button type="button" className="klide-result-mark" onClick={onUnfold}
          aria-label={`Open the side panel — ${spoken.toLowerCase()}`}
          title="Open the side panel">
          {mark}
          {count && <span className="klide-result-meta">{count}</span>}
        </button>
      </div>
    );
  }

  if (island) {
    // The Git island's sibling: a header that names it and counts what is in
    // it, a hairline, and the recap rows — always there, nothing to open
    // before the reader learns what the run changed and whether it held.
    // The Git Review recap line, the same words and the same diffstat: how
    // many files the run changed, then its totals and the five blocks. A run
    // that changed no file keeps its own name (partial work, command history,
    // documents) and the count of what it holds.
    const changed = completion.files.length;
    const heading = changed > 0 && !completion.stopped ? `${changed} file${changed === 1 ? "" : "s"} changed` : title;
    let totals: { add: number; del: number } | null = null;
    if (changed > 0 && islandDiffs) {
      totals = { add: 0, del: 0 };
      for (const path of completion.files) {
        const diff = islandDiffs.get(path);
        if (diff) { totals.add += diff.added; totals.del += diff.removed; }
      }
    }
    const recap = [
      history ? `${completion.commands.length} command${completion.commands.length === 1 ? "" : "s"}` : "",
      completion.stopped && changed > 0 ? `${changed} change${changed === 1 ? "" : "s"}` : "",
      documentCount > 0 ? `${documentCount} document${documentCount === 1 ? "" : "s"}` : "",
    ].filter(Boolean).join(" · ");
    return (
      <div className="klide-result-entry" data-variant="island" data-open="1">
        <section className="klide-result-island" data-open="1" aria-label={title}>
          <div className="klide-result-island-header" title={spoken} data-attention={attention > 0 ? "1" : undefined}>
            <span className="klide-result-island-title">{heading}</span>
            <span className="klide-result-island-spacer" />
            {recap && <span className="klide-result-meta">{recap}</span>}
            {totals && <DiffStat additions={totals.add} deletions={totals.del} />}
          </div>
          <div className="klide-result-island-panel" id={id}>
            <ResultEvidence completion={completion} disabled={disabled} onReview={onReview} diffs={islandDiffs}
              onOpenArtifact={onOpenArtifact} onPreviewArtifact={onPreviewArtifact} onRequestChanges={onRequestChanges} onDone={() => {}} />
          </div>
        </section>
      </div>
    );
  }

  const close = () => { setOpen(false); trigger.current?.focus(); };
  return (
    <div className="klide-result-entry" data-variant={variant}>
      <button ref={trigger} type="button" className="klide-result-trigger" data-compact={compact ? "1" : undefined}
        aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
        data-attention={attention > 0 ? "1" : undefined}
        aria-label={compact ? spoken : undefined}
        title={compact ? spoken : undefined}
        onClick={() => setOpen(true)}>
        {/* Compact is one mark and nothing else: no count beside it, no dot on
            top of it. What the words carried moves to the tooltip and the
            accessible name, and "needs attention" becomes the mark's own
            colour rather than a second thing to look at. */}
        {compact ? <ReviewIcon size={16} /> : <>
          <span>{label}</span>
          {files && <span className="klide-result-meta">{files}</span>}
          {dot}
          <span aria-hidden="true" className="klide-result-arrow">↗</span>
        </>}
      </button>
      {/* Portalled to the body, on the app's own Z scale: an AI panel sits
          inside transformed and clipped ancestors that a sheet left in the
          tree inherits — including the canvas column's click pass-through,
          which used to leave the sheet unclickable over a backdrop that
          blocked everything else. */}
      {open && typeof document !== "undefined" && createPortal(
        <div className="klide-result-scrim" style={{ zIndex: Z.modal }} onClick={close}>
          <div className="klide-result-drawer" id={id} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}
            onClick={(event) => event.stopPropagation()}>
            <header className="klide-result-header">
              <div><h2 id={`${id}-title`}>{title}</h2><p>{history ? "Commands in execution order" : completion.files.length ? `${completion.files.length} changed file${completion.files.length === 1 ? "" : "s"}` : "Items to review"}</p></div>
              <button type="button" autoFocus className="klide-result-close" aria-label={history ? "Close command history" : "Close result"} onClick={close}><CloseIcon size={18} /></button>
            </header>
            <ResultEvidence completion={completion} disabled={disabled} onReview={onReview}
              onOpenArtifact={onOpenArtifact} onPreviewArtifact={onPreviewArtifact} onRequestChanges={onRequestChanges} loadChanges={loadChanges} onDone={close} />
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
