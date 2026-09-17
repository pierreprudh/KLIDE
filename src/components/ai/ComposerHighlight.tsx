// A skill reads as a skill wherever it stands in the draft.
//
// At the head of a line the composer draws a lede over the command
// (SkillTokenLede) — it can, because the text is out of the way. Inside a
// sentence there is nowhere to put a lede and no way to colour one word of a
// <textarea>: a textarea renders one colour for all of its text. So the colour
// comes from underneath. This is the mirror every composer that highlights its
// own input uses: a div behind the textarea holding the same string with the
// same metrics, the command in the accent, and the textarea's own glyphs made
// transparent so the ones showing through are the drawn ones. The caret, the
// selection, the scrolling, the IME and undo all stay the textarea's.
//
// The metrics are *copied* from the textarea at layout time rather than
// restated here. Two composers style their textarea differently (one inline,
// one in tokens.css) and a mirror that guessed would ghost a pixel off; one
// that reads has nothing to drift from.
//
// The layer only exists while a wired command is in the draft. With none, the
// textarea keeps its own visible text and this renders nothing — the ordinary
// case carries none of the risk.

import { useEffect, useLayoutEffect, useRef } from "react";
import type { DraftSpan } from "./skillToken";

/** Everything that decides where a glyph lands. Colour is deliberately not
 *  here: the mirror paints, the textarea is transparent. */
const METRICS = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "fontVariant",
  "letterSpacing",
  "wordSpacing",
  "lineHeight",
  "textIndent",
  "textTransform",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "boxSizing",
  "tabSize",
] as const;

export function ComposerHighlight({
  textarea,
  spans,
}: {
  textarea: HTMLTextAreaElement | null;
  spans: readonly DraftSpan[];
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Every render: the textarea may have been resized, re-themed, or had a lede
  // change its indent, and all of that has to land before the browser paints.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !textarea) return;
    const cs = getComputedStyle(textarea);
    for (const key of METRICS) el.style[key] = cs[key];
    el.scrollTop = textarea.scrollTop;
  });

  // A long draft scrolls inside the textarea; the mirror follows it.
  useEffect(() => {
    if (!textarea) return;
    const sync = () => {
      const el = ref.current;
      if (el) el.scrollTop = textarea.scrollTop;
    };
    textarea.addEventListener("scroll", sync);
    return () => textarea.removeEventListener("scroll", sync);
  }, [textarea]);

  return (
    <div
      ref={ref}
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        pointerEvents: "none",
        userSelect: "none",
        whiteSpace: "pre-wrap",
        overflowWrap: "break-word",
        wordBreak: "break-word",
        color: "var(--fg-strong)",
      }}
    >
      {spans.map((span, i) =>
        span.skill ? (
          <span key={i} style={{ color: "var(--accent)" }}>{span.text}</span>
        ) : (
          <span key={i}>{span.text}</span>
        ),
      )}
      {/* A draft ending in a newline would leave the mirror a line short of
          the textarea, and the two would scroll out of step. */}
      {"​"}
    </div>
  );
}
