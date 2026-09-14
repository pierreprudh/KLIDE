// SVG text has no layout. A model places every label at an absolute coordinate
// without knowing how wide it will render, so labels collide — a caption lands
// on the bar it describes, two axis labels merge into "embedattention 17%".
// Nothing in the markup can prevent that, because the width only exists once
// the text is measured.
//
// So it is repaired after measuring, in the one place where the real widths are
// known: the browser. This module holds the decision — given boxes, which ones
// move and by how much — as pure arithmetic, so the rule is testable without a
// DOM and identical wherever it runs.

export type Box = { top: number; bottom: number; left: number; right: number };

/**
 * Nudge labels apart vertically, in document order.
 *
 * Earlier labels hold their ground: a drawing is read in the order it was
 * written, and the first mention of a thing is usually the anchor the later
 * caption hangs off. Each later label that lands on one already placed moves
 * the shorter way out — down if it sits lower, up if higher — and only if the
 * move is small. A label that would need a large shift is left where the model
 * put it: a big jump relocates it away from whatever it labels, which is worse
 * than the overlap it fixes.
 */
export function resolveOverlaps(boxes: Box[], limit: number): number[] {
  const shift = boxes.map(() => 0);
  const placed: Box[] = [];
  boxes.forEach((box, index) => {
    let top = box.top;
    let bottom = box.bottom;
    let moved = 0;
    for (const other of placed) {
      if (box.right <= other.left || box.left >= other.right) continue;
      if (bottom <= other.top || top >= other.bottom) continue;
      // The two ways out, measured from where the label now sits.
      const down = other.bottom - top + 1;
      const up = other.top - bottom - 1;
      const step = Math.abs(up) < down ? up : down;
      if (Math.abs(moved + step) > limit) continue;
      moved += step;
      top += step;
      bottom += step;
    }
    shift[index] = moved;
    placed.push(moved ? { ...box, top, bottom } : box);
  });
  return shift;
}

/** The gap a label keeps from its neighbours, in CSS pixels. */
export const LABEL_PADDING = 1;

/** How far a label may be moved before leaving it alone is the better answer. */
export const NUDGE_LIMIT = 14;

/**
 * Measure every label in a rendered drawing and move the ones that collide.
 * Returns the number of labels it moved.
 *
 * Measurement is in screen pixels, because two labels in differently
 * transformed groups can only be compared there; the move is converted back
 * into each label's own user units before it is written.
 */
export function typesetVisual(root: HTMLElement): number {
  const labels = [...root.querySelectorAll<SVGTextElement>("svg text")].slice(0, 300);
  const live: { node: SVGTextElement; box: Box; scale: number }[] = [];
  for (const node of labels) {
    // A label this pass already moved is measured where it now is, so a
    // re-run (a resize, a theme change) settles instead of drifting.
    node.removeAttribute("data-typeset");
    node.style.removeProperty("transform");
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const scale = node.getScreenCTM()?.d ?? 1;
    live.push({
      node,
      box: {
        top: rect.top - LABEL_PADDING,
        bottom: rect.bottom + LABEL_PADDING,
        left: rect.left - LABEL_PADDING,
        right: rect.right + LABEL_PADDING,
      },
      scale: scale || 1,
    });
  }
  const shifts = resolveOverlaps(live.map((l) => l.box), NUDGE_LIMIT);
  let moved = 0;
  shifts.forEach((dy, index) => {
    if (!dy) return;
    const { node, scale } = live[index];
    node.style.transform = `translateY(${(dy / scale).toFixed(2)}px)`;
    node.setAttribute("data-typeset", "moved");
    moved++;
  });
  return moved;
}
