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

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { SkillMarkGlyph } from "./skillMarks";
import type { DraftSpan } from "./skillToken";

/** Air between a command and its mark — the lede's own gap. */
const GAP = 5;

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
  const [fontSize, setFontSize] = useState(13.5);

  // Every render: the textarea may have been resized, re-themed, or had a lede
  // change its indent, and all of that has to land before the browser paints.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !textarea) return;
    const cs = getComputedStyle(textarea);
    for (const key of METRICS) el.style[key] = cs[key];
    el.scrollTop = textarea.scrollTop;
    const size = parseFloat(cs.fontSize);
    if (size && size !== fontSize) setFontSize(size);
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
          <span key={i} style={{ color: "var(--accent)" }}>
            {span.text}
            {/* The mark sits in a box of no width, so it can draw into the
                empty line beside it without moving one glyph of the text the
                textarea laid out. `draftSpans` only hands one over where that
                room exists. */}
            {span.mark && (
              <span style={{ display: "inline-block", width: 0, overflow: "visible", whiteSpace: "nowrap" }}>
                {/* Offset by position, not by margin or padding: either of
                    those would give the box a width again. GAP matches the
                    lede's air between a name and its mark. */}
                <span style={{ position: "relative", left: GAP, display: "inline-flex", verticalAlign: "-0.15em" }}>
                  <SkillMarkGlyph mark={span.mark} size={Math.round(fontSize * 1.05)} />
                </span>
              </span>
            )}
          </span>
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
