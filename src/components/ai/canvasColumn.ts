// The Focus canvas' right-hand column, as a rule rather than a render.
//
// Four things can sit there — the plan, a run's result, a question the run is
// parked on, the visuals the latest answer drew — and each can be a *card* (a window) or a *mark* (the pill a
// folded one leaves behind). Mixing those two up is what put a close button in
// an empty corner and let a folded plan's mark sit over the prose: the column
// knew whether the plan was "visible", which answers neither question.
//
// So the geometry is decided here, in one place, from what each slot is
// actually showing.

import type { TodoStripSlot } from "../TodoStrip";

/** The column's own width range. Narrower than this and it is a corner. */
export const COLUMN_MAX = 320;
export const COLUMN_MIN = 232;

/** Prose keeps at least this much before the column takes any of the canvas. */
const PROSE_MIN = 560;

/** The column's margins, left and right of it (18px each). */
const COLUMN_MARGINS = 36;

/** A folded corner still needs a lane of its own, or marks sit over the text. */
const MARK_LANE = 76;

export type ColumnInput = {
  /** What the plan is showing (TodoStrip reports it). */
  planSlot: TodoStripSlot;
  /** Whether a reviewable result the reader has not dismissed exists. What it
   *  *looks* like is the column's business, not its own: open, every entry is
   *  a full-width window; closed, every entry is its mark. */
  resultUp: boolean;
  /** A question the run is parked on. */
  questionUp: boolean;
  /** The latest answer drew something — a diagram, a page — and it is shown
   *  here rather than in the prose. Absent in older callers: nothing drawn. */
  visualUp?: boolean;
  /** The reader closed the column. A question overrides it: that card holds
   *  the run, and hiding it strands the run with no way to answer. */
  hidden: boolean;
  /** Measured canvas width; 0 means "not measured yet", so assume roomy. */
  canvasWidth: number;
};

export type ColumnGeometry = {
  /** Column width in px — a share of the canvas, clamped to its range. */
  width: number;
  /** A window is up: the column takes its full width. */
  cardsUp: boolean;
  /** Only marks are up: the column takes a lane, not a panel. */
  marksUp: boolean;
  /** What the conversation gives up on its right. */
  inset: number;
  /** Whether to draw the column's close control. It belongs to cards: with
   *  nothing but marks left there is nothing for it to close. */
  showClose: boolean;
  /** Whether the entries render folded to their marks (plan and result alike). */
  planFolded: boolean;
};

export function columnGeometry({ planSlot, resultUp, questionUp, visualUp = false, hidden, canvasWidth }: ColumnInput): ColumnGeometry {
  // A question is never hidden, so it also un-hides everything beside it: a
  // reader answering one should see the plan it came from.
  const closed = hidden && !questionUp;
  const width = canvasWidth === 0
    ? COLUMN_MAX
    : Math.max(COLUMN_MIN, Math.min(COLUMN_MAX, canvasWidth - PROSE_MIN - COLUMN_MARGINS));

  // Open, every entry in the column is a full-width window; closed, every one
  // is its mark. So the column is "open" whenever it holds anything the reader
  // has not folded away, and the corner keeps the marks either way — a
  // finished run never vanishes from the top right.
  const cardsUp = !closed && (planSlot === "card" || questionUp || resultUp || visualUp);
  const marksUp = !cardsUp && (planSlot !== "none" || resultUp || visualUp);

  return {
    width,
    cardsUp,
    marksUp,
    inset: cardsUp ? width + COLUMN_MARGINS : marksUp ? MARK_LANE : 0,
    showClose: cardsUp,
    planFolded: closed,
  };
}
