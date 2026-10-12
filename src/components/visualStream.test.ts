import { describe, expect, it } from "vitest";
import { hasDrawingRoot, settledMarkup } from "./visualStream";

describe("a drawing still arriving", () => {
  it("keeps every whole tag and cuts the one being written", () => {
    expect(settledMarkup('<svg viewBox="0 0 10 10"><rect x="1" y="1"/><circle cx="')).toBe('<svg viewBox="0 0 10 10"><rect x="1" y="1"/>');
    expect(settledMarkup("<svg><g><rect/></g><text>Hel")).toBe("<svg><g><rect/></g><text>Hel");
    expect(settledMarkup("<svg><text>Hello</te")).toBe("<svg><text>Hello");
  });

  it("does not mistake a > inside a quoted attribute for the end of a tag", () => {
    expect(settledMarkup('<svg><text data-x="a>b">hi')).toBe('<svg><text data-x="a>b">hi');
    expect(settledMarkup('<svg><text data-x="a>b')).toBe("<svg>");
  });

  it("cuts an open comment whole", () => {
    expect(settledMarkup("<svg><rect/><!-- the ar")).toBe("<svg><rect/>");
    expect(settledMarkup("<svg><!-- a --><rect/>")).toBe("<svg><!-- a --><rect/>");
  });

  it("only draws once the <svg> root has fully arrived", () => {
    expect(hasDrawingRoot(settledMarkup('<svg viewBox="0 0 1 1'))).toBe(false);
    expect(hasDrawingRoot(settledMarkup('<svg viewBox="0 0 1 1">'))).toBe(true);
    expect(hasDrawingRoot("<svgx>")).toBe(false);
  });
});
