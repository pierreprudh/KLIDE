// The lede a wired skill draws at the head of the composer's first line.
//
// It stands exactly where the `/visualise ` it replaces would have been: the
// textarea keeps the text (see skillToken.ts), and its first line is indented
// by this element's width, so the caret lands after the name and the prose
// wraps under it like any other line. No pill, no frame — the accent is the
// whole signal, and a mark follows the name only when one was picked.
//
// The geometry is read from the textarea rather than passed in, because two
// composers with two paddings and two type sizes float this and neither should
// have to restate its own metrics to keep the lede on the baseline.

import { useLayoutEffect, useRef, useState } from "react";
import type { SkillToken } from "./skillToken";
import { SkillMarkGlyph } from "./skillMarks";

/** Air between the name and the text that follows it. */
const GAP = 7;

type Geometry = { top: number; left: number; fontSize: number; lineHeight: number };

export function SkillTokenLede({
  token,
  textarea,
  onRemove,
  onWidth,
}: {
  token: SkillToken;
  /** The composer's textarea — the lede reads its metrics and follows its scroll. */
  textarea: HTMLTextAreaElement | null;
  onRemove: () => void;
  /** The first-line indent the host must leave for this lede. */
  onWidth: (width: number) => void;
}) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const [geom, setGeom] = useState<Geometry | null>(null);
  const [scrolled, setScrolled] = useState(0);
  const [hover, setHover] = useState(false);

  // The metrics the textarea is laying its own first line out with.
  useLayoutEffect(() => {
    if (!textarea) return;
    const cs = getComputedStyle(textarea);
    const fontSize = parseFloat(cs.fontSize) || 14;
    const lh = cs.lineHeight === "normal" ? fontSize * 1.55 : parseFloat(cs.lineHeight) || fontSize * 1.55;
    setGeom({
      top: parseFloat(cs.paddingTop) || 0,
      left: parseFloat(cs.paddingLeft) || 0,
      fontSize,
      lineHeight: lh,
    });
  }, [textarea, token.label]);

  // A long draft scrolls its own first line out of the box; the lede rides
  // along instead of hovering over whatever line arrives underneath it.
  useLayoutEffect(() => {
    if (!textarea) return;
    const onScroll = () => setScrolled(textarea.scrollTop);
    textarea.addEventListener("scroll", onScroll, { passive: true });
    setScrolled(textarea.scrollTop);
    return () => textarea.removeEventListener("scroll", onScroll);
  }, [textarea]);

  // What the host has to indent. Measured, not guessed: the name is the
  // skill's own, and the mark and type size come from the surface.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !geom) return;
    const report = () => onWidth(el.offsetWidth + GAP);
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    // A web font landing after first paint re-cuts the name's width.
    void document.fonts?.ready.then(report).catch(() => {});
    return () => ro.disconnect();
  }, [geom, token.label, onWidth]);

  if (!geom) return null;
  const hidden = scrolled > geom.lineHeight * 0.6;

  return (
    <button
      ref={ref}
      type="button"
      // mousedown, not click: the textarea keeps focus, so removing the skill
      // never costs you the caret you were typing at.
      onMouseDown={(e) => { e.preventDefault(); onRemove(); }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={`${token.label} skill · click to remove`}
      aria-label={`${token.label} skill — click to remove`}
      style={{
        position: "absolute",
        top: geom.top,
        left: geom.left,
        zIndex: 2,
        height: geom.lineHeight,
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: 0,
        border: 0,
        background: "transparent",
        font: "inherit",
        fontSize: geom.fontSize,
        lineHeight: 1,
        color: "var(--accent)",
        whiteSpace: "nowrap",
        cursor: "pointer",
        opacity: hidden ? 0 : hover ? 0.68 : 1,
        transform: `translateY(${-scrolled}px)`,
        transition: "opacity var(--motion-fast) var(--ease-out)",
      }}
    >
      {token.label}
      {token.mark && <SkillMarkGlyph mark={token.mark} size={Math.round(geom.fontSize * 1.05)} />}
    </button>
  );
}
