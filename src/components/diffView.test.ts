import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DiffView, diffBlocksFromContents, diffStatBlocks, parseDiffBlocks } from "./diffView";

const SAMPLE = [
  "diff --git a/src/foo.ts b/src/foo.ts",
  "index 1234567..89abcde 100644",
  "--- a/src/foo.ts",
  "+++ b/src/foo.ts",
  "@@ -10,3 +10,3 @@ function foo() {",
  " const a = 1;",
  "-const b = compute(a, 2);",
  "+const b = compute(a, 3);",
  " return b;",
];

describe("parseDiffBlocks", () => {
  it("parses file header, hunk, and lines with dual numbering", () => {
    const blocks = parseDiffBlocks(SAMPLE);
    expect(blocks[0]).toEqual({ kind: "file", path: "src/foo.ts" });
    expect(blocks[1]).toMatchObject({ kind: "hunk", text: "function foo() {" });
    // meta lines (index/---/+++) are dropped
    expect(blocks).toHaveLength(6);
    const [ctx, del, add, tail] = blocks.slice(2) as Extract<
      ReturnType<typeof parseDiffBlocks>[number],
      { kind: "line" }
    >[];
    expect(ctx).toMatchObject({ tone: "ctx", oldNo: 10, newNo: 10, code: "const a = 1;" });
    expect(del).toMatchObject({ tone: "del", oldNo: 11, newNo: null });
    expect(add).toMatchObject({ tone: "add", oldNo: null, newNo: 11 });
    expect(tail).toMatchObject({ tone: "ctx", oldNo: 12, newNo: 12 });
  });

  it("marks the word-level changed span on paired del/add lines", () => {
    const blocks = parseDiffBlocks(SAMPLE);
    const del = blocks[3] as Extract<ReturnType<typeof parseDiffBlocks>[number], { kind: "line" }>;
    const add = blocks[4] as Extract<ReturnType<typeof parseDiffBlocks>[number], { kind: "line" }>;
    expect(del.hi).toBeDefined();
    expect(add.hi).toBeDefined();
    // The changed middle is the "2" vs "3" argument.
    expect(del.code.slice(...del.hi!)).toBe("2");
    expect(add.code.slice(...add.hi!)).toBe("3");
  });

  it("leaves unpaired runs unhighlighted", () => {
    const blocks = parseDiffBlocks([
      "@@ -1,2 +1,1 @@",
      "-gone one",
      "-gone two",
      "+arrived",
    ]);
    const lines = blocks.filter((b) => b.kind === "line");
    // 2 deletions vs 1 addition: not an equal-length pair, no spans marked.
    expect(lines.every((l) => l.kind === "line" && l.hi === undefined)).toBe(true);
  });

  it("restarts numbering at each hunk header", () => {
    const blocks = parseDiffBlocks([
      "@@ -5,1 +5,1 @@",
      " five",
      "@@ -40,1 +41,1 @@",
      " forty",
    ]);
    const lines = blocks.filter((b) => b.kind === "line") as Extract<
      ReturnType<typeof parseDiffBlocks>[number],
      { kind: "line" }
    >[];
    expect(lines[0]).toMatchObject({ oldNo: 5, newNo: 5 });
    expect(lines[1]).toMatchObject({ oldNo: 40, newNo: 41 });
  });
});

describe("diffStatBlocks", () => {
  it("splits five blocks by share, never hiding a side that changed", () => {
    expect(diffStatBlocks(482, 37)).toEqual(["add", "add", "add", "add", "del"]);
    expect(diffStatBlocks(4, 1)).toEqual(["add", "add", "add", "add", "del"]);
    expect(diffStatBlocks(1, 1)).toEqual(["add", "add", "del", "del", "none"]);
    expect(diffStatBlocks(3, 0)).toEqual(["add", "add", "add", "add", "add"]);
    expect(diffStatBlocks(0, 0)).toEqual(["none", "none", "none", "none", "none"]);
  });
});

describe("diffBlocksFromContents", () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`);

  it("numbers both sides and highlights the changed word, like a git diff", () => {
    const before = lines(20);
    const after = [...before];
    after[9] = "line 10 changed";
    const blocks = diffBlocksFromContents(before.join("\n") + "\n", after.join("\n") + "\n");
    expect(blocks[0]).toEqual({ kind: "hunk", text: "" });
    const code = blocks.filter((b) => b.kind === "line");
    // three lines of context either side, then the pair
    expect(code).toHaveLength(8);
    expect(code[3]).toMatchObject({ tone: "del", oldNo: 10, newNo: null, code: "line 10", hi: [7, 7] });
    expect(code[4]).toMatchObject({ tone: "add", oldNo: null, newNo: 10, hi: [7, 15] });
    expect(code[0]).toMatchObject({ tone: "ctx", oldNo: 7, newNo: 7 });
  });

  it("splits distant changes into hunks and drops the no-newline marker", () => {
    const before = lines(30).join("\n");
    const after = lines(30).map((l, i) => (i === 1 || i === 28 ? `${l}!` : l)).join("\n");
    const blocks = diffBlocksFromContents(before, after);
    expect(blocks.filter((b) => b.kind === "hunk")).toHaveLength(2);
    expect(blocks.some((b) => b.kind === "line" && b.code.startsWith(" No newline"))).toBe(false);
  });

  it("reads a new file as all additions", () => {
    const blocks = diffBlocksFromContents("", "a\nb\n");
    expect(blocks.filter((b) => b.kind === "line").map((b) => b.kind === "line" && b.tone)).toEqual(["add", "add"]);
  });
});

describe("DiffView compact", () => {
  const blocks = diffBlocksFromContents("a\nb\nc\n", "a\nB\nc\n");
  const render = (compact: boolean) => renderToStaticMarkup(createElement(DiffView, { blocks, limit: Infinity, inset: false, flush: true, compact }));

  it("keeps one number gutter and wraps code instead of scrolling sideways", () => {
    const html = render(true);
    expect(html).toContain("grid-template-columns:3px 28px 16px 1fr");
    expect(html).toContain("white-space:pre-wrap");
    expect(html).not.toContain("width:max-content");
  });

  it("leaves the two-gutter layout untouched by default", () => {
    const html = render(false);
    expect(html).toContain("grid-template-columns:3px 34px 34px 22px 1fr");
    expect(html).toContain("width:max-content");
    expect(html).not.toContain("pre-wrap");
  });

  it("starts the first card flush when the host spaces it", () => {
    expect(render(true)).toMatch(/<section[^>]*style="margin-top:0/);
  });
});
