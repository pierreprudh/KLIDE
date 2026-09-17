import { describe, expect, it } from "vitest";

import { columnGeometry, COLUMN_MAX, COLUMN_MIN } from "./canvasColumn";

const roomy = { planSlot: "none", resultUp: false, questionUp: false, hidden: false, canvasWidth: 1210 } as const;

describe("canvas column geometry", () => {
  it("gives the canvas back when there is nothing in the corner", () => {
    const g = columnGeometry(roomy);
    expect(g.cardsUp).toBe(false);
    expect(g.marksUp).toBe(false);
    expect(g.inset).toBe(0);
    expect(g.showClose).toBe(false);
  });

  it("takes the column's width for a card", () => {
    const g = columnGeometry({ ...roomy, planSlot: "card" });
    expect(g.cardsUp).toBe(true);
    expect(g.inset).toBe(COLUMN_MAX + 36);
    expect(g.showClose).toBe(true);
  });

  // The bug this module exists for: closing the plan left the column's own
  // close button standing in a corner that had nothing left to close, and the
  // mark the plan folded to had no lane, so prose ran under it.
  it("keeps a lane for a folded plan's mark and hides the close with it", () => {
    const g = columnGeometry({ ...roomy, planSlot: "mark" });
    expect(g.cardsUp).toBe(false);
    expect(g.marksUp).toBe(true);
    expect(g.inset).toBe(76);
    expect(g.showClose).toBe(false);
  });

  it("keeps that lane when the reader closes the column on cards", () => {
    const g = columnGeometry({ ...roomy, planSlot: "card", resultUp: true, hidden: true });
    expect(g.cardsUp).toBe(false);
    expect(g.marksUp).toBe(true);
    expect(g.inset).toBe(76);
    expect(g.planFolded).toBe(true);
  });

  // "On sidepanel open, each should be full width and when closed only icons."
  // The switch is the column's state, not each card's: a result on its own
  // opens the column as a window, and closing the column turns it into a mark.
  it("gives a result the column's width while the column is open", () => {
    const g = columnGeometry({ ...roomy, resultUp: true });
    expect(g.cardsUp).toBe(true);
    expect(g.inset).toBe(COLUMN_MAX + 36);
    expect(g.showClose).toBe(true);
    expect(g.planFolded).toBe(false);
  });
  it("folds a result to its mark when the column is closed", () => {
    const g = columnGeometry({ ...roomy, resultUp: true, hidden: true });
    expect(g.cardsUp).toBe(false);
    expect(g.marksUp).toBe(true);
    expect(g.inset).toBe(76);
    expect(g.showClose).toBe(false);
    expect(g.planFolded).toBe(true);
  });
  it("asks for nothing when a closed column has nothing to mark", () => {
    expect(columnGeometry({ ...roomy, hidden: true }).inset).toBe(0);
  });

  // A parked question holds the run: it cannot be closed away, and it brings
  // the plan it came from back with it.
  it("overrides a closed column while a question waits", () => {
    const g = columnGeometry({ ...roomy, planSlot: "card", questionUp: true, hidden: true });
    expect(g.cardsUp).toBe(true);
    expect(g.showClose).toBe(true);
    expect(g.planFolded).toBe(false);
  });

  // The column narrows with the canvas, but its entries never become a
  // compacted line: open is a window at whatever width is left, folded is a
  // mark, and there is no third state in between.
  it("shrinks with the canvas, down to its floor", () => {
    expect(columnGeometry({ ...roomy, canvasWidth: 900 }).width).toBe(304);
    expect(columnGeometry({ ...roomy, canvasWidth: 700 }).width).toBe(COLUMN_MIN);
    expect(columnGeometry({ ...roomy, canvasWidth: 400 }).width).toBe(COLUMN_MIN);
  });

  it("assumes the roomy case before the canvas has been measured", () => {
    expect(columnGeometry({ ...roomy, canvasWidth: 0 }).width).toBe(COLUMN_MAX);
  });

  it("holds the column open for a drawing, and keeps its mark when closed", () => {
    const up = columnGeometry({ ...roomy, visualUp: true });
    expect(up.cardsUp).toBe(true);
    expect(up.inset).toBe(COLUMN_MAX + 36);
    const closed = columnGeometry({ ...roomy, visualUp: true, hidden: true });
    expect(closed.cardsUp).toBe(false);
    expect(closed.marksUp).toBe(true);
    expect(closed.inset).toBe(76);
  });
});
