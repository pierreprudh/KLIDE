import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { completionDocumentCount, hasCompletionReview, type RunCompletion } from "../../agent/completion";
import { DocumentAppMark, stackedDocumentMarks } from "../../documentAppLogo";
import { artifactActionLabel, artifactPreview } from "../../artifacts";
import { formatBytes } from "../settings/storage";
import { ChevronIcon, CloseIcon, ReviewIcon } from "../../icons";
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
};

type EvidenceProps = Pick<Props, "completion" | "disabled" | "onReview" | "onOpenArtifact" | "onPreviewArtifact" | "onRequestChanges"> & {
  onDone: () => void;
};

/** The evidence itself — the same sections and the same two actions wherever
 *  it is read: inside the island card on the canvas, or in the sheet the
 *  transcript's entry opens. Exported so its markup can be tested without a
 *  DOM to click in. */
export function ResultEvidence({ completion, disabled, onReview, onOpenArtifact, onPreviewArtifact, onRequestChanges, onDone }: EvidenceProps) {
  const failed = completion.commands.filter((command) => command.status !== "passed").length;
  const [commandsOpen, setCommandsOpen] = useState(false);
  const [changesOpen, setChangesOpen] = useState(false);
  const review = (path?: string) => { onDone(); onReview?.(path); };
  // A document opens in two steps: the first click previews it here in the
  // panel, the second opens it full width (the inspector, or the app that owns
  // the file). Going straight to full width meant every glance at a deck threw
  // the reader out of the conversation and into another window.
  //
  // Opening the result *is* the first step: every document it produced shows
  // its picture here, in the panel. So the row's own click is the second step
  // and opens the document full width — no row has to be chosen first.
  const artifacts = completion.artifacts ?? [];
  return (
    <>
      <div className="klide-result-body">
        {completion.files.length > 0 && <section aria-label="Changed files">
          {/* The changed files fold the way the commands do: closed, one row
              that says how many — "2 changes" — and opens on a click. The
              result's first screen is what the run made and said, and the
              footer's "Review changes" already leads to the diff; the list is
              for the reader who wants to pick one file out of it. */}
          <details className="klide-result-fold klide-result-changes"
            open={changesOpen} onToggle={(event) => setChangesOpen(event.currentTarget.open)}>
          <summary>
            {/* The word alone: the count is in the footer's button and in the
                list a click away, and a number before "changes" made the row
                read as a receipt. */}
            <span className="klide-result-fold-title">Changes</span>
            <span className="klide-result-fold-chevron" aria-hidden="true"><ChevronIcon open={changesOpen} /></span>
          </summary>
          <div className="klide-result-files">{completion.files.map((path) => {
            const name = path.split("/").pop() || path;
            const directory = path.slice(0, -name.length).replace(/\/$/, "");
            const label = <><span className="klide-result-filename">{name}</span>{directory && <span className="klide-result-directory">{directory}</span>}</>;
            return onReview ? <button key={path} type="button" title={`Review ${path}`} onClick={() => review(path)}>{label}<span aria-hidden="true">↗</span></button> : <div key={path}>{label}</div>;
          })}</div>
          </details>
        </section>}
        {artifacts.length > 0 && <section aria-label="Documents produced">
          {/* Not "Changes": these came from a command, so there is no diff
              behind them and nothing to revert. The row opens the document —
              in the inspector when Klide can read it, in the app that owns it
              when it cannot. */}
          <h3>Documents <span>{artifacts.length}</span></h3>
          <div className="klide-result-files klide-result-artifacts">{artifacts.map((artifact) => {
            const name = artifact.path.split("/").pop() || artifact.path;
            const directory = artifact.path.slice(0, -name.length).replace(/\/$/, "");
            // The app that owns the file, as its own mark: a reader looking for
            // the deck finds it by the PowerPoint square faster than by
            // reading four filenames.
            // Four columns on one baseline: the app's mark, the name over its
            // folder, the size, the arrow. The generic file row stacks and pins
            // its size to a fixed 11px from the top, which only lines up while
            // the row is one line high — with a logo and a folder under the
            // name, everything drifted.
            const label = (
              <>
                <DocumentAppMark path={artifact.path} size={20} className="klide-result-app-logo" />
                <span className="klide-result-document-text">
                  <span className="klide-result-filename">{name}</span>
                  {directory && <span className="klide-result-directory">{directory}</span>}
                </span>
              </>
            );
            const size = <span className="klide-result-size">{formatBytes(artifact.bytes)}</span>;
            const row = onOpenArtifact
              ? <button type="button" className="klide-result-document-row" title={artifactActionLabel(artifact.path)}
                  onClick={() => { onDone(); onOpenArtifact(artifact.path); }}>{label}{size}<span className="klide-result-open" aria-hidden="true">↗</span></button>
              : <div className="klide-result-document-row">{label}{size}</div>;
            return (
              <div key={artifact.path} className="klide-result-document">
                {row}
                <ArtifactThumb path={artifact.path} load={onPreviewArtifact} />
              </div>
            );
          })}</div>
        </section>}
        {completion.commands.length > 0 && <section aria-label="Command results">
          {/* The commands are the run's receipts: evidence you check when
              something looks wrong, not something to read every time. So they
              arrive as one stack — a heading that opens — and stay quiet even
              when opened. A failure is the exception: nothing dims while a
              command has failed. */}
          <details className="klide-result-fold klide-result-commands" data-failed={failed > 0 ? "1" : undefined}
            open={commandsOpen} onToggle={(event) => setCommandsOpen(event.currentTarget.open)}>
          {/* The count leads, on the left, as part of what the row is called —
              "3 commands" — rather than sitting on the right where it competed
              with the disclosure. The disclosure itself is the app's chevron,
              turning over on open instead of swapping a + for a −: one mark
              that moves, not two that replace each other. */}
          <summary>
            <span className="klide-result-fold-title">
              <span className="klide-result-fold-count">{completion.commands.length}</span>
              <span>command{completion.commands.length === 1 ? "" : "s"}</span>
            </span>
            <span className="klide-result-fold-chevron" aria-hidden="true"><ChevronIcon open={commandsOpen} /></span>
          </summary>
          {completion.commands.map((command) => <details key={command.id} className="klide-result-command">
            <summary><code>{command.label}</code><span className={`klide-result-status-${command.status}`}>{command.status === "unknown" ? "No result" : command.status === "passed" ? "Passed" : "Failed"}</span></summary>
            <pre>{command.output || "No output recorded."}</pre>
          </details>)}
          </details>
        </section>}
        {completion.warnings.length > 0 && <section className="klide-result-notes" aria-label="Review notes"><h3>Worth a look</h3>{completion.warnings.map((warning) => <p key={warning}>{warning}</p>)}</section>}
      </div>
      <footer className="klide-result-footer">
        {completion.files.length > 0 && onReview && <button type="button" className="klide-result-primary" onClick={() => review()}>Review changes <span aria-hidden="true">↗</span></button>}
        <button type="button" disabled={disabled} onClick={() => { onDone(); onRequestChanges(); }}>Request changes</button>
      </footer>
    </>
  );
}

/** What the document looks like, when the host can say.
 *
 *  Asked for once per row, on mount: the answer is a data URI, so nothing is
 *  refetched while the card is open, and a file with no preview simply has no
 *  picture rather than an apology in its place. */
/** The picture of one document, in the panel. It loads when the reader asks
 *  for it — a preview per row, all at once, was a wall of pictures nobody had
 *  asked to see, and it made the first click on a row the last one. */
function ArtifactThumb({ path, load }: { path: string; load?: (path: string) => Promise<string | null> }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!load || artifactPreview(path) === "none") return;
    let live = true;
    void load(path).then((next) => { if (live) setSrc(next); }).catch(() => {});
    return () => { live = false; };
  }, [path, load]);
  if (!src) {
    return (
      <p className="klide-result-preview-note">
        {artifactPreview(path) === "none" ? "No preview for this kind of file." : "Opening a preview…"}
      </p>
    );
  }
  return <img className="klide-result-thumb" src={src} alt={`Preview of ${path.split("/").pop() ?? path}`} loading="lazy" />;
}

/** A quiet entry point. On the canvas the evidence opens inside the card, in
 *  the column the plan already lives in; in a transcript it opens as a sheet. */
export function CompletionCard({ completion, disabled, onReview, onOpenArtifact, onPreviewArtifact, onRequestChanges, variant = "inline", compact = false, folded = false, onUnfold }: Props) {
  const island = variant === "island";
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const id = useId();

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
  const attention = failed + completion.warnings.length;
  const label = completion.stopped ? "Review partial work" : "Review result";
  const title = completion.stopped ? "Partial work" : "Result";
  const files = completion.files.length > 0
    ? `${completion.files.length} file${completion.files.length === 1 ? "" : "s"}`
    : "";
  const dot = attention > 0 && <span className="klide-result-attention-dot" aria-label={`${attention} item${attention === 1 ? "" : "s"} to review`} />;
  // What the compact mark cannot say, its name says.
  const documentCount = completionDocumentCount(completion);
  const spoken = [label, files, documentCount > 0 ? `${documentCount} document${documentCount === 1 ? "" : "s"}` : "", attention > 0 ? `${attention} item${attention === 1 ? "" : "s"} to review` : ""]
    .filter(Boolean).join(" · ");

  // The run's mark is what it made: the documents' app marks as a stack — one
  // disc for one document, two overlapping for two, three for three or more,
  // and past that the count says how many more. PowerPoint, Excel, Word as
  // pictures; the Markdown and HTML glyphs drawn. A run that only changed code
  // keeps the review glass and its file count.
  const documentPaths = (completion.artifacts ?? []).map((artifact) => artifact.path);
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
    // One window in the canvas column, built like the plan above it: a header
    // that is the whole hit target, a hairline that appears with the body, and
    // the body growing into the column rather than over the app.
    return (
      <div className="klide-result-entry" data-variant="island" data-open={open ? "1" : undefined}>
        <section className="klide-result-island" data-open={open ? "1" : undefined} aria-label={title}>
          <div className="klide-result-island-header" role="button" tabIndex={0}
            aria-expanded={open} aria-controls={id}
            aria-label={`${open ? "Collapse" : "Expand"} ${spoken.toLowerCase()}`}
            title={spoken}
            data-attention={attention > 0 ? "1" : undefined}
            onClick={() => setOpen(!open)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              setOpen(!open);
            }}>
            {/* A 232px column is a corner, not a panel: the header keeps one
                mark and drops the rest — the title, the count, the attention
                dot and the chevron. What they said is in the header's own
                name and tooltip, and "needs attention" becomes the mark's
                colour rather than a dot pinned beside it. */}
            {/* An open column has no compacted line: an entry there is a
                window with its words, however narrow the column gets — a
                full-width row holding a centred icon was neither one thing
                nor the other. Folded, it is a mark; there is no third state. */}
            {mark}
            <span className="klide-result-island-title">{title}</span>
            {files && <span className="klide-result-meta">{files}</span>}
            {documentCount > 0 && <span className="klide-result-document-count">{documentCount} document{documentCount === 1 ? "" : "s"}</span>}
            {dot}
            <span className="klide-result-island-chevron" aria-hidden="true"><ChevronIcon open={open} /></span>
            {/* Dismissal belongs to the open card. At rest the entry is one
                mark, and an X beside it is a second thing in the space the
                rule gives to one — hiding it with opacity was not enough
                either, since it kept the pill as wide as two. The column's own
                close puts the whole corner away meanwhile. */}
            {/* No dismiss here. What a run produced stays in the corner while
                that run is the latest one — the files are the run's output,
                not a notice about it, and there is no reading of "close" that
                should lose them. The column's own close folds this to its mark
                like everything else. */}
          </div>
          <div className="klide-result-island-rule" data-shown={open ? "1" : undefined} aria-hidden="true" />
          {/* Open, the card takes the rest of the column: the evidence scrolls
              inside it and the two actions stay on the floor of the card, so
              nothing ends mid-word against a hard edge. */}
          {open && (
            <div className="klide-result-island-panel" id={id}>
              <ResultEvidence completion={completion} disabled={disabled} onReview={onReview}
                onOpenArtifact={onOpenArtifact} onPreviewArtifact={onPreviewArtifact} onRequestChanges={onRequestChanges} onDone={() => setOpen(false)} />
            </div>
        )}
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
              <div><h2 id={`${id}-title`}>{title}</h2><p>{completion.files.length ? `${completion.files.length} changed file${completion.files.length === 1 ? "" : "s"}` : "Items to review"}</p></div>
              <button type="button" autoFocus className="klide-result-close" aria-label="Close result" onClick={close}><CloseIcon size={18} /></button>
            </header>
            <ResultEvidence completion={completion} disabled={disabled} onReview={onReview}
              onOpenArtifact={onOpenArtifact} onPreviewArtifact={onPreviewArtifact} onRequestChanges={onRequestChanges} onDone={close} />
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
