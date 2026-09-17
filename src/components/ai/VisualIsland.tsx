// The visuals the latest answer drew, as one window in the Focus canvas
// column — beside the plan and the result, built like them: a header that is
// the whole hit target, a hairline that comes with the body, and the body
// growing into the column. Folded, it is a mark.
//
// The preview is the drawing itself: the same sanitized markup, rendered by
// the same surface the prose used, fluid to the column's width and clipped to
// a card. Clicking a card opens the fullscreen viewer the inline figure has.

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronIcon, DiagramIcon, VisualExpandIcon } from "../../icons";
import { VisualSurface, VisualViewer, type VisualBlockRef } from "../markdown";
import { prepareVisual } from "../visualHtml";
import "./visualIsland.css";

type Props = {
  visuals: readonly VisualBlockRef[];
  /** Which answer these came from; a new one re-opens the window. */
  sourceKey: string;
  folded: boolean;
  onUnfold: () => void;
};

export function VisualIsland({ visuals, sourceKey, folded, onUnfold }: Props) {
  const id = useId();
  // A drawing arriving is the reason the window exists, so it opens on
  // arrival; the reader's fold outlives re-renders of the same answer.
  const [open, setOpen] = useState(true);
  useEffect(() => { setOpen(true); }, [sourceKey]);

  if (visuals.length === 0) return null;
  const pages = visuals.filter((v) => v.kind === "page").length;
  const title = visuals.length === 1 ? (pages === 1 ? "Page" : "Diagram") : `${visuals.length} visuals`;
  const spoken = visuals.length === 1 ? title.toLowerCase() : `${visuals.length} visuals`;
  const count = visuals.length > 1 ? String(visuals.length) : null;
  const mark = <DiagramIcon size={15} />;

  if (folded) {
    return (
      <div className="klide-result-entry" data-variant="island" data-folded="1">
        <button type="button" className="klide-result-mark" onClick={onUnfold}
          aria-label={`Open the side panel — ${spoken}`} title="Open the side panel">
          {mark}
          {count && <span className="klide-result-meta">{count}</span>}
        </button>
      </div>
    );
  }

  return (
    <div className="klide-result-entry" data-variant="island" data-open={open ? "1" : undefined}>
      <section className="klide-result-island" data-open={open ? "1" : undefined} aria-label={title}>
        <div className="klide-result-island-header" role="button" tabIndex={0}
          aria-expanded={open} aria-controls={id}
          aria-label={`${open ? "Collapse" : "Expand"} ${spoken}`}
          title={spoken}
          onClick={() => setOpen(!open)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            setOpen(!open);
          }}>
          {mark}
          <span className="klide-result-island-title">{title}</span>
          {count && <span className="klide-result-meta">{count}</span>}
          <span className="klide-result-island-chevron" aria-hidden="true"><ChevronIcon open={open} /></span>
        </div>
        <div className="klide-result-island-rule" data-shown={open ? "1" : undefined} aria-hidden="true" />
        {open && (
          <div className="klide-result-island-panel klide-visual-island-panel" id={id}>
            {visuals.map((visual) => <VisualThumb key={`${sourceKey}:${visual.key}`} visual={visual} />)}
          </div>
        )}
      </section>
    </div>
  );
}

function VisualThumb({ visual }: { visual: VisualBlockRef }) {
  const scope = `kv${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const prepared = useMemo(() => prepareVisual(visual.code, scope), [visual.code, scope]);
  const origin = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const what = visual.kind === "page" ? "page" : "diagram";
  return (
    <div>
      <button type="button" className="klide-visual-thumb" onClick={(event) => { event.currentTarget.focus(); setExpanded(true); }}
        aria-label={`Open the ${what} fullscreen`} title="Open fullscreen">
        <div ref={origin}><VisualSurface visual={prepared} scope={scope} /></div>
        <span className="klide-visual-thumb-open" aria-hidden="true"><VisualExpandIcon expanded={expanded} size={13} /></span>
      </button>
      {expanded ? <VisualViewer code={visual.code} origin={origin} onClose={() => setExpanded(false)} /> : null}
    </div>
  );
}
