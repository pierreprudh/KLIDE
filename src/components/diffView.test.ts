import { describe, expect, it } from "vitest";
import { parseDiffBlocks } from "./diffView";

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
