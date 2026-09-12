import { useCallback, useEffect, useRef, useState } from "react";
import { formatBytes } from "./settings/storage";
import { CloseIcon } from "../icons";
import { Z } from "../zLayers";
import { documentAppLogo } from "../documentAppLogo";
import { isSpreadsheetPath } from "../spreadsheets/paths";
import "./documentViewer.css";

export type ViewerDocument = { path: string; bytes: number };

type Props = {
  /** Everything the run produced, so the rail is the set and not just the one
   *  row that was clicked. */
  documents: ViewerDocument[];
  /** The document to open on. */
  path: string;
  /** A picture of a document at roughly `size` px on its long edge. The rail
   *  asks small and the canvas asks large, so a deck is not read from a
   *  thumbnail stretched to fill a window. */
  load: (path: string, size: number) => Promise<string | null>;
  /** A picture of the document the host already has at any size — the card's
   *  thumbnail, usually — shown on the canvas while the large one is drawn.
   *  Null means the canvas says the picture is coming instead. */
  placeholder?: (path: string) => string | null;
  /** Hand the file to the application that owns it. */
  onOpenExternal: (path: string) => void;
  onClose: () => void;
  onOpenSpreadsheet?: (path: string) => void;
};

const RAIL_SIZE = 220;
const CANVAS_SIZE = 1800;

const fileName = (path: string) => path.split("/").pop() || path;

/** One rail entry: the document, small. */
function RailItem({ document, active, load, onSelect }: {
  document: ViewerDocument;
  active: boolean;
  load: Props["load"];
  onSelect: () => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void load(document.path, RAIL_SIZE).then((next) => { if (live) setSrc(next); }).catch(() => {});
    return () => { live = false; };
  }, [document.path, load]);
  return (
    <button type="button" className="klide-doc-rail-item" data-active={active ? "1" : undefined}
      aria-current={active} onClick={onSelect} title={document.path}>
      <span className="klide-doc-rail-sheet">{src && <img src={src} alt="" />}</span>
      <span className="klide-doc-rail-name">{fileName(document.path)}</span>
    </button>
  );
}

/**
 * A document the run produced, read at the size it deserves.
 *
 * The card's row is a mention; this is the reading. It docks to the right —
 * the side the run's own windows are on — and leaves the conversation beside
 * it working, because reading a deck and asking about it are one piece of
 * work. Klide renders none of these formats itself: the picture comes from
 * macOS Quick Look, so this is deliberately a viewer — the rail to move
 * between what the run made, the sheet, and one way out to the application
 * that can actually edit it.
 */
export function DocumentViewer({ documents, path, load, placeholder, onOpenExternal, onClose, onOpenSpreadsheet }: Props) {
  const [active, setActive] = useState(path);
  const [src, setSrc] = useState<string | null>(() => placeholder?.(path) ?? null);
  const [pending, setPending] = useState(true);
  const [actualSize, setActualSize] = useState(false);
  const canvas = useRef<HTMLDivElement>(null);

  useEffect(() => setActive(path), [path]);

  // The sharp picture takes a Quick Look render the first time — ~200 ms — so
  // the canvas shows the picture the host already has for this document (the
  // card's, or a rail thumbnail's) and swaps it for the large one when that
  // lands, instead of going blank between every step.
  useEffect(() => {
    let live = true;
    setPending(true);
    setSrc(placeholder?.(active) ?? null);
    setActualSize(false);
    void load(active, CANVAS_SIZE)
      .then((next) => { if (live) { setSrc(next); setPending(false); } })
      .catch(() => { if (live) { setSrc(null); setPending(false); } });
    return () => { live = false; };
  }, [active, load, placeholder]);

  // Escape leaves; the arrows walk the rail, which is what a reader reaches for
  // before they reach for the mouse.
  const step = useCallback((delta: number) => {
    const index = documents.findIndex((document) => document.path === active);
    const next = documents[index + delta];
    if (next) {
      if (isSpreadsheetPath(next.path) && onOpenSpreadsheet) onOpenSpreadsheet(next.path);
      else setActive(next.path);
    }
  }, [active, documents, onOpenSpreadsheet]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { onClose(); return; }
      if (!(event.target instanceof Node) || !canvas.current?.closest(".klide-doc-shell")?.contains(event.target)) return;
      if (event.key === "ArrowDown" || event.key === "ArrowRight") { event.preventDefault(); step(1); }
      if (event.key === "ArrowUp" || event.key === "ArrowLeft") { event.preventDefault(); step(-1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, step]);

  const current = documents.find((document) => document.path === active);
  const appLogo = documentAppLogo(active);

  return (
    <div className="klide-doc-scrim" style={{ zIndex: Z.modal }}>
      <aside className="klide-doc-shell" aria-label={`Document: ${fileName(active)}`}>
        <header className="klide-doc-head">
          <div className="klide-doc-title">
            <span className="klide-doc-name">{fileName(active)}</span>
            <span className="klide-doc-meta">
              {active.slice(0, -fileName(active).length).replace(/\/$/, "") || "."}
              {current && <> · {formatBytes(current.bytes)}</>}
            </span>
          </div>
          <div className="klide-doc-actions">
            {src && (
              <button type="button" onClick={() => setActualSize((was) => !was)}
                aria-pressed={actualSize}>{actualSize ? "Fit" : "Actual size"}</button>
            )}
            <button type="button" onClick={() => onOpenExternal(active)}>
              {appLogo && <img className="klide-doc-app-logo" src={appLogo} alt="" aria-hidden="true" />}
              Open in app <span aria-hidden="true">↗</span>
            </button>
            <button type="button" className="klide-doc-close" aria-label="Close" onClick={onClose}>
              <CloseIcon size={18} />
            </button>
          </div>
        </header>
        <div className="klide-doc-body">
          {documents.length > 1 && (
            <nav className="klide-doc-rail" aria-label="Documents from this run">
              {documents.map((document) => (
                <RailItem key={document.path} document={document} active={document.path === active}
                  load={load} onSelect={() => {
                    if (isSpreadsheetPath(document.path) && onOpenSpreadsheet) onOpenSpreadsheet(document.path);
                    else setActive(document.path);
                  }} />
              ))}
            </nav>
          )}
          <div ref={canvas} className="klide-doc-canvas" data-actual={actualSize ? "1" : undefined}>
            {src
              ? <img className="klide-doc-sheet" data-provisional={pending ? "1" : undefined} src={src} alt={`Preview of ${fileName(active)}`} />
              : <p className="klide-doc-empty">{pending ? "Drawing the preview…" : "No preview for this file. Open it in its app to read it."}</p>}
          </div>
        </div>
      </aside>
    </div>
  );
}
